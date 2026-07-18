// WASM renderer in the browser. JS owns all I/O: fetches tiles + summit
// TSV, calls the WASM module, draws on canvas. Overlay layers: summit
// labels, azimuth ruler, sun marker + today's sunrise/set times (NOAA
// solar position, flat-horizon times). Pan by drag/arrows, zoom by
// wheel/pinch; visibility and refraction sliders re-render (render distance
// is capped at 1.2x visibility — beyond that terrain is <2% contrast, i.e.
// indistinguishable from sky, so the cap is lossless and ~halves the cost).
//
// The view scrolls over a virtual 360° strip built from twelve 30° sectors,
// each rendered on demand into its own offscreen canvas and LRU-cached
// (a single 360° canvas would exceed iOS Safari's canvas-area budget).
// Compass follow and the direction buttons only move the viewport; a render
// happens only when an uncached sector scrolls into view, and idle time
// prefetches the neighbor sector in the direction of travel.
//
// Scene state lives in URL params (shareable):
//   ?lat=&lon=&dh=&az=&ele=&dist=&vis=&decl=&sky=  (decl: magnetic declination
//   in degrees, added to compass headings, ~+5 in Central Europe 2026;
//   sky=1: 🌇 time-of-day palette follows the sun)
"use strict";

// Defaults: Kamenice lookout, view centered az 30° (matches src/main.cpp).
const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);
const SCENE = {
  eye: {
    lat: num("lat", 49.6013028),
    lon: num("lon", 16.1646667),
    // absolute override; otherwise heightmap 3x3 max + dh after tiles load.
    // The no-params default keeps the native scene's hardcoded 780 m.
    ele: num("ele", params.has("lat") ? NaN : 780.0),
  },
  eyeAboveM: num("dh", 5.0),
  azCenterDeg: ((num("az", 30.0) % 360) + 360) % 360,
  elMinRad: -0.0560, elMaxRad: 0.0339,
  stepRad: 0.0001,
  distMaxM: num("dist", 250) * 1000, // tile fetch radius + render distance cap
  declDeg: num("decl", 0.0),
};

const DEG_PER_PX = SCENE.stepRad * 180 / Math.PI;
const STRIP_W = 360 / DEG_PER_PX;      // virtual strip width, px (float)
const SECTOR_DEG = 30;
const SECTOR_PX = SECTOR_DEG / DEG_PER_PX;
const MAX_SECTORS = 6;                 // LRU cap: ~28 MP of canvases, iOS-safe
let stripH =                           // exact value confirmed from api.height()
  Math.floor((SCENE.elMaxRad - SCENE.elMinRad) / SCENE.stepRad) + 1;

// Integer-degree tile range covering distMaxM around the eye.
function tileRange() {
  const km = SCENE.distMaxM / 1000;
  const dLat = km / 111.2;
  const dLon = km / (111.2 * Math.cos(SCENE.eye.lat * Math.PI / 180));
  return {
    minLat: Math.floor(SCENE.eye.lat - dLat),
    maxLat: Math.floor(SCENE.eye.lat + dLat),
    minLon: Math.floor(SCENE.eye.lon - dLon),
    maxLon: Math.floor(SCENE.eye.lon + dLon),
  };
}

// Distance from the eye to the nearest point of a 1x1° tile, km. Rays stop
// at distMax, so tiles entirely beyond it can be skipped without changing a
// pixel — the bounding square of tiles becomes a disc (~20% fewer fetches).
// Conservative: uses the highest-|lat| cosine so distance is underestimated.
function tileNearestKm(lat, lon) {
  const clat = Math.min(Math.max(SCENE.eye.lat, lat), lat + 1);
  const clon = Math.min(Math.max(SCENE.eye.lon, lon), lon + 1);
  const cosLat = Math.cos(Math.max(Math.abs(SCENE.eye.lat), Math.abs(clat)) * Math.PI / 180);
  const dy = (clat - SCENE.eye.lat) * 111.2;
  const dx = (clon - SCENE.eye.lon) * 111.2 * cosLat;
  return Math.hypot(dx, dy);
}

// SRTM tile name from its floored SW corner: lat -34, lon -71 -> S34W071.
function tileName(lat, lon) {
  return (lat < 0 ? "S" : "N") + String(Math.abs(lat)).padStart(2, "0") +
         (lon < 0 ? "W" : "E") + String(Math.abs(lon)).padStart(3, "0") + ".hgt";
}

const DATA_URL = "../data";
const DIST_STEP_M = 50.0; // one distance-map unit

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const status = (msg) => { document.getElementById("status").textContent = msg; };

// Module state (set by main).
let api = null, wasm = null, tsvCache = "", ready = false;

// Viewport over the virtual strip: offsets are strip coordinates of the
// viewport's top-left corner; offsetX wraps modulo STRIP_W.
let offsetX = 0, offsetY = 0;
let zoom = 1.0;
let lastDir = 1; // last horizontal scroll direction (prefetch hint)

// Sector cache: index 0-11 -> {canvas, summits (sector-local x), stamp}.
const sectors = new Map();
let stamp = 0;
const mod12 = (k) => ((k % 12) + 12) % 12;

