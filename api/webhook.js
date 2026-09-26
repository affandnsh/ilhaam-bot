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

  // 2. Incoming WhatsApp Webhook Event
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body.trim();
      const lowerText = incomingText.toLowerCase();

      let replyText = "";

      // Try Gemini 1.5 Flash REST API
      try {
        const prompt = `You are the AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu: Chicken Biryani (320), Special Chicken Biryani (500), Mutton Biryani (390), Butter Naan (60), Chicken Tikka (320).
User message: "${incomingText}"

Instructions:
- If customer asks for menu or options: provide clear menu items with prices.
- If customer wants to order: acknowledge the order politely, confirm items, and append ORDER_DATA:{"total":320}
- If customer wants to book a table or reserve: confirm table booking and append RESERVATION_DATA:{"party_size":2}
- Keep replies courteous, concise, and helpful.`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          }
        );
        const data = await geminiRes.json();
        replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch (err) {
        console.error("Gemini primary call error:", err);
      }

      // Robust Conversational Fallback Engine
      if (!replyText) {
        if (lowerText.includes("menu") || lowerText === "3" || lowerText.includes("view")) {
          replyText = "📜 *Ilhaam Royal Dining Menu*:\n\n• Chicken Biryani: ₹320\n• Special Chicken Biryani: ₹500\n• Mutton Biryani: ₹390\n• Special Mutton Biryani: ₹550\n• Chicken Tikka: ₹320\n• Butter Naan: ₹60\n\nTo order, reply with the items you'd like (e.g. *1 Chicken Biryani and 1 Butter Naan*).";
        } else if (lowerText.includes("book") || lowerText.includes("table") || lowerText === "2" || lowerText.includes("reservation")) {
          replyText = "🍽️ *Table Reservation Request Received!*\n\nPlease share your *Party Size* and *Preferred Time* (e.g., *Table for 4 at 8:30 PM*).\n\nRESERVATION_DATA:{\"party_size\":2}";
        } else if (lowerText.includes("order") || lowerText.includes("biryani") || lowerText === "1" || lowerText.includes("naan")) {
          replyText = "🍛 *Order Registered!*\nWe are preparing your items for delivery/takeaway.\n\nORDER_DATA:{\"total\":380}";
        } else {
          replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️\nHow may we serve you today?\n\n1. Place an Order\n2. Book a Table\n3. View Menu\n\nCall Us: +91 744 998 8873";
        }
      }

      // 3. Supabase Integration: Insert Orders
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        try {
          const { data: cust } = await supabase
            .from("customers")
            .upsert({ whatsapp_number: fromPhone, name: "WhatsApp Guest" }, { onConflict: "whatsapp_number" })
            .select()
            .single();

          if (cust?.id) {
            await supabase.from("orders").insert({
              order_number: orderNum,
              customer_id: cust.id,
              total: 380,
              subtotal: 380,
              status: "new",
              payment_status: "pending"
            });
          }
        } catch (dbErr) {
          console.error("Order Supabase write error:", dbErr);
        }

        replyText += `\n\n✅ *Ticket Created:* *${orderNum}*. The kitchen has received your ticket!`;
      }

      // 4. Supabase Integration: Insert Table Reservations
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();

        try {
          await supabase.from("reservations").insert({
            customer_phone: fromPhone,
            customer_name: "WhatsApp Guest",
            party_size: 2,
            booking_time: "Evening",
            status: "pending"
          });
        } catch (resErr) {
          console.error("Reservation Supabase write error:", resErr);
        }

        replyText += `\n\n✅ *Table Logged:* Our reservation desk will confirm your spot shortly.`;
      }

      // 5. Send Formatted Message back to Customer via Meta Graph API
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
