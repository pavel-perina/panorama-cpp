#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["zstandard"]
# ///
"""Archive OSM peaks for Europe, one 1x1 degree cell per file, via Overpass.

Cells are fetched in a spiral starting from the Czech Republic, so the most
interesting data arrives first and the script can be interrupted/resumed at
any time (existing files are skipped). Raw Overpass JSON is stored
zstd-compressed under data/osm-peaks/ — cleaning is a separate, repeatable
step that never touches the network:

    uv run scripts/download_osm_peaks.py                # fetch (resumable)
    uv run scripts/download_osm_peaks.py --max-cells 20 # short session
    uv run scripts/download_osm_peaks.py --clean        # merge to peaks TSV

Overpass has no hard published quota; fair use means one request at a time
and pauses between them (default 10 s → whole Europe ≈ 4-5 h in one run,
but it does not have to be one run). On 429/504 the script backs off and
retries. For a bulk redo consider Geofabrik PBF extracts + osmium instead.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import zstandard

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "panorama-cpp peak archive (one-off, contact: pavel.perina@gmail.com)"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "osm-peaks"
TSV_PATH = Path(__file__).resolve().parent.parent / "data" / "peaks-europe.tsv"

# Europe: lat 35..72°N, lon 10°W..30°E; a cell is named by its SW corner.
LAT_RANGE = range(35, 72)
LON_RANGE = range(-10, 30)
SPIRAL_CENTER = (49, 15)  # Czech Republic


def cell_name(lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{ns}{abs(lat):02d}{ew}{abs(lon):03d}"


def spiral_cells() -> list[tuple[int, int]]:
    """All Europe cells ordered by a square spiral around SPIRAL_CENTER."""
    lat0, lon0 = SPIRAL_CENTER
    max_ring = max(
        lat0 - LAT_RANGE.start, LAT_RANGE.stop - 1 - lat0,
        lon0 - LON_RANGE.start, LON_RANGE.stop - 1 - lon0,
    )
    cells = [(lat0, lon0)]
    for ring in range(1, max_ring + 1):
        ring_cells = []
        # top and bottom rows of the ring
        for lon in range(lon0 - ring, lon0 + ring + 1):
            ring_cells.append((lat0 + ring, lon))
            ring_cells.append((lat0 - ring, lon))
        # left and right columns (corners already covered)
        for lat in range(lat0 - ring + 1, lat0 + ring):
            ring_cells.append((lat, lon0 - ring))
            ring_cells.append((lat, lon0 + ring))
        cells.extend(rc for rc in ring_cells
                     if rc[0] in LAT_RANGE and rc[1] in LON_RANGE)
    return cells


def fetch_cell(lat: int, lon: int, timeout: int = 240) -> bytes:
    """One Overpass request; returns raw JSON bytes. Retries with backoff."""
    query = f"""[out:json][timeout:180];
node["natural"="peak"]({lat},{lon},{lat + 1},{lon + 1});
out body;"""
    request = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": USER_AGENT},
    )
    delay = 30.0
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if code not in (429, 502, 504, None) or attempt == 5:
                raise
            print(f"    {e} -> retrying in {delay:.0f} s", flush=True)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def download(sleep_s: float, max_cells: int | None) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    compressor = zstandard.ZstdCompressor(level=19)
    cells = spiral_cells()
    todo = [c for c in cells if not (OUT_DIR / f"{cell_name(*c)}.json.zst").exists()]
    print(f"{len(cells)} cells total, {len(todo)} to fetch")
    fetched = 0
    for lat, lon in todo:
        if max_cells is not None and fetched >= max_cells:
            print(f"Stopping after {fetched} cells (--max-cells); rerun to continue.")
            return
        name = cell_name(lat, lon)
        raw = fetch_cell(lat, lon)
        n_peaks = len(json.loads(raw).get("elements", []))
        path = OUT_DIR / f"{name}.json.zst"
        path.write_bytes(compressor.compress(raw))
        fetched += 1
        print(f"  {name}: {n_peaks:5d} peaks, {path.stat().st_size / 1024:7.1f} KB "
              f"({fetched}/{len(todo)})", flush=True)
        time.sleep(sleep_s)
    print("All cells fetched.")


def clean() -> None:
    """Merge raw cells into one TSV of named peaks (offline, repeatable)."""
    decompressor = zstandard.ZstdDecompressor()
    peaks: dict[int, tuple[str, float, float, float]] = {}  # node id -> row
    named_without_ele = 0
    files = sorted(OUT_DIR.glob("*.json.zst"))
    for path in files:
        data = json.loads(decompressor.decompress(path.read_bytes(),
                                                  max_output_size=1 << 30))
        for element in data.get("elements", []):
            tags = element.get("tags", {})
            name = tags.get("name")
            if not name:
                continue
            try:
                # tolerate "1602 m", comma decimals, feet left to their fate
                ele = float(tags["ele"].replace(",", ".").split()[0])
            except (KeyError, ValueError, IndexError):
                named_without_ele += 1
                continue
            peaks[element["id"]] = (name, ele, element["lat"], element["lon"])
    with TSV_PATH.open("w", encoding="utf-8") as f:
        f.write('"Summit"\t"Elevation"\t"Latitude"\t"Longitude"\n')
        for name, ele, lat, lon in sorted(peaks.values(), key=lambda r: -r[1]):
            f.write(f'"{name}"\t{ele}\t{lat}\t{lon}\n')
    print(f"{len(files)} cells -> {len(peaks)} named peaks with elevation "
          f"({named_without_ele} named peaks lacked usable ele) -> {TSV_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean", action="store_true",
                        help="merge downloaded cells into peaks TSV (no network)")
    parser.add_argument("--sleep", type=float, default=10.0,
                        help="seconds between Overpass requests (default 10)")
    parser.add_argument("--max-cells", type=int, default=None,
                        help="fetch at most N cells this run")
    args = parser.parse_args()
    if args.clean:
        clean()
    else:
        download(args.sleep, args.max_cells)


if __name__ == "__main__":
    sys.exit(main())
