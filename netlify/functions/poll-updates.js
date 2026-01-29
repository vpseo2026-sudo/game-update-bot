const crypto = require("crypto");

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// Telegram sender with 429 (rate limit) handling
async function sendTelegram(text) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false,
      }),
    });

    if (res.ok) return;

    const raw = await res.text();

    // If rate-limited, wait and retry
    try {
      const data = JSON.parse(raw);
      if (data?.error_code === 429 && data?.parameters?.retry_after) {
        const waitSec = data.parameters.retry_after;
        await sleep((waitSec + 1) * 1000); // +1 sec buffer
        continue;
      }
    } catch (_) {
      // ignore JSON parse errors
    }

    throw new Error(`Telegram error: ${raw}`);
  }

  throw new Error("Telegram error: rate limited too long");
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

exports.handler = async () => {
  try {
    // DEBUG MODE: does not call Supabase or Telegram; just prints env visibility
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

    // Env sanity check
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

    // 1) Load enabled sources
    const sources = await supabaseFetch("sources?select=id,name,type,url&enabled=eq.true");

    let newCount = 0;
    const notifications = [];

    for (const src of sources) {
      // Skip placeholders or empty URLs
      if (!src.url || src.url.includes("PASTE_RSS_URL_HERE")) continue;

      // Only RSS in MVP
      if (src.type !== "rss") continue;

      // 2) Fetch source
      let resp;
      try {
        resp = await fetch(src.url, { headers: { "User-Agent": "GameUpdateBot/1.0" } });
      } catch {
        continue;
      }
      if (!resp.ok) continue;

      const xml = await resp.text();

      // 3) Parse latest items
      const parsed = parseRss(xml).slice(0, 10);

      for (const it of parsed) {
        const content_hash = sha1(`${it.title}|${it.link}|${it.published_at || ""}`);

        // 4) Dedup check
        const exists = await supabaseFetch(
          `items?select=id&source_id=eq.${src.id}&content_hash=eq.${content_hash}&limit=1`
        );
        if (exists?.length) continue;

        // 5) Store
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

        // 6) Queue notification (batch later)
        notifications.push(`• ${it.title}\n${it.link}`);
        newCount++;
      }
    }

    // 7) Send ONE batched message to avoid Telegram 429
    if (notifications.length) {
      const top = notifications.slice(0, 10); // limit per run
      await sendTelegram(`🎮 New updates (${top.length})\n\n${top.join("\n\n")}`);
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
