# CLAUDE.md

C++23 terrain panorama renderer (port of pavel-perina/panorama-jl): raycast
distance map from SRTM heightmaps + summit annotations. Two targets from one
core: native CLI (OpenCV for image output) and Emscripten/WASM web app
(browser does all I/O and drawing). See README.md for data scripts,
docs/mobile-app-plan.md and docs/ideas.md for direction.

## Build & verify

```sh
cmake -B build -S . && cmake --build build -j          # native
./build/panorama [dataDir=data]                        # scene hardcoded in src/main.cpp

source ~/emsdk/emsdk_env.sh
emcmake cmake -B build-wasm -S . && cmake --build build-wasm -j   # WASM
python3 -m http.server 8000    # from repo root, open /web/

node web/test-node.mjs         # regression: WASM vs native must be 0 px diff
```

The node test needs `dist_native.bin`: run `./build/panorama`, then
`python3 -c "import cv2; cv2.imread('dist_map.png',-1).tofile('dist_native.bin')"`.

## Invariants — do not break casually

- **Native and WASM renders are bit-identical.** That's why native builds
  with `-ffp-contract=off` (FMA flips cell truncations). After any renderer
  change: rebuild both, regenerate `dist_native.bin`, node test must pass.
- Ray loop uses grid-coordinate interpolation between exact checkpoints
  every 5 km (error s²/8R ≈ 0.5 m). `-DPANO_EXACT_RAYCAST=ON` builds the
  exact path for A/B comparison.
- Heightmap sampling **rounds** (deliberate break from Julia/Rust originals,
  which truncate — see commit f8b3bdf). Old reference images are offset by
  half a cell.
- Tile sources in priority order: `<dir>/hgt-zst/N49E015.hgt.zst`,
  `<dir>/N49E015.hgt.zst`, `<dir>/N49E015.hgt` (web app: hgt-zst first too).
  Only N/E quadrant is supported.

## Conventions

- C++23: `std::println`/`std::format`, not printf/iostream.
- Python tooling via **uv** (PEP 723 inline deps, `uv run scripts/foo.py`);
  data downloads live in committed scripts, never ad-hoc shell.
- `src/3rd_party/zstd/` and `src/common/colors.{h,cpp}` are vendored
  verbatim (colors.cpp comes from Pavel's slime_mold repo — don't edit here,
  fix upstream and re-copy).
- WASM API surface is `src/wasm_api.cpp` only; JS owns fetching, storage,
  canvas, text (UTF-8 labels work in Canvas2D; OpenCV Hershey is ASCII-only,
  desktop labels have broken diacritics — known, Cairo planned).
- Pavel verifies rendered output visually before committing renderer/web
  changes — implement, ask him to refresh/run, commit on his word.
- Commit messages: plain descriptive style, no conventional-commit prefixes
  beyond the loose `area:` habit visible in `git log`.

## Data (gitignored, large)

`data/hgt-zst/` — zstd Europe mirror (primary tile source);
`data/osm-peaks/` — raw Overpass JSON per 1×1° cell; `data/summits.tsv` —
curated CZ/SK list the renderer currently uses (committed);
`data/peaks-europe.tsv` — merged OSM peaks, unconsumed until the rating
pipeline (docs/ideas.md “Peak rating”) exists.
