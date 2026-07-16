#include "heightmap.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <format>
#include <fstream>
#include <print>
#include <stdexcept>

#include <zstd.h>

#include "geo.hpp"
#include "parallel.hpp"

namespace pano {

HeightMap::HeightMap(const LatLonRange &range)
    : m_range(range),
      m_width(range.tilesHoriz() * kPixelsPerDeg + 1),
      m_height(range.tilesVert() * kPixelsPerDeg + 1),
      m_data(size_t(m_width) * m_height, 0)
{
}

void HeightMap::addTileRaw(int lat, int lon, const int16_t *bigEndianData)
{
    const size_t rowOffset = size_t(m_range.maxLat - lat) * kPixelsPerDeg;
    const size_t colOffset = size_t(lon - m_range.minLon) * kPixelsPerDeg;
    for (int y = 0; y < kTileSize; ++y) {
        // tile edges overlap by one shared pixel with neighbors
        uint16_t *dst = &m_data[(rowOffset + y) * m_width + colOffset];
        const int16_t *src = bigEndianData + size_t(y) * kTileSize;
        for (int x = 0; x < kTileSize; ++x)
            dst[x] = uint16_t(std::clamp<int16_t>(std::byteswap(src[x]), 0, 6000));
    }
}

HeightMap HeightMap::load(const LatLonRange &range, const std::filesystem::path &tileDir)
{
    HeightMap hm(range);

    std::println("Requesting data for area lat {}° lon {}° - lat {}° lon {}° ... (aprox. {:3.0f}x{:3.0f} km).",
                 range.minLat, range.minLon, range.maxLat, range.maxLon,
                 range.tilesHoriz() * 111.1 * std::cos(toRadians(double(range.minLat))),
                 range.tilesVert() * 111.1);
    std::println("I will read {}x{}={} tiles, heightmap size is {}x{} ({} MB).",
                 range.tilesHoriz(), range.tilesVert(), range.tilesTotal(),
                 hm.m_width, hm.m_height, hm.m_data.size() * 2 / 1000000);

    const auto loadTile = [&](int i) {
        const int lat = range.minLat + i / range.tilesHoriz();
        const int lon = range.minLon + i % range.tilesHoriz();
        constexpr size_t kCount = size_t(kTileSize) * kTileSize;

        // zstd-compressed tile is the primary source, plain .hgt the
        // fallback; hgt3-zst/ is the 3-arcsec mirror layout that the web app
        // uses too (see scripts/mirror_hgt.py) — the "3" keeps the slot open
        // for a 1-arcsec hgt1-zst/ sibling. hgt-zst/ is the legacy name.
        // tile is named by its floored SW corner: lat -34 -> S34 (covers -34..-33)
        const std::string name = std::format("{}{:02}{}{:03}.hgt",
                                             lat < 0 ? 'S' : 'N', std::abs(lat),
                                             lon < 0 ? 'W' : 'E', std::abs(lon));
        const std::filesystem::path rawPath = tileDir / name;
        std::filesystem::path zstPath = tileDir / "hgt3-zst" / (name + ".zst");
        if (!std::filesystem::exists(zstPath))
            zstPath = tileDir / "hgt-zst" / (name + ".zst");
        if (!std::filesystem::exists(zstPath))
            zstPath = tileDir / (name + ".zst");
        std::vector<int16_t> raw(kCount);

        if (std::ifstream file{zstPath, std::ios::binary}) {
            const std::vector<char> compressed(std::istreambuf_iterator<char>(file), {});
            const size_t written = ZSTD_decompress(raw.data(), kCount * 2,
                                                   compressed.data(), compressed.size());
            if (ZSTD_isError(written))
                throw std::runtime_error(std::format("{}: {}", zstPath.string(),
                                                     ZSTD_getErrorName(written)));
            if (written != kCount * 2)
                throw std::runtime_error(std::format(
                    "{}: decompressed to {} bytes, expected {} (1-arcsecond tile?)",
                    zstPath.string(), written, kCount * 2));
        } else if (std::ifstream file{rawPath, std::ios::binary}) {
            file.read(reinterpret_cast<char *>(raw.data()), std::streamsize(kCount * 2));
            if (size_t(file.gcount()) != kCount * 2)
                throw std::runtime_error("Short read on tile " + rawPath.string());
        } else {
            throw std::runtime_error("Cannot open tile " + rawPath.string() +
                                     "[.zst] (run scripts/download_hgt.py)");
        }
        hm.addTileRaw(lat, lon, raw.data());
    };
    // grain 1: a chunk is one tile (file I/O + decompress). A missing tile's
    // exception propagates out of parallelFor (OpenMP terminated instead).
    parallelFor(0, range.tilesTotal(), 1, [&](int b, int e) {
        for (int i = b; i < e; ++i)
            loadTile(i);
    });
    return hm;
}

} // namespace pano