// Unwrapped sector numbers covering the viewport (k*30° may exceed 360;
// mod12(k) is the cache index, k keeps the layout math wrap-free).
function visibleKs() {
  const k0 = Math.floor(offsetX / SECTOR_PX);
  const k1 = Math.floor((offsetX + viewW / zoom) / SECTOR_PX);
  const ks = [];
  for (let k = k0; k <= k1; ++k) ks.push(k);
  return ks;
}

function visKm() { return Number(document.getElementById("vis").value); }

function clampZoom(z) {
  const vh = window.innerHeight - document.getElementById("bar").offsetHeight;
  // min: fit height, but never force stretching past 100% on tall screens
  const min = Math.min(1, vh / stripH);
  return Math.max(min, Math.min(6, z));
}

// --- time-of-day palette (terrain ink, horizon airlight, sky above) --------
// Generated by scripts/make_sky_palette.py (web/sky-palette.json) and pasted
// here by hand — re-run the script and copy the rows to update. Single-
// scattering Rayleigh+Mie+ozone model for sun >= -6°; the -12° row is a
// hand-tuned fake-bright blue night, flat below. Lerp between rows in OKLab.
const SKY_PALETTE = [
  { sunEle: -12, terrain: "14180b", horizon: "394861", sky: "1b2e4a" },
  { sunEle: -6, terrain: "020400", horizon: "a67028", sky: "1f252d" },
  { sunEle: -4, terrain: "020500", horizon: "eab66c", sky: "636c7b" },
  { sunEle: -2, terrain: "050900", horizon: "ebbc6e", sky: "868a93" },
  { sunEle: -1, terrain: "070d00", horizon: "ecc171", sky: "8c9196" },
  { sunEle: 0, terrain: "0a1100", horizon: "edcb77", sky: "8c9295" },
  { sunEle: 1, terrain: "0d1500", horizon: "f0d47f", sky: "889397" },
  { sunEle: 2, terrain: "101800", horizon: "f4db85", sky: "84949a" },
  { sunEle: 4, terrain: "151e00", horizon: "fbe48d", sky: "8095a2" },
  { sunEle: 6, terrain: "182200", horizon: "ffe893", sky: "7e95a8" },
  { sunEle: 10, terrain: "1d2900", horizon: "feecb1", sky: "7d97b2" },
  { sunEle: 15, terrain: "222e00", horizon: "f9eec3", sky: "7f99ba" },
  { sunEle: 20, terrain: "253200", horizon: "f5eecc", sky: "819bc1" },
  { sunEle: 30, terrain: "2a3800", horizon: "f1eed7", sky: "86a1cb" },
  { sunEle: 45, terrain: "2f3e00", horizon: "eceddd", sky: "8ba7d5" },
  { sunEle: 60, terrain: "324100", horizon: "e9ebdf", sky: "8ca9da" },
];

let skyMode = params.get("sky") === "1"; // 🌇 toggle: palette follows the sun

const hexRgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));

