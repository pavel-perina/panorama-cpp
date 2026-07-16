#include "distmap.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <print>

#include "parallel.hpp"

namespace pano {

namespace {

// earthCurve[i] = apparent drop at i*distStep for the refraction-scaled radius.
std::vector<double> precomputeEarthCurve(double radius, double distMax, double distStep)
{
    const int nSteps = int(distMax / distStep) + 1;
    std::vector<double> curve(nSteps);
    for (int i = 0; i < nSteps; ++i)
        curve[i] = elevationDropAtDistance(i * distStep, radius);
    return curve;
}

// Transpose colMajor[W][H] into rowMajor[H][W], blocked for cache locality.
void transpose(const std::vector<uint16_t> &src, std::vector<uint16_t> &dst, int width, int height)
{
    constexpr int kBlock = 64;
    for (int x0 = 0; x0 < width; x0 += kBlock) {
        for (int y0 = 0; y0 < height; y0 += kBlock) {
            const int x1 = std::min(x0 + kBlock, width);
            const int y1 = std::min(y0 + kBlock, height);
            for (int x = x0; x < x1; ++x)
                for (int y = y0; y < y1; ++y)
                    dst[size_t(y) * width + x] = src[size_t(x) * height + y];
        }
    }
}

} // namespace

namespace {

// Templated on the sampling mode so the nearest-neighbor path (the
// parity-tested reference) keeps its exact codegen; <true> interpolates.
template <bool Bilinear>
std::vector<uint16_t> makeDistMapImpl(const View &view, const HeightMap &heightMap)
{
    const Vec3 refPoint = view.earth.lleToXyz(view.eye);
    const double localEarthRadius = refPoint.norm();
    const double fakeEarthRadius = localEarthRadius * view.refractionCoef;
    const std::vector<double> earthCurve =
        precomputeEarthCurve(fakeEarthRadius, view.distMaxM, view.distStepM);

    std::println("Earth radius is {:6.1f} km (refraction x{:4.2f})",
                 localEarthRadius / 1000.0, view.refractionCoef);
    std::println("Output size is {} x {} pixels", view.outWidth, view.outHeight);
    std::println("Output resolution is {} mrad per pixel or {} pixels per degree",
                 view.angularStepR * 1000.0, 1.0 / toDegrees(view.angularStepR));

    const int width = view.outWidth;
    const int height = view.outHeight;
    const int nDistSteps = view.distSteps();
    const double h0 = view.eye.ele;
    const double invAngularStep = 1.0 / view.angularStepR;

    // Each ray owns a contiguous column; transposed to row-major at the end.
    std::vector<uint16_t> colMajor(view.arraySize(), 0);

    // The exact geographic position of a ray sample (asin + atan2 + sqrt) is
    // evaluated only at checkpoints every kCheckpointM; heightmap grid
    // coordinates are linearly interpolated in between. The ray's ground
    // track is a great circle, so the sag of a chord of length s against the
    // arc is at most s^2/(8R), where s is the checkpoint spacing and R the
    // Earth radius: 5 km^2 / (8 * 6371 km) = 0.5 m, about 1/200 of a 90 m
    // heightmap cell. Since checkpoints are exact, the error never
    // accumulates along the ray. PANO_EXACT_RAYCAST restores the per-sample
    // transform for A/B verification (CMake option, ~3x slower).
    constexpr double kCheckpointM = 5000.0;

    const auto renderColumn = [&](int x) {
        uint16_t *column = &colMajor[size_t(x) * height];
        const double azimuth = view.azimuthMinR + x * view.angularStepR;
        const Vec3 direction = view.vNorth * std::cos(azimuth) + view.vEast * std::sin(azimuth);
        double elevation = view.elevationMinR;
        double sinElevation = std::sin(elevation);

        auto onHit = [&](int i, double terrainHeight) {
            const double dist = i * view.distStepM;
            const double newElevation = std::atan2(terrainHeight - h0, dist);
            const int yTop = std::max(int((view.elevationMaxR - newElevation) * invAngularStep), 0);
            const int yBot = std::min(int((view.elevationMaxR - elevation) * invAngularStep), height - 1);
            for (int y = yTop; y <= yBot; ++y)
                column[y] = uint16_t(i);
            elevation = newElevation;
            sinElevation = std::sin(elevation);
            return elevation >= view.elevationMaxR; // viewport top reached: ray done
        };

#ifdef PANO_EXACT_RAYCAST
        for (int i = 1; i < nDistSteps; ++i) {
            const double dist = i * view.distStepM;
            const PositionLLE lle = view.earth.xyzToLle(refPoint + dist * direction);
            const double raycastHeight = h0 + sinElevation * dist;
            double gx, gy;
            heightMap.gridCoords(lle.lat, lle.lon, gx, gy);
            const double sample = Bilinear ? heightMap.atGridBilinear(gx, gy)
                                           : double(heightMap.atGrid(gx, gy));
            const double terrainHeight = earthCurve[i] + sample;
            if (terrainHeight > raycastHeight && onHit(i, terrainHeight))
                break;
        }
#else
        const auto gridAt = [&](double dist, double &gx, double &gy) {
            const Vec3 p = refPoint + dist * direction;
            const double v = p.norm();
            heightMap.gridCoords(toDegrees(std::asin(p.z / v)),
                                 toDegrees(std::atan2(p.y, p.x)), gx, gy);
        };
        const int checkpointSamples = std::max(int(kCheckpointM / view.distStepM), 1);
        double gx0, gy0;
        gridAt(0.0, gx0, gy0);
        bool done = false;
        for (int i0 = 0; i0 < nDistSteps - 1 && !done; i0 += checkpointSamples) {
            const int i1 = std::min(i0 + checkpointSamples, nDistSteps - 1);
            double gx1, gy1;
            gridAt(i1 * view.distStepM, gx1, gy1);
            const double dgx = (gx1 - gx0) / (i1 - i0);
            const double dgy = (gy1 - gy0) / (i1 - i0);
            double gx = gx0, gy = gy0;
            for (int i = i0 + 1; i <= i1; ++i) {
                gx += dgx;
                gy += dgy;
                const double raycastHeight = h0 + sinElevation * (i * view.distStepM);
                const double sample = Bilinear ? heightMap.atGridBilinear(gx, gy)
                                               : double(heightMap.atGrid(gx, gy));
                const double terrainHeight = earthCurve[i] + sample;
                if (terrainHeight > raycastHeight && onHit(i, terrainHeight)) {
                    done = true;
                    break;
                }
            }
            gx0 = gx1;
            gy0 = gy1;
        }
#endif
    };
    parallelFor(0, width, 16, [&](int b, int e) {
        for (int x = b; x < e; ++x)
            renderColumn(x);
    });

    std::vector<uint16_t> output(view.arraySize());
    transpose(colMajor, output, width, height);
    return output;
}

} // namespace

std::vector<uint16_t> makeDistMap(const View &view, const HeightMap &heightMap)
{
    return view.bilinear ? makeDistMapImpl<true>(view, heightMap)
                         : makeDistMapImpl<false>(view, heightMap);
}

std::vector<uint8_t> extractOutlines(const View &view, const std::vector<uint16_t> &distMap)
{
    const int width = view.outWidth;
    const int height = view.outHeight;
    std::vector<uint8_t> result(view.arraySize(), 0);
    std::fill_n(result.begin(), width, uint8_t(255));

    parallelFor(1, height, [&](int rowBegin, int rowEnd) {
        for (int row = rowBegin; row < rowEnd; ++row) {
            for (int col = 0; col < width; ++col) {
                const int diff = std::abs(int(distMap[size_t(width) * (row - 1) + col]) -
                                          int(distMap[size_t(width) * row + col]));
                result[size_t(width) * row + col] = uint8_t(255 - std::min(diff, 255));
            }
        }
    });
    return result;
}

} // namespace pano
