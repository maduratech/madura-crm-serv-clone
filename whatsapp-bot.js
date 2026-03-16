import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  geminiAI,
  messageIdToLeadCache,
  handleWhatsAppMessageFailure,
  logLeadActivity,
  generateItineraryForLead,
} from "./index.js";
import { normalizePhone } from "./phoneUtils.js";
import {
  triagePrompt,
  dataExtractionPrompt,
  dataExtractionSchema,
  validationPrompt,
} from "./aiPrompts.js";
import { startTokenMonitoring } from "./utils/tokenMonitor.js";

// This file contains the standalone WhatsApp bot logic.
// It is imported and used by the main server/index.js file.

const app = express();
app.use(bodyParser.json());

// -------------------------
// SUPABASE INIT
// -------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// -------------------------
// WHATSAPP CONFIG
// -------------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Australia WhatsApp config
const WHATSAPP_TOKEN_AU = process.env.WHATSAPP_TOKEN_AU;
const PHONE_NUMBER_ID_AU = process.env.WHATSAPP_PHONE_NUMBER_ID_AU;

const GRAPH_API_BASE = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
const GRAPH_API_BASE_AU = PHONE_NUMBER_ID_AU
  ? `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID_AU}/messages`
  : null;

const MADURA_API_URL = "https://api.maduratravel.com/api/lead/whatsapp";

// -------------------------
// BRANCH DETECTION HELPER
// -------------------------

/**
 * Get branch ID and WhatsApp config based on phone number ID
 * @param {string} phoneNumberId - The WhatsApp phone number ID that received the message
 * @returns {Object} { branchId, token, phoneNumberId, graphApiBase }
 */
function getBranchConfigFromPhoneNumberId(phoneNumberId) {
  // Default to India/Branch 1 if phone number ID matches India number
  if (phoneNumberId === PHONE_NUMBER_ID) {
    return {
      branchId: 1,
      token: WHATSAPP_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      graphApiBase: GRAPH_API_BASE,
    };
  }

  // Australia/Branch 2 if phone number ID matches Australia number
  if (phoneNumberId === PHONE_NUMBER_ID_AU) {
    return {
      branchId: 2,
      token: WHATSAPP_TOKEN_AU || WHATSAPP_TOKEN, // Fallback to India token if AU not set
      phoneNumberId: PHONE_NUMBER_ID_AU,
      graphApiBase: GRAPH_API_BASE_AU || GRAPH_API_BASE,
    };
  }

  // Fallback: Default to India/Branch 1 if no match
  console.warn(
    `[BOT] ⚠️ Unknown phone number ID: ${phoneNumberId}. Defaulting to Branch 1 (India)`,
  );
  return {
    branchId: 1,
    token: WHATSAPP_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
    graphApiBase: GRAPH_API_BASE,
  };
}

// -------------------------
// HELPER FUNCTIONS
// -------------------------

// Helper: Phone Number Sanitizer
function sanitizePhoneNumber(phone) {
  const normalized = normalizePhone(phone, "IN");
  if (!normalized) return null;
  // libphonenumber-js returns E.164 (with +). For our existing callers we
  // prefer to remove spaces and keep the + so WhatsApp API accepts it.
  return normalized.replace(/\s+/g, "");
}

// Date conversion helper: dd-mm-yyyy -> yyyy-mm-dd
function convertDateFormat(dateStr) {
  try {
    // Expected input: dd-mm-yyyy
    const parts = dateStr.trim().split(/[-\/]/);
    if (parts.length !== 3) return dateStr;

    const day = parts[0].padStart(2, "0");
    const month = parts[1].padStart(2, "0");
    let year = parts[2];

    // Handle 2-digit year
    if (year.length === 2) {
      year = "20" + year;
    }

    // Return in PostgreSQL format: yyyy-mm-dd
    return `${year}-${month}-${day}`;
  } catch (err) {
    console.error("Date conversion error:", err);
    return dateStr;
  }
}

// Validate and convert date
function validateAndConvertDate(dateStr) {
  try {
    const converted = convertDateFormat(dateStr);
    const [year, month, day] = converted.split("-").map(Number);

    // Basic validation
    if (year < 2024 || year > 2030)
      return { valid: false, error: "Year must be between 2024-2030" };
    if (month < 1 || month > 12)
      return { valid: false, error: "Month must be between 1-12" };
    if (day < 1 || day > 31)
      return { valid: false, error: "Day must be between 1-31" };

    return { valid: true, converted };
  } catch (err) {
    return { valid: false, error: "Invalid date format" };
  }
}

async function sendText(to, text) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    };

    const response = await fetch(GRAPH_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      const errMsg = result.error?.message || JSON.stringify(result.error);
      if (
        result.error?.code === 190 ||
        result.error?.type === "OAuthException"
      ) {
        console.error(
          "[BOT] out to=+%s err=TOKEN_EXPIRED %s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      } else {
        console.error(
          "[BOT] out to=+%s err=%s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      }
      return null;
    }
    console.log("[BOT] out to=+%s ok at %s", to, new Date().toISOString());
    return result;
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    return null;
  }
}

async function sendList(to, text, buttonText, sections) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text },
        action: {
          button: buttonText,
          sections,
        },
      },
    };

    const response = await fetch(GRAPH_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(
        "[BOT] out to=+%s err=list %s at %s",
        to,
        result.error?.message || JSON.stringify(result.error),
        new Date().toISOString(),
      );
      return null;
    }
    console.log("[BOT] out to=+%s ok at %s", to, new Date().toISOString());
    return result;
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    return null;
  }
}

async function sendInteractive(to, text, buttons) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: { buttons },
      },
    };

    const response = await fetch(GRAPH_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(
        "[BOT] out to=+%s err=interactive %s at %s",
        to,
        result.error?.message || JSON.stringify(result.error),
        new Date().toISOString(),
      );
      return null;
    }
    console.log("[BOT] out to=+%s ok at %s", to, new Date().toISOString());
    return result;
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    return null;
  }
}

// Helper function to send consultant notification template
async function sendConsultantTemplate(
  to,
  customerName,
  consultantName,
  consultantPhone,
) {
  try {
    const templatePayload = {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: "call_consultant",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: customerName || "Valued Customer" }, // {{1}} - Customer Name
              { type: "text", text: consultantName }, // {{2}} - Consultant Name
              { type: "text", text: consultantPhone }, // {{3}} - Consultant Phone
            ],
          },
        ],
      },
    };

    const response = await fetch(GRAPH_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(templatePayload),
    });

    const result = await response.json();
    if (response.ok) {
      console.log("[BOT] out to=+%s ok at %s", to, new Date().toISOString());
      return true;
    } else {
      const errMsg = result.error?.message || JSON.stringify(result.error);
      if (
        result.error?.code === 190 ||
        result.error?.type === "OAuthException"
      ) {
        console.error(
          "[BOT] out to=+%s err=TOKEN_EXPIRED %s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      } else {
        console.error(
          "[BOT] out to=+%s err=template %s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      }
      return false;
    }
  } catch (templateErr) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      templateErr.message,
      new Date().toISOString(),
    );
    return false;
  }
}

// Template -> Text Fallback Logic for CTA URLs
async function sendCtaUrl(to, text, buttonText, url, agentName = "Agent") {
  try {
    const urlObj = new URL(url);
    const queryParams = urlObj.search.substring(1); // leadId=...&staffId=... (without ?)

    const templatePayload = {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: "call_consultant",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: agentName }] }, // {{1}} Body
          {
            type: "button",
            sub_type: "url",
            index: 0,
            // WhatsApp template expects query params WITHOUT the ? - it will add it
            // Format: base_url?{{1}} where {{1}} = "leadId=348&staffId=14&customerId=85"
            parameters: [{ type: "text", text: queryParams }],
          }, // {{1}} Button URL
        ],
      },
    };

    const response = await fetch(GRAPH_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(templatePayload),
    });

    const result = await response.json();

    if (response.ok) {
      console.log("[BOT] out to=+%s ok at %s", to, new Date().toISOString());
      return result;
    } else {
      const errMsg = result.error?.message || JSON.stringify(result.error);
      if (
        result.error?.code === 190 ||
        result.error?.type === "OAuthException"
      ) {
        console.error(
          "[BOT] out to=+%s err=TOKEN_EXPIRED %s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      } else {
        console.error(
          "[BOT] out to=+%s err=template %s at %s",
          to,
          errMsg,
          new Date().toISOString(),
        );
      }
      const fullText = `${text}\n\n🔗 *${buttonText}*: ${url}`;
      return await sendText(to, fullText);
    }
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    const fullText = `${text}\n\n🔗 *${buttonText}*: ${url}`;
    return await sendText(to, fullText);
  }
}

// Add after existing sendInteractive() function:
async function sendQuickReply(to, questionText, options) {
  try {
    // WhatsApp only supports max 3 buttons - use list if more
    if (options.length > 3) {
      return await sendOptionsList(to, questionText, options);
    }

    const buttons = options.map((opt) => ({
      type: "reply",
      reply: { id: opt.id, title: opt.title },
    }));

    const response = await sendInteractive(to, questionText, buttons);
    return response ?? null;
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    return null;
  }
}

async function sendOptionsList(
  to,
  questionText,
  options,
  buttonLabel = "Select",
) {
  try {
    // WhatsApp API limit: Row title max 24 characters
    const sections = [
      {
        title: "Options",
        rows: options.map((opt) => {
          // Truncate title to 24 characters if needed
          let title = opt.title || "";
          if (title.length > 24) {
            title = title.substring(0, 21) + "...";
          }
          return {
            id: opt.id,
            title: title,
            description: opt.description || undefined,
          };
        }),
      },
    ];

    const response = await sendList(to, questionText, buttonLabel, sections);
    return response ?? null;
  } catch (err) {
    console.error(
      "[BOT] out to=+%s err=%s at %s",
      to,
      err.message,
      new Date().toISOString(),
    );
    return null;
  }
}

const SERVICES_LIST = [
  {
    id: "tour_package",
    title: "🧳 Tour Package",
    description: "Let's plan your dream trip",
  },
  {
    id: "visa",
    title: "🛂 Visa",
    description: "Get professional Visa Assistance",
  },
  {
    id: "hotel",
    title: "🏨 Hotel",
    description: "Get the cheapest Hotel rate ever",
  },
  {
    id: "air_ticket",
    title: "✈️ Air Ticket",
    description: "Get the best fares to fly",
  },
  { id: "forex", title: "💱 Forex", description: "Currency exchange" },
  { id: "passport", title: "🪪 Passport", description: "Passport services" },
];

const TRAVEL_TIMEFRAMES = [
  { id: "immediate", title: "Today/Tomorrow" },
  { id: "within_a_week", title: "Within a week" },
  { id: "within_this_month", title: "Within this month" },
  { id: "after_this_month", title: "After this month" },
];

// Add the travel date calculator function
function calculateTravelDate(timeframe) {
  const today = new Date();
  let travelDate = new Date(today);

  // Set time to 0 to avoid timezone issues when just adding days
  travelDate.setHours(0, 0, 0, 0);

  switch (timeframe) {
    case "immediate":
      break;
    case "within_a_week":
      travelDate.setDate(today.getDate() + 7);
      break;
    case "within_this_month":
      travelDate.setDate(today.getDate() + 30);
      break;
    case "after_this_month":
      travelDate.setDate(today.getDate() + 31);
      break;
  }

  return travelDate.toISOString().split("T")[0];
}

