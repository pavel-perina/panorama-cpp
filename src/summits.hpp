#pragma once
// Summit database, visibility test and annotated rendering.

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

#include "distmap.hpp"

namespace pano {

struct Summit {
    std::string name;
    PositionLLE lle;
    // From peaks-rated.tsv (scripts/build_peaks_db.py); curated summit lists
    // without the column default to "always prominent enough".
    double prominence = 1.0e9;
};

// Placement of a visible summit in the output image.
struct VisibleSummit {
    std::string name;
    double distanceM = 0.0;
    int x = 0;
    int y = 0;
    double prominence = 0.0;
};

// Parses TSV content with header: "Summit" Elevation Latitude Longitude
// (the format produced by scripts/download_osm_summits.py and used by
// panorama-jl). Extra columns are tolerated; column 6 ("Prominence" in
// peaks-rated.tsv) is picked up when present.
std::vector<Summit> parseSummitsTsv(std::string_view tsv);

// Convenience file wrapper around parseSummitsTsv.
std::vector<Summit> loadSummitsTsv(const std::filesystem::path &path);

// Filters summits by distance/azimuth window and checks them against the
// distance map (a summit counts as visible when a distance-map sample within
// `radius` px matches its distance within `tolerance` steps). The heightmap
// supplies the elevation for placement — the map was raycast from it, and at
// close range a few meters of OSM-vs-SRTM disagreement move the apparent
// position by more pixels than the test tolerates.
std::vector<VisibleSummit> findVisibleSummits(const View &view,
                                              const HeightMap &heightMap,
                                              const std::vector<uint16_t> &distMap,
                                              const std::vector<Summit> &summits);

class SdfFont;

// Draws summit labels, azimuth ticks and the horizon line into a row-major
// RGB buffer (view.outWidth x outHeight x 3) in place. Implemented in
// annotate.cpp (SDF text); not part of the WASM build, where JS draws on
// the canvas.
void drawAnnotations(const View &view, uint8_t *rgb,
                     const std::vector<VisibleSummit> &summits,
                     const SdfFont &font);

// Grayscale-outline convenience wrapper: expands `outlines` to RGB, draws
// the annotations and writes a PNG to `outputPath`.
void renderAnnotations(const View &view,
                       const std::vector<uint8_t> &outlines,
                       const std::vector<VisibleSummit> &summits,
                       const SdfFont &font,
                       const std::filesystem::path &outputPath);

} // namespace pano
