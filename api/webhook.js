import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-2.5-flash";

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (error) {
    console.error("SUPABASE INIT ERROR:", error);
  }
}

function log(...args) {
  console.log("[ILHAAM]", ...args);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("Missing WhatsApp credentials");
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      })
    },
    15000
  );

  const raw = await response.text();
  log("META STATUS:", response.status);
  if (!response.ok) {
    throw new Error(`Meta WhatsApp API failed (${response.status}): ${raw}`);
  }
  return true;
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  log("Calling Gemini:", GEMINI_MODEL);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    },
    20000
  );

  const raw = await response.text();
  log("GEMINI STATUS:", response.status);

  if (!response.ok) {
    throw new Error(`Gemini API failed (${response.status}): ${raw}`);
  }

  const data = JSON.parse(raw);
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) throw new Error("Gemini returned empty text");
  return text;
}

async function getMenu() {
  if (!supabase) return getEmergencyMenu();

  try {
    const { data, error } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg, is_available")
      .eq("is_available", true)
      .order("category", { ascending: true });

    if (error || !data || data.length === 0) return getEmergencyMenu();

    return data
      .map((item) => `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`)
      .join("\n");
  } catch (err) {
    return getEmergencyMenu();
  }
}

function getEmergencyMenu() {
  return `
- Fish Fingers (Starters): ₹370 [Non-Veg]
- Chilli Chicken (Starters): ₹250 [Non-Veg]
- Crispy Chilli Babycorn (Starters): ₹210 [Veg]
- Kolkata Chicken Biryani (Biryani): ₹320 [Non-Veg]
- Royal Mutton Biryani (Biryani): ₹390 [Non-Veg]
- Reshmi Kebab (Tandoor): ₹320 [Non-Veg]
- Cheese Kebab (Tandoor): ₹440 [Veg]
- Butter Naan (Breads): ₹60 [Veg]
- Garlic Cheese Naan (Breads): ₹100 [Veg]
`.trim();
}

async function getOrCreateCustomer(phone) {
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .eq("whatsapp_number", phone)
      .maybeSingle();

    if (data) return data;

    const { data: created } = await supabase
      .from("customers")
      .insert({ whatsapp_number: phone, name: "WhatsApp Guest" })
      .select()
      .single();

    return created;
  } catch (err) {
    console.error("CUSTOMER DB ERROR:", err);
    return null;
  }
}

function buildPrompt({ incomingText, phone, menu }) {
  return `
You are the authentic, highly intelligent AI Concierge for:
ILHAAM ROYAL DINING
2A Congress Exhibition Road, Park Circus, Kolkata (+91 74499 88873).

LIVE MENU FROM DATABASE:
${menu}

IMPORTANT RESTAURANT FACTS:
- Family fine-dining restaurant.
- Hookah & Alcohol are strictly NOT available.
- Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless.
- Kolkata Biryani and Drums of Heaven are bone-in.
- Mutton kebabs are NOT part of the regular daily menu (we serve Royal Mutton Biryani; mutton kebabs are chef specials on tasting nights).
- Fish option available: Fish Fingers (₹370).

INSTRUCTIONS & LOGIC:
1. Answer ANY guest inquiry naturally, politely, and logically.
2. If customer wants to order: calculate total using exact prices above, list the selected items and total, and ask:
   "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)"
3. When customer explicitly confirms (YES / CONFIRM / PROCEED / OK):
   Append at the end: ORDER_DATA:{"total":<calculated_number>,"items":"<item_summary>","type":"takeaway"}
4. When customer requests a table reservation: ask party size & time. When provided, append:
   RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}

Customer Phone: ${phone}
Customer says: "${incomingText}"

Response:
`;
}

async function saveOrder(customer, payload) {
  if (!supabase) return null;

  try {
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
    const { data } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_id: customer?.id || null,
        total: Number(payload.total) || 0,
        subtotal: Number(payload.total) || 0,
        status: "new",
        payment_status: "pending",
        order_type: payload.type || "takeaway"
      })
      .select()
      .single();

    return { orderNumber, data };
  } catch (err) {
    console.error("ORDER DB ERROR:", err);
    return null;
  }
}

async function saveReservation(customer, phone, payload) {
  if (!supabase) return null;

  try {
    const { data } = await supabase
      .from("reservations")
      .insert({
        customer_phone: phone,
        customer_name: customer?.name || "WhatsApp Guest",
        party_size: Number(payload.party_size) || 2,
        booking_time: payload.time || "Evening",
        status: "pending"
      })
      .select()
      .single();

    return data;
  } catch (err) {
    console.error("RESERVATION DB ERROR:", err);
    return null;
  }
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

  try {
    const body = req.body;
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.status(200).send("EVENT_RECEIVED");

    const fromPhone = String(message.from || "").replace(/\D/g, "");
    if (!fromPhone) return res.status(200).send("EVENT_RECEIVED");

    if (message.type === "audio" || message.type === "voice") {
      await sendWhatsApp(
        fromPhone,
        "We received your voice note 🎙️✨ Please send your query or order as text, or call +91 74499 88873 for immediate assistance."
      );
      return res.status(200).send("EVENT_RECEIVED");
    }

    if (message.type !== "text") return res.status(200).send("EVENT_RECEIVED");

    const incomingText = message.text?.body?.trim() || "";
    if (!incomingText) return res.status(200).send("EVENT_RECEIVED");

    log("CUSTOMER MESSAGE:", incomingText);

    const [customer, menu] = await Promise.all([
      getOrCreateCustomer(fromPhone),
      getMenu()
    ]);

    const prompt = buildPrompt({ incomingText, phone: fromPhone, menu });
    let replyText = await askGemini(prompt);

    // Order detection
    if (replyText.includes("ORDER_DATA:")) {
      const parts = replyText.split("ORDER_DATA:");
      replyText = parts[0].trim();
      let payload = { total: 0, type: "takeaway" };
      try {
        payload = JSON.parse(parts[1].trim());
      } catch (e) {}

      const savedOrder = await saveOrder(customer, payload);
      const orderId = savedOrder ? savedOrder.orderNumber : `ORD-${Date.now().toString().slice(-6)}`;
      replyText += `\n\n✅ *Order Ticket Created:* *${orderId}*\nYour order has been taken! Our team will contact you shortly for confirmation and details.`;
    }

    // Reservation detection
    if (replyText.includes("RESERVATION_DATA:")) {
      const parts = replyText.split("RESERVATION_DATA:");
      replyText = parts[0].trim();
      let resPayload = { party_size: 2, time: "Evening" };
      try {
        resPayload = JSON.parse(parts[1].trim());
      } catch (e) {}

      await saveReservation(customer, fromPhone, resPayload);
      replyText += `\n\n✅ *Reservation Logged!*\nOur team will contact you shortly to confirm your booking.`;
    }

    await sendWhatsApp(fromPhone, replyText);
    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
