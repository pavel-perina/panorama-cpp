#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["freetype-py", "scipy", "numpy", "pillow"]
# ///
"""Bake a signed-distance-field font atlas for the renderer's labels.

    uv run scripts/bake_font_sdf.py                  # downloads Inter if needed
    uv run scripts/bake_font_sdf.py --font my.ttf --em 32 --spread 6

Glyph set = complete alphabet blocks (ASCII, Latin-1 letters, Latin
Extended-A, Greek, Cyrillic incl. Ukrainian) so new names never need a
rebake, plus every codepoint appearing in the peak databases as a safety
net (data/peaks-rated.tsv, data/summits.tsv).

Each glyph is rendered mono at 4x the target em size, converted to a signed
Euclidean distance field (scipy EDT, positive inside), downsampled and
quantized to uint8 (128 = edge, ±spread px range). SDF sampling stays crisp
under rotation and scaling — the point of the exercise (45° labels).

Output: data/fonts/font-sdf.bin (format below, one fread in C++) and
font-sdf-preview.png for eyeballing. No kerning (DejaVu barely uses it for
our scripts); layout is plain advances.

Binary format (little-endian):
    char[4] "PSDF", u32 version=1
    u32 atlasW, atlasH, u32 glyphCount
    f32 emPx, f32 spreadPx, f32 ascenderPx, f32 descenderPx, f32 lineHeightPx
    glyphCount * { u32 codepoint; u16 x, y, w, h;
                   f32 bearingX, bearingY, advance }   (px at emPx scale)
    u8[atlasW * atlasH]  (SDF, row-major)
"""

import argparse
import io
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

import freetype
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FONT_DIR = DATA_DIR / "fonts"
INTER_URL = "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
CHARSET_SOURCES = [DATA_DIR / "peaks-rated.tsv", DATA_DIR / "summits.tsv"]
SCALE = 4  # render at SCALE * em, downsample

ALPHABET_RANGES = [       # complete blocks: new names never need a rebake
    (0x0020, 0x007F),     # printable ASCII
    (0x00C0, 0x0100),     # Latin-1 letters (à ä é ô ü ß ...)
    (0x0100, 0x0180),     # Latin Extended-A (all CZ/SK/PL/HU/HR/RO letters)
    (0x0386, 0x03CF),     # Greek
    (0x0400, 0x0460),     # Cyrillic incl. Ukrainian і ї є
    (0x0490, 0x0492),     # Ґ ґ
]


def fetch_inter() -> Path:
    font_path = FONT_DIR / "Inter-Regular.ttf"
    if font_path.exists():
        return font_path
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Inter 4.1 -> {font_path}")
    with urllib.request.urlopen(INTER_URL, timeout=60) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    font_path.write_bytes(archive.read("extras/ttf/Inter-Regular.ttf"))
    (FONT_DIR / "Inter-LICENSE.txt").write_bytes(archive.read("LICENSE.txt"))
    return font_path


def charset(extra: str = "") -> list[int]:
    chars = {"°", "×"} | set(extra)
    for begin, end in ALPHABET_RANGES:
        chars |= {chr(c) for c in range(begin, end)}
    for path in CHARSET_SOURCES:
        if path.exists():
            chars |= set(path.read_text(encoding="utf-8"))
    chars -= set("\t\n\r\"")
    return sorted(ord(c) for c in chars)


