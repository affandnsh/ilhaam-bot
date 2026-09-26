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
        model: "gemini-1.5-flash-latest",
        systemInstruction: `You are the AI concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu:
- Biryani: Chicken Biryani (320), Special Chicken Biryani (500), Mutton Biryani (390), Special Mutton Biryani (550)
- Starters: Chilli Chicken (250), Drums of Heaven (250), Fish Finger (370), Crispy Chilli Babycorn (210)
- Tandoor: Chicken Tikka (320), Reshmi Kebab (320), Cheese Kebab (440)
- Breads: Butter Naan (60), Garlic Cheese Naan (100), Tandoori Roti (20)
// Order handling
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;
        
        try {
          // 1. Create or find customer first
          const { data: customer } = await supabase
            .from("customers")
            .upsert({ whatsapp_number: fromPhone, name: "WhatsApp Guest" }, { onConflict: "whatsapp_number" })
            .select()
            .single();

          // 2. Insert order linked to customer
          if (customer?.id) {
            await supabase.from("orders").insert({
              order_number: orderNum,
              customer_id: customer.id,
              total: 320,
              subtotal: 320,
              status: "new",
              payment_status: "pending"
            });
          }
        } catch (dbErr) {
          console.error("Supabase insert ignored to allow reply:", dbErr);
        }

        replyText += `\n\n✅ *Order Confirmed!* Ticket: *${orderNum}*.`;
      }

      // Send reply via Meta Graph API
      const metaRes = await fetch(
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
      const metaData = await metaRes.json();
      console.log("Meta Response:", metaData);