// New simplified destination list for Tour Package
const TOUR_PACKAGE_DESTINATIONS = [
  { id: "australia", title: "Australia" },
  { id: "vietnam", title: "Vietnam" },
  { id: "singapore", title: "Singapore" },
  { id: "japan", title: "Japan" },
  { id: "south_korea", title: "South Korea" },
  { id: "indonesia_bali", title: "Indonesia (Bali)" },
  { id: "uae_dubai", title: "UAE (Dubai)" },
  {
    id: "europe",
    title: "Europe",
    description: "France, Swiss, UK, etc.",
  },
  { id: "other", title: "Other Destination", description: "Type manually" },
];

// Expandable destinations for Europe
const EUROPE_DESTINATIONS = [
  { id: "france", title: "France" },
  { id: "switzerland", title: "Switzerland" },
  { id: "uk", title: "UK" },
  { id: "italy", title: "Italy" },
  { id: "germany", title: "Germany" },
  { id: "netherlands", title: "Netherlands" },
  { id: "belgium", title: "Belgium" },
  { id: "spain", title: "Spain" },
  { id: "other", title: "Other Destination", description: "Type manually" },
];

// Travel date selection: Quarters
const TRAVEL_QUARTERS = [
  { id: "q1", title: "Jan – Mar" },
  { id: "q2", title: "Apr – Jun" },
  { id: "q3", title: "Jul – Sep" },
  { id: "q4", title: "Oct – Dec" },
];

// Travel date selection: 2-month periods (single question with 6 options)
const TRAVEL_MONTHS_COMBINED = [
  { id: "jan-feb", title: "Jan – Feb" },
  { id: "mar-apr", title: "Mar – Apr" },
  { id: "may-jun", title: "May – Jun" },
  { id: "jul-aug", title: "Jul – Aug" },
  { id: "sep-oct", title: "Sep – Oct" },
  { id: "nov-dec", title: "Nov – Dec" },
];

// Travel date selection: Months by Quarter
const QUARTER_MONTHS = {
  q1: [
    { id: "january", title: "January" },
    { id: "february", title: "February" },
    { id: "march", title: "March" },
  ],
  q2: [
    { id: "april", title: "April" },
    { id: "may", title: "May" },
    { id: "june", title: "June" },
  ],
  q3: [
    { id: "july", title: "July" },
    { id: "august", title: "August" },
    { id: "september", title: "September" },
  ],
  q4: [
    { id: "october", title: "October" },
    { id: "november", title: "November" },
    { id: "december", title: "December" },
  ],
};

// Helper function to convert month name to date (1st of that month, current or next year)
function convertMonthToDate(monthName) {
  const monthMap = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  const monthNum = monthMap[monthName.toLowerCase()];
  if (!monthNum) return null;

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // JavaScript months are 0-indexed

  // If the selected month has already passed this year, use next year
  const year = monthNum < currentMonth ? currentYear + 1 : currentYear;

  // Return date as YYYY-MM-DD (1st of the selected month)
  return `${year}-${String(monthNum).padStart(2, "0")}-01`;
}

// Helper function to calculate check-out date from check-in + duration
function calculateCheckOutDate(checkInDate, duration) {
  try {
    const checkIn = new Date(checkInDate);
    if (isNaN(checkIn.getTime())) return null;

    let nights = 0;
    if (duration === "1-4") {
      nights = 4; // Use max for calculation
    } else if (duration === "5-9") {
      nights = 9; // Use max for calculation
    } else if (duration === "10+") {
      nights = 10; // Use 10 as default for 10+
    } else {
      // Try to parse if it's a number
      const parsed = parseInt(duration);
      if (!isNaN(parsed)) {
        nights = parsed;
      } else {
        return null;
      }
    }

    const checkOut = new Date(checkIn);
    checkOut.setDate(checkIn.getDate() + nights);
    return checkOut.toISOString().split("T")[0];
  } catch (err) {
    console.error("Error calculating check-out date:", err);
    return null;
  }
}

function getServiceQuestions(service, serviceData = {}) {
  const baseQuestions = {
    tour_package: [
      {
        key: "destination",
        prompt: "Choose your destination:",
        type: "list",
        options: TOUR_PACKAGE_DESTINATIONS,
      },
      {
        key: "travel_date",
        prompt: "When are you traveling?",
        type: "list",
        options: TRAVEL_MONTHS_COMBINED,
      },
      {
        key: "duration",
        prompt: "How long would you like to travel?",
        type: "list",
        options: [
          { id: "1-4", title: "Quick Holiday", description: "1-4 nights" },
          { id: "5-9", title: "Good Holiday", description: "5-9 nights" },
          {
            id: "10+",
            title: "Ultimate Holiday",
            description: "More than 9 nights",
          },
        ],
      },
      {
        key: "budget",
        prompt: "What's your budget preference?",
        type: "list",
        options: [
          {
            id: "Budget Friendly",
            title: "Budget Friendly",
            description: "Budget stay, basic vehicles, essential tours",
          },
          {
            id: "Comfort Collection",
            title: "Comfort Collection",
            description: "3★ hotels, AC vehicles, smooth tours",
          },
          {
            id: "Signature Tours",
            title: "Signature Tours",
            description: "4★ hotels, premium vehicles, relaxed tours",
          },
          {
            id: "Royal Retreat",
            title: "Royal Retreat",
            description: "5★ resorts, luxury vehicles, curated experiences",
          },
        ],
      },
    ],
    visa: [
      {
        key: "destination",
        prompt: "Which country are you applying for a visa for?",
        type: "text",
      },
      {
        key: "visa_type",
        prompt: "What type of visa do you need?",
        type: "list",
        options: [
          { id: "tourist", title: "Tourist" },
          { id: "business", title: "Business" },
          { id: "work", title: "Work" },
          { id: "artist", title: "Artist" },
          { id: "other", title: "Other" },
        ],
      },
    ],
    hotel: [
      {
        key: "destination",
        prompt: "🏨 Which city are you looking to stay in?",
        type: "text",
      },
      {
        key: "check_in",
        prompt: "📅 Check-in Date (dd-mm-yyyy):",
        type: "text",
      },
      {
        key: "duration",
        prompt: "How long would you like to stay?",
        type: "list",
        options: [
          { id: "1-4", title: "Quick stay", description: "1-4 nights" },
          { id: "5-9", title: "Comfortable stay", description: "5-9 nights" },
          { id: "10+", title: "Long Stays", description: "More than 9 nights" },
        ],
      },
    ],
    air_ticket: [
      {
        key: "air_travel_type",
        prompt: "What type of air travel do you need?",
        type: "list",
        options: [
          {
            id: "domestic",
            title: "Domestic",
            description: "Travel within India",
          },
          {
            id: "international",
            title: "International",
            description: "Travel from India to any country or vice versa",
          },
          {
            id: "global",
            title: "Global",
            description: "From Any country to any country not involving India",
          },
        ],
      },
      {
        key: "travel_date",
        prompt: "When are you traveling?",
        type: "list",
        options: TRAVEL_MONTHS_COMBINED,
      },
    ],
    forex: [
      {
        key: "currency_have",
        prompt: "Which currency do you have?",
        type: "list",
        options: [
          { id: "inr", title: "INR", description: "Indian Rupee" },
          { id: "usd", title: "USD", description: "US Dollar" },
          { id: "eur", title: "EUR", description: "Euro" },
          { id: "gbp", title: "GBP", description: "British Pound" },
          { id: "sgd", title: "SGD", description: "Singapore Dollar" },
          { id: "aed", title: "AED", description: "UAE Dirham" },
          { id: "jpy", title: "JPY", description: "Japanese Yen" },
          { id: "other", title: "Other", description: "Type manually" },
        ],
      },
      {
        key: "currency_required",
        prompt: "Which currency do you need?",
        type: "list",
        options: [
          { id: "inr", title: "INR", description: "Indian Rupee" },
          { id: "usd", title: "USD", description: "US Dollar" },
          { id: "eur", title: "EUR", description: "Euro" },
          { id: "gbp", title: "GBP", description: "British Pound" },
          { id: "sgd", title: "SGD", description: "Singapore Dollar" },
          { id: "aed", title: "AED", description: "UAE Dirham" },
          { id: "jpy", title: "JPY", description: "Japanese Yen" },
          { id: "other", title: "Other", description: "Type manually" },
        ],
      },
    ],
    passport: [
      {
        key: "passport_type",
        prompt: "What type of passport service do you need?",
        type: "buttons",
        options: [
          { id: "new", title: "New Passport" },
          { id: "renewal", title: "Renewal" },
        ],
      },
      // Conditionally add ECR check for New Passports
      ...(serviceData.passport_type === "new"
        ? [
            {
              key: "ecr_status",
              prompt: "Have you completed minimum of 10th std/SSLC?",
              type: "buttons",
              options: [
                { id: "yes", title: "Yes" },
                { id: "no", title: "No" },
              ],
            },
          ]
        : []),
      {
        key: "city",
        prompt: "Which city do you reside in?",
        type: "text",
      },
    ],
  };

  return baseQuestions[service] || [];
}

function formatLeadSummary(userData, customerName = null) {
  const service = userData.service_required;
  let summary = `✅ *Enquiry Summary*\n\n`;
  summary += `📋 *Service:* ${service
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())}\n\n`;

  // Service-specific details
  const serviceData = userData.service_data || {};

  for (const [key, value] of Object.entries(serviceData)) {
    if (value && key !== "question_queue") {
      const label = key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
      summary += `*${label}:* ${value}\n`;
    }
  }

  summary += `\n*Personal Details*\n`;
  summary += `*Name:* ${customerName || userData.name}\n`;
  summary += `*Email:* ${userData.email}\n`;
  summary += `*Phone:* ${userData.phone}\n`;

  return summary;
}

// -------------------------
// DATABASE FUNCTIONS
// -------------------------
async function getCustomerByPhone(phone) {
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("phone", phone)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 means no rows found, which is not an error here.
      console.error("[BOT] ❌ Error fetching customer:", error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error(
      "[BOT] ❌ Database error in getCustomerByPhone:",
      err.message,
    );
    return null;
  }
}

