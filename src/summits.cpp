#include "summits.hpp"

#include <cmath>
#include <format>
#include <fstream>
#include <print>
#include <stdexcept>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

namespace pano {

namespace {

// True when any distance-map sample in a (2r+1)^2 neighborhood matches
// `value` within `tolerance` (distances in distStep units).
bool testPixel(const View &view, const std::vector<uint16_t> &distMap,
               int x, int y, int radius, uint16_t value, uint16_t tolerance)
{
    if (x < radius + 1 || y < radius + 1 ||
        x + radius >= view.outWidth || y + radius >= view.outHeight)
        return false;
    for (int row = y - radius; row <= y + radius; ++row) {
        for (int col = x - radius; col <= x + radius; ++col) {
            const int mapValue = distMap[size_t(row) * view.outWidth + col];
            if (std::abs(mapValue - int(value)) <= int(tolerance))
                return true;
        }
    }
    return false;
}

// Strips optional surrounding double quotes.
std::string_view unquote(std::string_view s)
{
    if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
        return s.substr(1, s.size() - 2);
    return s;
}

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

std::vector<Summit> loadSummitsTsv(const std::filesystem::path &path)
{
    std::ifstream file(path);
    if (!file)
        throw std::runtime_error("Cannot open summit database " + path.string());

    std::vector<Summit> summits;
    std::string line;
    bool header = true;
    while (std::getline(file, line)) {
        if (header) { // skip "Summit" Elevation Latitude Longitude
            header = false;
            continue;
        }
        if (line.empty())
            continue;
        std::vector<std::string_view> fields;
        const std::string_view sv(line);
        for (size_t pos = 0; pos <= sv.size();) {
            const size_t tab = std::min(sv.find('\t', pos), sv.size());
            fields.push_back(sv.substr(pos, tab - pos));
            pos = tab + 1;
        }
        if (fields.size() < 4)
            continue;
        Summit s;
        s.name = unquote(fields[0]);
        s.lle.ele = std::stod(std::string(fields[1]));
        s.lle.lat = std::stod(std::string(fields[2]));
        s.lle.lon = std::stod(std::string(fields[3]));
        summits.push_back(std::move(s));
    }
    std::println("Loaded {} summits from {}", summits.size(), path.string());
    return summits;
}

std::vector<VisibleSummit> findVisibleSummits(const View &view,
                                              const std::vector<uint16_t> &distMap,
                                              const std::vector<Summit> &summits)
{
    const Vec3 refPoint = view.earth.lleToXyz(view.eye);
    const double fakeEarthRadius = refPoint.norm() * view.refractionCoef;

    std::vector<VisibleSummit> visible;
    for (const Summit &summit : summits) {
        const double distanceM = view.earth.distance(view.eye, summit.lle);
        if (distanceM > view.distMaxM || distanceM < 4.0 * view.distStepM)
            continue;
        double azimuthR = toRadians(view.earth.bearingDeg(view.eye, summit.lle));
        if (azimuthR > view.azimuthMaxR)
            azimuthR -= 2.0 * kPi; // handle windows spanning north (negative azimuthMin)
        if (azimuthR < view.azimuthMinR)
            continue;
        // Apparent height above the observer, curvature + refraction included.
        const double h = summit.lle.ele + elevationDropAtDistance(distanceM, fakeEarthRadius) - view.eye.ele;
        const double elevationR = std::atan2(h, distanceM);
        const int x = int(std::lround((azimuthR - view.azimuthMinR) / view.angularStepR));
        const int y = int(std::lround((view.elevationMaxR - elevationR) / view.angularStepR));
        if (!testPixel(view, distMap, x, y, 4, uint16_t(distanceM / view.distStepM), 5))
            continue;
        std::println("{:>25} is visible at azimuth {:6.2f}°, distance {:6.2f} km",
                     summit.name, toDegrees(azimuthR) < 0.0 ? toDegrees(azimuthR) + 360.0 : toDegrees(azimuthR),
                     distanceM / 1000.0);
        visible.push_back({summit.name, distanceM, x, y});
    }
    std::println("Visible summits: {}", visible.size());
    return visible;
}

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
