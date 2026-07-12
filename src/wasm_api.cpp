// C ABI exported to JavaScript (Emscripten build only).
// JS owns all I/O: it fetches .hgt tiles and the summit TSV, passes them in
// as bytes, and draws the returned distance strip + summit list on a canvas.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <format>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>
#include <zstd.h>

#include "common/colors.h"
#include "distmap.hpp"
#include "heightmap.hpp"
#include "summits.hpp"
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

// Aerial-perspective tonemap of the last render: terrain fades into the sky
// with distance (Koschmieder contrast decay, V = visibilityKm), interpolated
// in OkLab so the perceptual fade is uniform. Returns W*H RGBA pixels.
EMSCRIPTEN_KEEPALIVE
const uint8_t *pano_tonemap(double visibilityKm,
                            int terrainR, int terrainG, int terrainB,
                            int skyR, int skyG, int skyB)
{
    if (!g_view || g_distMap.empty())
        return nullptr;
    const color::OkLab terrain = color::okLabFromRgb(
        {terrainR / 255.0f, terrainG / 255.0f, terrainB / 255.0f});
    const color::OkLab sky = color::okLabFromRgb(
        {skyR / 255.0f, skyG / 255.0f, skyB / 255.0f});

    // Color per distance value (index = distance in distStep units).
    const double k = 3.912 / (visibilityKm * 1000.0);
    std::vector<std::array<uint8_t, 4>> lut(size_t(g_view->distSteps()));
    for (size_t d = 0; d < lut.size(); ++d) {
        const float t = float(1.0 - std::exp(-k * double(d) * g_view->distStepM));
        const color::Rgb rgb = color::okLabToRgb({terrain.L + (sky.L - terrain.L) * t,
                                                  terrain.a + (sky.a - terrain.a) * t,
                                                  terrain.b + (sky.b - terrain.b) * t});
        lut[d] = {uint8_t(rgb.r * 255.0f + 0.5f), uint8_t(rgb.g * 255.0f + 0.5f),
                  uint8_t(rgb.b * 255.0f + 0.5f), 255};
    }
    const std::array<uint8_t, 4> skyPx{uint8_t(skyR), uint8_t(skyG), uint8_t(skyB), 255};

    g_rgba.resize(g_distMap.size() * 4);
    for (size_t i = 0; i < g_distMap.size(); ++i) {
        const uint16_t d = g_distMap[i];
        const auto &px = d == 0 ? skyPx : lut[d]; // 0 = sky
        std::copy(px.begin(), px.end(), &g_rgba[i * 4]);
    }
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
    if (g_view && !g_distMap.empty()) {
        const auto summits = pano::parseSummitsTsv(tsv);
        const auto visible = pano::findVisibleSummits(*g_view, g_distMap, summits);
        for (size_t i = 0; i < visible.size(); ++i) {
            if (i)
                g_summitsJson += ',';
            g_summitsJson += "{\"name\":\"";
            appendJsonEscaped(g_summitsJson, visible[i].name);
            g_summitsJson += std::format("\",\"x\":{},\"y\":{},\"distanceM\":{:.0f}}}",
                                         visible[i].x, visible[i].y, visible[i].distanceM);
        }
    }
    g_summitsJson += "]";
    return g_summitsJson.c_str();
}

} // extern "C"
