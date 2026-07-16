# Mobile panorama app — implementation plan

Goal: point the phone at the horizon, see the rendered panorama with summit
labels aligned to reality. Reuse the existing C++ renderer. Written as a
self-contained reference (2026-07-12).

## Architecture decision

**PWA (web app), no server-side code.** Two layers only:

1. **JavaScript in the browser** — owns *all* I/O: GPS, orientation sensors,
   `fetch()` of tiles, IndexedDB storage, canvas blitting, touch gestures.
   HTTPS is provided by the static file host, never by our code.
2. **Existing C++ core compiled to WASM** (Emscripten) — a pure-compute
   library: heightmap bytes in, panorama strip pixels out. No main loop, no
   networking, no filesystem.

Rejected alternatives, and why:

- **Native app (Kotlin/Swift)** — zero code reuse of sensors knowledge,
  app-store friction; offline is NOT a native privilege (see Storage below).
  Escape hatch if ever needed: Capacitor wraps this same web app in a native
  shell — nothing built here is throwaway.
- **PC server rendering / phone as thin client** — solves the wrong problem:
  the app is useful on a summit, exactly where there is no LAN and marginal
  data. At home a desktop browser serves the armchair use case directly.
- **Rust rewrite** — Rust targets WASM fine but the C++ core already exists;
  same .wasm either way.
- **Mesh terrain engine with LODs** — right tool for a *translating* camera
  (flyovers). Our camera only rotates; a cylindrical strip is the exact,
  minimal primitive for rotation-only. A mesh engine means LOD stitching,
  culling, streaming, occlusion queries — a different project.

### Key algorithmic insight

The render is **view-independent per location**: render a full 360° strip
once per GPS fix (seconds), then compass/gyro merely *scrolls a viewport*
over the strip at 60 fps. Sensors never touch the raycaster. Re-render only
when the user moves a few hundred meters.

Resolution budget: phone camera FOV ~65° across ~1200 screen px ⇒ display
needs only ~1 mrad/px. Render the strip at 0.25–0.3 mrad; full 360° is
~25k × 2k px @ 2 B/px (grayscale dist map) ≈ a few MB. The Comanche look is
a feature; pretty shading comes later.

## WASM ↔ JS interface

Emscripten `cwrap`/`ccall` over a C ABI; no bindings framework needed.
Entire surface:

```cpp
extern "C" {
  // called by JS after it fetched+decoded tiles (JS owns networking)
  void hm_reset(int minLat, int minLon, int maxLat, int maxLon);
  void hm_addTile(int lat, int lon, const uint16_t* data, int size);

  // renders 360° (or given azimuth range) strip into an internal buffer
  // returns pointer into WASM heap; JS wraps it in a Uint16Array view
  const uint16_t* pano_render(double lat, double lon, double eyeEle,
                              double azMinR, double azMaxR,
                              double stepRad, int* outW, int* outH);

  // summit annotations: JS passes the TSV, gets back visible summits
  // (name, x, y, distance) e.g. as JSON string; JS draws labels on canvas
  const char* pano_summits(const char* tsvData);
}
```

Division of labor: C++ = dist map + visibility test. JS = label drawing on
canvas (Canvas2D `fillText` does UTF-8 correctly), sky color, fog
shader (either JS per-pixel or later inside C++).

Build notes:

- `emcmake cmake -B build-wasm -S .` with an `EMSCRIPTEN` branch in
  CMakeLists (compute-only target; `parallelFor` falls back to serial
  there).
- **Start single-threaded.** Emscripten pthreads need SharedArrayBuffer ⇒
  COOP/COEP response headers ⇒ hosting hassle. A once-per-fix render is fine
  on one core. Enable `-msimd128` (WASM SIMD) for free vectorization.
- Link flags: `-sMODULARIZE=1 -sEXPORTED_FUNCTIONS=...`
  `-sEXPORTED_RUNTIME_METHODS=ccall,cwrap -sALLOW_MEMORY_GROWTH=1`.
- The transcendental-interpolation optimization (compute exact lat/lon every
  ~16th ray sample, lerp grid indices between) matters most here — do it
  before profiling on a phone.

## Browser API map (the "mobile SDK" is just these)

| concern | API | gotchas |
|---|---|---|
| GPS | `navigator.geolocation.watchPosition(cb)` | HTTPS only; browser shows its own permission prompt. **Ignore GPS altitude** (±20 m, ellipsoidal) — sample own heightmap at the fix + 2 m eye height |
| compass/gyro | `deviceorientationabsolute` event (Android); `webkitCompassHeading` (iOS) | iOS requires `DeviceOrientationEvent.requestPermission()` called from a user tap (show a button). OS does sensor fusion; we receive angles |
| magnetic declination | none — correct manually | compass gives *magnetic* north; declination in Central Europe ≈ +5° (2026) — one Sněžka-width of label error. Use a small JS WMM (World Magnetic Model) implementation, or offer manual calibration ("drag until labels match") |
| storage | Cache API (service worker) + IndexedDB; `navigator.storage.persist()` | Android: solid. iOS: may evict after weeks of disuse → occasional region re-download |
| gestures | Pointer Events on `<canvas>`, `touch-action: none` | pan = pointermove delta; pinch = two-pointer distance ratio; ~50 lines, no library |
| offline | service worker caches app shell + tiles | app opens in airplane mode after first visit |
| install | `manifest.json` (name, icons, `display: standalone`) | "Add to home screen", looks like an app |

