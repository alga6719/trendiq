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
    const nonce    = Date.now().toString();
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

  const allowed = [
    "/0/private/Balance",
    "/0/private/OpenOrders",
    "/0/private/TradesHistory",
    "/0/private/ClosedOrders",
  ];
  if (!allowed.includes(endpoint)) {
    return res.status(403).json({ error: "Endpoint not allowed" });
  }

  try {
    const data = await krakenPost(endpoint, params || {});
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
