// api/bot.js
// Server-side auto-trader — runs as a Vercel Cron Job (or can be triggered manually).
// Logic mirrors the browser bot: fetch prices → score → check TP/SL → place orders.
//
// Cron schedule: see vercel.json
// Manual trigger: POST /api/bot  (no body needed; reads everything from DB)

const { Client } = require("pg");
const https      = require("https");
const crypto     = require("crypto");
const url        = require("url");

const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const CG_KEY = process.env.CG_KEY || "";

// ── Pair metadata ──────────────────────────────────────────────────────────────
const CG_IDS = "bitcoin,ethereum,solana,avalanche-2,binancecoin,arbitrum,optimism,dogwifcoin,jupiter";
const CG_MAP = {
  "bitcoin":     "BTC/USD",
  "ethereum":    "ETH/USD",
  "solana":      "SOL/USD",
  "avalanche-2": "AVAX/USD",
  "binancecoin": "BNB/USD",
  "arbitrum":    "ARB/USD",
  "optimism":    "OP/USD",
  "dogwifcoin":  "WIF/USD",
  "jupiter":     "JUP/USD"
};
// TrendIQ pair → Kraken API pair name
const KRAKEN_PAIR = {
  "BTC/USD":  "XBTUSD",
  "ETH/USD":  "XETHZUSD",
  "SOL/USD":  "SOLUSD",
  "AVAX/USD": "AVAXUSD",
  "BNB/USD":  "BNBUSD",
  "ARB/USD":  "ARBUSD",
  "OP/USD":   "OPUSD",
  "WIF/USD":  "WIFUSD",
  "JUP/USD":  "JUPUSD"
};

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function getClient() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

// ── CoinGecko price fetch ──────────────────────────────────────────────────────
function fetchPrices() {
  return new Promise((resolve, reject) => {
    const endpoint =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd" +
      "&ids=" + CG_IDS +
      "&order=market_cap_desc&per_page=20&sparkline=false" +
      "&price_change_percentage=1h,24h,7d";
    const opts    = url.parse(endpoint);
    opts.headers  = { accept: "application/json" };
    if (CG_KEY) opts.headers["x-cg-demo-api-key"] = CG_KEY;

    https.get(opts, (cgRes) => {
      let body = "";
      cgRes.on("data", c => body += c);
      cgRes.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error("CoinGecko parse error: " + e.message)); }
      });
    }).on("error", reject);
  });
}

// ── Multi-factor momentum score (mirrors calcRawMomentumScore in browser) ─────
function calcScore(d) {
  const chg24  = d.chg24  || 0;
  const chg1h  = d.chg1h  || 0;
  const chg7d  = d.chg7d  || 0;
  const vol    = d.vol    || 0;
  const price  = d.price  || 1;
  const high24 = d.high24 || price;
  const low24  = d.low24  || price;

  const volScore  = Math.min(5, vol / 500_000_000);
  const volPts    = volScore * 6;
  const trend24   = chg24 * 3.5;
  const mom1h     = chg1h * 8;

  let trendConf = 0;
  if (chg7d !== 0) {
    const agree = (chg24 >= 0 && chg7d >= 0) || (chg24 < 0 && chg7d < 0);
    trendConf   = agree ? Math.min(5, Math.abs(chg7d) * 0.3) : -Math.min(5, Math.abs(chg7d) * 0.3);
  }

  let volDamp = 0;
  const rangePct = (high24 - low24) / price * 100;
  if (rangePct > 15) volDamp = -(rangePct - 15) * 0.4;

  return Math.round(Math.min(99, Math.max(5, 50 + trend24 + volPts + mom1h + trendConf + volDamp)));
}

// ── Regime detection (mirrors browser detectMarketRegime) ─────────────────────
function detectRegime(priceData) {
  const scores = Object.values(priceData).map(d => d.score);
  if (!scores.length) return { name: "unknown", scoreAdj: 0, blockMomentum: false };
  const avg    = scores.reduce((a, b) => a + b, 0) / scores.length;
  const maxS   = Math.max(...scores);
  const minS   = Math.min(...scores);
  const spread = maxS - minS;

  if (spread > 40)  return { name: "high_vol",      label: "High Volatility", scoreAdj: -10, blockMomentum: false };
  if (avg >= 65)    return { name: "trending_up",   label: "Trending Up",     scoreAdj: +8,  blockMomentum: false };
  if (avg <= 35)    return { name: "trending_down", label: "Trending Down",   scoreAdj: -8,  blockMomentum: true  };
  return              { name: "ranging",          label: "Ranging",         scoreAdj: 0,   blockMomentum: false };
}

function getTradingSession() {
  const h = new Date().getUTCHours();
  if (h >= 0  && h < 8)  return { name: "asia",    caution: true  };
  if (h >= 8  && h < 13) return { name: "london",  caution: false };
  if (h >= 13 && h < 22) return { name: "ny",      caution: false };
  return                         { name: "overlap", caution: true  };
}

