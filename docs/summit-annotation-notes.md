# Summit annotation: how it works, why peaks are missing

Notes from the Kamenice viewpoint experiment (49.6013°N 16.1647°E, 780 m,
azimuth 0–60°), 2026-07-12.

## Pipeline (`findVisibleSummits`, src/summits.cpp)

For each summit in `data/summits.tsv`:

1. **Distance filter** — haversine distance to eye; reject if > `distMaxM`.
2. **Azimuth filter** — great-circle initial bearing; reject if outside the
   azimuth window.
3. **Predicted pixel** — x from bearing, y from elevation angle
   `atan2(ele + curvatureDrop(d, R·refraction) − eyeEle, d)`.
4. **Visibility test** (`testPixel`) — scan a 9×9 px neighborhood of the
   predicted pixel in the distance map; the summit counts as visible if any
   sample matches its distance within ±5 distance steps (±250 m).

A summit hidden behind a nearer ridge fails step 4 *by design*: the distance
map at its predicted pixel holds the nearer ridge's distance, which is far
outside the ±250 m tolerance.

## Diagnosis of the Kamenice run

76 summits passed the distance+azimuth filters. Classification of the
distance-map neighborhood at each predicted pixel:

| outcome | count | meaning |
|---|---|---|
| found (annotated) | 33 | matching distance within 9×9 px |
| obscured by nearer ridge | 43 | map median much *closer* than summit (e.g. Smrk 94 km behind ~59 km terrain; Studniční vrch 102 km behind ~69 km) |
| near miss (match within 30 px) | 0 | would indicate position/height error |
| sky at pixel | 0 | would indicate database position error |

So the visibility check is not failing — the second-row Jeseníky/Krkonoše
peaks really are behind the front ridge from this low (780 m) viewpoint.
From Praděd (1510 m) far more summits clear the foreground, which is why that
scene felt more complete.

Why the annotated set skews to 60–95 km here: that band *is* the visible
horizon (Orlické hory / Jeseníky main ridge). Closer summits are mostly
missing from the database rather than failing the test — the CZ list only
contains prominence ≥ 100 m hills, so most silhouette bumps of the rolling
Vysočina foreground have no entry at all.

## Possible improvements

- Distinguish "obscured" from "not found" in the output (map value ≪ summit
  distance ⇒ obscured; ≈ sky/garbage ⇒ data error). Cheap, useful for
  debugging a scene.
- Optionally annotate obscured summits differently (dashed line / gray label)
  instead of dropping them.
- Snap summit elevation to the SRTM heightmap (or local max within a few
  cells) instead of trusting the database `ele`; reduces vertical prediction
  error for close summits, where a 30 m error is many pixels.
- Scale the 9×9 search radius with 1/distance: a fixed ~200 m database
  position error spans ~20 px at 10 km but only ~1 px at 200 km.
- Fill the near field from OSM with a lower prominence threshold
  (`scripts/download_osm_summits.py` takes a bbox; filtering by prominence
  would need a different source).

## Refraction and aerial perspective (off-topic observations)

**Refraction mismatch at 60–90 km.** `refractionCoef = 1.18` was tuned
against a photo taken during temperature inversion (strong near-ground
refraction, extreme visibility). A typical summer day with convective mixing
has a *steeper* temperature lapse near the ground → weaker refraction,
k ≈ 1.10–1.14, so real distant ridges sit lower (and horizon nearer) than
the 1.18 render predicts. The error grows roughly with distance², so it is
invisible at 20 km and noticeable at 60–90 km. Worth making the coefficient a
CLI parameter and bracketing a scene with 1.13 / 1.18 renders.

**Why 80–90 km ridges blend into a flat blue profile.** Koschmieder contrast
decay: apparent contrast C(d) = C₀·exp(−3.912·d/V) where V is meteorological
visibility. With a good summer V ≈ 100 km, a ridge at 85 km retains ~4%
contrast against the sky — right at the eye's detection threshold, hence a 2D
silhouette. A hill 10 km in front of that background differs from it by only
~1–2% luminance (indistinguishable); 30 km of separation gives ~2× the
contrast of the far ridge — visible as "slightly darker", exactly as
observed. In winter inversions V can exceed 200 km, which is why the same
ridges then show depth.

Since the renderer already produces per-pixel distance, simulating this is
one blend away: `pixel = lerp(terrainShade, skyColor, 1 − exp(−3.912·d/V))`
with V as a parameter — would make renders directly comparable to photos and
predict which ridges are distinguishable on a given day.
