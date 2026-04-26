const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "10mb" }));

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "roamy-secret-2024-change-this";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://roamyclone.edgeone.app";
const BACKEND_URL = process.env.BACKEND_URL || "https://roamy-backend.onrender.com";
if (!process.env.JWT_SECRET) console.warn("WARNING: JWT_SECRET env var not set, using insecure default");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── DB SETUP ──────────────────────────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS places (
      id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS collection_invites (
      id SERIAL PRIMARY KEY,
      collection_id TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      invitee_email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      accepted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shared_collections (
      collection_id TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      viewer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (collection_id, owner_id, viewer_id)
    );
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS collab_collections (
      collab_token TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      shared_state JSONB NOT NULL DEFAULT '{"sections":[],"sectionMap":{}}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE collab_collections ADD COLUMN IF NOT EXISTS shared_state JSONB NOT NULL DEFAULT '{"sections":[],"sectionMap":{}}'::jsonb;
    CREATE TABLE IF NOT EXISTS collab_places (
      id TEXT PRIMARY KEY,
      collab_token TEXT NOT NULL REFERENCES collab_collections(collab_token) ON DELETE CASCADE,
      added_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_by_name TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_collections_owner ON collab_collections (collection_id, owner_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_invites_unique ON collection_invites (collection_id, owner_id, invitee_email);
  `);
  console.log("DB setup complete");
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  var token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post("/auth/register", async (req, res) => {
  var { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    var hash = await bcrypt.hash(password, 10);
    var result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
      [email.toLowerCase().trim(), hash]
    );
    var user = result.rows[0];
    var token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "90d" });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch(e) {
    if (e.code === "23505") return res.status(400).json({ error: "Email already registered" });
    console.error("Register error:", e.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  var { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    var result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
    var user = result.rows[0];
    var valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    var token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "90d" });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch(e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ── SYNC ROUTES ───────────────────────────────────────────────────────────────

// Get all user data
app.get("/sync", authMiddleware, async (req, res) => {
  try {
    var placesRes = await pool.query("SELECT data FROM places WHERE user_id = $1 ORDER BY created_at ASC", [req.user.id]);

    // Get own collections, injecting collabToken if enabled
    var colsRes = await pool.query(`
      SELECT c.data, cc.collab_token
      FROM collections c
      LEFT JOIN collab_collections cc ON cc.collection_id = c.data->>'id' AND cc.owner_id = c.user_id
      WHERE c.user_id = $1
      ORDER BY c.created_at ASC
    `, [req.user.id]);

    var collections = colsRes.rows.map(function(r) {
      var col = r.data;
      if (r.collab_token) col = Object.assign({}, col, { collabToken: r.collab_token });
      return col;
    });

    // Get collab collections this user has joined (stored in their own collections table with isCollab flag)
    // These are already included above since we save them via /sync POST

    res.json({
      places: placesRes.rows.map(function(r){ return r.data; }),
      collections: collections
    });
  } catch(e) {
    console.error("Sync error:", e.message);
    res.status(500).json({ error: "Sync failed" });
  }
});

// Full sync push (upsert all places + collections)
app.post("/sync", authMiddleware, async (req, res) => {
  var { places, collections } = req.body;
  var client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (places && places.length) {
      for (var p of places) {
        await client.query(
          "INSERT INTO places (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id, user_id) DO UPDATE SET data = $3",
          [p.id, req.user.id, JSON.stringify(p)]
        );
      }
    }
    if (collections && collections.length) {
      for (var c of collections) {
        await client.query(
          "INSERT INTO collections (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id, user_id) DO UPDATE SET data = $3",
          [c.id, req.user.id, JSON.stringify(c)]
        );
      }
    }
    await client.query("COMMIT");
    res.json({ success: true });
  } catch(e) {
    await client.query("ROLLBACK");
    console.error("Sync push error:", e.message);
    res.status(500).json({ error: "Sync failed" });
  } finally {
    client.release();
  }
});

// Upsert single place
app.post("/places", authMiddleware, async (req, res) => {
  var place = req.body.place;
  if (!place || !place.id) return res.status(400).json({ error: "No place" });
  try {
    await pool.query(
      "INSERT INTO places (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id, user_id) DO UPDATE SET data = $3",
      [place.id, req.user.id, JSON.stringify(place)]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete place
app.delete("/places/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM places WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Upsert collection
app.post("/collections", authMiddleware, async (req, res) => {
  var col = req.body.collection;
  if (!col || !col.id) return res.status(400).json({ error: "No collection" });
  try {
    await pool.query(
      "INSERT INTO collections (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id, user_id) DO UPDATE SET data = $3",
      [col.id, req.user.id, JSON.stringify(col)]
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete collection
app.delete("/collections/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM collections WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    await pool.query("DELETE FROM collection_invites WHERE collection_id = $1 AND owner_id = $2", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── INVITES ───────────────────────────────────────────────────────────────────
app.post("/collections/:id/invite", authMiddleware, async (req, res) => {
  var { email } = req.body;
  var colId = req.params.id;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    // Check collection exists and belongs to user
    var colRes = await pool.query("SELECT id FROM collections WHERE id = $1 AND user_id = $2", [colId, req.user.id]);
    if (!colRes.rows.length) return res.status(404).json({ error: "Collection not found" });
    // Create invite token
    var token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      "INSERT INTO collection_invites (collection_id, owner_id, invitee_email, token) VALUES ($1, $2, $3, $4) ON CONFLICT (collection_id, owner_id, invitee_email) DO UPDATE SET token = EXCLUDED.token, accepted = FALSE",
      [colId, req.user.id, email.toLowerCase().trim(), token]
    );
    var inviteUrl = FRONTEND_URL + "/?invite=" + token;
    res.json({ success: true, inviteUrl, token });
  } catch(e) {
    console.error("Invite error:", e.message);
    res.status(500).json({ error: "Invite failed" });
  }
});

// Accept invite
app.get("/invites/:token", authMiddleware, async (req, res) => {
  try {
    var inviteRes = await pool.query("SELECT * FROM collection_invites WHERE token = $1", [req.params.token]);
    if (!inviteRes.rows.length) return res.status(404).json({ error: "Invite not found or expired" });
    var invite = inviteRes.rows[0];
    // Add to shared_collections
    await pool.query(
      "INSERT INTO shared_collections (collection_id, owner_id, viewer_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [invite.collection_id, invite.owner_id, req.user.id]
    );
    await pool.query("UPDATE collection_invites SET accepted = TRUE WHERE token = $1", [req.params.token]);
    // Return the collection data
    var colRes = await pool.query("SELECT data FROM collections WHERE id = $1 AND user_id = $2", [invite.collection_id, invite.owner_id]);
    res.json({ success: true, collection: colRes.rows[0]?.data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCRAPER ───────────────────────────────────────────────────────────────────
const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function scrape(url) {
  var caption = "", author = "";
  if (/instagram\.com/i.test(url)) {
    try { var r = await axios.get("https://www.instagram.com/api/v1/oembed/?url=" + encodeURIComponent(url), { headers: SCRAPE_HEADERS, timeout: 10000 }); caption = r.data.title || ""; author = r.data.author_name || ""; } catch(e) {}
    if (!caption) { try { var r2 = await axios.get(url, { headers: SCRAPE_HEADERS, timeout: 12000 }); var m = r2.data.match(/property="og:description"[^>]+content="([^"]+)"/i) || r2.data.match(/content="([^"]+)"[^>]+property="og:description"/i); if (m) caption = m[1]; } catch(e) {} }
  } else if (/tiktok\.com/i.test(url)) {
    try { var r = await axios.get("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), { headers: SCRAPE_HEADERS, timeout: 10000 }); caption = r.data.title || ""; author = r.data.author_name || ""; } catch(e) {}
  } else if (/youtube\.com|youtu\.be/i.test(url)) {
    try { var fullUrl = url; if (/youtu\.be\//.test(url)) { var id = url.match(/youtu\.be\/([^?&]+)/); if (id) fullUrl = "https://www.youtube.com/watch?v=" + id[1]; } var r = await axios.get("https://www.youtube.com/oembed?url=" + encodeURIComponent(fullUrl) + "&format=json", { headers: SCRAPE_HEADERS, timeout: 10000 }); caption = r.data.title || ""; author = r.data.author_name || ""; } catch(e) {}
  }
  return { caption, author };
}

function extractJSON(text) {
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  var start = text.indexOf("["), objStart = text.indexOf("{");
  if (start !== -1 && (objStart === -1 || start < objStart)) {
    var end = text.lastIndexOf("]");
    if (end !== -1) { try { return JSON.parse(text.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1")); } catch(e) {} }
  }
  if (objStart !== -1) {
    var end2 = text.lastIndexOf("}");
    if (end2 !== -1) { try { return [JSON.parse(text.slice(objStart, end2 + 1).replace(/,(\s*[}\]])/g, "$1"))]; } catch(e) {} }
  }
  throw new Error("Could not parse AI response");
}

async function askAI(text) {
  var prompt = `You are a travel place extraction AI. Extract ALL travel places mentioned and return ONLY a valid JSON array (no markdown):
[{"name":"exact venue name","city":"city","country":"full english country name","type":"restaurant or cafe or bar or hotel or museum or beach or park or market or shop or temple or church or viewpoint or attraction or neighborhood or nature or spa or club or island or waterfall or castle or gallery or winery or brewery or rooftop or lake or cave or default","description":"2-3 sentences about what makes this place special","lat":0.0,"lng":0.0}]
Rules: precise real coordinates, full English country name, max 6 places, never empty array.
Text: ` + text;

  var res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "openrouter/auto",
    messages: [{ role: "system", content: "You are a JSON-only API. Return ONLY a valid JSON array. No markdown, no explanation." }, { role: "user", content: prompt }],
    max_tokens: 1500, temperature: 0.1,
  }, { headers: { "Authorization": "Bearer " + OPENROUTER_KEY, "Content-Type": "application/json", "HTTP-Referer": "https://roamyclone.edgeone.app", "X-Title": "Roamy" }, timeout: 30000 });

  var raw = res.data.choices[0].message.content;
  return extractJSON(raw);
}

async function searchGooglePlace(query) {
  try {
    var url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=" + encodeURIComponent(query) + "&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,formatted_address,photos,opening_hours,price_level&key=" + GOOGLE_KEY;
    var res = await axios.get(url, { timeout: 8000 });
    if (res.data.error_message) console.error("Google error:", res.data.error_message);
    var candidates = res.data.candidates;
    return (candidates && candidates.length > 0) ? candidates[0] : null;
  } catch(e) { return null; }
}

async function getGoogleData(name, city, country) {
  var queries = [name + " " + city + " " + country, name + " " + city, name + " " + country, name].filter(function(q) { return q.trim().length > 3; });
  var place = null;
  for (var i = 0; i < queries.length; i++) { place = await searchGooglePlace(queries[i]); if (place) break; }
  if (!place) return null;
  var photoUrl = null;
  if (place.photos && place.photos.length > 0) photoUrl = BACKEND_URL + "/photo?ref=" + encodeURIComponent(place.photos[0].photo_reference);
  return { rating: place.rating || null, totalRatings: place.user_ratings_total || null, address: place.formatted_address || null, photoUrl, openNow: place.opening_hours ? place.opening_hours.open_now : null, priceLevel: place.price_level || null };
}

app.get("/photo", async (req, res) => {
  var ref = req.query.ref;
  if (!ref) return res.status(400).send("No ref");
  try {
    var photoRes = await axios.get("https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=" + ref + "&key=" + GOOGLE_KEY, { responseType: "arraybuffer", timeout: 10000, maxRedirects: 5 });
    res.set("Content-Type", photoRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(photoRes.data);
  } catch(e) { res.status(500).send("Photo failed"); }
});

app.post("/extract", authMiddleware, async (req, res) => {
  var input = req.body.input;
  if (!input || !input.trim()) return res.status(400).json({ error: "No input provided" });
  var trimmed = input.trim();
  var isUrl = /^https?:\/\//i.test(trimmed);
  var context = trimmed;
  if (isUrl) {
    try { var scraped = await scrape(trimmed); console.log("Caption:", scraped.caption.slice(0, 100)); if (scraped.caption) context = "URL: " + trimmed + "\nCaption: " + scraped.caption + "\nAuthor: " + scraped.author; } catch(e) {}
  }
  var aiPlaces;
  try { aiPlaces = await askAI(context); console.log("AI found", aiPlaces.length, "places"); } catch(e) { return res.status(500).json({ error: "Could not identify any places." }); }
  var enriched = await Promise.all(aiPlaces.map(async function(place) {
    try { var g = await getGoogleData(place.name, place.city, place.country); if (g) Object.assign(place, g); } catch(e) {}
    return place;
  }));
  res.json({ success: true, places: enriched });
});

// ── AI COVER IMAGE GENERATION via Unsplash ────────────────────────────────────
app.post("/generate-cover", authMiddleware, async (req, res) => {
  var { collectionName, places } = req.body;
  if (!collectionName) return res.status(400).json({ error: "Collection name required" });

  // Build search query from destinations
  var destinations = [];
  (places || []).forEach(function(p) {
    if (p.city) destinations.push(p.city);
    else if (p.country) destinations.push(p.country);
  });
  var uniqueDests = [...new Set(destinations)];
  
  // Use first destination or collection name as search query
  var query = uniqueDests.length > 0 ? uniqueDests[0] : collectionName;
  query = query + " travel landscape";

  console.log("Fetching Unsplash cover for:", query);

  try {
    var url = "https://api.unsplash.com/photos/random?query=" + encodeURIComponent(query) + "&orientation=landscape&content_filter=high&client_id=" + process.env.UNSPLASH_KEY;
    
    var response = await axios.get(url, { timeout: 10000 });
    var photo = response.data;
    var imageUrl = photo?.urls?.regular || photo?.urls?.full;
    
    if (!imageUrl) return res.status(500).json({ error: "No image found" });
    
    console.log("Cover found:", imageUrl.slice(0, 80));
    res.json({ success: true, imageUrl, credit: photo?.user?.name || "Unsplash" });

  } catch(e) {
    // Fallback: use Unsplash source (no API key needed, just redirect)
    console.log("Unsplash API error, using source fallback:", e.message);
    var fallbackQuery = encodeURIComponent(query);
    var seed = Math.floor(Math.random() * 1000);
    // Return a Unsplash source URL that resolves to a real image
    var imageUrl = "https://source.unsplash.com/1200x800/?" + fallbackQuery + "&sig=" + seed;
    res.json({ success: true, imageUrl });
  }
});

// ── SHORT SHARE LINKS ─────────────────────────────────────────────────────────
app.post("/share", authMiddleware, async (req, res) => {
  var data = req.body.data;
  if (!data) return res.status(400).json({ error: "No data" });
  var token = crypto.randomBytes(5).toString("hex");
  try {
    await pool.query("INSERT INTO shares (token, data) VALUES ($1, $2)", [token, JSON.stringify(data)]);
    res.json({ success: true, token, url: FRONTEND_URL + "/?s=" + token });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/share/:token", async (req, res) => {
  try {
    var result = await pool.query("SELECT data FROM shares WHERE token = $1", [req.params.token]);
    if (!result.rows.length) return res.status(404).json({ error: "Share not found" });
    res.json({ success: true, data: result.rows[0].data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── COLLABORATIVE COLLECTIONS ─────────────────────────────────────────────────

// Enable collab — initialises shared_state from owner's collection
app.post("/collections/:id/collab", authMiddleware, async (req, res) => {
  var colId = req.params.id;
  try {
    var colRes = await pool.query("SELECT data FROM collections WHERE id=$1 AND user_id=$2", [colId, req.user.id]);
    if (!colRes.rows.length) return res.status(404).json({ error: "Collection not found" });
    var token = crypto.randomBytes(6).toString("hex");
    var colData = colRes.rows[0].data;
    var initState = { sections: colData.sections || [], sectionMap: colData.sectionMap || {} };
    var inserted = await pool.query(
      "INSERT INTO collab_collections (collab_token, collection_id, owner_id, shared_state) VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, owner_id) DO NOTHING RETURNING collab_token",
      [token, colId, req.user.id, JSON.stringify(initState)]
    );
    if (!inserted.rows.length) {
      var fetched = await pool.query("SELECT collab_token FROM collab_collections WHERE collection_id=$1 AND owner_id=$2", [colId, req.user.id]);
      return res.json({ success: true, token: fetched.rows[0].collab_token });
    }
    res.json({ success: true, token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Disable collab
app.delete("/collections/:id/collab", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM collab_collections WHERE collection_id=$1 AND owner_id=$2", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /collab/:token — returns full merged state (no auth required)
app.get("/collab/:token", async (req, res) => {
  try {
    var cc = await pool.query("SELECT * FROM collab_collections WHERE collab_token=$1", [req.params.token]);
    if (!cc.rows.length) return res.status(404).json({ error: "Collab not found" });
    var row = cc.rows[0];
    var sharedState = row.shared_state || { sections: [], sectionMap: {} };

    // Get owner's collection metadata
    var colRes = await pool.query("SELECT data FROM collections WHERE id=$1 AND user_id=$2", [row.collection_id, row.owner_id]);
    if (!colRes.rows.length) return res.status(404).json({ error: "Collection not found" });
    var col = colRes.rows[0].data;

    // Get owner's places (all of them, keyed by id)
    var ownerPlacesRes = await pool.query("SELECT id, data FROM places WHERE user_id=$1", [row.owner_id]);
    var ownerPlacesMap = {};
    ownerPlacesRes.rows.forEach(function(r) { ownerPlacesMap[r.id] = r.data; });

    // Get collab places in insertion order
    var collabRes = await pool.query(
      "SELECT id, data, added_by_name, added_by_id FROM collab_places WHERE collab_token=$1 ORDER BY created_at ASC",
      [req.params.token]
    );
    var collabPlacesMap = {};
    collabRes.rows.forEach(function(r) {
      collabPlacesMap[r.id] = Object.assign({}, r.data, {
        id: r.id, addedByName: r.added_by_name, addedById: r.added_by_id
      });
    });

    // Build ordered place list: owner's places in their order, then collab places
    var ownerOrdered = (col.placeIds || []).map(function(id) { return ownerPlacesMap[id]; }).filter(Boolean);
    var collabOrdered = collabRes.rows.map(function(r) { return collabPlacesMap[r.id]; });
    var allPlaces = ownerOrdered.concat(collabOrdered);

    res.json({
      success: true,
      collection: col,
      sharedState: sharedState,
      places: allPlaces,
      ownerId: row.owner_id
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /collab/:token/state — update sections + sectionMap (anyone with auth)
app.patch("/collab/:token/state", authMiddleware, async (req, res) => {
  var { sections, sectionMap } = req.body;
  try {
    var cc = await pool.query("SELECT collab_token FROM collab_collections WHERE collab_token=$1", [req.params.token]);
    if (!cc.rows.length) return res.status(404).json({ error: "Not found" });
    var newState = { sections: sections || [], sectionMap: sectionMap || {} };
    await pool.query("UPDATE collab_collections SET shared_state=$1 WHERE collab_token=$2", [JSON.stringify(newState), req.params.token]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /collab/:token/places — add one place (auth required)
app.post("/collab/:token/places", authMiddleware, async (req, res) => {
  var { place } = req.body;
  if (!place) return res.status(400).json({ error: "No place" });
  try {
    var cc = await pool.query("SELECT collab_token FROM collab_collections WHERE collab_token=$1", [req.params.token]);
    if (!cc.rows.length) return res.status(404).json({ error: "Collab not found" });
    var id = "cp" + crypto.randomBytes(8).toString("hex");
    place.id = id;
    await pool.query(
      "INSERT INTO collab_places (id, collab_token, added_by_id, added_by_name, data) VALUES ($1,$2,$3,$4,$5)",
      [id, req.params.token, req.user.id, req.user.email.split("@")[0], JSON.stringify(place)]
    );
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /collab/:token/places/:placeId — owner can remove any, others only their own
app.delete("/collab/:token/places/:placeId", authMiddleware, async (req, res) => {
  var placeId = req.params.placeId;
  try {
    var cc = await pool.query("SELECT owner_id, shared_state FROM collab_collections WHERE collab_token=$1", [req.params.token]);
    if (!cc.rows.length) return res.status(404).json({ error: "Not found" });
    var isOwner = cc.rows[0].owner_id === req.user.id;
    if (isOwner) {
      await pool.query("DELETE FROM collab_places WHERE id=$1 AND collab_token=$2", [placeId, req.params.token]);
    } else {
      await pool.query("DELETE FROM collab_places WHERE id=$1 AND collab_token=$2 AND added_by_id=$3", [placeId, req.params.token, req.user.id]);
    }
    // Remove from shared_state.sectionMap
    var state = cc.rows[0].shared_state || { sections: [], sectionMap: {} };
    Object.keys(state.sectionMap || {}).forEach(function(secId) {
      state.sectionMap[secId] = (state.sectionMap[secId] || []).filter(function(id) { return id !== placeId; });
    });
    await pool.query("UPDATE collab_collections SET shared_state=$1 WHERE collab_token=$2", [JSON.stringify(state), req.params.token]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "Roamy backend running ✈", db: "connected" }));

const PORT = process.env.PORT || 10000;
setupDB().then(function() {
  app.listen(PORT, function() { console.log("Roamy backend listening on port " + PORT); });
}).catch(function(e) {
  console.error("DB setup failed:", e.message);
  process.exit(1);
});
