const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrape(url) {
  var caption = "";
  var author = "";
  if (/instagram\.com/i.test(url)) {
    try {
      var r = await axios.get("https://www.instagram.com/api/v1/oembed/?url=" + encodeURIComponent(url), { headers: SCRAPE_HEADERS, timeout: 10000 });
      caption = r.data.title || "";
      author = r.data.author_name || "";
    } catch(e) {}
    if (!caption) {
      try {
        var r2 = await axios.get(url, { headers: SCRAPE_HEADERS, timeout: 12000 });
        var m = r2.data.match(/property="og:description"[^>]+content="([^"]+)"/i) || r2.data.match(/content="([^"]+)"[^>]+property="og:description"/i);
        if (m) caption = m[1];
      } catch(e) {}
    }
  } else if (/tiktok\.com/i.test(url)) {
    try {
      var r = await axios.get("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), { headers: SCRAPE_HEADERS, timeout: 10000 });
      caption = r.data.title || "";
      author = r.data.author_name || "";
    } catch(e) {}
  } else if (/youtube\.com|youtu\.be/i.test(url)) {
    try {
      var fullUrl = url;
      if (/youtu\.be\//.test(url)) {
        var id = url.match(/youtu\.be\/([^?&]+)/);
        if (id) fullUrl = "https://www.youtube.com/watch?v=" + id[1];
      }
      var r = await axios.get("https://www.youtube.com/oembed?url=" + encodeURIComponent(fullUrl) + "&format=json", { headers: SCRAPE_HEADERS, timeout: 10000 });
      caption = r.data.title || "";
      author = r.data.author_name || "";
    } catch(e) {}
  }
  return { caption: caption, author: author };
}

// ── Safe JSON extraction ───────────────────────────────────────────────────────
function extractJSON(text) {
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  var start = text.indexOf("[");
  var objStart = text.indexOf("{");
  
  // Check if it's an array or single object
  if (start !== -1 && (objStart === -1 || start < objStart)) {
    // It's an array
    var end = text.lastIndexOf("]");
    if (end !== -1) {
      var jsonStr = text.slice(start, end + 1);
      jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");
      try { return JSON.parse(jsonStr); } catch(e) {}
    }
  }
  
  // Try as single object, wrap in array
  if (objStart !== -1) {
    var end2 = text.lastIndexOf("}");
    if (end2 !== -1) {
      var objStr = text.slice(objStart, end2 + 1);
      objStr = objStr.replace(/,(\s*[}\]])/g, "$1");
      try { return [JSON.parse(objStr)]; } catch(e) {}
    }
  }
  
  throw new Error("Could not parse AI response as JSON");
}

// ── AI Extraction (returns array of places) ───────────────────────────────────
async function askAI(text) {
  var prompt = `You are a travel place extraction AI. Given this social media post or text, extract ALL travel places/venues/destinations mentioned.

Return ONLY a valid JSON array (no markdown, no backticks, no explanation):
[
  {
    "name": "exact venue or place name",
    "city": "city",
    "country": "full english country name",
    "type": "restaurant or cafe or bar or hotel or museum or beach or park or market or temple or church or viewpoint or attraction or neighborhood or nature or shop or spa or club or island or waterfall or castle or gallery or winery or brewery or rooftop or lake or cave or default",
    "description": "2-3 sentences about what makes this place special",
    "lat": 0.0,
    "lng": 0.0
  }
]

Rules:
- If ONE place is mentioned, return an array with ONE object
- If MULTIPLE places are mentioned, return ALL of them as separate objects in the array
- Use precise real-world coordinates for each specific venue
- Country must be full English name (e.g. "Italy" not "IT")
- Maximum 6 places per response
- Never return an empty array — always extract at least one place

Text to analyze:
` + text;

  var res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "openrouter/auto",
    messages: [
      { role: "system", content: "You are a JSON-only API. Respond with ONLY a valid JSON array. No markdown, no explanation, no backticks." },
      { role: "user", content: prompt }
    ],
    max_tokens: 1500,
    temperature: 0.1,
  }, {
    headers: {
      "Authorization": "Bearer " + OPENROUTER_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://roamyclone.edgeone.app",
      "X-Title": "Roamy",
    },
    timeout: 30000,
  });

  var raw = res.data.choices[0].message.content;
  console.log("AI raw: " + raw.slice(0, 400));
  return extractJSON(raw);
}

