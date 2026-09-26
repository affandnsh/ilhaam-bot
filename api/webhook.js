import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

      // Ensure customer exists in database
      const { data: customer } = await supabase
        .from("customers")
        .upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest", last_order_at: new Date().toISOString() },
          { onConflict: "whatsapp_number" }
        )
        .select()
        .single();

      // System Prompt acting as the restaurant's live brain
      const systemPrompt = `You are the authentic, intelligent AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
You have a real mind: answer any questions conversationally, politely, and luxuriously. Never give robotic, repeated answers.

OUR COMPLETE CULINARY KNOWLEDGE BASE:
- Starters: Fish Fingers (₹370), Chilli Chicken (₹250), Drums of Heaven (₹250), Crispy Chilli Babycorn (₹210)
- Tandoor & Kebabs: Ilhaam's Special Kebab Platter (₹580), Chicken Tikka (₹320), Reshmi Kebab (₹320), Cheese Kebab (₹440).
  *Note on Mutton Kebabs*: We currently feature our Chef's signature Chicken & Cheese kebabs and royal mutton biryanis; mutton kebabs are prepared on special chef tasting nights.
- Royal Biryanis: Kolkata Chicken Biryani with egg & potato (₹320), Special Chicken Biryani (₹500), Royal Mutton Biryani (₹390), Special Mutton Biryani (₹550).
- Indian Breads: Butter Naan (₹60), Garlic Cheese Naan (₹100), Tandoori Roti (₹20).
- Beverages: Fresh Lime Soda (₹80), Diet Coke / Soft Drinks (₹60), Mineral Water (₹30).
- Policies: We are strictly a luxury family fine-dining restaurant; we DO NOT serve hookah or alcohol.
- Full PDF Menu Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

CHANNELS & WORKFLOWS:
1. DINE-IN (TABLE ORDERING):
   - If customer mentions a table (e.g. "We are at Table 4", "Table 2 ordering"): Confirm their items and table number.
   - When confirmed, end your message with:
     ORDER_DATA:{"table":"4","type":"dine_in","total":640,"items":"1x Chicken Biryani, 1x Reshmi Kebab"}
     And instruct them: "Please show this Order ID to your captain/waiter. Your items are being sent to the kitchen!"

2. TAKEAWAY & DELIVERY:
   - When a customer wants to order: list the items, calculate the total price, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)".
   - Only when they confirm with "YES" / "CONFIRM", end your message with:
     ORDER_DATA:{"table":"takeaway","type":"takeaway","total":480,"items":"..."}
     And state: "Thank you for ordering with us, you'll receive a confirmation call soon."

3. RESERVATIONS:
   - Ask for party size and preferred time. When confirmed, append:
     RESERVATION_DATA:{"party_size":2,"time":"Evening"}

4. GENERAL QUERIES & MENU:
   - If they ask for the menu, share the highlights warmly and provide the Google Drive link.
   - If they ask how you are, recommend dishes, ask about hookah, or ask anything else, respond authentically and helpfully.`;

      let replyText = "";

      // Call Google Gemini using the official SDK
      const modelList = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-pro"];
      for (const m of modelList) {
        try {
          const model = genAI.getGenerativeModel({ model: m });
          const result = await model.generateContent([
            { text: systemPrompt },
            { text: `Customer Phone: ${fromPhone}\nCustomer says: ${incomingText}` }
          ]);
          replyText = result.response.text();
          if (replyText) break;
        } catch (e) {
          console.error(`Gemini SDK model ${m} error:`, e?.message);
        }
      }

      // Safe fallback only if Google's entire API is unreachable
      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️✨ Our team is delighted to assist you. Would you like to view our menu, place an order for your table/takeaway, or make a reservation?";
      }

      // Handle Order Confirmation & Supabase Database Insertion
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        let payload = { total: 480, table: "takeaway", type: "takeaway" };
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
            order_type: payload.type || "takeaway"
          });
        }

        if (payload.type === "dine_in") {
          replyText += `\n\n✅ *Dine-In Ticket Created:* *${orderNum}* (Table ${payload.table})\nPlease show this Order ID to your captain/waiter.`;
        } else {
          replyText += `\n\n✅ *Ticket Created:* *${orderNum}*\nThank you for ordering with us, you'll receive a confirmation call soon.`;
        }
      }

      // Handle Reservation & Supabase Database Insertion
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

      // Send Response to Customer via Meta Graph API
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
