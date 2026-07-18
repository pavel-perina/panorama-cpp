#include "tonemap.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "common/colors.h"

namespace pano {

namespace {

color::OkLab lerpLab(const color::OkLab &a, const color::OkLab &b, float t)
{
    return {a.L + (b.L - a.L) * t, a.a + (b.a - a.a) * t, a.b + (b.b - a.b) * t};
}

std::array<uint8_t, 4> toPx(const color::OkLab &lab)
{
    const color::Rgb rgb = color::okLabToRgb(lab);
    return {uint8_t(rgb.r * 255.0f + 0.5f), uint8_t(rgb.g * 255.0f + 0.5f),
            uint8_t(rgb.b * 255.0f + 0.5f), 255};
}

} // namespace

std::vector<uint8_t> tonemapDistMap(const View &view,
                                    const std::vector<uint16_t> &distMap,
                                    double visibilityKm, Rgb8 terrain, Rgb8 sky,
                                    const Rgb8 *horizon)
{
    const color::OkLab terrainLab = color::okLabFromRgb(
        {terrain.r / 255.0f, terrain.g / 255.0f, terrain.b / 255.0f});
    const color::OkLab skyLab = color::okLabFromRgb(
        {sky.r / 255.0f, sky.g / 255.0f, sky.b / 255.0f});
    // Airlight at the horizon is nearly white; `sky` is the zenith color.
    // Distant terrain and low sky both converge on this band, so the far
    // ridges dissolve into the sky instead of silhouetting against it.
    // A time-of-day palette can override the band (sunset orange, night).
    const color::OkLab whiteLab = color::okLabFromRgb({1.0f, 1.0f, 1.0f});
    const color::OkLab horizonLab =
        horizon ? color::okLabFromRgb({horizon->r / 255.0f, horizon->g / 255.0f,
                                       horizon->b / 255.0f})
                : lerpLab(skyLab, whiteLab, 0.85f);

    // Color per distance value (index = distance in distStep units).
    const double k = 3.912 / (visibilityKm * 1000.0);
    std::vector<std::array<uint8_t, 4>> lut(size_t(view.distSteps()));
    for (size_t d = 0; d < lut.size(); ++d) {
        const float t = float(1.0 - std::exp(-k * double(d) * view.distStepM));
        lut[d] = toPx(lerpLab(terrainLab, horizonLab, t));
    }

    // Sky gradient per row: horizon white at elevation <= 0, zenith color at
    // the viewport top.
    const int width = view.outWidth, height = view.outHeight;
    std::vector<std::array<uint8_t, 4>> skyRow(static_cast<size_t>(height));
    for (int y = 0; y < height; ++y) {
        const double elev = view.elevationMaxR - y * view.angularStepR;
        const float t = float(std::clamp(elev / view.elevationMaxR, 0.0, 1.0));
        skyRow[y] = toPx(lerpLab(horizonLab, skyLab, t));
    }

    std::vector<uint8_t> rgba(distMap.size() * 4);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const size_t i = size_t(y) * width + x;
            const uint16_t d = distMap[i];
            const auto &px = d == 0 ? skyRow[y] : lut[d]; // 0 = sky
            std::copy(px.begin(), px.end(), &rgba[i * 4]);
        }
    }
    return rgba;
}

} // namespace pano
