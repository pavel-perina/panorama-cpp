#!/usr/bin/env python3
"""Download SRTM3 .hgt tiles from viewfinderpanoramas.org into data/.

Run once. Downloads the 4°x6° graticule zips covering the requested
integer-degree lat/lon range and extracts only the needed .hgt tiles
(N49E015 / S34W071 naming; negative arguments = S/W hemispheres).

Usage: download_hgt.py [min_lat min_lon max_lat max_lon]  (default: 47 15 50 21)
"""

import io
import sys
import urllib.request
import zipfile
from pathlib import Path

BASE_URL = "https://viewfinderpanoramas.org/dem3"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def graticule_name(lat: int, lon: int) -> str:
    """Zip name for a 1x1° tile: letter = 4° lat band, number = UTM zone.

    North: A=0..4°N, B=4..8°N, ... (L31 covers 44-48°N, 0-6°E).
    South: prefixed S, bands count southward: SA=1..4°S, SB=5..8°S, ...
    (SI19 covers 32-36°S in zone 19). lon // 6 floors, so W works as is.
    """
    number = 31 + lon // 6
    if lat < 0:
        letter = chr(ord("A") + (-lat - 1) // 4)
        return f"S{letter}{number}"
    letter = chr(ord("A") + lat // 4)
    return f"{letter}{number}"


def tile_name(lat: int, lon: int) -> str:
    """SRTM name from the floored SW corner: (-34, -71) -> S34W071.hgt."""
    ns, ew = "S" if lat < 0 else "N", "W" if lon < 0 else "E"
    return f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}.hgt"


def main() -> None:
    min_lat, min_lon, max_lat, max_lon = (
        map(int, sys.argv[1:5]) if len(sys.argv) >= 5 else (47, 15, 50, 21)
    )
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    tiles = [
        (lat, lon)
        for lat in range(min_lat, max_lat + 1)
        for lon in range(min_lon, max_lon + 1)
    ]
    missing = [t for t in tiles if not (DATA_DIR / tile_name(*t)).exists()]
    print(f"{len(tiles)} tiles requested, {len(missing)} missing")
    if not missing:
        return

    zips = sorted({graticule_name(*t) for t in missing})
    wanted = {tile_name(*t) for t in missing}
    for name in zips:
        url = f"{BASE_URL}/{name}.zip"
        print(f"Downloading {url} ...")
        with urllib.request.urlopen(url) as response:
            payload = response.read()
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            for member in zf.namelist():
                base = Path(member).name
                if base in wanted:
                    (DATA_DIR / base).write_bytes(zf.read(member))
                    print(f"  extracted {base}")

    still_missing = [tile_name(*t) for t in tiles if not (DATA_DIR / tile_name(*t)).exists()]
    if still_missing:
        print(f"WARNING: not found in any archive: {', '.join(still_missing)}")
    else:
        print("All tiles present.")


if __name__ == "__main__":
    main()
