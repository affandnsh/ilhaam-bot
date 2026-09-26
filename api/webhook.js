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

      let replyText = "";

      // Dedicated Menu Handling with Drive Link
      if (lower.includes("menu") || lower === "3") {
        replyText = `Welcome to *Ilhaam Royal Dining*! 🍽️✨\n\nWe present an exquisite culinary journey across vegetarian and non-vegetarian delicacies:\n\n• *Starters & Platters:* Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)\n• *Chef's Signature Tandoor:* Ilhaam's Special Kebab Platter (₹580), Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)\n• *Royal Biryanis:* Kolkata Chicken Biryani (₹320), Special Mutton Biryani (₹550)\n• *Breads:* Butter Naan (₹60), Garlic Cheese Naan (₹100)\n\n📖 *To explore our complete dining & dessert collection, please view our full menu here:*\nhttps://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view\n\nWhich delicacies would you like to savor today?`;
      } else {
        // AI Prompt
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
- Soft Drinks / Diet Coke (₹60)
Note: We are strictly a family fine-dining restaurant; we DO NOT serve hookah or alcohol.
Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

Customer said: "${incomingText}"

Rules of Engagement:
1. If the customer just expresses intent to order ("I want to place an order", "Can I order?"), welcome them warmly and ask which dishes and quantities they would like to have. DO NOT assume or recall any past items.
2. If customer specifies dishes (e.g. "1 chicken biryani and 2 butter naan"):
   Calculate the exact total, list each item, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
3. If customer confirms with "YES", "CONFIRM", or "PROCEED":
   Acknowledge the confirmation, and append at the very end:
   ORDER_DATA:{"total":480}
4. If customer says "CANCEL", "NO", or wants to change items:
   Acknowledge graciously and reset, asking what they would prefer instead.
5. If customer asks for reservation/table booking:
   Ask for their party size, date, and preferred time. If already provided, acknowledge and append:
   RESERVATION_DATA:{"party_size":2,"time":"Evening"}
6. For questions on hookah, clarify politely that Ilhaam is a fine-dining establishment and does not offer hookah.`;

        // Direct REST call to Gemini 1.5 Flash
        try {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3 }
              })
            }
          );
          const data = await geminiRes.json();
          replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        } catch (err) {
          console.error("Gemini call error:", err);
        }

        // Context-clean fallback
        if (!replyText) {
          if (lower.includes("hookah")) {
            replyText = "We are an authentic fine-dining restaurant and do not serve hookah. May we offer you our signature kebabs or biryani instead?";
          } else if (lower.includes("place an order") || lower.includes("can i order") || lower === "order") {
            replyText = "We would love to prepare a royal meal for you! 🍽️ Which dishes and quantities would you like to order?";
          } else if (lower.includes("cancel") || lower === "no") {
            replyText = "No problem at all. Your previous selection has been cleared. What else can I assist you with today?";
          } else if (lower === "yes" || lower === "confirm") {
            replyText = "Your order is confirmed!\n\nORDER_DATA:{\"total\":480}";
          } else if (lower.includes("table") || lower.includes("book") || lower.includes("reserve")) {
            replyText = "We would be delighted to host you! How many guests will be joining us, and at what time?";
          } else {
            replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️ How may we assist your dining experience today?";
          }
        }
      }

      // 3. Supabase Integration: Insert Confirmed Orders
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 480 };
        try { payload = JSON.parse(parts[1].trim()); } catch (e) {}

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

      // 4. Supabase Integration: Insert Reservations
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        let resPayload = { party_size: 2, time: "Evening" };
        try { resPayload = JSON.parse(parts[1].trim()); } catch (e) {}

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
