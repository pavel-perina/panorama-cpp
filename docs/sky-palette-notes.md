# A sky that knows what time it is — three colors at a time

Notes on the time-of-day palette (2026-07): how a terrain panorama
renderer got a day/sunset/night cycle out of a 16-row lookup table, what
physics went into it, and what got cheerfully faked. Written blog-style
because the dead ends are the interesting part.

## The constraint that made it easy

The renderer's aerial-perspective tonemap is controlled by exactly three
colors: **terrain ink** (near silhouettes), **horizon airlight** (what
distant ridges dissolve into, Koschmieder contrast decay in OKLab), and
**sky above** (the zenith end of the sky gradient). That's the whole
visual identity of a frame.

So "realistic sky through the day" doesn't need a sky simulation in the
app at all — it needs those three colors *as a function of sun
elevation*. A Python script can compute them offline; the app looks up
and interpolates. The table that fell out is 16 rows, ~600 bytes.
Pokémon Go's day/night cycle was the existence proof (a monster-catching
game with correct lunar phase — someone there got bored in the best
way); Bruneton-style precomputed atmospheric scattering is the same idea
taken to 4D lookup textures. Three colors per sunset is a much better
deal when your sky is a two-stop gradient.

## The model (the honest part)

`scripts/make_sky_palette.py` integrates spectral single scattering
along a view ray through a spherical atmosphere:

- **Rayleigh** scattering, `β ∝ λ⁻⁴`, 8 km scale height — the blue.
- **Mie** (aerosol) scattering, Henyey–Greenstein `g = 0.76`, 1.2 km
  scale height — haze and the sunward glow.
- **Ozone**, Chappuis band approximated as a Gaussian around 602 nm,
  tent profile at 25 km. Ozone absorbs *red* light — it is the reason
  the high twilight sky stays blue instead of graying out. Without it
  the whole dusk goes brown.
- 16 wavelength bands, 400–700 nm; CIE 1931 color matching via the
  Wyman et al. Gaussian fits; sun as a 5778 K Planck spectrum.

Sampling: the horizon color at +1° elevation, the sky color at +35°,
both at 35° azimuth away from the sun — close enough to catch the
sunset glow, far enough to miss the solar disc. Sun transmittance along
each sample's path to the sun, with a hard Earth-shadow test, is what
makes twilight happen at all.

That model is trusted for sun elevation **≥ −6°** and not one degree
lower — see "what we faked."

## Iterations (the instructive part)

Each of these looked reasonable until rendered as a panorama strip.

**1. Fixed exposure.** Anchor exposure so the day horizon is
near-white, keep it constant. Result: physically correct and useless —
contrast died at sunset −0.7° and civil twilight was black. A camera on
manual exposure, not an eye.

**2. The unit bug.** Terrain lightness mixed direct sun and sky ambient
in incompatible units, so ambient rounded to zero and the landscape went
black *at* sunset (reality: civil twilight is bright). Fix: treat the
sun spectrum as irradiance throughout, so `direct = E·T·sin(h)` and
`ambient = π·L̄_sky` are on one scale.

**3. Unbounded adaptation.** Slide exposure with scene luminance^0.8,
like the eye. Result at −15°: a *bright amber horizon band* — the
model's faint residual glow amplified 10⁴×. Real eyes slide about 5 EV
over an evening, so the gain got capped at 32×. Two constants
(`ADAPT = 0.8`, `MAX_GAIN = 32`) are the entire adaptation model, and
the surface-lightness exponent `illum^(1−ADAPT)` falls out of the same
theory instead of being a magic 0.2.

