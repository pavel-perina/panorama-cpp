# Ideas notebook

Unscheduled ideas, roughly in dependency order. (Mobile PWA has its own
plan: mobile-app-plan.md.)

## Summit database with computed prominence

Goal: one self-made database — name, position, height, prominence — instead
of scraping per-country prominence lists. OSM supplies names/positions but
essentially no prominence and unreliable `ele`; heightmaps supply the rest.

**Prominence algorithm** (the classic one, used by Kirmse & de Ferranti's
"every mountain in the world" run): process heightmap cells sorted by
elevation descending — conceptually lowering a water level. Maintain islands
with union-find; each island remembers its highest cell (the peak). When two
islands merge at elevation s, the lower island's peak P gets its key saddle:
prominence(P) = ele(P) − s. One pass, O(n α n) after the sort; SRTM3 Europe
is a few billion cells → tile-wise divide and conquer with border stitching
(Kirmse's approach, github.com/akirmse/mountains — also a reference/
validation dataset, results are published and downloadable).

Pipeline sketch:
1. C++ tool: heightmap tiles → list of (lat, lon, ele, prominence, saddle)
   for every peak above some threshold (e.g. prom ≥ 50 m).
2. Python: match against OSM `natural=peak` nodes (nearest named node within
   ~300 m; SRTM peak positions are off by up to a cell or two).
3. Emit TSV/SQLite: name, OSM ele, SRTM ele, prominence, country.

Caveats: SRTM3 is a 90 m surface model — sharp summits get smoothed down
tens of meters, so computed prominence is a lower-ish estimate and computed
height ≠ official height. Fine for *filtering and ranking* (which is what
annotations need: "label the most prominent peaks in view"), not for
authoritative numbers. Cross-check a few known values (Sněžka prom ≈ 1197 m,
Praděd ≈ 1000 m) after implementing.

Bonus metric, nearly free: **isolation** (distance to nearest higher
ground) — useful for label placement priority alongside prominence.
Fixes the observed near-field annotation gap (see
summit-annotation-notes.md): current DB only has prom ≥ 100 m CZ hills, so
foreground silhouette bumps are unlabeled; with own prominence we can set
per-distance thresholds (near: prom ≥ 30 m, far: prom ≥ 300 m).

## Peak rating + label selection (practical filter before true prominence)

Problem observed in the web app: horizon hills are unlabeled (curated list
only has prom ≥ 100 m), but labeling all OSM peaks would flood the image
(~2 600 named+ele peaks in just 3 CZ cells). Key design decision: **no
global threshold can fix both** — the right label density is
view-dependent. Two stages:

### Stage 1 — offline rating (scripts/build_peaks_db.py, run-once)

For each 1×1° cell of `data/osm-peaks/` (loading the 8 neighbor cells too,
so border peaks get full context; missing neighbors = ocean/edge):

1. **Validate/fix elevation**: sample SRTM (max of 3×3 cells around the
   node); if OSM `ele` missing or |ele − srtm| > ~30 m, use the SRTM value
   and flag it (jl README already noted positions/elevations are sometimes
   off by hundreds of meters). Peaks without name are dropped; peaks
   without ele are now kept (SRTM supplies it).
2. **Dedup**: nodes with the same name within a few hundred meters — keep
   the higher/better-tagged one.
3. **Heuristic prominence** ("fake prominence"): windowed Kirmse sweep —
   run the union-find water-level algorithm on a window around the peak
   (e.g. 0.25–0.5°). Result is a lower bound of true prominence, exact
   whenever the key saddle lies inside the window; cap at window relief.
   Much cheaper than continental sweep, trivially parallel per cell.
4. **Isolation**: distance to nearest higher SRTM cell, expanding-ring
   search capped at ~25 km. Cheap for minor bumps (terminates fast),
   capped for majors. The "lonely hill" signal: high isolation with modest
   prominence still deserves a label locally.
5. Emit TSV: name, lat, lon, ele_used, ele_src(osm/srtm), prom_est,
   isolation_km. This file replaces/augments summits.tsv; thresholds do
   NOT live here — the file keeps everything with prom_est ≥ ~20 m.

### Stage 2 — view-time label selection (renderer/web)

Candidates = visible summits (existing distance-map test). Score each,
then greedy screen-space placement:

