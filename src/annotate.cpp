// renderAnnotations — desktop build only. OpenCV draws lines and writes the
// PNG; text is our SDF font (UTF-8, crisp at 45° — Hershey fonts were
// ASCII-only and mangled diacritics).

#include "summits.hpp"

#include <cmath>
#include <format>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "sdftext.hpp"

namespace pano {

namespace {

// Solarized-ish palette used by the Julia version (BGR order).
const cv::Scalar kLineColor(150, 148, 131);
const uint8_t kTextColor[3] = {210, 139, 38};
const cv::Scalar kHorizonColor(213, 232, 238);

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
    const cv::Mat gray(height, width, CV_8UC1, const_cast<uint8_t *>(outlines.data()));
    cv::Mat img;
    cv::cvtColor(gray, img, cv::COLOR_GRAY2BGR);

    constexpr double kLabelBaseY = 300.0; // labels start above this line, like pano.jl

    for (const VisibleSummit &summit : summits) {
        cv::line(img, cv::Point(summit.x, summit.y), cv::Point(summit.x, int(kLabelBaseY)),
                 kLineColor, 1, cv::LINE_AA);
        const std::string label = std::format("{} ({:.0f} km)", summit.name, summit.distanceM / 1000.0);
        font.drawText(img.data, width, height, 3, label,
                      double(summit.x) + 5.0, kLabelBaseY - 5.0, kLabelSizePx, 45.0, kTextColor);
    }

    // Azimuth ticks and degree labels.
    const int azMinD = int(std::ceil(toDegrees(view.azimuthMinR)));
    const int azMaxD = int(std::floor(toDegrees(view.azimuthMaxR)));
    for (int az = azMinD; az <= azMaxD; ++az) {
        const int x = int(std::lround((toRadians(double(az)) - view.azimuthMinR) / view.angularStepR));
        cv::line(img, {x, 38}, {x, 42}, kLineColor, 1, cv::LINE_AA);
        cv::line(img, {x, 63}, {x, 68}, kLineColor, 1, cv::LINE_AA);
        const std::string label = std::format("{}°", az >= 0 ? az : az + 360);
        font.drawText(img.data, width, height, 3, label,
                      x - font.textWidth(label, kTickSizePx) / 2.0, 58.0,
                      kTickSizePx, 0.0, kTextColor);
    }

    // Horizon line (elevation angle 0).
    const int horizonY = int(std::lround(view.elevationMaxR / view.angularStepR));
    cv::line(img, {0, horizonY}, {width - 1, horizonY}, kHorizonColor, 1, cv::LINE_AA);

    cv::imwrite(outputPath.string(), img);
}

} // namespace pano
