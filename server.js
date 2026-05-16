import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/index.html');
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function edamamNutrientQuantity(totalNutrients, code) {
  const n = totalNutrients && totalNutrients[code];
  return n && typeof n.quantity === "number" ? n.quantity : null;
}

/** Proxy to Edamam Nutrition Analysis — keeps app_id / app_key on the server only. */
app.post("/api/nutrition", async (req, res) => {
  try {
    const appId = process.env.EDAMAM_APP_ID;
    const appKey = process.env.EDAMAM_APP_KEY;
    if (!appId || !appKey) {
      return res.status(503).json({ error: "Edamam credentials not configured" });
    }

    const title =
      (req.body && typeof req.body.title === "string" && req.body.title.trim()) ||
      "Recipe";
    const ingr = Array.isArray(req.body && req.body.ingr) ? req.body.ingr : [];
    const cleanIngr = ingr
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    if (!cleanIngr.length) {
      return res.status(400).json({ error: "ingr must be a non-empty array of strings" });
    }

    const url = new URL("https://api.edamam.com/api/nutrition-details");
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);

    const edResp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, ingr: cleanIngr }),
    });

    if (edResp.status === 304) {
      return res.status(200).json({
        totalNutrients: null,
        notModified: true,
        message: "Use cached nutrition for this recipe fingerprint",
      });
    }

    const rawText = await edResp.text();
    if (!edResp.ok) {
      console.error("Edamam nutrition-details", edResp.status, rawText.slice(0, 400));
      return res.status(edResp.status >= 400 && edResp.status < 600 ? edResp.status : 502).json({
        error: "Edamam request failed",
        detail: rawText.slice(0, 300),
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from Edamam" });
    }

    const tn = data.totalNutrients || {};
    const kcal = edamamNutrientQuantity(tn, "ENERC_KCAL");
    const protein = edamamNutrientQuantity(tn, "PROCNT");
    const fat = edamamNutrientQuantity(tn, "FAT");
    const carbs =
      edamamNutrientQuantity(tn, "CHOCDF") ?? edamamNutrientQuantity(tn, "CHOCDF.net");

    res.json({
      totalNutrients: {
        calories: kcal != null ? Math.round(kcal) : null,
        protein: protein != null ? Math.round(protein * 10) / 10 : null,
        fat: fat != null ? Math.round(fat * 10) / 10 : null,
        carbs: carbs != null ? Math.round(carbs * 10) / 10 : null,
      },
    });
  } catch (err) {
    console.error("/api/nutrition", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/ai", async (req, res) => {
  try {
    const messages =
      req.body.messages && req.body.messages.length > 0
        ? req.body.messages
        : [
            {
              role: "user",
              content: req.body.userMsg || "Give me a healthy recipe",
            },
          ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
    });

    res.json({
      content: [
        {
          type: "text",
          text: completion.choices[0].message.content,
        },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ─────────────────────────────────────────────────────────────
   Grocery Intelligence V1 — Kroger Products API integration
   Credentials live ONLY in process.env. The frontend never sees
   the client id/secret or the access token.
   ───────────────────────────────────────────────────────────── */

const KROGER_BASE = "https://api.kroger.com/v1";
const KROGER_SCOPE = "product.compact";

// Token cache (in-memory; single Render instance)
let krogerTokenCache = { token: null, expiresAt: 0 };

// Product cache: `${locationId}|${term}` -> { value, expiresAt }
const krogerProductCache = new Map();
const PRODUCT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Location cache: zipCode -> { value, expiresAt }
const krogerLocationCache = new Map();
const LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function krogerCredsConfigured() {
  return !!(process.env.KROGER_CLIENT_ID && process.env.KROGER_CLIENT_SECRET);
}

async function getKrogerToken() {
  const now = Date.now();
  if (krogerTokenCache.token && krogerTokenCache.expiresAt > now + 5_000) {
    return krogerTokenCache.token;
  }
  if (!krogerCredsConfigured()) {
    throw new Error("Kroger credentials not configured on server");
  }

  const basic = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: KROGER_SCOPE,
  });

  const resp = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Kroger token error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const ttlMs = Math.max(60_000, (data.expires_in || 1800) * 1000 - 60_000);
  krogerTokenCache = {
    token: data.access_token,
    expiresAt: now + ttlMs,
  };
  return krogerTokenCache.token;
}

async function krogerGet(path, params) {
  const token = await getKrogerToken();
  const url = new URL(KROGER_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (resp.status === 401) {
    krogerTokenCache = { token: null, expiresAt: 0 };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `Kroger ${path} ${resp.status}: ${text.slice(0, 200)}`
    );
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function normalizeZip(zip) {
  const s = String(zip || "").trim();
  const m = s.match(/\d{5}/);
  return m ? m[0] : "";
}

async function findKrogerLocation(zipCode) {
  const zip = normalizeZip(zipCode);
  if (!zip) return null;

  const cached = krogerLocationCache.get(zip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const data = await krogerGet("/locations", {
    "filter.zipCode.near": zip,
    "filter.limit": 1,
  });
  const loc = (data && data.data && data.data[0]) || null;
  if (!loc) return null;

  const out = {
    locationId: loc.locationId,
    name: loc.name,
    chain: loc.chain,
    address: loc.address && {
      addressLine1: loc.address.addressLine1,
      city: loc.address.city,
      state: loc.address.state,
      zipCode: loc.address.zipCode,
    },
  };
  krogerLocationCache.set(zip, {
    value: out,
    expiresAt: Date.now() + LOCATION_TTL_MS,
  });
  return out;
}

function pickBestKrogerItem(products) {
  if (!Array.isArray(products) || !products.length) return null;
  let best = null;

  for (const p of products) {
    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      const price = it && it.price;
      const reg = price && typeof price.regular === "number" ? price.regular : 0;
      const promo =
        price && typeof price.promo === "number" && price.promo > 0
          ? price.promo
          : 0;
      const effective = promo > 0 ? promo : reg;
      if (!(effective > 0)) continue;

      const candidate = {
        productId: p.productId,
        upc: p.upc,
        name: p.description,
        brand: p.brand,
        size: it.size || "",
        priceRegular: reg || null,
        pricePromo: promo || null,
        priceEffective: effective,
        image: pickKrogerImage(p),
        soldBy: it.soldBy || null,
      };

      if (!best || effective < best.priceEffective) best = candidate;
    }
  }
  return best;
}

function pickKrogerImage(product) {
  const imgs = Array.isArray(product.images) ? product.images : [];
  const front = imgs.find((i) => i.perspective === "front") || imgs[0];
  if (!front || !Array.isArray(front.sizes) || !front.sizes.length) return null;
  // Prefer medium/small for thumbnails
  const order = ["medium", "small", "thumbnail", "large", "xlarge"];
  for (const s of order) {
    const hit = front.sizes.find((x) => x.size === s);
    if (hit && hit.url) return hit.url;
  }
  return front.sizes[0].url || null;
}

async function searchKrogerProduct(term, locationId) {
  const cleanTerm = String(term || "").trim();
  if (!cleanTerm) return null;
  const cacheKey = `${locationId || "_"}|${cleanTerm.toLowerCase()}`;
  const cached = krogerProductCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const params = {
    "filter.term": cleanTerm,
    "filter.limit": 8,
  };
  if (locationId) params["filter.locationId"] = locationId;

  let data;
  try {
    data = await krogerGet("/products", params);
  } catch (err) {
    // 4xx with no results — cache a null briefly so we don't hammer
    if (err.status && err.status >= 400 && err.status < 500) {
      krogerProductCache.set(cacheKey, {
        value: null,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return null;
    }
    throw err;
  }

  const best = pickBestKrogerItem(data && data.data);
  const out = best
    ? {
        matched: true,
        term: cleanTerm,
        locationId: locationId || null,
        ...best,
        source: "kroger",
      }
    : null;

  krogerProductCache.set(cacheKey, {
    value: out,
    expiresAt: Date.now() + PRODUCT_TTL_MS,
  });
  return out;
}

// Bounded-concurrency map (no extra deps)
async function mapWithLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { __error: err.message || String(err) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  return out;
}

app.get("/api/kroger/location", async (req, res) => {
  try {
    if (!krogerCredsConfigured()) {
      return res.status(503).json({ error: "Kroger not configured" });
    }
    const loc = await findKrogerLocation(req.query.zipCode);
    if (!loc) return res.status(404).json({ error: "No nearby Kroger store" });
    res.json(loc);
  } catch (err) {
    console.error("kroger/location", err);
    res.status(500).json({ error: "Kroger location lookup failed" });
  }
});

/** Live grocery shelf lookup — v1 uses one regional integration; add providers behind this handler over time. */
async function handleLiveGroceryPrices(req, res) {
  try {
    if (!krogerCredsConfigured()) {
      return res.status(503).json({ error: "Grocery pricing not configured" });
    }

    const items = Array.isArray(req.body && req.body.items)
      ? req.body.items
      : [];
    if (!items.length) return res.json({ results: {}, locationId: null });

    // Resolve location: explicit id wins, else derive from zipCode
    let locationId = (req.body.locationId || "").toString().trim() || null;
    let locationInfo = null;
    if (!locationId && req.body.zipCode) {
      locationInfo = await findKrogerLocation(req.body.zipCode);
      if (locationInfo) locationId = locationInfo.locationId;
    }

    // De-dupe terms to reduce upstream calls while preserving per-key mapping
    const termIndex = new Map(); // termLower -> [keys]
    const uniqueTerms = [];
    for (const it of items) {
      const key = String(it.key || "").trim();
      const term = String(it.term || "").trim();
      if (!key || !term) continue;
      const tl = term.toLowerCase();
      if (!termIndex.has(tl)) {
        termIndex.set(tl, { term, keys: [] });
        uniqueTerms.push(tl);
      }
      termIndex.get(tl).keys.push(key);
    }

    const lookups = await mapWithLimit(uniqueTerms, 4, (tl) =>
      searchKrogerProduct(termIndex.get(tl).term, locationId)
    );

    const results = {};
    uniqueTerms.forEach((tl, i) => {
      const entry = termIndex.get(tl);
      const value = lookups[i] && !lookups[i].__error ? lookups[i] : null;
      for (const key of entry.keys) results[key] = value;
    });

    res.json({
      locationId,
      location: locationInfo,
      results,
    });
  } catch (err) {
    console.error("grocery/prices", err);
    res.status(500).json({ error: "Grocery price lookup failed" });
  }
}

app.post("/api/grocery/prices", handleLiveGroceryPrices);
app.post("/api/kroger/prices", handleLiveGroceryPrices);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
