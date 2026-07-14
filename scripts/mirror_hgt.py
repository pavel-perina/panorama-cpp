#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["zstandard"]
# ///
"""Mirror viewfinderpanoramas.org SRTM3 heightmaps for Europe as .hgt.zst.

Downloads the 4x6 degree graticule zips (nearest to the Czech Republic
first), recompresses every contained tile to data/hgt3-zst/<TILE>.hgt.zst
(zstd shrinks a 2.8 MB tile to roughly half) and drops the zip. Resumable:
graticules whose tiles are already mirrored are skipped, so it can run in
short sessions:

    uv run scripts/mirror_hgt.py                 # everything (~70 zips, 2-3 GB)
    uv run scripts/mirror_hgt.py --max-zips 5    # short session

viewfinderpanoramas.org is a personal site — keep the default pause between
downloads. Some regions (islands, far north) live in specially named
archives rather than the graticule scheme; those come back as 404 and are
reported at the end for manual handling.
"""

import argparse
import io
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import zstandard

BASE_URL = "https://viewfinderpanoramas.org/dem3"
USER_AGENT = "panorama-cpp hgt mirror (one-off, contact: pavel.perina@gmail.com)"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "hgt3-zst"

# Europe: lat 35..72°N, lon 10°W..30°E
LAT_RANGE = range(35, 72)
LON_RANGE = range(-10, 30)
CENTER = (49.5, 15.5)  # Czech Republic


def graticule_of(lat: int, lon: int) -> str:
    """4° lat band letter + UTM-style 6° lon zone, e.g. (49,15) -> 'M33'."""
    return f"{chr(ord('A') + lat // 4)}{31 + lon // 6}"


def graticules() -> list[tuple[str, list[tuple[int, int]]]]:
    """Europe graticules with their in-range tiles, nearest to CENTER first."""
    groups: dict[str, list[tuple[int, int]]] = {}
    for lat in LAT_RANGE:
        for lon in LON_RANGE:
            groups.setdefault(graticule_of(lat, lon), []).append((lat, lon))

    def distance2(item: tuple[str, list[tuple[int, int]]]) -> float:
        tiles = item[1]
        clat = sum(t[0] for t in tiles) / len(tiles) + 0.5
        clon = sum(t[1] for t in tiles) / len(tiles) + 0.5
        return (clat - CENTER[0]) ** 2 + (clon - CENTER[1]) ** 2

    return sorted(groups.items(), key=distance2)


def tile_name(lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}"


def mirror(sleep_s: float, max_zips: int | None) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    compressor = zstandard.ZstdCompressor(level=19)
    missing_archives: list[str] = []
    downloaded = 0

    for name, tiles in graticules():
        wanted = [t for t in tiles
                  if not (OUT_DIR / f"{tile_name(*t)}.hgt.zst").exists()]
        if not wanted:
            continue
        if max_zips is not None and downloaded >= max_zips:
            print(f"Stopping after {downloaded} archives (--max-zips); rerun to continue.")
            return
        url = f"{BASE_URL}/{name}.zip"
        print(f"Downloading {url} ({len(wanted)} tiles wanted) ...", flush=True)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                payload = response.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                missing_archives.append(name)
                print(f"  {name}.zip: 404 (ocean or specially-named region)")
                continue
            raise
        downloaded += 1
        stored = 0
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            for member in zf.namelist():
                base = Path(member).name
                if not base.lower().endswith(".hgt"):
                    continue
                raw = zf.read(member)
                out = OUT_DIR / f"{Path(base).stem.upper()}.hgt.zst"
                out.write_bytes(compressor.compress(raw))
                stored += 1
        print(f"  {name}.zip: {len(payload) / 1e6:.1f} MB -> {stored} tiles mirrored")
        time.sleep(sleep_s)

    print("Mirror complete." if not missing_archives else
          f"Done; archives not found (check site manually): {', '.join(missing_archives)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sleep", type=float, default=5.0,
                        help="seconds between zip downloads (default 5)")
    parser.add_argument("--max-zips", type=int, default=None,
                        help="download at most N archives this run")
    args = parser.parse_args()
    mirror(args.sleep, args.max_zips)


if __name__ == "__main__":
    sys.exit(main())
