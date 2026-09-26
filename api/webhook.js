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

  // 2. Inbound Message Processing
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body.trim();
      const lower = incomingText.toLowerCase();

      // Ensure customer exists
      const { data: customer } = await supabase
        .from("customers")
        .upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest", last_order_at: new Date().toISOString() },
          { onConflict: "whatsapp_number" }
        )
        .select()
        .single();

      // Retrieve recent orders/reservations context if any
      const { data: recentOrders } = await supabase
        .from("orders")
        .select("order_number, total, status, created_at")
        .eq("customer_id", customer?.id)
        .order("created_at", { ascending: false })
        .limit(2);

      let replyText = "";

      // Dedicated Menu Request Handling
      if (lower.includes("menu") || lower === "3") {
        replyText = `Welcome to *Ilhaam Royal Dining*! 🍽️✨\n\nWe present an exquisite culinary journey across vegetarian and non-vegetarian delicacies:\n\n• *Starters & Platters:* Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)\n• *Chef's Signature Tandoor:* Ilhaam's Special Kebab Platter, Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)\n• *Royal Biryanis:* Kolkata Chicken Biryani (₹320), Special Mutton Biryani (₹550)\n• *Breads:* Butter Naan (₹60), Garlic Cheese Naan (₹100)\n\n📖 *To explore our complete dining & dessert collection, please view our full menu here:*\nhttps://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view\n\nWhich delicacies would you like to order today?`;
      } else {
        // Multi-Turn AI System Prompt
        const prompt = `You are the authentic AI Concierge for "Ilhaam Royal Dining", a luxury fine-dining restaurant in Park Circus, Kolkata (+91 744 998 8873).
Menu & Prices:
- Fish Fingers (₹370)
- Chilli Chicken (₹250)
- Drums of Heaven (₹250)
- Crispy Chilli Babycorn (₹210)
- Ilhaam's Special Kebab Platter (₹580)
- Chicken Tikka (₹320)
- Reshmi Kebab (₹320)
- Kolkata Chicken Biryani (₹320)
- Special Mutton Biryani (₹550)
- Butter Naan (₹60)
- Garlic Cheese Naan (₹100)
Note: We are strictly a family restaurant; we DO NOT serve hookah or alcohol.
Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

Customer phone: ${fromPhone}
Customer said: "${incomingText}"

Rules of Conversation:
1. ORDERING:
   - If they say "I want to place an order" or "I want food", ask politely what specific dishes and quantities they would like.
   - If they mention dishes (e.g., "1 Fish Finger and 2 Butter Naan"), calculate the total price, list each item with quantity and price, and ask: "You've selected [Items] for a total of ₹[Total]. Would you like to confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
   - ONLY when they explicitly confirm (saying "yes", "confirm", "proceed", "place it"), append at the very end of your response:
   ORDER_DATA:{"items":[{"name":"...","qty":1,"price":370}],"total":370}

2. RESERVATIONS:
   - If they say "I want to book a table" or "reservation", ask: "How many guests will be joining us, and at what date and time would you like your table reserved?"
   - Once they provide both the party size and time (e.g., "4 people at 8 PM"), summarize it and ask for confirmation, OR finalize and append at the very end:
   RESERVATION_DATA:{"party_size":4,"time":"8:00 PM"}

3. GENERAL QUESTIONS:
   - Answer food, timing, location, and ingredient questions politely and briefly.
   - If asked about hookah, politely explain we are a fine-dining establishment and do not offer hookah.`;

        try {
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
          console.error("Gemini fetch error:", err);
        }

        // Smart Fallbacks if AI endpoint is unreachable
        if (!replyText) {
          if (lower.includes("hookah")) {
            replyText = "We are an authentic fine-dining restaurant and do not serve hookah. May we offer you our signature kebabs or royal biryani instead?";
          } else if (lower.includes("table") || lower.includes("book") || lower.includes("reserve")) {
            replyText = "We'd be delighted to host you! How many guests will be joining, and for what date and time?";
          } else if (lower === "yes" || lower === "confirm") {
            replyText = "Thank you! Your request is being confirmed.\n\nORDER_DATA:{\"total\":370}";
          } else {
            replyText = "We would love to serve you! Please let us know which dishes you would like to order, or if you wish to reserve a table.";
          }
        }
      }

      // 3. Process Confirmed Order into Supabase
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 370 };
        try {
          payload = JSON.parse(parts[1].trim());
        } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        if (customer?.id) {
          await supabase.from("orders").insert({
            order_number: orderNum,
            customer_id: customer.id,
            total: payload.total || 370,
            subtotal: payload.total || 370,
            status: "new",
            payment_status: "pending",
            order_type: "delivery"
          });
        }

        replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
      }

      // 4. Process Confirmed Reservation into Supabase
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        let resPayload = { party_size: 2, time: "Evening" };
        try {
          resPayload = JSON.parse(parts[1].trim());
        } catch (e) {}

        await supabase.from("reservations").insert({
          customer_phone: fromPhone,
          customer_name: "WhatsApp Guest",
          party_size: resPayload.party_size || 2,
          booking_time: resPayload.time || "Evening",
          status: "pending"
        });

        replyText += `\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining, you'll receive a confirmation call soon.`;
      }

      // 5. Send Response via Meta Graph API
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
      console.error("Critical webhook error:", err);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
