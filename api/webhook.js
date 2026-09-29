import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GRAPH_VERSION = "v20.0";

const HISTORY_LIMIT = 8;
const HISTORY_WINDOW_MS = 4 * 60 * 60 * 1000;
const WHATSAPP_MAX_CHARS = 4000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(
      SUPABASE_URL.replace(/\/rest\/v1\/?$/, ""),
      SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  } catch (err) {
    console.error("Supabase init error:", err);
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 4500) {
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
  if (seenMessageIds.size > 300) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  return false;
}

function waUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) return;
  await fetchWithTimeout(waUrl(), {
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
  }, 6000);
}

async function loadHistory(phone) {
  if (!supabase) return [];
  try {
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    const { data } = await supabase
      .from("chat_messages")
      .select("role, content")
      .eq("phone", phone)
      .gte("created_at", new Date(cutoff).toISOString())
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (data) return data.reverse();
  } catch (err) {}
  return [];
}

async function saveTurn(phone, userText, assistantText) {
  if (!supabase) return;
  try {
    const now = Date.now();
    await supabase.from("chat_messages").insert([
      { phone, role: "user", content: userText, created_at: new Date(now).toISOString() },
      { phone, role: "assistant", content: assistantText, created_at: new Date(now + 1).toISOString() },
    ]);
  } catch (err) {}
}

async function getMenu() {
  if (!supabase) return "";
  try {
    const { data } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg")
      .eq("is_available", true);
    if (!data?.length) return "";
    return data
      .map((item) => `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`)
      .join("\n");
  } catch (err) {
    return "";
  }
}

function buildSystemPrompt(menu) {
  return `You are "Ilhaam Concierge", the dining assistant of Ilhaam Royal Dining on WhatsApp.
RESTAURANT:
Ilhaam Royal Dining, 2A Congress Exhibition Road, Park Circus, Kolkata
Phone: +91 74499 88873

MENU:
${menu || "Crispy Fish Fingers: ₹370, Reshmi Kebab: ₹340, Chicken Tikka: ₹320, Chilli Chicken: ₹310"}

RULES:
- Keep responses short, polite, and helpful (1-2 sentences).
- If guest orders, state total price and ask to reply YES to confirm.
- If confirmed, end message with ORDER_DATA:{"items":"SUMMARY","total":NUMBER,"type":"takeaway"}`;
}

async function askGemini(systemPrompt, history, userText) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  let turns = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  turns.push({ role: "user", parts: [{ text: userText }] });

  // Single fast call to the primary model with a 4-second timeout
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: turns,
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
      }),
    },
    4500
  );

  if (res.ok) {
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  }

  const err = await res.text();
  throw new Error(`Gemini HTTP ${res.status}: ${err}`);
}

function cleanReply(reply) {
  return reply.replace(/```(?:json)?/gi, "").replace(/```/g, "").replace(/\*\*(.+?)\*\*/g, "*$1*").trim();
}

async function processMessage(message) {
  const fromPhone = String(message.from || "").replace(/\D/g, "");
  if (!fromPhone || message.type !== "text") return;

  const incomingText = message.text?.body?.trim() || "";
  if (!incomingText) return;

  const [menu, history] = await Promise.all([getMenu(), loadHistory(fromPhone)]);

  let reply;
  let aiOk = true;
  try {
    reply = await askGemini(buildSystemPrompt(menu), history, incomingText);
  } catch (err) {
    aiOk = false;
    console.error("AI Error:", err.message);
    reply = "Greetings from *Ilhaam Royal Dining*! 🍽️ How can we help you today? Would you like to view our menu, reserve a table, or place an order?";
  }

  reply = cleanReply(reply);
  if (reply.includes("ORDER_DATA:")) {
    reply = reply.split("ORDER_DATA:")[0].trim() + "\n\n✅ *Order received!* Our team is preparing it.";
  }

  await sendWhatsApp(fromPhone, reply.slice(0, WHATSAPP_MAX_CHARS));
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
    console.error("Handler error:", err);
  }
  return res.status(200).send("EVENT_RECEIVED");
}
