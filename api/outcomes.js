// /api/outcomes.js — Trade outcome persistence via Neon Postgres
// GET  /api/outcomes  → returns last 500 outcomes ordered by timestamp desc
// POST /api/outcomes  → inserts a new outcome row

const { Client } = require("pg");

const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function getClient() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

// Create table on first use (idempotent)
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id          SERIAL PRIMARY KEY,
      pair        TEXT        NOT NULL,
      entry_score REAL        DEFAULT 0,
      buy_score   REAL        DEFAULT 0,
      pnl_pct     REAL        NOT NULL,
      pnl_usd     REAL        DEFAULT 0,
      exit_reason TEXT        DEFAULT 'unknown',
      duration_min INTEGER    DEFAULT 0,
      ts          BIGINT      NOT NULL,
      mode        TEXT        DEFAULT 'sim',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!DB_URL) {
    return res.status(503).json({ error: "Database not configured" });
  }

  let client;
  try {
    client = await getClient();
    await ensureTable(client);

    // ── GET: return last 500 outcomes ────────────────────────────────────────
    if (req.method === "GET") {
      const result = await client.query(
        `SELECT pair, entry_score AS "entryScore", buy_score AS "buyScore",
                pnl_pct AS "pnlPct", pnl_usd AS "pnlUsd",
                exit_reason AS "exitReason", duration_min AS "durationMin",
                ts AS timestamp, mode
         FROM trade_outcomes
         ORDER BY ts DESC
         LIMIT 500`
      );
      return res.status(200).json({ outcomes: result.rows });
    }

    // ── POST: insert a new outcome ───────────────────────────────────────────
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); }
        catch(e) { return res.status(400).json({ error: "Invalid JSON" }); }
      }
      if (!body || !body.pair || typeof body.pnlPct !== "number") {
        return res.status(400).json({ error: "Missing pair or pnlPct" });
      }

      await client.query(
        `INSERT INTO trade_outcomes
           (pair, entry_score, buy_score, pnl_pct, pnl_usd, exit_reason, duration_min, ts, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          body.pair,
          body.entryScore  || 0,
          body.buyScore    || 0,
          body.pnlPct,
          body.pnlUsd      || 0,
          body.exitReason  || "unknown",
          body.durationMin || 0,
          body.timestamp   || Date.now(),
          body.mode        || "sim",
        ]
      );

      // Keep only last 500 rows
      await client.query(
        `DELETE FROM trade_outcomes
         WHERE id NOT IN (
           SELECT id FROM trade_outcomes ORDER BY ts DESC LIMIT 500
         )`
      );

      return res.status(201).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    console.error("[outcomes]", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.end().catch(() => {});
  }
};
