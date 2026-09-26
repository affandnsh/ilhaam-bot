import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. Meta Webhook Verification Handshake
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2. Incoming WhatsApp Message
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      // Ignore delivery receipts or non-text messages cleanly
      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = message.from;
      const incomingText = message.text.body;

      // Gemini AI Engine
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: `You are the AI concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu:
- Biryani: Chicken Biryani (320), Special Chicken Biryani (500), Mutton Biryani (390), Special Mutton Biryani (550)
- Starters: Chilli Chicken (250), Drums of Heaven (250), Fish Finger (370), Crispy Chilli Babycorn (210)
- Tandoor: Chicken Tikka (320), Reshmi Kebab (320), Cheese Kebab (440)
- Breads: Butter Naan (60), Garlic Cheese Naan (100), Tandoori Roti (20)

Rules:
1. Greet warmly and answer any menu/timing questions.
2. If customer wants to order: collect items, delivery address, and payment method (COD or Prepaid).
3. Once all details are finalized, end your response with:
ORDER_DATA:{"name":"...","address":"...","total":320,"items":[{"name":"...","qty":1,"price":320}]}`
      });

      const result = await model.generateContent(incomingText);
      let replyText = result.response.text();

      // Write to Supabase orders table
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderJson = JSON.parse(parts[1].trim());
        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        await supabase.from("orders").insert({
          order_number: orderNum,
          total: orderJson.total || 0,
          subtotal: orderJson.total || 0,
          status: "new",
          payment_status: "pending"
        });

        replyText += `\n\n✅ *Order Confirmed!* Ticket: *${orderNum}*.`;
      }

      // Send WhatsApp message back to customer
      await fetch(
        `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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

      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
