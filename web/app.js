// WASM renderer in the browser. JS owns all I/O: fetches tiles + summit
// TSV, calls the WASM module, draws on canvas. Pan by drag/arrows, zoom by
// wheel/pinch, visibility slider re-tonemaps, refraction slider re-raycasts.
// Scene state lives in URL params (shareable): ?lat=&lon=&dh=&az=&ele=&dist=
"use strict";

// Defaults: Kamenice lookout, sector centered az 30° (matches src/main.cpp).
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
  azHalfDeg: 30.0,
  azMinDeg: 0.0, azMaxDeg: 60.0, // derived from azCenterDeg on each render
  elMinRad: -0.0560, elMaxRad: 0.0339,
  stepRad: 0.0001,
  distMaxM: num("dist", 250) * 1000,
};

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

// SRTM tile name from its floored SW corner: lat -34, lon -71 -> S34W071.
function tileName(lat, lon) {
  return (lat < 0 ? "S" : "N") + String(Math.abs(lat)).padStart(2, "0") +
         (lon < 0 ? "W" : "E") + String(Math.abs(lon)).padStart(3, "0") + ".hgt";
}

function syncUrl() {
  const p = new URLSearchParams(location.search);
  p.set("lat", SCENE.eye.lat.toFixed(6));
  p.set("lon", SCENE.eye.lon.toFixed(6));
  p.set("az", Math.round(SCENE.azCenterDeg));
  history.replaceState(null, "", "?" + p);
}

const DATA_URL = "../data";
const DIST_STEP_M = 50.0; // one distance-map unit

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const status = (msg) => { document.getElementById("status").textContent = msg; };

// Module state (set by main), kept for re-render and re-tonemap.
let api = null, wasm = null, tsvCache = "";
let distData = null, distW = 0, distH = 0;
let visibleSummits = [];

// Full rendered strip on an offscreen canvas; the visible canvas is a fixed
// viewport and only the image content zooms/pans inside it. Offsets are the
// strip coordinates of the viewport's top-left corner.
let strip = null;
let offsetX = 0, offsetY = 0;
let zoom = 1.0;

function clampZoom(z) {
  const vh = window.innerHeight - document.getElementById("bar").offsetHeight;
  // min: fit height, but never force stretching past 100% on tall screens
  const min = strip ? Math.min(1, vh / strip.height) : 0.2;
  return Math.max(min, Math.min(6, z));
}

function draw() {
  if (!strip) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight - document.getElementById("bar").offsetHeight;
  canvas.width = vw;
  canvas.height = vh;
  zoom = clampZoom(zoom);
  const sw = vw / zoom, sh = vh / zoom;
  offsetX = Math.max(0, Math.min(offsetX, strip.width - sw));
  offsetY = Math.max(0, Math.min(offsetY, strip.height - sh));
  ctx.imageSmoothingEnabled = zoom < 1; // smooth when zoomed out, crisp pixels zoomed in
  ctx.drawImage(strip, offsetX, offsetY, sw, sh, 0, 0, vw, vh);
  drawOverlay();
}

// Aerial-perspective tonemap (Koschmieder): terrain fades into the sky with
// distance; visibilityKm is the meteorological visibility V.
const TERRAIN = [50, 65, 0]; // near-terrain color (khaki)
const SKY = [149, 195, 233];    // airlight / sky color (light blue)

function renderStrip(visibilityKm) {
  // Tonemapping (Koschmieder fade, OkLab-interpolated) happens in WASM.
  const ptr = api.tonemap(visibilityKm, ...TERRAIN, ...SKY);
  const rgba = new Uint8ClampedArray(wasm.HEAPU8.buffer, ptr, distW * distH * 4);
  const img = new ImageData(rgba, distW, distH);
  if (!strip || strip.width !== distW || strip.height !== distH) {
    strip = document.createElement("canvas");
    strip.width = distW;
    strip.height = distH;
  }
  strip.getContext("2d").putImageData(img, 0, 0);
  draw();
}

