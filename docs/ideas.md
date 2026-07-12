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

## Printable panorama scroll

Print-quality output for a physical viewpoint panorama — the classic
orientation-table / summit-book format, generated instead of hand-drawn.
The native renderer already produces full-res annotated PNGs; missing is a
print layout pass:

- 360° at 20 px/deg (udeuschle-style) ≈ 7200 px wide → ~60 cm at 300 dpi,
  or fold-out leporello strips for higher resolution; title block with
  viewpoint name/coords/elevation, azimuth scale along the full edge.
- Labels styled for print (black on white outlines, no fog background —
  the existing outlines.png mode is exactly right for this).
- QR code linking to the web app with the viewpoint pre-selected
  (URL params: lat/lon/ele — needs the location-picker milestone anyway);
  `qrencode` CLI or python qrcode lib in a script. panorama-jl already has
  a project QR (project-qr.png) — tradition continues.
- Output PDF (cairo would do this natively — another argument for the
  planned cairo text backend) or just a print-ready PNG strip.

Use case: viewpoints that have a book/board already — leave a better one.

## Renderer (carried over, see also mobile-app-plan.md)

- Transcendental interpolation in ray loop (exact lat/lon every ~16th
  sample, lerp grid indices) — 2–4× expected, do before WASM port.
- Hillshading from hit-point normals; aerial-perspective fog
  `lerp(shade, sky, 1−exp(−3.912 d/V))` with visibility V as parameter.
- Refraction coefficient as CLI parameter (1.18 = inversion day fit;
  summer ~1.10–1.14).
- Bilinear heightmap sampling.
- Scene parameters from config file / CLI instead of #if 0 blocks in main.
- UTF-8 labels: Cairo or OpenCV freetype module (Hershey fonts are
  ASCII-only); on web, Canvas2D fillText solves it.
- Report "obscured by ridge X" for rejected summits instead of silently
  dropping (data is already in the distance map).
