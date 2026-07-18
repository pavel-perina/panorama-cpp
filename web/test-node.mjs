// Smoke test: render the Kamenice scene in the WASM module under Node and
// compare against the native renderer's output (dumped as raw uint16 LE).
//   ./build/panorama && uv run scripts/dump_dist_native.py
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
  addTileZst: Module.cwrap("pano_addTileZst", "number",
    ["number", "number", "number", "number"]),
  render: Module.cwrap("pano_render", "number",
    ["number", "number", "number", "number", "number",
     "number", "number", "number", "number", "number"]),
  width: Module.cwrap("pano_width", "number", []),
  height: Module.cwrap("pano_height", "number", []),
  // heap pointer, not cwrap "string": the TSV can exceed the 1 MB WASM stack
  summits: Module.cwrap("pano_summits", "string", ["number"]),
  tonemap: Module.cwrap("pano_tonemap", "number",
    ["number", "number", "number", "number", "number", "number", "number",
     "number", "number", "number"]),
};

const r = SCENE.range;
api.reset(r.minLat, r.minLon, r.maxLat, r.maxLon);
let zstTiles = 0;
for (let lat = r.minLat; lat <= r.maxLat; ++lat) {
  for (let lon = r.minLon; lon <= r.maxLon; ++lon) {
    const name = (lat < 0 ? "S" : "N") + String(Math.abs(lat)).padStart(2, "0") +
                 (lon < 0 ? "W" : "E") + String(Math.abs(lon)).padStart(3, "0") + ".hgt";
    // exercise the zstd path where the mirror has the tile
    let zstUrl = new URL(`../data/hgt3-zst/${name}.zst`, import.meta.url);
    if (!existsSync(zstUrl))
      zstUrl = new URL(`../data/hgt-zst/${name}.zst`, import.meta.url); // legacy name
    const compressed = existsSync(zstUrl);
    const bytes = readFileSync(compressed ? zstUrl : new URL(`../data/${name}`, import.meta.url));
    const ptr = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, ptr);
    if (compressed) {
      if (!api.addTileZst(lat, lon, ptr, bytes.length)) throw new Error(`bad zst ${name}`);
      ++zstTiles;
    } else {
      api.addTile(lat, lon, ptr);
    }
    Module._free(ptr);
  }
}
console.log(`tiles via zstd path: ${zstTiles}`);

const t0 = performance.now();
const distPtr = api.render(
  SCENE.eye.lat, SCENE.eye.lon, SCENE.eye.ele,
  SCENE.azMinDeg, SCENE.azMaxDeg, SCENE.elMinRad, SCENE.elMaxRad,
  SCENE.stepRad, SCENE.distMaxM, SCENE.refraction);
const w = api.width(), h = api.height();
console.log(`WASM render: ${w}x${h} in ${(performance.now() - t0).toFixed(0)} ms`);
// copy, not a view: later allocations may grow memory and detach views
const dist = Module.HEAPU16.slice(distPtr / 2, distPtr / 2 + w * h);

let max = 0, nonzero = 0;
for (const v of dist) { if (v > max) max = v; if (v) ++nonzero; }
console.log(`max=${max} nonzero=${(100 * nonzero / dist.length).toFixed(2)}%`);

// rated database when built, curated list otherwise — same order as app.js
const ratedUrl = new URL("../data/peaks-rated.tsv", import.meta.url);
const tsvBuf = readFileSync(existsSync(ratedUrl) ? ratedUrl
                                                 : new URL("../data/summits.tsv", import.meta.url));
const tsvPtr = Module._malloc(tsvBuf.length + 1);
Module.HEAPU8.set(tsvBuf, tsvPtr);
Module.HEAPU8[tsvPtr + tsvBuf.length] = 0;
const visible = JSON.parse(api.summits(tsvPtr));
Module._free(tsvPtr);
console.log(`visible summits: ${visible.length}, nearest: ` +
  visible.slice().sort((a, b) => a.distanceM - b.distanceM)[0]?.name);

// Tonemap regression: shared src/tonemap.cpp must keep producing the same
// pixels (parity-reference palette = native CLI defaults, visibility
// 100 km, derived horizon). FNV-1a over RGB; update the expected hash only
// on a deliberate palette/tonemap change.
{
  const rgbaPtr = api.tonemap(100.0, 50, 65, 0, 149, 195, 233, -1, -1, -1);
  const rgba = Module.HEAPU8.subarray(rgbaPtr, rgbaPtr + w * h * 4);
  let hash = 0x811c9dc5;
  for (let i = 0; i < rgba.length; i += 4)
    for (let c = 0; c < 3; ++c) {
      hash ^= rgba[i + c];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  const expected = "b175c596"; // == native panorama_photo.png (bottom-row fencepost fix, 2026-07-17)
  const got = hash.toString(16).padStart(8, "0");
  console.log(`tonemap rgb hash: ${got} (expected ${expected})`);
  if (got !== expected) {
    console.error("TONEMAP HASH MISMATCH");
    process.exit(1);
  }
}

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
