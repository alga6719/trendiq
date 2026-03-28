const crypto = require("crypto");
const https  = require("https");

const KR_KEY    = process.env.KR_KEY;
const KR_SECRET = process.env.KR_SECRET;

function krakenSign(path, nonce, postData) {
  const message      = nonce + postData;
  const secretBuffer = Buffer.from(KR_SECRET, "base64");
  const sha256Hash   = crypto.createHash("sha256").update(nonce + postData).digest();
  const hmac         = crypto.createHmac("sha512", secretBuffer);
  hmac.update(Buffer.from(path));
  hmac.update(sha256Hash);
  return hmac.digest("base64");
}

function krakenPost(path, params) {
  return new Promise((resolve, reject) => {
    // Multiply by 1000 for microsecond precision — prevents EAPI:Invalid nonce
    // when sequential calls land within the same millisecond on Vercel.
    const nonce    = (Date.now() * 1000).toString();
    params.nonce   = nonce;
    const postData = new URLSearchParams(params).toString();
    const sign     = krakenSign(path, nonce, postData);

    const options = {
      hostname: "api.kraken.com",
      path,
      method:  "POST",
      headers: {
        "API-Key":      KR_KEY,
        "API-Sign":     sign,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const { endpoint, params } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

  if (!KR_KEY || !KR_SECRET) {
    return res.status(503).json({ error: "Kraken API credentials not configured" });
  }

  const allowed = [
    "/0/private/Balance",
    "/0/private/OpenOrders",
    "/0/private/TradesHistory",
    "/0/private/ClosedOrders",
    "/0/private/AddOrder",
  ];
  if (!allowed.includes(endpoint)) {
    return res.status(403).json({ error: "Endpoint not allowed" });
  }

  // Validate AddOrder parameters before sending to Kraken
  if (endpoint === "/0/private/AddOrder") {
    const { pair, type, ordertype, volume } = params || {};
    if (!pair || !type || !ordertype || !volume) {
      return res.status(400).json({ error: "AddOrder requires: pair, type, ordertype, volume" });
    }
    if (!["buy", "sell"].includes(type)) {
      return res.status(400).json({ error: "type must be 'buy' or 'sell'" });
    }
    if (!["market", "limit"].includes(ordertype)) {
      return res.status(400).json({ error: "ordertype must be 'market' or 'limit'" });
    }
    if (isNaN(parseFloat(volume)) || parseFloat(volume) <= 0) {
      return res.status(400).json({ error: "volume must be a positive number" });
    }
  }

  try {
    const data = await krakenPost(endpoint, params || {});
    // Short log so it is not truncated in Vercel dashboard
    const resKeys = Object.keys(data.result || {}).slice(0,8).join(",") || "(empty)";
    const errStr  = (data.error && data.error.length) ? data.error.join("|") : "none";
    console.log(`KR:${endpoint.split("/").pop()} err=${errStr} res=${resKeys}`);
    res.status(200).json(data);
  } catch (e) {
    console.error(`[kraken] ${endpoint} threw:`, e.message);
    res.status(500).json({ error: e.message });
  }
};
