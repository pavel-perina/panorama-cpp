#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["zstandard"]
# ///
"""Stage 1 of peak rating (docs/ideas.md): rate OSM named peaks by matching
them against the SRTM prominence/isolation sweep of the `prominence` tool.

    cmake --build build -j --target prominence
    ./build/prominence 46 9 50 22 data 10 data/prominence.tsv
    uv run scripts/build_peaks_db.py

Reads data/geofabrik-peaks/*-peaks.json.zst (see extract_geofabrik_peaks.py;
pass paths to use other sources, e.g. data/osm-peaks cells - same JSON shape).
Only named peaks are considered. Each is matched to the nearest SRTM peak
within 300 m (OSM node positions are off by a cell or two) and split into

    data/peaks-rated.tsv     accepted, sorted by prominence descending
    data/peaks-rejected.tsv  with a rejection reason per peak

Elevation: OSM ele is kept when plausible; missing or implausible values are
replaced by the SRTM peak elevation (ele_src column says which). SRTM smooths
sharp summits down by tens of meters, so OSM may exceed SRTM by more than it
may fall below it.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import zstandard

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROMINENCE_TSV = DATA_DIR / "prominence.tsv"
ACCEPTED_TSV = DATA_DIR / "peaks-rated.tsv"
REJECTED_TSV = DATA_DIR / "peaks-rejected.tsv"

MATCH_RADIUS_M = 300.0      # unconditional match
MATCH_RADIUS_EXT_M = 600.0  # broad dome summits: the SRTM maximum can sit
MATCH_EXT_ELE_TOL = 40.0    # far from the cairn; require consistent elevation
MIN_PROM_M = 20          # acceptance floor; the sweep itself starts at 10
ELE_TOLERANCE = (-30.0, 150.0)  # plausible osm_ele - srtm_ele range
HASH_CELL_DEG = 0.003    # grid-hash cell, ~333 m; 3x3 lookup covers the radius


def dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Equirectangular approximation; plenty for sub-kilometer distances."""
    dy = (lat1 - lat2) * 111320.0
    dx = (lon1 - lon2) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


def parse_ele(tags: dict) -> float | None:
    try:
        # tolerate "1602 m", comma decimals, feet left to their fate
        return float(tags["ele"].replace(",", ".").split()[0])
    except (KeyError, ValueError, IndexError):
        return None


def load_prominence() -> tuple[list[tuple], dict, tuple]:
    """Rows (lat, lon, ele, prom, saddle, isolation), grid hash, lat/lon bounds."""
    rows = []
    grid: dict[tuple[int, int], list[int]] = {}
    with PROMINENCE_TSV.open() as f:
        next(f)  # header
        for line in f:
            lat, lon, ele, prom, saddle, isolation = line.split("\t")
            row = (float(lat), float(lon), int(ele), int(prom), int(saddle),
                   float(isolation))
            key = (int(row[0] / HASH_CELL_DEG), int(row[1] / HASH_CELL_DEG))
            grid.setdefault(key, []).append(len(rows))
            rows.append(row)
    bounds = (min(r[0] for r in rows), min(r[1] for r in rows),
              max(r[0] for r in rows), max(r[1] for r in rows))
    return rows, grid, bounds


def nearest_srtm_peak(rows, grid, lat: float, lon: float,
                      osm_ele: float | None) -> tuple[int, float] | None:
    """Index of the nearest sweep peak: unconditionally within MATCH_RADIUS_M,
    or within MATCH_RADIUS_EXT_M when the elevation agrees (broad domes)."""
    key_lat, key_lon = int(lat / HASH_CELL_DEG), int(lon / HASH_CELL_DEG)
    best, best_d = None, MATCH_RADIUS_EXT_M
    for dy in range(-2, 3):      # +-2 cells lat ~ 666 m
        for dx in range(-3, 4):  # +-3 cells lon ~ 660 m at 49 deg N
            for i in grid.get((key_lat + dy, key_lon + dx), ()):
                d = dist_m(lat, lon, rows[i][0], rows[i][1])
                if d >= best_d:
                    continue
                if d > MATCH_RADIUS_M and (osm_ele is None or
                                           abs(osm_ele - rows[i][2]) > MATCH_EXT_ELE_TOL):
                    continue
                best, best_d = i, d
    return (best, best_d) if best is not None else None


