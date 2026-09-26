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
      const entry = req.body?.entry?.[0];
      const message = entry?.changes?.[0]?.value?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text?.body?.trim() || "";

      // Parallel Fetch: Upsert Customer & Retrieve Live Menu from Supabase
      const [customerRes, menuRes] = await Promise.all([
        supabase
          .from("customers")
          .upsert(
            { whatsapp_number: fromPhone, name: "WhatsApp Guest" },
            { onConflict: "whatsapp_number" }
          )
          .select()
          .single(),
        supabase
          .from("menu_items")
          .select("name, category, price, is_veg, is_available")
          .eq("is_available", true)
      ]);

      const customer = customerRes.data;
      const menuList = menuRes.data;

      let menuKnowledge = "Menu items currently being updated.";
      if (menuList && menuList.length > 0) {
        menuKnowledge = menuList
          .map((i) => `- ${i.name} (${i.category}): ₹${i.price} [${i.is_veg ? "Veg" : "Non-Veg"}]`)
          .join("\n");
      }

      // Master Prompt
      const fullPrompt = `You are the authentic, knowledgeable AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

LIVE MENU RETRIEVED FROM DATABASE:
${menuKnowledge}

CULINARY POLICIES:
- Boneless: Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless. Biryanis and Drums of Heaven are bone-in.
- Hookah & Alcohol: Strictly unavailable. We are a family fine-dining restaurant.
- Fish options: Fish Fingers (₹370).
- Veg options: Crispy Chilli Babycorn (₹210), Cheese Kebab (₹440), Butter Naan (₹60), Garlic Cheese Naan (₹100).
- Mutton Kebabs: Not on standard daily menu (we serve Royal Mutton Biryani; mutton kebabs are chef specials on select tasting nights).

WORKFLOW:
1. Answer customer queries naturally, politely, and helpfully.
2. If customer wants to order: list the chosen items, calculate total from prices above, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
3. When customer explicitly confirms (YES/CONFIRM/PROCEED):
   - For table orders (e.g. Table 4), append: ORDER_DATA:{"table":"4","type":"dine_in","total":480}
   - For takeaway/delivery, append: ORDER_DATA:{"table":"takeaway","type":"takeaway","total":480}
4. When customer wants table reservation: ask party size & time. When provided, append:
   RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}

Customer Phone: ${fromPhone}
Customer says: "${incomingText}"

Response:`;

      let replyText = "";

      // Native REST call to Gemini endpoint
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: fullPrompt }] }]
            })
          }
        );
        const geminiData = await geminiRes.json();
        replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      } catch (err) {
        console.error("Gemini REST Error:", err);
      }

      // Context-aware fallback if external API is unreachable
      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️✨ How may we assist your dining experience today? You can ask about our menu, place an order, or reserve a table. Or call us directly at +91 74499 88873.";
      }

      // Order Placement into Database
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 480, table: "takeaway", type: "takeaway" };
        try {
          payload = JSON.parse(parts[1].trim());
        } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-6)}`;

        if (customer?.id) {
          await supabase.from("orders").insert({
            order_number: orderNum,
            customer_id: customer.id,
            total: payload.total || 480,
            subtotal: payload.total || 480,
            status: "new",
            payment_status: "pending",
            order_type: payload.type || "takeaway"
          });
        }

        if (payload.type === "dine_in") {
          replyText += `\n\n✅ *Dine-In Ticket Created:* *${orderNum}* (Table ${payload.table})\nPlease show this Order ID to your captain/waiter.`;
        } else {
          replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
        }
      }

      // Reservation Placement into Database
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();
        let resPayload = { party_size: 2, time: "Evening" };
        try {
          resPayload = JSON.parse(parts[1].trim());
        } catch (e) {}

        await supabase.from("reservations").insert({
          customer_phone: fromPhone,
          customer_name: customer?.name || "WhatsApp Guest",
          party_size: Number(resPayload.party_size) || 2,
          booking_time: resPayload.time || "Evening",
          status: "pending"
        });

        replyText += `\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining, you'll receive a confirmation call soon.`;
      }

      // Send WhatsApp Response via Meta API v26.0
      await fetch(
        `https://graph.facebook.com/v26.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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
