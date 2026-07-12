#!/usr/bin/env python3
"""Download SRTM3 .hgt tiles from viewfinderpanoramas.org into data/.

Run once. Downloads the 4°x6° graticule zips covering the requested
integer-degree lat/lon range and extracts only the needed N??E???.hgt files.

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
    """Zip name for a 1x1° tile: letter = 4° lat band (A=0..4°), number = UTM zone."""
    letter = chr(ord("A") + lat // 4)
    number = 31 + lon // 6
    return f"{letter}{number}"


def tile_name(lat: int, lon: int) -> str:
    return f"N{lat:02d}E{lon:03d}.hgt"


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
