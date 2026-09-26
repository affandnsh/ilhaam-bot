import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export default async function handler(req, res) {
  // =========================================================
  // META WEBHOOK VERIFICATION
  // =========================================================
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // =========================================================
  // WHATSAPP MESSAGE PROCESSING
  // =========================================================
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0];
      const message = entry?.changes?.[0]?.value?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text?.body?.trim() || "";

      // =====================================================
      // PARALLEL DATABASE QUERIES (LIGHTNING FAST)
      // =====================================================
      // By using Promise.all, we fetch the customer and the menu at the exact same time
      const [customerResponse, menuResponse] = await Promise.all([
        supabase.from("customers").upsert(
          { whatsapp_number: fromPhone, name: "WhatsApp Guest" },
          { onConflict: "whatsapp_number" }
        ).select().single(),
        supabase.from("menu_items").select("name, category, price, is_veg, is_available").eq("is_available", true)
      ]);

      const customer = customerResponse.data;
      const menuList = menuResponse.data;

      let menuKnowledge = "Menu currently unavailable.";
      if (menuList && menuList.length > 0) {
        menuKnowledge = menuList
          .map((item) => `- ${item.name} | Category: ${item.category} | Price: ₹${item.price} | ${item.is_veg ? "Veg" : "Non-Veg"}`)
          .join("\n");
      }

      // =====================================================
      // GEMINI PROMPT
      // =====================================================
      const fullPrompt = `You are the official AI Concierge for: ILHAAM ROYAL DINING.
Be warm, concise, and professional. 

=========================================================
LIVE RESTAURANT MENU FROM SUPABASE
=========================================================
${menuKnowledge}

=========================================================
RESTAURANT KNOWLEDGE
=========================================================
- Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless.
- Biryanis and Drums of Heaven are bone-in unless specified otherwise.
- Hookah and Alcohol are NOT available.
- Mutton kebabs are not on the daily menu.
- Always use the LIVE MENU above for prices. Never invent dishes or prices.

=========================================================
ORDERING RULES
=========================================================
If the customer wants to order:
1. Identify the dishes and quantities.
2. Use the LIVE MENU prices to calculate the exact subtotal.
3. Summarize the items and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? Reply YES to confirm."
4. DO NOT create an order until the customer explicitly confirms with words like YES, CONFIRM, or PROCEED.

If the customer explicitly confirms an order, append this exact machine-readable line at the END of your message:
ORDER_DATA:{"type":"takeaway","total":700}
(Replace 700 with the ACTUAL calculated total).

=========================================================
TABLE RESERVATION RULES
=========================================================
If the customer wants to reserve a table, ask for the number of guests and preferred time.
Once they provide both, append:
RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}

=========================================================
CUSTOMER MESSAGE: "${incomingText}"
=========================================================
YOUR RESPONSE:`;

      // =====================================================
      // GEMINI EXECUTION
      // =====================================================
      let replyText = "";
      try {
        const result = await ai.models.generateContent({
          model: "gemini-1.5-flash", 
          contents: fullPrompt
        });
        replyText = result.text?.trim() || "";
      } catch (geminiError) {
        console.error("GEMINI ERROR:", geminiError);
        replyText = "Sorry, our dining assistant is temporarily experiencing high traffic. Please try again in a moment, or call us directly at +91 74499 88873 for immediate assistance.";
      }

      // =====================================================
      // ORDER & RESERVATION PROCESSING
      // =====================================================
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        const customerReply = parts[0].trim();
        let orderData = null;
        try { orderData = JSON.parse(parts[1].trim()); } catch (e) {}

        if (orderData && customer) {
          const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
          const total = Number(orderData.total) || 0;

          await supabase.from("orders").insert({
            order_number: orderNumber,
            customer_id: customer.id,
            total: total,
            subtotal: total,
            status: "new",
            payment_status: "pending",
            order_type: "takeaway"
          });
          
          replyText = `${customerReply}\n\n✅ *Order Received:* *${orderNumber}*\nThank you. Our team will contact you shortly regarding the order.`;
        }
      }

      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        const customerReply = parts[0].trim();
        let reservationData = null;
        try { reservationData = JSON.parse(parts[1].trim()); } catch (e) {}

        if (reservationData) {
          await supabase.from("reservations").insert({
            customer_phone: fromPhone,
            customer_name: customer?.name || "WhatsApp Guest",
            party_size: Number(reservationData.party_size) || 2,
            booking_time: reservationData.time || "Evening",
            status: "pending"
          });
          
          replyText = `${customerReply}\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining. Our team will contact you to confirm the reservation.`;
        }
      }

      if (!replyText) {
        replyText = "Sorry, I couldn't process that request. Please try again, or call us directly at +91 74499 88873 for immediate assistance.";
      }

      // =====================================================
      // SEND WHATSAPP MESSAGE
      // =====================================================
      await fetch(
        `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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
    } catch (error) {
      console.error("CRITICAL WEBHOOK ERROR:", error);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
