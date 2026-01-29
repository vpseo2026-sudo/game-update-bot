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
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram error: ${t}`);
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

// ✅ Netlify expects exports.handler
exports.handler = async () => {
  try {
    // ✅ DEBUG MODE (no DB calls, just shows what Netlify sees)
    if (process.env.DEBUG === "1") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabaseUrl: process.env.SUPABASE_URL,
          hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
          telegramChatId: process.env.TELEGRAM_CHAT_ID,
        }),
      };
    }

    // ✅ Env sanity check
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

    // 1) load enabled sources
    const sources = await supabaseFetch("sources?select=id,name,type,url&enabled=eq.true");

    let newCount = 0;

    for (const src of sources) {
      // If there is still a placeholder URL in DB, skip it instead of crashing
      if (!src.url || src.url.includes("PASTE_RSS_URL_HERE")) continue;

      // 2) fetch source
      const r = await fetch(src.url, { headers: { "User-Agent": "GameUpdateBot/1.0" } });
      if (!r.ok) continue;

      const text = await r.text();
      if (src.type !== "rss") continue;

      const parsed = parseRss(text).slice(0, 10);

      for (const it of parsed) {
        const content_hash = sha1(`${it.title}|${it.link}|${it.published_at || ""}`);

        // 3) dedupe check
        const exists = await supabaseFetch(
          `items?select=id&source_id=eq.${src.id}&content_hash=eq.${content_hash}&limit=1`
        );
        if (exists?.length) continue;

        // 4) insert
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

        // 5) notify
        await sendTelegram(`🎮 New update\n${it.title}\n${it.link}`);
        newCount++;
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, newCount }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
