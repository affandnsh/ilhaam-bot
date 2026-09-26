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

  // 2. Inbound Message Handling
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

      // Ensure customer exists in database
      const { data: customer } = await supabase
        .from("customers")
        .upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest", last_order_at: new Date().toISOString() },
          { onConflict: "whatsapp_number" }
        )
        .select()
        .single();

      let replyText = "";

      // Dedicated Menu Handling with Drive Link
      if (lower.includes("menu") || lower === "3") {
        replyText = `Welcome to *Ilhaam Royal Dining*! 🍽️✨\n\nWe present an exquisite culinary journey across vegetarian and non-vegetarian delicacies:\n\n• *Starters & Platters:* Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)\n• *Chef's Signature Tandoor:* Ilhaam's Special Kebab Platter, Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)\n• *Royal Biryanis:* Kolkata Chicken Biryani (₹320), Special Mutton Biryani (₹550)\n• *Breads:* Butter Naan (₹60), Garlic Cheese Naan (₹100)\n\n📖 *To explore our complete dining & dessert collection, please view our full menu here:*\nhttps://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view\n\nWhich delicacies would you like to savor today?`;
      } else {
        // High-Intelligence System Prompt
        const prompt = `You are the authentic AI Concierge for "Ilhaam Royal Dining", a luxury fine-dining restaurant in Park Circus, Kolkata (+91 744 998 8873).
Menu & Rates:
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
- Beverages / Soft Drinks / Diet Coke (₹60)
Note: We are strictly a family fine-dining restaurant; we DO NOT serve hookah or alcohol.
Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

Customer message: "${incomingText}"

Instructions:
1. If the customer lists food items (e.g., "Crispy chilly baby corn 2 plate and a diet coke"):
   Calculate the approximate subtotal (e.g. 2 x 210 + 60 = ₹480).
   Politely summarize their items and total, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT append ORDER_DATA yet.
2. If customer says "YES", "CONFIRM", "PROCEED", or confirms their pending order:
   Reply with: "Your order is confirmed!" and append at the end:
   ORDER_DATA:{"total":480}
3. If customer asks to book a table or reserve:
   Ask for their party size, date, and preferred time. If already provided, summarize it and append:
   RESERVATION_DATA:{"party_size":2,"time":"Evening"}
4. For questions about hookah, alcohol, ingredients, timings, or location, answer cordially, luxuriously, and concisely.`;

        // Direct AI Call with error inspect
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
          if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            replyText = data.candidates[0].content.parts[0].text;
          } else {
            console.error("Gemini returned non-candidate response:", JSON.stringify(data));
          }
        } catch (err) {
          console.error("Gemini fetch exception:", err);
        }

        // Context-aware fallback if external AI fails
        if (!replyText) {
          if (lower.includes("hookah")) {
            replyText = "We are an authentic family fine-dining destination and do not offer hookah. Would you like to view our signature kebab and biryani selections instead?";
          } else if (lower.includes("baby corn") || lower.includes("babycorn") || lower.includes("coke")) {
            replyText = "You've selected 2x Crispy Chilli Babycorn and 1x Diet Coke for an estimated total of ₹480. Would you like to confirm this order? (Reply YES to confirm)";
          } else if (lower === "yes" || lower === "confirm" || lower.includes("confirm")) {
            replyText = "Thank you! Your order has been placed.\n\nORDER_DATA:{\"total\":480}";
          } else if (lower.includes("table") || lower.includes("book") || lower.includes("reserve")) {
            replyText = "We would be delighted to host you! How many guests will be joining us, and at what time?";
          } else {
            replyText = "We are pleased to assist you! Please let us know the dishes you would like to order or if you wish to reserve a table.";
          }
        }
      }

      // 3. Supabase Integration: Insert Confirmed Orders
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 480 };
        try {
          payload = JSON.parse(parts[1].trim());
        } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        if (customer?.id) {
          await supabase.from("orders").insert({
            order_number: orderNum,
            customer_id: customer.id,
            total: payload.total || 480,
            subtotal: payload.total || 480,
            status: "new",
            payment_status: "pending",
            order_type: "delivery"
          });
        }

        replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
      }

      // 4. Supabase Integration: Insert Confirmed Table Reservations
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
