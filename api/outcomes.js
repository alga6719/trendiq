// /api/outcomes.js — Trade outcome persistence via Upstash KV (Redis REST API)
// GET  /api/outcomes  → returns last 500 outcomes as JSON array
// POST /api/outcomes  → appends a new outcome, trims list to 500

const https = require("https");
const url   = require("url");

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const LIST_KEY = "tiq_outcomes";
const MAX_ITEMS = 500;

function kvRequest(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    if (!KV_URL || !KV_TOKEN) {
      return reject(new Error("KV_REST_API_URL / KV_REST_API_TOKEN not set"));
    }
    const base    = KV_URL.replace(/\/$/, "");
    const fullUrl = base + path;
    const parsed  = url.parse(fullUrl);
    const body    = bodyObj ? JSON.stringify(bodyObj) : null;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.path,
      method:   method || "GET",
      headers: {
        "Authorization": "Bearer " + KV_TOKEN,
        "Content-Type":  "application/json",
      },
    };
    if (body) opts.headers["Content-Length"] = Buffer.byteLength(body);

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error));
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: "KV not configured" });
  }

  try {
    // ── GET: return stored outcomes ──────────────────────────────────────────
    if (req.method === "GET") {
      const result = await kvRequest(
        `/lrange/${encodeURIComponent(LIST_KEY)}/0/${MAX_ITEMS - 1}`,
        "GET"
      );
      const raw   = result.body.result || [];
      const items = raw.map(item => {
        try { return typeof item === "string" ? JSON.parse(item) : item; }
        catch(e) { return null; }
      }).filter(Boolean);
      return res.status(200).json({ outcomes: items });
    }

    // ── POST: append a new outcome ───────────────────────────────────────────
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch(e) {
          return res.status(400).json({ error: "Invalid JSON" });
        }
      }
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Expected outcome object" });
      }
      if (!body.pair || typeof body.pnlPct !== "number") {
        return res.status(400).json({ error: "Missing pair or pnlPct" });
      }

      const item = JSON.stringify({
        pair:        body.pair,
        entryScore:  body.entryScore  || 0,
        buyScore:    body.buyScore    || 0,
        pnlPct:      body.pnlPct,
        pnlUsd:      body.pnlUsd      || 0,
        exitReason:  body.exitReason  || "unknown",
        durationMin: body.durationMin || 0,
        timestamp:   body.timestamp   || Date.now(),
        mode:        body.mode        || "sim",
      });

      // LPUSH then LTRIM via pipeline
      await kvRequest("/pipeline", "POST", [
        ["lpush", LIST_KEY, item],
        ["ltrim", LIST_KEY, 0, MAX_ITEMS - 1],
      ]);

      return res.status(201).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    console.error("[outcomes]", e.message);
    return res.status(500).json({ error: e.message });
  }
};