// OKLab (Ottosson reference, same coefficients as src/common/colors.cpp).
function rgbToOklab([r, g, b]) {
  const f = (c) => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [f(r), f(g), f(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const g = (c) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return [g(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          g(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          g(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
}

// Palette at a sun elevation: OKLab lerp between bracketing table rows,
// clamped to the table range.
function paletteAt(eleDeg) {
  const rows = SKY_PALETTE;
  let lo = rows[0], hi = rows[rows.length - 1];
  for (const r of rows) {
    if (r.sunEle <= eleDeg && r.sunEle > lo.sunEle) lo = r;
    if (r.sunEle >= eleDeg && r.sunEle < hi.sunEle) hi = r;
  }
  if (lo.sunEle >= hi.sunEle) return mapColors(lo, (c) => hexRgb(c));
  const t = (eleDeg - lo.sunEle) / (hi.sunEle - lo.sunEle);
  return mapColors(lo, (c, key) => {
    const a = rgbToOklab(hexRgb(c)), b = rgbToOklab(hexRgb(hi[key]));
    return oklabToRgb(a.map((v, i) => v + (b[i] - v) * t));
  });
}

const mapColors = (row, fn) => ({
  terrain: fn(row.terrain, "terrain"),
  horizon: fn(row.horizon, "horizon"),
  sky: fn(row.sky, "sky"),
});

// Colors for the next sector render: fixed daylight (+30° row) by default,
// live sun elevation in 🌇 mode.
function currentPalette() {
  return paletteAt(skyMode
    ? sunPosition(new Date(), SCENE.eye.lat, SCENE.eye.lon).eleDeg : 30);
}

let viewW = 0, viewH = 0; // viewport size in CSS px (backing store is ×dpr)

// --- sun position (NOAA solar calculator terms, ported from the
// pico_weather_station sun_calc snippets; geometric elevation, no
// atmospheric refraction — matters < 0.6° and only at the horizon) --------

const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;

// Sun declination [deg] and equation of time [min] for a Julian century.
function sunDeclEot(jc) {
  const meanLong = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const meanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const eqOfCtr =
      Math.sin(toRad(meanAnom)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(toRad(2 * meanAnom)) * (0.019993 - 0.000101 * jc)
    + Math.sin(toRad(3 * meanAnom)) * 0.000289;
  const appLong = meanLong + eqOfCtr
    - 0.00569 - 0.00478 * Math.sin(toRad(125.04 - 1934.136 * jc));
  const obliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(toRad(125.04 - 1934.136 * jc));
  const decl = toDeg(Math.asin(Math.sin(toRad(obliq)) * Math.sin(toRad(appLong))));
  const y = Math.tan(toRad(obliq / 2)) ** 2;
  const eot = 4 * toDeg(
      y * Math.sin(2 * toRad(meanLong))
    - 2 * eccent * Math.sin(toRad(meanAnom))
    + 4 * eccent * y * Math.sin(toRad(meanAnom)) * Math.cos(2 * toRad(meanLong))
    - 0.5 * y * y * Math.sin(4 * toRad(meanLong))
    - 1.25 * eccent * eccent * Math.sin(2 * toRad(meanAnom)));
  return { decl, eot };
}

const julianCentury = (date) =>
  (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525.0;

// Sun azimuth (0° = N, clockwise) and geometric elevation, degrees.
function sunPosition(date, lat, lon) {
  const { decl, eot } = sunDeclEot(julianCentury(date));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMin = (utcMin + eot + 4 * lon + 1440) % 1440;
  const ha = trueSolarMin / 4 - 180; // hour angle, deg; < 0 before solar noon
  const sinEle = Math.sin(toRad(lat)) * Math.sin(toRad(decl))
    + Math.cos(toRad(lat)) * Math.cos(toRad(decl)) * Math.cos(toRad(ha));
  const cosAz = Math.max(-1, Math.min(1,
    (Math.sin(toRad(decl)) - Math.sin(toRad(lat)) * sinEle)
      / (Math.cos(toRad(lat)) * Math.cos(Math.asin(sinEle)))));
  const az = toDeg(Math.acos(cosAz));
  return { azDeg: ha > 0 ? 360 - az : az, eleDeg: toDeg(Math.asin(sinEle)) };
}

// Times when the sun center crosses `eleDeg` on the UTC day of `date`
// (flat horizon), or null if it never does — e.g. no astronomical night
// (-18°) in a Czech midsummer, polar day/night. The terrain-corrected
// version needs the silhouette (ideas.md).
function sunCrossings(date, lat, lon, eleDeg) {
  const dayUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const { decl, eot } = sunDeclEot(julianCentury(new Date(dayUtc + 43200000)));
  const cosHa = (Math.sin(toRad(eleDeg)) - Math.sin(toRad(lat)) * Math.sin(toRad(decl)))
    / (Math.cos(toRad(lat)) * Math.cos(toRad(decl)));
  if (cosHa < -1 || cosHa > 1) return null;
  const haDeg = toDeg(Math.acos(cosHa));
  const noonMin = 720 - 4 * lon - eot; // solar noon, minutes UTC
  return { rise: new Date(dayUtc + (noonMin - haDeg * 4) * 60000),
           set: new Date(dayUtc + (noonMin + haDeg * 4) * 60000) };
}

// Sunrise/sunset: sun center at -0.833° (standard refraction + solar radius).
const sunEvents = (date, lat, lon) => sunCrossings(date, lat, lon, -0.833);

function draw() {
  viewW = window.innerWidth;
  viewH = window.innerHeight - document.getElementById("bar").offsetHeight;
  // HiDPI / OS display scaling: back the canvas with physical pixels and
  // keep all drawing code in CSS px via the transform — text rasterizes
  // natively instead of being upscaled (blurry at 125% scaling), 1 px
  // lines stay 1 device-px-ish.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  zoom = clampZoom(zoom);
  offsetX = ((offsetX % STRIP_W) + STRIP_W) % STRIP_W;
  offsetY = Math.max(0, Math.min(offsetY, stripH - viewH / zoom));

  // crisp pixels only when the effective scale is an integer; otherwise
  // smoothing avoids uneven pixel blocks (e.g. zoom 1 at 125% scaling)
  ctx.imageSmoothingEnabled = zoom < 1 || (zoom * dpr) % 1 !== 0;
  // page background; the sky placeholder is painted only under sectors that
  // are still missing — painting it under drawn ones leaks a light 1 px
  // line through the antialiased bottom edge of the terrain image
  ctx.fillStyle = "#002b36";
  ctx.fillRect(0, 0, viewW, viewH);
  // never sample past the strip bottom: a source rect that overshoots the
  // sector canvas blends in transparent pixels
  const srcH = Math.min(viewH / zoom, stripH - offsetY);
  const stripBottom = Math.min(viewH, (stripH - offsetY) * zoom);
  let missing = false;
  for (const k of visibleKs()) {
    const s = sectors.get(mod12(k));
    const x0 = (k * SECTOR_PX - offsetX) * zoom;
    if (!s) {
      const sky = currentPalette().sky;
      ctx.fillStyle = `rgb(${sky[0]},${sky[1]},${sky[2]})`;
      ctx.fillRect(Math.max(0, x0), 0,
                   Math.min(viewW, x0 + SECTOR_PX * zoom + 1) - Math.max(0, x0),
                   stripBottom);
      missing = true;
      continue;
    }
    s.stamp = ++stamp;
    ctx.drawImage(s.canvas,
                  offsetX - k * SECTOR_PX, offsetY, viewW / zoom, srcH,
                  0, 0, viewW, srcH * zoom);
  }
  drawOverlay();
  if (missing && ready) pump();
  scheduleUrlSync();
}

// Labels + vector layer as a screen-space overlay, redrawn every frame:
// geometry anchored in strip coordinates, style in screen pixels — lines
// stay 1 px and text stays 14 px at any zoom.
function drawOverlay() {
  const toY = (y) => (y - offsetY) * zoom;
  const c = ctx;
  c.font = "14px Inter, sans-serif";
  c.lineWidth = 1;
  c.textAlign = "left";

  // Summit labels anchored to their own silhouette point, most prominent
  // first. All labels share the -45° rotation, so collisions live in the
  // rotated frame: p = x + y is the coordinate perpendicular to the text
  // run, u = x - y the coordinate along it — two labels collide when their
  // p bands are close AND their u intervals overlap. A colliding label is
  // lifted up its stem (new p band) until it fits; stems grow only where
  // it is actually crowded.
  const cand = [];
  for (const k of visibleKs()) {
    const s = sectors.get(mod12(k));
    if (!s) continue;
    for (const p of s.summits) {
      const x = (k * SECTOR_PX + p.x - offsetX) * zoom;
      if (x < -40 || x > viewW + 40) continue;
      cand.push({ ...p, sx: x });
    }
  }
  cand.sort((a, b) => b.prom - a.prom);
  const placed = []; // {p, u0, u1} of accepted labels, rotated coords
  const labels = []; // accepted placements for the two draw passes
  for (const s of cand) {
    const text = `${s.name} (${Math.round(s.distanceM / 1000)} km)`;
    const len = c.measureText(text).width + 12;
    const anchorY = toY(s.y);
    let labelY = null;
    for (let lift = 18; lift <= 158; lift += 20) {
      const y = anchorY - lift;
      if (y < 44) break; // keep clear of the azimuth ruler
      const p = s.sx + y;
      const u0 = s.sx - y, u1 = u0 + len * 1.42; // len px along the -45° run
      if (!placed.some((o) => Math.abs(o.p - p) < 26 && u0 < o.u1 && o.u0 < u1)) {
        labelY = y;
        placed.push({ p, u0, u1 });
        break;
      }
    }
    if (labelY !== null) labels.push({ sx: s.sx, anchorY, labelY, text });
  }
  // two passes: stems first, texts (with halo) on top — a stem crossing a
  // neighbor's text run disappears under its halo instead of striking it out
  c.strokeStyle = "rgba(30, 50, 60, 0.45)";
  for (const l of labels) {
    c.beginPath();
    c.moveTo(Math.round(l.sx) + 0.5, l.anchorY);
    c.lineTo(Math.round(l.sx) + 0.5, l.labelY);
    c.stroke();
  }
  for (const l of labels) {
    c.save();
    c.translate(l.sx + 4, l.labelY - 3);
    c.rotate(-Math.PI / 4);
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255, 255, 255, 0.75)"; // halo: readable over terrain
    c.strokeText(l.text, 0, 0);
    c.fillStyle = "#0b4d7a";
    c.fillText(l.text, 0, 0);
    c.restore();
    c.lineWidth = 1;
  }

  // azimuth ruler pinned to the viewport top
  c.strokeStyle = "#4d5a63";
  c.fillStyle = "#0b4d7a";
  c.textAlign = "center";
  const azLeft = offsetX * DEG_PER_PX;
  const azRight = azLeft + viewW / zoom * DEG_PER_PX;
  for (let az = Math.ceil(azLeft); az <= Math.floor(azRight); ++az) {
    const x = Math.round((az / DEG_PER_PX - offsetX) * zoom) + 0.5;
    c.beginPath();
    c.moveTo(x, 26); c.lineTo(x, 34);
    c.stroke();
    c.fillText(`${((az % 360) + 360) % 360}°`, x, 20);
  }
  c.textAlign = "left";

  // horizon (eye-level) line: subtle darkening of what's underneath, so it
  // reads as a crease in the image rather than a wire across it
  const hy = Math.round(toY(SCENE.elMaxRad / SCENE.stepRad)) + 0.5;
  if (hy > 0 && hy < viewH) {
    c.strokeStyle = "rgba(0, 30, 45, 0.10)";
    c.beginPath();
    c.moveTo(0, hy); c.lineTo(viewW, hy);
    c.stroke();
  }

  // sun layer: current position marker + today's sunrise/set on the horizon.
  // Azimuths are true (no declination involved — that's a compass concern).
  const azToX = (azDeg) => {
    const dx = ((azDeg / DEG_PER_PX - offsetX) % STRIP_W + STRIP_W) % STRIP_W;
    const x = dx * zoom;
    return x > viewW + 40 ? x - STRIP_W * zoom : x;
  };
  const now = new Date();
  const sun = sunPosition(now, SCENE.eye.lat, SCENE.eye.lon);
  const sx = azToX(sun.azDeg);
  if (sun.eleDeg > -0.833 && sx > -30 && sx < viewW + 30) {
    // pinned under the ruler at the true azimuth — the sun's real elevation
    // is almost always far above the ±3° strip, so vertical placement would
    // mostly lie; the number says it instead. Occlusion doesn't apply up
    // here, and the ticks below mark where it actually meets the horizon.
    const sy = 56;
    const g = c.createRadialGradient(sx, sy, 1, sx, sy, 9);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.65, "#fff3c4");
    g.addColorStop(1, "rgba(255, 236, 160, 0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(sx, sy, 9, 0, 2 * Math.PI);
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255, 255, 255, 0.75)";
    c.fillStyle = "#b58900";
    const eleText = `${sun.eleDeg.toFixed(0)}°`;
    c.strokeText(eleText, sx + 13, sy + 5);
    c.fillText(eleText, sx + 13, sy + 5);
    c.lineWidth = 1;
  }
  const ev = sunEvents(now, SCENE.eye.lat, SCENE.eye.lon);
  if (ev && hy > 60 && hy < viewH) {
    const tfmt = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    for (const [t, arrow] of [[ev.rise, "↑"], [ev.set, "↓"]]) {
      const x = azToX(sunPosition(t, SCENE.eye.lat, SCENE.eye.lon).azDeg);
      if (x < -30 || x > viewW + 30) continue;
      c.strokeStyle = "#b58900";
      c.beginPath();
      c.moveTo(Math.round(x) + 0.5, hy - 5); c.lineTo(Math.round(x) + 0.5, hy + 5);
      c.stroke();
      c.lineWidth = 3;
      c.strokeStyle = "rgba(255, 255, 255, 0.75)";
      c.fillStyle = "#b58900";
      const label = `${arrow}${tfmt(t)}`;
      c.strokeText(label, x + 4, hy - 5);
      c.fillText(label, x + 4, hy - 5);
      c.lineWidth = 1;
    }
  }
}

// --- sector rendering (raycast + summit test + tonemap, one at a time) -----

let renderBusy = false;
let prefetchTimer = null;
let renderedSunEle = null; // sun elevation baked into cached sectors (🌇 mode)

async function renderSector(i) {
  renderBusy = true;
  const azMin = i * SECTOR_DEG, azMax = azMin + SECTOR_DEG;
  status(`Rendering ${azMin}–${azMax}°…`);
  await new Promise(requestAnimationFrame); // let the status paint
  const t0 = performance.now();
  const refraction = Number(document.getElementById("refr").value);
  // beyond 1.2x visibility terrain has <2% contrast against the sky
  // (Koschmieder) — quantizes to sky anyway, so capping is lossless
  const distEffM = Math.min(SCENE.distMaxM, 1.2 * visKm() * 1000);
  api.render(SCENE.eye.lat, SCENE.eye.lon, SCENE.eye.ele,
             azMin, azMax, SCENE.elMinRad, SCENE.elMaxRad,
             SCENE.stepRad, distEffM, refraction);
  const w = api.width(), h = api.height();
  stripH = h;

  // summits first: the TSV malloc may grow wasm memory, which would detach
  // a heap view taken earlier
  const tsvBytes = new TextEncoder().encode(tsvCache);
  const tsvPtr = wasm._malloc(tsvBytes.length + 1);
  wasm.HEAPU8.set(tsvBytes, tsvPtr);
  wasm.HEAPU8[tsvPtr + tsvBytes.length] = 0;
  const summits = JSON.parse(api.summits(tsvPtr));
  wasm._free(tsvPtr);

  const pal = currentPalette();
  renderedSunEle = skyMode
    ? sunPosition(new Date(), SCENE.eye.lat, SCENE.eye.lon).eleDeg : null;
  const ptr = api.tonemap(visKm(), ...pal.terrain, ...pal.sky, ...pal.horizon);
  const rgba = new Uint8ClampedArray(wasm.HEAPU8.buffer, ptr, w * h * 4);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  cv.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);

  sectors.set(i, { canvas: cv, summits, stamp: ++stamp });
  while (sectors.size > MAX_SECTORS) {
    let lru = null;
    for (const [idx, s] of sectors)
      if (lru === null || s.stamp < sectors.get(lru).stamp) lru = idx;
    sectors.delete(lru);
  }
  renderBusy = false;
  status(`${azMin}–${azMax}° in ${(performance.now() - t0).toFixed(0)} ms — ` +
         `drag to pan, wheel/pinch to zoom`);
  draw();
}

// Render missing visible sectors (in view order); when the view is fully
// rendered, arm the idle prefetch of the next sector in the travel direction.
async function pump() {
  if (!ready || renderBusy) return;
  const need = visibleKs().map(mod12).filter((i) => !sectors.has(i));
  if (need.length) {
    await renderSector(need[0]);
    pump();
    return;
  }
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(prefetchNeighbor, 400);
}

function prefetchNeighbor() {
  if (!ready || renderBusy) return;
  const ks = visibleKs();
  const cands = lastDir >= 0 ? [ks[ks.length - 1] + 1, ks[0] - 1]
                             : [ks[0] - 1, ks[ks.length - 1] + 1];
  for (const k of cands) {
    if (!sectors.has(mod12(k))) {
      renderSector(mod12(k)).then(() => {
        prefetchTimer = setTimeout(prefetchNeighbor, 400);
      });
      return;
    }
  }
}

// Scene-parameter change (visibility, refraction): all cached sectors are
// stale — drop them and re-render the view.
function invalidateSectors() {
  sectors.clear();
  draw();
}

// --- URL state ---------------------------------------------------------------

let urlTimer = null;
function scheduleUrlSync() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const center = (offsetX + viewW / zoom / 2) * DEG_PER_PX;
    const p = new URLSearchParams(location.search);
    p.set("lat", SCENE.eye.lat.toFixed(6));
    p.set("lon", SCENE.eye.lon.toFixed(6));
    p.set("az", Math.round(((center % 360) + 360) % 360));
    if (ready) p.set("vis", visKm());
    if (skyMode) p.set("sky", "1"); else p.delete("sky");
    history.replaceState(null, "", "?" + p);
  }, 800);
}

// Center the viewport on an azimuth (no render — draw() requests sectors).
function lookAt(azDeg) {
  const az = ((azDeg % 360) + 360) % 360;
  const prev = offsetX;
  // window size, not canvas: canvas dimensions lag until the next draw()
  offsetX = az / DEG_PER_PX - window.innerWidth / zoom / 2;
  const d = ((offsetX - prev) % STRIP_W + STRIP_W * 1.5) % STRIP_W - STRIP_W / 2;
  if (d) lastDir = Math.sign(d);
  draw();
}

async function main() {
  // canvas fillText won't fetch @font-face fonts on its own; load explicitly
  const fontReady = document.fonts.load("14px Inter").catch(() => {});
  wasm = await createPanoModule();
  api = {
    reset: wasm.cwrap("pano_reset", null, ["number", "number", "number", "number"]),
    addTile: wasm.cwrap("pano_addTile", null, ["number", "number", "number"]),
    addTileZst: wasm.cwrap("pano_addTileZst", "number",
      ["number", "number", "number", "number"]),
    render: wasm.cwrap("pano_render", "number",
      ["number", "number", "number", "number", "number",
       "number", "number", "number", "number", "number"]),
    width: wasm.cwrap("pano_width", "number", []),
    height: wasm.cwrap("pano_height", "number", []),
    tonemap: wasm.cwrap("pano_tonemap", "number",
      ["number", "number", "number", "number", "number", "number", "number",
       "number", "number", "number"]),
    // takes a heap pointer: cwrap "string" args go via the 1 MB WASM stack,
    // too small for peaks-rated.tsv (~1.1 MB)
    summits: wasm.cwrap("pano_summits", "string", ["number"]),
    eyeElevation: wasm.cwrap("pano_eyeElevation", "number", ["number", "number"]),
  };

  // Fetch tiles straight into the WASM heap — only those the render
  // distance can reach (disc, not bounding square).
  const r = tileRange();
  api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
  const tiles = [];
  for (let lat = r.minLat; lat <= r.maxLat; ++lat)
    for (let lon = r.minLon; lon <= r.maxLon; ++lon)
      if (tileNearestKm(lat, lon) <= SCENE.distMaxM / 1000 + 2)
        tiles.push([lat, lon]);
  let loaded = 0;
  for (const [lat, lon] of tiles) {
    const name = tileName(lat, lon);
    // zstd mirror is the primary source (3x smaller); hgt-zst is the legacy
    // mirror name, raw .hgt the last fallback
    let src = `hgt3-zst/${name}.zst`;
    let resp = await fetch(`${DATA_URL}/${src}`);
    if (!resp.ok) {
      src = `hgt-zst/${name}.zst`;
      resp = await fetch(`${DATA_URL}/${src}`);
    }
    let compressed = true;
    if (!resp.ok) {
      src = name;
      resp = await fetch(`${DATA_URL}/${name}`);
      compressed = false;
    }
    status(`Fetching tile ${++loaded}/${tiles.length}: ${src}`);
    if (!resp.ok) { console.warn(`missing tile ${name}`); continue; }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const ptr = wasm._malloc(buf.length);
    wasm.HEAPU8.set(buf, ptr);
    if (compressed) {
      if (!api.addTileZst(lat, lon, ptr, buf.length))
        console.warn(`bad zst tile ${name}`);
    } else {
      api.addTile(lat, lon, ptr);
    }
    wasm._free(ptr);
  }

  // Safe eye height: 3x3 heightmap max + dh, unless ?ele= gave an absolute.
  if (!Number.isFinite(SCENE.eye.ele))
    SCENE.eye.ele = api.eyeElevation(SCENE.eye.lat, SCENE.eye.lon) + SCENE.eyeAboveM;

  // Rated peak database when built (scripts/build_peaks_db.py), curated list otherwise.
  let tsvResp = await fetch(`${DATA_URL}/peaks-rated.tsv`);
  if (!tsvResp.ok) tsvResp = await fetch(`${DATA_URL}/summits.tsv`);
  tsvCache = await tsvResp.text();

  // Controls: both sliders re-render on release (visibility caps the render
  // distance, so it is a raycast parameter now, not only a tonemap one).
  const vis = document.getElementById("vis");
  const refr = document.getElementById("refr");
  if (params.has("vis")) {
    vis.value = params.get("vis");
    document.getElementById("visval").textContent = `${vis.value} km`;
  }
  document.getElementById("visctl").style.display = "";
  document.getElementById("refrctl").style.display = "";
  vis.addEventListener("input", () => {
    document.getElementById("visval").textContent = `${vis.value} km`;
  });
  vis.addEventListener("change", invalidateSectors);
  refr.addEventListener("input", () => {
    document.getElementById("refrval").textContent = Number(refr.value).toFixed(2);
  });
  refr.addEventListener("change", invalidateSectors);

  setupControls();
  await fontReady;
  ready = true;
  lookAt(SCENE.azCenterDeg);

  // keep the sun marker honest while the app sits open (moves ~0.25°/min);
  // in 🌇 mode also re-render once the baked-in sun elevation drifts —
  // ~1° is invisible at noon but a whole palette row around sunset
  setInterval(() => {
    if (!ready) return;
    if (skyMode && renderedSunEle !== null && Math.abs(
        sunPosition(new Date(), SCENE.eye.lat, SCENE.eye.lon).eleDeg
        - renderedSunEle) > 1.0) {
      invalidateSectors();
    } else {
      draw();
    }
  }, 60000);

  // Offline support (deployed host only — localhost keeps the no-cache dev
  // loop). The SW caches every tile fetched above; ⇣ prefetches a full disc.
  // Updates: the browser re-fetches sw.js on navigations; an installed PWA
  // has no reload UI, so we also check on resume and self-reload when a new
  // version takes over during startup (invisible), or hint when mid-session.
  if ("serviceWorker" in navigator &&
      !["localhost", "127.0.0.1"].includes(location.hostname)) {
    const t0 = Date.now();
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (Date.now() - t0 < 5000) location.reload();
      else status("Updated — reopen the app to apply");
    });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
    }).catch(() => {});
  }
}

