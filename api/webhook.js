import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GRAPH_VERSION = "v20.0";

// Updated with valid production Gemini model names
const candidateModels = [ "gemini-3.1-pro", "gemini-3.5-flash-lite", "gemini-3.8-flash" ] ;
const HISTORY_LIMIT = 12;
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const WHATSAPP_MAX_CHARS = 4000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(
      SUPABASE_URL.replace(/\/rest\/v1\/?$/, ""),
      SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  } catch (err) {
    console.error("Supabase init error:", err);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const seenMessageIds = new Set();
function alreadySeen(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 500) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  return false;
}

function waUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp environment variables missing");
  }
  const res = await fetchWithTimeout(
    waUrl(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    },
    15000,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
}

async function markReadAndTyping(messageId) {
  if (!messageId || !WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) return;
  try {
    await fetchWithTimeout(
      waUrl(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      },
      5000,
    );
  } catch (e) {}
}

const memoryHistory = new Map();
async function loadHistory(phone) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("role, content")
        .eq("phone", phone)
        .gte("created_at", new Date(cutoff).toISOString())
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);
      if (!error && data) return data.reverse();
      if (error)
        console.warn("chat_messages unavailable, using memory:", error.message);
    } catch (err) {
      console.warn("loadHistory error:", err.message);
    }
  }

  return (memoryHistory.get(phone) || [])
    .filter((m) => m.ts >= cutoff)
    .slice(-HISTORY_LIMIT)
    .map(({ role, content }) => ({ role, content }));
}

async function saveTurn(phone, userText, assistantText) {
  const now = Date.now();
  const mem = memoryHistory.get(phone) || [];
  mem.push({ role: "user", content: userText, ts: now });
  mem.push({ role: "assistant", content: assistantText, ts: now + 1 });
  memoryHistory.set(phone, mem.slice(-HISTORY_LIMIT * 2));

  if (!supabase) return;
  try {
    const { error } = await supabase.from("chat_messages").insert([
      {
        phone,
        role: "user",
        content: userText,
        created_at: new Date(now).toISOString(),
      },
      {
        phone,
        role: "assistant",
        content: assistantText,
        created_at: new Date(now + 1).toISOString(),
      },
    ]);
    if (error)
      console.warn("saveTurn skipped (table missing?):", error.message);
  } catch (err) {
    console.warn("saveTurn error:", err.message);
  }
}

async function getMenu() {
  if (!supabase) return "";
  try {
    const { data, error } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg")
      .eq("is_available", true);

    if (error || !data?.length) return "";

    return data
      .map(
        (item) =>
          `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`,
      )
      .join("\n");
  } catch (err) {
    console.error("getMenu error:", err);
    return "";
  }
}

function buildSystemPrompt(menu) {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `You are "Ilhaam Concierge", the friendly AI dining assistant of Ilhaam Royal Dining, chatting with guests on WhatsApp.

CURRENT DATE/TIME (India): ${now}

RESTAURANT
Ilhaam Royal Dining, 2A Congress Exhibition Road, Park Circus, Kolkata
Phone: +91 74499 88873

LIVE MENU (only source of dishes and prices):
${menu || "(Menu database is currently unavailable. Do not invent menu items or prices; offer to have the team call back.)"}

FACTS
- Upscale family fine dining.
- Hookah and alcohol are strictly prohibited and never served.
- Reshmi Kebab, Chicken Tikka and Chilli Chicken are 100% boneless.
- Kolkata Biryanis and Drums of Heaven are bone-in.
- Crispy Fish Fingers are available for ₹370.
- Mutton kebabs are chef tasting specials and are not on the regular daily menu.

HOW TO CHAT
- Sound like a warm, natural human concierge, not a form. Short messages, 1-3 short paragraphs. Use emojis sparingly (0-2).
- Reply in the guest's language and style (English, Hindi, Bengali, or Hinglish).
- Remember the whole conversation. Never ask again for something the guest already told you.
- Greetings: greet warmly and offer 2-3 helpful things (menu, order, table).
- If asked for the menu, show it grouped by category with prices, compactly. Do not use Markdown tables.
- Recommend dishes when asked (popular, veg/non-veg, boneless, spice level), only from the menu.
- WhatsApp formatting only: *bold* with single asterisks, _italic_ with underscores. Never use ** or # headings.
- Never invent dishes, prices, offers or policies. If unsure, say the team will confirm and share the phone number.

ORDERS
- When the guest wants to order, list the items with quantity and price, give the total (calculated from the menu), and ask them to reply YES to confirm.
- Only after the guest clearly confirms (YES / confirm / haan / okay place it), write a short confirmation and append this on the very last line, nothing after it:
ORDER_DATA:{"items":"ITEM SUMMARY","total":NUMBER,"type":"takeaway"}
- If they say YES but there is no pending order in the conversation, ask what they'd like to order. Never output ORDER_DATA in any other situation.

RESERVATIONS
- To book a table you need party size, date and time. Ask only for what is missing.
- Once you have all three, confirm them back in one friendly line and append this on the very last line, nothing after it:
RESERVATION_DATA:{"party_size":NUMBER,"date":"YYYY-MM-DD","time":"HH:MM AM/PM"}
- Never output RESERVATION_DATA until all three details are known.`;
}

