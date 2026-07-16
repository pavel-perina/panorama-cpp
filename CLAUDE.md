# CLAUDE.md

C++23 terrain panorama renderer (port of pavel-perina/panorama-jl): raycast
distance map from SRTM heightmaps + summit annotations. Two targets from one
core: native CLI (own zlib PNG writer + SDF text, no OpenCV) and
Emscripten/WASM web app (browser does all I/O and drawing). See README.md for data scripts,
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
- Tile sources in priority order: `<dir>/hgt3-zst/N49E015.hgt.zst`,
  `<dir>/hgt-zst/…` (legacy name), `<dir>/N49E015.hgt.zst`,
  `<dir>/N49E015.hgt` (web app: same order). `hgt1-zst/` is reserved for
  1-arcsec tiles (print mode). All hemispheres work (S/W tiles like
  `S34W071.hgt`, named by the floored SW corner); antimeridian scenes and
  sub-sea-level terrain (clamped to 0) don't.

## Conventions

- C++23: `std::println`/`std::format`, not printf/iostream.
- Python tooling via **uv** (PEP 723 inline deps, `uv run scripts/foo.py`);
  data downloads live in committed scripts, never ad-hoc shell.
- `src/3rd_party/zstd/` and `src/common/colors.{h,cpp}` are vendored
  verbatim (colors.cpp comes from Pavel's slime_mold repo — don't edit here,
  fix upstream and re-copy).
- WASM API surface is `src/wasm_api.cpp` only; JS owns fetching, storage,
  canvas, text (web labels via Canvas2D; desktop labels via the SDF font
  atlas `data/fonts/font-sdf.bin` + `src/sdftext.cpp` — rebake with
  `scripts/bake_font_sdf.py`).
- Pavel verifies rendered output visually before committing renderer/web
  changes — implement, ask him to refresh/run, commit on his word.
- Commit messages: plain descriptive style, no conventional-commit prefixes
  beyond the loose `area:` habit visible in `git log`.

## Data (gitignored, large)

`data/hgt3-zst/` — zstd 3-arcsec Europe mirror (primary tile source;
`data/hgt1-zst/` = 1-arcsec, not consumed yet);
`data/osm-peaks/` — raw Overpass JSON per 1×1° cell; `data/summits.tsv` —
curated CZ/SK list the renderer currently uses (committed);
`data/peaks-europe.tsv` — merged OSM peaks, unconsumed until the rating
pipeline (docs/ideas.md “Peak rating”) exists.