// ── Google Places ─────────────────────────────────────────────────────────────
async function searchGooglePlace(query) {
  try {
    var url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=" + encodeURIComponent(query) + "&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,formatted_address,photos,opening_hours,price_level&key=" + GOOGLE_KEY;
    var res = await axios.get(url, { timeout: 8000 });
    console.log("Google [" + query.slice(0,40) + "]: " + res.data.status);
    if (res.data.error_message) console.log("Google error: " + res.data.error_message);
    var candidates = res.data.candidates;
    return (candidates && candidates.length > 0) ? candidates[0] : null;
  } catch(e) {
    console.log("Google error: " + e.message);
    return null;
  }
}

async function getGoogleData(name, city, country) {
  var queries = [
    name + " " + city + " " + country,
    name + " " + city,
    name + " " + country,
    name,
  ].filter(function(q) { return q.trim().length > 3; });

  var place = null;
  for (var i = 0; i < queries.length; i++) {
    place = await searchGooglePlace(queries[i]);
    if (place) break;
  }
  if (!place) return null;

  var photoUrl = null;
  if (place.photos && place.photos.length > 0) {
    var photoRef = place.photos[0].photo_reference;
    photoUrl = "https://roamy-backend.onrender.com/photo?ref=" + encodeURIComponent(photoRef);
  }

  return {
    rating: place.rating || null,
    totalRatings: place.user_ratings_total || null,
    address: place.formatted_address || null,
    photoUrl: photoUrl,
    openNow: place.opening_hours ? place.opening_hours.open_now : null,
    priceLevel: place.price_level || null,
  };
}

// ── Photo proxy ───────────────────────────────────────────────────────────────
app.get("/photo", async function(req, res) {
  var ref = req.query.ref;
  if (!ref) return res.status(400).send("No ref");
  try {
    var photoRes = await axios.get(
      "https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=" + ref + "&key=" + GOOGLE_KEY,
      { responseType: "arraybuffer", timeout: 10000, maxRedirects: 5 }
    );
    res.set("Content-Type", photoRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(photoRes.data);
  } catch(e) {
    console.log("Photo proxy error: " + e.message);
    res.status(500).send("Photo failed");
  }
});

// ── Main extract route ────────────────────────────────────────────────────────
app.post("/extract", async function(req, res) {
  var input = req.body.input;
  if (!input || !input.trim()) return res.status(400).json({ error: "No input provided" });

  var trimmed = input.trim();
  var isUrl = /^https?:\/\//i.test(trimmed);
  var context = trimmed;

  if (isUrl) {
    console.log("Scraping: " + trimmed);
    try {
      var scraped = await scrape(trimmed);
      console.log("Caption: " + scraped.caption.slice(0, 120));
      if (scraped.caption) {
        context = "URL: " + trimmed + "\nCaption: " + scraped.caption + "\nAuthor: " + scraped.author;
      }
    } catch(e) {
      console.log("Scrape error: " + e.message);
    }
  }

  var aiPlaces;
  try {
    aiPlaces = await askAI(context);
    console.log("AI found " + aiPlaces.length + " place(s)");
  } catch(err) {
    console.log("AI error: " + err.message);
    return res.status(500).json({ error: "Could not identify any places." });
  }

  // Enrich each place with Google data in parallel
  var enriched = await Promise.all(aiPlaces.map(async function(place) {
    try {
      var googleData = await getGoogleData(place.name, place.city, place.country);
      if (googleData) {
        place.rating = googleData.rating;
        place.totalRatings = googleData.totalRatings;
        place.address = googleData.address;
        place.photoUrl = googleData.photoUrl;
        place.openNow = googleData.openNow;
        place.priceLevel = googleData.priceLevel;
      }
    } catch(e) {
      console.log("Google enrichment failed for " + place.name + ": " + e.message);
    }
    return place;
  }));

  res.json({ success: true, places: enriched });
});

app.get("/", function(req, res) {
  res.json({ status: "Roamy backend running", googleKey: !!GOOGLE_KEY, openrouterKey: !!OPENROUTER_KEY });
});

var PORT = process.env.PORT || 10000;
app.listen(PORT, function() {
  console.log("Roamy backend listening on port " + PORT);
});
