#include "distmap.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <print>

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

std::vector<uint16_t> makeDistMap(const View &view, const HeightMap &heightMap)
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

    #pragma omp parallel for schedule(dynamic, 16)
    for (int x = 0; x < width; ++x) {
        uint16_t *column = &colMajor[size_t(x) * height];
        const double azimuth = view.azimuthMinR + x * view.angularStepR;
        const Vec3 direction = view.vNorth * std::cos(azimuth) + view.vEast * std::sin(azimuth);
        double elevation = view.elevationMinR;

        for (int i = 1; i < nDistSteps; ++i) {
            const double dist = i * view.distStepM;
            const Vec3 point = refPoint + dist * direction;
            const PositionLLE lle = view.earth.xyzToLle(point);
            const double raycastHeight = h0 + std::sin(elevation) * dist;
            const double terrainHeight = earthCurve[i] + heightMap.at(lle.lat, lle.lon);
            if (terrainHeight > raycastHeight) {
                const double newElevation = std::atan2(terrainHeight - h0, dist);
                const int yTop = std::max(int((view.elevationMaxR - newElevation) * invAngularStep), 0);
                const int yBot = std::min(int((view.elevationMaxR - elevation) * invAngularStep), height - 1);
                const auto value = uint16_t(dist / view.distStepM);
                for (int y = yTop; y <= yBot; ++y)
                    column[y] = value;
                elevation = newElevation;
                if (elevation >= view.elevationMaxR)
                    break; // terrain fills the viewport top; nothing farther can show
            }
        }
    }

    std::vector<uint16_t> output(view.arraySize());
    transpose(colMajor, output, width, height);
    return output;
}

std::vector<uint8_t> extractOutlines(const View &view, const std::vector<uint16_t> &distMap)
{
    const int width = view.outWidth;
    const int height = view.outHeight;
    std::vector<uint8_t> result(view.arraySize(), 0);
    std::fill_n(result.begin(), width, uint8_t(255));

    #pragma omp parallel for
    for (int row = 1; row < height; ++row) {
        for (int col = 0; col < width; ++col) {
            const int diff = std::abs(int(distMap[size_t(width) * (row - 1) + col]) -
                                      int(distMap[size_t(width) * row + col]));
            result[size_t(width) * row + col] = uint8_t(255 - std::min(diff, 255));
        }
    }
    return result;
}

} // namespace pano