function isStrategyGated(strat, regime, session) {
  const name           = (strat.name || "").toLowerCase();
  const isMomentumLong = name.includes("momentum") || strat.mode === "buy";
  const isArb          = name.includes("arb") || name.includes("arbitrage");
  const isNeutral      = name.includes("neutral") || name.includes("mean");
  if (regime.blockMomentum && isMomentumLong && !isArb && !isNeutral) return true;
  if (session.caution && regime.name === "high_vol") {
    const pair = strat.pair || "";
    if (!pair.includes("BTC") && !pair.includes("ETH")) return true;
  }
  return false;
}

// ── Kraken order placement ─────────────────────────────────────────────────────
function krakenSign(path, nonce, postData, secret) {
  const secretBuffer = Buffer.from(secret, "base64");
  const sha256Hash   = crypto.createHash("sha256").update(nonce + postData).digest();
  const hmac         = crypto.createHmac("sha512", secretBuffer);
  hmac.update(Buffer.from(path));
  hmac.update(sha256Hash);
  return hmac.digest("base64");
}

function krakenPost(path, params, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const nonce    = (Date.now() * 1000).toString();
    params.nonce   = nonce;
    const postData = new URLSearchParams(params).toString();
    const sign     = krakenSign(path, nonce, postData, apiSecret);
    const options  = {
      hostname: "api.kraken.com",
      path,
      method:   "POST",
      headers:  {
        "API-Key":        apiKey,
        "API-Sign":       sign,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ── Save trade outcome to DB ───────────────────────────────────────────────────
async function saveOutcome(client, outcome) {
  await client.query(`
    INSERT INTO trade_outcomes
      (pair, entry_score, buy_score, pnl_pct, pnl_usd, exit_reason, duration_min, ts, mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [
    outcome.pair, outcome.entryScore || 0, outcome.buyScore || 0,
    outcome.pnlPct, outcome.pnlUsd || 0, outcome.exitReason || "server",
    outcome.durationMin || 0, outcome.timestamp, outcome.mode || "sim"
  ]);
}

// ── Main bot cycle ─────────────────────────────────────────────────────────────
async function runBotCycle(client) {
  const logs = [];
  const log  = (msg) => { logs.push(msg); console.log("[bot]", msg); };

  // 1. Load config
  const cfgQ = await client.query(
    "SELECT mode, enabled, strategies, kr_key, kr_secret FROM bot_config WHERE id=1"
  );
  const cfg = cfgQ.rows[0];
  if (!cfg || !cfg.enabled || cfg.mode === "idle") {
    log("Bot is idle — skipping cycle.");
    return logs;
  }

  const mode       = cfg.mode;          // "live" | "sim"
  const strategies = cfg.strategies || [];
  const krKey      = cfg.kr_key     || "";
  const krSecret   = cfg.kr_secret  || "";

  if (mode === "live" && (!krKey || !krSecret)) {
    log("ERROR: Live mode selected but Kraken keys not saved to server. Save keys in Settings.");
    return logs;
  }

  const enabled = strategies.filter(s => s.enabled);
  if (!enabled.length) {
    log("No enabled strategies — skipping.");
    return logs;
  }

  // 2. Fetch prices
  let priceData;
  try {
    const raw = await fetchPrices();
    priceData = {};
    raw.forEach(c => {
      const sym = CG_MAP[c.id];
      if (sym) {
        const d = {
          price:  c.current_price,
          chg24:  c.price_change_percentage_24h                   || 0,
          chg1h:  c.price_change_percentage_1h_in_currency        || 0,
          chg7d:  c.price_change_percentage_7d_in_currency        || 0,
          vol:    c.total_volume                                   || 0,
          high24: c.high_24h   || c.current_price,
          low24:  c.low_24h    || c.current_price
        };
        priceData[sym] = { ...d, score: calcScore(d) };
      }
    });
    log("Prices fetched: " + Object.keys(priceData).join(", "));
  } catch(e) {
    log("ERROR fetching prices: " + e.message);
    return logs;
  }

  // 3. Load open positions
  const posQ     = await client.query("SELECT * FROM bot_positions");
  const positions = {};
  posQ.rows.forEach(p => { positions[p.pos_key] = p; });

  // 4. Detect market regime + session once per cycle
  const regime  = detectRegime(priceData);
  const session = getTradingSession();
  log("Regime: " + regime.label + " (scoreAdj " + (regime.scoreAdj >= 0 ? "+" : "") + regime.scoreAdj + ") · Session: " + session.name);

  // 5. Process each enabled strategy
  for (const strat of enabled) {
    const pair    = strat.pair;
    const posKey  = strat.name + "|" + pair;
    const mkt     = priceData[pair];
    if (!mkt) { log("No price data for " + pair + " — skip"); continue; }

    const price = mkt.price;
    const score = mkt.score;
    const pos   = positions[posKey] || null;

    if (pos) {
      // ── Check open position: TP / SL / sell-signal ────────────────────────
      const pctChg = ((price - pos.entry_price) / pos.entry_price) * 100;
      const tpHit  = pctChg >= pos.take_profit;
      const slHit  = pctChg <= pos.stop_loss;
      const sigSell = score <= (strat.sellScore || 40);

      if (tpHit || slHit || sigSell) {
        const reason = tpHit  ? ("TP +" + pos.take_profit + "%")
                     : slHit  ? ("SL "  + pos.stop_loss + "%")
                     : ("SellSig " + score + "/100");

        let txId = "sim";
        if (mode === "live") {
          try {
            const vol = pos.qty.toFixed(8);
            const r   = await krakenPost(
              "/0/private/AddOrder",
              { pair: KRAKEN_PAIR[pair] || pair, type: "sell", ordertype: "market", volume: vol },
              krKey, krSecret
            );
            if (r.error && r.error.length) throw new Error(r.error.join(", "));
            txId = (r.result && r.result.txid) ? r.result.txid[0] : "?";
          } catch(e) {
            log("SELL FAILED " + pair + ": " + e.message + " — position kept open");
            continue;
          }
        }

        const pnlUsd = (price - pos.entry_price) * pos.qty;
        const pnlPct = parseFloat(pctChg.toFixed(3));
        const pnlStr = (pnlUsd >= 0 ? "+" : "") + "$" + Math.abs(pnlUsd).toFixed(2) +
                       " (" + (pnlPct >= 0 ? "+" : "") + pnlPct + "%)";
        log((mode === "live" ? "LIVE" : "SIM") + " SELL " + pair + " @ $" + price.toFixed(2) +
            "  P&L: " + pnlStr + "  Reason: " + reason + (mode === "live" ? "  txid:" + txId : ""));

        // Close position in DB
        await client.query("DELETE FROM bot_positions WHERE pos_key=$1", [posKey]);

        // Record outcome for ML
        try {
          await saveOutcome(client, {
            pair,
            entryScore:  pos.entry_score || 0,
            buyScore:    strat.buyScore  || 0,
            pnlPct,
            pnlUsd:      parseFloat(pnlUsd.toFixed(2)),
            exitReason:  reason.split(" ")[0],
            durationMin: Math.round((Date.now() - pos.entry_time) / 60000),
            timestamp:   Date.now(),
            mode
          });
        } catch(e) { log("Outcome save failed: " + e.message); }
      }

    } else {
      // ── Regime + session gate ─────────────────────────────────────────────
      if (isStrategyGated(strat, regime, session)) {
        log("GATED  " + strat.name + " (" + pair + ") — " + regime.label + " / " + session.name);
        continue;
      }

      // ── Check buy signal (with regime score adjustment) ───────────────────
      const adjustedScore = Math.max(0, Math.min(100, score + (regime.scoreAdj || 0)));
      if (adjustedScore >= (strat.buyScore || 70)) {
        const qty    = (strat.amount || 100) / price;

        let txId = "sim";
        if (mode === "live") {
          try {
            const r = await krakenPost(
              "/0/private/AddOrder",
              { pair: KRAKEN_PAIR[pair] || pair, type: "buy", ordertype: "market", volume: qty.toFixed(8) },
              krKey, krSecret
            );
            if (r.error && r.error.length) throw new Error(r.error.join(", "));
            txId = (r.result && r.result.txid) ? r.result.txid[0] : "?";
          } catch(e) {
            log("BUY FAILED " + pair + ": " + e.message);
            continue;
          }
        }

        const scoreLabel = adjustedScore !== score ? score + "→" + adjustedScore : String(score);
        log((mode === "live" ? "LIVE" : "SIM") + " BUY  " + pair + " @ $" + price.toFixed(2) +
            "  Score:" + scoreLabel + "/" + strat.buyScore + "  $" + (strat.amount || 100) +
            (mode === "live" ? "  txid:" + txId : ""));

        // Save position to DB
        await client.query(`
          INSERT INTO bot_positions
            (pos_key, pair, entry_price, entry_time, qty, amount_usd,
             take_profit, stop_loss, mode, entry_score, strategy_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (pos_key) DO NOTHING
        `, [
          posKey, pair, price, Date.now(), qty,
          strat.amount || 100, strat.takeProfit || strat.tp || 3,
          strat.stopLoss || strat.sl || -2, mode, adjustedScore, strat.name
        ]);
      }
    }
  }

  log("Cycle complete. " + Object.keys(positions).length + " positions open.");
  return logs;
}

// ── Vercel handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Vercel calls crons with GET; UI "Run Now" button uses POST
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" }); return;
  }

  const client = await getClient();
  try {
    const logs = await runBotCycle(client);
    const ts   = Date.now();

    // Persist log for UI display
    await client.query(
      "UPDATE bot_config SET last_run=$1, last_run_log=$2 WHERE id=1",
      [ts, logs.join("\n").slice(0, 2000)]
    );

    res.status(200).json({ ok: true, ts, log: logs });
  } catch(e) {
    console.error("[bot cron]", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
};
