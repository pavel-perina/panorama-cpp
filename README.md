# panorama-cpp

C++23 port of [panorama-jl](https://github.com/pavel-perina/panorama-jl) /
panorama-rs: renders a terrain panorama (distance map) from SRTM heightmaps
as seen from a given location, extracts outlines and annotates visible
summits. See `docs/` for the mobile PWA plan, ideas notebook and
summit-annotation analysis.

## Build & run

Dependencies: CMake ≥ 3.20, GCC ≥ 14 (uses `std::println`), zlib (own PNG
writer, `src/pngwrite.cpp`). Parallelism is std::thread only
(`src/parallel.hpp`) — no OpenMP, no OpenCV.

```sh
cmake -B build -S .
cmake --build build -j
./build/panorama [dataDir]        # default dataDir: data
```

Scene parameters (viewpoint, azimuth/elevation window, resolution, max
distance, refraction) are hardcoded in `src/main.cpp`. Outputs to the
current directory: `dist_map.png` (16-bit distances), `outlines.png`,
`panorama.png` (annotated, printer-friendly) and `panorama_photo.png` —
the same aerial-perspective tonemap as the web app, byte-identical pixels
(guarded by the hash check in `web/test-node.mjs`). Photo options:
`-l/--label` draws the summit labels + azimuth ruler on it,
`-fg/--foreground-color` and `-bg/--background-color` set the terrain and
sky colors (hex `RRGGBB`, defaults match the web palette).

Tiles are read from `hgt3-zst/N49E015.hgt.zst` (the 3-arcsec mirror layout;
`hgt-zst/` is accepted as the legacy name) with plain `N49E015.hgt.zst` /
`N49E015.hgt` in the data dir as fallbacks (vendored zstd decoder,
`src/3rd_party/zstd/`). All four hemispheres work — southern/western tiles
use SRTM's `S34W071.hgt` naming (floored SW corner). Not handled:
antimeridian-crossing scenes and sub-sea-level terrain (clamped to 0 m).

## Web app (WASM)

```sh
source ~/emsdk/emsdk_env.sh
emcmake cmake -B build-wasm -S . && cmake --build build-wasm -j
python3 -m http.server 8000      # from repo root, open http://localhost:8000/web/
```

Scene state lives in URL params, all optional:
`?lat=&lon=` viewpoint (default Kamenice), `dh=` eye height above terrain
(default +5 m; eye elevation = 3×3 heightmap max + dh, GPS altitude is
ignored), `ele=` absolute eye elevation override, `az=` sector center
(60° window), `dist=` max render distance in km (default 250; also sets
the tile fetch radius). Toolbar: 📍 geolocate, 🧭 compass follow (adaptive
heading smoothing; scrolls within the rendered sector, re-renders on
leaving it), N…NW direction buttons, ⛶ fullscreen. Sensors require HTTPS —
use the deployed host, not `http://` LAN addresses.

Self-hosting: see `deploy/` (podman quadlet + nginx). After a wasm or
web/ change, rerun `deploy/deploy.sh`. Beware the dev-server cache
hazard: `python3 -m http.server` sends no cache headers, so a browser can
pair a fresh `app.js` with a stale cached `pano.wasm` → "memory access
out of bounds"; hard-reload (Ctrl+Shift+R) fixes it.

Before the first run fetch heightmaps and a summit list (see below):

```sh
uv run scripts/download_hgt.py            # tiles for the default scene
uv run scripts/download_osm_summits.py    # or reuse data/summits.tsv from git
```

## Data scripts (Python via [uv](https://docs.astral.sh/uv/), run-once tools)

All scripts write into the project `data/` directory (resolved relative to
the script location, so they work from any CWD). Summary:

| script | purpose | output |
|---|---|---|
| `download_hgt.py` | fetch the raw `.hgt` tiles **the renderer needs** for one scene | `data/N49E015.hgt`, … |
| `mirror_hgt.py` | archival mirror of **all Europe** heightmaps, zstd-recompressed | `data/hgt3-zst/N49E015.hgt.zst`, … |
| `download_osm_summits.py` | quick bbox → summit TSV for the renderer (small areas) | `data/summits.tsv` |
| `download_osm_peaks.py` | archival crawl of **all Europe** OSM peaks, raw JSON per 1×1° cell + offline merge step | `data/osm-peaks/*.json.zst`, `data/peaks-europe.tsv` |
| `extract_geofabrik_peaks.py` | offline peak extraction from manually downloaded Geofabrik country PBFs | `data/geofabrik-peaks/*-peaks.json.zst`, `data/peaks-geofabrik.tsv` |
| `build_peaks_db.py` | peak rating stage 1: match OSM peaks against the `prominence` tool's sweep | `data/peaks-rated.tsv`, `data/peaks-rejected.tsv` |

The two `*_hgt` and the two `*_osm_*` scripts intentionally overlap: the
short ones serve the renderer today, the archive ones hedge against data
sources disappearing (see docs/ideas.md).

### download_hgt.py — renderer tiles

```sh
uv run scripts/download_hgt.py [min_lat min_lon max_lat max_lon]
uv run scripts/download_hgt.py              # default 47 15 50 21 (CZ/SK scene)
uv run scripts/download_hgt.py 45 6 48 14   # e.g. the Alps
```

Downloads the 4°×6° graticule zips from viewfinderpanoramas.org covering
the integer-degree range and extracts only the needed `N??E???.hgt` files
into `data/`. Skips tiles that already exist.

### mirror_hgt.py — Europe heightmap archive

```sh
uv run scripts/mirror_hgt.py                # everything (~70 zips, ≈2 GB, <1 h)
uv run scripts/mirror_hgt.py --max-zips 5   # short session, rerun to continue
uv run scripts/mirror_hgt.py --sleep 10     # be extra gentle (default 5 s)
```

Covers lat 35–72°N, lon 10°W–30°E, nearest-to-CZ archives first. Resumable:
already-mirrored tiles are skipped. A 2.88 MB tile compresses to ≈1 MB.
404s (islands / far north live in specially named archives) are reported at
the end for manual handling.

### download_osm_summits.py — quick summit list

```sh
uv run scripts/download_osm_summits.py [min_lat min_lon max_lat max_lon]
uv run scripts/download_osm_summits.py      # default 47 15 51 22
```

One Overpass query for named peaks with elevation in the bbox; writes
`data/summits.tsv` (`"Summit"  Elevation  Latitude  Longitude`), highest
first. Fine for country-sized areas; for Europe use `download_osm_peaks.py`.

### download_osm_peaks.py — Europe peak archive

```sh
uv run scripts/download_osm_peaks.py                 # crawl (≈1480 cells, 5–6 h)
uv run scripts/download_osm_peaks.py --max-cells 200 # evening-sized chunk
uv run scripts/download_osm_peaks.py --sleep 15      # gentler (default 10 s)
uv run scripts/download_osm_peaks.py --clean         # offline: merge cells → TSV
```

Crawls `natural=peak` nodes cell by cell in a spiral starting at the Czech
Republic (interesting data first), storing **raw** Overpass JSON as
`data/osm-peaks/N49E015.json.zst` — nothing is filtered at download time.
Interrupt any time; rerun skips existing cells. `--clean` runs offline and
merges all cells into `data/peaks-europe.tsv`, keeping named peaks with a
parsable `ele` tag (in CZ roughly half the named peaks lack one — their
elevations will eventually come from heightmaps instead, see the prominence
pipeline in docs/ideas.md).

## Peak rating pipeline (stage 1)

Turns raw OSM peaks into a rated database (docs/ideas.md "Peak rating").
The work is split by language on purpose:

- **C++** (`prominence`, native-only CMake target — not part of the WASM
  build) does the one numerically heavy step: a Kirmse water-level
  union-find sweep over ~100M stitched heightmap cells, emitting every grid
  local maximum with its prominence, key saddle and isolation. ~12 s for
  CZ+AT+SK; pure Python would take about an hour per rerun.
- **Python** (`build_peaks_db.py`) does the messy-but-cheap data cleaning:
  OSM JSON parsing, elevation repair, dedup, accept/reject decisions.
  Reruns in ~1.5 s, so matching heuristics can be tweaked freely without
  touching the expensive sweep.

They meet at `data/prominence.tsv`:

```sh
cmake --build build -j --target prominence
./build/prominence 46 9 50 22            # minLat minLon maxLat maxLon
./build/prominence 46 9 50 22 data 10 data/prominence.tsv   # + defaults spelled out
uv run scripts/build_peaks_db.py         # -> peaks-rated.tsv / peaks-rejected.tsv
uv run scripts/build_peaks_db.py data/osm-peaks/*.json.zst  # alternate source
```

Load the sweep region generously around the area of interest: prominence is
exact only when a peak's key saddle lies inside the region (fewer escape
routes to higher ground otherwise → overestimate). Only named OSM peaks are
rated; everything rejected lands in `peaks-rejected.tsv` with a reason
(no prominent SRTM peak nearby / low prominence / duplicate / outside
region). `peaks-rated.tsv` keeps summits.tsv column order, so the renderer
can read it directly; extra columns carry `EleSrc`, `Prominence`, `Saddle`,
`IsolationKm` for view-time label selection (stage 2, not yet built).

