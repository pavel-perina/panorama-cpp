// Panorama renderer — C++ port of panorama-jl / panorama-rs.
// Renders a terrain distance map from SRTM heightmaps, extracts outlines and
// annotates visible summits. Scene defaults match the originals (Praděd, CZ).

#include <chrono>
#include <filesystem>
#include <print>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>

#include "distmap.hpp"
#include "geo.hpp"
#include "heightmap.hpp"
#include "summits.hpp"
#include "view.hpp"

using namespace pano;

namespace {

double secondsSince(std::chrono::steady_clock::time_point start)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
}

} // namespace

int main(int argc, char **argv)
{
    const std::filesystem::path dataDir = argc > 1 ? argv[1] : "data";

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
                        250.0e3, 1.18);                    // max distance, refraction
#endif
        t0 = std::chrono::steady_clock::now();
        const std::vector<uint16_t> distMap = makeDistMap(view, heightMap);
        std::println("Distance map took {:.3f} seconds", secondsSince(t0));

        std::println("Saving dist_map.png");
        const cv::Mat distMat(view.outHeight, view.outWidth, CV_16UC1,
                              const_cast<uint16_t *>(distMap.data()));
        cv::imwrite("dist_map.png", distMat);

        std::println("Extracting outlines");
        const std::vector<uint8_t> outlines = extractOutlines(view, distMap);
        std::println("Saving outlines.png");
        const cv::Mat outlineMat(view.outHeight, view.outWidth, CV_8UC1,
                                 const_cast<uint8_t *>(outlines.data()));
        cv::imwrite("outlines.png", outlineMat);

        // Rated peak database when built (scripts/build_peaks_db.py),
        // curated summit list otherwise.
        auto summitsPath = dataDir / "peaks-rated.tsv";
        if (!std::filesystem::exists(summitsPath))
            summitsPath = dataDir / "summits.tsv";
        std::println("Summit database: {}", summitsPath.string());
        const auto summits = loadSummitsTsv(summitsPath);
        const auto visible = findVisibleSummits(view, heightMap, distMap, summits);
        std::println("Saving panorama.png");
        renderAnnotations(view, outlines, visible, "panorama.png");
    } catch (const std::exception &e) {
        std::println(stderr, "Error: {}", e.what());
        return 1;
    }

    std::println("All done.");
    return 0;
}