// Labels + vector layer as a screen-space overlay, redrawn every frame:
// geometry anchored in strip coordinates, style in screen pixels — lines
// stay 1 px and text stays 14 px at any zoom.
function drawOverlay() {
  const toX = (x) => (x - offsetX) * zoom;
  const toY = (y) => (y - offsetY) * zoom;
  const c = ctx;
  c.font = "14px Inter, sans-serif";
  c.lineWidth = 1;
  c.textAlign = "left";

  // summit stems + labels; greedy screen-space spacing (summits arrive
  // prominence-first from C++) prunes crowding when zoomed out
  const labelBaseY = toY(300);
  const taken = [];
  for (const s of visibleSummits) {
    const x = toX(s.x);
    if (x < -40 || x > canvas.width + 40) continue;
    if (taken.some((t) => Math.abs(t - x) < 20)) continue;
    taken.push(x);
    c.strokeStyle = "#4d5a63";
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, toY(s.y));
    c.lineTo(Math.round(x) + 0.5, labelBaseY);
    c.stroke();
    c.fillStyle = "#0b4d7a";
    c.save();
    c.translate(x + 5, labelBaseY - 5);
    c.rotate(-Math.PI / 4);
    c.fillText(`${s.name} (${Math.round(s.distanceM / 1000)} km)`, 0, 0);
    c.restore();
  }

  // azimuth ruler pinned to the viewport top
  c.strokeStyle = "#4d5a63";
  c.fillStyle = "#0b4d7a";
  c.textAlign = "center";
  const degPerPx = SCENE.stepRad * 180 / Math.PI; // strip px -> degrees
  const azLeft = SCENE.azMinDeg + offsetX * degPerPx;
  const azRight = SCENE.azMinDeg + (offsetX + canvas.width / zoom) * degPerPx;
  for (let az = Math.ceil(azLeft); az <= Math.floor(azRight); ++az) {
    const x = Math.round(toX((az - SCENE.azMinDeg) / degPerPx)) + 0.5;
    c.beginPath();
    c.moveTo(x, 26); c.lineTo(x, 34);
    c.stroke();
    c.fillText(`${((az % 360) + 360) % 360}°`, x, 20);
  }
  c.textAlign = "left";

  // horizon (eye-level) line
  const hy = Math.round(toY(SCENE.elMaxRad / SCENE.stepRad)) + 0.5;
  if (hy > 0 && hy < canvas.height) {
    c.strokeStyle = "#7d97a8";
    c.beginPath();
    c.moveTo(0, hy); c.lineTo(canvas.width, hy);
    c.stroke();
  }
}

// Raycast (or re-raycast after a refraction/sector change) + summit test + tonemap.
let rendering = false;
async function render() {
  rendering = true;
  status("Rendering…");
  await new Promise(requestAnimationFrame); // let the status paint
  SCENE.azMinDeg = SCENE.azCenterDeg - SCENE.azHalfDeg;
  SCENE.azMaxDeg = SCENE.azCenterDeg + SCENE.azHalfDeg;
  const refraction = Number(document.getElementById("refr").value);
  const t0 = performance.now();
  const distPtr = api.render(
    SCENE.eye.lat, SCENE.eye.lon, SCENE.eye.ele,
    SCENE.azMinDeg, SCENE.azMaxDeg, SCENE.elMinRad, SCENE.elMaxRad,
    SCENE.stepRad, SCENE.distMaxM, refraction);
  distW = api.width();
  distH = api.height();
  // copy out of the WASM heap: memory growth may detach the view later
  distData = wasm.HEAPU16.slice(distPtr / 2, distPtr / 2 + distW * distH);
  const renderMs = performance.now() - t0;
  const tsvBytes = new TextEncoder().encode(tsvCache);
  const tsvPtr = wasm._malloc(tsvBytes.length + 1);
  wasm.HEAPU8.set(tsvBytes, tsvPtr);
  wasm.HEAPU8[tsvPtr + tsvBytes.length] = 0;
  visibleSummits = JSON.parse(api.summits(tsvPtr));
  wasm._free(tsvPtr);
  renderStrip(Number(document.getElementById("vis").value));
  status(`${distW}×${distH} px, render ${renderMs.toFixed(0)} ms, ` +
         `${visibleSummits.length} summits visible — drag to pan, wheel/pinch to zoom`);
  rendering = false;
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

  // Fetch tiles straight into the WASM heap.
  const r = tileRange();
  api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
  const tiles = [];
  for (let lat = r.minLat; lat <= r.maxLat; ++lat)
    for (let lon = r.minLon; lon <= r.maxLon; ++lon)
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

  // Controls: visibility re-tonemaps instantly, refraction re-raycasts.
  const vis = document.getElementById("vis");
  const refr = document.getElementById("refr");
  document.getElementById("visctl").style.display = "";
  document.getElementById("refrctl").style.display = "";
  vis.addEventListener("input", () => {
    document.getElementById("visval").textContent = `${vis.value} km`;
    renderStrip(Number(vis.value));
  });
  refr.addEventListener("input", () => {
    document.getElementById("refrval").textContent = Number(refr.value).toFixed(2);
  });
  refr.addEventListener("change", render); // on release, ~1 s

  setupControls();
  await fontReady;
  await render();
}

