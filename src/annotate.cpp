// OpenCV implementation of renderAnnotations — desktop build only.

#include "summits.hpp"

#include <cmath>
#include <format>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

namespace pano {

namespace {

// Solarized-ish palette used by the Julia version (BGR order).
const cv::Scalar kLineColor(150, 148, 131);
const cv::Scalar kTextColor(210, 139, 38);
const cv::Scalar kHorizonColor(213, 232, 238);

// OpenCV's putText cannot rotate text, so render the label into a mask,
// warp it and paint the masked pixels. anchor = bottom-left of the text
// baseline in image coordinates, angle counterclockwise.
void drawRotatedText(cv::Mat &img, const std::string &text, cv::Point2d anchor,
                     double angleDeg, const cv::Scalar &color, double fontScale)
{
    const int font = cv::FONT_HERSHEY_SIMPLEX;
    const int thickness = 1;
    int baseline = 0;
    const cv::Size ts = cv::getTextSize(text, font, fontScale, thickness, &baseline);

    cv::Mat mask = cv::Mat::zeros(ts.height + baseline + 2, ts.width + 2, CV_8U);
    const cv::Point2d origin(1.0, ts.height + 1.0); // baseline start inside the patch
    cv::putText(mask, text, cv::Point(origin), font, fontScale, 255, thickness, cv::LINE_AA);

    // Affine map: rotate around the baseline start, then move it to `anchor`.
    const double a = angleDeg * kPi / 180.0;
    const double c = std::cos(a), s = std::sin(a);
    cv::Mat m = (cv::Mat_<double>(2, 3)
                 << c, s, anchor.x - c * origin.x - s * origin.y,
                    -s, c, anchor.y + s * origin.x - c * origin.y);
    cv::Mat warped = cv::Mat::zeros(img.size(), CV_8U);
    cv::warpAffine(mask, warped, m, img.size(), cv::INTER_LINEAR, cv::BORDER_CONSTANT);
    img.setTo(color, warped > 127);
}

} // namespace

void renderAnnotations(const View &view,
                       const std::vector<uint8_t> &outlines,
                       const std::vector<VisibleSummit> &summits,
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
        drawRotatedText(img, label, {double(summit.x) + 5.0, kLabelBaseY - 5.0}, 45.0, kTextColor, 0.5);
    }

    // Azimuth ticks and degree labels.
    const int azMinD = int(std::ceil(toDegrees(view.azimuthMinR)));
    const int azMaxD = int(std::floor(toDegrees(view.azimuthMaxR)));
    for (int az = azMinD; az <= azMaxD; ++az) {
        const int x = int(std::lround((toRadians(double(az)) - view.azimuthMinR) / view.angularStepR));
        cv::line(img, {x, 38}, {x, 42}, kLineColor, 1, cv::LINE_AA);
        cv::line(img, {x, 63}, {x, 68}, kLineColor, 1, cv::LINE_AA);
        const std::string label = std::format("{}", az >= 0 ? az : az + 360);
        const cv::Size ts = cv::getTextSize(label, cv::FONT_HERSHEY_SIMPLEX, 0.5, 1, nullptr);
        cv::putText(img, label, {x - ts.width / 2, 58}, cv::FONT_HERSHEY_SIMPLEX, 0.5,
                    kTextColor, 1, cv::LINE_AA);
    }

    // Horizon line (elevation angle 0).
    const int horizonY = int(std::lround(view.elevationMaxR / view.angularStepR));
    cv::line(img, {0, horizonY}, {width - 1, horizonY}, kHorizonColor, 1, cv::LINE_AA);

    cv::imwrite(outputPath.string(), img);
}

} // namespace pano
