#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Precompute the time-of-day palette table: sun elevation -> 3 colors.

The tonemap is fully controlled by three colors (terrain ink, sky at the
horizon, sky above), so a day/sunset/night cycle is just those three as a
function of sun elevation. This script computes them from a spectral
single-scattering atmosphere (Rayleigh + Mie + ozone Chappuis band — the
ozone is what keeps the twilight zenith blue) and writes
web/sky-palette.json for the JS side, plus an ANSI preview to the
terminal. Legibility clamps in OKLab keep night renders readable
(the Pokémon Go trick: dark, never black).

Companion: scripts/render_sunset_anim.py renders panorama frames through
the table via the native CLI (-fg/-bg/-hz).
"""

import json
import math
from pathlib import Path

import numpy as np

# --- geometry & atmosphere ---------------------------------------------------

RG = 6360e3            # ground radius [m]
RT = 6460e3            # atmosphere top
OBSERVER_H = 600.0     # Vysočina-ish viewpoint altitude [m]

H_RAYLEIGH = 8000.0    # density scale heights [m]
H_MIE = 1200.0
BETA_MIE_S = 2.1e-6    # Mie scattering at sea level [1/m] (clear-ish air)
BETA_MIE_ABS = 0.1 * BETA_MIE_S
MIE_G = 0.76           # Henyey-Greenstein anisotropy

OZONE_CENTER = 25e3    # tent profile [m]
OZONE_HALFWIDTH = 15e3
BETA_OZONE_PEAK = 1.9e-6   # extinction at layer center, Chappuis peak [1/m]

WL = np.arange(400.0, 701.0, 20.0)          # nm, 16 bands
DWL = 20.0

BETA_RAYLEIGH = 33.1e-6 * (440.0 / WL) ** 4          # [1/m] sea level
# Chappuis band: broad absorption around 600 nm (yes, ozone absorbs *red*,
# which is why the high twilight sky stays blue instead of graying out).
SIGMA_OZONE = BETA_OZONE_PEAK * np.exp(-0.5 * ((WL - 602.0) / 65.0) ** 2)

# Sun: Planck 5778 K, normalized at 550 nm.
def _planck(wl_nm):
    wl = wl_nm * 1e-9
    h, c, k, t = 6.626e-34, 2.998e8, 1.381e-23, 5778.0
    return (1.0 / wl**5) / (np.exp(h * c / (wl * k * t)) - 1.0)

SUN = _planck(WL) / _planck(np.array([550.0]))

# --- CIE 1931 color matching (Wyman et al. 2013 gaussian fits) ---------------

def _g(x, mu, s1, s2):
    s = np.where(x < mu, s1, s2)
    return np.exp(-0.5 * ((x - mu) / s) ** 2)

CMF_X = 1.056 * _g(WL, 599.8, 37.9, 31.0) + 0.362 * _g(WL, 442.0, 16.0, 26.7) \
        - 0.065 * _g(WL, 501.1, 20.4, 26.2)
CMF_Y = 0.821 * _g(WL, 568.8, 46.9, 40.5) + 0.286 * _g(WL, 530.9, 16.3, 31.1)
CMF_Z = 1.217 * _g(WL, 437.0, 11.8, 36.0) + 0.681 * _g(WL, 459.0, 26.0, 13.8)

XYZ_TO_SRGB = np.array([[3.2406, -1.5372, -0.4986],
                        [-0.9689, 1.8758, 0.0415],
                        [0.0557, -0.2040, 1.0570]])


def spectrum_to_linear_srgb(spec):
    xyz = np.array([np.sum(spec * CMF_X), np.sum(spec * CMF_Y),
                    np.sum(spec * CMF_Z)]) * DWL
    return XYZ_TO_SRGB @ xyz


# --- single scattering -------------------------------------------------------

def densities(h):
    """Relative densities (rayleigh, mie, ozone) at altitude h [m]."""
    h = max(h, 0.0)
    return (math.exp(-h / H_RAYLEIGH), math.exp(-h / H_MIE),
            max(0.0, 1.0 - abs(h - OZONE_CENTER) / OZONE_HALFWIDTH))


def ray_exit(pos, d, radius):
    """Distance to the sphere |x|=radius along d, or None if missed."""
    b = np.dot(pos, d)
    disc = b * b - (np.dot(pos, pos) - radius * radius)
    if disc < 0.0:
        return None
    root = math.sqrt(disc)
    t = -b + root                       # far intersection (we start inside RT)
    tn = -b - root                      # near intersection (for ground hits)
    if radius < np.linalg.norm(pos):    # target sphere below us -> near hit
        return tn if tn > 0.0 else None
    return t if t > 0.0 else None


def optical_depth(pos, d, samples=64):
    """tau(lambda) along d to the atmosphere top; inf if the ray hits ground."""
    if ray_exit(pos, d, RG) is not None:
        return np.full_like(WL, np.inf)
    t_max = ray_exit(pos, d, RT)
    dt = t_max / samples
    tau = np.zeros_like(WL)
    for i in range(samples):
        p = pos + d * ((i + 0.5) * dt)
        h = np.linalg.norm(p) - RG
        rho_r, rho_m, rho_o = densities(h)
        tau += (BETA_RAYLEIGH * rho_r + (BETA_MIE_S + BETA_MIE_ABS) * rho_m
                + SIGMA_OZONE * rho_o) * dt
    return tau


def sky_radiance(view_ele_deg, sun_azi_off_deg, sun_ele_deg, samples=196):
    """Spectral radiance of the sky in the given view direction."""
    ev, phi, es = (math.radians(view_ele_deg), math.radians(sun_azi_off_deg),
                   math.radians(sun_ele_deg))
    pos0 = np.array([0.0, 0.0, RG + OBSERVER_H])
    v = np.array([math.cos(ev) * math.cos(phi), math.cos(ev) * math.sin(phi),
                  math.sin(ev)])
    s = np.array([math.cos(es), 0.0, math.sin(es)])
    cos_th = float(np.dot(v, s))
    phase_r = 3.0 / (16.0 * math.pi) * (1.0 + cos_th * cos_th)
    g = MIE_G
    phase_m = (1.0 - g * g) / (4.0 * math.pi
                               * (1.0 + g * g - 2.0 * g * cos_th) ** 1.5)

    t_max = ray_exit(pos0, v, RT)
    dt = t_max / samples
    tau_view = np.zeros_like(WL)
    radiance = np.zeros_like(WL)
    for i in range(samples):
        p = pos0 + v * ((i + 0.5) * dt)
        h = np.linalg.norm(p) - RG
        rho_r, rho_m, rho_o = densities(h)
        ext = (BETA_RAYLEIGH * rho_r + (BETA_MIE_S + BETA_MIE_ABS) * rho_m
               + SIGMA_OZONE * rho_o)
        tau_view += ext * (0.5 * dt)          # to segment midpoint
        tau_sun = optical_depth(p, s)
        scatter = BETA_RAYLEIGH * rho_r * phase_r + BETA_MIE_S * rho_m * phase_m
        radiance += SUN * np.exp(-(tau_view + tau_sun)) * scatter * dt
        tau_view += ext * (0.5 * dt)          # rest of the segment
    return radiance


def sun_ground_transmittance(sun_ele_deg):
    """Direct sun transmittance at the observer (0 below the horizon)."""
    es = math.radians(sun_ele_deg)
    pos0 = np.array([0.0, 0.0, RG + OBSERVER_H])
    s = np.array([math.cos(es), 0.0, math.sin(es)])
    tau = optical_depth(pos0, s)
    return np.exp(-tau) if np.all(np.isfinite(tau)) else np.zeros_like(WL)


# --- OKLab (Ottosson reference, matches src/common/colors.cpp) ---------------

def srgb_to_oklab(rgb):
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
           for c in rgb]
    l = 0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]
    m = 0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]
    s = 0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]
    l, m, s = l ** (1 / 3), m ** (1 / 3), s ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def oklab_to_srgb(lab):
    L, a, b = lab
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    return [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
            for c in (max(0.0, min(1.0, c)) for c in lin)]


def hex_of(rgb):
    return "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in rgb)


# --- palette table -----------------------------------------------------------

SUN_ELEVATIONS = [-18, -15, -12, -9, -6, -4, -2, -1, 0, 1, 2, 4, 6, 10, 15, 20, 25]
VIEW_HORIZON = 1.0     # deg — just above the horizon line
VIEW_SKY = 35.0        # deg — the "sky above" slab
SUN_AZI_OFF = 35.0     # deg from the sun's azimuth: sunward glow, off the disc

DAY_TERRAIN = (50 / 255, 65 / 255, 0 / 255)   # current default ink (day look)


def tone(linear, exposure):
    """Linear radiance -> display sRGB: exposure, soft shoulder, gamma."""
    x = np.clip(linear * exposure, 0.0, None)
    x = 1.0 - np.exp(-x)                       # filmic-ish soft clip
    return [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
            for c in x]


def main():
    # Exposure anchor: full-day horizon should land near-white but not clipped.
    day_horizon = spectrum_to_linear_srgb(sky_radiance(VIEW_HORIZON, SUN_AZI_OFF, 25))
    exposure = 1.9 / day_horizon[1]            # green ~ luminance proxy

    def lum(spec):
        return float(np.sum(spec * CMF_Y)) * DWL

    rows = []
    for es in SUN_ELEVATIONS:
        hor_spec = sky_radiance(VIEW_HORIZON, SUN_AZI_OFF, es)
        sky_spec = sky_radiance(VIEW_SKY, SUN_AZI_OFF, es)
        horizon = tone(spectrum_to_linear_srgb(hor_spec), exposure)
        sky = tone(spectrum_to_linear_srgb(sky_spec), exposure)

        # Terrain ink: day albedo, lightness driven by ground illumination.
        # SUN is treated as irradiance throughout, so direct = E*T*sin(es)
        # and ambient = pi * mean sky radiance are on the same scale —
        # at sunset (direct 0) the ambient keeps the landscape visibly lit,
        # as in reality (civil twilight is bright).
        direct = lum(sun_ground_transmittance(es) * SUN) \
            * max(0.0, math.sin(math.radians(es)))
        ambient = math.pi * 0.5 * (lum(hor_spec) + lum(sky_spec))
        rows.append({"es": es, "horizon": horizon, "sky": sky,
                     "illum": direct + ambient})
    day_illum = max(r["illum"] for r in rows)

    tL, ta, tb = srgb_to_oklab(DAY_TERRAIN)
    out = []
    for r in rows:
        hL, ha, hb = srgb_to_oklab(r["horizon"])
        sL, sa, sb = srgb_to_oklab(r["sky"])

        # Legibility clamps (dark, never black; horizon stays the bright band).
        sL = max(sL, 0.13)
        hL = max(hL, sL + 0.04, 0.20)

        # Flat exponent, not 1/3: single scattering misses the multiply-
        # scattered twilight ambient (real sunset is EV ~12 vs noon ~15,
        # our linear ratio says far less), and the eye dark-adapts anyway.
        f = max(0.0, min(1.0, r["illum"] / day_illum)) ** 0.2
        terrL = max(0.10, min(tL * f, hL - 0.12))
        chroma = 0.3 + 0.7 * f                 # night desaturates the ink
        terrain = oklab_to_srgb((terrL, ta * chroma, tb * chroma))

        out.append({"sunEle": r["es"],
                    "terrain": hex_of(terrain),
                    "horizon": hex_of(oklab_to_srgb((hL, ha, hb))),
                    "sky": hex_of(oklab_to_srgb((sL, sa, sb)))})

    dst = Path(__file__).resolve().parent.parent / "web" / "sky-palette.json"
    dst.write_text(json.dumps(
        {"model": "single-scattering Rayleigh+Mie+ozone, sun azimuth offset "
                  f"{SUN_AZI_OFF} deg, OKLab legibility clamps",
         "columns": ["terrain", "horizon", "sky"],
         "rows": out}, indent=1) + "\n")
    print(f"wrote {dst} ({len(out)} rows)\n")

    def swatch(hexcol):
        r, g, b = (int(hexcol[i:i + 2], 16) for i in (0, 2, 4))
        return f"\x1b[48;2;{r};{g};{b}m      \x1b[0m"

    print("sun ele   terrain  horizon  sky")
    for row in out:
        print(f"  {row['sunEle']:+4d}°   {swatch(row['terrain'])} "
              f"{swatch(row['horizon'])} {swatch(row['sky'])}   "
              f"{row['terrain']} {row['horizon']} {row['sky']}")


if __name__ == "__main__":
    main()
