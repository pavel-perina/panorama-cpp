#pragma once
// Geodetic primitives: LLE<->ECEF on a spherical Earth model.
// Port of the GeoUtils sections of panorama-jl/pano.jl and panorama-rs/src/main.rs.

#include <cmath>
#include <numbers>

namespace pano {

constexpr double kPi = std::numbers::pi;

constexpr double toRadians(double deg) { return deg * (kPi / 180.0); }
constexpr double toDegrees(double rad) { return rad * (180.0 / kPi); }

struct Vec3 {
    double x = 0.0, y = 0.0, z = 0.0;

    Vec3 operator+(const Vec3 &o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3 &o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
    Vec3 operator-() const { return {-x, -y, -z}; }

    double dot(const Vec3 &o) const { return x * o.x + y * o.y + z * o.z; }
    double norm() const { return std::sqrt(dot(*this)); }

    Vec3 cross(const Vec3 &o) const
    {
        return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x};
    }

    Vec3 normalized() const
    {
        const double n = norm();
        return {x / n, y / n, z / n};
    }
};

inline Vec3 operator*(double s, const Vec3 &v) { return v * s; }

struct PositionLLE {
    double lat = 0.0; // latitude  [deg], +north
    double lon = 0.0; // longitude [deg], +east
    double ele = 0.0; // elevation [m] above model surface
};

// Spherical Earth. WGS84 ellipsoid can be added later behind the same interface
// (pano.jl has the formulas); for annotation purposes the sphere was sufficient.
class SphereEarth {
public:
    static constexpr double kRadius = 6378137.0; // [m], WGS84 semi-major axis

    Vec3 lleToXyz(const PositionLLE &p) const
    {
        const double phi = toRadians(p.lat);
        const double lambda = toRadians(p.lon);
        const double v = kRadius + p.ele;
        const double cosPhi = std::cos(phi);
        return {v * cosPhi * std::cos(lambda),
                v * cosPhi * std::sin(lambda),
                v * std::sin(phi)};
    }

    PositionLLE xyzToLle(const Vec3 &p) const
    {
        const double v = p.norm();
        return {toDegrees(std::asin(p.z / v)),
                toDegrees(std::atan2(p.y, p.x)),
                v - kRadius};
    }

    // Initial great-circle bearing from p1 to p2, degrees in [0, 360).
    // https://www.movable-type.co.uk/scripts/latlong.html
    double bearingDeg(const PositionLLE &p1, const PositionLLE &p2) const
    {
        const double phi1 = toRadians(p1.lat);
        const double phi2 = toRadians(p2.lat);
        const double dLambda = toRadians(p2.lon - p1.lon);
        const double y = std::sin(dLambda) * std::cos(phi2);
        const double x = std::cos(phi1) * std::sin(phi2) - std::sin(phi1) * std::cos(phi2) * std::cos(dLambda);
        const double theta = toDegrees(std::atan2(y, x));
        return theta >= 0.0 ? theta : theta + 360.0;
    }

    // Great-circle (haversine) distance in meters, ignoring elevation.
    double distance(const PositionLLE &p1, const PositionLLE &p2) const
    {
        const double lat1 = toRadians(p1.lat);
        const double lat2 = toRadians(p2.lat);
        const double sinDLat2 = std::sin((lat2 - lat1) * 0.5);
        const double sinDLon2 = std::sin(toRadians(p2.lon - p1.lon) * 0.5);
        const double a = sinDLat2 * sinDLat2 + std::cos(lat1) * std::cos(lat2) * sinDLon2 * sinDLon2;
        return 2.0 * std::asin(std::sqrt(a)) * kRadius;
    }
};

// Apparent vertical drop of a point at ground `distance` caused by Earth's
// curvature (negative, in meters). `radius` already includes the refraction
// scale factor.
inline double elevationDropAtDistance(double distance, double radius)
{
    return std::sqrt(radius * radius - distance * distance) - radius;
}

} // namespace pano