// Prefetch every tile within the render-distance disc into the SW cache,
// so the current viewpoint works offline (tiles already cached are free).
async function downloadRegion() {
  if (!navigator.serviceWorker?.controller) {
    status("Offline cache needs the deployed (https) host + one reload");
    return;
  }
  await navigator.storage?.persist?.();
  const r = tileRange();
  const wanted = [];
  for (let lat = r.minLat; lat <= r.maxLat; ++lat)
    for (let lon = r.minLon; lon <= r.maxLon; ++lon)
      if (tileNearestKm(lat, lon) <= SCENE.distMaxM / 1000 + 2)
        wanted.push(tileName(lat, lon));
  let done = 0, missing = 0;
  for (const name of wanted) {
    const resp = await fetch(`${DATA_URL}/hgt3-zst/${name}.zst`);
    if (!resp.ok) ++missing;
    status(`Offline download ${++done}/${wanted.length}…`);
  }
  const est = await navigator.storage?.estimate?.();
  const mb = est ? ` (${(est.usage / 1048576).toFixed(0)} MB stored)` : "";
  status(`Region cached for offline: ${done - missing} tiles${mb}`);
}

// --- viewpoint / direction controls (phone-first) ---------------------------

// Compass heading from a plain deviceorientation event (Android absolute):
// project the vector out of the device's back onto the horizontal plane.
// (W3C alpha/beta/gamma are intrinsic ZXY; iOS provides webkitCompassHeading
// directly and never reaches this.)
function compassHeading(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const a = alpha * d, b = beta * d, g = gamma * d;
  const vx = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const vy = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  return ((Math.atan2(vx, vy) * 180 / Math.PI) + 360) % 360;
}

