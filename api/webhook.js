import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-3.8-flash";

// Official SDK Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (err) {
    console.error("Supabase init error:", err);
  }
}

async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  const res = await fetch(url, {
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
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Meta WhatsApp send failed (${res.status}):`, errText);
  }
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  // 1. Primary: Use the official SDK Interactions/generate method
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });
    const output = response.text;
    if (output) return output.trim();
  } catch (err) {
    console.warn("Primary SDK call failed, trying direct endpoint:", err.message);
  }

  // 2. Fallback: Direct endpoint with API key parameter
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text returned by Gemini");
  return text.trim();
}

async function getMenu() {
  if (!supabase) return "";
  try {
    const { data } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg")
      .eq("is_available", true);
    if (!data || data.length === 0) return "";
    return data
      .map((i) => `- ${i.name} (${i.category}): ₹${i.price} [${i.is_veg ? "Veg" : "Non-Veg"}]`)
      .join("\n");
  } catch (e) {
    return "";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    if (req.query?.["hub.mode"] === "subscribe" && req.query?.["hub.verify_token"] === VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return res.status(200).send("EVENT_RECEIVED");

    const fromPhone = String(message.from || "").replace(/\D/g, "");
    const incomingText = message.text?.body?.trim() || "";

    const menu = await getMenu();

    const prompt = `You are the authentic AI dining concierge for Ilhaam Royal Dining, 2A Congress Exhibition Road, Park Circus, Kolkata (+91 74499 88873).

LIVE MENU:
${menu}

RESTAURANT RULES & FACTS:
- Upscale family fine dining.
- Hookah and Alcohol are strictly prohibited and never served.
- Reshmi Kebab, Chicken Tikka, and Chilli Chicken are 100% boneless.
- Kolkata Biryanis & Drums of Heaven are bone-in.
- Fish dish available: Crispy Fish Fingers (₹370).
- Mutton kebabs are chef tasting specials and not on the regular daily menu.

CUSTOMER MESSAGE:
"${incomingText}"

INSTRUCTIONS:
1. Reason and converse completely naturally like a professional dining concierge.
2. If customer asks questions about menu, prices, spices, boneless/bone-in, answer accurately based on the facts above.
3. If customer expresses intent to order dishes (e.g. "I would like to take fish fingers"):
   - Identify the item and calculate total price from the menu.
   - Summarize the items and total price clearly.
   - Ask them: "Shall I confirm this order for you? (Reply YES to confirm)"
4. DO NOT finalize the order until customer explicitly confirms with YES / CONFIRM.
5. Once the customer explicitly confirms (YES, CONFIRM), append at the very end of your response:
   ORDER_DATA:{"items":"item summary","total":calculated_number,"type":"takeaway"}
6. If customer wants to reserve a table, ask for party size, date, and preferred time. When all provided, append:
   RESERVATION_DATA:{"party_size":number,"time":"time"}

Response:`;

    let reply = "";
    try {
      reply = await askGemini(prompt);
    } catch (e) {
      console.error("AI Generation Error:", e);
      reply = "Warm greetings from Ilhaam Royal Dining! 🍽️✨ How may we assist your dining experience today? You can ask about our menu, dietary preferences, or place an order.";
    }

    // Process Orders into Supabase
    if (reply.includes("ORDER_DATA:")) {
      const parts = reply.split("ORDER_DATA:");
      reply = parts[0].trim();
      let payload = { total: 0, type: "takeaway" };
      try {
        payload = JSON.parse(parts[1].trim());
      } catch (err) {}

      const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
      if (supabase && payload.total > 0) {
        await supabase.from("orders").insert({
          order_number: orderNumber,
          total: payload.total,
          subtotal: payload.total,
          status: "new",
          payment_status: "pending",
          order_type: payload.type || "takeaway"
        });
        reply += `\n\n✅ *Order Ticket Created:* *${orderNumber}*\nYour order has been recorded! Our counter team will prepare it for you.`;
      }
    }

    // Process Reservations into Supabase
    if (reply.includes("RESERVATION_DATA:")) {
      const parts = reply.split("RESERVATION_DATA:");
      reply = parts[0].trim();
      reply += `\n\n✅ *Table Request Logged!*\nOur team will contact you shortly to confirm your booking.`;
    }

    await sendWhatsApp(fromPhone, reply);
    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook handler fatal error:", err);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