async function getUserSession(phone) {
  try {
    // Try to get existing session
    const { data: session, error } = await supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("phone", phone)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[BOT] ❌ Error fetching session:", error.message);
      return null;
    }

    if (session) {
      return session;
    }

    // Create new session if none exists
    const { data: newSession, error: createError } = await supabase
      .from("whatsapp_sessions")
      .insert([
        {
          phone,
          stage: "collecting_name",
          service_required: null,
          service_data: {},
          question_queue: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (createError) {
      console.error("[BOT] ❌ Error creating session:", createError.message);
      return null;
    }

    return newSession;
  } catch (err) {
    console.error("[BOT] ❌ Database error in getUserSession:", err.message);
    return null;
  }
}

async function updateUserSession(phone, updates, retryCount = 0) {
  try {
    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("phone", phone)
      .select()
      .single();

    if (error) {
      // Retry on connection pool timeout (up to 2 retries)
      const isConnectionError =
        error.message?.includes("connection pool") ||
        error.message?.includes("Timed out acquiring") ||
        error.code === "PGRST301" ||
        error.code === "57014";

      if (isConnectionError && retryCount < 2) {
        // Wait before retry (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (retryCount + 1)),
        );
        return updateUserSession(phone, updates, retryCount + 1);
      }

      // Only log non-retryable errors
      if (retryCount >= 2 || !isConnectionError) {
        console.error("[BOT] ❌ Error updating session:", error.message);
      }
      return null;
    }

    return data;
  } catch (err) {
    // Retry on connection pool timeout
    const isConnectionError =
      err.message?.includes("connection pool") ||
      err.message?.includes("Timed out acquiring");

    if (isConnectionError && retryCount < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * (retryCount + 1)),
      );
      return updateUserSession(phone, updates, retryCount + 1);
    }

    if (retryCount >= 2 || !isConnectionError) {
      console.error(
        "[BOT] ❌ Database error in updateUserSession:",
        err.message,
      );
    }
    return null;
  }
}

function parseBudget(budgetString) {
  if (!budgetString) return null;

  // Handle string categories: Economical, Standard, Deluxe, Luxury
  // Also support legacy "budget" for backward compatibility
  if (
    budgetString === "economical" ||
    budgetString === "budget" || // Legacy support
    budgetString === "standard" ||
    budgetString === "deluxe" ||
    budgetString === "luxury"
  ) {
    // Normalize "budget" to "economical" for consistency
    return budgetString === "budget" ? "economical" : budgetString;
  }

  // Handle numeric values (for backward compatibility or manual entry)
  // If it's a number or numeric string, return it as-is
  const numericValue = parseFloat(budgetString);
  if (!isNaN(numericValue) && isFinite(numericValue)) {
    return numericValue;
  }

  return null;
}

// NEW: Format data for API endpoint
function formatLeadDataForAPI(userData) {
  const serviceData = userData.service_data || {};
  const serviceTitle = userData.service_required; // e.g., "🧳 Tour Package"

  // Find the service object from its title to get the ID
  const serviceId =
    SERVICES_LIST.find((s) => s.title === serviceTitle)?.id || "other";

  let services = [];
  let enquiry = "Other"; // Default

  switch (serviceId) {
    case "air_ticket":
      enquiry = "Air Ticket";
      break;
    case "visa":
      enquiry = "Visa";
      break;
    case "hotel":
      enquiry = "Hotel";
      break;
    case "tour_package":
      enquiry = "Tour Package";
      break;
    case "forex":
      enquiry = "Forex";
      break;
    case "passport":
      enquiry = "Passport";
      break;
    case "other":
      enquiry = "Other";
      break;
  }
  services.push(enquiry);

  // Default requirements - set to null if not collected (agents will fill later)
  const requirements = {
    adults: null, // Not collected in simplified flow - agents will fill
    children: null, // Not collected in simplified flow - agents will fill
    babies: 0,
    hotelPreference: "No Preference",
    stayPreference: "No Preference",
    rooms: [], // Empty - agents will fill passenger details
  };

  let travelDate = null; // Set to null - agents will fill date of travel
  let returnDate = null;

  // Only use travel_date if explicitly provided (from AI extraction)
  // Do NOT calculate from timeframe or use fallback dates
  if (serviceData.travel_date) {
    // Use the specific date extracted by AI (already in YYYY-MM-DD format)
    travelDate = serviceData.travel_date;
    console.log(`[BOT] 📅 Using extracted travel date: ${travelDate}`);

    // If return_date is available, use it
    if (serviceData.return_date) {
      returnDate = serviceData.return_date;
      console.log(`[BOT] 📅 Using extracted return date: ${returnDate}`);
    }
  }
  // Note: We do NOT calculate dates from timeframe anymore
  // Agents will fill the actual travel date manually

  // Format destination - handle expandable destinations
  let formattedDestination = (serviceData.destination || "N/A")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  // If destination is europe, check if there's a sub-destination
  if (serviceData.destination === "europe" && serviceData.europe_destination) {
    formattedDestination = serviceData.europe_destination
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  const leadData = {
    name: userData.name,
    phone: userData.phone,
    email: userData.email,
    enquiry: enquiry, // Primary enquiry type
    services: [...new Set(services)], // Unique services
    date: travelDate, // Will be null if not explicitly provided
    travel_date: travelDate, // Will be null - agents will fill
    return_date: returnDate, // Return date if available
    destination: formattedDestination,
    duration: serviceData.duration || null,
    adults: null, // Not collected - agents will fill
    children: null, // Not collected - agents will fill
    babies: 0,
    requirements: requirements,
  };

  // Service-specific structured data
  if (serviceId === "air_ticket") {
    leadData.air_travel_type = serviceData.air_travel_type || null;
  }

  if (serviceId === "visa") {
    leadData.visa_type = serviceData.visa_type || null;
  }

  if (serviceId === "tour_package") {
    // Store budget as-is (new names: Budget Friendly, Comfort Collection, etc.)
    leadData.budget = serviceData.budget || null;
  }

  if (serviceId === "forex") {
    leadData.forex_currency_have = serviceData.currency_have || null;
    leadData.forex_currency_required = serviceData.currency_required || null;
  }

  if (serviceId === "passport") {
    leadData.passport_service_type = serviceData.passport_type || "New";
    leadData.passport_city_of_residence = serviceData.city || null;
  }

  if (serviceId === "hotel") {
    // Calculate check-out from check-in + duration
    const checkInDate = serviceData.check_in
      ? convertDateFormat(serviceData.check_in)
      : null;

    leadData.check_in_date = checkInDate;

    if (checkInDate && serviceData.duration) {
      const checkOutDate = calculateCheckOutDate(
        checkInDate,
        serviceData.duration,
      );
      leadData.check_out_date = checkOutDate;
    } else {
      leadData.check_out_date = null;
    }
  }

  // Create summary text for the lead's main summary field
  leadData.summary = formatLeadSummary(userData, userData.name);

  // Pass the raw user query if it exists from the AI flow
  if (userData.conversation_summary) {
    leadData.conversation_summary_note = userData.conversation_summary;
  }

  console.log(
    "[BOT] 📦 Formatted Lead Data for API:",
    JSON.stringify(leadData, null, 2),
  );

  return leadData;
}

async function submitLead(userData, branchId = null) {
  try {
    // Get branchId from userData if not provided, default to 1 (India)
    const finalBranchId = branchId || userData.branch_id || 1;

    const leadData = formatLeadDataForAPI(userData);
    // Add branchId to lead data
    leadData.branchId = finalBranchId;

    console.log("[BOT] 🚀 Submitting lead to Madura API...");
    console.log("[BOT] 🏢 Branch ID:", branchId);
    console.log("API URL:", MADURA_API_URL);
    console.log("Payload:", JSON.stringify(leadData, null, 2));

    const response = await fetch(MADURA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(leadData),
    });

    const responseText = await response.text();
    console.log("[BOT] API Response Status:", response.status);
    console.log("[BOT] API Response Body:", responseText);

    if (!response.ok) {
      throw new Error(`API Error ${response.status}: ${responseText}`);
    }

    const result = JSON.parse(responseText);
    console.log("[BOT] ✅ Lead submitted successfully:", result);

    // Try to extract the created lead ID from the API response shape:
    // { message: 'Lead created successfully from WhatsApp.', lead: { id, ... } }
    const leadId = result?.lead?.id ?? null;

    return { success: true, data: result, leadId };
  } catch (err) {
    console.error("[BOT] ❌ Error submitting lead:", err.message);
    return { success: false, error: err.message };
  }
}

// Helper to send question based on type
async function sendQuestion(from, question) {
  if (question.type === "buttons") {
    await sendQuickReply(from, question.prompt, question.options);
  } else if (question.type === "list") {
    await sendOptionsList(from, question.prompt, question.options);
  } else {
    await sendText(from, question.prompt);
  }
}

async function askNextQuestion(from, user) {
  let serviceData = user.service_data || {};
  const service = user.service_required
    ? SERVICES_LIST.find((s) => s.title === user.service_required)?.id ||
      "other"
    : "other";

  // REFACTORED: Pass full serviceData to handle conditional questions (like passport ECR check)
  const allQuestions = getServiceQuestions(service, serviceData);

  // Filter out questions that have already been answered
  let remainingQuestions = allQuestions.filter(
    (q) =>
      !serviceData.hasOwnProperty(q.key) ||
      serviceData[q.key] === null ||
      serviceData[q.key] === undefined,
  );

  // If we have a destination but are about to ask for a continent, skip it.
  if (
    service === "tour_package" &&
    (serviceData.destination || serviceData.destination_known) &&
    remainingQuestions[0]?.key === "continent"
  ) {
    console.log(
      "[BOT] 🧠 Destination already known, skipping continent question.",
    );
    remainingQuestions.shift(); // Remove the continent question
  }

  // If we have specific travel dates, skip the travel_timeframe question
  // (This is for AI flow where travel_date might be extracted before asking questions)
  if (
    serviceData.travel_date &&
    remainingQuestions[0]?.key === "travel_timeframe"
  ) {
    console.log(
      "[BOT] 📅 Travel dates already known, skipping travel_timeframe question.",
    );
    remainingQuestions.shift(); // Remove the travel_timeframe question
  }

  // Note: We don't skip travel_date question here because:
  // - In structured flow, it's properly handled by removing it from queue after month selection
  // - The travel_date question is the quarter selection, which is needed even if we have a date from AI
  //   (we want to confirm/update the date through the quarter/month flow)

  if (remainingQuestions.length > 0) {
    console.log(`[BOT] ❓ Asking next question: ${remainingQuestions[0].key}`);
    await updateUserSession(from, {
      stage: "collecting_service_data",
      question_queue: remainingQuestions,
    });
    await sendQuestion(from, remainingQuestions[0]);
  } else {
    console.log(
      "[BOT] ✅ All questions completed. Submitting lead with complete data.",
    );
    await sendText(
      from,
      "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
    );
    // Create lead only once when all questions are completed
    const updatedUser = { ...user, service_data: serviceData };
    const leadResult = await submitLead(updatedUser);
    if (leadResult.success) {
      await updateUserSession(from, {
        stage: "completed",
        service_data: {},
        question_queue: [],
      });
    } else {
      await sendText(
        from,
        "Sorry, there was an issue creating your enquiry. Please try again later.",
      );
    }
  }
}

// -------------------------
// WEBHOOK VERIFICATION
// -------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[BOT] 📥 Webhook verification request received");
  console.log(`Mode: ${mode}, Token: ${token}`);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[BOT] ✅ Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("[BOT] ❌ Webhook verification failed");
  return res.sendStatus(403);
});

