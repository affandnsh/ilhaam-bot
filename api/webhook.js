import { createClient } from "@supabase/supabase-js";

/*
========================================================
ILHAAM ROYAL DINING — WHATSAPP AI WEBHOOK
Production-safe version
========================================================
*/

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-3.8-flash";

let supabase = null;

if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
  try {
    supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    );
  } catch (error) {
    console.error("SUPABASE INIT ERROR:", error);
  }
}


/*
========================================================
HELPERS
========================================================
*/

function log(...args) {
  console.log("[ILHAAM]", ...args);
}


async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}


async function sendWhatsApp(to, text) {

  if (!WHATSAPP_PHONE_ID) {
    throw new Error("WHATSAPP_PHONE_ID is missing");
  }

  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is missing");
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_ID}/messages`;

  log("Sending WhatsApp message to:", to);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        messaging_product: "whatsapp",

        to,

        type: "text",

        text: {
          body: text
        }
      })
    },
    15000
  );

  const raw = await response.text();

  log("META STATUS:", response.status);
  log("META RESPONSE:", raw);

  if (!response.ok) {
    throw new Error(
      `Meta WhatsApp API failed (${response.status}): ${raw}`
    );
  }

  return true;
}


/*
========================================================
GEMINI
========================================================
*/

async function askGemini(prompt) {

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  log("Calling Gemini:", GEMINI_MODEL);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
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
    },
    20000
  );

  const raw = await response.text();

  log("GEMINI STATUS:", response.status);
  log("GEMINI RAW:", raw);

  if (!response.ok) {
    throw new Error(
      `Gemini API failed (${response.status}): ${raw}`
    );
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part?.text || "")
      .join("")
      .trim();

  if (!text) {
    throw new Error(
      "Gemini returned no usable text"
    );
  }

  return text;
}


/*
========================================================
MENU
========================================================
*/

async function getMenu() {

  if (!supabase) {
    log("Supabase unavailable — using emergency menu.");
    return getEmergencyMenu();
  }

  try {

    const { data, error } = await supabase
      .from("menu_items")
      .select(
        "name, category, price, is_veg, is_available"
      )
      .eq("is_available", true)
      .order("category", { ascending: true });

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      log("Supabase menu is empty — using emergency menu.");
      return getEmergencyMenu();
    }

    log(`Loaded ${data.length} menu items from Supabase.`);

    return data
      .map(item => {

        const vegStatus =
          item.is_veg ? "Veg" : "Non-Veg";

        return (
          `- ${item.name} | ` +
          `${item.category} | ` +
          `₹${item.price} | ` +
          `${vegStatus}`
        );

      })
      .join("\n");

  } catch (error) {

    console.error(
      "MENU DATABASE ERROR:",
      error
    );

    return getEmergencyMenu();
  }
}


function getEmergencyMenu() {

  return `
- Fish Fingers | Starters | ₹370 | Non-Veg
- Chilli Chicken | Starters | ₹250 | Non-Veg
- Crispy Chilli Babycorn | Starters | ₹210 | Veg
- Kolkata Chicken Biryani | Biryani | ₹320 | Non-Veg
- Royal Mutton Biryani | Biryani | ₹390 | Non-Veg
- Reshmi Kebab | Tandoor | ₹320 | Non-Veg
- Cheese Kebab | Tandoor | ₹440 | Veg
- Butter Naan | Breads | ₹60 | Veg
- Garlic Cheese Naan | Breads | ₹100 | Veg
`.trim();
}


/*
========================================================
CUSTOMER
========================================================
*/

async function getOrCreateCustomer(phone) {

  if (!supabase) {
    return null;
  }

  try {

    const { data, error } = await supabase
      .from("customers")
      .upsert(
        {
          whatsapp_number: phone,
          name: "WhatsApp Guest"
        },
        {
          onConflict: "whatsapp_number"
        }
      )
      .select()
      .single();

    if (error) {
      console.error(
        "CUSTOMER DATABASE ERROR:",
        error
      );

      return null;
    }

    return data;

  } catch (error) {

    console.error(
      "CUSTOMER ERROR:",
      error
    );

    return null;
  }
}


/*
========================================================
MAIN AI PROMPT
========================================================
*/

function buildPrompt({
  incomingText,
  phone,
  menu
}) {

  return `
You are the official WhatsApp AI dining concierge for:

ILHAAM ROYAL DINING

Address:
2A Congress Exhibition Road,
Park Circus, Kolkata

Restaurant phone:
+91 74499 88873

You are speaking directly with a restaurant guest on WhatsApp.

Your job is to behave like a real, intelligent restaurant concierge.

====================================================
IMPORTANT RESTAURANT INFORMATION
====================================================

