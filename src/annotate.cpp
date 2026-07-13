// renderAnnotations — desktop build only. All lines here are axis-aligned
// (label stems, ticks, horizon), so plain pixel runs suffice; text is the
// SDF font (UTF-8, crisp at 45°); output via our zlib PNG writer.

#include "summits.hpp"

#include <cmath>
#include <format>

#include "pngwrite.hpp"
#include "sdftext.hpp"

namespace pano {

namespace {

// Solarized-ish palette used by the Julia version.
constexpr uint8_t kLineColor[3] = {131, 148, 150};
constexpr uint8_t kTextColor[3] = {38, 139, 210};
constexpr uint8_t kHorizonColor[3] = {238, 232, 213};

constexpr double kLabelSizePx = 16.0; // matches the web app's label font size
constexpr double kTickSizePx = 13.0;

} // namespace

void renderAnnotations(const View &view,
                       const std::vector<uint8_t> &outlines,
                       const std::vector<VisibleSummit> &summits,
                       const SdfFont &font,
                       const std::filesystem::path &outputPath)
{
    const int width = view.outWidth;
    const int height = view.outHeight;
    std::vector<uint8_t> img(size_t(width) * height * 3);
    for (size_t i = 0; i < outlines.size(); ++i)
        img[i * 3] = img[i * 3 + 1] = img[i * 3 + 2] = outlines[i];

    const auto setPixel = [&](int x, int y, const uint8_t color[3]) {
        uint8_t *px = &img[(size_t(y) * width + x) * 3];
        px[0] = color[0], px[1] = color[1], px[2] = color[2];
    };
    const auto vLine = [&](int x, int y0, int y1, const uint8_t color[3]) {
        if (x < 0 || x >= width)
            return;
        for (int y = std::max(y0, 0); y <= std::min(y1, height - 1); ++y)
            setPixel(x, y, color);
    };

    constexpr double kLabelBaseY = 300.0; // labels start above this line, like pano.jl

    for (const VisibleSummit &summit : summits) {
        vLine(summit.x, std::min(summit.y, int(kLabelBaseY)),
              std::max(summit.y, int(kLabelBaseY)), kLineColor);
        const std::string label = std::format("{} ({:.0f} km)", summit.name, summit.distanceM / 1000.0);
        font.drawText(img.data(), width, height, 3, label,
                      double(summit.x) + 5.0, kLabelBaseY - 5.0, kLabelSizePx, 45.0, kTextColor);
    }

    // Azimuth ticks and degree labels.
    const int azMinD = int(std::ceil(toDegrees(view.azimuthMinR)));
    const int azMaxD = int(std::floor(toDegrees(view.azimuthMaxR)));
    for (int az = azMinD; az <= azMaxD; ++az) {
        const int x = int(std::lround((toRadians(double(az)) - view.azimuthMinR) / view.angularStepR));
        vLine(x, 38, 42, kLineColor);
        vLine(x, 63, 68, kLineColor);
        const std::string label = std::format("{}°", az >= 0 ? az : az + 360);
        font.drawText(img.data(), width, height, 3, label,
                      x - font.textWidth(label, kTickSizePx) / 2.0, 58.0,
                      kTickSizePx, 0.0, kTextColor);
    }

    // Horizon line (elevation angle 0).
    const int horizonY = int(std::lround(view.elevationMaxR / view.angularStepR));
    if (horizonY >= 0 && horizonY < height)
        for (int x = 0; x < width; ++x)
            setPixel(x, horizonY, kHorizonColor);

    writePng(outputPath, width, height, 3, 8, img.data());
}

} // namespace pano
