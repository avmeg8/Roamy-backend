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
  // Remove markdown
  text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  
  // Find the first { and last } to extract just the JSON object
  var start = text.indexOf("{");
  var end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  
  var jsonStr = text.slice(start, end + 1);
  
  // Try parsing directly first
  try {
    return JSON.parse(jsonStr);
  } catch(e) {}
  
  // Fix common AI JSON issues
  // Remove trailing commas before } or ]
  jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");
  // Fix unescaped quotes in values (basic)
  jsonStr = jsonStr.replace(/:\s*"([^"]*)"([^,}\]]*)"([^,}\]]*)"(\s*[,}\]])/g, ': "$1\\"$2\\"$3"$4');
  
  try {
    return JSON.parse(jsonStr);
  } catch(e) {}

  // Last resort: extract fields manually with regex
  var result = {};
  var fields = ["name","city","country","type","description","lat","lng","searchTerms"];
  fields.forEach(function(field) {
    var numMatch = jsonStr.match(new RegExp('"' + field + '"\\s*:\\s*(-?[0-9]+\\.?[0-9]*)'));
    var strMatch = jsonStr.match(new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
    if (numMatch) result[field] = parseFloat(numMatch[1]);
    else if (strMatch) result[field] = strMatch[1];
  });
  
  if (!result.name) throw new Error("Could not extract place name from AI response");
  return result;
}

// ── AI Extraction ─────────────────────────────────────────────────────────────
async function askAI(text) {
  var prompt = "You are a travel place extraction AI. Given this text, extract the travel place.\n\nReturn ONLY a valid JSON object, nothing else, no markdown:\n{\"name\":\"exact venue name\",\"city\":\"city\",\"country\":\"full english country name\",\"type\":\"restaurant or cafe or bar or hotel or museum or beach or park or market or temple or church or viewpoint or attraction or neighborhood or nature or shop or spa or club or island or waterfall or castle or gallery or default\",\"description\":\"2-3 sentences about this place\",\"lat\":0.0,\"lng\":0.0,\"searchTerms\":\"alternative names for google search\"}\n\nIMPORTANT: Return ONLY the JSON. No explanation. No markdown. No extra text.\n\nText to analyze:\n" + text;

  var res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "openrouter/auto",
    messages: [
      { role: "system", content: "You are a JSON-only API. You must respond with ONLY a valid JSON object and absolutely nothing else. No markdown, no explanation, no backticks." },
      { role: "user", content: prompt }
    ],
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
  console.log("AI raw response: " + raw.slice(0, 300));
  return extractJSON(raw);
}

// ── Google Places search ───────────────────────────────────────────────────────
async function searchGooglePlace(query) {
  var url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=" + encodeURIComponent(query) + "&inputtype=textquery&fields=place_id,name,rating,user_ratings_total,formatted_address,photos,website,opening_hours,price_level&key=" + GOOGLE_KEY;
  var res = await axios.get(url, { timeout: 8000 });
  console.log("Google status for '" + query + "': " + res.data.status);
  if (res.data.error_message) console.log("Google error: " + res.data.error_message);
  var candidates = res.data.candidates;
  return (candidates && candidates.length > 0) ? candidates[0] : null;
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

// ── Google Places with fallbacks ──────────────────────────────────────────────
async function getGooglePlaceData(name, city, country, searchTerms) {
  var queries = [
    name + " " + city + " " + country,
    name + " " + city,
    name + " " + country,
    (searchTerms || "").trim() + " " + city,
    name,
  ].filter(function(q) { return q.trim().length > 3; });

  // Remove duplicates
  queries = queries.filter(function(q, i) { return queries.indexOf(q) === i; });

  var place = null;
  for (var i = 0; i < queries.length; i++) {
    try {
      place = await searchGooglePlace(queries[i]);
      if (place) break;
    } catch(e) {
      console.log("Google query error: " + e.message);
    }
  }

  if (!place) {
    console.log("No Google Places result after all queries");
    return null;
  }

  var photoUrl = null;
  if (place.photos && place.photos.length > 0) {
    var photoRef = place.photos[0].photo_reference;
    photoUrl = "https://roamy-backend.onrender.com/photo?ref=" + encodeURIComponent(photoRef);
    console.log("Photo proxy URL created");
  } else {
    console.log("Place found but no photos available");
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

  var googleData = await getGooglePlaceData(place.name, place.city, place.country, place.searchTerms);
  if (googleData) {
    place.googlePlaceId = googleData.placeId;
    place.rating = googleData.rating;
    place.totalRatings = googleData.totalRatings;
    place.address = googleData.address;
    place.photoUrl = googleData.photoUrl;
    place.website = googleData.website;
    place.openNow = googleData.openNow;
    place.priceLevel = googleData.priceLevel;
  }

  delete place.searchTerms;
  res.json({ success: true, place: place });
});

app.get("/", function(req, res) {
  res.json({ status: "Roamy backend running", googleKey: !!GOOGLE_KEY, keyLength: GOOGLE_KEY ? GOOGLE_KEY.length : 0, openrouterKey: !!OPENROUTER_KEY });
});

var PORT = process.env.PORT || 10000;
app.listen(PORT, function() {
  console.log("Roamy backend listening on port " + PORT);
});