def load_osm_peaks(sources: list[Path]) -> dict[int, dict]:
    """Named peaks by node id (id-dedup across overlapping country extracts)."""
    decompressor = zstandard.ZstdDecompressor()
    peaks: dict[int, dict] = {}
    unnamed = 0
    for path in sources:
        data = json.loads(decompressor.decompress(path.read_bytes(),
                                                  max_output_size=1 << 30))
        for element in data["elements"]:
            if "name" not in element.get("tags", {}):
                unnamed += 1
                continue
            peaks[element["id"]] = element
    print(f"{len(sources)} source files -> {len(peaks)} named peaks "
          f"({unnamed} unnamed skipped)")
    return peaks


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="*", type=Path,
                        help="peak JSON files (default: data/geofabrik-peaks/*-peaks.json.zst)")
    args = parser.parse_args()
    sources = args.sources or sorted(DATA_DIR.glob("geofabrik-peaks/*-peaks.json.zst"))
    if not sources:
        sys.exit("No peak sources found - run extract_geofabrik_peaks.py first.")

    rows, grid, bounds = load_prominence()
    print(f"{len(rows)} SRTM peaks from {PROMINENCE_TSV}, "
          f"bounds {bounds[0]:.2f}..{bounds[2]:.2f}N {bounds[1]:.2f}..{bounds[3]:.2f}E")

    rejected: list[tuple[str, float, float, str]] = []  # name, lat, lon, reason
    by_srtm_peak: dict[int, tuple] = {}  # sweep row index -> best candidate

    for element in load_osm_peaks(sources).values():
        name = element["tags"]["name"]
        lat, lon = element["lat"], element["lon"]
        if not (bounds[0] <= lat <= bounds[2] and bounds[1] <= lon <= bounds[3]):
            rejected.append((name, lat, lon, "outside heightmap region"))
            continue
        osm_ele = parse_ele(element["tags"])
        match = nearest_srtm_peak(rows, grid, lat, lon, osm_ele)
        if match is None:
            rejected.append((name, lat, lon,
                             f"no SRTM peak with prom>=10m within {MATCH_RADIUS_M:.0f}m"))
            continue
        i, _ = match
        srtm_ele = rows[i][2]
        if osm_ele is None:
            ele, ele_src = float(srtm_ele), "srtm"
        elif ELE_TOLERANCE[0] <= osm_ele - srtm_ele <= ELE_TOLERANCE[1]:
            ele, ele_src = osm_ele, "osm"
        else:
            ele, ele_src = float(srtm_ele), "srtm-fixed"
        candidate = (name, ele, lat, lon, ele_src)
        if i in by_srtm_peak:
            # two OSM nodes share one SRTM peak: keep the higher one
            keep, drop = sorted((by_srtm_peak[i], candidate),
                                key=lambda c: -c[1])
            by_srtm_peak[i] = keep
            rejected.append((drop[0], drop[2], drop[3],
                             f"duplicate: shares SRTM peak with \"{keep[0]}\""))
        else:
            by_srtm_peak[i] = candidate

    accepted = []
    for i, (name, ele, lat, lon, ele_src) in by_srtm_peak.items():
        prom, saddle, isolation = rows[i][3], rows[i][4], rows[i][5]
        if prom < MIN_PROM_M:
            rejected.append((name, lat, lon, f"low prominence ({prom} m)"))
        else:
            accepted.append((name, ele, lat, lon, ele_src, prom, saddle, isolation))

    accepted.sort(key=lambda r: -r[5])

    # Same peak mapped as several OSM nodes that matched *different* sweep
    # bumps: same name (or shared bilingual component, "Orlica / Vrchmezí")
    # within 1.5 km. Processing in prominence order keeps the real summit.
    def name_parts(name: str) -> set[str]:
        return {p.strip().casefold() for p in name.split("/")}

    kept: list[tuple] = []
    kept_grid: dict[tuple[int, int], list[int]] = {}
    for row in accepted:
        name, lat, lon = row[0], row[2], row[3]
        parts = name_parts(name)
        key = (int(lat / 0.02), int(lon / 0.02))  # ~2.2 km cells
        dup_of = None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for k in kept_grid.get((key[0] + dy, key[1] + dx), ()):
                    if parts & name_parts(kept[k][0]) and \
                            dist_m(lat, lon, kept[k][2], kept[k][3]) < 1500.0:
                        dup_of = kept[k][0]
                        break
        if dup_of is not None:
            rejected.append((name, lat, lon, f"duplicate: same name as \"{dup_of}\" nearby"))
        else:
            kept_grid.setdefault(key, []).append(len(kept))
            kept.append(row)
    accepted = kept
    with ACCEPTED_TSV.open("w", encoding="utf-8") as f:
        f.write('"Summit"\t"Elevation"\t"Latitude"\t"Longitude"'
                '\t"EleSrc"\t"Prominence"\t"Saddle"\t"IsolationKm"\n')
        for name, ele, lat, lon, ele_src, prom, saddle, isolation in accepted:
            f.write(f'"{name}"\t{ele}\t{lat}\t{lon}'
                    f'\t{ele_src}\t{prom}\t{saddle}\t{isolation}\n')

    rejected.sort(key=lambda r: (r[3], r[0]))
    with REJECTED_TSV.open("w", encoding="utf-8") as f:
        f.write('"Summit"\t"Latitude"\t"Longitude"\t"Reason"\n')
        for name, lat, lon, reason in rejected:
            f.write(f'"{name}"\t{lat}\t{lon}\t"{reason}"\n')

    reasons: dict[str, int] = {}
    for _, _, _, reason in rejected:
        reasons[reason.split(" (")[0].split(":")[0]] = \
            reasons.get(reason.split(" (")[0].split(":")[0], 0) + 1
    print(f"accepted {len(accepted)} -> {ACCEPTED_TSV}")
    print(f"rejected {len(rejected)} -> {REJECTED_TSV}")
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"  {count:6d}  {reason}")


if __name__ == "__main__":
    sys.exit(main())
