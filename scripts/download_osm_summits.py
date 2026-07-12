#!/usr/bin/env python3
"""Download named peaks with elevation from OpenStreetMap via Overpass API.

Run once (please be considerate to the public Overpass server). Writes
data/summits.tsv with the same columns the Julia version used:
"Summit" <tab> Elevation <tab> Latitude <tab> Longitude

Usage: download_osm_summits.py [min_lat min_lon max_lat max_lon]  (default: 47 15 51 22)
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main() -> None:
    min_lat, min_lon, max_lat, max_lon = (
        map(float, sys.argv[1:5]) if len(sys.argv) >= 5 else (47.0, 15.0, 51.0, 22.0)
    )
    query = f"""
[out:json][timeout:120];
node["natural"="peak"]["name"]["ele"]({min_lat},{min_lon},{max_lat},{max_lon});
out body;
"""
    print(f"Querying Overpass for peaks in bbox {min_lat},{min_lon},{max_lat},{max_lon} ...")
    request = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "panorama-cpp summit fetch (one-off)"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        data = json.load(response)

    rows = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        try:
            # some entries have "1602 m" or comma decimals; be lenient
            ele = float(tags["ele"].replace(",", ".").split()[0])
        except (KeyError, ValueError, IndexError):
            continue
        rows.append((tags["name"], ele, element["lat"], element["lon"]))

    rows.sort(key=lambda r: -r[1])  # highest first, nicer for eyeballing
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / "summits.tsv"
    with out_path.open("w", encoding="utf-8") as f:
        f.write('"Summit"\t"Elevation"\t"Latitude"\t"Longitude"\n')
        for name, ele, lat, lon in rows:
            f.write(f'"{name}"\t{ele}\t{lat}\t{lon}\n')
    print(f"Wrote {len(rows)} summits to {out_path}")


if __name__ == "__main__":
    main()
