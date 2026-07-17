// Service worker: offline support.
// - App shell (html/js/wasm/font) precached as one versioned set — pano.js
//   and pano.wasm always update atomically, which kills the mismatched-pair
//   "memory access out of bounds" failure mode for good.
// - Heightmap tiles: cache-first, immutable — every tile ever fetched works
//   offline; the app's download-region button prefetches a whole disc.
// - Peak TSVs: stale-while-revalidate — instant load, background refresh.
// VERSION is stamped by deploy/deploy.sh; "dev" is the repo placeholder
// (app.js skips registration on localhost anyway).
"use strict";

const VERSION = "dev";
const SHELL = `shell-${VERSION}`;
const TILES = "tiles-v1";
const DATA = "data-v1";

const PRECACHE = [
  "./",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "../build-wasm/pano.js",
  "../build-wasm/pano.wasm",
  "../data/fonts/Inter-Regular.woff2",
];

self.addEventListener("install", (e) => {
  // cache: "reload" bypasses the HTTP cache — without it, heuristic
  // freshness (nginx sends no Cache-Control) can fill a brand-new shell
  // cache with stale copies of app.js/pano.wasm from the browser cache.
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys())
      if (![SHELL, TILES, DATA].includes(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok) cache.put(req, resp.clone());
  return resp;
}

// Precached shell only: scene params make navigations carry query strings
// (?lat=...), which must still hit the precached "./"; cache misses go to
// the network without polluting the versioned shell cache.
async function shellFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || fetch(req);
}

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const refresh = fetch(req).then((resp) => {
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => hit);
  return hit || refresh;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/hgt3-zst/") || url.pathname.includes("/hgt-zst/")) {
    e.respondWith(cacheFirst(TILES, e.request));
  } else if (url.pathname.endsWith(".tsv")) {
    e.respondWith(staleWhileRevalidate(DATA, e.request));
  } else {
    e.respondWith(shellFirst(e.request));
  }
});
