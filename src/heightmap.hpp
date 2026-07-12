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

    HeightMap() = default;

    // Allocates a zeroed grid covering `range`; fill it with addTileRaw().
    explicit HeightMap(const LatLonRange &range);

    // Copies one 1201x1201 big-endian int16 tile (raw .hgt content) into the
    // grid. Voids (-32768) and out-of-range values are clamped to [0, 6000]
    // like the Julia version, otherwise SRTM voids show up as 32 km high
    // walls (the Rust version had this artifact).
    void addTileRaw(int lat, int lon, const int16_t *bigEndianData);

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
        double x, y;
        gridCoords(latDeg, lonDeg, x, y);
        return atGrid(x, y);
    }

    // Continuous grid coordinates (column x, row y) of a geographic position;
    // unclamped, so they can be interpolated before sampling.
    void gridCoords(double latDeg, double lonDeg, double &x, double &y) const
    {
        y = (double(m_range.maxLat + 1) - latDeg) * kPixelsPerDeg;
        x = (lonDeg - double(m_range.minLon)) * kPixelsPerDeg;
    }

    // Nearest-neighbor sample at continuous grid coordinates, clamped.
    // (+0.5: Julia/Rust truncated, which shifted the sampled profile by half
    // a cell toward +lat/+lon and left summit labels ~4 px off the peaks.)
    uint16_t atGrid(double x, double y) const
    {
        const int c = std::min(int(std::max(x + 0.5, 0.0)), m_width - 1);
        const int r = std::min(int(std::max(y + 0.5, 0.0)), m_height - 1);
        return m_data[size_t(r) * m_width + c];
    }

private:
    LatLonRange m_range;
    int m_width = 0;
    int m_height = 0;
    std::vector<uint16_t> m_data; // row-major, row 0 = northern edge
};

} // namespace pano