// -------------------------
// REFACTORED HANDLERS
// -------------------------
async function handleAiExtractionFlow(from, user, messageText) {
  // AI extraction flow started (no verbose log)
  await updateUserSession(from, { flow_type: "ai_driven" });
  await sendText(from, "Got it! Let me process that for you...");

  try {
    const extractionResponse = await geminiAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ parts: [{ text: dataExtractionPrompt(messageText) }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: dataExtractionSchema,
      },
    });
    const extractedData = JSON.parse(extractionResponse.text.trim());
    // extractedData used below (no payload log)

    // Calculate duration from dates if not provided but dates are available (store as number of days)
    let duration = extractedData.duration;
    if (!duration && extractedData.start_date && extractedData.end_date) {
      try {
        const start = new Date(extractedData.start_date);
        const end = new Date(extractedData.end_date);
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        duration = diffDays >= 1 ? `${diffDays} Days` : null;
      } catch (e) {
        console.error("[BOT] Error calculating duration:", e);
      }
    }
    // Normalize to "X Days" if we have a number (e.g. "5", "5 Days / 4 Nights" -> "5 Days")
    if (duration && typeof duration === "string") {
      const match = String(duration).match(/(\d+)/);
      if (match) {
        const d = parseInt(match[1], 10);
        if (d >= 1) duration = `${d} Day${d !== 1 ? "s" : ""}`;
      }
    }

    // Determine travel_date (use start_date if available)
    const travelDate = extractedData.start_date || null;

    // Build confirmation message
    let confirmation = "Great! I've got this so far:\n";
    if (extractedData.destination)
      confirmation += `\n• *Destination:* ${extractedData.destination}`;
    if (duration) confirmation += `\n• *Duration:* ${duration}`;
    if (travelDate) {
      const dateObj = new Date(travelDate);
      confirmation += `\n• *Travel Date:* ${dateObj.toLocaleDateString(
        "en-GB",
        { day: "numeric", month: "long", year: "numeric" },
      )}`;
    }
    if (extractedData.adults)
      confirmation += `\n• *Adults:* ${extractedData.adults}`;
    if (extractedData.children)
      confirmation += `\n• *Children:* ${extractedData.children}`;
    if (extractedData.notes)
      confirmation += `\n• *Notes:* ${extractedData.notes}`;
    confirmation += "\n\nIs this correct?";

    // Prepare service_data with all extracted information
    const serviceData = {
      destination: extractedData.destination,
      duration: duration,
      adults: String(extractedData.adults || 1),
      children: String(extractedData.children || 0),
      notes: extractedData.notes,
    };

    // Add dates if available
    if (travelDate) {
      serviceData.travel_date = travelDate;
      // Don't ask for travel_timeframe if we have specific dates
      serviceData.travel_timeframe = null;
    }
    if (extractedData.end_date) {
      serviceData.return_date = extractedData.end_date;
    }

    // Automatically add Air Ticket service if airfare is mentioned
    if (extractedData.needs_airfare) {
      serviceData.include_flights = "yes";
      console.log(
        "[BOT] ✈️ Airfare detected - will automatically include Air Ticket service",
      );
    }

    // Automatically add Visa service if visa is mentioned
    if (extractedData.needs_visa) {
      serviceData.include_visa = "yes";
      console.log(
        "[BOT] 🛂 Visa detected - will automatically include Visa service",
      );
    }

    // Skip continent question if destination is known
    if (extractedData.destination) {
      // Try to determine continent from destination (basic check)
      const destLower = extractedData.destination.toLowerCase();
      if (
        destLower.includes("phuket") ||
        destLower.includes("thailand") ||
        destLower.includes("singapore") ||
        destLower.includes("malaysia") ||
        destLower.includes("dubai") ||
        destLower.includes("uae")
      ) {
        serviceData.continent = "asia";
      }
      // Mark that we have destination so continent question will be skipped
      serviceData.destination_known = true;
    }

    // Update session with extracted data
    await updateUserSession(from, {
      stage: "awaiting_ai_confirmation",
      service_required: "🧳 Tour Package", // Assume tour package for complex queries
      service_data: serviceData,
      conversation_summary: messageText,
    });

    await sendQuickReply(from, confirmation, [
      { id: "ai_confirm_yes", title: "Yes, that's right!" },
      { id: "ai_confirm_no", title: "No, let's correct it" },
    ]);
  } catch (e) {
    console.error("[BOT] ❌ AI Extraction or JSON parsing failed:", e);
    await sendText(
      from,
      "I had a little trouble understanding all the details. Let's try step-by-step. What service are you interested in?",
    );
    await sendOptionsList(from, "Select a service:", SERVICES_LIST, "Choose");
    await updateUserSession(from, {
      stage: "selecting_service",
      flow_type: "structured",
    });
  }
}

async function handleStructuredTextMessage(from, user, messageText) {
  const lc = messageText.trim().toLowerCase();
  let serviceData = user.service_data || {};
  let questions = user.question_queue || [];

  // ========================= GREETING / RESTART =========================
  // If the user sends a greeting OR if their previous conversation was completed, start a new flow.
  if (
    /^(hi|hello|hey|namaste|start|menu)$/i.test(lc) ||
    user.stage === "completed"
  ) {
    console.log(
      "[BOT] 👋 Greeting or new conversation detected - Starting fresh flow",
    );
    const customer = await getCustomerByPhone(from);

    if (customer && customer.first_name) {
      await sendText(
        from,
        `Greetings, ${customer.first_name}!\n\nWelcome back to Madura Travel Service! 👋\n\nSelect a service below 👇`,
      );
      await sendOptionsList(from, "Choose a service:", SERVICES_LIST, "Choose");

      await updateUserSession(from, {
        stage: "selecting_service",
        name: customer.first_name,
        email: customer.email || null,
        service_required: null,
        service_data: {},
        question_queue: [],
        flow_type: "structured",
      });
    } else {
      // Even if we have a name in the session, re-confirm it for a new lead.
      await sendText(
        from,
        "Hello! 👋\nWelcome to Madura Travel Service!\n\nMay I have your full name, please?",
      );
      await updateUserSession(from, {
        stage: "collecting_name",
        service_required: null,
        service_data: {},
        question_queue: [],
        name: null,
        email: null,
        flow_type: "structured",
      });
    }
    return;
  }

  // ========================= COLLECTING NAME =========================
  if (user.stage === "collecting_name" && messageText) {
    console.log(`[BOT] 📝 Name collected: ${messageText}`);

    await updateUserSession(from, {
      name: messageText,
      stage: "selecting_service",
    });
    await sendText(
      from,
      `Thank you, ${messageText}! 😊\n\nPlease choose what you'd like help with today 👇`,
    );
    await sendOptionsList(
      from,
      "Select a service:",
      SERVICES_LIST,
      "Choose Service",
    );
    return;
  }

  // ========================= COLLECTING SERVICE DATA (TEXT) =========================
  if (user.stage === "collecting_service_data") {
    if (questions.length === 0) {
      console.log("[BOT] ⚠️ Question queue is empty. Resetting.");
      await sendText(
        from,
        "Something went wrong. Let's start over. Type *hi* to begin.",
      );
      await updateUserSession(from, {
        stage: "collecting_name",
        question_queue: [],
        service_data: {},
      });
      return;
    }

    const currentQuestion = questions[0];

    // Handle text input for a question that was expecting a list (i.e., user chose "Other")
    if (serviceData?.awaiting_other_text) {
      console.log(
        `[BOT] 📝 Capturing text for 'other' option for key: ${
          currentQuestion.key || serviceData.awaiting_sub_destination
        }`,
      );

      // If we're in sub-destination flow (Europe), store in the sub-destination key
      if (serviceData.awaiting_sub_destination) {
        serviceData[serviceData.awaiting_sub_destination] = messageText;
        delete serviceData.awaiting_sub_destination;
        // Move to next question (destination question is done)
        const remainingQuestions = questions.slice(1);
        serviceData.awaiting_other_text = false;

        if (remainingQuestions.length > 0) {
          await updateUserSession(from, {
            service_data: serviceData,
            question_queue: remainingQuestions,
          });
          await sendQuestion(from, remainingQuestions[0]);
        } else {
          // All questions completed
          await sendText(
            from,
            "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
          );
          const updatedUser = { ...user, service_data: serviceData };
          const leadResult = await submitLead(updatedUser);
          if (leadResult.success) {
            await updateUserSession(from, {
              stage: "completed",
              service_data: {},
              question_queue: [],
            });
          } else {
            await sendText(
              from,
              "Sorry, there was an issue creating your enquiry. Please try again later.",
            );
          }
        }
        return;
      }

      // Regular "other" text input
      serviceData[currentQuestion.key] = messageText;
      serviceData.awaiting_other_text = false; // Clear the flag
      const remainingQuestions = questions.slice(1);

      const updatedUser = {
        ...user,
        service_data: serviceData,
        question_queue: remainingQuestions,
      };
      await updateUserSession(from, {
        service_data: serviceData,
        question_queue: remainingQuestions,
      });

      if (remainingQuestions.length > 0) {
        await sendQuestion(from, remainingQuestions[0]);
      } else {
        console.log("[BOT] ✅ All questions completed. Submitting lead.");
        await sendText(
          from,
          "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
        );
        const leadResult = await submitLead(updatedUser);
        if (leadResult.success) {
          await updateUserSession(from, {
            stage: "completed",
            service_data: {},
            question_queue: [],
          });
        } else {
          await sendText(
            from,
            "Sorry, there was an issue creating your enquiry. Please try again later.",
          );
        }
      }
      return;
    }

    if (currentQuestion.type !== "text") {
      await sendText(
        from,
        "🤔 I was expecting a selection from the list. Please choose one of the options.",
      );
      await sendQuestion(from, currentQuestion);
      return;
    }

    console.log(`[BOT] 🔍 Validating text answer for: ${currentQuestion.key}`);
    const validationResponse = await geminiAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            { text: validationPrompt(currentQuestion.prompt, messageText) },
          ],
        },
      ],
      config: { responseMimeType: "application/json" },
    });

    try {
      const validationResult = JSON.parse(validationResponse.text.trim());
      console.log("[BOT] 🧠 AI Validation Result:", validationResult);

      if (validationResult.status === "VALID") {
        serviceData[currentQuestion.key] = validationResult.answer;
        console.log(
          `[BOT] 📝 Saving validated answer for ${currentQuestion.key}: ${validationResult.answer}`,
        );

        const remainingQuestions = questions.slice(1);

        if (remainingQuestions.length > 0) {
          await updateUserSession(from, {
            service_data: serviceData,
            question_queue: remainingQuestions,
          });
          await sendQuestion(from, remainingQuestions[0]);
        } else {
          console.log("[BOT] ✅ All questions completed. Submitting lead.");
          await sendText(
            from,
            "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
          );
          const updatedUser = { ...user, service_data: serviceData };
          const leadResult = await submitLead(updatedUser);
          if (leadResult.success) {
            await updateUserSession(from, {
              stage: "completed",
              service_data: {},
              question_queue: [],
            });
          } else {
            await sendText(
              from,
              "Sorry, there was an issue creating your enquiry. Please try again later.",
            );
          }
        }
      } else {
        // INVALID or QUESTION
        await sendText(
          from,
          `I didn't quite get that. Let's try again.\n\n${currentQuestion.prompt}`,
        );
      }
    } catch (e) {
      console.error("[BOT] ❌ AI Validation or JSON parsing failed:", e);
      // Fallback to old behavior if validation fails
      serviceData[currentQuestion.key] = messageText;
      const remainingQuestions = questions.slice(1);
      await updateUserSession(from, {
        service_data: serviceData,
        question_queue: remainingQuestions,
      });
      if (remainingQuestions.length > 0) {
        await sendQuestion(from, remainingQuestions[0]);
      } else {
        console.log(
          "[BOT] ✅ All questions completed (validation failed). Submitting lead.",
        );
        await sendText(
          from,
          "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
        );
        const updatedUser = { ...user, service_data: serviceData };
        await submitLead(updatedUser);
        await updateUserSession(from, {
          stage: "completed",
          service_data: {},
          question_queue: [],
        });
      }
    }
    return;
  }

  // ========================= DEFAULT FALLBACK =========================
  if (user.stage !== "completed") {
    console.log("[BOT] ⚠️ Unhandled message or stage in structured flow.");
    await sendText(
      from,
      "🤔 I didn't understand that.\n\nType *hi* to start a new enquiry.",
    );
  }
}

