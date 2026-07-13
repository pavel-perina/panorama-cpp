// Prominence + isolation sweep over SRTM tiles — the C++ half of the summit
// database pipeline (docs/ideas.md "Peak rating"). Emits every grid local
// maximum above a prominence threshold; scripts/build_peaks_db.py matches
// the result against OSM named peaks.
//
// Algorithm (Kirmse water-level): process cells by descending elevation,
// maintaining islands with union-find. When two islands merge at elevation
// s, the island with the lower peak P dies and s is its key saddle:
// prominence(P) = ele(P) - s. Prominence is exact within the loaded region;
// peaks whose key saddle lies outside get an overestimate (fewer escape
// routes to higher ground), so load generously around the area of interest.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <format>
#include <fstream>
#include <print>
#include <vector>

#include "geo.hpp"
#include "heightmap.hpp"
#include "parallel.hpp"

namespace {

struct PeakRec {
    int32_t cell;       // grid index of the peak
    uint16_t prom;      // prominence [m]
    uint16_t saddleEle; // key saddle elevation [m]
    float isolationKm;  // distance to nearest higher cell, capped
};

} // namespace

int main(int argc, char **argv)
{
    if (argc < 5) {
        std::println(stderr, "Usage: {} minLat minLon maxLat maxLon"
                             " [dataDir=data] [minProm=10] [out=data/prominence.tsv]",
                     argv[0]);
        return 1;
    }
    const pano::LatLonRange range{std::atoi(argv[1]), std::atoi(argv[2]),
                                  std::atoi(argv[3]), std::atoi(argv[4])};
    const std::filesystem::path dataDir = argc > 5 ? argv[5] : "data";
    const int minProm = argc > 6 ? std::atoi(argv[6]) : 10;
    const std::filesystem::path outPath = argc > 7 ? argv[7] : "data/prominence.tsv";

    const pano::HeightMap hm = pano::HeightMap::load(range, dataDir);
    const uint16_t *h = hm.data();
    const int width = hm.width(), height = hm.height();
    const size_t n = size_t(width) * height;
    const auto t0 = std::chrono::steady_clock::now();

    // Counting sort by elevation, descending (elevations are clamped [0,6000]).
    std::vector<int32_t> order(n);
    {
        std::vector<uint32_t> pos(6001, 0);
        for (size_t i = 0; i < n; ++i)
            ++pos[h[i]];
        uint32_t acc = 0;
        for (int e = 6000; e >= 0; --e) {
            const uint32_t c = pos[e];
            pos[e] = acc;
            acc += c;
        }
        for (size_t i = 0; i < n; ++i)
            order[pos[h[i]]++] = int32_t(i);
    }

    // Union-find over cells. parent[i]: -1 = under water (unprocessed),
    // >= 0 = link toward root, <= -2 = island root with peak cell -parent-2.
    std::vector<int32_t> parent(n, -1);
    const auto find = [&](int32_t x) {
        while (parent[x] >= 0) {
            const int32_t p = parent[x];
            const int32_t gp = parent[p];
            if (gp >= 0) {
                parent[x] = gp; // path halving
                x = gp;
            } else {
                x = p;
            }
        }
        return x;
    };

    std::vector<PeakRec> peaks;
    constexpr int dr[8] = {-1, -1, -1, 0, 0, 1, 1, 1};
    constexpr int dc[8] = {-1, 0, 1, -1, 1, -1, 0, 1};
    for (size_t oi = 0; oi < n; ++oi) {
        const int32_t cell = order[oi];
        const int row = cell / width, col = cell % width;
        int32_t root = -1;
        for (int k = 0; k < 8; ++k) {
            const int r2 = row + dr[k], c2 = col + dc[k];
            if (r2 < 0 || r2 >= height || c2 < 0 || c2 >= width)
                continue;
            const int32_t nb = r2 * width + c2;
            if (parent[nb] == -1)
                continue; // still under water
            const int32_t rb = find(nb);
            if (rb == root)
                continue;
            if (root == -1) {
                root = rb;
                continue;
            }
            // two islands meet: this cell is the lower peak's key saddle
            const int32_t pa = -parent[root] - 2, pb = -parent[rb] - 2;
            const bool aWins = h[pa] > h[pb] || (h[pa] == h[pb] && pa < pb);
            const int32_t loserRoot = aWins ? rb : root;
            const int32_t loserPeak = aWins ? pb : pa;
            const int prom = int(h[loserPeak]) - int(h[cell]);
            if (prom >= minProm)
                peaks.push_back({loserPeak, uint16_t(prom), h[cell], 0.0f});
            root = aWins ? root : rb;
            parent[loserRoot] = root;
        }
        parent[cell] = root == -1 ? -(cell + 2) : root;
    }
    {
        // The region's highest peak never merges; its prominence is clipped
        // at the lowest cell of the region.
        const int32_t topRoot = find(order[n - 1]);
        const int32_t topPeak = -parent[topRoot] - 2;
        const uint16_t minEle = h[order[n - 1]];
        peaks.push_back({topPeak, uint16_t(h[topPeak] - minEle), minEle, 0.0f});
    }
    const auto t1 = std::chrono::steady_clock::now();
    std::println("Water-level sweep: {} cells -> {} peaks with prom >= {} m ({:.1f} s)",
                 n, peaks.size(), minProm,
                 std::chrono::duration<double>(t1 - t0).count());

    // Isolation: distance to the nearest strictly higher cell, expanding
    // Chebyshev rings, capped (25.0 in the output = "at least 25 km").
    constexpr double kCellM = 92.66; // 3 arcsec N-S
    constexpr double kIsolationCapM = 25000.0;
    const auto computeIsolation = [&](PeakRec &pk) {
        const int row = pk.cell / width, col = pk.cell % width;
        const uint16_t ele = h[pk.cell];
        const double lat = double(range.maxLat + 1) - double(row) / pano::HeightMap::kPixelsPerDeg;
        const double cellW = kCellM * std::cos(pano::toRadians(lat));
        double best = kIsolationCapM;
        for (int k = 1; k * cellW < best; ++k) {
            const auto visit = [&](int r2, int c2) {
                if (r2 < 0 || r2 >= height || c2 < 0 || c2 >= width)
                    return;
                if (h[size_t(r2) * width + c2] <= ele)
                    return;
                best = std::min(best, std::hypot((r2 - row) * kCellM, (c2 - col) * cellW));
            };
            for (int c2 = col - k; c2 <= col + k; ++c2) {
                visit(row - k, c2);
                visit(row + k, c2);
            }
            for (int r2 = row - k + 1; r2 <= row + k - 1; ++r2) {
                visit(r2, col - k);
                visit(r2, col + k);
            }
        }
        pk.isolationKm = float(best / 1000.0);
    };
    pano::parallelFor(0, int(peaks.size()), 64, [&](int b, int e) {
        for (int i = b; i < e; ++i)
            computeIsolation(peaks[size_t(i)]);
    });
    const auto t2 = std::chrono::steady_clock::now();
    std::println("Isolation pass: {:.1f} s", std::chrono::duration<double>(t2 - t1).count());

    std::sort(peaks.begin(), peaks.end(),
              [](const PeakRec &a, const PeakRec &b) { return a.prom > b.prom; });
    std::ofstream out(outPath);
    out << "lat\tlon\tele\tprom\tsaddle\tisolation_km\n";
    for (const PeakRec &pk : peaks) {
        const int row = pk.cell / width, col = pk.cell % width;
        out << std::format("{:.6f}\t{:.6f}\t{}\t{}\t{}\t{:.2f}\n",
                           double(range.maxLat + 1) - double(row) / pano::HeightMap::kPixelsPerDeg,
                           double(range.minLon) + double(col) / pano::HeightMap::kPixelsPerDeg,
                           h[pk.cell], pk.prom, pk.saddleEle, pk.isolationKm);
    }
    std::println("Wrote {} ({} rows)", outPath.string(), peaks.size());
    return 0;
}
