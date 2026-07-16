#pragma once
// Aerial-perspective tonemap of a rendered distance map — shared by the
// native CLI and the WASM build so both produce identical pixels.

#include <cstdint>
#include <vector>

#include "view.hpp"

namespace pano {

// 0-255 channel values (int to mirror the WASM C ABI exactly).
struct Rgb8 {
    int r = 0, g = 0, b = 0;
};

// Terrain fades into the sky with distance (Koschmieder contrast decay,
// V = visibilityKm), interpolated in OkLab so the perceptual fade is
// uniform. distMap: 0 = sky, else distance in view.distStepM units.
// Returns view.outWidth * outHeight RGBA pixels.
std::vector<uint8_t> tonemapDistMap(const View &view,
                                    const std::vector<uint16_t> &distMap,
                                    double visibilityKm, Rgb8 terrain, Rgb8 sky);

} // namespace pano
