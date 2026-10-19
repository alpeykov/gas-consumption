// Bump VERSION on every release: a changed sw.js is what makes installed apps show "Update available".
const VERSION = "1.9.5";
const CACHE = "gas-bill-" + VERSION;
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192-v2.png",
  "./icons/icon-512-v2.png",
  "./icons/icon-maskable-512-v2.png",
  "./icons/apple-touch-icon-v2.png",
  "./icons/favicon-64-v2.png",
  "./icons/bill-new-reading.png",
  "./data/prices.json",
  "./data/gcv.json",
  "./data/price-history.json",
  "./data/price-chart.json",
];

self.addEventListener("install", (event) => {
  // No skipWaiting here: the new version waits until the user taps "Reload".
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("gas-bill-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
  if (event.data === "version") event.source.postMessage({ version: VERSION });
});

// App files come from the cache of the installed version; overgas.bg, fonts and pdf.js go to the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Always fetch the manifest and the price/kWh data fresh; the cached copy is only an offline fallback.
  if (url.pathname.endsWith("/manifest.webmanifest") || url.pathname.includes("/data/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request, { ignoreSearch: true })));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
    )
  );
});
