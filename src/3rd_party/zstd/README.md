# zstd single-file decoder (vendored)

- `zstddeclib.c` — decompression-only amalgamation of zstd **v1.5.7**,
  generated from the release tarball with
  `build/single_file_libs/create_single_file_decoder.sh` (2026-07-12).
- `zstd.h` — matching public header from `lib/zstd.h`.
- `LICENSE` — zstd is dual BSD/GPLv2 licensed; BSD applies here.

Used to read `.hgt.zst` heightmap tiles (see `data/hgt-zst/`,
`scripts/mirror_hgt.py`). Decode only — compression stays in the Python
scripts. To upgrade: download the new release tarball, rerun the script,
replace these two files.
