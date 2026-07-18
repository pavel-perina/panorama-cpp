// Panorama renderer — C++ port of panorama-jl / panorama-rs.
// Renders a terrain distance map from SRTM heightmaps, extracts outlines and
// annotates visible summits. Scene defaults match the originals (Praděd, CZ).

#include <charconv>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <optional>
#include <print>
#include <string_view>

#include "distmap.hpp"
#include "geo.hpp"
#include "heightmap.hpp"
#include "pngwrite.hpp"
#include "sdftext.hpp"
#include "summits.hpp"
#include "tonemap.hpp"
#include "view.hpp"

using namespace pano;

namespace {

double secondsSince(std::chrono::steady_clock::time_point start)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
}

struct Options {
    std::filesystem::path dataDir = "data";
    bool label = false;                 // annotate the photo rendering
    bool bilinear = false;              // bilinear heightmap sampling
    Rgb8 terrain{50, 65, 0};            // near-terrain color (parity-reference palette;
    Rgb8 sky{149, 195, 233};            // the web app defaults to its sky-palette +30° row)
    std::optional<Rgb8> horizon;        // horizon airlight override (time-of-day)
};

// "RRGGBB" or "#RRGGBB" -> Rgb8; exits with a message on malformed input.
Rgb8 parseHexColor(std::string_view s)
{
    if (s.starts_with('#'))
        s.remove_prefix(1);
    unsigned v = 0;
    const auto [end, ec] = std::from_chars(s.data(), s.data() + s.size(), v, 16);
    if (ec != std::errc{} || end != s.data() + s.size() || s.size() != 6) {
        std::println(stderr, "Bad color '{}': expected hex RRGGBB", s);
        std::exit(1);
    }
    return {int(v >> 16), int(v >> 8 & 0xff), int(v & 0xff)};
}

[[noreturn]] void usage()
{
    std::println(stderr,
                 "Usage: panorama [options] [dataDir]\n"
                 "  -l,  --label             annotate panorama_photo.png (summit labels,\n"
                 "                           azimuth ruler, horizon line)\n"
                 "  -b,  --bilinear          bilinear heightmap sampling (smooth near\n"
                 "                           ridges; nearest sampling is the default)\n"
                 "  -fg, --foreground-color  photo near-terrain color, hex RRGGBB (default 324100)\n"
                 "  -bg, --background-color  photo sky color, hex RRGGBB (default 95c3e9)\n"
                 "  -hz, --horizon-color     photo horizon airlight override, hex RRGGBB\n"
                 "                           (default: sky pushed 85%% toward white)\n"
                 "Scene (viewpoint, azimuth window, distance) is hardcoded in src/main.cpp.");
    std::exit(1);
}

Options parseOptions(int argc, char **argv)
{
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        const auto value = [&]() -> std::string_view {
            if (++i >= argc) {
                std::println(stderr, "Missing value for {}", arg);
                std::exit(1);
            }
            return argv[i];
        };
        if (arg == "-l" || arg == "--label")
            opt.label = true;
        else if (arg == "-b" || arg == "--bilinear")
            opt.bilinear = true;
        else if (arg == "-fg" || arg == "--foreground-color")
            opt.terrain = parseHexColor(value());
        else if (arg == "-bg" || arg == "--background-color")
            opt.sky = parseHexColor(value());
        else if (arg == "-hz" || arg == "--horizon-color")
            opt.horizon = parseHexColor(value());
        else if (arg.starts_with('-'))
            usage();
        else
            opt.dataDir = arg;
    }
    return opt;
}

} // namespace

int main(int argc, char **argv)
{
    const Options opt = parseOptions(argc, argv);
    const std::filesystem::path &dataDir = opt.dataDir;

    const LatLonRange range{.minLat = 47, .minLon = 15, .maxLat = 50, .maxLon = 21};
#if 0
    // Praded    
    const PositionLLE eye{.lat = 50.08309, .lon = 17.23094, .ele = 1510.0};
#else
    // Kamenice
    const PositionLLE eye{.lat = 49.6013028, .lon = 16.1646667, .ele = 780.0};
#endif
    try {
        auto t0 = std::chrono::steady_clock::now();
        const HeightMap heightMap = HeightMap::load(range, dataDir);
        std::println("Loading took {:.3f} seconds", secondsSince(t0));
#if 0
        const View view(SphereEarth{}, eye,
                        toRadians(90.0), toRadians(135.0), // azimuth window
                        -0.0560, 0.0339,                   // elevation window [rad]
                        0.0001,                            // 0.1 mrad per pixel
                        250.0e3, 1.18);                    // max distance, refraction
#else
        const View view(SphereEarth{}, eye,
                        toRadians(0.0), toRadians(60.0), // azimuth window
                        -0.0560, 0.0339,                   // elevation window [rad]
                        0.0001,                            // 0.1 mrad per pixel
                        250.0e3, 1.18,                     // max distance, refraction
                        opt.bilinear);
#endif
        t0 = std::chrono::steady_clock::now();
        const std::vector<uint16_t> distMap = makeDistMap(view, heightMap);
        std::println("Distance map took {:.3f} seconds", secondsSince(t0));

        std::println("Saving dist_map.png");
        writePng("dist_map.png", view.outWidth, view.outHeight, 1, 16, distMap.data());

        std::println("Extracting outlines");
        const std::vector<uint8_t> outlines = extractOutlines(view, distMap);
        std::println("Saving outlines.png");
        writePng("outlines.png", view.outWidth, view.outHeight, 1, 8, outlines.data());

        // Rated peak database when built (scripts/build_peaks_db.py),
        // curated summit list otherwise.
        auto summitsPath = dataDir / "peaks-rated.tsv";
        if (!std::filesystem::exists(summitsPath))
            summitsPath = dataDir / "summits.tsv";
        std::println("Summit database: {}", summitsPath.string());
        const auto summits = loadSummitsTsv(summitsPath);
        const auto visible = findVisibleSummits(view, heightMap, distMap, summits);
        std::println("Saving panorama.png");
        auto fontPath = dataDir / "fonts" / "font-sdf.bin";
        if (!std::filesystem::exists(fontPath))
            fontPath = "data/fonts/font-sdf.bin"; // dataDir may be the tile mirror
        const SdfFont font = SdfFont::load(fontPath);
        renderAnnotations(view, outlines, visible, font, "panorama.png");

        // Photo-style rendering, same tonemap code and default palette as the
        // web app (visibility slider default 100 km) — pixels match the page.
        std::println("Saving panorama_photo.png{}", opt.label ? " (labeled)" : "");
        const std::vector<uint8_t> rgba = tonemapDistMap(
            view, distMap, 100.0, opt.terrain, opt.sky,
            opt.horizon ? &*opt.horizon : nullptr);
        std::vector<uint8_t> rgb(view.arraySize() * 3);
        for (size_t i = 0; i < view.arraySize(); ++i)
            std::copy_n(&rgba[i * 4], 3, &rgb[i * 3]);
        if (opt.label)
            drawAnnotations(view, rgb.data(), visible, font);
        writePng("panorama_photo.png", view.outWidth, view.outHeight, 3, 8, rgb.data());
    } catch (const std::exception &e) {
        std::println(stderr, "Error: {}", e.what());
        return 1;
    }

    std::println("All done.");
    return 0;
}
