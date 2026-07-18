// Render worker: owns the WASM module so raycasting, tile decompression and
// tonemapping never block the UI thread (a 30° sector is ~600 ms of solid
// compute on a phone — as a main-thread call it froze pans whenever the
// speculative prefetch fired). Protocol: main sends {id, cmd, ...args}; the
// worker replies {id, ok, ...result} — the rendered sector travels as a
// transferred ImageBitmap, not a copy — and tile loading additionally posts
// unsolicited {progress} strings for the status line. Requests are handled
// sequentially; the app serializes renders anyway (renderBusy).
"use strict";
importScripts("../build-wasm/pano.js");

const DATA_URL = "../data"; // relative to this script (web/), same as app.js

let wasm = null, api = null, tsv = "";

const handlers = {
  async init({ range }) {
    // locateFile is required here: inside a worker pano.js can't derive its
    // own directory (no document.currentScript), so without this it would
    // fetch pano.wasm relative to worker.js (web/) and 404.
    wasm = await createPanoModule({
      locateFile: (path) => "../build-wasm/" + path,
    });
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
    api.reset(range.minLat, range.minLon, range.maxLat, range.maxLon);
    return {};
  },

  // Tile fetch + zstd decompression (worker fetches still go through the
  // service worker, so the offline tile cache works unchanged).
  async loadTiles({ tiles }) {
    let loaded = 0;
    for (const { lat, lon, name } of tiles) {
      // zstd mirror is the primary source (3x smaller); hgt-zst is the
      // legacy mirror name, raw .hgt the last fallback
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
      self.postMessage({ progress: `Fetching tile ${++loaded}/${tiles.length}: ${src}` });
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
    return {};
  },

  eyeElevation({ lat, lon }) {
    return { ele: api.eyeElevation(lat, lon) };
  },

  setTsv({ text }) {
    tsv = text;
    return {};
  },

  // Raycast + summit test + tonemap for one sector.
  async render(p) {
    api.render(p.lat, p.lon, p.ele, p.azMin, p.azMax,
               p.elMinRad, p.elMaxRad, p.stepRad, p.distM, p.refraction);
    const w = api.width(), h = api.height();

    // summits first: the TSV malloc may grow wasm memory, which would
    // detach a heap view taken earlier
    const tsvBytes = new TextEncoder().encode(tsv);
    const tsvPtr = wasm._malloc(tsvBytes.length + 1);
    wasm.HEAPU8.set(tsvBytes, tsvPtr);
    wasm.HEAPU8[tsvPtr + tsvBytes.length] = 0;
    const summits = JSON.parse(api.summits(tsvPtr));
    wasm._free(tsvPtr);

    const ptr = api.tonemap(p.visKm, ...p.terrain, ...p.sky, ...p.horizon);
    // copy out of the heap: createImageBitmap resolves asynchronously and
    // the heap may move if another message allocates meanwhile
    const rgba = new Uint8ClampedArray(
      wasm.HEAPU8.buffer.slice(ptr, ptr + w * h * 4));
    const bitmap = await createImageBitmap(new ImageData(rgba, w, h));
    return { result: { w, h, summits, bitmap }, transfer: [bitmap] };
  },
};

self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try {
    const r = (await handlers[cmd](e.data)) || {};
    const result = "result" in r ? r.result : r;
    self.postMessage({ id, ok: true, ...result }, r.transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
