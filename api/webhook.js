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

      if (!message) {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");

      // Handle Voice Notes
      if (message.type === "audio" || message.type === "voice") {
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
              text: {
                body: "We received your voice note! 🎙️✨ To ensure 100% accuracy for our kitchen staff, please send your order or questions as a text message, or call us directly at +91 74499 88873."
              }
            })
          }
        );
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (message.type !== "text") {
        return res.status(200).send("OK");
      }

      const incomingText = message.text?.body?.trim() || "";

      // Parallel Fetch: Upsert Customer & Read Menu from Supabase
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

      let menuKnowledge = "";
      if (menuList && menuList.length > 0) {
        menuKnowledge = menuList
          .map((i) => `- ${i.name} (${i.category}): ₹${i.price} [${i.is_veg ? "Veg" : "Non-Veg"}]`)
          .join("\n");
      } else {
        menuKnowledge = `- Fish Fingers (Starters): ₹370 [Non-Veg]\n- Chilli Chicken (Starters): ₹250 [Non-Veg]\n- Crispy Chilli Babycorn (Starters): ₹210 [Veg]\n- Kolkata Chicken Biryani (Biryani): ₹320 [Non-Veg]\n- Royal Mutton Biryani (Biryani): ₹390 [Non-Veg]\n- Reshmi Kebab (Tandoor): ₹320 [Non-Veg]\n- Butter Naan (Breads): ₹60 [Veg]`;
      }

      // Master AI Prompt
      const systemPrompt = `You are the authentic, highly intelligent AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Full Menu Drive Link: https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

OFFICIAL MENU RETRIEVED FROM DATABASE:
${menuKnowledge}

RULES & CULINARY KNOWLEDGE:
- Boneless: Reshmi Kebab, Chicken Tikka, and Chilli Chicken are boneless. Biryanis and Drums of Heaven are bone-in.
- Hookah & Alcohol: Strictly unavailable. We are an upscale family fine-dining establishment.
- Fish options: Fish Fingers (₹370).
- Veg options: Crispy Chilli Babycorn (₹210), Cheese Kebab (₹440), Butter Naan (₹60), Garlic Cheese Naan (₹100).
- Mutton Kebabs: Not on the regular daily menu (we serve Royal Mutton Biryani; mutton kebabs are chef specials on tasting nights).

WORKFLOW:
1. Answer ANY culinary, timing, or general question naturally, warmly, and helpfully.
2. If customer wants to order: calculate the total using the prices above, summarize the items with quantities and total, and ask: "You've selected [Items] for a total of ₹[Total]. Shall I confirm this order? (Reply YES to confirm)". DO NOT finalize yet.
3. When customer explicitly confirms (YES / CONFIRM / PROCEED):
   - For table orders (e.g. Table 4): append at the very end:
     ORDER_DATA:{"table":"4","type":"dine_in","total":690}
   - For takeaway/delivery: append at the very end:
     ORDER_DATA:{"table":"takeaway","type":"takeaway","total":690}
4. When customer wants table reservation: ask party size & time. When provided, append:
   RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}`;

      let replyText = "";

      // Native SDK Call via @google/genai
      try {
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: incomingText,
          config: {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            temperature: 0.3
          }
        });
        replyText = response.text?.trim() || "";
      } catch (gemErr) {
        console.error("Gemini SDK Primary Error:", gemErr);
        try {
          const fallbackRes = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: incomingText,
            config: {
              systemInstruction: { parts: [{ text: systemPrompt }] },
              temperature: 0.3
            }
          });
          replyText = fallbackRes.text?.trim() || "";
        } catch (fbErr) {
          console.error("Gemini SDK Fallback Error:", fbErr);
        }
      }

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

      // Send Response via Meta API
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
