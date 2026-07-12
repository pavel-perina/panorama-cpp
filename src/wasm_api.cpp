// C ABI exported to JavaScript (Emscripten build only).
// JS owns all I/O: it fetches .hgt tiles and the summit TSV, passes them in
// as bytes, and draws the returned distance strip + summit list on a canvas.

#include <cstdint>
#include <format>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "distmap.hpp"
#include "heightmap.hpp"
#include "summits.hpp"
#include "view.hpp"

namespace {

// One implicit session; a phone renders one panorama at a time.
std::unique_ptr<pano::HeightMap> g_heightMap;
std::unique_ptr<pano::View> g_view;
std::vector<uint16_t> g_distMap;
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
