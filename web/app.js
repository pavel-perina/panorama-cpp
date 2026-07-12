// Milestone 1+2: WASM renderer on desktop browser. JS owns all I/O:
// fetches tiles + summit TSV, calls the WASM module, draws on canvas.
"use strict";

// Scene: Kamenice lookout, azimuth 0-60° (same as current src/main.cpp).
const SCENE = {
  range: { minLat: 47, minLon: 15, maxLat: 50, maxLon: 21 },
  eye: { lat: 49.6013028, lon: 16.1646667, ele: 780.0 },
  azMinDeg: 0.0, azMaxDeg: 60.0,
  elMinRad: -0.0560, elMaxRad: 0.0339,
  stepRad: 0.0001,
  distMaxM: 250.0e3,
  refraction: 1.18,
};
const DATA_URL = "../data";

const DIST_STEP_M = 50.0; // one distance-map unit

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const status = (msg) => { document.getElementById("status").textContent = msg; };

// Full rendered strip lives on an offscreen canvas; the visible canvas is a
// draggable viewport over it. Kept around for re-tonemapping: the raw
// distance map, and the summit list.
let strip = null;
let offsetX = 0;
let distData = null, distW = 0, distH = 0;
let visibleSummits = [];

function draw() {
  if (!strip) return;
  const w = Math.min(window.innerWidth, strip.width);
  canvas.width = w;
  canvas.height = strip.height;
  offsetX = Math.max(0, Math.min(offsetX, strip.width - w));
  ctx.drawImage(strip, -offsetX, 0);
}

// Aerial-perspective tonemap (Koschmieder): terrain fades into the sky with
// distance; visibilityKm is the meteorological visibility V.
const TERRAIN = [123, 112, 76]; // near-terrain color (khaki)
const SKY = [149, 195, 233];    // airlight / sky color (light blue)

function renderStrip(visibilityKm) {
  const img = new ImageData(distW, distH);
  const px = img.data;
  const k = 3.912 / (visibilityKm * 1000.0);
  // fade[] lookup per distance value; 5001 covers distMax/distStep
  const fade = new Float32Array(5002);
  for (let d = 0; d < fade.length; ++d)
    fade[d] = 1.0 - Math.exp(-k * d * DIST_STEP_M);
  for (let i = 0; i < distData.length; ++i) {
    const o = i * 4;
    const d = distData[i];
    if (d === 0) {
      px[o] = SKY[0]; px[o + 1] = SKY[1]; px[o + 2] = SKY[2];
    } else {
      const t = fade[d];
      px[o]     = TERRAIN[0] + (SKY[0] - TERRAIN[0]) * t;
      px[o + 1] = TERRAIN[1] + (SKY[1] - TERRAIN[1]) * t;
      px[o + 2] = TERRAIN[2] + (SKY[2] - TERRAIN[2]) * t;
    }
    px[o + 3] = 255;
  }
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

async function main() {
  const t0 = performance.now();
  const Module = await createPanoModule();
  const api = {
    reset: Module.cwrap("pano_reset", null, ["number", "number", "number", "number"]),
    addTile: Module.cwrap("pano_addTile", null, ["number", "number", "number"]),
    render: Module.cwrap("pano_render", "number",
      ["number", "number", "number", "number", "number",
       "number", "number", "number", "number", "number"]),
    width: Module.cwrap("pano_width", "number", []),
    height: Module.cwrap("pano_height", "number", []),
    summits: Module.cwrap("pano_summits", "string", ["string"]),
  };

  // Fetch tiles straight into the WASM heap.
  const r = SCENE.range;
  api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
  const tiles = [];
  for (let lat = r.minLat; lat <= r.maxLat; ++lat)
    for (let lon = r.minLon; lon <= r.maxLon; ++lon)
      tiles.push([lat, lon]);
  const tileBytes = 1201 * 1201 * 2;
  const ptr = Module._malloc(tileBytes);
  let loaded = 0;
  for (const [lat, lon] of tiles) {
    const name = `N${String(lat).padStart(2, "0")}E${String(lon).padStart(3, "0")}.hgt`;
    status(`Fetching tile ${++loaded}/${tiles.length}: ${name}`);
    const resp = await fetch(`${DATA_URL}/${name}`);
    if (!resp.ok) { console.warn(`missing tile ${name}`); continue; }
    const buf = new Uint8Array(await resp.arrayBuffer());
    Module.HEAPU8.set(buf.subarray(0, tileBytes), ptr);
    api.addTile(lat, lon, ptr);
  }
  Module._free(ptr);

  status("Rendering…");
  await new Promise(requestAnimationFrame); // let the status paint
  const t1 = performance.now();
  const distPtr = api.render(
    SCENE.eye.lat, SCENE.eye.lon, SCENE.eye.ele,
    SCENE.azMinDeg, SCENE.azMaxDeg, SCENE.elMinRad, SCENE.elMaxRad,
    SCENE.stepRad, SCENE.distMaxM, SCENE.refraction);
  const w = api.width(), h = api.height();
  // copy out of the WASM heap: memory growth may detach the view later
  distData = Module.HEAPU16.slice(distPtr / 2, distPtr / 2 + w * h);
  distW = w;
  distH = h;
  const renderMs = performance.now() - t1;

  status("Finding summits…");
  const tsv = await (await fetch(`${DATA_URL}/summits.tsv`)).text();
  visibleSummits = JSON.parse(api.summits(tsv));

  // Visibility slider re-tonemaps without re-raycasting.
  const vis = document.getElementById("vis");
  document.getElementById("visctl").style.display = "";
  vis.addEventListener("input", () => {
    document.getElementById("visval").textContent = `${vis.value} km`;
    renderStrip(Number(vis.value));
  });
  renderStrip(Number(vis.value));

  status(`${w}×${h} px, render ${renderMs.toFixed(0)} ms, ` +
         `${visibleSummits.length} summits visible, total ${((performance.now() - t0) / 1000).toFixed(1)} s ` +
         `— drag or use arrow keys to pan`);
}

// Panning: drag or arrow keys.
let dragging = false, dragStartX = 0, dragStartOffset = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  dragStartX = e.clientX;
  dragStartOffset = offsetX;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  offsetX = dragStartOffset - (e.clientX - dragStartX);
  draw();
});
canvas.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { offsetX -= 100; draw(); }
  if (e.key === "ArrowRight") { offsetX += 100; draw(); }
});
window.addEventListener("resize", draw);

main().catch((e) => { status(`Error: ${e.message}`); console.error(e); });