// --- viewpoint / direction controls (phone-first) ---------------------------

// Re-render the 60° sector facing azDeg (N=0, E=90, ...).
async function setSector(azDeg) {
  if (rendering) return;
  SCENE.azCenterDeg = ((azDeg % 360) + 360) % 360;
  syncUrl();
  await render();
}

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
let compassTimer = null;
let smoothAz = null; // low-pass filtered heading (shaky hands, magnetometer noise)

function onOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading;                    // iOS
  } else if (e.alpha != null &&
             (e.absolute || e.type === "deviceorientationabsolute")) {
    heading = compassHeading(e.alpha, e.beta, e.gamma);  // Android
  }
  if (heading == null || !strip) return;
  // Adaptive smoothing (One Euro style): gain grows with the deviation, so
  // hand tremor (~1-2°) is damped hard but a deliberate turn tracks fast.
  if (smoothAz == null) smoothAz = heading;
  const dAz = ((heading - smoothAz + 540) % 360) - 180;
  const gain = Math.min(0.5, 0.02 + Math.abs(dAz) * 0.03);
  smoothAz = (smoothAz + gain * dAz + 360) % 360;
  heading = smoothAz;
  // wrapped offset of the heading from the sector center, in [-180, 180)
  const rel = ((heading - SCENE.azCenterDeg + 540) % 360) - 180;
  if (Math.abs(rel) <= SCENE.azHalfDeg - 3) {
    // inside the rendered sector: scroll the strip to center the heading
    const px = (rel + SCENE.azHalfDeg) * (Math.PI / 180) / SCENE.stepRad;
    offsetX = px - canvas.width / zoom / 2;
    draw();
  } else if (!rendering && !compassTimer) {
    // left the sector: re-render facing the heading once it settles
    compassTimer = setTimeout(() => {
      compassTimer = null;
      if (compassOn) setSector(heading);
    }, 700);
  }
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
    mk(name, `look ${name} (az ${az}°)`, () => setSector(az));

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
    offsetX = dragStart.offsetX - (e.clientX - dragStart.x) / zoom;
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
  if (e.key === "ArrowLeft") { offsetX -= 100 / zoom; draw(); }
  if (e.key === "ArrowRight") { offsetX += 100 / zoom; draw(); }
  if (e.key === "ArrowUp") { offsetY -= 50 / zoom; draw(); }
  if (e.key === "ArrowDown") { offsetY += 50 / zoom; draw(); }
  if (e.key === "+" || e.key === "=") zoomAt(canvas.width / 2, canvas.height / 2, zoom * 1.25);
  if (e.key === "-") zoomAt(canvas.width / 2, canvas.height / 2, zoom * 0.8);
  if (e.key === "0") zoomAt(canvas.width / 2, canvas.height / 2, 1.0); // reset to 100%
});
window.addEventListener("resize", draw);

main().catch((e) => { status(`Error: ${e.message}`); console.error(e); });
