import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];
      
      // If delivery status update, ignore cleanly
      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = message.from;
      const incomingText = message.text.body;

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: `You are the AI concierge for "Ilhaam Royal Dining", Park Circus, Kolkata (+91 744 998 8873).
Menu: Chicken Biryani (320), Mutton Biryani (390), Butter Naan (60), Chicken Tikka (320).
Greet cordially. When an order is confirmed with name and address, end your response with:
ORDER_DATA:{"name":"...","address":"...","items":[{"name":"...","qty":1,"price":320}],"total":320}`
      });

      const result = await model.generateContent(incomingText);
      let replyText = result.response.text();

      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderJson = JSON.parse(parts[1].trim());
        const orderId = `AXL-${Date.now().toString().slice(-5)}`;

        await supabase.from("orders").insert({
          id: orderId,
          customer_phone: fromPhone,
          customer_name: orderJson.name || "Customer",
          delivery_address: orderJson.address || "Takeaway",
          items: orderJson.items || [],
          subtotal: orderJson.total || 0,
          order_status: "new"
        });

        replyText += `\n\n✅ *Order Confirmed!* Order ID: *${orderId}*.`;
      }

      // Send to Meta Graph API
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
      console.error(err);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  res.status(405).send("Method Not Allowed");
}
