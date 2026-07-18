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

// Matches the web overlay: near-black ink under a white halo (readable over
// any sky palette), stems as a translucent darkening rather than a wire.
constexpr uint8_t kTextColor[3] = {21, 37, 40};    // --bg / --ink on the web
constexpr uint8_t kHaloColor[3] = {255, 255, 255};
constexpr uint8_t kStemColor[3] = {30, 50, 60};    // blended at kStemAlpha
constexpr double kStemAlpha = 0.45;
constexpr uint8_t kTickColor[3] = {78, 81, 87};    // --border

} // namespace

void drawAnnotations(const View &view, uint8_t *rgb,
                     const std::vector<VisibleSummit> &summits,
                     const SdfFont &font, double labelSizePx)
{
    const double tickSizePx = labelSizePx * 13.0 / 16.0;
    const double haloPx = labelSizePx * 1.5 / 16.0; // scales with the text
    const int width = view.outWidth;
    const int height = view.outHeight;
    uint8_t *img = rgb;

    const auto blendPixel = [&](int x, int y, const uint8_t color[3], double a) {
        uint8_t *px = &img[(size_t(y) * width + x) * 3];
        for (int ch = 0; ch < 3; ++ch)
            px[ch] = uint8_t(px[ch] + (color[ch] - px[ch]) * a + 0.5);
    };
    const auto vLine = [&](int x, int y0, int y1, const uint8_t color[3],
                           double a = 1.0) {
        if (x < 0 || x >= width)
            return;
        for (int y = std::max(y0, 0); y <= std::min(y1, height - 1); ++y)
            blendPixel(x, y, color, a);
    };

    constexpr double kLabelBaseY = 300.0; // labels start above this line, like pano.jl

    // stems first, all texts after — a stem crossing a neighbor's label run
    // vanishes under its halo instead of striking it out (same as the web)
    for (const VisibleSummit &summit : summits)
        vLine(summit.x, std::min(summit.y, int(kLabelBaseY)),
              std::max(summit.y, int(kLabelBaseY)), kStemColor, kStemAlpha);
    for (const VisibleSummit &summit : summits) {
        const std::string label = std::format("{} ({:.0f} km)", summit.name, summit.distanceM / 1000.0);
        font.drawText(img, width, height, 3, label,
                      double(summit.x) + 5.0, kLabelBaseY - 5.0, labelSizePx, 45.0,
                      kTextColor, kHaloColor, haloPx);
    }

    // Azimuth ticks and degree labels.
    const int azMinD = int(std::ceil(toDegrees(view.azimuthMinR)));
    const int azMaxD = int(std::floor(toDegrees(view.azimuthMaxR)));
    for (int az = azMinD; az <= azMaxD; ++az) {
        const int x = int(std::lround((toRadians(double(az)) - view.azimuthMinR) / view.angularStepR));
        vLine(x, 38, 42, kTickColor);
        vLine(x, 63, 68, kTickColor);
        const std::string label = std::format("{}°", az >= 0 ? az : az + 360);
        font.drawText(img, width, height, 3, label,
                      x - font.textWidth(label, tickSizePx) / 2.0, 58.0,
                      tickSizePx, 0.0, kTextColor, kHaloColor, haloPx);
    }

    // Horizon line (elevation angle 0): darken the underlying pixels slightly
    // instead of painting a color — subtle against sky and terrain alike.
    const int horizonY = int(std::lround(view.elevationMaxR / view.angularStepR));
    if (horizonY >= 0 && horizonY < height)
        for (int x = 0; x < width; ++x) {
            uint8_t *px = &img[(size_t(horizonY) * width + x) * 3];
            for (int ch = 0; ch < 3; ++ch)
                px[ch] = uint8_t(px[ch] * 0.92f);
        }

}

void renderAnnotations(const View &view,
                       const std::vector<uint8_t> &outlines,
                       const std::vector<VisibleSummit> &summits,
                       const SdfFont &font,
                       const std::filesystem::path &outputPath)
{
    std::vector<uint8_t> img(size_t(view.outWidth) * view.outHeight * 3);
    for (size_t i = 0; i < outlines.size(); ++i)
        img[i * 3] = img[i * 3 + 1] = img[i * 3 + 2] = outlines[i];
    drawAnnotations(view, img.data(), summits, font);
    writePng(outputPath, view.outWidth, view.outHeight, 3, 8, img.data());
}

} // namespace pano
