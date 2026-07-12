// Smoke test: render the Kamenice scene in the WASM module under Node and
// compare against the native renderer's output (dumped as raw uint16 LE).
//   python3 -c "import cv2; cv2.imread('dist_map.png',-1).tofile('dist_native.bin')"
//   ~/emsdk/node/22.16.0_64bit/bin/node web/test-node.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const createPanoModule = require("../build-wasm/pano.js");

const SCENE = {
  range: { minLat: 47, minLon: 15, maxLat: 50, maxLon: 21 },
  eye: { lat: 49.6013028, lon: 16.1646667, ele: 780.0 },
  azMinDeg: 0.0, azMaxDeg: 60.0,
  elMinRad: -0.0560, elMaxRad: 0.0339,
  stepRad: 0.0001, distMaxM: 250.0e3, refraction: 1.18,
};

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

const r = SCENE.range;
api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
const ptr = Module._malloc(1201 * 1201 * 2);
for (let lat = r.minLat; lat <= r.maxLat; ++lat) {
  for (let lon = r.minLon; lon <= r.maxLon; ++lon) {
    const name = `N${String(lat).padStart(2, "0")}E${String(lon).padStart(3, "0")}.hgt`;
    const bytes = readFileSync(new URL(`../data/${name}`, import.meta.url));
    Module.HEAPU8.set(bytes, ptr);
    api.addTile(lat, lon, ptr);
  }
}
Module._free(ptr);

const t0 = performance.now();
const distPtr = api.render(
  SCENE.eye.lat, SCENE.eye.lon, SCENE.eye.ele,
  SCENE.azMinDeg, SCENE.azMaxDeg, SCENE.elMinRad, SCENE.elMaxRad,
  SCENE.stepRad, SCENE.distMaxM, SCENE.refraction);
const w = api.width(), h = api.height();
console.log(`WASM render: ${w}x${h} in ${(performance.now() - t0).toFixed(0)} ms`);
const dist = Module.HEAPU16.subarray(distPtr / 2, distPtr / 2 + w * h);

let max = 0, nonzero = 0;
for (const v of dist) { if (v > max) max = v; if (v) ++nonzero; }
console.log(`max=${max} nonzero=${(100 * nonzero / dist.length).toFixed(2)}%`);

const tsv = readFileSync(new URL("../data/summits.tsv", import.meta.url), "utf8");
const visible = JSON.parse(api.summits(tsv));
console.log(`visible summits: ${visible.length}, nearest: ` +
  visible.slice().sort((a, b) => a.distanceM - b.distanceM)[0]?.name);

const refPath = new URL("../dist_native.bin", import.meta.url);
if (existsSync(refPath)) {
  const ref = new Uint16Array(readFileSync(refPath).buffer);
  if (ref.length !== dist.length) {
    console.error(`SIZE MISMATCH: native ${ref.length} vs wasm ${dist.length}`);
    process.exit(1);
  }
  let differing = 0, maxDiff = 0;
  for (let i = 0; i < ref.length; ++i) {
    const d = Math.abs(ref[i] - dist[i]);
    if (d) { ++differing; if (d > maxDiff) maxDiff = d; }
  }
  console.log(`vs native: ${differing} px differ (${(100 * differing / ref.length).toFixed(4)}%), max diff ${maxDiff}`);
  process.exit(differing / ref.length > 0.001 ? 1 : 0);
} else {
  console.log("(no dist_native.bin reference, skipped comparison)");
}
