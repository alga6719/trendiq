const Anthropic = require("@anthropic-ai/sdk");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI not configured — set ANTHROPIC_API_KEY in Vercel env vars" });
  }

  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages array required" });
  }

  // Build a rich system prompt from whatever live market data the client passed in
  const sys = [
    "You are TrendIQ AI, an expert crypto market analyst embedded in a live trading dashboard.",
    "Be concise (≤150 words), specific, and grounded in the data provided.",
    "Never present anything as financial advice — frame everything as observation and analysis.",
    "Use numbers from the live context when relevant. Do not make up prices or stats.",
  ];
  if (context?.prices)      sys.push("Current prices: "       + context.prices);
  if (context?.topMomentum) sys.push("Top momentum ticker: "  + context.topMomentum);
  if (context?.fearGreed)   sys.push("Fear & Greed index: "   + context.fearGreed);
  if (context?.signals)     sys.push("Active ML signals: "    + context.signals);
  if (context?.balance)     sys.push("User Kraken balance: "  + context.balance);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Stream plain-text deltas so the browser can read them with a ReadableStream reader
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const stream = client.messages.stream({
      model:      "claude-sonnet-4-6",
      max_tokens: 350,
      system:     sys.join(" "),
      messages:   messages.slice(-12),   // keep last 12 turns (6 round-trips)
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
        res.write(chunk.delta.text);
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.end();
    }
  }
};
