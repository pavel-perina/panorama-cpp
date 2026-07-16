#include "tonemap.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include "common/colors.h"

namespace pano {

std::vector<uint8_t> tonemapDistMap(const View &view,
                                    const std::vector<uint16_t> &distMap,
                                    double visibilityKm, Rgb8 terrain, Rgb8 sky)
{
    const color::OkLab terrainLab = color::okLabFromRgb(
        {terrain.r / 255.0f, terrain.g / 255.0f, terrain.b / 255.0f});
    const color::OkLab skyLab = color::okLabFromRgb(
        {sky.r / 255.0f, sky.g / 255.0f, sky.b / 255.0f});

    // Color per distance value (index = distance in distStep units).
    const double k = 3.912 / (visibilityKm * 1000.0);
    std::vector<std::array<uint8_t, 4>> lut(size_t(view.distSteps()));
    for (size_t d = 0; d < lut.size(); ++d) {
        const float t = float(1.0 - std::exp(-k * double(d) * view.distStepM));
        const color::Rgb rgb =
            color::okLabToRgb({terrainLab.L + (skyLab.L - terrainLab.L) * t,
                               terrainLab.a + (skyLab.a - terrainLab.a) * t,
                               terrainLab.b + (skyLab.b - terrainLab.b) * t});
        lut[d] = {uint8_t(rgb.r * 255.0f + 0.5f), uint8_t(rgb.g * 255.0f + 0.5f),
                  uint8_t(rgb.b * 255.0f + 0.5f), 255};
    }
    const std::array<uint8_t, 4> skyPx{uint8_t(sky.r), uint8_t(sky.g),
                                       uint8_t(sky.b), 255};

    std::vector<uint8_t> rgba(distMap.size() * 4);
    for (size_t i = 0; i < distMap.size(); ++i) {
        const uint16_t d = distMap[i];
        const auto &px = d == 0 ? skyPx : lut[d]; // 0 = sky
        std::copy(px.begin(), px.end(), &rgba[i * 4]);
    }
    return rgba;
}

} // namespace pano
