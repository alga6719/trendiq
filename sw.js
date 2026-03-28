// TrendIQ Service Worker
// Strategy: network-first for API calls, cache-first for static assets

const CACHE_NAME = "trendiq-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        // Don't fail install if icons aren't present yet
        console.warn("[SW] Pre-cache partial failure:", err.message);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: route requests ─────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Always network-first for API routes and external data
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("coingecko") ||
    url.hostname.includes("binance") ||
    url.hostname.includes("kraken") ||
    url.hostname.includes("neon")
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for static HTML/assets (the app shell)
  event.respondWith(cacheFirst(event.request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    // Offline fallback — return cached version if available
    const cached = await caches.match(request);
    return cached || offlineFallback();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

function offlineFallback() {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>TrendIQ — Offline</title>
    <style>
      body{background:#0f1117;color:#e2e8f0;font-family:system-ui,sans-serif;
           display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center;padding:32px}
      h1{font-size:24px;margin-bottom:8px}
      p{color:#94a3b8;font-size:14px}
      button{margin-top:20px;padding:10px 24px;background:#8b5cf6;color:#fff;
             border:none;border-radius:8px;font-size:14px;cursor:pointer}
    </style></head>
    <body><div class="box">
      <h1>📡 No connection</h1>
      <p>TrendIQ needs internet access to fetch live prices.<br>Check your connection and try again.</p>
      <button onclick="location.reload()">Retry</button>
    </div></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
