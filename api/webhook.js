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
        replyText = `Welcome to *Ilhaam Royal Dining*! 🍽️✨\n\nWe present an exquisite culinary journey across vegetarian and non-vegetarian delicacies:\n\n• *Starters & Platters:* Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)\n• *Chef's Signature Tandoor:* Ilhaam's Special Kebab Platter (₹580), Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440)\n• *Royal Biryanis:* Kolkata Chicken Biryani (₹320), Special Mutton Biryani (₹550)\n• *Breads:* Butter Naan (₹60), Garlic Cheese Naan (₹100)\n\n📖 *To explore our complete dining & dessert collection, please view our full menu here:*\nhttps://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view\n\nWhich delicacies would you like to savor today?`;
      } else {
        // Multi-Model Fallback Engine using the official SDK
        const systemInstructionText = `You are the authentic AI Concierge for "Ilhaam Royal Dining", a luxury fine-dining restaurant in Park Circus, Kolkata (+91 744 998 8873).
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
Full Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

Customer said: "${incomingText}"

Rules of Engagement:
1. Speak intelligently, naturally, and warmly like a high-end restaurant concierge. Answer whatever question they ask!
2. If customer asks for chicken dishes: recommend Kolkata Chicken Biryani (₹320), Chicken Tikka (₹320), Reshmi Kebab (₹320), Chilli Chicken (₹250), or Drums of Heaven (₹250).
3. If customer specifies food items: calculate the total price, summarize the items and price, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
4. If customer replies "YES", "CONFIRM", or confirms: state that their order is confirmed, and append at the very end:
ORDER_DATA:{"total":480}
5. If customer asks for reservation/table booking: ask for guest count and time, or summarize and append:
RESERVATION_DATA:{"party_size":2,"time":"Evening"}
6. If customer asks how you are or greets: reply warmly, ask how you can assist their dining experience today.`;

        // Try primary model, fallback to alternative if needed
        const candidateModels = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
        for (const mod of candidateModels) {
          try {
            const model = genAI.getGenerativeModel({ model: mod });
            const result = await model.generateContent([
              { text: systemInstructionText },
              { text: incomingText }
            ]);
            replyText = result.response.text();
            if (replyText) break;
          } catch (e) {
            console.error(`Model ${mod} failed:`, e?.message);
          }
        }

        // Direct Fallback if all AI endpoints reject
        if (!replyText) {
          if (lower.includes("chicken")) {
            replyText = "We have wonderful royal chicken specialties! 🍗\n\n• Kolkata Chicken Biryani: ₹320\n• Chicken Tikka: ₹320\n• Reshmi Kebab: ₹320\n• Chilli Chicken: ₹250\n• Drums of Heaven: ₹250\n\nWhich of these would you like to order?";
          } else if (lower.includes("how are you")) {
            replyText = "I am doing wonderfully, thank you for asking! 😊 Welcome to *Ilhaam Royal Dining*. How may I assist your dining plans today?";
          } else if (lower === "yes" || lower === "confirm") {
            replyText = "Your order is confirmed!\n\nORDER_DATA:{\"total\":480}";
          } else if (lower.includes("table") || lower.includes("book")) {
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