// -------------------------
// MAIN WEBHOOK RECEIVER
// -------------------------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Respond immediately

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Check for status updates (message status changes)
    const statuses = value?.statuses;
    if (statuses && statuses.length > 0) {
      const status = statuses[0];
      const messageId = status.id;
      const statusType = status.status; // sent, delivered, read, failed
      const recipientId = status.recipient_id;

      // Log failed messages with details
      if (statusType === "failed") {
        const errorCode = status.errors?.[0]?.code;
        const errorTitle = status.errors?.[0]?.title;
        const errorDetails = status.errors?.[0]?.details;

        console.error(`[BOT] ❌ Message FAILED: ${messageId}`);
        console.error(`[BOT] Error Code: ${errorCode}, Title: ${errorTitle}`);
        console.error(`[BOT] Error Details: ${JSON.stringify(errorDetails)}`);
        console.error(`[BOT] Recipient: ${recipientId}`);

        // Update message status in database to "failed" with error details
        try {
          const updateData = { status: "failed" };
          // Try to add error_code and error_title if columns exist (they might not)
          // We'll update status first, then try to add error details
          const { error: updateError } = await supabase
            .from("whatsapp_messages")
            .update(updateData)
            .eq("message_id", messageId);

          if (updateError) {
            console.warn(
              `[BOT] Failed to update message status to failed:`,
              updateError.message,
            );
          } else {
            // Message status updated to failed (silent)
            // Try to update error details (columns might not exist, so we'll ignore errors)
            if (errorCode || errorTitle) {
              try {
                await supabase
                  .from("whatsapp_messages")
                  .update({
                    error_code: errorCode,
                    error_title: errorTitle,
                  })
                  .eq("message_id", messageId);
              } catch (err) {
                // Ignore if columns don't exist
                console.warn(
                  `[BOT] Could not update error details (columns may not exist):`,
                  err.message,
                );
              }
            }
          }
        } catch (err) {
          console.warn(`[BOT] Error updating message status:`, err.message);
        }

        // For error 131047 (Re-engagement message), log a helpful message
        if (errorCode === 131047) {
          console.warn(
            `[BOT] ⚠️ Re-engagement required for ${recipientId}. Customer needs to send a message first, or use a template message.`,
          );
        }

        // Try to find the lead associated with this message and log the failure
        if (handleWhatsAppMessageFailure) {
          await handleWhatsAppMessageFailure(
            messageId,
            errorCode,
            errorTitle,
            recipientId,
          );
        }
      } else if (statusType === "delivered") {
        // Update message status in database (silent)
        try {
          await supabase
            .from("whatsapp_messages")
            .update({ status: "delivered" })
            .eq("message_id", messageId);
        } catch (err) {
          // Silent fail
        }
      } else if (statusType === "read") {
        // Update message status in database (silent)
        try {
          await supabase
            .from("whatsapp_messages")
            .update({ status: "read" })
            .eq("message_id", messageId);
        } catch (err) {
          // Silent fail
        }
      }

      return; // Don't process as a regular message
    }

    const message = value?.messages?.[0];
    if (!message) {
      console.log(
        "[BOT] ⚠️ No message found in payload (likely a status update or other event).",
      );
      return;
    }

    // Detect branch from phone number ID that received the message
    const metadata = value?.metadata;
    const receivingPhoneNumberId = metadata?.phone_number_id;
    const branchConfig = getBranchConfigFromPhoneNumberId(
      receivingPhoneNumberId,
    );
    const branchId = branchConfig.branchId;

    const from = message.from;
    const messageId = message.id;
    const msgType = message.type || "unknown";
    const ts = new Date().toISOString();
    console.log(
      `[BOT] in from=+${from} type=${msgType} branch=${branchId} at ${ts}`,
    );

    // Store incoming message in database
    const normalizedPhone = `+${from}`;
    const messageText = message.text?.body || "";
    const messageType = message.type; // text, image, document, etc.

    // (Message body only logged in debug mode to reduce noise)

    // Check for template button clicks (type: "button") - these come from WhatsApp templates
    const buttonMessage = message.button;
    if (message.type === "button" && buttonMessage) {
      console.log(
        `[BOT] 🔘 Template button click detected! Payload: "${buttonMessage.payload}", Text: "${buttonMessage.text}"`,
      );

      // Normalize button payload/text for comparison
      const buttonPayload = (buttonMessage.payload || buttonMessage.text || "")
        .toLowerCase()
        .trim();
      const buttonText = (buttonMessage.text || "").toLowerCase().trim();

      // Handle "Confirm Enquiry" button
      if (
        (buttonPayload.includes("confirm") &&
          buttonPayload.includes("enquiry")) ||
        (buttonText.includes("confirm") && buttonText.includes("enquiry"))
      ) {
        console.log(`[BOT] ✅ Processing "Confirm Enquiry" button click`);

        let leadId = null;

        // Try to get lead ID from message ID cache (stored when template was sent)
        // The context.id contains the message ID of the template we sent
        const templateMessageId = message.context?.id;
        if (templateMessageId && messageIdToLeadCache) {
          console.log(
            `[BOT] 🔍 Template message ID from context: ${templateMessageId}`,
          );
          const cached = messageIdToLeadCache.get(templateMessageId);
          if (cached && cached.leadId) {
            leadId = cached.leadId;
            console.log(`[BOT] ✅ Found lead ID ${leadId} from message cache`);
          } else {
            console.log(
              `[BOT] ⚠️ No cached lead mapping found for message ID ${templateMessageId}`,
            );
          }
        }

        // Fallback: Find most recent lead for this customer if we couldn't extract from template
        if (!leadId) {
          console.log(
            `[BOT] 🔄 Fallback: Finding most recent lead for customer`,
          );
          const customer = await getCustomerByPhone(from);
          if (!customer) {
            console.error(`[BOT] ❌ Could not find customer for phone ${from}`);
            await sendText(
              from,
              "Sorry, I couldn't find your enquiry. Please contact us directly.",
            );
            return;
          }

          const { data: recentLead, error: leadError } = await supabase
            .from("leads")
            .select("id")
            .eq("customer_id", customer.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (leadError) {
            console.error(
              `[BOT] ❌ Error finding lead for customer ${customer.id}:`,
              leadError?.message,
            );
            await sendText(
              from,
              "Sorry, I couldn't find your enquiry. Please contact us directly.",
            );
            return;
          }

          if (!recentLead) {
            console.error(`[BOT] ❌ No lead found for customer ${customer.id}`);
            await sendText(
              from,
              "Sorry, I couldn't find your enquiry. Please contact us directly.",
            );
            return;
          }

          leadId = recentLead.id;
          console.log(
            `[BOT] ✅ Found lead ${leadId} for customer ${customer.id}`,
          );
        }

        // DISABLED: Status change and itinerary generation - only log activity
        // Fetch lead to log activity
        const { data: lead, error: leadError } = await supabase
          .from("leads")
          .select("id")
          .eq("id", leadId)
          .single();

        if (leadError || !lead) {
          console.error(
            `[BOT] ❌ Error fetching lead ${leadId}:`,
            leadError?.message,
          );
          await sendText(
            from,
            "Sorry, there was a problem confirming your enquiry. Please try again.",
          );
        } else {
          // Only log activity that customer confirmed via WhatsApp
          await logLeadActivity(
            leadId,
            "Customer Confirmed",
            "Customer confirmed the enquiry via WhatsApp button.",
            "Customer",
          );

          console.log(
            `[BOT] ✅ Customer confirmed enquiry for lead ${leadId}. Activity logged.`,
          );

          await sendText(
            from,
            "Thank you for confirming! Your Travel Consultant will review the details and get in touch with you shortly. ✨",
          );
        }
        return;
      }

      // Handle "Talk to Agent" button
      if (
        (buttonPayload.includes("talk") && buttonPayload.includes("agent")) ||
        (buttonPayload.includes("request") &&
          buttonPayload.includes("agent")) ||
        (buttonText.includes("talk") && buttonText.includes("agent"))
      ) {
        console.log(`[BOT] ✅ Processing "Talk to Agent" button click`);

        let leadId = null;
        let staffId = null;
        let customerId = null;

        // Try to get lead ID and customer ID from message ID cache (stored when template was sent)
        const templateMessageId = message.context?.id;
        if (templateMessageId && messageIdToLeadCache) {
          console.log(
            `[BOT] 🔍 Template message ID from context: ${templateMessageId}`,
          );
          const cached = messageIdToLeadCache.get(templateMessageId);
          if (cached) {
            if (cached.leadId) {
              leadId = cached.leadId;
              console.log(
                `[BOT] ✅ Found lead ID ${leadId} from message cache`,
              );
            }
            if (cached.customerId) {
              customerId = cached.customerId;
              console.log(
                `[BOT] ✅ Found customer ID ${customerId} from message cache`,
              );
            }
          } else {
            console.log(
              `[BOT] ⚠️ No cached lead mapping found for message ID ${templateMessageId}`,
            );
          }
        }

        // Fallback: Find most recent lead for this customer if we couldn't extract from template
        if (!leadId) {
          console.log(
            `[BOT] 🔄 Fallback: Finding most recent lead for customer`,
          );
          const customer = await getCustomerByPhone(from);
          if (!customer) {
            console.error(`[BOT] ❌ Could not find customer for phone ${from}`);
            await sendText(
              from,
              "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
            );
            return;
          }

          if (!customerId) {
            customerId = customer.id;
          }

          const { data: recentLead, error: leadError } = await supabase
            .from("leads")
            .select("id, all_assignees:lead_assignees(staff(id))")
            .eq("customer_id", customer.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (leadError) {
            console.error(
              `[BOT] ❌ Error finding lead for customer ${customer.id}:`,
              leadError?.message,
            );
            await sendText(
              from,
              "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
            );
            return;
          }

          if (!recentLead) {
            console.error(`[BOT] ❌ No lead found for customer ${customer.id}`);
            await sendText(
              from,
              "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
            );
            return;
          }

          leadId = recentLead.id;

          // Get the first assigned staff (primary assignee)
          if (recentLead.all_assignees && recentLead.all_assignees.length > 0) {
            staffId = recentLead.all_assignees[0].staff?.id;
            console.log(
              `[BOT] ✅ Found lead ${leadId} with staff ${staffId} for customer ${customer.id}`,
            );
          }
        } else {
          // If we have leadId from template, fetch the lead with staff info
          const { data: leadData, error: leadFetchError } = await supabase
            .from("leads")
            .select("id, all_assignees:lead_assignees(staff(id))")
            .eq("id", leadId)
            .maybeSingle();

          if (!leadFetchError && leadData) {
            if (leadData.all_assignees && leadData.all_assignees.length > 0) {
              staffId = leadData.all_assignees[0].staff?.id;
              console.log(`[BOT] ✅ Found staff ${staffId} for lead ${leadId}`);
            }
          }
        }

        if (!leadId) {
          console.error(`[BOT] ❌ Could not determine lead ID`);
          await sendText(
            from,
            "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
          );
          return;
        }

        if (!staffId) {
          console.error(`[BOT] ❌ No staff assigned to lead ${leadId}`);
          await sendText(
            from,
            "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
          );
          return;
        }

        // Fallback: Get customer ID from database if not in cache
        if (!customerId) {
          const customer = await getCustomerByPhone(from);
          customerId = customer?.id;
        }

        const { data: staff, error: staffError } = await supabase
          .from("staff")
          .select("phone, name")
          .eq("id", staffId)
          .single();
        const { data: lead, error: leadFetchError } = await supabase
          .from("leads")
          .select("customer:customers(first_name)")
          .eq("id", leadId)
          .single();

        if (staffError || leadFetchError || !staff || !lead || !lead.customer) {
          console.error(
            `[BOT] ❌ Error fetching details for agent contact request:`,
            staffError?.message || leadFetchError?.message,
          );
          await sendText(
            from,
            "Sorry, I couldn't process your request right now. Your agent will still be in touch.",
          );
        } else {
          const sanitizedStaffPhone = sanitizePhoneNumber(staff.phone);

          if (sanitizedStaffPhone) {
            const alertMessage = `*‼️ Agent Contact Request ‼️*\n\nCustomer *${lead.customer.first_name}* for Lead ID *#${leadId}* has requested to talk to you directly.\n\nPlease contact them at your earliest convenience.`;
            await sendText(sanitizedStaffPhone, alertMessage);
          }

          // Ensure customerId is set (use lead's customer_id if still null)
          if (!customerId && lead.customer) {
            // Try to get customer ID from lead
            const { data: leadWithCustomer } = await supabase
              .from("leads")
              .select("customer_id")
              .eq("id", leadId)
              .single();
            customerId = leadWithCustomer?.customer_id || customerId;
          }

          // Format phone number: if it starts with +91, add space after +91, otherwise use default
          let consultantPhone = "+91 90929 49494"; // Default
          if (staff.phone) {
            const phoneStr = String(staff.phone).trim();
            if (phoneStr.startsWith("+91")) {
              consultantPhone = phoneStr.replace(/^(\+91)(\d+)/, "$1 $2");
            } else if (phoneStr.startsWith("91") && phoneStr.length >= 12) {
              consultantPhone = `+91 ${phoneStr.substring(2)}`;
            } else if (phoneStr.length === 10) {
              consultantPhone = `+91 ${phoneStr}`;
            } else {
              consultantPhone = phoneStr;
            }
          }

          // Send template message with customer name, consultant name, and phone
          const customerName = lead.customer.first_name || "Valued Customer";
          const templateSent = await sendConsultantTemplate(
            from,
            customerName,
            staff.name,
            consultantPhone,
          );

          // Fallback to plain text if template fails
          if (!templateSent) {
            const fallbackMessage = `Vanakkam, ${customerName}, I've notified your travel consultant.\n\nConsultant Details:\nName: *${staff.name}*\nPhone: *${consultantPhone}*\n\nThey will call you shortly!`;
            await sendText(from, fallbackMessage);
          }
        }
        return;
      }

      // If button doesn't match known handlers, log and return
      console.warn(
        `[BOT] ⚠️ Unhandled template button click. Payload: "${buttonMessage.payload}", Text: "${buttonMessage.text}"`,
      );
      return;
    }

    // Check for interactive messages (non-template button clicks) BEFORE processing text
    const interactive = message.interactive;
    if (interactive) {
      console.log(
        `[BOT] 🔘 Interactive message detected! Type: ${interactive.type}`,
      );
    }

    // Handle image messages
    let imageUrl = null;
    let fileUrl = null;
    let fileName = null;

    if (messageType === "image" && message.image) {
      imageUrl = message.image.id; // WhatsApp media ID
      // Note: To get the actual URL, you need to use the media API endpoint
      // For now, we'll store the media ID and fetch it when needed
      fileName = message.image.caption || "Image";
    } else if (messageType === "document" && message.document) {
      fileUrl = message.document.id; // WhatsApp media ID
      fileName =
        message.document.filename || message.document.caption || "Document";
    }

    // Store text or media message
    if (messageText || imageUrl || fileUrl) {
      try {
        // Try to find customer by phone to link the message
        const phoneWithSpace = normalizedPhone.replace(
          /^(\+\d{1,4})(\d+)/,
          "$1 $2",
        );
        const phoneWithoutSpace = normalizedPhone.replace(/\s/g, "");
        const { data: customer } = await supabase
          .from("customers")
          .select("id")
          .or(`phone.eq.${phoneWithSpace},phone.eq.${phoneWithoutSpace}`)
          .limit(1)
          .maybeSingle();

        const { error: storeError } = await supabase
          .from("whatsapp_messages")
          .insert({
            message_id: messageId,
            phone: normalizedPhone,
            customer_id: customer?.id || null,
            text:
              messageText ||
              (imageUrl ? `📷 ${fileName}` : fileUrl ? `📄 ${fileName}` : ""),
            direction: "incoming",
            staff_id: null,
            status: "delivered",
            image_url: imageUrl,
            file_url: fileUrl,
            file_name: fileName,
            created_at: new Date().toISOString(),
          });

        if (storeError) {
          // Check if it's a column/table error
          if (
            storeError.message &&
            storeError.message.includes("does not exist")
          ) {
            console.warn(
              `[BOT] Table/column error: ${storeError.message}. ` +
                `Please run the migration script: migrations/create_whatsapp_messages_table.sql`,
            );
          } else {
            console.warn(
              "[BOT] Failed to store incoming message:",
              storeError.message,
            );
          }
        }
      } catch (err) {
        console.warn("[BOT] Message storage skipped:", err.message);
      }
    }

    let user = await getUserSession(from);

    // Store branchId in user session if not already set (only if column exists)
    if (user && (!user.branch_id || user.branch_id !== branchId)) {
      try {
        await updateUserSession(from, { branch_id: branchId });
        user = { ...user, branch_id: branchId };
      } catch (branchIdError) {
        // branch_id column may not exist in whatsapp_sessions table
        // This is not critical, so we continue without it
        if (
          branchIdError.message?.includes("branch_id") ||
          branchIdError.message?.includes("column") ||
          branchIdError.message?.includes("schema cache")
        ) {
          console.log(
            "[BOT] ℹ️ branch_id column not available in whatsapp_sessions table. Continuing without it.",
          );
        } else {
          // Re-throw if it's a different error
          throw branchIdError;
        }
      }
    }
    if (!user) {
      console.log("[BOT] ⚠️ Failed to get/create session. Aborting.");
      return;
    }

    // User stage and flow type (logged only for debugging if needed)

    // First, check if AI is enabled globally
    const { data: aiSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "is_chatbot_ai_enabled")
      .single();
    const isAiEnabledGlobally =
      aiSetting?.value === true ||
      aiSetting?.value === "true" ||
      JSON.parse(aiSetting?.value || "false");

    // Check if automation is disabled for this specific customer
    let isAutomationDisabled = false;
    if (user?.customer_id) {
      const { data: customer } = await supabase
        .from("customers")
        .select(
          "whatsapp_automation_disabled, whatsapp_automation_disabled_until, last_staff_message_at",
        )
        .eq("id", user.customer_id)
        .single();

      if (customer) {
        isAutomationDisabled = customer.whatsapp_automation_disabled || false;

        // Check if automation was temporarily disabled and if the time has passed
        if (
          isAutomationDisabled &&
          customer.whatsapp_automation_disabled_until
        ) {
          if (
            new Date() > new Date(customer.whatsapp_automation_disabled_until)
          ) {
            // Time has passed, auto-enable automation
            console.log(
              `[BOT] ⏰ Automation re-enabled for customer ${user.customer_id} (inactivity timeout expired).`,
            );
            await supabase
              .from("customers")
              .update({
                whatsapp_automation_disabled: false,
                whatsapp_automation_disabled_until: null,
              })
              .eq("id", user.customer_id);
            isAutomationDisabled = false;
          }
        }

        // Check if automation should be auto-enabled (5 minutes after last staff message)
        if (!isAutomationDisabled && customer.last_staff_message_at) {
          const lastMessageTime = new Date(
            customer.last_staff_message_at,
          ).getTime();
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          if (lastMessageTime < fiveMinutesAgo) {
            // More than 5 minutes passed, ensure automation is enabled
            if (customer.whatsapp_automation_disabled) {
              await supabase
                .from("customers")
                .update({
                  whatsapp_automation_disabled: false,
                  whatsapp_automation_disabled_until: null,
                })
                .eq("id", user.customer_id);
            }
            isAutomationDisabled = false;
          }
        }
      }
    }

    const isAiEnabled = isAiEnabledGlobally && !isAutomationDisabled;
    const isAutomationEnabled = !isAutomationDisabled; // Automation includes both AI and structured flows

    // ================== CHECK IF AUTOMATION IS DISABLED ==================
    // If automation is disabled, skip ALL automated responses (AI, structured flow, welcome messages, etc.)
    if (isAutomationDisabled) {
      console.log(
        `[BOT] ⏸️ Automation is disabled for customer ${
          user?.customer_id || "unknown"
        }. Skipping all automated responses.`,
      );
      return; // Don't process any automated messages
    }

    // ================== 1. HANDLE INTERACTIVE REPLIES (BUTTONS, LISTS) FIRST ==================
    // IMPORTANT: Check interactive messages BEFORE text messages, as button clicks come as interactive type
    if (interactive) {
      console.log(`[BOT] 🔘 Interactive message received: ${interactive.type}`);
      const reply_id =
        interactive.button_reply?.id || interactive.list_reply?.id;

      // Log the full interactive payload for debugging
      console.log(
        `[BOT] 🔍 Full interactive payload:`,
        JSON.stringify(interactive, null, 2),
      );
      console.log(`[BOT] 🔍 Button reply ID received: "${reply_id}"`);

      // Normalize button ID for comparison (lowercase, trim whitespace)
      const normalizedReplyId = reply_id ? reply_id.toLowerCase().trim() : "";

      // Handle "Confirm Enquiry" button (both static template payload and dynamic payload)
      // Check for various possible button ID formats from template
      if (
        normalizedReplyId === "confirm_enquiry" ||
        normalizedReplyId === "confirmenquiry" ||
        normalizedReplyId === "confirm enquiry" ||
        normalizedReplyId.startsWith("confirm_enquiry_") ||
        (normalizedReplyId.includes("confirm") &&
          normalizedReplyId.includes("enquiry"))
      ) {
        let leadId = null;

        // If dynamic payload (from interactive message), extract leadId
        if (reply_id && reply_id.startsWith("confirm_enquiry_")) {
          leadId = reply_id.split("_")[2];
        } else {
          // Static payload from template - find most recent lead for this customer
          const customer = await getCustomerByPhone(from);
          if (customer) {
            const { data: recentLead, error: leadError } = await supabase
              .from("leads")
              .select("id")
              .eq("customer_id", customer.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            if (!leadError && recentLead) {
              leadId = recentLead.id;
              console.log(
                `[BOT] Found most recent lead ${leadId} for customer ${customer.id}`,
              );
            }
          }
        }

        if (!leadId) {
          console.error(
            `[BOT] ❌ Could not determine lead ID for confirm enquiry`,
          );
          await sendText(
            from,
            "Sorry, I couldn't find your enquiry. Please contact us directly.",
          );
          return;
        }

        console.log(`[BOT] ✅ User confirmed enquiry for lead ID: ${leadId}`);

        // DISABLED: Status change - only log activity
        const { data: lead, error } = await supabase
          .from("leads")
          .select("id")
          .eq("id", leadId)
          .single();

        if (error || !lead) {
          console.error(
            `[BOT] ❌ Error fetching lead ${leadId}:`,
            error?.message,
          );
          await sendText(
            from,
            "Sorry, there was a problem confirming your enquiry. Please try again.",
          );
        } else {
          // Only log activity that customer confirmed via WhatsApp
          await logLeadActivity(
            leadId,
            "Customer Confirmed",
            "Customer confirmed the enquiry via WhatsApp button.",
            "Customer",
          );

          console.log(
            `[BOT] ✅ Customer confirmed enquiry for lead ${leadId}. Activity logged.`,
          );

          await sendText(
            from,
            "Thank you for confirming! Your Travel Consultant will review the details and get in touch with you shortly. ✨",
          );
        }
        return;
      }

      // Handle "Talk to Agent" button (both static template payload and dynamic payload)
      // Check for various possible button ID formats from template
      if (
        normalizedReplyId === "request_agent_contact" ||
        normalizedReplyId === "requestagentcontact" ||
        normalizedReplyId === "request agent contact" ||
        normalizedReplyId === "talk_to_agent" ||
        normalizedReplyId === "talktoagent" ||
        normalizedReplyId === "talk to agent" ||
        normalizedReplyId.startsWith("request_agent_contact_") ||
        (normalizedReplyId.includes("talk") &&
          normalizedReplyId.includes("agent")) ||
        (normalizedReplyId.includes("request") &&
          normalizedReplyId.includes("agent"))
      ) {
        let leadId = null;
        let staffId = null;

        // If dynamic payload (from interactive message), extract leadId and staffId
        if (reply_id && reply_id.startsWith("request_agent_contact_")) {
          const parts = reply_id.split("_");
          leadId = parts[3];
          staffId = parts[4];
        } else {
          // Static payload from template - find most recent lead and assigned staff
          const customer = await getCustomerByPhone(from);
          if (customer) {
            const { data: recentLead, error: leadError } = await supabase
              .from("leads")
              .select("id, all_assignees:lead_assignees(staff(id))")
              .eq("customer_id", customer.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            if (!leadError && recentLead) {
              leadId = recentLead.id;
              // Get the first assigned staff (primary assignee)
              if (
                recentLead.all_assignees &&
                recentLead.all_assignees.length > 0
              ) {
                staffId = recentLead.all_assignees[0].staff?.id;
                console.log(
                  `[BOT] Found most recent lead ${leadId} with staff ${staffId} for customer ${customer.id}`,
                );
              }
            }
          }
        }

        const customerId =
          user.customer_id || (await getCustomerByPhone(from))?.id;

        if (!leadId || !staffId) {
          console.error(
            `[BOT] ❌ Could not determine lead ID or staff ID for agent contact`,
          );
          await sendText(
            from,
            "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
          );
          return;
        }

        console.log(
          `[BOT] 🗣️ User requested agent contact for lead ${leadId}, staff ${staffId}`,
        );

        const { data: staff, error: staffError } = await supabase
          .from("staff")
          .select("phone, name")
          .eq("id", staffId)
          .single();
        const { data: lead, error: leadError } = await supabase
          .from("leads")
          .select("customer:customers(first_name)")
          .eq("id", leadId)
          .single();

        if (staffError || leadError || !staff || !lead || !lead.customer) {
          console.error(
            `[BOT] ❌ Error fetching details for agent contact request.`,
          );
          await sendText(
            from,
            "Sorry, I couldn't process your request right now. Your agent will still be in touch.",
          );
        } else {
          const sanitizedStaffPhone = sanitizePhoneNumber(staff.phone);

          if (sanitizedStaffPhone) {
            const alertMessage = `*‼️ Agent Contact Request ‼️*\n\nCustomer *${lead.customer.first_name}* for Lead ID *#${leadId}* has requested to talk to you directly.\n\nPlease contact them at your earliest convenience.`;
            await sendText(sanitizedStaffPhone, alertMessage);
          }

          // Format phone number: if it starts with +91, add space after +91, otherwise use default
          let consultantPhone = "+91 90929 49494"; // Default
          if (staff.phone) {
            const phoneStr = String(staff.phone).trim();
            if (phoneStr.startsWith("+91")) {
              consultantPhone = phoneStr.replace(/^(\+91)(\d+)/, "$1 $2");
            } else if (phoneStr.startsWith("91") && phoneStr.length >= 12) {
              consultantPhone = `+91 ${phoneStr.substring(2)}`;
            } else if (phoneStr.length === 10) {
              consultantPhone = `+91 ${phoneStr}`;
            } else {
              consultantPhone = phoneStr;
            }
          }

          // Send template message with customer name, consultant name, and phone
          const customerName = lead.customer.first_name || "Valued Customer";
          const templateSent = await sendConsultantTemplate(
            from,
            customerName,
            staff.name,
            consultantPhone,
          );

          // Fallback to plain text if template fails
          if (!templateSent) {
            const fallbackMessage = `Vanakkam, ${customerName}, I've notified your travel consultant.\n\nConsultant Details:\nName: *${staff.name}*\nPhone: *${consultantPhone}*\n\nThey will call you shortly!`;
            await sendText(from, fallbackMessage);
          }
        }
        return;
      }

      // Handle list_reply messages (service selection, questions, etc.)
      // These should be processed by the structured flow handlers below
      // Skip button_reply fallback logic for list_reply
      if (interactive.type === "list_reply" && reply_id) {
        // Continue to structured flow handlers below - don't process as button_reply
      } else if (interactive.type === "button_reply") {
        // Log unhandled button clicks for debugging (only for button_reply)
        console.warn(
          `[BOT] ⚠️ Unhandled button click with ID: "${reply_id}" (normalized: "${normalizedReplyId}")`,
        );
        console.warn(
          `[BOT] ⚠️ Full button_reply object:`,
          JSON.stringify(interactive.button_reply, null, 2),
        );

        // Try to handle as "Confirm Enquiry" or "Talk to Agent" based on button title if ID doesn't match
        const buttonTitle =
          interactive.button_reply?.title?.toLowerCase() || "";
        if (
          buttonTitle.includes("confirm") ||
          buttonTitle.includes("enquiry")
        ) {
          console.log(
            `[BOT] 🔄 Attempting to handle as "Confirm Enquiry" based on button title: "${interactive.button_reply?.title}"`,
          );
          // Fall through to confirm enquiry handler logic
          let leadId = null;
          const customer = await getCustomerByPhone(from);
          if (customer) {
            const { data: recentLead, error: leadError } = await supabase
              .from("leads")
              .select("id")
              .eq("customer_id", customer.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            if (!leadError && recentLead) {
              leadId = recentLead.id;
              console.log(
                `[BOT] Found most recent lead ${leadId} for customer ${customer.id}`,
              );
            }
          }

          if (!leadId) {
            console.error(
              `[BOT] ❌ Could not determine lead ID for confirm enquiry`,
            );
            await sendText(
              from,
              "Sorry, I couldn't find your enquiry. Please contact us directly.",
            );
            return;
          }

          console.log(`[BOT] ✅ User confirmed enquiry for lead ID: ${leadId}`);

          const { data: updatedLead, error } = await supabase
            .from("leads")
            .update({ status: "Confirmed" })
            .eq("id", leadId)
            .select()
            .single();

          if (error || !updatedLead) {
            console.error(
              `[BOT] ❌ Error updating lead status to Confirmed:`,
              error?.message,
            );
            await sendText(
              from,
              "Sorry, there was a problem confirming your enquiry. Please try again.",
            );
          } else {
            await sendText(
              from,
              "Thank you for confirming! Your Travel Consultant will review the details and get in touch with you shortly. ✨",
            );
          }
          return;
        } else if (
          buttonTitle &&
          (buttonTitle.includes("talk") || buttonTitle.includes("agent"))
        ) {
          console.log(
            `[BOT] 🔄 Attempting to handle as "Talk to Agent" based on button title: "${interactive.button_reply?.title}"`,
          );
          // Fall through to talk to agent handler logic
          let leadId = null;
          let staffId = null;
          const customer = await getCustomerByPhone(from);
          if (customer) {
            const { data: recentLead, error: leadError } = await supabase
              .from("leads")
              .select("id, all_assignees:lead_assignees(staff(id))")
              .eq("customer_id", customer.id)
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            if (!leadError && recentLead) {
              leadId = recentLead.id;
              if (
                recentLead.all_assignees &&
                recentLead.all_assignees.length > 0
              ) {
                staffId = recentLead.all_assignees[0].staff?.id;
                console.log(
                  `[BOT] Found most recent lead ${leadId} with staff ${staffId} for customer ${customer.id}`,
                );
              }
            }
          }

          const customerId =
            user.customer_id || (await getCustomerByPhone(from))?.id;

          if (!leadId || !staffId) {
            console.error(
              `[BOT] ❌ Could not determine lead ID or staff ID for agent contact`,
            );
            await sendText(
              from,
              "Sorry, I couldn't find your assigned consultant. Please contact us directly.",
            );
            return;
          }

          console.log(
            `[BOT] 🗣️ User requested agent contact for lead ${leadId}, staff ${staffId}`,
          );

          const { data: staff, error: staffError } = await supabase
            .from("staff")
            .select("phone, name")
            .eq("id", staffId)
            .single();
          const { data: lead, error: leadError } = await supabase
            .from("leads")
            .select("customer:customers(first_name)")
            .eq("id", leadId)
            .single();

          if (staffError || leadError || !staff || !lead || !lead.customer) {
            console.error(
              `[BOT] ❌ Error fetching details for agent contact request.`,
            );
            await sendText(
              from,
              "Sorry, I couldn't process your request right now. Your agent will still be in touch.",
            );
          } else {
            const sanitizedStaffPhone = sanitizePhoneNumber(staff.phone);

            if (sanitizedStaffPhone) {
              const alertMessage = `*‼️ Agent Contact Request ‼️*\n\nCustomer *${lead.customer.first_name}* for Lead ID *#${leadId}* has requested to talk to you directly.\n\nPlease contact them at your earliest convenience.`;
              await sendText(sanitizedStaffPhone, alertMessage);
            }

            // Format phone number: if it starts with +91, add space after +91, otherwise use default
            let consultantPhone = "+91 90929 49494"; // Default
            if (staff.phone) {
              const phoneStr = String(staff.phone).trim();
              if (phoneStr.startsWith("+91")) {
                consultantPhone = phoneStr.replace(/^(\+91)(\d+)/, "$1 $2");
              } else if (phoneStr.startsWith("91") && phoneStr.length >= 12) {
                consultantPhone = `+91 ${phoneStr.substring(2)}`;
              } else if (phoneStr.length === 10) {
                consultantPhone = `+91 ${phoneStr}`;
              } else {
                consultantPhone = phoneStr;
              }
            }

            // Send template message with customer name, consultant name, and phone
            const customerName = lead.customer.first_name || "Valued Customer";
            const templateSent = await sendConsultantTemplate(
              from,
              customerName,
              staff.name,
              consultantPhone,
            );

            // Fallback to plain text if template fails
            if (!templateSent) {
              const fallbackMessage = `Vanakkam, ${customerName}, I've notified your travel consultant.\n\nConsultant Details:\nName: *${staff.name}*\nPhone: *${consultantPhone}*\n\nThey will call you shortly!`;
              await sendText(from, fallbackMessage);
            }
          }
          return;
        }
      }

      // AI Confirmation Flow
      if (normalizedReplyId === "ai_confirm_yes") {
        console.log(
          "[BOT] ✅ User confirmed AI data. Asking remaining questions.",
        );

        // Don't create lead here - wait until all questions are completed
        // This prevents duplicate lead creation (once on confirmation, once on completion)
        await askNextQuestion(from, user);
        return;
      }
      if (normalizedReplyId === "ai_confirm_no") {
        console.log(
          "[BOT] ❌ User rejected AI data. Switching to structured flow.",
        );
        await sendText(
          from,
          "My apologies! Let's get it right step-by-step. What service can I help you with?",
        );
        await sendOptionsList(
          from,
          "Select a service:",
          SERVICES_LIST,
          "Choose",
        );
        await updateUserSession(from, {
          stage: "selecting_service",
          flow_type: "structured",
          service_data: {},
        }); // Clear service_data
        return;
      }

      // Structured Flow
      if (user.stage === "selecting_service") {
        const service =
          SERVICES_LIST.find(
            (s) => s.id === normalizedReplyId || s.id === reply_id,
          )?.title || reply_id;
        console.log(`[BOT] 📝 Service selected: ${service}`);
        // REFACTORED: Pass empty object initially, or null continent if that's simpler
        const questions = getServiceQuestions(reply_id, {});
        await updateUserSession(from, {
          service_required: service,
          question_queue: questions,
          stage: "collecting_service_data",
        });
        await sendQuestion(from, questions[0]);
        return;
      }

      if (user.stage === "collecting_service_data") {
        let serviceData = user.service_data || {};
        let questions = user.question_queue || [];
        const currentQuestion = questions[0];

        if (normalizedReplyId === "other" || reply_id === "other") {
          const keyLabel = currentQuestion.key.replace(/_/g, " ");
          await sendText(
            from,
            `Please type the ${keyLabel} you're looking for.`,
          );
          serviceData.awaiting_other_text = true;
          await updateUserSession(from, { service_data: serviceData });
          return;
        }

        // Handle expandable destinations for Tour Package (Europe sub-list only)
        if (currentQuestion.key === "destination" && reply_id === "europe") {
          // Store the continent selection
          serviceData.destination = reply_id;

          await sendOptionsList(
            from,
            "Choose a specific destination in Europe:",
            EUROPE_DESTINATIONS,
            "Choose",
          );

          // Update service data and keep the same question key but mark we're in sub-selection
          serviceData.awaiting_sub_destination = "europe_destination";
          await updateUserSession(from, { service_data: serviceData });
          return;
        }

        // Handle travel date selection (2-month periods)
        if (
          currentQuestion.key === "travel_date" &&
          (reply_id === "jan-feb" ||
            reply_id === "mar-apr" ||
            reply_id === "may-jun" ||
            reply_id === "jul-aug" ||
            reply_id === "sep-oct" ||
            reply_id === "nov-dec")
        ) {
          // Store the travel period
          serviceData.travel_date_period = reply_id;

          // Convert period to first month date
          const periodMonthMap = {
            "jan-feb": "january",
            "mar-apr": "march",
            "may-jun": "may",
            "jul-aug": "july",
            "sep-oct": "september",
            "nov-dec": "november",
          };

          const monthName = periodMonthMap[reply_id];
          const travelDate = convertMonthToDate(monthName);
          if (travelDate) {
            serviceData.travel_date = travelDate;
          }

          // Move to next question
          const remainingQuestions = questions.slice(1);
          if (remainingQuestions.length > 0) {
            await updateUserSession(from, {
              service_data: serviceData,
              question_queue: remainingQuestions,
            });
            await sendQuestion(from, remainingQuestions[0]);
          } else {
            // All questions completed
            await sendText(
              from,
              "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
            );
            const updatedUser = { ...user, service_data: serviceData };
            const leadResult = await submitLead(updatedUser);
            if (leadResult.success) {
              await updateUserSession(from, {
                stage: "completed",
                service_data: {},
                question_queue: [],
              });
            } else {
              await sendText(
                from,
                "Sorry, there was an issue creating your enquiry. Please try again later.",
              );
            }
          }
          22;
          return;
        }

        // Handle sub-destination selection (Europe specific destinations)
        if (serviceData.awaiting_sub_destination) {
          if (normalizedReplyId === "other" || reply_id === "other") {
            await sendText(
              from,
              "Please type the specific destination you're looking for.",
            );
            serviceData.awaiting_other_text = true;
            serviceData.awaiting_sub_destination =
              serviceData.awaiting_sub_destination; // Keep the flag
            await updateUserSession(from, { service_data: serviceData });
            return;
          }

          // Store the sub-destination
          serviceData[serviceData.awaiting_sub_destination] = reply_id;
          delete serviceData.awaiting_sub_destination;

          // Move to next question
          const remainingQuestions = questions.slice(1);
          if (remainingQuestions.length > 0) {
            await updateUserSession(from, {
              service_data: serviceData,
              question_queue: remainingQuestions,
            });
            await sendQuestion(from, remainingQuestions[0]);
          } else {
            // All questions completed
            await sendText(
              from,
              "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
            );
            const updatedUser = { ...user, service_data: serviceData };
            const leadResult = await submitLead(updatedUser);
            if (leadResult.success) {
              await updateUserSession(from, {
                stage: "completed",
                service_data: {},
                question_queue: [],
              });
            } else {
              await sendText(
                from,
                "Sorry, there was an issue creating your enquiry. Please try again later.",
              );
            }
          }
          return;
        }

        serviceData[currentQuestion.key] = reply_id;

        // RECALCULATE QUESTIONS QUEUE DYNAMICALLY
        // This handles logic like showing "ECR Check" only if Passport=New
        // Or showing specific Destinations only if Continent is selected
        const serviceId = user.service_required
          ? SERVICES_LIST.find((s) => s.title === user.service_required)?.id ||
            "other"
          : "other";
        const updatedQuestions = getServiceQuestions(serviceId, serviceData);

        // Filter out questions already answered
        const remainingQuestions = updatedQuestions.filter(
          (q) =>
            !serviceData.hasOwnProperty(q.key) ||
            serviceData[q.key] === null ||
            serviceData[q.key] === undefined,
        );

        if (remainingQuestions.length > 0) {
          await updateUserSession(from, {
            service_data: serviceData,
            question_queue: remainingQuestions,
          });
          await sendQuestion(from, remainingQuestions[0]);
        } else {
          console.log("[BOT] ✅ All questions completed. Submitting lead.");
          await sendText(
            from,
            "Perfect! Getting you the best deal! One of our team members will contact you soon. Thank you!",
          );
          const updatedUser = { ...user, service_data: serviceData };
          const leadResult = await submitLead(updatedUser);
          if (leadResult.success) {
            await updateUserSession(from, {
              stage: "completed",
              service_data: {},
              question_queue: [],
            });
          } else {
            await sendText(
              from,
              "Sorry, there was an issue creating your enquiry. Please try again later.",
            );
          }
        }
        return;
      }

      return;
    }

    // If we had an interactive message but didn't handle it above, log and return
    // (This prevents falling through to text handler when button clicks aren't matched)
    if (interactive) {
      console.warn(
        `[BOT] ⚠️ Interactive message received but no handler matched. Type: ${
          interactive.type
        }, Button ID: ${interactive.button_reply?.id || "N/A"}, Title: ${
          interactive.button_reply?.title || "N/A"
        }`,
      );
      console.warn(
        `[BOT] ⚠️ Full interactive object:`,
        JSON.stringify(interactive, null, 2),
      );
      return; // Don't fall through to text handler
    }

    // ================== 2. HANDLE TEXT MESSAGES ==================
    if (messageText) {
      const lcMessage = messageText.trim().toLowerCase();
      const isGreeting = /^(hi|hello|hey|namaste|start|menu)$/i.test(lcMessage);

      // Always treat explicit greetings as a fresh structured flow,
      // but let non-greeting messages (even in a completed session)
      // go through the AI triage so detailed enquiries are handled smartly.
      if (isGreeting) {
        await handleStructuredTextMessage(from, user, messageText);
        return;
      }

      // If AI is enabled, triage the text message to see if it's a detailed request
      if (isAiEnabled) {
        console.log("[BOT] 🤖 AI is enabled. Triaging message...");
        const triageResponse = await geminiAI.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              parts: [
                { text: triagePrompt },
                { text: `User message: "${messageText}"` },
              ],
            },
          ],
          config: { responseMimeType: "application/json" },
        });

        let triageResult;
        try {
          triageResult = JSON.parse(triageResponse.text.trim());
        } catch (e) {
          console.error("[BOT] ❌ AI Triage JSON parsing failed:", e);
          // Fallback to structured flow if AI fails to produce valid JSON
          await handleStructuredTextMessage(from, user, messageText);
          return;
        }

        console.log(
          "[BOT] AI triage intent=%s at %s",
          triageResult?.intent || "?",
          new Date().toISOString(),
        );

        if (triageResult.intent === "DETAILED_ENQUIRY") {
          await handleAiExtractionFlow(from, user, messageText);
          return;
        }
      }

      // If AI is disabled, or triage determines it's a simple response,
      // proceed with the normal structured text message handler.
      await handleStructuredTextMessage(from, user, messageText);
      return;
    }

    // (Already logged above as in from= type= at=)
  } catch (err) {
    console.error("\n[BOT] ❌ UNCAUGHT WEBHOOK ERROR:", err.stack || err);
  }
});

// -------------------------
// HEALTH CHECK ENDPOINTS
// -------------------------
app.get("/", (req, res) => {
  res.redirect("https://maduratravel.com/");
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabaseConnected: !!process.env.SUPABASE_URL,
  });
});

// -------------------------
// TOKEN MONITORING
// -------------------------
// Start token monitoring on initialization (checks every 12 hours)
if (WHATSAPP_TOKEN) {
  startTokenMonitoring(WHATSAPP_TOKEN, 12); // Check every 12 hours
} else {
  console.warn("[BOT] ⚠️ WHATSAPP_TOKEN not set, token monitoring disabled");
}

// Export the app instance to be used by the main server
export default app;
