import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  // 1. Meta Webhook Verification
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

      // Ensure customer exists
      const { data: customer } = await supabase
        .from("customers")
        .upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest", last_order_at: new Date().toISOString() },
          { onConflict: "whatsapp_number" }
        )
        .select()
        .single();

      // RAG RETRIEVAL: Pull live menu knowledge base from Supabase
      const { data: menuList } = await supabase
        .from("menu_items")
        .select("name, category, price, is_veg, is_available");

      const menuKnowledge = menuList && menuList.length > 0 
        ? menuList.map(item => `- ${item.name} (${item.category}): ₹${item.price} [${item.is_veg ? "Veg" : "Non-Veg"}]`).join("\n")
        : `- Fish Fingers: ₹370\n- Chilli Chicken: ₹250\n- Royal Mutton Biryani: ₹390\n- Chicken Tikka: ₹320\n- Butter Naan: ₹60`;

      // System Prompt with Injected Ground Truth
      const systemInstruction = `You are the authentic, intelligent AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Full Menu Drive Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

OFFICIAL MENU RETRIEVED FROM DATABASE:
${menuKnowledge}

RESTAURANT RULES & POLICIES:
- Fine Dining Policy: We DO NOT serve hookah or alcohol.
- When asked if an item is available (e.g. mutton, fish fingers, kebabs): check the retrieved database menu above. If present, tell them warmly with the price! If not in the list (e.g. Mutton Kebab), state politely that we have Royal Mutton Biryani, and that mutton kebabs are chef specials on select tasting nights.

CHANNELS & WORKFLOW:
1. DINE-IN (At table):
   - If customer states a table number (e.g., "Table 3"): Confirm their items and table.
   - When confirmed, append at the end:
     ORDER_DATA:{"table":"3","type":"dine_in","total":450}
     And say: "Please show this Order ID to your captain/waiter. Your items are being sent to the kitchen!"
2. TAKEAWAY & DELIVERY:
   - Calculate itemized subtotal from the menu list. Summarize and ask: "You've selected [Items] for a total of ₹[Total]. Would you like to confirm? (Reply YES to confirm)".
   - Only when they confirm (YES/CONFIRM), append at the end:
     ORDER_DATA:{"table":"takeaway","type":"takeaway","total":450}
     And say: "Thank you for ordering with us, you'll receive a confirmation call soon."
3. TABLE RESERVATIONS:
   - Ask for party size and preferred time. When confirmed, append:
     RESERVATION_DATA:{"party_size":2,"time":"Evening"}`;

      let replyText = "";

      // Call Gemini with Fallback
      const candidateModels = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-pro"];
      for (const mod of candidateModels) {
        try {
          const model = genAI.getGenerativeModel({ model: mod });
          const result = await model.generateContent([
            { text: systemInstruction },
            { text: `Customer Phone: ${fromPhone}\nCustomer Query: ${incomingText}` }
          ]);
          replyText = result.response.text();
          if (replyText) break;
        } catch (e) {
          console.error(`Model ${mod} failed:`, e?.message);
        }
      }

      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️✨ How may we assist your dining experience today? You may view our menu, place an order, or reserve a table.";
      }

      // Handle Confirmed Orders into Database
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 370, table: "takeaway", type: "takeaway" };
        try { payload = JSON.parse(parts[1].trim()); } catch (e) {}

        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        if (customer?.id) {
          await supabase.from("orders").insert({
            order_number: orderNum,
            customer_id: customer.id,
            total: payload.total || 370,
            subtotal: payload.total || 370,
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
