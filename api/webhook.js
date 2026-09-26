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
  // ENVIRONMENT CHECK
  // =========================================================

  const requiredEnv = [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "GEMINI_API_KEY",
    "VERIFY_TOKEN",
    "WHATSAPP_PHONE_ID",
    "WHATSAPP_ACCESS_TOKEN"
  ];

  const missingEnv = requiredEnv.filter(
    (key) => !process.env[key]
  );

  if (missingEnv.length > 0) {
    console.error("MISSING ENVIRONMENT VARIABLES:", missingEnv);

    if (req.method === "GET") {
      return res.status(500).send(
        `Missing environment variables: ${missingEnv.join(", ")}`
      );
    }

    return res.status(500).send("Server configuration error");
  }


  // =========================================================
  // META WEBHOOK VERIFICATION
  // =========================================================

  if (req.method === "GET") {

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token === process.env.VERIFY_TOKEN
    ) {
      console.log("META WEBHOOK VERIFIED");

      return res.status(200).send(challenge);
    }

    console.error("META WEBHOOK VERIFICATION FAILED");

    return res.status(403).send("Forbidden");
  }


  // =========================================================
  // WHATSAPP MESSAGE
  // =========================================================

  if (req.method === "POST") {

    try {

      console.log("WHATSAPP WEBHOOK RECEIVED");

      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      // Ignore status updates and other webhook events
      if (!message) {
        console.log("No WhatsApp message found. Ignoring event.");

        return res.status(200).send("OK");
      }

      // We currently process text messages only
      if (message.type !== "text") {

        console.log(
          "Ignoring non-text message:",
          message.type
        );

        return res.status(200).send("OK");
      }


      // =====================================================
      // CUSTOMER MESSAGE
      // =====================================================

      const fromPhone = String(message.from).replace(/\D/g, "");

      const incomingText =
        message.text?.body?.trim() || "";

      console.log("CUSTOMER PHONE:", fromPhone);
      console.log("CUSTOMER MESSAGE:", incomingText);


      // =====================================================
      // CUSTOMER DATABASE
      // =====================================================

      let customer = null;

      const {
        data: customerData,
        error: customerError
      } = await supabase
        .from("customers")
        .upsert(
          {
            whatsapp_number: fromPhone,
            name: "WhatsApp Guest"
          },
          {
            onConflict: "whatsapp_number"
          }
        )
        .select()
        .single();

      if (customerError) {

        console.error(
          "CUSTOMER DATABASE ERROR:",
          customerError
        );

      } else {

        customer = customerData;

        console.log(
          "CUSTOMER FOUND:",
          customer.id
        );
      }


      // =====================================================
      // LIVE MENU FROM SUPABASE
      // =====================================================

      const {
        data: menuList,
        error: menuError
      } = await supabase
        .from("menu_items")
        .select(
          "name, category, price, is_veg, is_available"
        )
        .eq("is_available", true);

      if (menuError) {

        console.error(
          "MENU DATABASE ERROR:",
          menuError
        );
      }


      let menuKnowledge = "";

      if (
        menuList &&
        menuList.length > 0
      ) {

        menuKnowledge = menuList
          .map(
            (item) =>
              `- ${item.name} | Category: ${item.category} | Price: ₹${item.price} | ${item.is_veg ? "Veg" : "Non-Veg"}`
          )
          .join("\n");

      } else {

        console.log(
          "No menu found in Supabase. Using emergency fallback menu."
        );

        menuKnowledge = `
- Fish Fingers | Starters | ₹370 | Non-Veg
- Chilli Chicken | Starters | ₹250 | Non-Veg
- Drums of Heaven | Starters | ₹250 | Non-Veg
- Kolkata Chicken Biryani | Main Course | ₹320 | Non-Veg
- Royal Mutton Biryani | Main Course | ₹390 | Non-Veg
- Reshmi Kebab | Kebab | ₹320 | Non-Veg
- Butter Naan | Indian Bread | ₹60 | Veg
`;
      }


      // =====================================================
      // GEMINI PROMPT
      // =====================================================

      const fullPrompt = `
You are the official AI Concierge for:

ILHAAM ROYAL DINING

Location:
Park Circus, Kolkata

Phone:
+91 744 998 8873

You are speaking to customers through WhatsApp.

Your job is to help customers with:
1. Menu questions
2. Food questions
3. Ordering
4. Takeaway
5. Delivery enquiries
6. Dine-in enquiries
7. Table reservations

Be warm, concise and professional.

Do NOT repeatedly send the generic welcome message.

If the customer says hello, greet them and briefly explain that they can:
- View the menu
- Ask about dishes
- Place an order
- Reserve a table

=========================================================
LIVE RESTAURANT MENU FROM SUPABASE
=========================================================

${menuKnowledge}

=========================================================
RESTAURANT KNOWLEDGE
=========================================================

- Reshmi Kebab is boneless.
- Chicken Tikka is boneless.
- Chilli Chicken is boneless.
- Biryanis are bone-in unless the menu/database specifically says otherwise.
- Drums of Heaven are bone-in.
- Hookah is NOT available.
- Alcohol is NOT served.
- Mutton kebabs are not part of the regular daily menu.
- Royal Mutton Biryani is available if listed in the live menu.
- Never invent dishes or prices.
- Always use the LIVE MENU above for prices.
- If a dish is not present in the menu, say that you cannot currently find it on the available menu.

=========================================================
MENU REQUEST
=========================================================

If the customer asks for the menu, give a short organized summary using the available menu.

Menu:
https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view

=========================================================
ORDERING
=========================================================

If the customer wants to order:

1. Identify the dishes.
2. Identify quantities.
3. Use the LIVE MENU prices.
4. Calculate the total.
5. Ask for confirmation.

Example:

"You've selected:
2 × Chicken Biryani — ₹640
1 × Butter Naan — ₹60

Total: ₹700

Shall I confirm this order?
Reply YES to confirm."

DO NOT create an order until the customer clearly confirms.

=========================================================
ORDER CONFIRMATION
=========================================================

If the customer clearly confirms an order using words such as:

YES
CONFIRM
CONFIRMED
PROCEED
PLACE ORDER

then append this exact machine-readable line at the END:

ORDER_DATA:{"type":"takeaway","total":700}

Replace 700 with the ACTUAL total.

If the customer explicitly gives a dine-in table number, use:

ORDER_DATA:{"type":"dine_in","table":"4","total":700}

Never invent a table number.

=========================================================
TABLE RESERVATION
=========================================================

If the customer wants to reserve a table:

Ask for:
- Number of guests
- Preferred time

Once the customer has provided both and is clearly asking to make the reservation, append:

RESERVATION_DATA:{"party_size":2,"time":"8:00 PM"}

Use the actual party size and time.

=========================================================
IMPORTANT
=========================================================

Never invent prices.

Never invent menu items.

Never claim an order is confirmed before the customer explicitly confirms.

Never claim a reservation is confirmed by the restaurant.

The system will handle database storage after you provide the machine-readable data.

=========================================================
CUSTOMER PHONE
=========================================================

${fromPhone}

=========================================================
CUSTOMER MESSAGE
=========================================================

${incomingText}

=========================================================
YOUR RESPONSE
=========================================================
`;


      // =====================================================
      // GEMINI
      // =====================================================

      let replyText = "";

      try {

        console.log("CALLING GEMINI...");

        const result =
          await ai.models.generateContent({
            model: "gemini-3.8-flash",
            contents: fullPrompt
          });

        replyText =
          result.text?.trim() || "";

        console.log(
          "GEMINI RESPONSE:",
          replyText
        );

      } catch (geminiError) {

        console.error(
          "GEMINI ERROR:",
          geminiError
        );

        replyText =
          "Sorry, our dining assistant is temporarily unavailable. Please try again in a moment.";
      }


      // =====================================================
      // ORDER PROCESSING
      // =====================================================

      if (
        replyText.includes("ORDER_DATA:")
      ) {

        const parts =
          replyText.split("ORDER_DATA:");

        const customerReply =
          parts[0].trim();

        let orderData = null;

        try {

          orderData =
            JSON.parse(parts[1].trim());

        } catch (parseError) {

          console.error(
            "ORDER DATA PARSE ERROR:",
            parseError
          );
        }

        if (
          orderData &&
          customer
        ) {

          const orderNumber =
            `ORD-${Date.now()
              .toString()
              .slice(-6)}`;

          const total =
            Number(orderData.total) || 0;

          const orderType =
            orderData.type === "dine_in"
              ? "dine_in"
              : "takeaway";

          const {
            error: orderError
          } = await supabase
            .from("orders")
            .insert({

              order_number:
                orderNumber,

              customer_id:
                customer.id,

              total:
                total,

              subtotal:
                total,

              status:
                "new",

              payment_status:
                "pending",

              order_type:
                orderType
            });

          if (orderError) {

            console.error(
              "ORDER DATABASE ERROR:",
              orderError
            );

          } else {

            console.log(
              "ORDER CREATED:",
              orderNumber
            );

            if (
              orderType === "dine_in"
            ) {

              customerReply +=
                `\n\n✅ *Dine-In Ticket Created:* *${orderNumber}*\nTable ${orderData.table || "Not specified"}\nPlease show this Order ID to your captain/waiter.`;

            } else {

              customerReply +=
                `\n\n✅ *Order Received:* *${orderNumber}*\nThank you. Our team will contact you shortly regarding the order.`;
            }
          }

        }

        replyText =
          customerReply;
      }


      // =====================================================
      // RESERVATION PROCESSING
      // =====================================================

      if (
        replyText.includes(
          "RESERVATION_DATA:"
        )
      ) {

        const parts =
          replyText.split(
            "RESERVATION_DATA:"
          );

        const customerReply =
          parts[0].trim();

        let reservationData = null;

        try {

          reservationData =
            JSON.parse(parts[1].trim());

        } catch (parseError) {

          console.error(
            "RESERVATION DATA PARSE ERROR:",
            parseError
          );
        }

        if (
          reservationData
        ) {

          const {
            error: reservationError
          } = await supabase
            .from("reservations")
            .insert({

              customer_phone:
                fromPhone,

              customer_name:
                customer?.name ||
                "WhatsApp Guest",

              party_size:
                Number(
                  reservationData.party_size
                ) || 2,

              booking_time:
                reservationData.time ||
                "Evening",

              status:
                "pending"
            });

          if (reservationError) {

            console.error(
              "RESERVATION DATABASE ERROR:",
              reservationError
            );

          } else {

            console.log(
              "RESERVATION CREATED"
            );

            customerReply +=
              `\n\n✅ *Table Request Logged!*\nThank you for choosing Ilhaam Royal Dining. Our team will contact you to confirm the reservation.`;
          }
        }

        replyText =
          customerReply;
      }


      // =====================================================
      // FINAL SAFETY
      // =====================================================

      if (!replyText) {

        console.error(
          "EMPTY GEMINI RESPONSE"
        );

        replyText =
          "Sorry, I couldn't process that request. Please try again.";
      }


      // =====================================================
      // SEND WHATSAPP MESSAGE
      // =====================================================

      console.log(
        "SENDING WHATSAPP RESPONSE..."
      );

      const whatsappResponse =
        await fetch(
          `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({

              messaging_product:
                "whatsapp",

              to:
                fromPhone,

              type:
                "text",

              text: {
                body:
                  replyText
              }
            })
          }
        );


      const whatsappResult =
        await whatsappResponse.text();

      console.log(
        "WHATSAPP API STATUS:",
        whatsappResponse.status
      );

      console.log(
        "WHATSAPP API RESPONSE:",
        whatsappResult
      );


      // =====================================================
      // FINISH
      // =====================================================

      return res
        .status(200)
        .send("EVENT_RECEIVED");

    } catch (error) {

      console.error(
        "CRITICAL WEBHOOK ERROR:",
        error
      );

      return res
        .status(200)
        .send("ERROR_HANDLED");
    }
  }


  return res
    .status(405)
    .send("Method Not Allowed");
}
