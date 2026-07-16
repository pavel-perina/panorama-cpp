#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Generate the PWA icons (web/icon-192.png, web/icon-512.png).

Three ridge layers fading into airlight — the same terrain/sky palette the
tonemap uses, so the icon looks like the app. Deterministic (fixed seed).
Content stays inside the central 80% so the icon survives maskable
cropping on Android.
"""

import random
from pathlib import Path

from PIL import Image, ImageDraw

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
TERRAIN = (50, 65, 0)
SKY = (149, 195, 233)


def mix(t: float) -> tuple[int, int, int]:
    return tuple(round(a + (b - a) * t) for a, b in zip(TERRAIN, SKY))


def ridge(rng: random.Random, size: int, base: float, amp: float) -> list[tuple[float, float]]:
    pts = [(0, size)]
    y = base * size
    step = size / 24
    for i in range(25):
        y += rng.uniform(-amp, amp) * size
        y = min(max(y, base * size - 2 * amp * size), base * size + 2 * amp * size)
        pts.append((i * step, y))
    pts.append((size, size))
    return pts


def make(size: int) -> Image.Image:
    rng = random.Random(49)  # Kamenice's latitude, why not
    img = Image.new("RGB", (size, size), SKY)
    d = ImageDraw.Draw(img)
    # far -> near: lighter (more airlight) -> darker terrain
    for base, amp, t in ((0.52, 0.020, 0.75), (0.60, 0.030, 0.45), (0.72, 0.045, 0.0)):
        d.polygon(ridge(rng, size, base, amp), fill=mix(t))
    return img


for size in (192, 512):
    out = WEB_DIR / f"icon-{size}.png"
    make(size).save(out)
    print(f"{out} ({size}x{size})")
