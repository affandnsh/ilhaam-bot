import { createClient } from "@supabase/supabase-js";

/*
========================================================
ILHAAM ROYAL DINING — WHATSAPP AI WEBHOOK
Production-safe version
========================================================
*/

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
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  } catch (error) {
    console.error("SUPABASE INIT ERROR:", error);
  }
}

/*
========================================================
HELPERS
========================================================
*/

function log(...args) {
  console.log("[ILHAAM]", ...args);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_PHONE_ID) {
    throw new Error("WHATSAPP_PHONE_ID is missing");
  }

  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is missing");
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  log("Sending WhatsApp message to:", to);

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
        text: {
          body: text
        }
      })
    },
    15000
  );

  const raw = await response.text();
  log("META STATUS:", response.status);
  log("META RESPONSE:", raw);

  if (!response.ok) {
    throw new Error(`Meta WhatsApp API failed (${response.status}): ${raw}`);
  }

  return true;
}

/*
========================================================
GEMINI
========================================================
*/

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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    },
    20000
  );

  const raw = await response.text();
  log("GEMINI STATUS:", response.status);

  if (!response.ok) {
    throw new Error(`Gemini API failed (${response.status}): ${raw}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no usable text");
  }

  return text;
}

/*
========================================================
MENU
========================================================
*/

async function getMenu() {
  if (!supabase) {
    log("Supabase unavailable — using emergency menu.");
    return getEmergencyMenu();
  }

  try {
    const { data, error } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg, is_available")
      .eq("is_available", true)
      .order("category", { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      log("Supabase menu is empty — using emergency menu.");
      return getEmergencyMenu();
    }

    log(`Loaded ${data.length} menu items from Supabase.`);

    return data
      .map((item) => {
        const vegStatus = item.is_veg ? "Veg" : "Non-Veg";
        return `- ${item.name} | ${item.category} | ₹${item.price} | ${vegStatus}`;
      })
      .join("\n");
  } catch (error) {
    console.error("MENU DATABASE ERROR:", error);
    return getEmergencyMenu();
  }
}

function getEmergencyMenu() {
  return `
- Fish Fingers | Starters | ₹370 | Non-Veg
- Chilli Chicken | Starters | ₹250 | Non-Veg
- Crispy Chilli Babycorn | Starters | ₹210 | Veg
- Kolkata Chicken Biryani | Biryani | ₹320 | Non-Veg
- Royal Mutton Biryani | Biryani | ₹390 | Non-Veg
- Reshmi Kebab | Tandoor | ₹320 | Non-Veg
- Cheese Kebab | Tandoor | ₹440 | Veg
- Butter Naan | Breads | ₹60 | Veg
- Garlic Cheese Naan | Breads | ₹100 | Veg
`.trim();
}

/*
========================================================
CUSTOMER
========================================================
*/

async function getOrCreateCustomer(phone) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from("customers")
      .upsert(
        {
          whatsapp_number: phone,
          name: "WhatsApp Guest"
        },
        {
          onConflict: "whatsapp_number"
        }
      )
      .select()
      .single();

    if (error) {
      console.error("CUSTOMER DATABASE ERROR:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("CUSTOMER ERROR:", error);
    return null;
  }
}

/*
========================================================
MAIN AI PROMPT
========================================================
*/

function buildPrompt({ incomingText, phone, menu }) {
  return `
You are the official WhatsApp AI dining concierge for:
ILHAAM ROYAL DINING

Address:
2A Congress Exhibition Road, Park Circus, Kolkata
Restaurant phone: +91 74499 88873

IMPORTANT RESTAURANT INFORMATION:
- Family fine-dining restaurant.
- Hookah & Alcohol are strictly NOT available.
- Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless.
- Biryanis and Drums of Heaven are bone-in.
- Mutton kebabs are NOT part of the regular daily menu.
- Fish option currently available: Fish Fingers (₹370).
- Be polite, warm, and concise.
- Never invent menu items or prices.

LIVE MENU FROM DATABASE:
${menu}

CUSTOMER:
Phone: ${phone}
Latest message: "${incomingText}"

INSTRUCTIONS:
1. Answer naturally and helpfully.
2. If customer wants to order: calculate the total from the menu, summarize the items and prices, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? Reply YES to confirm."
3. When the customer confirms with YES, CONFIRM, etc., append at the very end:
ORDER_DATA:{"total":480,"type":"takeaway"}
4. When customer wants table reservation: ask party size & time. When provided, append:
RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}
`;
}

/*
========================================================
ORDER & RESERVATION PERSISTENCE
========================================================
*/

async function saveOrder(customer, payload) {
  if (!supabase || !customer?.id) return null;

  try {
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
    const { data, error } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_id: customer.id,
        total: Number(payload.total) || 0,
        subtotal: Number(payload.total) || 0,
        status: "new",
        payment_status: "pending",
        order_type: payload.type || "takeaway"
      })
      .select()
      .single();

    if (error) {
      console.error("ORDER DATABASE ERROR:", error);
      return null;
    }
    return { orderNumber, data };
  } catch (error) {
    console.error("ORDER SAVE ERROR:", error);
    return null;
  }
}

async function saveReservation(customer, phone, payload) {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
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

    if (error) {
      console.error("RESERVATION DATABASE ERROR:", error);
      return null;
    }
    return data;
  } catch (error) {
    console.error("RESERVATION SAVE ERROR:", error);
    return null;
  }
}

function extractOrderData(reply) {
  const marker = "ORDER_DATA:";
  if (!reply.includes(marker)) return { cleanReply: reply, payload: null };

  const index = reply.indexOf(marker);
  const cleanReply = reply.substring(0, index).trim();
  const jsonText = reply.substring(index + marker.length).trim();

  try {
    return { cleanReply, payload: JSON.parse(jsonText) };
  } catch (error) {
    return { cleanReply, payload: null };
  }
}

function extractReservationData(reply) {
  const marker = "RESERVATION_DATA:";
  if (!reply.includes(marker)) return { cleanReply: reply, payload: null };

  const index = reply.indexOf(marker);
  const cleanReply = reply.substring(0, index).trim();
  const jsonText = reply.substring(index + marker.length).trim();

  try {
    return { cleanReply, payload: JSON.parse(jsonText) };
  } catch (error) {
    return { cleanReply, payload: null };
  }
}

/*
========================================================
WEBHOOK HANDLER
========================================================
*/

export default async function handler(req, res) {
  // GET = Verification
  if (req.method === "GET") {
    if (req.query?.health === "1") {
      return res.status(200).json({
        ok: true,
        service: "Ilhaam Royal Dining WhatsApp Bot",
        geminiConfigured: !!GEMINI_API_KEY,
        whatsappConfigured: !!WHATSAPP_PHONE_ID && !!WHATSAPP_ACCESS_TOKEN,
        supabaseConfigured: !!SUPABASE_URL && !!SUPABASE_SECRET_KEY,
        model: GEMINI_MODEL
      });
    }

    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = req.body;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) {
      return res.status(200).send("EVENT_RECEIVED");
    }

    const fromPhone = String(message.from || "").replace(/\D/g, "");
    if (!fromPhone) return res.status(200).send("EVENT_RECEIVED");

    if (message.type === "audio" || message.type === "voice") {
      try {
        await sendWhatsApp(
          fromPhone,
          "We received your voice note 🎙️✨\n\nFor now, please send your order or question as a text message and we'll be happy to help."
        );
      } catch (e) {
        console.error("VOICE REPLY FAILED:", e);
      }
      return res.status(200).send("EVENT_RECEIVED");
    }

    if (message.type !== "text") {
      return res.status(200).send("EVENT_RECEIVED");
    }

    const incomingText = message.text?.body?.trim() || "";
    if (!incomingText) return res.status(200).send("EVENT_RECEIVED");

    log("CUSTOMER MESSAGE:", incomingText);

    const [customer, menu] = await Promise.all([
      getOrCreateCustomer(fromPhone),
      getMenu()
    ]);

    let replyText = "";
    try {
      const prompt = buildPrompt({ incomingText, phone: fromPhone, menu });
      replyText = await askGemini(prompt);
      log("GEMINI REPLY:", replyText);
    } catch (error) {
      console.error("GEMINI FAILED:", error);
      replyText =
        "Welcome to *Ilhaam Royal Dining*! 🍽️✨ How may we assist your dining experience today? You can ask about our menu, place an order, or reserve a table.";
    }

    // Process Orders
    const orderResult = extractOrderData(replyText);
    replyText = orderResult.cleanReply;

    if (orderResult.payload) {
      const savedOrder = await saveOrder(customer, orderResult.payload);
      if (savedOrder) {
        replyText += `\n\n✅ *Order Created*\nOrder ID: *${savedOrder.orderNumber}*\nThank you for ordering with us.`;
      }
    }

    // Process Reservations
    const reservationResult = extractReservationData(replyText);
    replyText = reservationResult.cleanReply;

    if (reservationResult.payload) {
      const savedRes = await saveReservation(customer, fromPhone, reservationResult.payload);
      if (savedRes) {
        replyText += `\n\n✅ *Table Request Logged!*\nOur team will contact you to confirm the reservation.`;
      }
    }

    if (!replyText || !replyText.trim()) {
      replyText = "Thank you for contacting *Ilhaam Royal Dining*! 🍽️\nHow may I assist you today?";
    }

    try {
      await sendWhatsApp(fromPhone, replyText);
      log("WHATSAPP RESPONSE SENT SUCCESSFULLY");
    } catch (error) {
      console.error("!!!!!!!! META SEND FAILED !!!!!!!!", error);
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("!!!!!!!! CRITICAL WEBHOOK ERROR !!!!!!!!", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
