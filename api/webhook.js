import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
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
    const body = req.body;

    // Immediately respond 200 OK so Meta doesn't retry
    res.status(200).send("EVENT_RECEIVED");

    try {
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];
      if (!message || message.type !== "text") return;

      const fromPhone = message.from; // Customer's WhatsApp number
      const incomingText = message.text.body;

      // Gemini Model setup with ordering instructions
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: `You are the AI concierge for Ilhaam Royal Dining, Kolkata (Phone: +91 744 998 8873).
Help customers order or book tables. Keep replies short, warm, and clear.
When a customer confirms items, address, and payment (COD/Prepaid), summarize their order clearly.`
      });

      const result = await model.generateContent(incomingText);
      const replyText = result.response.text();

      // Send response back to customer via Meta Cloud API
      await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: fromPhone,
          type: "text",
          text: { body: replyText }
        })
      });
    } catch (err) {
      console.error("Webhook processing error:", err);
    }
    return;
  }

  res.status(405).send("Method Not Allowed");
}
