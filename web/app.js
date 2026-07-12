// WASM renderer on desktop browser. JS owns all I/O: fetches tiles + summit
// TSV, calls the WASM module, draws on canvas. Pan by drag/arrows, zoom by
// wheel/pinch, visibility slider re-tonemaps, refraction slider re-raycasts.
"use strict";

// Scene: Kamenice lookout, azimuth 0-60° (same as current src/main.cpp).
const SCENE = {
  range: { minLat: 47, minLon: 15, maxLat: 50, maxLon: 21 },
  eye: { lat: 49.6013028, lon: 16.1646667, ele: 780.0 },
  azMinDeg: 0.0, azMaxDeg: 60.0,
  elMinRad: -0.0560, elMaxRad: 0.0339,
  stepRad: 0.0001,
  distMaxM: 250.0e3,
};
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
  return Math.max(strip ? vh / strip.height : 0.2, Math.min(6, z));
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
}

// Aerial-perspective tonemap (Koschmieder): terrain fades into the sky with
// distance; visibilityKm is the meteorological visibility V.
const TERRAIN = [123, 112, 76]; // near-terrain color (khaki)
const SKY = [149, 195, 233];    // airlight / sky color (light blue)

function renderStrip(visibilityKm) {
  // Tonemapping (Koschmieder fade, OkLab-interpolated) happens in WASM.
  const ptr = api.tonemap(visibilityKm, ...TERRAIN, ...SKY);
  const rgba = new Uint8ClampedArray(wasm.HEAPU8.buffer, ptr, distW * distH * 4);
  const img = new ImageData(rgba, distW, distH);
  if (!strip) {
    strip = document.createElement("canvas");
    strip.width = distW;
    strip.height = distH;
  }
  strip.getContext("2d").putImageData(img, 0, 0);
  drawAnnotations(visibleSummits, SCENE);
  draw();
}

function drawAnnotations(summits, view) {
  const c = strip.getContext("2d");
  const labelBaseY = 300;
  c.font = "16px 'Fira Sans', sans-serif";
  c.lineWidth = 1;
  for (const s of summits) {
    c.strokeStyle = "#4d5a63";
    c.beginPath();
    c.moveTo(s.x + 0.5, s.y);
    c.lineTo(s.x + 0.5, labelBaseY);
    c.stroke();
    c.fillStyle = "#0b4d7a";
    c.save();
    c.translate(s.x + 5, labelBaseY - 5);
    c.rotate(-Math.PI / 4);
    c.fillText(`${s.name} (${Math.round(s.distanceM / 1000)} km)`, 0, 0);
    c.restore();
  }
  // azimuth ticks + horizon
  c.strokeStyle = "#4d5a63";
  c.fillStyle = "#0b4d7a";
  c.textAlign = "center";
  for (let az = Math.ceil(view.azMinDeg); az <= Math.floor(view.azMaxDeg); ++az) {
    const x = Math.round((az - view.azMinDeg) * (Math.PI / 180) / view.stepRad) + 0.5;
    c.beginPath();
    c.moveTo(x, 38); c.lineTo(x, 42);
    c.moveTo(x, 63); c.lineTo(x, 68);
    c.stroke();
    c.fillText(`${(az + 360) % 360}°`, x, 58);
  }
  c.textAlign = "left";
  const horizonY = Math.round(view.elMaxRad / view.stepRad) + 0.5;
  c.strokeStyle = "#7d97a8";
  c.beginPath();
  c.moveTo(0, horizonY); c.lineTo(strip.width, horizonY);
  c.stroke();
}

// Raycast (or re-raycast after a refraction change) + summit test + tonemap.
async function render() {
  status("Rendering…");
  await new Promise(requestAnimationFrame); // let the status paint
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
  visibleSummits = JSON.parse(api.summits(tsvCache));
  renderStrip(Number(document.getElementById("vis").value));
  status(`${distW}×${distH} px, render ${renderMs.toFixed(0)} ms, ` +
         `${visibleSummits.length} summits visible — drag to pan, wheel/pinch to zoom`);
}

async function main() {
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
    summits: wasm.cwrap("pano_summits", "string", ["string"]),
  };

  // Fetch tiles straight into the WASM heap.
  const r = SCENE.range;
  api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
  const tiles = [];
  for (let lat = r.minLat; lat <= r.maxLat; ++lat)
    for (let lon = r.minLon; lon <= r.maxLon; ++lon)
      tiles.push([lat, lon]);
  let loaded = 0;
  for (const [lat, lon] of tiles) {
    const name = `N${String(lat).padStart(2, "0")}E${String(lon).padStart(3, "0")}.hgt`;
    // zstd mirror is the primary source (3x smaller); raw .hgt as fallback
    let resp = await fetch(`${DATA_URL}/hgt-zst/${name}.zst`);
    let compressed = true;
    if (!resp.ok) {
      resp = await fetch(`${DATA_URL}/${name}`);
      compressed = false;
    }
    status(`Fetching tile ${++loaded}/${tiles.length}: ${compressed ? `hgt-zst/${name}.zst` : name}`);
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

  tsvCache = await (await fetch(`${DATA_URL}/summits.tsv`)).text();

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

  await render();
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
});
window.addEventListener("resize", draw);

main().catch((e) => { status(`Error: ${e.message}`); console.error(e); });
