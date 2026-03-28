// /api/outcomes.js — Trade outcome persistence via Upstash KV (Redis REST API)
// GET  /api/outcomes            → returns last 500 outcomes as JSON array
// POST /api/outcomes            → appends a new outcome, trims to 500

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const LIST_KEY = "tiq_outcomes";
const MAX_ITEMS = 500;

async function kvCmd(...args) {
  // Upstash Redis REST: POST /pipeline or GET /<cmd>/<args...>
  const body = JSON.stringify(args);
  const r = await fetch(`${KV_URL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

async function kvPipeline(commands) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  return r.json();
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
    if (req.method === "GET") {
      // LRANGE tiq_outcomes 0 499  → most recent 500 items
      const r = await fetch(`${KV_URL}/lrange/${LIST_KEY}/0/${MAX_ITEMS - 1}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const d = await r.json();
      const items = (d.result || []).map(item => {
        try { return typeof item === "string" ? JSON.parse(item) : item; }
        catch(e) { return null; }
      }).filter(Boolean);
      return res.status(200).json({ outcomes: items });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch(e) { return res.status(400).json({ error: "Invalid JSON" }); }
      }
      if (!body || typeof body !== "object") {
        return res.status(400).json({ error: "Expected outcome object" });
      }

      // Validate required fields
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

      // LPUSH (prepend newest) + LTRIM to keep only MAX_ITEMS
      await kvPipeline([
        ["lpush", LIST_KEY, item],
        ["ltrim", LIST_KEY, 0, MAX_ITEMS - 1],
      ]);

      return res.status(201).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[outcomes]", e);
    return res.status(500).json({ error: e.message });
  }
};
