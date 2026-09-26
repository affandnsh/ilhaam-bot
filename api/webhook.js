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
      const lowerText = incomingText.toLowerCase();

      let replyText = "";

      // Check if user is asking for the menu
      if (lowerText.includes("menu") || lowerText === "3" || lowerText.includes("card") || lowerText.includes("list")) {
        replyText = `Welcome to *Ilhaam Royal Dining*! 🍽️✨\n\nWe present an exquisite culinary journey across vegetarian and non-vegetarian delicacies:\n\n• *Starters & Platters:* Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)\n• *Chef's Signature Tandoor:* Ilhaam's Special Kebab Platter, Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)\n• *Royal Biryanis:* Kolkata Chicken Biryani (₹320), Special Mutton Biryani (₹550)\n• *Breads:* Butter Naan (₹60), Garlic Cheese Naan (₹100)\n\n📖 *To explore our complete dining & dessert collection, please view our full menu here:*\nhttps://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view\n\nWhat would you like to savor today?`;
      } else {
        // Full Conversational Engine via Google Gemini REST
        const prompt = `You are the authentic AI Concierge for "Ilhaam Royal Dining", a luxury fine-dining restaurant in Park Circus, Kolkata (+91 744 998 8873).
Menu highlights: Fish Finger (₹370), Chicken Biryani (₹320), Mutton Biryani (₹390), Chicken Tikka (₹320), Butter Naan (₹60), Ilhaam's Special Kebab Platter. We do not serve hookah (strictly fine dining & family restaurant).
Full menu link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

Customer asked: "${incomingText}"

Rules:
1. Speak in a warm, polite, and upscale tone.
2. If asked about hookah/alcohol: politely clarify that Ilhaam is a fine-dining restaurant and does not serve hookah.
3. If they want to order: acknowledge the items warmly, and append at the very end:
ORDER_DATA:{"name":"Guest","total":370}
4. If they want to book a table: acknowledge date/time/party size and append at the very end:
RESERVATION_DATA:{"name":"Guest","party_size":2}
5. Answer all other questions about food, timings, or location clearly and concisely.`;

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
        } catch (e) {
          console.error("Gemini fetch error:", e);
        }

        // Intelligent Fallbacks if AI service times out
        if (!replyText) {
          if (lowerText.includes("hookah") || lowerText.includes("sheesha")) {
            replyText = "Thank you for asking! We are a family fine-dining restaurant and do not serve hookah. May we offer you our signature kebabs or biryani instead?";
          } else if (lowerText.includes("fish finger") || lowerText.includes("order") || lowerText.includes("biryani")) {
            replyText = "Excellent choice! We have logged your request.\n\nORDER_DATA:{\"name\":\"Guest\",\"total\":370}";
          } else if (lowerText.includes("table") || lowerText.includes("book") || lowerText.includes("reserve")) {
            replyText = "We would be delighted to host you! How many guests will be joining us, and at what time?\n\nRESERVATION_DATA:{\"name\":\"Guest\",\"party_size\":2}";
          } else {
            replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️\nHow may we assist you today?\n\n• Send your order items\n• Ask for *Menu*\n• Reserve a *Table*";
          }
        }
      }

      // 3. Supabase Integration: Insert Orders & Trigger Realtime Dashboard
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 370, name: "WhatsApp Guest" };
        try {
          payload = JSON.parse(parts[1].trim());
        } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        try {
          // Find or create customer
          const { data: cust } = await supabase
            .from("customers")
            .upsert(
              {
                whatsapp_number: fromPhone,
                name: payload.name || "WhatsApp Guest",
                last_order_at: new Date().toISOString()
              },
              { onConflict: "whatsapp_number" }
            )
            .select()
            .single();

          if (cust?.id) {
            await supabase.from("orders").insert({
              order_number: orderNum,
              customer_id: cust.id,
              total: payload.total || 370,
              subtotal: payload.total || 370,
              status: "new",
              payment_status: "pending",
              order_type: "delivery"
            });
          }
        } catch (dbErr) {
          console.error("Order Supabase error:", dbErr);
        }

        replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
      }

      // 4. Supabase Integration: Insert Table Reservations
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        let resPayload = { party_size: 2, name: "WhatsApp Guest" };
        try {
          resPayload = JSON.parse(parts[1].trim());
        } catch (e) {}

        try {
          await supabase.from("reservations").insert({
            customer_phone: fromPhone,
            customer_name: resPayload.name || "WhatsApp Guest",
            party_size: resPayload.party_size || 2,
            booking_time: "Evening",
            status: "pending"
          });
        } catch (resErr) {
          console.error("Reservation Supabase error:", resErr);
        }

        replyText += `\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining, you'll receive a confirmation call soon.`;
      }

      // 5. Send Formatted Message back to Customer
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
