// TrendIQ Service Worker v5
// Strategy: ALWAYS network-first for HTML (so updates show immediately),
//           network-first for APIs, cache-first only for icons/manifest

const CACHE_NAME = "trendiq-v5";

// ── Install: skip waiting immediately ────────────────────────────────────────
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// ── Activate: delete ALL old caches, claim clients ───────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: route requests ─────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache HTML — always fetch fresh from network
  if (url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // Always network-first for API routes and external data feeds
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("coingecko") ||
    url.hostname.includes("binance") ||
    url.hostname.includes("kraken") ||
    url.hostname.includes("neon") ||
    url.hostname.includes("alternative.me")
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first only for icons and manifest (rarely change)
  if (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.json") {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Everything else: network-first
  event.respondWith(networkFirst(event.request));
});

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallback();
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
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
