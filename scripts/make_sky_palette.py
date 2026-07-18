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
BETA_MIE_S = 4.2e-6    # Mie scattering at sea level [1/m] (clear-ish air)
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

# The single-scattering model is credible for sun above about -6 deg; the
# real sky below that (blue hour, night) is multiple scattering we don't
# compute, so the table dives from the -6 deg dusk straight to one fixed
# night anchor at -12 deg (dark blue, not grey — cameras and eyes both
# agree twilight-to-night is blue) and stays flat below. High sun barely
# changes anything, so the day side is sparse.
MODEL_ELEVATIONS = [-6, -4, -2, -1, 0, 1, 2, 4, 6, 10, 15, 20, 30, 45, 60]
# Deliberately fake-bright night (visibility beats realism on a screen):
# the -12 anchor keeps the blue hue but sits far above physical darkness,
# and interpolation from the -6 dusk inherits the boost.
NIGHT_SKY_LAB = (0.30, -0.012, -0.055)
NIGHT_HORIZON_LAB = (0.40, -0.008, -0.045)
VIEW_HORIZON = 1.0     # deg — just above the horizon line
VIEW_SKY = 35.0        # deg — the "sky above" slab
SUN_AZI_OFF = 35.0     # deg from the sun's azimuth: sunward glow, off the disc

DAY_TERRAIN = (50 / 255, 65 / 255, 0 / 255)   # current default ink (day look)

# Eye adaptation: display exposure slides with scene luminance^ADAPT.
# 0 = fixed exposure (night is physically, uselessly dark on a screen),
# 1 = full adaptation (night looks like day). Surfaces then render at
# illum^(1-ADAPT) — incomplete adaptation is what keeps night *looking*
# dark while staying inside the screen's ~2 usable orders of magnitude.
# The gain cap bounds the slide (~5 EV, the eye's evening range): without
# it, deep-twilight residual glow gets amplified 10^4x into a fictional
# bright amber horizon at -15 deg.
ADAPT = 0.8
MAX_GAIN = 32.0

# Pastel ceiling: cap OKLab chroma so the sunset band lands salmon/amber
# instead of maximum-saturation mustard (real skies and good wallpaper
# art both sit well below sRGB's yellow corner).
MAX_CHROMA = 0.11


def tone(linear, exposure):
    """Linear radiance -> display sRGB: exposure, soft shoulder, gamma.

    The shoulder compresses *luminance* and scales RGB uniformly — a
    per-channel soft clip collapses sunset hues to yellow (r and g both
    saturate toward 1 while b sits clipped at 0)."""
    x = np.clip(linear * exposure, 0.0, None)
    y = max(1e-9, 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2])
    x = x * ((1.0 - math.exp(-y)) / y)
    return [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
            for c in np.clip(x, 0.0, 1.0)]