**4. The mustard problem.** With adaptation fixed, the sunset band was
maximum-saturation yellow (`f6d000`, blue channel exactly 0). Two
causes, both display-side, neither atmospheric: the per-channel
soft-clip `1−e⁻ˣ` pushes red *and* green toward 1 while blue sits
clipped — collapsing orange into yellow — and nothing bounded chroma.
Fix: compress **luminance** and scale RGB uniformly (hue-preserving
shoulder), plus an OKLab chroma cap of 0.11. A reference sunrise
artwork sampled at `#dfb1a3` / `#8976a4` / `#3e3875` confirmed the
target: real skies and good wallpaper art are both *pastel*.
Doubling the Mie coefficient, the "obvious" fix, moved almost nothing —
the tone curve was the culprit.

**5. Webcam calibration.** Checking real webcams showed two model
limits: an hour before sunrise the sky is deep *blue* (ozone-filtered
multiple scattering — single scattering yields ~zero there), and in
haze the brightest band lifts off the horizon with a brown aerosol
layer under it. The first shaped the night rows below; the second is
future work (visibility as a second table axis — the palette turns out
to depend on the visibility slider, which the tonemap already knows).

## What we faked, explicitly

- **Night is hand-authored.** Below −6° the single-scattering output is
  not credible (multiple scattering dominates and we don't compute it),
  so the table jumps to one fixed row at −12°: fake-bright blue
  (`1b2e4a` sky, `394861` horizon), flat below. Deliberately brighter
  than physics: a screen has ~2 usable orders of magnitude and a night
  panorama you can't see is a bug, not realism. OKLab interpolation
  between the −6° amber dusk and the −12° blue night produces the
  brown-blue bridge for free, and it looks right.
- **Adaptation is a display decision**, not physics: exponent 0.8,
  capped at 5 EV. Webcams "see" more at night because they auto-expose
  past that cap; we choose not to.
- **Chroma cap 0.11** — an aesthetic ceiling, tuned against art, not
  measured sky.
- **No azimuth dependence.** One horizon color for all directions; the
  real sunset is orange only around the sun, blue-gray opposite, pink
  antisolar arch. Within the app's ~5° elevation strip a single sunward
  average reads correctly; salmon-pink (the antisolar register) is
  structurally out of reach until the horizon color depends on
  |azimuth − sun azimuth|.
- **Terrain ink is albedo-times-illumination**, hue fixed, chroma
  fading at night — no attempt at sunset-lit faces vs shadowed slopes.

## Wiring

`make_sky_palette.py` writes `web/sky-palette.json` and prints the
table as ANSI swatches plus continuous gradient strips (sun elevation on
the x-axis) — a palette tweak is judged in the terminal in ~10 s without
rendering anything. `render_sunset_anim.py` renders real panorama frames
through the native CLI (`-fg/-bg/-hz`) and builds a labeled contact
sheet; the no-args default sweeps the table rows +60°…−12°.

In the app the table is hardcoded into `app.js` (pasted from the JSON —
resist the urge to fetch it; it changes once a season), interpolated in
OKLab at the live sun elevation, behind the 🌇 toggle (`sky=1`). Cached
sectors re-render when the baked-in sun elevation drifts more than 1° —
invisible at noon, one palette row around sunset. The default (toggle
off) palette is the table's +30° row, so "plain daylight" and the
dynamic sky share one source of truth. The native CLI keeps the original
palette as defaults: it is the bit-parity reference pinned by the
`test-node.mjs` tonemap hash, and reference palettes should not follow
fashion.

## Lessons learned

1. **Parametrize first, simulate second.** Three colors was the right
   interface; everything else stayed swappable behind it.
2. **Terminal swatches beat renders for iteration speed** — 8 s to
   judge a palette, 16 s for the full contact sheet when it matters.
   No ImGui lab needed at this knob count (4).
3. **The display pipeline lies more than the atmosphere.** Two of the
   worst artifacts (mustard sunset, black twilight) were tone-curve and
   unit bugs, not missing physics.
4. **Fake boldly, but label it.** The night rows say "hand-tuned" in
   the script; the trust boundary (−6°) is a named constant, not a
   vibe.
5. **Single scattering earns its keep only above the horizon.** For
   twilight it needs multiple scattering (Bruneton) — or two honest
   hardcoded rows, which cost 40 bytes.