- score ≈ prom_est weighted by apparent size (angular height above the
  local silhouette), plus isolation bonus, plus **skyline bonus**: the
  distance map already knows whether the summit's pixel column has sky
  right above the silhouette it sits on — "part of a high ridge visible
  from far" scores high even though a ridge shoulder has low prominence.
- sort by score descending; accept a label only if no accepted label is
  within N px horizontally (N ~ label width); optionally two rows of
  labels (near/far) like peakfinder does.
- Result: skyline always gets its best labels, foreground bumps only when
  nothing better competes for the space — both complaints solved by the
  same mechanism, and sliders/zoom could later re-run selection live
  (it is cheap; candidates are already computed).

Relation to [true prominence pipeline](#summit-database-with-computed-prominence):
stage 1's prom_est column is a drop-in for real prominence once the
continental sweep exists; stage 2 is needed either way and can be built
first with the current curated TSV.

## Whole-Europe data archive (hedge against link rot)

Motivation: viewfinderpanoramas.org is a one-man site (Jonathan de
Ferranti) and could vanish; Overpass is unsuitable for continent-scale
queries anyway.

- **Heightmaps**: dem3 for Europe ≈ lat 35–72°N, lon −10–30°E (to western
  Ukraine/Romania: lon up to ~30°E covers both) → roughly 1500 tiles,
  ~2–3 GB zipped. `scripts/download_hgt.py` already maps tiles→graticule
  zips; add a mirror mode that keeps the original zips instead of
  extracting (cheaper storage, re-extract on demand) and rate-limits.
- **OSM peaks**: don't use Overpass for this — download per-country PBF
  extracts from Geofabrik (~dozens of MB each for peak-relevant countries;
  whole-Europe PBF ~30 GB if going all in) and filter offline:
  `osmium tags-filter europe.pbf n/natural=peak -o peaks.pbf`.
  Keeps the raw extracts archived; peaks TSV becomes reproducible offline.
- Store archive outside the repo (external disk), only scripts + checksums
  committed.

## Tile visibility index (fetch only tiles that can matter)

Problem: the app currently fetches a hardcoded tile range as if Mount
Everest could be anywhere — but from a Czech viewpoint the Polish lowlands
to the north are provably invisible long before 250 km. Precompute
conservative visibility bounds so mobile/web fetches only tiles that can
contribute. Game engines call this a PVS; virtual globes call it horizon
culling. Three levels, all tiny:

### Level 1 — smooth-Earth reach, one number per tile (~3 KB Europe)

Over a smooth Earth with refraction-scaled radius R′ ≈ 7520 km, observer
at h₀ and peak at M can see each other at most at

    d_max = sqrt(2 R′ h₀) + sqrt(2 R′ M)

The second term is per-tile: precompute `maxEle` per tile (scan the zst
mirror once, `scripts/build_tile_index.py` → `data/tile_maxele.tsv`).
Numbers: Sněžka tile reaches ~155 km, flat Polish tile (150 m) ~47 km,
Kamenice observer term (780 m) ~108 km → Polish tile 200 km away is
provably invisible. Key design rule: the **observer term is never
precomputed** — h₀ is known at view time (user may sit on a 100 m tower or
raise the eye to see over the local hill), so compute it live; only
target/occlusion data gets baked. Conservative in the safe direction
(ignores blocking terrain — real terrain only sees less). Fetch-time
filter is one line in app.js. Do this first; an hour of work, most of the
practical win.

### Level 2 — coarse occlusion prepass, per-direction limits (~1 MB Europe)

0.1° (~10 km) block grid with per-block **min and max** elevation. At view
time, before fetching, run the existing raycaster on the coarse grid —
few hundred columns × ~25 samples, microseconds — to get a per-azimuth
upper bound on useful distance → visibility fan → fetch only tiles the
fan touches. Conservativeness rule: block **max** is valid for targets
("could something here poke above the sightline?"), block **min** for
occluders ("does terrain here provably block?") — min keeps see-through
valleys open. A false "visible" costs a download; a false "blocked" would
amputate the panorama. Realistic cut for a CZ interior 360° view: ~30
tiles → 15–20.

Bonuses from the same structure: the min/max pyramid is the "maximum
mipmaps" acceleration structure from GPU terrain ray-marching — the
renderer itself could stride through provably-empty foreground instead of
stepping every 50 m. And the reverse query ("from which blocks does peak X
clear the sightline?") gives viewshed maps nearly free.

### Level 3 — tile-pair PVS bits (~280 KB Europe, offline)

For every ordered tile pair, one bit: "can any observer in A possibly see
terrain in B", computed offline with observer ≤ maxEle(A) + Δ headroom
(Δ ~ 100–200 m covers towers; sqrt makes headroom cheap — 200 m costs
~13 km of reach). Download set becomes a single row lookup. Runtime
guard: if actual h₀ > maxEle(A) + Δ, ignore the bits and fall back to the
live level-1 bound — fatter set, never a wrong one. Only worth building
if offline tile pre-caching for hiking becomes real.

## Interactive desktop app (ImGui/SDL3 lab first, Qt/QML if it becomes a product)

The core (heightmap/distmap/summits/tonemap) has no UI dependencies, and
the WASM build proves the core drives fine through a thin interface.
Either shell is a day of plumbing.

- **ImGui + SDL3** = interactive lab: live sliders (visibility re-tonemap,
  refraction re-raycast), hover readout of distance/azimuth from the
  distance map, click an unlabeled bump → query rated/rejected DB for the
  reason, tune gate constants with immediate feedback. ImGui's FreeType
  atlas renders UTF-8 labels properly.
- **Qt/QML** earns its weight only as a product: QtLocation location
  picker, QPrinter → PDF (printable scroll), file dialogs. Framework
  ceremony that experimentation doesn't need; the mobile PWA may claim
  the product role anyway.

**Render only the viewport.** Columns are independent (no cross-column
state), so rendering an azimuth sub-window is trivially exact. A 1920 px
viewport is ~18 % of the 10 472-column full strip → ~27 ms native, i.e.
real-time pan at 1080p and still a fraction of the strip at 4K.
Speculatively render a margin around the viewport (grayscale distance
data is cheap) and re-render outward on idle.

### Where the CLI stops (2026-07-16)

`panorama_photo.png` gained `-l/-fg/-bg` (commit 3d54aef). The natural
next asks — label color, label halo/outline (toggle + color), scene from
the command line (lat/lon, azimuth window, elevation window, distance) —
are each trivial, but ten flags deep the CLI re-invents a config file
badly. Boundary that seems right:

- **Style knobs** (label color, halo): one annotation-style struct shared
  by the print and photo outputs, sane defaults, expose only what a print
  run actually varies. Halo/outline doubles as the legibility fix for
  blue-on-sky labels, so it pulls its weight.
- **Scene definition**: instead of one flag per parameter, accept the web
  app's own URL query syntax — `panorama --scene
  'lat=49.60&lon=16.16&az=30&dist=250'` (or a pasted full URL). One
  parser, zero new conventions, and it enables the real workflow: find
  the view on the phone, share the URL, print it from the desktop at
  0.1 mrad. A scene *file* is then just that string in a text file.
- **Feedback loops** (tuning colors, hunting azimuths) are the ImGui lab
  / web app's job — more flags can't compete with a slider, so don't try.

## Sector cache + speculative rendering (web/PWA)

**Status 2026-07-16: implemented in web/app.js as designed** — 12×30°
sectors, LRU cap 6 canvases, idle neighbor prefetch in the scroll
direction, render distance capped at 1.2× visibility, tile fetch limited
to the distance disc. **2026-07-18: worker-thread rendering done too**
(web/worker.js owns the WASM module; renders return ImageBitmaps, tile
unzstd moved off-thread). Still open: per-sector re-render on late
tiles; Emscripten pthreads for parallelFor inside a sector (~3–4× on a
phone, needs COOP/COEP headers on the nginx side).

Today (0fd2e59) the web app renders one 60° sector and re-renders from
scratch when the compass leaves it — a visible ~600 ms+ stall at every
sector edge. Column independence makes the fix mechanical:

- **Fixed 30° sectors aligned to the compass rose** (0–30, 30–60, …; 12 per
  circle). Cache key = sector index + eye + distMax + refraction + step.
  Each sector is its own offscreen canvas + kept dist-map copy — *not* one
  360° strip canvas: 63k × 901 px ≈ 57 MP exceeds iOS Safari's canvas area
  cap, and per-sector eviction is free. `draw()` composites the 2–3 sectors
  intersecting the viewport.
- **Speculative prefetch**: after the current sector lands, render its two
  neighbors in the turn direction on idle (single render already blocks the
  main thread ~600 ms — chunk it per-sector, or per half-sector if that
  still stutters the compass scroll). A user panning steadily never sees a
  render; a 360° sweep costs 12 background renders once, then is free.
- **Labels per sector** via pano_summits on the sector's az window with a
  small overlap margin; spacing suppression runs per composite view so
  seam-adjacent labels don't collide.
- **Distance cap from visibility (lossless speedup)**: meteorological
  visibility V is *defined* as the 2 % contrast distance (Koschmieder), so
  terrain beyond ~1.2 V is indistinguishable from sky in the tonemapped
  output. Rendering with distMax = 1.2 × visibility-slider instead of a
  fixed 250 km changes nothing visible while cutting both the ray marching
  (sky pixels walk the full distMax — they dominate cost) and the tile
  fetch radius: 100 km visibility → 120 km cap → ~12 tiles instead of 40,
  and roughly half the render time. Raising the slider past the cap
  invalidates the sector cache (rare, explicit user action).

Query: from (49.1454, 15.6990), what is at azimuth 35.12° distance ~65 km?
Answer should rank *any* identifiable feature near that ray: hill, village,
radio tower, chimney, power plant cooling tower, castle ruin — the things
one actually squints at through binoculars.

- Data: generalize extract_geofabrik_peaks.py into a tags-filter list —
  `place=village/town/city`, `man_made=tower/mast/chimney/works`,
  `power=plant`, `historic=castle` … from the same PBF extracts → one
  SQLite/TSV of (type, name, lat, lon, ele?, height-tag).
- Matching: candidate features inside an angular/distance tolerance cone
  around the ray; verify against the distance map (same testPixel idea as
  summits — the map already knows what is visible at that pixel); rank by
  angular proximity × feature size.
- Desktop app queries the SQLite directly, no server. A tiny server
  (Python FastAPI or Rust axum — a chance to keep the Rust muscle warm)
  wraps the same lookup for web/PWA clients where the DB doesn't fit
  client-side. Same endpoint later answers PWA "tap on screen → what is
  it" queries.

## Portability / infrastructure cleanup (pre-desktop-app)

- **Done — self-contained native build.** Parallelism is own `parallelFor`
  (src/parallel.hpp: dynamic scheduling over one atomic counter, serial
  fallback, exception-safe); PNG via own writer on bare zlib
  (src/pngwrite.cpp: chunks + CRC32 + Up-filtered scanlines; gray8/16,
  rgb24/48 share one code path); text via the SDF atlas. Native binary
  links only zlib + libstdc++. WASM-side PNG export stays JS-owned
  ("download PNG" = `canvas.toBlob()`).
- **Text: baked SDF/MSDF atlas, no HarfBuzz.** HarfBuzz is a shaping
  engine (Arabic joining, Indic reordering); CZ/SK/DE/PL/HU/RO + Greek +
  Cyrillic are precomposed NFC codepoints with plain advances — simple
  layout is fully correct. Bake atlas offline (msdfgen, DejaVu Sans),
  commit atlas PNG + metrics; runtime = bilinear sample + threshold,
  45° labels stay crisp (bitmap fonts would not). Bake the glyph set
  from the peaks TSVs — exactly the alphabet the database uses.
  Fallback: stb_truetype runtime bake with 3× oversampling.
- **Share the tonemap.** Koschmieder/OkLab fog lives only in wasm_api;
  move to core (tonemap.cpp) so native panorama.png matches the web look
  ("web version is more true"). outlines.png stays as the print-friendly
  mode; also step one of the printable scroll.

## Printable panorama scroll

Print-quality output for a physical viewpoint panorama — the classic
orientation-table / summit-book format, generated instead of hand-drawn.
panorama.png is already almost printer-friendly (line art on white);
what's missing, roughly in dependency order:

**Distance cue in ink, not fog.** Engraved panoramas encode depth as line
weight/density: near silhouettes heavy, far ridges hairline-light. We get
this nearly free — outline strength × exp(−d/D) with D ≈ 150–200 km is
Koschmieder again with paper white as the "sky color"; the shared-tonemap
refactor covers screen (ink→sky blue) and print (ink→paper) with one
formula. A print palette: labels near-black (solarized blue dithers to mud
on a B&W laser), stems ~50 % gray, label text already carries "(83 km)" as
the honest distance cue. Deliberately do NOT fade label ink with distance —
labels are the payload, terrain lines alone carry the depth. Depth cue may
be optional anyway: the scroll lies in front of the real view, reality
supplies the depth.

**Print resolution is a different renderer regime.**

- Source data: 90 m SRTM3 silhouettes look fine at screen scale but
  stair-step in print; wants 1-arcsecond tiles (some already mirrored in
  data/hgt1-zst/) + bilinear heightmap sampling. Needs HeightMap to take
  tile size at runtime (1201 vs 3601) and ~9× memory (a 28-tile view
  ≈ 1.5 GB — fine natively). Bilinear + 1″ changes silhouettes, so this is
  a print/quality mode, not a default (bit-parity discipline stays on the
  3″ nearest path).
- Laser printers cannot print pixels 1:1: the RIP downscales/halftones
  (a "1200 dpi" PDF typically lands on a 600 dpi engine), grayscale
  becomes halftone rosettes, and strokes under ~2 device px (~85 µm at
  600 dpi) drop out. So render 1-bit black&white at device resolution
  (600 dpi), doing our own thresholding: distance fade becomes stroke
  *weight* (near ~4 px, far 2 px minimum) or ordered dither under our
  control instead of the printer's.
- Paging: A4 landscape ≈ 277 mm printable → at ~8 mm/deg that's ~33°/page,
  11-page leporello for 360°; each page needs a few degrees of overlap,
  cut marks, and its own azimuth scale so misordered pages are obvious.
  Title block (viewpoint name/coords/elevation, date, refraction/visibility
  used) + QR code linking the web app with the viewpoint preselected
  (URL params: lat/lon/ele — needs the location-picker milestone);
  `qrencode` or python qrcode lib.
- Assembly: PDF from the 1-bit PNGs — `img2pdf` embeds PNG losslessly
  (no recompression, no resampling); a 600 dpi 1-bit A4 page is ~4 MB raw
  and compresses to a few hundred KB. No Cairo needed anywhere.

Use case: viewpoints that have a book/board already — leave a better one.

## Magnetic declination (compass follow)

Phone sensors report *magnetic* headings; no web API exposes true north
(native Android/iOS get it in one call — browsers don't). Current
limitation: a manual `decl=` URL offset, and a fixed value ≈ +5° is good
enough for Europe in 2026 (drifts ~ +0.15°/yr).

Rejected shortcut — bearing to the magnetic dip pole from the GPS fix:
the needle follows local field lines, not great circles to the pole
(field is only ~90 % dipole). Checked 2026-07: Prague +5.1° vs actual
+5° (lucky fluke), Tokyo −0.1° vs −8°, Seattle −6.1° vs +15°, Cape Town
+4.5° vs −26°. Same maintenance burden too — the dip pole moves
~45 km/yr. And the app is useless outside Europe anyway until the summit
DB covers it.

Proper fix, later: vendor a WMM evaluation into app.js — the WMM2025
coefficient table is ~6 kB (90 spherical-harmonic terms, valid to 2030),
small enough to hardcode into the JS; declination from (lat, lon, date)
computed once per GPS fix, `decl=` demoted to a manual override /
calibration nudge.

## Time-of-day palette (sun-elevation → 3-color table)

**Status 2026-07-18: implemented.** `scripts/make_sky_palette.py` →
`web/sky-palette.json` → hardcoded table in app.js behind the 🌇 toggle
(`sky=1`); web default palette is the table's +30° row. Model, tuning
iterations and what got faked: `docs/sky-palette-notes.md`. Still open
below: visibility as a second table axis, azimuth-dependent horizon.

Observation (Pokémon Go, of all things, does this well): day/sunset/night
color grading that stays *legible* — night sky is dark but never black.
Our whole look is controlled by 3 colors — terrain ink, sky at horizon,
sky above — so a full day cycle is just those three as functions of sun
elevation, which the web app already computes (NOAA port).

- **Precompute in Python**: sample a physical sky model (Hosek–Wilkie has
  reference implementations; or pixel-sample Stellarium screenshots) at
  the horizon and ~+30° for sun elevations −18°…+15° in a few-degree
  steps → a ~20-row table of 3 RGB triples, hardcodeable anywhere.
  Interpolate between rows in OKLab (colors.cpp already speaks it).
- **The contrast model survives sunset.** Koschmieder fades distant
  terrain toward the horizon color *whatever that color is* — ridges
  vanish into orange exactly as they vanish into white, and near
  silhouettes get MORE contrast (near-black vs. bright orange, like
  reality). The danger zone is night, where terrain and sky are both
  dark: clamp a luminance floor / minimum ΔL between the three colors,
  which is exactly the game's trick.
- v1 ignores azimuth dependence (real sunset is orange only around the
  sun, blue-grey opposite, pink antisolar arch). A later refinement could
  lerp the horizon color by |azimuth − sun azimuth|; overlay-level, the
  tonemap needn't know.
- **Validate with the native CLI first**: needs an explicit
  horizon-color flag — today the horizon color is derived inside the
  tonemap (85 % push toward white from the sky color), so exposing it is
  a deliberate tonemap-signature change (hash-update rules apply, flag
  defaults must reproduce today's output bit-exactly). Then a sunset
  animation is a shell loop over sun elevation → frames → ffmpeg.
- Subsumes the "sky gradient" and "warm-near/cool-far preset" bullets
  below once it exists: those are just rows of this table.

Field observations (webcams, 2026-07-18) and where the v1 model stops:

- **Blue hour is missing.** An hour before sunrise the real sky is deep
  blue (ozone-filtered *multiple* scattering — single scattering yields
  ~zero there, so our clamps output neutral grey). Cheap fix: tint the
  clamp floors blue (fixed OKLab hue ≈ a −0.01, b −0.04) instead of grey.
  Webcams also auto-expose far past our 5 EV adaptation cap, so they look
  brighter than our deliberately-dark night by design.
- **Haze reorders the gradient.** At low visibility the sky near the
  horizon is a brownish aerosol band with the bright band lifted above
  it (brown → orange → white → blue upward). The palette therefore
  depends on visibility → make the table 2D: sun elevation × visibility
  (~3 columns, hazy/normal/clear), generated by scaling BETA_MIE_S from
  the Koschmieder relation β ≈ 3.912/V. The 3-color model survives:
  within the app's ~5° strip the right horizon color in haze is simply
  the brown, and the bright band sits above the viewport. Only a
  wide-elevation clear-sky window (print mode) would need a 4-stop
  vertical gradient.

Separate but adjacent gripe — **done 2026-07-18**: the solarized-dark
UI theme is gone. The web app now uses Terafox (nightfox.nvim), declared
as raw palette + semantic roles (`--bg`, `--panel`, `--accent`, `--ink`,
`--sun`, …) in index.html's `:root`; the canvas overlay reads the same
variables via getComputedStyle, so a re-theme is one CSS block.
`--accent2` (apricot) is reserved for a future peak-search cursor. The
native CLI keeps its solarized-blue label ink (parity reference, don't
care). SVG icons for the three remaining bar buttons still pending.

## Renderer (carried over, see also mobile-app-plan.md)

- Transcendental interpolation in ray loop (exact lat/lon every ~16th
  sample, lerp grid indices) — 2–4× expected, do before WASM port.
- Hillshading from hit-point normals; aerial-perspective fog
  `lerp(shade, sky, 1−exp(−3.912 d/V))` with visibility V as parameter.
- Refraction coefficient as CLI parameter (1.18 = inversion day fit;
  summer ~1.10–1.14).
- ~~Bilinear heightmap sampling~~ done: `-b/--bilinear` (native CLI);
  web default flip pending a phone A/B — regenerating dist_native.bin +
  the tonemap hash is the deliberate act that flips it.
- **Sky gradient (2-stop OkLab, hue shift not just lightness).** Firewatch
  reference: teal zenith → pale warm haze at the horizon; the flat sky
  slab is the biggest visual gap vs. that look. One lerp in the tonemap.
- **Warm-near / cool-far palette preset.** Painter's rule: near terrain
  warm (ochre), all distance cues cool. Pure -fg/-bg + sky-gradient
  values, no algorithm change — candidate default for the photo style.
- **Auto elevation window.** Fixed elMax (+1.9°) clips nearby higher
  hills (valley viewpoints, big neighbors). Probe max elevation angle in
  a near-field ring of atGrid samples before rendering, set elMax with
  margin. Web: boot-time decision — all sectors must share one height.
- Horizon line: useful instrumentation on summits, visual noise on the
  plain photo — draw it only with -l / in the web app.
- Scene parameters from config file / CLI instead of #if 0 blocks in main.
- ~~UTF-8 labels~~ done: SDF font atlas (scripts/bake_font_sdf.py +
  src/sdftext.cpp); on web, Canvas2D fillText.
- Report "obscured by ridge X" for rejected summits instead of silently
  dropping (data is already in the distance map).
