import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-3.8-flash";

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } catch (err) {}
}

async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;
  await fetch(url, {
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
}

// Official Interactions API for gemini-3.8-flash
async function askGemini(prompt) {
  // 1. Try official Interactions endpoint
  const interactionsUrl = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${GEMINI_API_KEY}`;
  
  try {
    const res = await fetch(interactionsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt
      })
    });

    if (res.ok) {
      const data = await res.json();
      const output = data.output_text || data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (output) return output.trim();
    }
  } catch (e) {
    console.warn("Interactions API call error:", e.message);
  }

  // 2. Fallback to standard generateContent if interactions isn't provisioned yet
  const standardUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const stdRes = await fetch(standardUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!stdRes.ok) {
    const err = await stdRes.text();
    throw new Error(`Gemini failed ${stdRes.status}: ${err}`);
  }

  const stdData = await stdRes.json();
  return stdData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function getMenu() {
  if (!supabase) return "";
  try {
    const { data } = await supabase
      .from("menu_items")
      .select("name, category, price, is_veg")
      .eq("is_available", true);
    if (!data) return "";
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

    const prompt = `You are the authentic dining concierge for Ilhaam Royal Dining, Kolkata (+91 74499 88873).
Menu:
${menu}

Restaurant details:
- Fine dining. Strictly NO hookah and NO alcohol.
- Reshmi Kebab, Chicken Tikka, Chilli Chicken are boneless.
- Kolkata Biryanis & Drums of Heaven are bone-in.
- Fish dish: Crispy Fish Fingers (₹370).

Customer message: "${incomingText}"

Rules:
1. Answer the customer naturally, conversationally, and helpfully.
2. If customer says "I would like to place an order" or "I want to order", ask them what dishes and quantities they would like. Do NOT confirm an order yet.
3. Only when the customer clearly names items and quantities, calculate the total from the menu and ask them to confirm.
4. Only when customer explicitly confirms (YES, CONFIRM), append at the end:
ORDER_DATA:{"items":"summary of items","total":number,"type":"takeaway"}
5. For table bookings, ask guests, date, and time. When all provided, append:
RESERVATION_DATA:{"party_size":number,"time":"time"}

Response:`;

    let reply = "";
    try {
      reply = await askGemini(prompt);
    } catch (e) {
      console.error("AI Error:", e);
      if (incomingText.toLowerCase().includes("order")) {
        reply = "We would love to take your order! 🍽️ What delicious dishes from our royal menu would you like to have today?";
      } else if (incomingText.toLowerCase().includes("menu")) {
        reply = "Here is our full menu link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view 🍽️✨ What can we prepare for you?";
      } else {
        reply = "Warm greetings from Ilhaam Royal Dining! 🍽️✨ How may we assist you today? You can ask about our menu, place an order, or reserve a table.";
      }
    }

    // Process database writes ONLY if real ORDER_DATA exists
    if (reply.includes("ORDER_DATA:")) {
      const parts = reply.split("ORDER_DATA:");
      reply = parts[0].trim();
      let payload = { total: 0, type: "takeaway" };
      try { payload = JSON.parse(parts[1].trim()); } catch (err) {}
      
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
        reply += `\n\n✅ *Order Ticket Created:* *${orderNumber}*\nYour order has been recorded! Our team will contact you shortly.`;
      }
    }

    if (reply.includes("RESERVATION_DATA:")) {
      const parts = reply.split("RESERVATION_DATA:");
      reply = parts[0].trim();
      reply += `\n\n✅ *Table Request Logged!*\nOur team will contact you shortly to confirm your booking.`;
    }

    await sendWhatsApp(fromPhone, reply);
    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
