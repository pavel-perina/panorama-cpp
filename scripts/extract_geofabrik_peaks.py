#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["osmium", "zstandard"]
# ///
"""Extract OSM peaks from Geofabrik country extracts (offline, no API limits).

Alternative to the Overpass crawl in download_osm_peaks.py for bulk redos:
download whole-country PBFs manually, then filter locally at ~100 MB/s.
Node ids are identical to Overpass results, so the two sources can be
unioned by id later.

    # 1. download extracts (manual, they are large - CZ ~900 MB):
    #    https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf
    #    -> data/geofabrik-peaks/
    uv run scripts/extract_geofabrik_peaks.py           # all PBFs in the dir
    uv run scripts/extract_geofabrik_peaks.py --tsv     # merge to peaks TSV

Extraction keeps every natural=peak node with all its tags (Overpass JSON
shape, zstd-compressed) so the future rating pipeline can use prominence/
wikidata/name:* tags; the TSV step reduces to named peaks with elevation.
"""

import argparse
import json
import sys
from pathlib import Path

import osmium
import zstandard

PBF_DIR = Path(__file__).resolve().parent.parent / "data" / "geofabrik-peaks"
TSV_PATH = Path(__file__).resolve().parent.parent / "data" / "peaks-geofabrik.tsv"


def extract(pbf_path: Path) -> Path:
    """Filter one country PBF to an Overpass-shaped peaks JSON (.json.zst)."""
    elements = []
    fp = osmium.FileProcessor(str(pbf_path), osmium.osm.NODE) \
        .with_filter(osmium.filter.TagFilter(("natural", "peak")))
    for node in fp:
        elements.append({
            "type": "node",
            "id": node.id,
            "lat": node.location.lat,
            "lon": node.location.lon,
            "tags": dict(node.tags),
        })
    out_path = pbf_path.with_name(
        pbf_path.name.replace("-latest.osm.pbf", "") + "-peaks.json.zst")
    raw = json.dumps({"elements": elements}, ensure_ascii=False).encode()
    out_path.write_bytes(zstandard.ZstdCompressor(level=19).compress(raw))
    print(f"  {pbf_path.name}: {len(elements)} peaks "
          f"-> {out_path.name} ({out_path.stat().st_size / 1024:.0f} KB)")
    return out_path


def merge_tsv() -> None:
    """Merge extracted peak files into one TSV (same format as peaks-europe.tsv)."""
    decompressor = zstandard.ZstdDecompressor()
    peaks: dict[int, tuple[str, float, float, float]] = {}  # node id -> row
    named_without_ele = 0
    files = sorted(PBF_DIR.glob("*-peaks.json.zst"))
    for path in files:
        data = json.loads(decompressor.decompress(path.read_bytes(),
                                                  max_output_size=1 << 30))
        for element in data["elements"]:
            tags = element["tags"]
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
    print(f"{len(files)} countries -> {len(peaks)} named peaks with elevation "
          f"({named_without_ele} named peaks lacked usable ele) -> {TSV_PATH}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tsv", action="store_true",
                        help="merge extracted peaks into TSV (no PBF reading)")
    parser.add_argument("pbf", nargs="*", type=Path,
                        help=f"PBF files to extract (default: all in {PBF_DIR})")
    args = parser.parse_args()
    if args.tsv:
        merge_tsv()
        return
    pbfs = args.pbf or sorted(PBF_DIR.glob("*.osm.pbf"))
    if not pbfs:
        sys.exit(f"No PBF files in {PBF_DIR} - download from "
                 "https://download.geofabrik.de/europe/ first.")
    for pbf_path in pbfs:
        extract(pbf_path)


if __name__ == "__main__":
    sys.exit(main())
