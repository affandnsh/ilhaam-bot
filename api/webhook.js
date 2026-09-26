import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. Meta Webhook Handshake
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2. Inbound Message Processing
  if (req.method === "POST") {
    res.status(200).send("EVENT_RECEIVED");

    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];
      if (!message || message.type !== "text") return;

      const fromPhone = message.from;
      const incomingText = message.text.body;

      // Gemini Model setup
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: `You are the WhatsApp AI concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata. Phone: +91 744 998 8873.

Core Menu:
- Starters: Crispy Chilli Babycorn (210), Chilli Chicken Dry (250), Drum of Heaven (250), Fish Finger Kolkata Vetki (370)
- Tandoor: Chicken Tikka (320), Reshmi Kebab (320), Ilhaam Special Cheese Kebab (440)
- Biryani: Chicken Biryani (320), Chicken Special (500), Mutton Biryani (390), Mutton Special (550)
- Mains: Chicken Bharta (300), Mutton Kassa (440), Paneer Butter Masala (240), Dal Makhani (170)
- Breads: Tandoori Roti (20), Butter Naan (60), Garlic Cheese Naan (100)

If customer is greeting:
Offer 3 options:
1. Place Food Order
2. Reserve a Table
3. View Full Menu

When customer confirms order items, name, delivery address/table, and payment preference (COD/Prepaid):
Summarize politely and append exact JSON at the very end:
ORDER_DATA:{"name":"...","address":"...","payment":"cod","items":[{"name":"...","qty":1,"price":320}],"total":320}

For table reservations:
RESERVATION_DATA:{"name":"...","party_size":2,"time":"..."}`
      });

      const result = await model.generateContent(incomingText);
      let replyText = result.response.text();

      // Order submission to Supabase
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderJson = JSON.parse(parts[1].trim());

        const orderId = `AXL-${Date.now().toString().slice(-6)}`;
        await supabase.from("orders").insert({
          id: orderId,
          customer_phone: fromPhone,
          customer_name: orderJson.name || "Customer",
          delivery_address: orderJson.address || "Dine-in / Takeaway",
          items: orderJson.items || [],
          subtotal: orderJson.total || 0,
          payment_method: orderJson.payment || "cod",
          payment_status: "pending",
          order_status: "new"
        });

        replyText += `\n\n✅ *Order Confirmed!* Your Order ID is *${orderId}*. Sent to our kitchen team.`;
      }

      // Reservation submission to Supabase
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        const resJson = JSON.parse(parts[1].trim());

        await supabase.from("reservations").insert({
          customer_phone: fromPhone,
          customer_name: resJson.name || "Guest",
          party_size: resJson.party_size || 2,
          booking_time: resJson.time || "Tonight",
          status: "confirmed"
        });

        replyText += `\n\n✅ *Table Reserved!* We look forward to hosting you at Ilhaam Royal Dining.`;
      }

      // Send WhatsApp Reply via Meta API
      await fetch(
        `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: fromPhone,
            type: "text",
            text: { body: replyText }
          })
        }
      );
    } catch (err) {
      console.error("Webhook processing error:", err);
    }
    return;
  }

  res.status(405).send("Method Not Allowed");
}