def main():
    # Exposure anchor: full-day horizon should land near-white but not clipped.
    day_horizon = spectrum_to_linear_srgb(sky_radiance(VIEW_HORIZON, SUN_AZI_OFF, 25))
    exposure = 1.9 / day_horizon[1]            # green ~ luminance proxy

    def lum(spec):
        return float(np.sum(spec * CMF_Y)) * DWL

    rows = []
    for es in MODEL_ELEVATIONS:
        hor_spec = sky_radiance(VIEW_HORIZON, SUN_AZI_OFF, es)
        sky_spec = sky_radiance(VIEW_SKY, SUN_AZI_OFF, es)

        # Ground illumination: SUN is treated as irradiance throughout, so
        # direct = E*T*sin(es) and ambient = pi * mean sky radiance are on
        # the same scale — at sunset (direct 0) the ambient keeps the
        # landscape visibly lit, as in reality (civil twilight is bright).
        direct = lum(sun_ground_transmittance(es) * SUN) \
            * max(0.0, math.sin(math.radians(es)))
        ambient = math.pi * 0.5 * (lum(hor_spec) + lum(sky_spec))
        rows.append({"es": es, "hor_spec": hor_spec, "sky_spec": sky_spec,
                     "adapt_lum": 0.5 * (lum(hor_spec) + lum(sky_spec)),
                     "illum": direct + ambient})
    day_illum = max(r["illum"] for r in rows)
    day_adapt = max(r["adapt_lum"] for r in rows)

    for r in rows:
        # Sliding exposure: partial dark adaptation to the scene's own
        # brightness. Deep night radiance is exactly 0 in this model (the
        # whole atmosphere sits in Earth's shadow) — floor the adaptation
        # luminance and let the OKLab clamps own that regime.
        la = max(r["adapt_lum"], day_adapt * 1e-9)
        ex = exposure * min((day_adapt / la) ** ADAPT, MAX_GAIN)
        r["horizon"] = tone(spectrum_to_linear_srgb(r["hor_spec"]), ex)
        r["sky"] = tone(spectrum_to_linear_srgb(r["sky_spec"]), ex)

    def cap_chroma(L, a, b):
        c = math.hypot(a, b)
        if c > MAX_CHROMA:
            a, b = a * MAX_CHROMA / c, b * MAX_CHROMA / c
        return L, a, b

    tL, ta, tb = srgb_to_oklab(DAY_TERRAIN)
    out = []
    for r in rows:
        hL, ha, hb = cap_chroma(*srgb_to_oklab(r["horizon"]))
        sL, sa, sb = cap_chroma(*srgb_to_oklab(r["sky"]))

        # Legibility clamps (dark, never black; horizon stays the bright band).
        sL = max(sL, 0.13)
        hL = max(hL, sL + 0.04, 0.20)

        # Surfaces under partial adaptation: displayed lightness tracks
        # illumination^(1-ADAPT) (full adaptation would cancel it entirely).
        f = max(0.0, min(1.0, r["illum"] / day_illum)) ** (1.0 - ADAPT)
        terrL = max(0.10, min(tL * f, hL - 0.12))
        chroma = 0.3 + 0.7 * f                 # night desaturates the ink
        terrain = oklab_to_srgb((terrL, ta * chroma, tb * chroma))

        out.append({"sunEle": r["es"],
                    "terrain": hex_of(terrain),
                    "horizon": hex_of(oklab_to_srgb((hL, ha, hb))),
                    "sky": hex_of(oklab_to_srgb((sL, sa, sb)))})

    # Night anchor below the model's trust range: interpolation carries
    # the -6 deg dusk into night by -12; consumers clamp below that.
    night_terrain = hex_of(oklab_to_srgb((0.20, ta * 0.3, tb * 0.3)))
    out.insert(0, {"sunEle": -12,
                   "terrain": night_terrain,
                   "horizon": hex_of(oklab_to_srgb(NIGHT_HORIZON_LAB)),
                   "sky": hex_of(oklab_to_srgb(NIGHT_SKY_LAB))})

    dst = Path(__file__).resolve().parent.parent / "web" / "sky-palette.json"
    dst.write_text(json.dumps(
        {"model": "single-scattering Rayleigh+Mie+ozone for sun >= -6 deg, "
                  f"sun azimuth offset {SUN_AZI_OFF} deg, OKLab legibility "
                  "clamps; fixed dark-blue night rows below",
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

    # Continuous gradient strips (slime_mold test_palettes style): sun
    # elevation on the x-axis, OKLab interpolation between table rows —
    # what the app would actually show through a day.
    def at(key, es):
        lo = max((r for r in out if r["sunEle"] <= es), key=lambda r: r["sunEle"])
        hi = min((r for r in out if r["sunEle"] >= es), key=lambda r: r["sunEle"])
        t = 0.0 if lo is hi else (es - lo["sunEle"]) / (hi["sunEle"] - lo["sunEle"])
        a = srgb_to_oklab(tuple(int(lo[key][i:i + 2], 16) / 255 for i in (0, 2, 4)))
        b = srgb_to_oklab(tuple(int(hi[key][i:i + 2], 16) / 255 for i in (0, 2, 4)))
        return oklab_to_srgb(tuple(x + (y - x) * t for x, y in zip(a, b)))

    lo_es, hi_es = out[0]["sunEle"], out[-1]["sunEle"]
    steps = [lo_es + i for i in range(int(hi_es - lo_es) + 1)]
    print()
    for key in ("sky", "horizon", "terrain"):
        strip = ""
        for es in steps:
            r, g, b = (round(c * 255) for c in at(key, es))
            strip += f"\x1b[38;2;{r};{g};{b}m█\x1b[0m"
        print(f"{key:>8}  {strip}")
    axis = [" "] * len(steps)
    for tick in range(int(lo_es), int(hi_es) + 1, 6):
        col = int(tick - lo_es)
        for j, ch in enumerate(f"{tick:+d}" if tick else "0"):
            if col + j < len(axis):
                axis[col + j] = ch
    print(f"{'sun ele':>8}  {''.join(axis)}")


if __name__ == "__main__":
    main()
