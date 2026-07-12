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

const bar = document.getElementById("bar");
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const status = (msg) => { bar.textContent = msg; };

// Full rendered strip lives on an offscreen canvas; the visible canvas is a
// draggable viewport over it.
let strip = null;
let offsetX = 0;

function draw() {
  if (!strip) return;
  const w = Math.min(window.innerWidth, strip.width);
  canvas.width = w;
  canvas.height = strip.height;
  offsetX = Math.max(0, Math.min(offsetX, strip.width - w));
  ctx.drawImage(strip, -offsetX, 0);
}

function makeStrip(dist, w, h) {
  let max = 1;
  for (let i = 0; i < dist.length; ++i) if (dist[i] > max) max = dist[i];
  const img = new ImageData(w, h);
  const px = img.data;
  for (let i = 0; i < dist.length; ++i) {
    const v = dist[i] ? Math.round(255 - (dist[i] / max) * 200) : 0; // sky black, near bright
    const o = i * 4;
    px[o] = px[o + 1] = px[o + 2] = v;
    px[o + 3] = 255;
  }
  strip = document.createElement("canvas");
  strip.width = w;
  strip.height = h;
  strip.getContext("2d").putImageData(img, 0, 0);
}

function drawAnnotations(summits, view) {
  const c = strip.getContext("2d");
  const labelBaseY = 300;
  c.font = "16px 'Fira Sans', sans-serif";
  c.lineWidth = 1;
  for (const s of summits) {
    c.strokeStyle = "#839496";
    c.beginPath();
    c.moveTo(s.x + 0.5, s.y);
    c.lineTo(s.x + 0.5, labelBaseY);
    c.stroke();
    c.fillStyle = "#268bd2";
    c.save();
    c.translate(s.x + 5, labelBaseY - 5);
    c.rotate(-Math.PI / 4);
    c.fillText(`${s.name} (${Math.round(s.distanceM / 1000)} km)`, 0, 0);
    c.restore();
  }
  // azimuth ticks + horizon
  c.strokeStyle = "#839496";
  c.fillStyle = "#268bd2";
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
  c.strokeStyle = "#eee8d5";
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
  const dist = Module.HEAPU16.subarray(distPtr / 2, distPtr / 2 + w * h);
  const renderMs = performance.now() - t1;

  makeStrip(dist, w, h);

  status("Finding summits…");
  const tsv = await (await fetch(`${DATA_URL}/summits.tsv`)).text();
  const visible = JSON.parse(api.summits(tsv));
  drawAnnotations(visible, SCENE);

  draw();
  status(`${w}×${h} px, render ${renderMs.toFixed(0)} ms, ` +
         `${visible.length} summits visible, total ${((performance.now() - t0) / 1000).toFixed(1)} s ` +
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
