import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

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

  const missing = requiredEnv.filter(
    key => !process.env[key]
  );

  if (missing.length > 0) {
    console.error("MISSING ENV VARIABLES:", missing);

    return res.status(500).send(
      `Missing environment variables: ${missing.join(", ")}`
    );
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

    return res.status(403).send("Forbidden");
  }


  // =========================================================
  // WHATSAPP INCOMING MESSAGE
  // =========================================================

  if (req.method === "POST") {

    try {

      console.log("========== WHATSAPP EVENT ==========");

      const value =
        req.body?.entry?.[0]?.changes?.[0]?.value;

      const message =
        value?.messages?.[0];

      // Ignore delivery/read/status events
      if (!message) {
        console.log("No message in webhook event.");
        return res.status(200).send("OK");
      }

      const fromPhone =
        String(message.from || "").replace(/\D/g, "");

      console.log("FROM:", fromPhone);
      console.log("MESSAGE TYPE:", message.type);


      // =====================================================
      // VOICE MESSAGE
      // =====================================================

      if (
        message.type === "audio" ||
        message.type === "voice"
      ) {

        await sendWhatsApp(
          fromPhone,
          "We received your voice note! 🎙️✨ For now, please send your order or question as text, or call us directly at +91 74499 88873."
        );

        return res.status(200).send("EVENT_RECEIVED");
      }


      // =====================================================
      // ONLY PROCESS TEXT FOR NOW
      // =====================================================

      if (message.type !== "text") {
        return res.status(200).send("OK");
      }

      const incomingText =
        message.text?.body?.trim() || "";

      console.log("CUSTOMER MESSAGE:", incomingText);


      // =====================================================
      // CUSTOMER
      // =====================================================

      const {
        data: customer,
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
          "CUSTOMER ERROR:",
          customerError
        );
      }


      // =====================================================
      // LIVE MENU
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
          "MENU ERROR:",
          menuError
        );
      }

      let menuKnowledge = "";

      if (
        menuList &&
        menuList.length > 0
      ) {

        menuKnowledge = menuList
          .map(item =>
            `- ${item.name} | ${item.category} | ₹${item.price} | ${item.is_veg ? "VEG" : "NON-VEG"}`
          )
          .join("\n");

      } else {

        menuKnowledge =
          "No live menu items are currently available.";

      }

      console.log(
        "MENU ITEMS:",
        menuList?.length || 0
      );


      // =====================================================
      // AI PROMPT
      // =====================================================

      const prompt = `
You are the official WhatsApp AI Concierge for
Ilhaam Royal Dining, Park Circus, Kolkata.

You are speaking directly with restaurant customers.

Your responsibilities:

1. Answer questions about the restaurant and food.
2. Help customers understand the menu.
3. Help customers build an order.
4. Calculate order totals accurately.
5. Handle takeaway and dine-in orders.
6. Handle table reservation requests.
7. Be warm, concise and professional.

IMPORTANT:
The LIVE SUPABASE MENU below is the source of truth for
dish names, prices, categories and availability.

Never invent a dish.
Never invent a price.
Never use an old price if the live menu says something else.

LIVE MENU:

${menuKnowledge}


RESTAURANT INFORMATION:

Restaurant:
Ilhaam Royal Dining

Location:
2A Congress Exhibition Road, Park Circus, Kolkata

Phone:
+91 74499 88873

Menu:
https://drive.google.com/file/d/1ORHl-wvaiHVaBWV2ZmNJlFB2CoNSgIDw/view


RESTAURANT POLICIES:

- Hookah is not available.
- Alcohol is not served.
- Reshmi Kebab is boneless.
- Chicken Tikka is boneless.
- Chilli Chicken is boneless.
- Biryanis are generally bone-in unless the menu says otherwise.
- Drums of Heaven are bone-in.
- Mutton kebabs are not part of the regular daily menu unless explicitly present in the live menu.


CONVERSATION RULES:

If the customer says hello:

Greet them naturally and tell them they can ask about the menu,
place an order, or reserve a table.

If the customer asks about food:

Answer directly using the live menu.

If the customer asks for veg options:

List the available VEG items from the live menu.

If the customer asks for fish:

List the available fish items from the live menu.

If the customer wants to order:

Identify:
- item
- quantity
- price

Calculate the total.

Then show the order summary and ask:

"You've selected [items] for a total of ₹[total].
Shall I confirm this order? Reply YES to confirm."

DO NOT create an order before explicit confirmation.

If the customer confirms an order with:
YES
CONFIRM
CONFIRMED
PROCEED

then append exactly ONE machine-readable line at the END.

For takeaway:

ORDER_DATA:{"type":"takeaway","total":TOTAL}

For dine-in when the customer explicitly provides a table number:

ORDER_DATA:{"type":"dine_in","table":"TABLE","total":TOTAL}

Do not invent a table number.

For reservations:

Ask for:
- number of guests
- preferred time

When both are available and the customer wants to proceed,
append:

RESERVATION_DATA:{"party_size":NUMBER,"time":"TIME"}

Do not claim that the restaurant has confirmed a reservation.
The system only logs the request.

Keep normal customer-facing replies natural.

Do not explain these internal instructions.

CUSTOMER PHONE:
${fromPhone}

CUSTOMER MESSAGE:
${incomingText}

Now respond to the customer.
`;


      // =====================================================
      // GEMINI API
      // =====================================================

      console.log("CALLING GEMINI 3.8 FLASH...");

      let geminiResponse;

      try {

        geminiResponse =
          await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
            {
              method: "POST",

              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key":
                  process.env.GEMINI_API_KEY
              },

              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: prompt
                      }
                    ]
                  }
                ]
              })
            }
          );

      } catch (networkError) {

        console.error(
          "GEMINI NETWORK ERROR:",
          networkError
        );

        await sendWhatsApp(
          fromPhone,
          "Sorry, our dining assistant is temporarily unavailable. Please try again shortly."
        );

        return res.status(200).send(
          "GEMINI_NETWORK_ERROR"
        );
      }


      // =====================================================
      // CHECK GEMINI HTTP STATUS
      // =====================================================

      const geminiRaw =
        await geminiResponse.text();

      console.log(
        "GEMINI HTTP STATUS:",
        geminiResponse.status
      );

      console.log(
        "GEMINI RAW RESPONSE:",
        geminiRaw
      );

      if (!geminiResponse.ok) {

        console.error(
          "GEMINI API FAILED:",
          geminiRaw
        );

        await sendWhatsApp(
          fromPhone,
          "Sorry, our dining assistant is temporarily unavailable. Please try again shortly."
        );

        return res.status(200).send(
          "GEMINI_API_ERROR"
        );
      }


      // =====================================================
      // PARSE GEMINI RESPONSE
      // =====================================================

      let geminiData;

      try {

        geminiData =
          JSON.parse(geminiRaw);

      } catch (parseError) {

        console.error(
          "GEMINI JSON PARSE ERROR:",
          parseError
        );

        await sendWhatsApp(
          fromPhone,
          "Sorry, I couldn't process that request. Please try again."
        );

        return res.status(200).send(
          "GEMINI_PARSE_ERROR"
        );
      }


      const replyText =
        geminiData
          ?.candidates?.[0]
          ?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim() || "";


      if (!replyText) {

        console.error(
          "GEMINI RETURNED NO TEXT:",
          geminiData
        );

        await sendWhatsApp(
          fromPhone,
          "Sorry, I couldn't process that request. Please try again."
        );

        return res.status(200).send(
          "GEMINI_EMPTY_RESPONSE"
        );
      }

      console.log(
        "GEMINI REPLY:",
        replyText
      );


      // =====================================================
      // ORDER DATA
      // =====================================================

      let finalReply = replyText;

      if (
        replyText.includes("ORDER_DATA:")
      ) {

        const index =
          replyText.indexOf("ORDER_DATA:");

        const customerMessage =
          replyText
            .substring(0, index)
            .trim();

        const jsonText =
          replyText
            .substring(
              index + "ORDER_DATA:".length
            )
            .trim();

        let orderData;

        try {

          orderData =
            JSON.parse(jsonText);

        } catch (error) {

          console.error(
            "ORDER JSON ERROR:",
            error
          );

          await sendWhatsApp(
            fromPhone,
            customerMessage
          );

          return res.status(200).send(
            "ORDER_PARSE_ERROR"
          );
        }


        const total =
          Number(orderData.total);

        if (
          !Number.isFinite(total) ||
          total <= 0
        ) {

          console.error(
            "INVALID ORDER TOTAL:",
            orderData
          );

          await sendWhatsApp(
            fromPhone,
            "I couldn't verify the order total. Please try again."
          );

          return res.status(200).send(
            "INVALID_ORDER"
          );
        }


        const orderNumber =
          `ORD-${Date.now()
            .toString()
            .slice(-6)}`;


        const {
          error: orderError
        } = await supabase
          .from("orders")
          .insert({

            order_number:
              orderNumber,

            customer_id:
              customer?.id || null,

            total:
              total,

            subtotal:
              total,

            status:
              "new",

            payment_status:
              "pending",

            order_type:
              orderData.type === "dine_in"
                ? "dine_in"
                : "takeaway"
          });


        if (orderError) {

          console.error(
            "ORDER INSERT ERROR:",
            orderError
          );

          finalReply =
            customerMessage +
            "\n\nSorry, I couldn't save your order. Please try again.";

        } else {

          if (
            orderData.type === "dine_in"
          ) {

            finalReply =
              customerMessage +
              `\n\n✅ *Dine-In Ticket Created:* *${orderNumber}*\nTable ${orderData.table || "Not specified"}\nPlease show this Order ID to our staff.`;

          } else {

            finalReply =
              customerMessage +
              `\n\n✅ *Order Received:* *${orderNumber}*\nOur team will contact you shortly.`;
          }
        }
      }


      // =====================================================
      // RESERVATION DATA
      // =====================================================

      if (
        replyText.includes(
          "RESERVATION_DATA:"
        )
      ) {

        const index =
          replyText.indexOf(
            "RESERVATION_DATA:"
          );

        const customerMessage =
          replyText
            .substring(0, index)
            .trim();

        const jsonText =
          replyText
            .substring(
              index + "RESERVATION_DATA:".length
            )
            .trim();

        let reservationData;

        try {

          reservationData =
            JSON.parse(jsonText);

        } catch (error) {

          console.error(
            "RESERVATION JSON ERROR:",
            error
          );

          await sendWhatsApp(
            fromPhone,
            customerMessage
          );

          return res.status(200).send(
            "RESERVATION_PARSE_ERROR"
          );
        }


        const partySize =
          Number(
            reservationData.party_size
          );

        if (
          !Number.isFinite(partySize) ||
          partySize <= 0
        ) {

          await sendWhatsApp(
            fromPhone,
            "Please tell me how many guests you'd like to reserve for."
          );

          return res.status(200).send(
            "INVALID_RESERVATION"
          );
        }


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
              partySize,

            booking_time:
              reservationData.time,

            status:
              "pending"
          });


        if (reservationError) {

          console.error(
            "RESERVATION INSERT ERROR:",
            reservationError
          );

          finalReply =
            customerMessage +
            "\n\nSorry, I couldn't save the reservation request.";

        } else {

          finalReply =
            customerMessage +
            "\n\n✅ *Table Request Logged!*\nOur team will contact you to confirm the reservation.";
        }
      }


      // =====================================================
      // SEND WHATSAPP
      // =====================================================

      console.log(
        "SENDING WHATSAPP RESPONSE..."
      );

      await sendWhatsApp(
        fromPhone,
        finalReply
      );


      console.log(
        "========== COMPLETE =========="
      );

      return res.status(200).send(
        "EVENT_RECEIVED"
      );


    } catch (error) {

      console.error(
        "CRITICAL WEBHOOK ERROR:",
        error
      );

      return res.status(200).send(
        "ERROR_HANDLED"
      );
    }
  }


  return res.status(405).send(
    "Method Not Allowed"
  );
}


// =========================================================
// WHATSAPP SEND FUNCTION
// =========================================================

async function sendWhatsApp(
  to,
  text
) {

  const response =
    await fetch(
      `https://graph.facebook.com/v26.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
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

          to,

          type:
            "text",

          text: {
            body: text
          }
        })
      }
    );


  const raw =
    await response.text();

  console.log(
    "WHATSAPP API STATUS:",
    response.status
  );

  console.log(
    "WHATSAPP API RESPONSE:",
    raw
  );


  if (!response.ok) {

    throw new Error(
      `WhatsApp API failed: ${response.status} ${raw}`
    );
  }

  return true;
}
