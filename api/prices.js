const https = require("https");
const url   = require("url");

const CG_KEY = process.env.CG_KEY || "";
const CG_IDS = "bitcoin,ethereum,solana,avalanche-2,binancecoin,arbitrum,optimism,dogwifcoin,jupiter";

module.exports = (req, res) => {
  // Let Vercel's CDN edge cache this for 60 s; serve stale for 120 s while revalidating
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  if (req.method === "OPTIONS") return res.status(200).end();

  const endpoint =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd" +
    "&ids=" + CG_IDS +
    "&order=market_cap_desc&per_page=20&sparkline=false&price_change_percentage=1h,24h,7d";

  const opts    = url.parse(endpoint);
  opts.headers  = { accept: "application/json" };
  if (CG_KEY) opts.headers["x-cg-demo-api-key"] = CG_KEY;

  https.get(opts, (cgRes) => {
    let body = "";
    cgRes.on("data", (c) => (body += c));
    cgRes.on("end", () => {
      try {
        const data = JSON.parse(body);
        res.status(200).json(data);
      } catch (e) {
        res.status(502).json({ error: "Invalid response from CoinGecko" });
      }
    });
  }).on("error", (e) => {
    res.status(502).json({ error: e.message });
  });
};
