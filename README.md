# panorama-cpp

C++23 port of [panorama-jl](https://github.com/pavel-perina/panorama-jl) /
panorama-rs: renders a terrain panorama (distance map) from SRTM heightmaps
as seen from a given location, extracts outlines and annotates visible
summits. See `docs/` for the mobile PWA plan, ideas notebook and
summit-annotation analysis.

## Build & run

Dependencies: CMake ≥ 3.20, GCC ≥ 14 (uses `std::println`), OpenCV 4
(core/imgproc/imgcodecs), OpenMP.

```sh
cmake -B build -S .
cmake --build build -j
./build/panorama [dataDir]        # default dataDir: data
```

Scene parameters (viewpoint, azimuth/elevation window, resolution, max
distance, refraction) are hardcoded in `src/main.cpp`. Outputs to the
current directory: `dist_map.png` (16-bit distances), `outlines.png`,
`panorama.png` (annotated).

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
| `mirror_hgt.py` | archival mirror of **all Europe** heightmaps, zstd-recompressed | `data/hgt-zst/N49E015.hgt.zst`, … |
| `download_osm_summits.py` | quick bbox → summit TSV for the renderer (small areas) | `data/summits.tsv` |
| `download_osm_peaks.py` | archival crawl of **all Europe** OSM peaks, raw JSON per 1×1° cell + offline merge step | `data/osm-peaks/*.json.zst`, `data/peaks-europe.tsv` |

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

## Data sources

- Heightmaps: SRTM3 via <https://viewfinderpanoramas.org> (Jonathan de
  Ferranti) — a personal site; keep the scripts' default pauses.
- Peaks: OpenStreetMap via Overpass API (fair use: sequential requests
  with pauses). For bulk work prefer Geofabrik PBF extracts + osmium.
- `data/summits.tsv` in git: CZ prominence ≥ 100 m (ultratisicovky.cz) +
  SK prominence ≥ 200 m (peaklist.org) lists inherited from panorama-jl.