- Family fine-dining restaurant.
- Hookah is NOT available.
- Alcohol is NOT available.
- Reshmi Kebab is boneless.
- Chicken Tikka is boneless.
- Chilli Chicken is boneless.
- Biryanis are bone-in.
- Drums of Heaven are bone-in.
- Mutton kebabs are NOT part of the regular daily menu.
- Mutton kebabs may sometimes be chef specials.
- Fish option currently available: Fish Fingers.
- Be polite, warm and concise.
- Never invent menu items or prices.
- Never invent availability.
- Never claim an order is confirmed unless the customer explicitly confirms it.
- Never invent discounts.
- Never invent delivery charges.
- Never invent restaurant policies.

====================================================
LIVE MENU FROM DATABASE
====================================================

${menu}

====================================================
CUSTOMER
====================================================

Customer WhatsApp number:
${phone}

Customer's latest message:
"${incomingText}"

====================================================
CONVERSATION BEHAVIOUR
====================================================

Answer naturally.

If the customer asks about:

- menu
- food
- ingredients
- veg/non-veg
- prices
- recommendations
- portions
- boneless/bone-in
- restaurant information

answer directly using the information available above.

If something is not known, say that you do not want to guess and suggest contacting the restaurant.

====================================================
ORDERING
====================================================

When the customer wants to order:

1. Understand the requested items and quantities.
2. Calculate the total from the menu.
3. Show a clear summary.
4. Ask for confirmation.

Example:

"Certainly. Your order is:

2 × Chilli Chicken — ₹500
1 × Butter Naan — ₹60

Total: ₹560

Shall I confirm this order?
Reply YES to confirm."

Do NOT create an order before explicit confirmation.

When the customer explicitly confirms an order with YES, CONFIRM, PROCEED, etc.:

Return the confirmation message followed by this exact machine-readable line:

ORDER_DATA:{"items":[{"name":"Chilli Chicken","quantity":2,"price":250},{"name":"Butter Naan","quantity":1,"price":60}],"total":560,"type":"takeaway"}

IMPORTANT:

- The JSON must be valid.
- total must be the actual calculated total.
- price must be the actual menu price.
- quantity must be numeric.
- type must be "takeaway" unless the customer clearly requests dine-in.
- For dine-in use "dine_in".

====================================================
TABLE RESERVATIONS
====================================================

If customer wants a table reservation:

Ask for:

1. Number of people
2. Date
3. Preferred time

Do not pretend that a table is available.

Once the customer has supplied all three, return:

RESERVATION_DATA:{"party_size":2,"date":"2026-09-27","time":"8:00 PM"}

Only use a date supplied or clearly understood from the conversation.

====================================================
DELIVERY
====================================================

Do not invent delivery availability or delivery fees.

If customer asks to place a delivery order, collect the necessary information and explain that the restaurant will confirm delivery details.

====================================================
STYLE
====================================================

- Friendly
- Premium
- Human
- Helpful
- Concise
- No unnecessary essays
- Use WhatsApp-friendly formatting
- Use occasional emojis, but don't overdo them.

