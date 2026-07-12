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
};

// Placement of a visible summit in the output image.
struct VisibleSummit {
    std::string name;
    double distanceM = 0.0;
    int x = 0;
    int y = 0;
};

// Reads a TSV with header: "Summit" Elevation Latitude Longitude
// (the format produced by scripts/download_osm_summits.py and used by panorama-jl).
std::vector<Summit> loadSummitsTsv(const std::filesystem::path &path);

// Filters summits by distance/azimuth window and checks them against the
// distance map (a summit counts as visible when a distance-map sample within
// `radius` px matches its distance within `tolerance` steps).
std::vector<VisibleSummit> findVisibleSummits(const View &view,
                                              const std::vector<uint16_t> &distMap,
                                              const std::vector<Summit> &summits);

// Draws summit labels, azimuth ticks and the horizon line over the outline
// image and writes an RGB PNG to `outputPath`.
void renderAnnotations(const View &view,
                       const std::vector<uint8_t> &outlines,
                       const std::vector<VisibleSummit> &summits,
                       const std::filesystem::path &outputPath);

} // namespace pano
