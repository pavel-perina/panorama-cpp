#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Render panorama frames through the time-of-day palette (sunset test).

Reads web/sky-palette.json (make_sky_palette.py), interpolates the three
palette colors in OKLab for each frame's sun elevation, and runs the
native CLI with -fg/-bg/-hz. Scene is whatever src/main.cpp hardcodes.

    uv run scripts/render_sunset_anim.py [start_ele end_ele [frames]]
    uv run scripts/render_sunset_anim.py   # one frame per table row, +60..-12

Outputs to out/sunset/: frame_NN_ele*.png (full size) and
contact-sheet.png (cropped strips, one per frame, labeled).
"""

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
BINARY = REPO / "build" / "panorama"
PALETTE = REPO / "web" / "sky-palette.json"
OUT = REPO / "out" / "sunset"

# Contact-sheet crop: the Praděd/Sněžník ridge section, azimuth 33..55 deg
# of the default 0..60 scene at 174.53 px/deg.
CROP_AZ = (33.0, 55.0)
PX_PER_DEG = 174.53292519943295
SHEET_SCALE = 3  # downscale factor for the sheet strips


# --- OKLab (matches src/common/colors.cpp) -----------------------------------

def srgb_to_oklab(rgb):
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
           for c in rgb]
    l = 0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]
    m = 0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]
    s = 0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]
    l, m, s = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def oklab_to_srgb(lab):
    L, a, b = lab
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    return [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
            for c in (max(0.0, min(1.0, c)) for c in lin)]


def hex_to_rgb01(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def rgb01_to_hex(rgb):
    return "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in rgb)


def palette_at(rows, sun_ele):
    """OKLab-interpolated (terrain, horizon, sky) hex triple at sun_ele."""
    rows = sorted(rows, key=lambda r: r["sunEle"])
    if sun_ele <= rows[0]["sunEle"]:
        lo = hi = rows[0]
    elif sun_ele >= rows[-1]["sunEle"]:
        lo = hi = rows[-1]
    else:
        lo = max((r for r in rows if r["sunEle"] <= sun_ele),
                 key=lambda r: r["sunEle"])
        hi = min((r for r in rows if r["sunEle"] >= sun_ele),
                 key=lambda r: r["sunEle"])
    t = 0.0 if lo is hi else \
        (sun_ele - lo["sunEle"]) / (hi["sunEle"] - lo["sunEle"])
    out = []
    for key in ("terrain", "horizon", "sky"):
        a = srgb_to_oklab(hex_to_rgb01(lo[key]))
        b = srgb_to_oklab(hex_to_rgb01(hi[key]))
        lab = tuple(x + (y - x) * t for x, y in zip(a, b))
        out.append(rgb01_to_hex(oklab_to_srgb(lab)))
    return out


def main():
    if not BINARY.exists():
        sys.exit(f"{BINARY} not found — build the native target first")

    rows = json.loads(PALETTE.read_text())["rows"]
    if len(sys.argv) >= 3:
        start, end = float(sys.argv[1]), float(sys.argv[2])
        frames = int(sys.argv[3]) if len(sys.argv) >= 4 else 15
        eles = [start + (end - start) * i / (frames - 1) for i in range(frames)]
    else:
        # Default: sweep the table itself, one frame per row, day -> night.
        eles = sorted((r["sunEle"] for r in rows), reverse=True)

    work = OUT / "work"
    work.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("frame_*.png"):
        old.unlink()

    strips = []
    for i, ele in enumerate(eles):
        terrain, horizon, sky = palette_at(rows, ele)
        print(f"frame {i:02d}: sun {ele:+6.2f}°  "
              f"-fg {terrain} -bg {sky} -hz {horizon}")
        subprocess.run(
            [BINARY, "-fg", terrain, "-bg", sky, "-hz", horizon, REPO / "data"],
            cwd=work, check=True, stdout=subprocess.DEVNULL)
        dst = OUT / f"frame_{i:02d}_ele{ele:+05.1f}.png"
        shutil.copy(work / "panorama_photo.png", dst)
        strips.append((ele, dst))

    # Contact sheet: cropped, downscaled strip per frame, labeled.
    x0, x1 = (round(a * PX_PER_DEG) for a in CROP_AZ)
    sheet_rows = []
    for ele, path in strips:
        img = Image.open(path).crop((x0, 0, x1, Image.open(path).height))
        img = img.resize((img.width // SHEET_SCALE, img.height // SHEET_SCALE),
                         Image.LANCZOS)
        d = ImageDraw.Draw(img)
        label = f"sun {ele:+.1f}°"
        d.text((9, 7), label, fill=(0, 0, 0))
        d.text((8, 6), label, fill=(255, 255, 255))
        sheet_rows.append(img)
    sheet = Image.new("RGB", (sheet_rows[0].width,
                              sum(r.height for r in sheet_rows)))
    y = 0
    for r in sheet_rows:
        sheet.paste(r, (0, y))
        y += r.height
    sheet_path = OUT / "contact-sheet.png"
    sheet.save(sheet_path)
    print(f"\n{len(eles)} frames in {OUT}/, sheet: {sheet_path}")


if __name__ == "__main__":
    main()
