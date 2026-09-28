import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GRAPH_VERSION = "v26.0";

let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(
      SUPABASE_URL.replace(/\/rest\/v1\/?$/, ""),
      SUPABASE_SECRET_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );
  } catch (err) {
    console.error("Supabase init error:", err);
  }
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_PHONE_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp environment variables missing");
  }
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
    const body = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${body}`);
  }
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  const models = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 800
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((part) => part?.text || "")
          .join("")
          .trim();
        if (text) return text;
      }
    } catch (e) {
      console.warn(`Model ${model} request error:`, e.message);
    }
  }

  throw new Error("All model endpoints failed");
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
      .map((item) => `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`)
      .join("\n");
  } catch (err) {
    console.error("getMenu error:", err);
    return "";
  }
}

function cleanModelMarkers(reply) {
  return reply.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function extractMarker(reply, marker) {
  const index = reply.indexOf(marker);
  if (index === -1) return null;
  const before = reply.slice(0, index).trim();
  const after = reply.slice(index + marker.length).trim();
  return { before, after };
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
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") {
      return res.status(200).send("EVENT_RECEIVED");
    }

    const fromPhone = String(message.from || "").replace(/\D/g, "");
    const incomingText = message.text?.body?.trim() || "";
    if (!fromPhone || !incomingText) {
      return res.status(200).send("EVENT_RECEIVED");
    }

    const menu = await getMenu();
    const prompt = `You are the authentic AI dining concierge for Ilhaam Royal Dining.
RESTAURANT:
Ilhaam Royal Dining
2A Congress Exhibition Road, Park Circus, Kolkata
Phone: +91 74499 88873

LIVE MENU FROM DATABASE:
${menu || "(Menu database is currently unavailable. Do not invent menu items or prices.)"}

RESTAURANT FACTS:
- Upscale family fine dining.
- Hookah and alcohol are strictly prohibited and never served.
- Reshmi Kebab, Chicken Tikka, and Chilli Chicken are 100% boneless.
- Kolkata Biryanis and Drums of Heaven are bone-in.
- Crispy Fish Fingers are available for ₹370.
- Mutton kebabs are chef tasting specials and are not on the regular daily menu.

CUSTOMER MESSAGE:
"${incomingText}"

RULES:
1. Reply naturally, warmly and briefly like a professional WhatsApp dining concierge.
2. Answer menu, price, spice, vegetarian, boneless/bone-in and restaurant questions using only the supplied menu and facts.
3. Never invent a price or menu item.
4. If the customer wants to order, identify the requested menu item(s), calculate the total from the supplied menu, show a clear summary, and ask:
   "Shall I confirm this order for you? Reply YES to confirm."
5. Do NOT create ORDER_DATA until the customer explicitly says YES or CONFIRM.
6. If the customer says YES/CONFIRM but there is no clearly established pending order in the current message/context, ask what they would like to order instead of inventing an order.
7. If the customer wants a table reservation, ask for any missing party size, date, and preferred time.
8. Only when all reservation details are present, append exactly:
   RESERVATION_DATA:{"party_size":NUMBER,"date":"DATE","time":"TIME"}
9. Only after explicit order confirmation, append exactly:
   ORDER_DATA:{"items":"ITEM SUMMARY","total":NUMBER,"type":"takeaway"}
10. Put the marker on the final line and do not put anything after it.
11. Do not use Markdown tables.

Response:`;

    let reply;
    try {
      reply = await askGemini(prompt);
    } catch (err) {
      console.error("AI Generation Error:", err);
      reply = "Welcome to *Ilhaam Royal Dining*! 🍽️✨ How may we assist your dining experience today? You can ask about our menu, dietary options, or place an order.";
    }

    reply = cleanModelMarkers(reply);

    // Process Orders into Supabase
    const orderMarker = extractMarker(reply, "ORDER_DATA:");
    if (orderMarker) {
      reply = orderMarker.before;
      try {
        const payload = JSON.parse(orderMarker.after);
        const total = Number(payload.total);
        const items = String(payload.items || "").trim();

        if (supabase && Number.isFinite(total) && total > 0 && items) {
          const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
          const { error } = await supabase.from("orders").insert({
            order_number: orderNumber,
            total,
            subtotal: total,
            status: "new",
            payment_status: "pending",
            order_type: payload.type || "takeaway"
          });

          if (!error) {
            reply += `\n\n✅ *Order Ticket Created:* *${orderNumber}*\nYour order has been recorded! Our counter team will prepare it for you.`;
          }
        }
      } catch (err) {
        console.error("Invalid ORDER_DATA:", err);
      }
    }

    // Process Reservations into Supabase
    const reservationMarker = extractMarker(reply, "RESERVATION_DATA:");
    if (reservationMarker) {
      reply = reservationMarker.before;
      try {
        const payload = JSON.parse(reservationMarker.after);
        if (supabase) {
          await supabase.from("reservations").insert({
            party_size: Number(payload.party_size),
            booking_time: payload.time || "Evening",
            status: "pending"
          });
        }
        reply += `\n\n✅ *Table Request Logged!*\nOur team will contact you shortly to confirm your booking.`;
      } catch (err) {
        console.error("Invalid RESERVATION_DATA:", err);
      }
    }

    await sendWhatsApp(fromPhone, reply.trim());
    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook handler fatal error:", err);
    return res.status(200).send("EVENT_RECEIVED");
  }
}