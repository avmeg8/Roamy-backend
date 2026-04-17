const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Headers to mimic a real mobile browser ──────────────────────────────────
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
};

// ─── Platform detection ───────────────────────────────────────────────────────
function detectPlatform(url) {
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return "unknown";
}

// ─── Instagram scraper ────────────────────────────────────────────────────────
async function scrapeInstagram(url) {
  // Try oEmbed first
  try {
    const res = await axios.get(
      `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}&hidecaption=0`,
      { headers: HEADERS, timeout: 10000 }
    );
    if (res.data?.title) {
      return { caption: res.data.title, author: res.data.author_name || "", platform: "instagram" };
    }
  } catch {}

  // Fallback: scrape HTML meta tags
  try {
    const res = await axios.get(url, {
      headers: { ...HEADERS, "Cookie": "ig_did=0; csrftoken=missing; ds_user_id=0;" },
      timeout: 12000,
      maxRedirects: 5,
    });
    const html = res.data;
    const desc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1]
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i)?.[1]
      || "";
    return { caption: desc, author: "", platform: "instagram" };
  } catch (e) {
    throw new Error(`Instagram scrape failed: ${e.message}`);
  }
}

// ─── TikTok scraper ───────────────────────────────────────────────────────────
async function scrapeTikTok(url) {
  try {
    const res = await axios.get(
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      { headers: HEADERS, timeout: 10000 }
    );
    if (res.data?.title) {
      return { caption: res.data.title, author: res.data.author_name || "", platform: "tiktok" };
    }
  } catch {}

  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000, maxRedirects: 5 });
    const html = res.data;
    const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1]
      || html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1]
      || "";
    return { caption: desc, author: "", platform: "tiktok" };
  } catch (e) {
    throw new Error(`TikTok scrape failed: ${e.message}`);
  }
}

// ─── YouTube scraper ──────────────────────────────────────────────────────────
async function scrapeYouTube(url) {
  try {
    let fullUrl = url;
    if (/youtu\.be\//.test(url)) {
      const id = url.match(/youtu\.be\/([^?&]+)/)?.[1];
      if (id) fullUrl = `https://www.youtube.com/watch?v=${id}`;
    }
    const res = await axios.get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(fullUrl)}&format=json`,
      { headers: HEADERS, timeout: 10000 }
    );
    return { caption: res.data.title || "", author: res.data.author_name || "", platform: "youtube" };
  } catch (e) {
    throw new Error(`YouTube scrape failed: ${e.message}`);
  }
}

// ─── Gemini AI extraction ─────────────────────────────────────────────────────
async function extractPlaceWithGemini({ caption, author, platform, rawInput }) {
  const context = [
    caption ? `Post caption/title: "${caption}"` : null,
    author  ? `Posted by: @${author}` : null,
    platform ? `Platform: ${platform}` : null,
    rawInput ? `Original input: ${rawInput}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are a travel place extraction AI for an app called Roamy.
Given social media post data or a place description, extract the specific travel destination.

${context}

Return ONLY a raw JSON object — no markdown, no backticks, no explanation whatsoever:
{
  "name": "Exact venue or place name",
  "city": "City name",
  "country": "Full English country name",
  "type": "one of: restaurant, cafe, bar, cocktail bar, hotel, museum, beach, park, market, temple, church, viewpoint, attraction, neighborhood, nature, shop, spa, club, street, island, waterfall, castle, gallery, winery, brewery, rooftop, lake, cave, default",
  "description": "1-2 sentences about what makes this place special",
  "lat": <accurate real-world latitude as number>,
  "lng": <accurate real-world longitude as number>
}

Rules:
- Use precise real-world coordinates for the specific venue
- Country must be full English name (e.g. "Italy" not "IT")
- If multiple places mentioned, pick the most prominent one
- Never return null fields — always make your best guess`;

  const res = await axios.post(GEMINI_URL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  }, { timeout: 20000 });

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI returned no valid JSON");
  return JSON.parse(match[0]);
}

// ─── Main route ───────────────────────────────────────────────────────────────
app.post("/extract", async (req, res) => {
  const { input } = req.body;
  if (!input?.trim()) return res.status(400).json({ error: "No input provided" });

  const trimmed = input.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);

  try {
    let scrapedData = { caption: "", author: "", platform: "text" };

    if (isUrl) {
      const platform = detectPlatform(trimmed);
      console.log(`[${platform}] Scraping: ${trimmed}`);

      if (platform === "instagram") scrapedData = await scrapeInstagram(trimmed);
      else if (platform === "tiktok") scrapedData = await scrapeTikTok(trimmed);
      else if (platform === "youtube") scrapedData = await scrapeYouTube(trimmed);
      else {
        try {
          const r = await axios.get(trimmed, { headers: HEADERS, timeout: 10000 });
          const desc = r.data.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || "";
          scrapedData = { caption: desc, author: "", platform: "web" };
        } catch {}
      }

      console.log(`[scraped] caption: "${scrapedData.caption?.slice(0, 100)}"`);
    }

    const place = await extractPlaceWithGemini({ ...scrapedData, rawInput: trimmed });
    console.log(`[AI] Extracted: ${place.name}, ${place.city}, ${place.country}`);
    res.json({ success: true, place });

  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ error: err.message || "Extraction failed" });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Roamy backend running ✈" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Roamy backend listening on port ${PORT}`));
- If multiple places are mentioned, pick the most prominent one
- Never return null fields — always make your best guess`,
    messages: [{ role: "user", content: context }],
  });

  const raw = message.content.map(b => b.text || "").join("");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI returned no valid JSON");
  return JSON.parse(match[0]);
}

// ─── Main route ───────────────────────────────────────────────────────────────

app.post("/extract", async (req, res) => {
  const { input } = req.body;

  if (!input || !input.trim()) {
    return res.status(400).json({ error: "No input provided" });
  }

  const trimmed = input.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);

  try {
    let scrapedData = { caption: "", author: "", platform: "text" };

    if (isUrl) {
      const platform = detectPlatform(trimmed);
      console.log(`[${platform}] Scraping: ${trimmed}`);

      if (platform === "instagram") {
        scrapedData = await scrapeInstagram(trimmed);
      } else if (platform === "tiktok") {
        scrapedData = await scrapeTikTok(trimmed);
      } else if (platform === "youtube") {
        scrapedData = await scrapeYouTube(trimmed);
      } else {
        // Unknown URL - just try generic scrape
        try {
          const r = await axios.get(trimmed, { headers: HEADERS, timeout: 10000 });
          const desc = r.data.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] || "";
          scrapedData = { caption: desc, author: "", platform: "web" };
        } catch {}
      }

      console.log(`[scraped] caption: "${scrapedData.caption?.slice(0, 80)}..."`);
    }

    // Even if scraping got nothing, pass the raw URL/text to AI
    const place = await extractPlaceWithAI({
      ...scrapedData,
      rawInput: trimmed,
    });

    console.log(`[AI] Extracted: ${place.name}, ${place.city}, ${place.country}`);
    res.json({ success: true, place });

  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ error: err.message || "Extraction failed" });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "Roamy backend running ✈" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Roamy backend listening on port ${PORT}`));