Development without a phone: desktop Chrome DevTools emulates geolocation
(type coordinates) and orientation (drag 3D phone widget). Phone testing:
deploy to GitHub Pages (free HTTPS) or `adb reverse` so the phone sees the
dev server as localhost (localhost is exempt from HTTPS rule).

## Tile data pipeline (Python, run-once — scripts/)

Problem: 250 km radius ≈ 28 SRTM tiles ≈ 80 MB raw. Solution: resolution
pyramid, since beyond ~50 km the silhouette doesn't benefit from 90 m posts.

- Preprocess (extend `scripts/`): chop `.hgt` into web tiles, e.g. PNG16
  grayscale (browsers decode natively — JS `createImageBitmap` + canvas
  readback, or decode in WASM), levels: full res / 2× / 4× downsampled.
- Result ≈ 20–30 MB per CZ+SK-sized region.
- Host as static files next to the app. JS fetches only tiles in view
  radius; "download region" button prefetches into IndexedDB for offline.

## Milestones (each independently satisfying)

Status 2026-07-16: 0–1 done earlier; 3 done (0fd2e59 — URL scene state,
geolocation, compass follow with adaptive smoothing, safe eye height from
the heightmap). The 30° sector cache is in: compass/buttons only scroll a
virtual 360° strip of LRU-cached sector canvases, idle prefetch renders
the neighbor in the travel direction, render distance capped at 1.2×
visibility (lossless, Koschmieder), tile fetch limited to the distance
disc. Declination is a manual `decl=` URL param for now (≈ +5 in Central
Europe 2026) — a JS WMM evaluation or drag-to-calibrate remains open.
Milestone 2 is being satisfied without Leaflet: URL params + GPS today, a
nearby-hills landing page (list from peaks-rated.tsv) planned instead of a
map. 4 (offline) and 5 (PWA manifest/fullscreen-on-iOS) open.

0. **Sensor page, no WASM, no build system** (~100 lines JS): show live
   GPS lat/lon/accuracy + compass heading + pitch as text. Walk around.
   De-risks permissions, iOS quirks, sensor noise in isolation.
1. **Emscripten build + canvas on desktop**: hardcoded viewpoint, tiles
   fetched from local static server, arrow keys pan the strip. Proves the
   toolchain end to end.
2. **Location picker**: Leaflet/OSM mini-map click → re-render. Still
   desktop. (This is already a useful product — udeuschle replacement.)
3. **Phone**: deploy to HTTPS host; orientation listener scrolls the strip;
   iOS permission button; declination correction. The "hold phone up,
   labels align" moment.
4. **Offline**: service worker, "download region" button, persisted storage.
5. **PWA manifest** → installable. Optional polish: pinch zoom, camera
   passthrough underlay (`getUserMedia`) with panorama as overlay = AR mode.

## Performance expectations

Desktop reference (this repo, 4 cores): 45° @ 0.1 mrad in 0.8 s.
Full 360° @ 0.25 mrad ≈ similar pixel count ⇒ ~1–2 s native. Phone WASM
single-thread ≈ 3–8 s before optimizations; transcendental interpolation
(~2–4×) brings it to seconds; progressive refinement (render 1 mrad
instantly, refine in background) hides the rest. If ever insufficient:
WASM pthreads (accept COOP/COEP), then WebGPU compute (algorithm maps
cleanly: one thread per column, curvature stays a per-distance 1D LUT,
hardware bilinear heightmap sampling for free — but iOS WebGPU still has
rough edges).

## Related renderer track (independent of mobile)

- Hillshading: store hit-point terrain normal (finite differences at hit)
  → Lambertian shade with sun direction.
- Aerial perspective ("dist map shader"): per-pixel
  `lerp(terrainShade, skyColor, 1 − exp(−3.912·d/V))`, V = meteorological
  visibility as parameter. Makes renders photo-comparable; predicts which
  ridges are distinguishable on a given day.
- Refraction coefficient as CLI parameter (1.18 fit an inversion day;
  summer convection ⇒ ~1.10–1.14, error grows ~d², visible at 60–90 km).
- Bilinear heightmap sampling (kills 90 m stair-stepping on near ridges).
- See docs/summit-annotation-notes.md for the visibility-test analysis
  (obscured peaks are correctly rejected; near-field gaps are database
  coverage, not test failures).