let compassOn = false;
let smoothAz = null; // low-pass filtered heading (shaky hands, magnetometer noise)

function onOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading;                    // iOS
  } else if (e.alpha != null &&
             (e.absolute || e.type === "deviceorientationabsolute")) {
    heading = compassHeading(e.alpha, e.beta, e.gamma);  // Android
  }
  if (heading == null || !ready) return;
  heading = (heading + SCENE.declDeg + 360) % 360; // magnetic -> true north
  // Adaptive smoothing (One Euro style): gain grows with the deviation, so
  // hand tremor (~1-2°) is damped hard but a deliberate turn tracks fast.
  if (smoothAz == null) smoothAz = heading;
  const dAz = ((heading - smoothAz + 540) % 360) - 180;
  const gain = Math.min(0.5, 0.02 + Math.abs(dAz) * 0.03);
  smoothAz = (smoothAz + gain * dAz + 360) % 360;
  lookAt(smoothAz); // pure scroll; missing sectors render via draw() -> pump()
}

async function toggleCompass(btn) {
  if (compassOn) {
    compassOn = false;
    btn.style.opacity = "";
    window.removeEventListener("deviceorientationabsolute", onOrientation, true);
    window.removeEventListener("deviceorientation", onOrientation, true);
    return;
  }
  // iOS requires an explicit permission prompt from a user gesture
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      if (await DeviceOrientationEvent.requestPermission() !== "granted") {
        status("Compass permission denied");
        return;
      }
    } catch (err) {
      status(`Compass: ${err.message}`);
      return;
    }
  }
  compassOn = true;
  smoothAz = null;
  btn.style.opacity = "0.5";
  window.addEventListener("deviceorientationabsolute", onOrientation, true);
  window.addEventListener("deviceorientation", onOrientation, true);
}

