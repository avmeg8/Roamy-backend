const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function scrape(url) {
  var caption = "";
  var author = "";

  if (/instagram\.com/i.test(url)) {
    try {
      var r = await axios.get("https://www.instagram.com/api/v1/oembed/?url=" + encodeURIComponent(url), { headers: HEADERS, timeout: 10000 });
      caption = r.data.title || "";
      author = r.data.author_name || "";
    } catch(e) {}
    if (!caption) {
      try {
        var r2 = await axios.get(url, { headers: HEADERS, timeout: 12000 });
        var m = r2.data.match(/property="og:description"[^>]+content="([^"]+)"/i) || r2.data.match(/content="([^"]+)"[^>]+property="og:description"/i);
        if (m) caption = m[1];
      } catch(e) {}
    }
  } else if (/tiktok\.com/i.test(url)) {
    try {
      var r = await axios.get("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), { headers: HEADERS, timeout: 10000 });
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
      var r = await axios.get("https://www.youtube.com/oembed?url=" + encodeURIComponent(fullUrl) + "&format=json", { headers: HEADERS, timeout: 10000 });
      caption = r.data.title || "";
      author = r.data.author_name || "";
    } catch(e) {}
  }

  return { caption: caption, author: author };
}

async function askGemini(text) {
  var prompt = "You are a travel place extraction AI. Given this text, extract the travel place and return ONLY a JSON object with no markdown or backticks:\n{\"name\":\"place name\",\"city\":\"city\",\"country\":\"full english country name\",\"type\":\"restaurant or cafe or bar or hotel or museum or beach or park or market or temple or church or viewpoint or attraction or neighborhood or nature or shop or spa or club or island or waterfall or castle or gallery or default\",\"description\":\"one sentence about this place\",\"lat\":0.0,\"lng\":0.0}\n\nText to analyze:\n" + text;

  var retries = 4;
  var delay = 5000;

  for (var i = 0; i < retries; i++) {
    try {
      var res = await axios.post(GEMINI_URL,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 512 } },
        { timeout: 25000 }
      );
      var raw = res.data.candidates[0].content.parts[0].text;
      raw = raw.replace(/```json/g, "").replace(/```/g, "").trim();
      var match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON from AI");
      return JSON.parse(match[0]);
    } catch(e) {
      var status = e.response ? e.response.status : 0;
      console.log("Attempt " + (i+1) + " failed (status " + status + "): " + e.message);
      if (status === 429 && i < retries - 1) {
        console.log("Rate limited, waiting " + (delay/1000) + "s before retry...");
        await sleep(delay);
        delay = delay * 2;
      } else {
        throw e;
      }
    }
  }
}

app.get("/", function(req, res) {
  res.json({ status: "Roamy backend running" });
});

app.post("/extract", async function(req, res) {
  var input = req.body.input;
  if (!input || !input.trim()) {
    return res.status(400).json({ error: "No input provided" });
  }

  var trimmed = input.trim();
  var isUrl = /^https?:\/\//i.test(trimmed);
  var context = trimmed;

  if (isUrl) {
    console.log("Scraping: " + trimmed);
    try {
      var scraped = await scrape(trimmed);
      console.log("Caption: " + scraped.caption.slice(0, 100));
      if (scraped.caption) {
        context = "URL: " + trimmed + "\nCaption: " + scraped.caption + "\nAuthor: " + scraped.author;
      }
    } catch(e) {
      console.log("Scrape error: " + e.message);
    }
  }

  try {
    var place = await askGemini(context);
    console.log("Extracted: " + place.name + ", " + place.city + ", " + place.country);
    res.json({ success: true, place: place });
  } catch(err) {
    console.log("AI Error: " + err.message);
    res.status(500).json({ error: "Could not identify place. Try typing the name directly." });
  }
});

var PORT = process.env.PORT || 10000;
app.listen(PORT, function() {
  console.log("Roamy backend listening on port " + PORT);
});

