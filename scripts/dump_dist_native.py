#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Dump the native renderer's dist_map.png as raw uint16 LE dist_native.bin.

web/test-node.mjs compares the WASM render against this reference. Rerun
after any renderer change:

    ./build/panorama
    uv run scripts/dump_dist_native.py
    node web/test-node.mjs

Paths are CWD-relative (panorama writes its outputs to the CWD too);
override with arguments: dump_dist_native.py [dist_map.png] [dist_native.bin]
"""

import sys
from pathlib import Path

from PIL import Image

src = Path(sys.argv[1] if len(sys.argv) > 1 else "dist_map.png")
dst = Path(sys.argv[2] if len(sys.argv) > 2 else "dist_native.bin")

img = Image.open(src)
if img.mode != "I;16":  # older Pillow opens 16-bit gray PNG as 32-bit "I"
    img = img.convert("I;16")
dst.write_bytes(img.tobytes())
print(f"{dst}: {img.width}x{img.height} uint16 ({dst.stat().st_size} bytes)")
