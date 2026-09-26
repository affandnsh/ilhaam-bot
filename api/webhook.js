import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const message = entry?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(200).send("OK");
      }

      const fromPhone = String(message.from).replace(/\D/g, "");
      const incomingText = message.text.body;

      let replyText = "";

      // 1. Call Gemini via standard REST
      try {
        const prompt = `You are the AI Concierge for "Ilhaam Royal Dining", 2A Congress Exhibition Road, Park Circus, Kolkata (+91 744 998 8873).
Menu: Chicken Biryani (320), Special Chicken Biryani (500), Mutton Biryani (390), Butter Naan (60), Chicken Tikka (320).
User said: "${incomingText}"

Instructions:
- If they want to order: ask what they'd like, or confirm their items and address.
- If they want to book a table: ask for party size and preferred time.
- If they just greet: greet warmly and offer Menu, Order, or Booking.
- Keep the response short, warm, and conversational.
- When an order is clearly requested/confirmed, include at the very end:
ORDER_DATA:{"total":320}
- When a reservation is requested, include at the very end:
RESERVATION_DATA:{"party_size":2,"time":"Tonight"}`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
          }
        );
        const geminiData = await geminiRes.json();
        replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch (e) {
        console.error("AI error:", e);
      }

      if (!replyText) {
        replyText = "Welcome to *Ilhaam Royal Dining*! 🍽️\nHow can we serve you today?\n\n1. Place an Order\n2. Book a Table\n3. View Menu";
      }

      // 2. Handle Order Insertion into Supabase
      if (replyText.includes("ORDER_DATA:")) {
        const parts = replyText.split("ORDER_DATA:");
        replyText = parts[0].trim();
        const orderNum = `ORD-${Date.now().toString().slice(-4)}`;

        try {
          // Upsert customer
          const { data: cust } = await supabase
            .from("customers")
            .upsert({ whatsapp_number: fromPhone, name: "WhatsApp Guest" }, { onConflict: "whatsapp_number" })
            .select()
            .single();

          if (cust?.id) {
            await supabase.from("orders").insert({
              order_number: orderNum,
              customer_id: cust.id,
              total: 320,
              subtotal: 320,
              status: "new",
              payment_status: "pending"
            });
          }
        } catch (dbErr) {
          console.error("Order DB write error:", dbErr);
        }

        replyText += `\n\n✅ *Order Confirmed!* Ticket: *${orderNum}*.`;
      }

      // 3. Handle Reservation Insertion into Supabase
      if (replyText.includes("RESERVATION_DATA:")) {
        const parts = replyText.split("RESERVATION_DATA:");
        replyText = parts[0].trim();

        try {
          await supabase.from("reservations").insert({
            customer_phone: fromPhone,
            customer_name: "WhatsApp Guest",
            party_size: 2,
            booking_time: "Evening",
            status: "pending"
          });
        } catch (resErr) {
          console.error("Reservation DB write error:", resErr);
        }

        replyText += `\n\n✅ *Table Request Logged!* Our team is reserving your spot.`;
      }

      // 4. Send Message back to Customer
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
      console.error("Handler error:", err);
      return res.status(200).send("ERROR_HANDLED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
