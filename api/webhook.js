import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

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

      // Ignore delivery receipts or non-text messages
      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body;

      let replyText = "";

      // Call Gemini API via direct REST (100% stable, bypasses SDK version bugs)
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: incomingText }] }],
              systemInstruction: {
                parts: [{
                  text: `You are the WhatsApp AI concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu: Chicken Biryani (320), Special Chicken Biryani (500), Mutton Biryani (390), Butter Naan (60), Chicken Tikka (320).
Greet the customer politely, answer menu queries briefly. If they order, give a warm confirmation.`
                }]
              }
            })
          }
        );
        const geminiData = await geminiRes.json();
        replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch (aiErr) {
        console.error("Gemini fallback triggered:", aiErr);
      }

      // Safe Fallback if Gemini key is rate-limited or fails
      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️\nHow can we help you today?\n\n1. View Menu\n2. Order Food (Chicken Biryani ₹320, Mutton Biryani ₹390)\n3. Book a Table\n\nCall us: +91 744 998 8873";
      }

      // Safe Supabase Customer & Order insertion
      try {
        const { data: customer } = await supabase
          .from("customers")
          .upsert(
            { whatsapp_number: fromPhone, name: "WhatsApp Guest" },
            { onConflict: "whatsapp_number" }
          )
          .select()
          .single();

        if (customer?.id && incomingText.toLowerCase().includes("order")) {
          await supabase.from("orders").insert({
            order_number: `ORD-${Date.now().toString().slice(-4)}`,
            customer_id: customer.id,
            total: 320,
            subtotal: 320,
            status: "new",
            payment_status: "pending"
          });
        }
      } catch (dbErr) {
        console.error("DB error ignored to preserve WhatsApp reply:", dbErr);
      }

      // Send WhatsApp message back to customer via Meta API
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
      console.log("Meta API Response:", JSON.stringify(metaData));

      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Critical webhook error:", err);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
