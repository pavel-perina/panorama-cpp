// WASM renderer in the browser. JS owns all I/O: fetches tiles + summit
// TSV, calls the WASM module, draws on canvas. Pan by drag/arrows, zoom by
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
//   ?lat=&lon=&dh=&az=&ele=&dist=&decl=  (decl: magnetic declination in
//   degrees, added to compass headings; ~+5 in Central Europe 2026)
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
  Math.floor((SCENE.elMaxRad - SCENE.elMinRad) / SCENE.stepRad) + 2;

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

const SKY = [149, 195, 233];    // zenith color; horizon fades to near-white in the tonemap
const TERRAIN = [50, 65, 0];    // near-terrain color (khaki)

let viewW = 0, viewH = 0; // viewport size in CSS px (backing store is ×dpr)

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
  // page background below the strip (tall windows), sky placeholder within it
  ctx.fillStyle = "#002b36";
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.fillStyle = `rgb(${SKY[0]},${SKY[1]},${SKY[2]})`; // placeholder for unrendered sectors
  ctx.fillRect(0, 0, viewW, Math.min(viewH, (stripH - offsetY) * zoom));
  // never sample past the strip bottom: a source rect that overshoots the
  // sector canvas blends in transparent pixels — a 1 px line at the bottom
  const srcH = Math.min(viewH / zoom, stripH - offsetY);
  let missing = false;
  for (const k of visibleKs()) {
    const s = sectors.get(mod12(k));
    if (!s) { missing = true; continue; }
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
}

// --- sector rendering (raycast + summit test + tonemap, one at a time) -----

let renderBusy = false;
let prefetchTimer = null;

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

  const ptr = api.tonemap(visKm(), ...TERRAIN, ...SKY);
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
      ["number", "number", "number", "number", "number", "number", "number"]),
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

  const about = document.getElementById("about");
  about.addEventListener("click", (e) => { if (e.target === about) about.close(); });
  mk("ⓘ", "about & data credits", () => about.showModal());
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