Customer's message:
"${incomingText}"
`;
}


/*
========================================================
ORDER DATABASE
========================================================
*/

async function saveOrder(customer, payload) {

  if (!supabase) {
    log("Supabase unavailable. Order NOT written to database.");
    return null;
  }

  if (!customer?.id) {
    log("No customer ID. Order NOT written.");
    return null;
  }

  if (!payload?.total || Number(payload.total) <= 0) {
    log("Invalid order total. Order NOT written.");
    return null;
  }

  try {

    const orderNumber =
      `ORD-${Date.now().toString().slice(-6)}`;

    const { data, error } =
      await supabase
        .from("orders")
        .insert({
          order_number: orderNumber,
          customer_id: customer.id,
          total: Number(payload.total),
          subtotal: Number(payload.total),
          status: "new",
          payment_status: "pending",
          order_type: payload.type || "takeaway"
        })
        .select()
        .single();

    if (error) {
      console.error(
        "ORDER DATABASE ERROR:",
        error
      );

      return null;
    }

    return {
      orderNumber,
      data
    };

  } catch (error) {

    console.error(
      "ORDER SAVE ERROR:",
      error
    );

    return null;
  }
}


/*
========================================================
RESERVATION DATABASE
========================================================
*/

async function saveReservation(
  customer,
  phone,
  payload
) {

  if (!supabase) {
    log("Supabase unavailable. Reservation NOT written.");
    return null;
  }

  try {

    const { data, error } =
      await supabase
        .from("reservations")
        .insert({
          customer_phone: phone,
          customer_name:
            customer?.name || "WhatsApp Guest",
          party_size:
            Number(payload.party_size) || 2,
          booking_time:
            payload.time || "Evening",
          status: "pending"
        })
        .select()
        .single();

    if (error) {
      console.error(
        "RESERVATION DATABASE ERROR:",
        error
      );

      return null;
    }

    return data;

  } catch (error) {

    console.error(
      "RESERVATION SAVE ERROR:",
      error
    );

    return null;
  }
}


/*
========================================================
PARSE ORDER DATA
========================================================
*/

function extractOrderData(reply) {

  const marker = "ORDER_DATA:";

  if (!reply.includes(marker)) {
    return {
      cleanReply: reply,
      payload: null
    };
  }

  const index = reply.indexOf(marker);

  const cleanReply =
    reply.substring(0, index).trim();

  const jsonText =
    reply.substring(
      index + marker.length
    ).trim();

  try {

    const payload =
      JSON.parse(jsonText);

    return {
      cleanReply,
      payload
    };

  } catch (error) {

    console.error(
      "ORDER JSON PARSE ERROR:",
      error
    );

    return {
      cleanReply,
      payload: null
    };
  }
}


/*
========================================================
PARSE RESERVATION DATA
========================================================
*/

function extractReservationData(reply) {

  const marker = "RESERVATION_DATA:";

  if (!reply.includes(marker)) {
    return {
      cleanReply: reply,
      payload: null
    };
  }

  const index = reply.indexOf(marker);

  const cleanReply =
    reply.substring(0, index).trim();

  const jsonText =
    reply.substring(
      index + marker.length
    ).trim();

  try {

    const payload =
      JSON.parse(jsonText);

    return {
      cleanReply,
      payload
    };

  } catch (error) {

    console.error(
      "RESERVATION JSON PARSE ERROR:",
      error
    );

    return {
      cleanReply,
      payload: null
    };
  }
}


/*
========================================================
WEBHOOK
========================================================
*/

export default async function handler(req, res) {

  /*
  ------------------------------------------------------
  GET = Meta verification
  ------------------------------------------------------
  */

  if (req.method === "GET") {

    // Optional health check
    if (req.query?.health === "1") {

      return res.status(200).json({
        ok: true,
        service: "Ilhaam Royal Dining WhatsApp Bot",
        geminiConfigured: !!GEMINI_API_KEY,
        whatsappConfigured:
          !!WHATSAPP_PHONE_ID &&
          !!WHATSAPP_ACCESS_TOKEN,
        supabaseConfigured:
          !!SUPABASE_URL &&
          !!SUPABASE_SECRET_KEY,
        model: GEMINI_MODEL
      });
    }

    const mode =
      req.query?.["hub.mode"];

    const token =
      req.query?.["hub.verify_token"];

    const challenge =
      req.query?.["hub.challenge"];

    log("META VERIFICATION REQUEST");

    if (
      mode === "subscribe" &&
      token === VERIFY_TOKEN
    ) {

      log("META VERIFICATION SUCCESS");

      return res
        .status(200)
        .send(challenge);
    }

    log("META VERIFICATION FAILED");

    return res
      .status(403)
      .send("Forbidden");
  }


  /*
  ------------------------------------------------------
  POST = WhatsApp incoming event
  ------------------------------------------------------
  */

  if (req.method !== "POST") {

    return res
      .status(405)
      .send("Method Not Allowed");
  }


  try {

    log("====================================");
    log("NEW WHATSAPP WEBHOOK EVENT");
    log("====================================");

    const body = req.body;

    log(
      "Incoming webhook body:",
      JSON.stringify(body)
    );


    /*
    ----------------------------------------------------
    Extract WhatsApp message
    ----------------------------------------------------
    */

    const entry =
      body?.entry?.[0];

    const change =
      entry?.changes?.[0];

    const value =
      change?.value;

    const message =
      value?.messages?.[0];


    /*
    Meta sends other events too.
    These are not actual customer messages.
    */

    if (!message) {

      log(
        "Webhook event contains no customer message."
      );

      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }


    const fromPhone =
      String(message.from || "")
        .replace(/\D/g, "");


    if (!fromPhone) {

      log(
        "Could not determine customer phone."
      );

      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }


    log(
      "CUSTOMER PHONE:",
      fromPhone
    );

    log(
      "MESSAGE TYPE:",
      message.type
    );


    /*
    ----------------------------------------------------
    VOICE NOTE
    ----------------------------------------------------
    */

    if (
      message.type === "audio" ||
      message.type === "voice"
    ) {

      try {

        await sendWhatsApp(
          fromPhone,

          "We received your voice note 🎙️\n\n" +
          "For now, please send your order or question as a text message and we'll be happy to help."
        );

      } catch (error) {

        console.error(
          "VOICE REPLY FAILED:",
          error
        );
      }

      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }


    /*
    ----------------------------------------------------
    Ignore non-text messages for now
    ----------------------------------------------------
    */

    if (message.type !== "text") {

      log(
        "Non-text message ignored:",
        message.type
      );

      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }


    const incomingText =
      message.text?.body?.trim() || "";


    if (!incomingText) {

      return res
        .status(200)
        .send("EVENT_RECEIVED");
    }


    log(
      "CUSTOMER MESSAGE:",
      incomingText
    );


    /*
    ----------------------------------------------------
    CUSTOMER + MENU
    ----------------------------------------------------
    */

    const [
      customer,
      menu
    ] = await Promise.all([
      getOrCreateCustomer(fromPhone),
      getMenu()
    ]);


    /*
    ----------------------------------------------------
    AI
    ----------------------------------------------------
    */

    let replyText = "";

    try {

      const prompt =
        buildPrompt({
          incomingText,
          phone: fromPhone,
          menu
        });

      replyText =
        await askGemini(prompt);

      log(
        "GEMINI REPLY:",
        replyText
      );

    } catch (error) {

      console.error(
        "GEMINI FAILED:",
        error
      );


      /*
      IMPORTANT:
      Even if Gemini fails, the customer MUST
      receive a response rather than silence.
      */

      replyText =
        "Welcome to *Ilhaam Royal Dining*! 🍽️\n\n" +
        "I'm having a temporary issue accessing my dining assistant.\n\n" +
        "Please try your message again in a moment, or call us directly at +91 74499 88873.";
    }


    /*
    ----------------------------------------------------
    ORDER PROCESSING
    ----------------------------------------------------
    */

    const orderResult =
      extractOrderData(replyText);

    replyText =
      orderResult.cleanReply;


    if (orderResult.payload) {

      const savedOrder =
        await saveOrder(
          customer,
          orderResult.payload
        );


      if (savedOrder) {

        if (
          orderResult.payload.type ===
          "dine_in"
        ) {

          replyText +=
            `\n\n✅ *Dine-In Order Created*\n` +
            `Order ID: *${savedOrder.orderNumber}*`;

        } else {

          replyText +=
            `\n\n✅ *Order Created*\n` +
            `Order ID: *${savedOrder.orderNumber}*\n` +
            `Thank you for ordering with us.`;

        }

      } else {

        /*
        Do NOT falsely tell customer that the
        database order was created.
        */

        replyText +=
          "\n\nPlease note: your order details were understood, " +
          "but our order system needs a quick check. " +
          "Please call +91 74499 88873 to confirm.";
      }
    }


    /*
    ----------------------------------------------------
    RESERVATION PROCESSING
    ----------------------------------------------------
    */

    const reservationResult =
      extractReservationData(replyText);

    replyText =
      reservationResult.cleanReply;


    if (reservationResult.payload) {

      const savedReservation =
        await saveReservation(
          customer,
          fromPhone,
          reservationResult.payload
        );


      if (savedReservation) {

        replyText +=
          "\n\n✅ *Table Request Logged!*\n" +
          "Our team will contact you to confirm the reservation.";

      } else {

        replyText +=
          "\n\nOur reservation system needs a quick check. " +
          "Please call +91 74499 88873 to confirm your table.";
      }
    }


    /*
    ----------------------------------------------------
    ABSOLUTE SAFETY NET
    ----------------------------------------------------
    */

    if (!replyText || !replyText.trim()) {

      replyText =
        "Thank you for contacting *Ilhaam Royal Dining*! 🍽️\n\n" +
        "How may I assist you today?";
    }


    /*
    ----------------------------------------------------
    SEND TO WHATSAPP
    ----------------------------------------------------
    */

    try {

      await sendWhatsApp(
        fromPhone,
        replyText
      );

      log(
        "WHATSAPP RESPONSE SENT SUCCESSFULLY"
      );

    } catch (error) {

      /*
      This is the most important log if the customer
      receives absolutely nothing.
      */

      console.error(
        "!!!!!!!! META SEND FAILED !!!!!!!!"
      );

      console.error(error);

      log(
        "Reply that Meta failed to receive:",
        replyText
      );
    }


    /*
    ----------------------------------------------------
    ALWAYS ACKNOWLEDGE META
    ----------------------------------------------------
    */

    return res
      .status(200)
      .send("EVENT_RECEIVED");


  } catch (error) {

    /*
    ----------------------------------------------------
    GLOBAL FAILURE
    ----------------------------------------------------
    */

    console.error(
      "!!!!!!!! CRITICAL WEBHOOK ERROR !!!!!!!!"
    );

    console.error(error);


    /*
    Still return 200 so Meta does not endlessly
    retry a broken event.
    */

    return res
      .status(200)
      .send("EVENT_RECEIVED");
  }
}
