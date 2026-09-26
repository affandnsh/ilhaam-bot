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

  // 2. Inbound WhatsApp Message
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body.trim();

      // Ensure customer exists in database
      const { data: customer } = await supabase
        .from("customers")
        .upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest", last_order_at: new Date().toISOString() },
          { onConflict: "whatsapp_number" }
        )
        .select()
        .single();

      // Fetch live menu from Supabase
      const { data: menuList } = await supabase
        .from("menu_items")
        .select("name, category, price, is_veg, is_available");

      const menuKnowledge = menuList && menuList.length > 0
        ? menuList.map(item => `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`).join("\n")
        : `- Fish Fingers: ₹370\n- Chilli Chicken: ₹250\n- Drums of Heaven: ₹250\n- Kolkata Chicken Biryani: ₹320\n- Royal Mutton Biryani: ₹390\n- Reshmi Kebab: ₹320\n- Butter Naan: ₹60`;

      // Master Intelligent Prompt
      const fullPrompt = `You are the authentic, knowledgeable AI Concierge for "Ilhaam Royal Dining", a luxury fine-dining restaurant in Park Circus, Kolkata (+91 744 998 8873).
Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

OFFICIAL MENU RETRIEVED FROM DATABASE:
${menuKnowledge}

CULINARY KNOWLEDGE & POLICIES:
- Boneless questions: Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless. Biryanis and Drums of Heaven are bone-in.
- Hookah & Alcohol: Strictly prohibited. We are a family fine-dining restaurant and do NOT serve hookah.
- Mutton Kebabs: Not on the regular daily menu (we serve Royal Mutton Biryani; mutton kebabs are chef specials on tasting nights).
- If customer asks for menu: share an elegant summary across sections with the Google Drive menu link.

WORKFLOW RULES:
1. Answering Questions: Answer any culinary, timing, or ingredient question warmly and intelligently.
2. Ordering:
   - When a customer wants to order: clarify dishes and quantities, calculate the total amount from the menu, and summarize: "You've selected [Items] for ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
   - When they confirm (YES / CONFIRM / PROCEED):
     * If DINE-IN (mentioning table, e.g. Table 4): append at the very end:
       ORDER_DATA:{"table":"4","type":"dine_in","total":480}
     * If TAKEAWAY/DELIVERY: append at the very end:
       ORDER_DATA:{"table":"takeaway","type":"takeaway","total":480}
3. Reservations:
   - Ask for party size and preferred time. When confirmed, append at the end:
     RESERVATION_DATA:{"party_size":2,"time":"Evening"}

CUSTOMER PHONE: ${fromPhone}
CUSTOMER MESSAGE: "${incomingText}"

Response:`;

      let replyText = "";

      // Call Gemini Flash with clean text payload
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(fullPrompt);
        replyText = result.response.text();
      } catch (gemErr) {
        console.error("Gemini 1.5 Flash error, attempting fallback:", gemErr?.message);
        try {
          const fallbackModel = genAI.getGenerativeModel({ model: "gemini-pro" });
          const fbResult = await fallbackModel.generateContent(fullPrompt);
          replyText = fbResult.response.text();
        } catch (fbErr) {
          console.error("Gemini Pro fallback error:", fbErr?.message);
        }
      }

      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️✨ How may we assist your dining experience today? You may view our menu, place an order, or reserve a table.";
      }

      // Handle Confirmed Orders into Database
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 480, table: "takeaway", type: "takeaway" };
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
            order_type: payload.type || "takeaway"
          });
        }

        if (payload.type === "dine_in") {
          replyText += `\n\n✅ *Dine-In Ticket Created:* *${orderNum}* (Table ${payload.table})\nPlease show this Order ID to your captain/waiter.`;
        } else {
          replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
        }
      }

      // Handle Confirmed Reservations into Database
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

      // Send Response to WhatsApp via Meta API
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
