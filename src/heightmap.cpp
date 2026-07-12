#include "heightmap.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <format>
#include <fstream>
#include <print>
#include <stdexcept>

#include "geo.hpp"

namespace pano {

namespace {

// Reads one 1201x1201 big-endian int16 tile; voids (-32768) and out-of-range
// values are clamped to [0, 6000] like the Julia version, otherwise SRTM voids
// show up as 32 km high walls (the Rust version had this artifact).
std::vector<uint16_t> loadTile(int lat, int lon, const std::filesystem::path &tileDir)
{
    const std::filesystem::path path = tileDir / std::format("N{:02}E{:03}.hgt", lat, lon);
    constexpr size_t kCount = size_t(HeightMap::kTileSize) * HeightMap::kTileSize;

    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Cannot open tile " + path.string() +
                                 " (run scripts/download_hgt.py)");

    std::vector<int16_t> raw(kCount);
    file.read(reinterpret_cast<char *>(raw.data()), std::streamsize(kCount * 2));
    if (size_t(file.gcount()) != kCount * 2)
        throw std::runtime_error("Short read on tile " + path.string());

    std::vector<uint16_t> tile(kCount);
    for (size_t i = 0; i < kCount; ++i) {
        const int16_t v = std::byteswap(raw[i]);
        tile[i] = uint16_t(std::clamp<int16_t>(v, 0, 6000));
    }
    return tile;
}

} // namespace

HeightMap HeightMap::load(const LatLonRange &range, const std::filesystem::path &tileDir)
{
    HeightMap hm;
    hm.m_range = range;
    hm.m_width = range.tilesHoriz() * kPixelsPerDeg + 1;
    hm.m_height = range.tilesVert() * kPixelsPerDeg + 1;
    hm.m_data.assign(size_t(hm.m_width) * hm.m_height, 0);

    std::println("Requesting data for area {}°N {}°E - {}°N {}°E ... (aprox. {:3.0f}x{:3.0f} km).",
                 range.minLat, range.minLon, range.maxLat, range.maxLon,
                 range.tilesHoriz() * 111.1 * std::cos(toRadians(double(range.minLat))),
                 range.tilesVert() * 111.1);
    std::println("I will read {}x{}={} tiles, heightmap size is {}x{} ({} MB).",
                 range.tilesHoriz(), range.tilesVert(), range.tilesTotal(),
                 hm.m_width, hm.m_height, hm.m_data.size() * 2 / 1000000);

    #pragma omp parallel for schedule(dynamic)
    for (int i = 0; i < range.tilesTotal(); ++i) {
        const int lat = range.minLat + i / range.tilesHoriz();
        const int lon = range.minLon + i % range.tilesHoriz();
        const std::vector<uint16_t> tile = loadTile(lat, lon, tileDir);
        // Copy into the merged grid; tile edges overlap by one shared px.
        const size_t rowOffset = size_t(range.maxLat - lat) * kPixelsPerDeg;
        const size_t colOffset = size_t(lon - range.minLon) * kPixelsPerDeg;
        for (int y = 0; y < kTileSize; ++y) {
            std::copy_n(&tile[size_t(y) * kTileSize], kTileSize,
                        &hm.m_data[(rowOffset + y) * hm.m_width + colOffset]);
        }
    }
    return hm;
}

} // namespace pano