function setupControls() {
  const bar = document.getElementById("dirs");
  const mk = (label, title, onClick) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  };

  mk("📍", "render from my GPS position", () => {
    if (!navigator.geolocation) { status("No geolocation API (https needed)"); return; }
    status("Locating…");
    navigator.geolocation.getCurrentPosition((pos) => {
      const p = new URLSearchParams(location.search);
      p.set("lat", pos.coords.latitude.toFixed(6));
      p.set("lon", pos.coords.longitude.toFixed(6));
      p.delete("ele"); // eye height from heightmap, not GPS altitude
      location.search = p; // reload: tile range changed
    }, (err) => status(`Geolocation failed: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000 });
  });

  const compassBtn = mk("🧭", "follow compass", () => toggleCompass(compassBtn));

  if (document.documentElement.requestFullscreen)
    mk("⛶", "fullscreen", () => document.fullscreenElement
      ? document.exitFullscreen() : document.documentElement.requestFullscreen());

  for (const [name, az] of [["N", 0], ["NE", 45], ["E", 90], ["SE", 135],
                            ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]])
    mk(name, `look ${name} (az ${az}°)`, () => lookAt(az));

  mk("⇣", "download this region for offline use", downloadRegion);

  const skyBtn = mk("🌇", "realistic sky — colors follow the sun", () => {
    skyMode = !skyMode;
    skyBtn.style.opacity = skyMode ? "0.5" : "";
    scheduleUrlSync();
    invalidateSectors();
  });
  if (skyMode) skyBtn.style.opacity = "0.5";

  const sundlg = document.getElementById("sundlg");
  sundlg.addEventListener("click", (e) => { if (e.target === sundlg) sundlg.close(); });
  let sunTimer = null;
  sundlg.addEventListener("close", () => clearInterval(sunTimer));
  mk("☀", "sun position & twilight times", () => {
    updateSunDialog();
    sunTimer = setInterval(updateSunDialog, 1000);
    sundlg.showModal();
  });

  const about = document.getElementById("about");
  about.addEventListener("click", (e) => { if (e.target === about) about.close(); });
  mk("ⓘ", "about & data credits", () => about.showModal());
}

// Sun dialog: live position + twilight table, everything for the scene
// viewpoint. Shadow length as a multiple of object height (cot elevation).
function updateSunDialog() {
  const { lat, lon } = SCENE.eye;
  const now = new Date();
  const s = sunPosition(now, lat, lon);
  const shadow = s.eleDeg > 0.5 ? `, shadow ${(1 / Math.tan(toRad(s.eleDeg))).toFixed(1)}× height`
    : s.eleDeg > 0 ? ", shadows practically infinite" : "";
  document.getElementById("sunnow").textContent =
    `Now: azimuth ${s.azDeg.toFixed(1)}°, elevation ${s.eleDeg.toFixed(1)}°${shadow}`;
  const tiers = [
    ["Astronomical twilight (−18°)", -18],
    ["Nautical twilight (−12°)", -12],
    ["Civil twilight (−6°)", -6],
    ["Sunrise / sunset", -0.833],
    ["Golden hour ends/starts (+6°)", 6],
  ];
  const t = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  document.getElementById("suntbl").innerHTML = tiers.map(([name, ele]) => {
    const cr = sunCrossings(now, lat, lon, ele);
    return `<tr><td>${name}</td><td>${cr ? t(cr.rise) : "—"}</td>` +
           `<td>${cr ? t(cr.set) : "—"}</td></tr>`;
  }).join("");
}

// --- pan (drag / arrows) and zoom (wheel / pinch) ---------------------------
const pointers = new Map(); // active pointerId -> {x, y}
let dragStart = null;       // {x, y, offsetX, offsetY} while dragging
let pinchDist = 0;

function zoomAt(screenX, screenY, newZoom) {
  newZoom = clampZoom(newZoom);
  const stripX = offsetX + screenX / zoom;
  const stripY = offsetY + (screenY - canvas.offsetTop) / zoom;
  zoom = newZoom;
  offsetX = stripX - screenX / zoom;
  offsetY = stripY - (screenY - canvas.offsetTop) / zoom;
  draw();
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    dragStart = { x: e.clientX, y: e.clientY, offsetX, offsetY };
  } else if (pointers.size === 2) {
    dragStart = null;
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && dragStart) {
    const dx = e.clientX - dragStart.x;
    if (dx) lastDir = -Math.sign(dx);
    offsetX = dragStart.offsetX - dx / zoom;
    offsetY = dragStart.offsetY - (e.clientY - dragStart.y) / zoom;
    draw();
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0)
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, zoom * (d / pinchDist));
    pinchDist = d;
  }
});
for (const ev of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(ev, (e) => {
    pointers.delete(e.pointerId);
    dragStart = null;
    pinchDist = 0;
  });
}
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, zoom * (e.deltaY < 0 ? 1.25 : 0.8));
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (document.activeElement instanceof HTMLInputElement) return; // sliders own the arrows
  if (e.key === "ArrowLeft") { offsetX -= 100 / zoom; lastDir = -1; draw(); }
  if (e.key === "ArrowRight") { offsetX += 100 / zoom; lastDir = 1; draw(); }
  if (e.key === "ArrowUp") { offsetY -= 50 / zoom; draw(); }
  if (e.key === "ArrowDown") { offsetY += 50 / zoom; draw(); }
  if (e.key === "+" || e.key === "=") zoomAt(viewW / 2, viewH / 2, zoom * 1.25);
  if (e.key === "-") zoomAt(viewW / 2, viewH / 2, zoom * 0.8);
  if (e.key === "0") zoomAt(viewW / 2, viewH / 2, 1.0); // reset to 100%
});
window.addEventListener("resize", draw);

main().catch((e) => { status(`Error: ${e.message}`); console.error(e); });
