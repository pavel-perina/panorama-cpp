#pragma once
// SRTM3 .hgt tile loading and the merged heightmap grid.

#include <cstdint>
#include <filesystem>
#include <vector>

namespace pano {

// Integer-degree bounding box of SRTM tiles, north-eastern hemisphere only
// (same limitation as the Julia/Rust versions).
struct LatLonRange {
    int minLat = 0, minLon = 0; // south-west corner tile
    int maxLat = 0, maxLon = 0; // north-east corner tile (inclusive)

    int tilesHoriz() const { return maxLon - minLon + 1; }
    int tilesVert() const { return maxLat - minLat + 1; }
    int tilesTotal() const { return tilesHoriz() * tilesVert(); }
};

class HeightMap {
public:
    static constexpr int kPixelsPerDeg = 1200; // SRTM3: 3 arc-second grid
    static constexpr int kTileSize = 1201;     // rows/cols per tile, edges shared

    // Loads and stitches all tiles in `range` from `tileDir` (N%02dE%03d.hgt).
    // Throws std::runtime_error on missing/short files.
    static HeightMap load(const LatLonRange &range, const std::filesystem::path &tileDir);

    int width() const { return m_width; }
    int height() const { return m_height; }
    const uint16_t *data() const { return m_data.data(); }
    const LatLonRange &range() const { return m_range; }

    // Nearest-neighbor sample at geographic coordinates, clamped to the grid.
    uint16_t at(double latDeg, double lonDeg) const
    {
        return m_data[indexOf(latDeg, lonDeg)];
    }

    size_t indexOf(double latDeg, double lonDeg) const
    {
        const double y = (double(m_range.maxLat + 1) - latDeg) * kPixelsPerDeg;
        const double x = (lonDeg - double(m_range.minLon)) * kPixelsPerDeg;
        // negative -> 0 via the max(); the (int) truncation matches Julia/Rust
        const int c = std::min(int(std::max(x, 0.0)), m_width - 1);
        const int r = std::min(int(std::max(y, 0.0)), m_height - 1);
        return size_t(r) * m_width + c;
    }

private:
    LatLonRange m_range;
    int m_width = 0;
    int m_height = 0;
    std::vector<uint16_t> m_data; // row-major, row 0 = northern edge
};

} // namespace pano
