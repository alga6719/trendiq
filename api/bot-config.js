// api/bot-config.js
// Manages server-side bot state in Neon Postgres.
// GET  → returns mode, enabled, strategies, positions (keys never exposed)
// POST → actions: set_mode | save_strategies | save_keys |
//                 upsert_position | close_position | update_last_run

const { Client } = require("pg");
const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function getClient() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bot_config (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      mode        TEXT    DEFAULT 'idle',
      enabled     BOOLEAN DEFAULT false,
      strategies  JSONB   DEFAULT '[]',
      kr_key      TEXT    DEFAULT '',
      kr_secret   TEXT    DEFAULT '',
      last_run    BIGINT  DEFAULT 0,
      last_run_log TEXT   DEFAULT '',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO bot_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS bot_positions (
      id            SERIAL  PRIMARY KEY,
      pos_key       TEXT    UNIQUE NOT NULL,
      pair          TEXT    NOT NULL,
      entry_price   REAL    NOT NULL,
      entry_time    BIGINT  NOT NULL,
      qty           REAL    DEFAULT 0,
      amount_usd    REAL    DEFAULT 100,
      take_profit   REAL    DEFAULT 3,
      stop_loss     REAL    DEFAULT -2,
      mode          TEXT    DEFAULT 'sim',
      entry_score   REAL    DEFAULT 0,
      strategy_name TEXT    DEFAULT '',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const client = await getClient();
  try {
    await ensureTables(client);

    // ── GET ─────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const cfgQ = await client.query(
        "SELECT mode, enabled, strategies, last_run, last_run_log, updated_at FROM bot_config WHERE id = 1"
      );
      const posQ = await client.query(
        "SELECT * FROM bot_positions ORDER BY entry_time DESC"
      );
      const cfg = cfgQ.rows[0] || { mode: "idle", enabled: false, strategies: [], last_run: 0, last_run_log: "" };

      const positions = {};
      posQ.rows.forEach(p => {
        positions[p.pos_key] = {
          stratName:  p.strategy_name,
          pair:       p.pair,
          entryPrice: p.entry_price,
          entryTime:  p.entry_time,
          qty:        p.qty,
          amount:     p.amount_usd,
          tp:         p.take_profit,
          sl:         p.stop_loss,
          mode:       p.mode,
          entryScore: p.entry_score
        };
      });

      res.status(200).json({
        mode:       cfg.mode,
        enabled:    cfg.enabled,
        strategies: cfg.strategies || [],
        positions,
        lastRun:    cfg.last_run    || 0,
        lastRunLog: cfg.last_run_log || "",
        updatedAt:  cfg.updated_at
      });
      return;
    }

    // ── POST ────────────────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body   = req.body || {};
      const action = body.action;

      // Set bot mode (live / sim / idle)
      if (action === "set_mode") {
        const mode    = ["live","sim","idle"].includes(body.mode) ? body.mode : "idle";
        const enabled = mode !== "idle";
        await client.query(
          "UPDATE bot_config SET mode=$1, enabled=$2, updated_at=NOW() WHERE id=1",
          [mode, enabled]
        );
        res.status(200).json({ ok: true, mode, enabled });
        return;
      }

      // Save full strategies array
      if (action === "save_strategies") {
        const strats = Array.isArray(body.strategies) ? body.strategies : [];
        await client.query(
          "UPDATE bot_config SET strategies=$1::jsonb, updated_at=NOW() WHERE id=1",
          [JSON.stringify(strats)]
        );
        res.status(200).json({ ok: true, count: strats.length });
        return;
      }

      // Save Kraken API keys (stored server-side so cron can use them)
      if (action === "save_keys") {
        await client.query(
          "UPDATE bot_config SET kr_key=$1, kr_secret=$2, updated_at=NOW() WHERE id=1",
          [body.key || "", body.secret || ""]
        );
        res.status(200).json({ ok: true });
        return;
      }

      // Upsert an open position (called when bot buys)
      if (action === "upsert_position") {
        const p = body.position || {};
        await client.query(`
          INSERT INTO bot_positions
            (pos_key, pair, entry_price, entry_time, qty, amount_usd,
             take_profit, stop_loss, mode, entry_score, strategy_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (pos_key) DO UPDATE SET
            pair          = EXCLUDED.pair,
            entry_price   = EXCLUDED.entry_price,
            entry_time    = EXCLUDED.entry_time,
            qty           = EXCLUDED.qty,
            amount_usd    = EXCLUDED.amount_usd,
            take_profit   = EXCLUDED.take_profit,
            stop_loss     = EXCLUDED.stop_loss,
            mode          = EXCLUDED.mode,
            entry_score   = EXCLUDED.entry_score,
            strategy_name = EXCLUDED.strategy_name
        `, [
          p.key, p.pair, p.entryPrice, p.entryTime,
          p.qty || 0, p.amount || 100,
          p.tp || 3, p.sl || -2,
          p.mode || "sim", p.entryScore || 0, p.stratName || ""
        ]);
        res.status(200).json({ ok: true });
        return;
      }

      // Remove a closed position
      if (action === "close_position") {
        await client.query("DELETE FROM bot_positions WHERE pos_key=$1", [body.key]);
        res.status(200).json({ ok: true });
        return;
      }

      // Update last cron run timestamp + log
      if (action === "update_last_run") {
        await client.query(
          "UPDATE bot_config SET last_run=$1, last_run_log=$2 WHERE id=1",
          [body.ts || Date.now(), (body.log || "").slice(0, 2000)]
        );
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: "Unknown action: " + action });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });

  } catch(e) {
    console.error("[bot-config]", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
};
