#pragma once
// Viewport definition: observer position, angular window and ray parameters.

#include <stdexcept>

#include "geo.hpp"

namespace pano {

struct View {
    SphereEarth earth;
    PositionLLE eye;

    double azimuthMinR = 0.0;   // [rad], may go negative after wrap fix-up
    double azimuthMaxR = 0.0;
    double elevationMinR = 0.0; // [rad], angle above horizontal plane
    double elevationMaxR = 0.0;
    double angularStepR = 1e-4; // [rad/px]

    double distMaxM = 0.0;      // ray length limit [m]
    double distStepM = 50.0;    // ray sampling step [m]

    double refractionCoef = 1.0; // apparent Earth radius multiplier

    // Bilinear heightmap sampling: smooths the 90 m posts into slopes,
    // removing the staircase on near ridges. Off by default — nearest
    // sampling is the parity-tested reference the web app renders.
    bool bilinear = false;

    int outWidth = 0;
    int outHeight = 0;

    // Local tangent frame at the eye (unit vectors in ECEF).
    Vec3 vUp, vNorth, vEast;

    View(const SphereEarth &earthModel, const PositionLLE &eyePos,
         double azMinR, double azMaxR, double elMinR, double elMaxR,
         double angStepR, double distMax, double refraction,
         bool bilinearSampling = false)
        : earth(earthModel), eye(eyePos),
          azimuthMinR(azMinR), azimuthMaxR(azMaxR),
          elevationMinR(elMinR), elevationMaxR(elMaxR), angularStepR(angStepR),
          distMaxM(distMax), refractionCoef(refraction), bilinear(bilinearSampling)
    {
        if (azimuthMinR > azimuthMaxR)
            azimuthMinR -= 2.0 * kPi; // e.g. 350°..10° becomes -10°..10°
        if (azimuthMaxR - azimuthMinR > 2.0 * kPi)
            throw std::invalid_argument("Azimuth range exceeds 360 degrees");

        outWidth = int((azimuthMaxR - azimuthMinR) / angularStepR) + 2;
        // +1 covers the elevation span inclusively; the former +2 left a
        // bottom row below elevationMinR that no ray ever filled — a
        // permanent 1 px sky-colored line under the terrain.
        outHeight = int((elevationMaxR - elevationMinR) / angularStepR) + 1;

        const Vec3 refPoint = earth.lleToXyz(eye);
        const Vec3 vZ{0.0, 0.0, 1.0};
        vUp = refPoint.normalized();
        vEast = (-vUp).cross(vZ).normalized();
        vNorth = vEast.cross(-vUp).normalized();
    }

    size_t arraySize() const { return size_t(outWidth) * outHeight; }
    int distSteps() const { return int(distMaxM / distStepM) + 1; }
};

} // namespace pano
