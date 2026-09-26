import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

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

  // 2. Incoming WhatsApp Message
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body.trim();

      // System Prompt for Dynamic Conversational Gemini
      const prompt = `You are the authentic AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu & Pricing:
- Biryani: Chicken Biryani (₹320), Special Chicken Biryani (₹500), Mutton Biryani (₹390), Special Mutton Biryani (₹550)
- Starters: Chilli Chicken (₹250), Drums of Heaven (₹250), Fish Finger (₹370), Crispy Chilli Babycorn (₹210)
- Tandoor: Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)
- Breads: Butter Naan (₹60), Garlic Cheese Naan (₹100), Tandoori Roti (₹20)

Customer Message: "${incomingText}"

Instructions:
1. Answer any question conversationally (menu items, pricing, timings, recommendations, ingredients).
2. If customer is asking for menu, show clear categorized items with prices.
3. If customer specifies items to order, extract item names, quantities, and their delivery address/name. Confirm the order warmly, and ALWAYS append at the very end of your message:
ORDER_DATA:{"name":"Guest","items":[{"name":"Biryani","qty":1,"price":320}],"total":320}
4. If customer requests a table reservation, ask or extract party size, name, and time. Confirm the request, and ALWAYS append at the very end:
RESERVATION_DATA:{"name":"Guest","party_size":2,"time":"Evening"}
5. Keep tone luxurious, warm, and brief.`;

      let replyText = "";

      // Call Google Gemini REST API
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
          }
        );
        const data = await geminiRes.json();
        replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch (err) {
        console.error("Gemini API call failed:", err);
      }

      // Contextual Fallback if external API drops
      if (!replyText) {
        const lower = incomingText.toLowerCase();
        if (lower.includes("menu")) {
          replyText = "📜 *Ilhaam Royal Dining Menu*:\n\n• Chicken Biryani: ₹320\n• Mutton Biryani: ₹390\n• Chicken Tikka: ₹320\n• Butter Naan: ₹60\n\nPlease let us know what you'd like to order!";
        } else {
          replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️\nHow may we serve you today?\n\n• Reply with your order\n• Ask to *Book a Table*\n• Request the *Menu*";
        }
      }

      // Handle Order Processing & DB Storage
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let orderPayload = { total: 320, name: "WhatsApp Guest" };
        try {
          orderPayload = JSON.parse(parts[1].trim());
        } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        try {
          // 1. Ensure Customer Exists
          const { data: customer } = await supabase
            .from("customers")
            .upsert(
              {
                whatsapp_number: fromPhone,
                name: orderPayload.name || "WhatsApp Guest",
                last_order_at: new Date().toISOString()
              },
              { onConflict: "whatsapp_number" }
            )
            .select()
            .single();

          // 2. Insert into Orders Table
          if (customer?.id) {
            await supabase.from("orders").insert({
              order_number: orderNum,
              customer_id: customer.id,
              total: orderPayload.total || 320,
              subtotal: orderPayload.total || 320,
              status: "new",
              payment_status: "pending",
              order_type: "delivery"
            });
          }
        } catch (dbErr) {
          console.error("Supabase Order Error:", dbErr);
        }

        // Exact required confirmation phrasing
        replyText += `\n\n✅ *Order Ticket:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
      }

      // Handle Reservation Processing & DB Storage
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        let resPayload = { party_size: 2, time: "Evening", name: "WhatsApp Guest" };
        try {
          resPayload = JSON.parse(parts[1].trim());
        } catch (e) {}

        try {
          await supabase.from("reservations").insert({
            customer_phone: fromPhone,
            customer_name: resPayload.name || "WhatsApp Guest",
            party_size: resPayload.party_size || 2,
            booking_time: resPayload.time || "Evening",
            status: "pending"
          });
        } catch (resErr) {
          console.error("Supabase Reservation Error:", resErr);
        }

        replyText += `\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining, you'll receive a confirmation call soon.`;
      }

      // Send Response to Customer via WhatsApp
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
