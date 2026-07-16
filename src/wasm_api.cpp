// C ABI exported to JavaScript (Emscripten build only).
// JS owns all I/O: it fetches .hgt tiles and the summit TSV, passes them in
// as bytes, and draws the returned distance strip + summit list on a canvas.

#include <algorithm>
#include <cstdint>
#include <format>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>
#include <zstd.h>

#include "distmap.hpp"
#include "heightmap.hpp"
#include "summits.hpp"
#include "tonemap.hpp"
#include "view.hpp"

namespace {

// One implicit session; a phone renders one panorama at a time.
std::unique_ptr<pano::HeightMap> g_heightMap;
std::unique_ptr<pano::View> g_view;
std::vector<uint16_t> g_distMap;
std::vector<uint8_t> g_rgba;
std::string g_summitsJson;

void appendJsonEscaped(std::string &out, const std::string &s)
{
    for (const char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (uint8_t(c) < 0x20) {
            out += std::format("\\u{:04x}", c);
        } else {
            out += c;
        }
    }
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void pano_reset(int minLat, int minLon, int maxLat, int maxLon)
{
    g_heightMap = std::make_unique<pano::HeightMap>(
        pano::LatLonRange{minLat, minLon, maxLat, maxLon});
    g_view.reset();
    g_distMap.clear();
}

// data = raw big-endian .hgt bytes (1201*1201 int16), fetched by JS.
EMSCRIPTEN_KEEPALIVE
void pano_addTile(int lat, int lon, const int16_t *data)
{
    if (g_heightMap)
        g_heightMap->addTileRaw(lat, lon, data);
}

// Safe eye elevation for a viewpoint: max of the 3x3 heightmap cells around
// the position. SRTM smooths sharp summits and sampling rounds to a cell, so
// the literal sample can sit below an adjacent cell — an eye placed there
// gets its whole panorama eaten by the neighboring 90 m of terrain.
EMSCRIPTEN_KEEPALIVE
double pano_eyeElevation(double lat, double lon)
{
    if (!g_heightMap)
        return 0.0;
    double x, y;
    g_heightMap->gridCoords(lat, lon, x, y);
    uint16_t best = 0;
    for (int dy = -1; dy <= 1; ++dy)
        for (int dx = -1; dx <= 1; ++dx)
            best = std::max(best, g_heightMap->atGrid(x + dx, y + dy));
    return double(best);
}

// data = zstd-compressed .hgt.zst bytes; returns 1 on success, 0 on error.
EMSCRIPTEN_KEEPALIVE
int pano_addTileZst(int lat, int lon, const uint8_t *data, int size)
{
    if (!g_heightMap)
        return 0;
    constexpr size_t kCount = size_t(pano::HeightMap::kTileSize) * pano::HeightMap::kTileSize;
    std::vector<int16_t> raw(kCount);
    const size_t written = ZSTD_decompress(raw.data(), kCount * 2, data, size_t(size));
    if (ZSTD_isError(written) || written != kCount * 2)
        return 0;
    g_heightMap->addTileRaw(lat, lon, raw.data());
    return 1;
}

// Returns pointer to the row-major uint16 distance map (0 = sky, else
// distance in 50 m steps); dimensions via pano_width()/pano_height().
EMSCRIPTEN_KEEPALIVE
const uint16_t *pano_render(double lat, double lon, double eyeEle,
                            double azMinDeg, double azMaxDeg,
                            double elMinRad, double elMaxRad,
                            double stepRad, double distMaxM, double refraction)
{
    if (!g_heightMap)
        return nullptr;
    g_view = std::make_unique<pano::View>(
        pano::SphereEarth{}, pano::PositionLLE{lat, lon, eyeEle},
        pano::toRadians(azMinDeg), pano::toRadians(azMaxDeg),
        elMinRad, elMaxRad, stepRad, distMaxM, refraction);
    g_distMap = pano::makeDistMap(*g_view, *g_heightMap);
    return g_distMap.data();
}

// Aerial-perspective tonemap of the last render (src/tonemap.cpp — shared
// with the native CLI, identical pixels). Returns W*H RGBA pixels.
EMSCRIPTEN_KEEPALIVE
const uint8_t *pano_tonemap(double visibilityKm,
                            int terrainR, int terrainG, int terrainB,
                            int skyR, int skyG, int skyB)
{
    if (!g_view || g_distMap.empty())
        return nullptr;
    g_rgba = pano::tonemapDistMap(*g_view, g_distMap, visibilityKm,
                                  {terrainR, terrainG, terrainB}, {skyR, skyG, skyB});
    return g_rgba.data();
}

EMSCRIPTEN_KEEPALIVE
int pano_width() { return g_view ? g_view->outWidth : 0; }

EMSCRIPTEN_KEEPALIVE
int pano_height() { return g_view ? g_view->outHeight : 0; }

// tsv = summit database content; returns JSON array of summits visible in
// the last rendered view: [{"name":…,"x":…,"y":…,"distanceM":…},…]
EMSCRIPTEN_KEEPALIVE
const char *pano_summits(const char *tsv)
{
    g_summitsJson = "[";
    if (g_view && g_heightMap && !g_distMap.empty()) {
        const auto summits = pano::parseSummitsTsv(tsv);
        const auto visible = pano::findVisibleSummits(*g_view, *g_heightMap, g_distMap, summits);
        for (size_t i = 0; i < visible.size(); ++i) {
            if (i)
                g_summitsJson += ',';
            g_summitsJson += "{\"name\":\"";
            appendJsonEscaped(g_summitsJson, visible[i].name);
            g_summitsJson += std::format("\",\"x\":{},\"y\":{},\"distanceM\":{:.0f},\"prom\":{:.0f}}}",
                                         visible[i].x, visible[i].y, visible[i].distanceM,
                                         std::min(visible[i].prominence, 9999.0));
        }
    }
    g_summitsJson += "]";
    return g_summitsJson.c_str();
}

} // extern "C"