async function askGemini(systemPrompt, history, userText) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  let turns = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  turns.push({ role: "user", parts: [{ text: userText }] });

  // Use primary 3.8 models with auto-retry on 503 spikes
  const candidateModels = ["gemini-3.8-flash", "gemini-2.5-pro"];

  for (const model of candidateModels) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: turns,
              generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 1024,
              },
            }),
          },
          8000
        );

        if (res.ok) {
          const data = await res.json();
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((part) => part?.text || "")
            .join("")
            .trim();
          if (text) return text;
        }

        const errText = await res.text();
        console.warn(`Model ${model} attempt ${attempt + 1} returned ${res.status}:`, errText);

        // If Google returns 503 (demand spike), wait 800ms and retry once
        if (res.status === 503 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
      } catch (e) {
        console.warn(`Model ${model} request error:`, e.message);
      }
      break;
    }
  }

  throw new Error("All model endpoints failed");
}

function cleanReply(reply) {
  return reply
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

function extractMarker(reply, marker) {
  const index = reply.indexOf(marker);
  if (index === -1) return null;
  const before = reply.slice(0, index).trim();
  const after = reply.slice(index + marker.length).trim();
  const start = after.indexOf("{");
  const end = after.lastIndexOf("}");
  const json =
    start !== -1 && end > start ? after.slice(start, end + 1) : after;
  return { before, json };
}

async function insertWithFallback(table, full, minimal) {
  let { error } = await supabase.from(table).insert(full);
  if (error) {
    console.warn(
      `${table} full insert failed (${error.message}); retrying minimal`,
    );
    ({ error } = await supabase.from(table).insert(minimal));
  }
  return error;
}

async function processMessage(message) {
  const fromPhone = String(message.from || "").replace(/\D/g, "");
  if (!fromPhone) return;

  if (message.type !== "text") {
    await sendWhatsApp(
      fromPhone,
      "Thanks for your message! 😊 I can read text messages only, so please type your question and I'll be glad to help.",
    );
    return;
  }

  const incomingText = message.text?.body?.trim() || "";
  if (!incomingText) return;

  markReadAndTyping(message.id);

  const [menu, history] = await Promise.all([
    getMenu(),
    loadHistory(fromPhone),
  ]);

  let reply;
  let aiOk = true;
  try {
    reply = await askGemini(buildSystemPrompt(menu), history, incomingText);
  } catch (err) {
    aiOk = false;
    console.error("AI Generation Error:", err);
    reply =
      "Sorry, our dining assistant is having trouble right now. Please try again in a moment or call us at +91 74499 88873.";
  }

  reply = cleanReply(reply);

  const orderMarker = extractMarker(reply, "ORDER_DATA:");
  if (orderMarker) {
    reply = orderMarker.before;
    try {
      const payload = JSON.parse(orderMarker.json);
      const total = Number(payload.total);
      const items = String(payload.items || "").trim();

      if (supabase && Number.isFinite(total) && total > 0 && items) {
        const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
        const minimal = {
          order_number: orderNumber,
          total,
          subtotal: total,
          status: "new",
          payment_status: "pending",
          order_type: payload.type || "takeaway",
        };
        const error = await insertWithFallback(
          "orders",
          { ...minimal, customer_phone: fromPhone, notes: items },
          minimal,
        );
        if (error) {
          console.error("Order insert error:", error);
        } else {
          reply += `\n\n *Order confirmed:* *${orderNumber}*\nOur counter team will start preparing it for you.`;
        }
      }
    } catch (err) {
      console.error("Invalid ORDER_DATA:", err);
    }
  }

  const reservationMarker = extractMarker(reply, "RESERVATION_DATA:");
  if (reservationMarker) {
    reply = reservationMarker.before;
    try {
      const payload = JSON.parse(reservationMarker.json);
      if (supabase) {
        const minimal = {
          party_size: Number(payload.party_size),
          booking_time: payload.time || "Evening",
          status: "pending",
        };
        const error = await insertWithFallback(
          "reservations",
          { ...minimal, booking_date: payload.date, customer_phone: fromPhone },
          minimal,
        );
        if (error) console.error("Reservation insert error:", error);
      }
      reply += `\n\n *Table request logged!*\nOur team will contact you shortly to confirm your booking.`;
    } catch (err) {
      console.error("Invalid RESERVATION_DATA:", err);
    }
  }

  reply = reply.trim().slice(0, WHATSAPP_MAX_CHARS);
  await sendWhatsApp(fromPhone, reply);

  if (aiOk) await saveTurn(fromPhone, incomingText, reply);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || alreadySeen(message.id)) {
    return res.status(200).send("EVENT_RECEIVED");
  }

  try {
    await processMessage(message);
  } catch (err) {
    console.error("Webhook handler fatal error:", err);
  }

  return res.status(200).send("EVENT_RECEIVED");
}