def glyph_sdf(face: freetype.Face, codepoint: int, spread_hi: int
              ) -> tuple[np.ndarray, float, float, float] | None:
    """SDF (hi-res px, padded by spread) + bearingX/Y/advance in hi-res px."""
    if face.get_char_index(codepoint) == 0:
        return None
    face.load_char(chr(codepoint),
                   freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_MONO)
    g = face.glyph
    bmp = g.bitmap
    inside = np.zeros((bmp.rows, bmp.width), dtype=bool)
    if bmp.rows and bmp.width:  # unpack 1-bit rows (pitch bytes, MSB first)
        raw = np.frombuffer(bytes(bmp.buffer), dtype=np.uint8)
        rows = raw.reshape(bmp.rows, abs(bmp.pitch))
        inside = np.unpackbits(rows, axis=1)[:, :bmp.width].astype(bool)
    padded = np.pad(inside, spread_hi)
    # EDT gives each nonzero pixel its distance to the nearest zero pixel.
    sdf = distance_transform_edt(padded) - distance_transform_edt(~padded)
    return sdf, float(g.bitmap_left), float(g.bitmap_top), g.advance.x / 64.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, default=None,
                        help="TTF/OTF path (default: fetch Inter)")
    parser.add_argument("--em", type=int, default=32,
                        help="target em size in atlas px (default 32)")
    parser.add_argument("--spread", type=float, default=6.0,
                        help="SDF range in target px (default 6)")
    parser.add_argument("--out", type=Path, default=FONT_DIR / "font-sdf.bin")
    parser.add_argument("--extra-text", default="",
                        help="additional characters to include in the atlas")
    args = parser.parse_args()

    font_path = args.font or fetch_inter()
    face = freetype.Face(str(font_path))
    face.set_pixel_sizes(0, args.em * SCALE)
    spread_hi = int(round(args.spread * SCALE))

    codepoints = charset(args.extra_text)
    glyphs = []  # (codepoint, sdf_small, bearingX, bearingY, advance) target px
    missing = []
    for cp in codepoints:
        result = glyph_sdf(face, cp, spread_hi)
        if result is None:
            missing.append(chr(cp))
            continue
        sdf, bearing_x, bearing_y, advance = result
        # downsample by SCALE (box mean), convert distances to target px
        h, w = (sdf.shape[0] // SCALE) * SCALE, (sdf.shape[1] // SCALE) * SCALE
        small = sdf[:h, :w].reshape(h // SCALE, SCALE, w // SCALE, SCALE) \
                           .mean(axis=(1, 3)) / SCALE
        quantized = np.clip(128 + small * (127.0 / args.spread), 0, 255) \
                      .astype(np.uint8)
        glyphs.append((cp, quantized,
                       bearing_x / SCALE - args.spread,   # padding shifts origin
                       bearing_y / SCALE + args.spread,
                       advance / SCALE))
    if missing:
        print(f"{len(missing)} codepoints missing in font: {''.join(missing)}")

    # shelf packing, tallest first
    atlas_w = 512
    order = sorted(range(len(glyphs)), key=lambda i: -glyphs[i][1].shape[0])
    positions: dict[int, tuple[int, int]] = {}
    x = y = shelf_h = 0
    for i in order:
        gh, gw = glyphs[i][1].shape
        if x + gw > atlas_w:
            x, y = 0, y + shelf_h
            shelf_h = 0
        positions[i] = (x, y)
        x += gw
        shelf_h = max(shelf_h, gh)
    atlas_h = y + shelf_h
    atlas = np.zeros((atlas_h, atlas_w), dtype=np.uint8)
    for i, (px, py) in positions.items():
        gh, gw = glyphs[i][1].shape
        atlas[py:py + gh, px:px + gw] = glyphs[i][1]

    scale = 1.0 / SCALE
    header = struct.pack("<4sIIII fffff", b"PSDF", 1, atlas_w, atlas_h,
                         len(glyphs), float(args.em), args.spread,
                         face.size.ascender / 64.0 * scale,
                         face.size.descender / 64.0 * scale,
                         face.size.height / 64.0 * scale)
    records = b"".join(
        struct.pack("<IHHHH fff", glyphs[i][0], *positions[i],
                    glyphs[i][1].shape[1], glyphs[i][1].shape[0],
                    glyphs[i][2], glyphs[i][3], glyphs[i][4])
        for i in range(len(glyphs)))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(header + records + atlas.tobytes())

    preview = args.out.with_name(args.out.stem + "-preview.png")
    Image.fromarray(atlas).save(preview)
    print(f"{len(glyphs)} glyphs, atlas {atlas_w}x{atlas_h}, "
          f"{args.out} ({args.out.stat().st_size / 1024:.0f} KB), preview {preview}")


if __name__ == "__main__":
    sys.exit(main())
