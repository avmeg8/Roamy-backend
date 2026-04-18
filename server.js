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

// ── Scraper ──────────────────────────────────────────────────────────────────
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

// ── AI Extraction ─────────────────────────────────────────────────────────────
async function askAI(text) {
  var prompt = "You are a travel place extraction AI. Given this text, extract the travel place and return ONLY a JSON object with no markdown or backticks:\n{\"name\":\"exact venue or place name\",\"city\":\"city\",\"country\":\"full english country name\",\"type\":\"restaurant or cafe or bar or hotel or museum or beach or park or market or temple or church or viewpoint or attraction or neighborhood or nature or shop or spa or club or island or waterfall or castle or gallery or default\",\"description\":\"2-3 sentences about what makes this place special and why people visit\",\"lat\":0.0,\"lng\":0.0}\n\nRules: use precise real coordinates, full english country name, pick the most specific/prominent place mentioned.\n\nText:\n" + text;

  var res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "openrouter/auto",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 600,
    temperature: 0.1,
  }, {
    headers: {
      "Authorization": "Bearer " + OPENROUTER_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://roamyclone.edgeone.app",
      "X-Title": "Roamy",
    },
    timeout: 25000,
  });

  var raw = res.data.choices[0].message.content;
  raw = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON from AI");
  return JSON.parse(match[0]);
}

// ── Google Places ─────────────────────────────────────────────────────────────
async function getGooglePlaceData(name, city, country) {
  try {
    var query = name + " " + city + " " + country;
    var searchUrl = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=" + encodeURIComponent(query) + "&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,formatted_address,photos,website,opening_hours,price_level&key=" + GOOGLE_KEY;
    var searchRes = await axios.get(searchUrl, { timeout: 8000 });
    var candidates = searchRes.data.candidates;
    if (!candidates || candidates.length === 0) return null;
    var place = candidates[0];
    var photoUrl = null;
    if (place.photos && place.photos.length > 0) {
      var photoRef = place.photos[0].photo_reference;
      photoUrl = "https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=" + photoRef + "&key=" + GOOGLE_KEY;
    }
    return {
      placeId: place.place_id,
      rating: place.rating || null,
      totalRatings: place.user_ratings_total || null,
      address: place.formatted_address || null,
      photoUrl: photoUrl,
      website: place.website || null,
      openNow: place.opening_hours ? place.opening_hours.open_now : null,
      priceLevel: place.price_level || null,
    };
  } catch(e) {
    console.log("Google Places error: " + e.message);
    return null;
  }
}

// ── Main route ────────────────────────────────────────────────────────────────
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

  var place;
  try {
    place = await askAI(context);
    console.log("AI extracted: " + place.name + ", " + place.city + ", " + place.country);
  } catch(err) {
    console.log("AI error: " + err.message);
    return res.status(500).json({ error: "Could not identify place." });
  }

  var googleData = await getGooglePlaceData(place.name, place.city, place.country);
  if (googleData) {
    console.log("Google data found, photo: " + (googleData.photoUrl ? "yes" : "no"));
    place.googlePlaceId = googleData.placeId;
    place.rating = googleData.rating;
    place.totalRatings = googleData.totalRatings;
    place.address = googleData.address;
    place.photoUrl = googleData.photoUrl;
    place.website = googleData.website;
    place.openNow = googleData.openNow;
    place.priceLevel = googleData.priceLevel;
  }

  res.json({ success: true, place: place });
});

app.get("/", function(req, res) {
  res.json({ status: "Roamy backend running", googleKey: !!GOOGLE_KEY, openrouterKey: !!OPENROUTER_KEY });
});

var PORT = process.env.PORT || 10000;
app.listen(PORT, function() {
  console.log("Roamy backend listening on port " + PORT);
});