## Data sources

- Heightmaps: NASA SRTM (Shuttle Radar Topography Mission, public domain),
  using the void-filled 3-arcsec versions by Jonathan de Ferranti,
  <https://viewfinderpanoramas.org> — a personal site; keep the scripts'
  default pauses.
- Peaks: © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright),
  via Overpass API (fair use: sequential requests with pauses). For bulk
  work prefer Geofabrik PBF extracts + osmium.
- `data/summits.tsv` in git: CZ prominence ≥ 100 m (ultratisicovky.cz) +
  SK prominence ≥ 200 m (peaklist.org) lists inherited from panorama-jl.

## License

MIT (see `LICENSE`). Bundled third-party components keep their own
licenses:

- `src/3rd_party/zstd/` — Zstandard decoder, BSD (Meta Platforms; see the
  `LICENSE` file there).
- `src/common/colors.{h,cpp}` — MIT, portions derived from Björn
  Ottosson's OKLab reference code (MIT).
- `data/fonts/font-sdf.bin` — baked from the Inter typeface, SIL Open
  Font License 1.1 (`data/fonts/Inter-LICENSE.txt`).

Peak data derived from OpenStreetMap (`data/summits.tsv`,
`data/peaks-rated.tsv`, …) is © OpenStreetMap contributors and licensed
under the ODbL, not MIT.
