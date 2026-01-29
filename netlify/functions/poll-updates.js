const crypto = require("crypto");

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

async function supabaseFetch(path, { method = "GET", body } = {}) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  // Don’t timeout the function if Telegram is rate-limiting; just skip this run
  if (!res.ok) {
    const raw = await res.text();
    console.log("Telegram send failed:", raw);
  }
}

function stripCdata(s = "") {
  return s.replace("<![CDATA[", "").replace("]]>", "").trim();
}

function parseRss(xmlText) {
  const items = [];
  const blocks = xmlText
    .split("<item>")
    .slice(1)
    .map((x) => x.split("</item>")[0]);

  for (const b of blocks) {
    const get = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? stripCdata(m[1]) : null;
    };

    const title = get("title");
    const link = get("link");
    const guid = get("guid");
    const pubDate = get("pubDate");

    if (!title || !link) continue;

    items.push({
      title,
      link,
      external_id: guid || link,
      published_at: pubDate ? new Date(pubDate).toISOString() : null,
    });
  }
  return items;
}

// ---- HTML parsing (official sources) ----
// Extract candidate links from HTML and normalize to absolute URLs
function extractLinks(html, baseUrl) {
  const links = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

    try {
      const abs = new URL(href, baseUrl).toString();
      links.push(abs);
    } catch (_) {}
  }
  return links;
}

// Keep only links that look like official “detail” pages we care about
function filterOfficialLinks(urls) {
  const out = [];
  for (const u of urls) {
    const lu = u.toLowerCase();

    // MLBB official article detail pattern
    if (lu.includes("mobilelegends.com") && lu.includes("articleldetail")) out.push(u);

    // Free Fire official article pages
    if (lu.includes("ff.garena.com") && (lu.includes("/article/") || lu.includes("/news/")))
      out.push(u);

    // PUBG Mobile official news detail pages
    if (lu.includes("pubgmobile.com") && lu.includes("news")) out.push(u);
  }

  // de-dupe + keep order
  return [...new Set(out)];
}

async function fetchWithTimeout(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GameUpdateBot/1.0" },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async () => {
  const started = Date.now();
  const TIME_BUDGET_MS = 25000;
  const MAX_SOURCES_PER_RUN = 2;
  const MAX_NEW_ITEMS_PER_RUN = 5;

  try {
    const missing = [];
    if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!process.env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
    if (!process.env.TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
    if (missing.length) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: `Missing env vars: ${missing.join(", ")}` }),
      };
    }

    const allSources = await supabaseFetch(
      "sources?select=id,name,type,url&enabled=eq.true&order=id.asc"
    );

    const sources = (allSources || []).filter(
      (s) => s.url && !s.url.includes("PASTE_RSS_URL_HERE")
    );

    // Round-robin by minute so sources get processed over time
    const minute = new Date().getUTCMinutes();
    const startIndex = sources.length ? minute % sources.length : 0;

    const pick = [];
    for (let i = 0; i < sources.length && pick.length < MAX_SOURCES_PER_RUN; i++) {
      pick.push(sources[(startIndex + i) % sources.length]);
    }

    let newCount = 0;
    const notifications = [];

    for (const src of pick) {
      if (Date.now() - started > TIME_BUDGET_MS) break;

      const resp = await fetchWithTimeout(src.url, 7000).catch(() => null);
      if (!resp || !resp.ok) continue;

      const text = await resp.text();

      let candidateItems = [];

      if (src.type === "rss") {
        const parsed = parseRss(text).slice(0, 10);
        candidateItems = parsed.map((it) => ({
          title: it.title,
          link: it.link,
          external_id: it.external_id,
          published_at: it.published_at,
        }));
      } else if (src.type === "html") {
        const links = filterOfficialLinks(extractLinks(text, src.url)).slice(0, 10);

        // For HTML, we use link itself as identity (fast, stable)
        candidateItems = links.map((link) => ({
          title: `[Official] ${src.name}`,
          link,
          external_id: link,
          published_at: null,
        }));
      } else {
        continue;
      }

      // Pull recent hashes once per source for dedupe
      const existing = await supabaseFetch(
        `items?select=content_hash&source_id=eq.${src.id}&order=created_at.desc&limit=300`
      );
      const existingSet = new Set((existing || []).map((x) => x.content_hash).filter(Boolean));

      for (const it of candidateItems) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        if (newCount >= MAX_NEW_ITEMS_PER_RUN) break;

        const content_hash = sha1(`${it.title}|${it.link}|${it.published_at || ""}`);
        if (existingSet.has(content_hash)) continue;

        await supabaseFetch("items", {
          method: "POST",
          body: {
            source_id: src.id,
            title: it.title,
            link: it.link,
            published_at: it.published_at,
            external_id: it.external_id,
            content_hash,
          },
        });

        existingSet.add(content_hash);
        notifications.push(`• ${src.name}\n${it.link}`);
        newCount++;
      }
    }

    if (notifications.length) {
      await sendTelegram(`✅ Official updates (${notifications.length})\n\n${notifications.join("\n\n")}`);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        processedSources: pick.map((s) => s.name),
        newCount,
        timeMs: Date.now() - started,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
