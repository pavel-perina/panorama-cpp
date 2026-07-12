#include "summits.hpp"

#include <cmath>
#include <fstream>
#include <print>
#include <sstream>
#include <stdexcept>
#include <string>

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

} // namespace

std::vector<Summit> parseSummitsTsv(std::string_view tsv)
{
    std::vector<Summit> summits;
    bool header = true;
    for (size_t lineStart = 0; lineStart < tsv.size();) {
        const size_t lineEnd = std::min(tsv.find('\n', lineStart), tsv.size());
        std::string_view line = tsv.substr(lineStart, lineEnd - lineStart);
        lineStart = lineEnd + 1;
        if (!line.empty() && line.back() == '\r')
            line.remove_suffix(1);
        if (header) { // skip "Summit" Elevation Latitude Longitude
            header = false;
            continue;
        }
        if (line.empty())
            continue;
        std::vector<std::string_view> fields;
        for (size_t pos = 0; pos <= line.size();) {
            const size_t tab = std::min(line.find('\t', pos), line.size());
            fields.push_back(line.substr(pos, tab - pos));
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
    std::println("Parsed {} summits", summits.size());
    return summits;
}

std::vector<Summit> loadSummitsTsv(const std::filesystem::path &path)
{
    std::ifstream file(path);
    if (!file)
        throw std::runtime_error("Cannot open summit database " + path.string());
    std::ostringstream content;
    content << file.rdbuf();
    return parseSummitsTsv(content.str());
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

} // namespace pano
