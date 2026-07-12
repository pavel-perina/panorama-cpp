#pragma once
// Raycast distance map and outline extraction.

#include <cstdint>
#include <vector>

#include "heightmap.hpp"
#include "view.hpp"

namespace pano {

// For every output pixel: distance to terrain in distStep units (0 = sky).
// Row-major, outWidth x outHeight, row 0 at elevationMax.
std::vector<uint16_t> makeDistMap(const View &view, const HeightMap &heightMap);

// 8-bit edge image: 255 = flat, darker = larger vertical distance jump.
std::vector<uint8_t> extractOutlines(const View &view, const std::vector<uint16_t> &distMap);

} // namespace pano
