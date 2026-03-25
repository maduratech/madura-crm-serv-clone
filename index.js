import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import { GoogleGenAI, Type } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import fetch from "node-fetch";
import multer from "multer";
import ExcelJS from "exceljs";
import whatsappBotApp from "./whatsapp-bot.js";
import whatsappCrmRouter from "./whatsapp-crm.js";
import { generateItinerary } from "./itineraryGenerator.js";
import { generateItineraryPdf } from "./itineraryPdfGenerator.js";
import {
  generateInvoicePdf,
  generateInvoicePdfBuffer,
} from "./invoicePdfGenerator.js";
import { aiGenerationLimiter } from "./utils/rateLimiter.js";
import { logger } from "./utils/logger.js";
import { cleanupOldPdfs, scheduleDailyCleanup } from "./utils/pdfCleanup.js";
import { normalizePhone } from "./phoneUtils.js";
import { startTokenMonitoring } from "./utils/tokenMonitor.js";
import { searchFlightOffers, searchLocations } from "./amadeusClient.js";
import {
  searchTboFlights,
  searchTboHotels,
  getTboHotelDetails,
  searchTboAirports,
  searchTboHotelCities,
  fetchTboCountryList,
  fetchTboCityList,
  fetchTboHotelCodeList,
  storeTboCountries,
  storeTboCities,
  storeTboHotelCodes,
} from "./tboClient.js";
import {
  extractTextFromFile,
  extractTextFromFileURL,
} from "./fileExtractor.js";
import {
  crawlWebsite,
  fetchSinglePage,
  cancelCrawl,
  activeCrawls,
} from "./websiteCrawler.js";
import {
  sendCrmWhatsappText,
  sendCrmWhatsappReplyButtons,
  sendCrmWhatsappCtaUrl,
  sendCrmWhatsappTemplate,
  uploadWhatsappMedia,
  sendCrmWhatsappDocument,
} from "./whatsapp-crm.js";
import {
  scheduleCustomerNotifications,
  checkBirthdays,
  checkPassportExpiries,
} from "./utils/customerNotifications.js";

const app = express();

// In-memory caches (ephemeral; safe for short-lived data)
const flightSearchCache = new Map();
const FLIGHT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const airportSearchCache = new Map();
const AIRPORT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Helper to convert ISO-8601 durations (e.g. PT2H30M) to minutes
function parseIsoDurationToMinutes(duration) {
  if (!duration || typeof duration !== "string") return 0;
  const hoursMatch = duration.match(/(\d+)H/);
  const minsMatch = duration.match(/(\d+)M/);
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minsMatch ? parseInt(minsMatch[1], 10) : 0;
  return hours * 60 + minutes;
}

const getCached = (cache, key) => {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value;
  }
  cache.delete(key);
  return null;
};

const setCache = (cache, key, value, ttlMs) => {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

// Whitelist specific origins for CORS
const allowedOrigins = [
  "https://crm.maduratravel.com",
  "https://madura-crm-25.vercel.app",
  "https://maduracrmclone.vercel.app",
  "https://maduracrmclone.vercel.app/",
  "https://crm-madura.vercel.app",
  "https://crm-madura.vercel.app/",
  "https://maduratravel.com",
  "https://www.maduratravel.com",
  "http://maduratravel.com",
  "http://www.maduratravel.com",
  "https://maduraglobal.com",
  "https://www.maduraglobal.com",
  "http://maduraglobal.com",
  "http://www.maduraglobal.com",
  "http://localhost:5173",
];

const corsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else if (origin && origin.includes("maduratravel.com")) {
      // Allow all maduratravel.com subdomains
      callback(null, true);
    } else if (origin && origin.includes("maduraglobal.com")) {
      // Allow maduraglobal.com (website lead form, public site)
      callback(null, true);
    } else if (
      origin &&
      (origin.includes("crm-madura.vercel.app") ||
        origin.includes("madura-crm-25.vercel.app"))
    ) {
      // Allow Vercel deployment domains
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));
// Ensure preflight requests get a successful response.
// CORS middleware only sets headers; we must explicitly return a 2xx for OPTIONS.
app.options("*", cors(corsOptions), (req, res) => res.sendStatus(204));
app.use(express.json({ limit: "50mb" })); // For JSON payloads (increased for file metadata)
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // For form-data payloads from Elementor

// Configure multer for file uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow PDF and Excel files
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/excel",
      "application/x-excel",
      "application/x-msexcel",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only PDF and Excel files are allowed."));
    }
  },
});

// Configure multer for resume uploads (PDF, DOC, DOCX only)
const resumeUpload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow PDF, DOC, DOCX files
    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const allowedExtensions = [".pdf", ".doc", ".docx"];
    const fileExtension =
      "." + file.originalname.split(".").pop().toLowerCase();

    if (
      allowedTypes.includes(file.mimetype) ||
      allowedExtensions.includes(fileExtension)
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only PDF, DOC, and DOCX files are allowed.",
        ),
      );
    }
  },
});

// Configure multer for supplier visiting card uploads (PDF or image, max 2MB)
const supplierCardUpload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only PDF or image files are allowed for visiting cards.",
        ),
      );
    }
  },
});

// Mount the standalone WhatsApp bot app
// This will handle routes like /webhook defined in whatsapp-bot.js
app.use(whatsappBotApp);

// Mount the standalone WhatsApp CRM router
// This will handle routes like /api/whatsapp/conversations, /api/whatsapp/messages, etc.
app.use(whatsappCrmRouter);

const PORT = process.env.PORT || 3001;

// Message ID to Lead ID mapping cache (for tracking delivery failures)
// Format: { messageId: { leadId, staffName, staffPhone, timestamp } }
// Entries expire after 24 hours
export const messageIdToLeadCache = new Map();
const MESSAGE_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Clean up expired cache entries periodically
setInterval(
  () => {
    const now = Date.now();
    for (const [messageId, data] of messageIdToLeadCache.entries()) {
      if (now - data.timestamp > MESSAGE_CACHE_EXPIRY) {
        messageIdToLeadCache.delete(messageId);
      }
    }
  },
  60 * 60 * 1000,
); // Clean up every hour

// Function to handle WhatsApp message delivery failures
export async function handleWhatsAppMessageFailure(
  messageId,
  errorCode,
  errorTitle,
  recipientId,
) {
  const cached = messageIdToLeadCache.get(messageId);
  if (!cached) {
    console.log(
      `[CRM] ⚠️ Message failure for ${messageId} but no cached lead mapping found.`,
    );
    return;
  }

  const { leadId, staffName, staffPhone } = cached;

  // Determine error message based on error code
  let errorMessage = `WhatsApp message delivery failed for staff "${staffName}" (${staffPhone}). `;

  if (errorCode === 131049) {
    errorMessage += `Error Code ${errorCode}: ${
      errorTitle ||
      "Message not delivered to maintain healthy ecosystem engagement"
    }. `;
    errorMessage += `Possible reasons: Staff may have blocked the business number, opted out of messages, or phone number is not registered on WhatsApp.`;
  } else if (errorCode === 131047) {
    errorMessage += `Error Code ${errorCode}: ${
      errorTitle || "Re-engagement message"
    }. `;
    errorMessage += `The customer needs to send a message first, or you must use a WhatsApp template message if outside the 24-hour messaging window.`;
  } else {
    errorMessage += `Error Code ${errorCode}: ${
      errorTitle || "Unknown error"
    }.`;
  }

  console.error(
    `[CRM] ❌ ${errorMessage} (Lead: ${leadId}, Message ID: ${messageId})`,
  );

  // Log to lead activity
  await logLeadActivity(leadId, "WhatsApp Failed", errorMessage, "System");
}

// --- SUPABASE CLIENT ---
// Create Supabase client with service role key (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
    },
  },
);

// Default roles: role_id 1,2,3 only. Lead Manager & Accountant are tags (staff_role_tags + role_tags).
async function deriveStaffFlagsFromRoleTags(staffId) {
  const out = {
    is_lead_manager: false,
    is_accountant: false,
    manage_lead_branches: [],
  };
  try {
    const { data: srtRows } = await supabase
      .from("staff_role_tags")
      .select("role_tag_id, role_tags(id, name, slug)")
      .eq("staff_id", staffId);
    const list = srtRows || [];
    for (const row of list) {
      const rt = row.role_tags;
      const tags = rt == null ? [] : Array.isArray(rt) ? rt : [rt];
      for (const t of tags) {
        const slug = (t.slug || "").toLowerCase();
        const name = (t.name || "").trim();
        if (slug === "lead-manager" || name === "Lead Manager")
          out.is_lead_manager = true;
        if (slug === "accountant" || name === "Accountant")
          out.is_accountant = true;
      }
    }
    if (out.is_lead_manager) {
      const { data: branches } = await supabase.from("branches").select("id");
      out.manage_lead_branches = (branches || []).map((b) => b.id);
    }
  } catch (err) {
    // role_tags / staff_role_tags tables may not exist yet
  }
  return out;
}

// --- AUTHENTICATION MIDDLEWARE ---
// Middleware to check if user is authenticated
const requireAuth = async (req, res, next) => {
  try {
    // Allow internal calls to bypass authentication
    // Internal calls are made from within the server (e.g., from generateItineraryForLead)
    if (req.headers["x-internal-call"] === "true") {
      // For internal calls, create a system user object
      // This allows internal API calls to work without requiring a real user token
      req.user = {
        id: 0,
        name: "System",
        role: "System",
        role_id: null,
      };
      return next();
    }

    // Check for service role key for internal service-to-service calls
    const { authorization } = req.headers;
    if (authorization && authorization.startsWith("Bearer ")) {
      const token = authorization.split(" ")[1];

      // Check if it's the service role key (for internal calls)
      if (token === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        req.user = {
          id: 0,
          name: "System",
          role: "System",
          role_id: null,
        };
        return next();
      }
    }

    // Standard authentication flow for external requests
    if (!authorization) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authorization.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Invalid token format" });
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      const errorMessage =
        authError?.message ||
        authError?.toString() ||
        JSON.stringify(authError) ||
        "No user";

      // Reduce log noise for connection timeout errors (network issues)
      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("Connect Timeout") ||
        errorMessage.includes("UND_ERR_CONNECT_TIMEOUT")
      ) {
        // Only log connection errors occasionally to reduce spam
        if (Math.random() < 0.1) {
          // Log 10% of connection errors
          console.warn(
            "[Auth Middleware] Connection timeout to Supabase (network issue). This may be temporary.",
          );
        }
      } else {
        // Log other auth errors normally
        console.error(
          "[Auth Middleware] Token validation error:",
          errorMessage,
        );
      }

      return res.status(401).json({ message: "Invalid token" });
    }

    // Get staff profile
    const { data: staffProfile, error: profileError } = await supabase
      .from("staff")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (profileError || !staffProfile) {
      console.error(
        "[Auth Middleware] Staff profile error:",
        profileError?.message || "No profile",
      );
      return res.status(403).json({ message: "Staff profile not found" });
    }

    // Default role from role_id (1=Super Admin, 2=Manager, 3=Staff only)
    const roleIdToName = {
      1: "Super Admin",
      2: "Manager",
      3: "Staff",
    };
    const roleName = roleIdToName[staffProfile.role_id] || "Staff";

    const derived = await deriveStaffFlagsFromRoleTags(staffProfile.id);

    req.user = {
      ...staffProfile,
      role_id: staffProfile.role_id,
      role: roleName,
      is_lead_manager: derived.is_lead_manager,
      is_accountant: derived.is_accountant,
      manage_lead_branches: derived.manage_lead_branches,
    };

    next();
  } catch (error) {
    console.error("[Auth Middleware] Unexpected error:", error);
    // Return 401 instead of 500 for auth errors
    return res.status(401).json({
      message: "Authentication error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// Middleware to check if user is Super Admin
const requireSuperAdmin = async (req, res, next) => {
  try {
    const { authorization } = req.headers;
    if (!authorization) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authorization.split(" ")[1];
    const {
      data: { user },
    } = await supabase.auth.getUser(token);

    if (!user) {
      return res.status(401).json({ message: "Invalid token" });
    }

    // Check if user is Super Admin
    const { data: staffProfile, error: profileError } = await supabase
      .from("staff")
      .select("role_id")
      .eq("user_id", user.id)
      .single();

    // Check if role_id is 1 (Super Admin)
    if (profileError || staffProfile?.role_id !== 1) {
      return res
        .status(403)
        .json({ message: "Forbidden: Super Admin access required." });
    }

    next();
  } catch (error) {
    console.error("[Sources API] Auth error:", error);
    return res.status(401).json({ message: "Authentication failed" });
  }
};

// --- GEMINI AI CLIENT ---
export const geminiAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- NODEMAILER TRANSPORTER ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "465", 10),
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// --- WHATSAPP NOTIFICATION LOGIC (FOR CRM) ---
// WhatsApp sending functions are now imported from whatsapp-crm.js
// Rate limiting and throttling are handled in whatsapp-crm.js
// These constants are still needed for template sending in sendStaffAssignmentNotification, sendDailyProductivitySummary, etc.
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_GRAPH_API_BASE = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
const BULK_MESSAGE_DELAY = 500; // 500ms delay between different recipients in bulk operations

export async function logLeadActivity(
  leadId,
  type,
  description,
  user = "System",
) {
  try {
    const { data: lead, error: fetchError } = await supabase
      .from("leads")
      .select("activity")
      .eq("id", leadId)
      .single();

    if (fetchError) {
      console.error(
        `[ActivityLogger] Failed to fetch lead ${leadId}: ${fetchError.message}`,
      );
      return;
    }

    const newActivity = {
      id: Date.now(),
      type,
      description,
      user,
      timestamp: new Date().toISOString(),
    };

    const updatedActivity = [newActivity, ...(lead.activity || [])];

    const { error: updateError } = await supabase
      .from("leads")
      .update({
        activity: updatedActivity,
        last_updated: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (updateError) {
      console.error(
        `[ActivityLogger] Failed to log activity for lead ${leadId}: ${updateError.message}`,
      );
    } else {
      console.log(
        `[ActivityLogger] Successfully logged '${type}' for lead ${leadId}.`,
      );
    }
  } catch (error) {
    console.error(
      `[ActivityLogger] CRITICAL error for lead ${leadId}:`,
      error.message,
    );
  }
}

// --- GLOBAL REALTIME LISTENERS ---
function setupGlobalListeners() {
  try {
    const channel = supabase.channel("global-listeners");

    // INSERT on leads: Send MTS summary once (after staff assignment if needed)
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "leads" },
      async (payload) => {
        const record = payload.new || payload.record || payload;
        console.log(
          "[GlobalListener] New lead inserted:",
          record?.id || record,
        );
        try {
          if (!record || !record.customer_id) return;

          // Fetch customer details
          const { data: customer } = await supabase
            .from("customers")
            .select("*")
            .eq("id", record.customer_id)
            .single();

          if (!customer) {
            console.error(
              `[GlobalListener] Customer not found for lead ${record.id}`,
            );
            return;
          }

          // Check if summary was already sent (prevent duplicates)
          const recentSummarySent = (record.activity || []).some(
            (act) =>
              (act.type === "Summary Sent" || act.type === "WhatsApp Sent") &&
              (act.description?.includes("Summary sent") ||
                act.description?.includes("template")) &&
              new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
          );

          if (recentSummarySent) {
            console.log(
              `[GlobalListener] Summary already sent recently for lead ${record.id}. Skipping duplicate.`,
            );
            // Still trigger assignment even if summary was sent (event-driven for this specific lead)
            try {
              assignLeadsAndGenerateItineraries(record.id).catch((e) =>
                console.error(
                  "[GlobalListener] Error triggering assignment/itinerary:",
                  e?.message || e,
                ),
              );
            } catch (e) {
              console.error(
                "[GlobalListener] Failed to call assignLeadsAndGenerateItineraries:",
                e?.message || e,
              );
            }
            return;
          }

          // Check if staff is already assigned
          const { data: leadWithAssignees } = await supabase
            .from("leads")
            .select("*, all_assignees:lead_assignees(staff(*))")
            .eq("id", record.id)
            .single();

          if (
            leadWithAssignees?.all_assignees &&
            leadWithAssignees.all_assignees.length > 0
          ) {
            // Staff already assigned - DISABLED: MTS summary auto-sending
            // const staff = leadWithAssignees.all_assignees[0].staff;
            // console.log(
            //   `[GlobalListener] Staff already assigned (${staff.name}). Sending MTS summary immediately for lead ${record.id}`
            // );
            // await sendWelcomeWhatsapp(leadWithAssignees, customer, staff);
            console.log(
              `[GlobalListener] Staff already assigned for lead ${record.id}. MTS summary auto-sending is disabled.`,
            );
          } else {
            // No staff yet - trigger assignment for this specific lead (event-driven)
            // Summary will be sent by the lead_assignees INSERT listener when staff is assigned
            console.log(
              `[GlobalListener] No staff assigned yet for lead ${record.id}. Triggering event-driven assignment. Summary will be sent when staff is assigned.`,
            );

            // Trigger assignment for this specific lead (much faster than batch processing)
            try {
              assignLeadsAndGenerateItineraries(record.id).catch((e) =>
                console.error(
                  "[GlobalListener] Error triggering assignment:",
                  e?.message || e,
                ),
              );
            } catch (e) {
              console.error(
                "[GlobalListener] Failed to call assignLeadsAndGenerateItineraries:",
                e?.message || e,
              );
            }
          }
        } catch (err) {
          console.error(
            "[GlobalListener] Error handling new lead insert:",
            err.message,
          );
        }
      },
    );

    // UPDATE on leads: Handle status changes and itinerary generation
    // NOTE: MTS summary is ONLY sent once when lead is created (INSERT listener)
    // Do NOT send summary on any UPDATE events (status changes, destination changes, etc.)
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "leads" },
      async (payload) => {
        const startTime = Date.now();
        const oldRec = payload.old || payload.previous || null;
        const newRec = payload.new || payload.record || payload;
        try {
          if (!newRec) return;

          // Log all UPDATE events for debugging
          console.log(
            `[GlobalListener] UPDATE event received for lead ${
              newRec.id
            }. Status: ${newRec.status}, Old status: ${oldRec?.status || "N/A"}`,
          );

          // Detect *actual* changes to destination, travel date, services, duration, passenger details, or status.
          // We ONLY act when Supabase provides the previous row (`oldRec`).
          // This prevents repeated WhatsApp sends when the user simply "saves" the lead
          // without changing these key fields.
          const destinationChanged =
            !!oldRec && oldRec.destination !== newRec.destination;

          const travelDateChanged =
            !!oldRec && oldRec.travel_date !== newRec.travel_date;

          const servicesChanged =
            !!oldRec &&
            JSON.stringify(oldRec.services || []) !==
              JSON.stringify(newRec.services || []);

          // Detect duration changes
          const durationChanged =
            !!oldRec && oldRec.duration !== newRec.duration;

          // Detect passenger details changes (requirements.rooms, adults, children)
          const oldRequirements = oldRec?.requirements || {};
          const newRequirements = newRec?.requirements || {};
          const oldRooms = oldRequirements?.rooms || [];
          const newRooms = newRequirements?.rooms || [];
          const oldAdults = oldRequirements?.adults || oldRec?.adults || 0;
          const newAdults = newRequirements?.adults || newRec?.adults || 0;
          const oldChildren =
            oldRequirements?.children || oldRec?.children || 0;
          const newChildren =
            newRequirements?.children || newRec?.children || 0;

          // Check if passenger details changed (rooms array or adults/children counts)
          const passengerDetailsChanged =
            !!oldRec &&
            (JSON.stringify(oldRooms) !== JSON.stringify(newRooms) ||
              oldAdults !== newAdults ||
              newChildren !== newChildren);

          // Check if travel_date was added (changed from null/empty to a valid date)
          // This is important for sending MTS summary when agents fill in missing required fields
          const travelDateAdded =
            !!oldRec &&
            (!oldRec.travel_date ||
              oldRec.travel_date === null ||
              String(oldRec.travel_date).trim() === "" ||
              new Date(oldRec.travel_date).getFullYear() <= 1970) &&
            newRec.travel_date &&
            String(newRec.travel_date).trim() !== "" &&
            new Date(newRec.travel_date).getFullYear() > 1970;

          // WhatsApp messages are only triggered for Feedback status
          // All other status changes do not trigger WhatsApp messages
          const statusChanged = !!oldRec && oldRec.status !== newRec.status;

          // Handle Feedback status separately - send feedback even if oldRec is null
          // This ensures feedback is sent when status is changed to Feedback
          if (newRec.status === "Feedback") {
            console.log(
              `[GlobalListener] Lead ${newRec.id} status is Feedback. Checking if feedback needs to be sent...`,
            );
            console.log(
              `[GlobalListener] Lead ${newRec.id} - notified_status: ${newRec.notified_status}`,
            );

            if (newRec.notified_status !== "Feedback") {
              console.log(
                `[GlobalListener] Lead ${newRec.id} status changed to Feedback. Sending feedback template...`,
              );
              try {
                // Fetch customer for feedback
                const { data: customer } = await supabase
                  .from("customers")
                  .select("*")
                  .eq("id", newRec.customer_id)
                  .single();

                if (customer) {
                  await sendFeedbackLinkMessage(newRec, customer);
                  // Mark as notified to prevent duplicate processing
                  await supabase
                    .from("leads")
                    .update({ notified_status: "Feedback" })
                    .eq("id", newRec.id);
                  console.log(
                    `[GlobalListener] ✅ Feedback template sent for lead ${newRec.id}`,
                  );
                } else {
                  console.log(
                    `[GlobalListener] ⚠️ Customer not found for lead ${newRec.id}. Cannot send feedback.`,
                  );
                }
              } catch (feedbackError) {
                console.error(
                  `[GlobalListener] Error sending feedback template for lead ${newRec.id}:`,
                  feedbackError.message,
                  feedbackError.stack,
                );
              }
            } else {
              console.log(
                `[GlobalListener] Lead ${newRec.id} already notified for Feedback status. Skipping.`,
              );
            }
          }

          // If we don't have a previous row snapshot, we can't reliably know if
          // anything important changed, so we skip to avoid duplicate messages.
          // (But Feedback is already handled above)
          if (!oldRec) {
            console.log(
              `[GlobalListener] Lead ${newRec.id} update received without previous row; no significant-field diff check possible. Skipping other actions.`,
            );
            return;
          }

          // Send summary when lead is created and staff is assigned (status is Enquiry)
          // Also send when status changes to "Processing" (customer confirmed)
          const isTourPackage = newRec.services?.includes("Tour Package");
          const isEnquiryStatus = newRec.status === "Enquiry";
          const isProcessingStatus = newRec.status === "Processing";

          // Check if staff was just assigned (by checking if lead_assignees was inserted)
          // This will be handled by the lead_assignees INSERT listener

          // MTS SUMMARY SHOULD BE SENT ONLY FOR SPECIFIC CHANGES:
          // - Services add or remove
          // - Destination change
          // - Duration change
          // - Passenger Details change
          // - Travel date added (when it was null/empty and now has a valid date)
          // DO NOT send summary when ONLY status changes
          const shouldSendSummary =
            servicesChanged ||
            destinationChanged ||
            durationChanged ||
            passengerDetailsChanged ||
            travelDateAdded;

          // Log all "Enquiry" to "Processing" status changes
          if (
            statusChanged &&
            oldRec.status === "Enquiry" &&
            isProcessingStatus
          ) {
            console.log(
              `[GlobalListener] Lead ${newRec.id} status changed from Enquiry to Processing.`,
            );
            // Log this status change to lead activity
            try {
              await logLeadActivity(
                newRec.id,
                "Status Changed",
                `Lead status changed from Enquiry to Processing.`,
                "System",
              );
            } catch (logError) {
              console.error(
                `[GlobalListener] Failed to log status change to activity:`,
                logError.message,
              );
            }
          }

          // Trigger itinerary generation when status changes to "Processing" for Tour Package leads
          if (statusChanged && isProcessingStatus && isTourPackage) {
            console.log(
              `[GlobalListener] Lead ${newRec.id} status changed to Processing. Triggering itinerary generation...`,
            );
            // Trigger itinerary generation asynchronously
            generateItineraryForLead(newRec.id).catch((err) => {
              console.error(
                `[GlobalListener] Error generating itinerary for lead ${newRec.id}:`,
                err.message,
              );
            });
          }

          // Handle other status-specific actions (invoice creation, feedback links)
          if (statusChanged) {
            // Fetch customer for status-specific actions
            const { data: customer } = await supabase
              .from("customers")
              .select("*")
              .eq("id", newRec.customer_id)
              .single();

            if (customer) {
              // Note: Feedback status is handled earlier in the function (before oldRec check)
              // This ensures it works even if oldRec is null
            }
          }

          // Send MTS summary ONLY for specific changes: Services, Destination, Duration, Passenger Details, or Travel Date added
          // DO NOT send summary when ONLY status changes
          // Also check if all required fields are now filled before sending
          if (shouldSendSummary) {
            // Validate that all required fields are now filled
            const validation = validateMtsSummaryRequiredFields(newRec);
            if (!validation.isValid) {
              console.log(
                `[GlobalListener] Lead ${
                  newRec.id
                } has changes but still missing required fields: ${Object.entries(
                  validation.missingFields,
                )
                  .filter(([_, missing]) => missing)
                  .map(([field]) => field)
                  .join(", ")}. Skipping MTS summary send.`,
              );
            } else {
              console.log(
                `[GlobalListener] Lead ${newRec.id} has significant changes (Services: ${servicesChanged}, Destination: ${destinationChanged}, Duration: ${durationChanged}, Passenger Details: ${passengerDetailsChanged}, Travel Date Added: ${travelDateAdded}). All required fields filled. Sending updated summary to customer.`,
              );

              // Fetch customer and staff for sending summary
              const { data: customer } = await supabase
                .from("customers")
                .select("*")
                .eq("id", newRec.customer_id)
                .single();

              if (customer && customer.phone) {
                // Fetch lead with assignees to get staff information
                const { data: leadWithAssignees } = await supabase
                  .from("leads")
                  .select("*, all_assignees:lead_assignees(staff(*))")
                  .eq("id", newRec.id)
                  .single();

                if (leadWithAssignees) {
                  // Get primary assigned staff (first assignee)
                  const primaryStaff =
                    leadWithAssignees.all_assignees &&
                    leadWithAssignees.all_assignees.length > 0
                      ? leadWithAssignees.all_assignees[0].staff
                      : {
                          id: 0,
                          name: "Madura Travel Service",
                          phone: process.env.DEFAULT_STAFF_PHONE || "",
                        };

                  // Check if summary was already sent recently (prevent duplicates)
                  const recentSummarySent = (
                    leadWithAssignees.activity || []
                  ).some(
                    (act) =>
                      (act.type === "Summary Sent" ||
                        act.type === "WhatsApp Sent") &&
                      (act.description?.includes("Summary sent") ||
                        act.description?.includes("template")) &&
                      new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
                  );

                  if (!recentSummarySent) {
                    // DISABLED: MTS summary auto-sending
                    // try {
                    //   await sendWelcomeWhatsapp(
                    //     leadWithAssignees,
                    //     customer,
                    //     primaryStaff
                    //   );
                    //   console.log(
                    //     `[GlobalListener] ✅ Updated summary sent successfully to customer for lead ${newRec.id}`
                    //   );
                    // } catch (summaryError) {
                    //   console.error(
                    //     `[GlobalListener] ❌ Error sending updated summary to customer for lead ${newRec.id}:`,
                    //     summaryError.message
                    //   );
                    //   // Log error to lead activity
                    //   await logLeadActivity(
                    //     newRec.id,
                    //     "WhatsApp Failed",
                    //     `Failed to send updated summary to customer: ${summaryError.message}`,
                    //     "System"
                    //   );
                    // }
                    console.log(
                      `[GlobalListener] MTS summary auto-sending is disabled for lead ${newRec.id}`,
                    );
                  } else {
                    console.log(
                      `[GlobalListener] Summary already sent recently for lead ${newRec.id}. Skipping duplicate.`,
                    );
                  }
                }
              } else {
                console.log(
                  `[GlobalListener] ⚠️ Cannot send summary for lead ${newRec.id}: Customer phone not available.`,
                );
              }
            } // End of validation.isValid check
          } else if (statusChanged && !shouldSendSummary) {
            // Log when status changes but summary is NOT sent (as per requirement)
            console.log(
              `[GlobalListener] Lead ${newRec.id} status changed from "${oldRec.status}" to "${newRec.status}". Summary NOT sent (only status change, no Services/Destination/Duration/Passenger Details changes).`,
            );
          }
        } catch (err) {
          console.error(
            "[GlobalListener] Error handling lead update:",
            err.message,
          );
        }
      },
    );

    // INSERT on lead_assignees: Handled by dedicated listenForManualAssignments() function
    // This prevents duplicate notifications and ensures consistent messaging

    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log("[GlobalListener] ✅ Subscribed to global DB changes.");
      } else if (err) {
        console.error("[GlobalListener] ❌ Subscription error:", err);
      }
    });
  } catch (err) {
    console.error("[GlobalListener] Failed to setup listeners:", err.message);
  }
}

// WhatsApp sending functions are now imported from whatsapp-crm.js
// sendCrmWhatsappText, sendCrmWhatsappReplyButtons, sendCrmWhatsappCtaUrl, sendCrmWhatsappTemplate

// Reusable function to generate summary text for leads
/**
 * Validate if all required fields are filled for MTS summary
 * Required fields:
 * 1. Services Required (services array)
 * 2. Destination
 * 3. Duration
 * 4. Date of Travel (travel_date)
 * 5. Passenger Details (adults/children in requirements)
 */
function validateMtsSummaryRequiredFields(lead) {
  // 1. Services Required
  const hasServices =
    lead.services && Array.isArray(lead.services) && lead.services.length > 0;

  // 2. Destination
  const hasDestination =
    lead.destination &&
    lead.destination !== "N/A" &&
    lead.destination.trim() !== "";

  // 3. Duration
  const hasDuration = lead.duration && lead.duration.trim() !== "";

  // 4. Date of Travel
  // Handle null, undefined, empty string, or invalid dates (like epoch 0 = 1970-01-01)
  // Also check check_in_date if travel_date is not available
  let hasTravelDate = false;
  let travelDateToCheck = lead.travel_date || lead.check_in_date;
  if (travelDateToCheck) {
    const travelDateStr = String(travelDateToCheck).trim();
    if (
      travelDateStr !== "" &&
      travelDateStr !== "null" &&
      travelDateStr !== "undefined"
    ) {
      // Check if it's a valid date (not epoch 0 = 1970-01-01)
      const dateObj = new Date(travelDateStr);
      if (!isNaN(dateObj.getTime()) && dateObj.getFullYear() > 1970) {
        hasTravelDate = true;
      }
    }
  }

  // 5. Passenger Details (adults or children must be filled)
  // First check rooms array, then fall back to requirements.adults/children
  let totalAdults = 0;
  if (
    lead.requirements?.rooms &&
    Array.isArray(lead.requirements.rooms) &&
    lead.requirements.rooms.length > 0
  ) {
    totalAdults = lead.requirements.rooms.reduce(
      (sum, room) => sum + (room.adults || 0),
      0,
    );
  } else if (
    lead.requirements?.adults !== null &&
    lead.requirements?.adults !== undefined
  ) {
    totalAdults = parseInt(lead.requirements.adults) || 0;
  }

  let totalChildren = 0;
  if (
    lead.requirements?.rooms &&
    Array.isArray(lead.requirements.rooms) &&
    lead.requirements.rooms.length > 0
  ) {
    totalChildren = lead.requirements.rooms.reduce(
      (sum, room) => sum + (room.children || 0),
      0,
    );
  } else if (
    lead.requirements?.children !== null &&
    lead.requirements?.children !== undefined
  ) {
    totalChildren = parseInt(lead.requirements.children) || 0;
  }

  const hasPassengerDetails = totalAdults > 0 || totalChildren > 0;

  // Make travelDate and passengerDetails optional for initial summary send
  // Agents will fill these later, but we can send summary with Services, Destination, and Duration
  // Only require Services, Destination, and Duration - travelDate and passengerDetails are optional
  const isValid = hasServices && hasDestination && hasDuration;
  // Note: hasTravelDate and hasPassengerDetails are now optional - agents will fill them later

  return {
    isValid,
    missingFields: {
      services: !hasServices,
      destination: !hasDestination,
      duration: !hasDuration,
      travelDate: !hasTravelDate, // Optional - shown in missingFields but doesn't block sending
      passengerDetails: !hasPassengerDetails, // Optional - shown in missingFields but doesn't block sending
    },
  };
}

function generateLeadSummary(lead, customer, staff) {
  const today = new Date();
  const bookingId = `MTS-${lead.id}${String(today.getDate()).padStart(
    2,
    "0",
  )}${String(today.getMonth() + 1).padStart(2, "0")}${String(
    today.getFullYear(),
  ).slice(-2)}`;

  // Calculate passengers
  const totalAdults =
    (lead.requirements?.rooms || []).reduce(
      (sum, room) => sum + (room.adults || 0),
      0,
    ) || (lead.adults ? parseInt(lead.adults) : 0);
  const totalChildren =
    (lead.requirements?.rooms || []).reduce(
      (sum, room) => sum + (room.children || 0),
      0,
    ) || (lead.children ? parseInt(lead.children) : 0);

  let passengerDetails = `${totalAdults} Adult(s)`;
  if (totalChildren > 0) {
    passengerDetails += `, ${totalChildren} Child(ren)`;
  }

  // Build summary parts
  const summaryParts = [];
  summaryParts.push(`Service: ${lead.services?.join(", ") || "N/A"}`);
  if (lead.destination && lead.destination !== "N/A") {
    summaryParts.push(`Destination: ${lead.destination}`);
  }
  if (lead.travel_date) {
    summaryParts.push(
      `Date of Travel: ${new Date(lead.travel_date).toLocaleDateString(
        "en-GB",
      )}`,
    );
  }
  if (lead.duration) {
    summaryParts.push(`Duration: ${formatDurationToDays(lead.duration)}`);
  }
  if (totalAdults > 0 || totalChildren > 0) {
    summaryParts.push(`Passengers: ${passengerDetails}`);
  }

  const summaryText = summaryParts.join("\n");

  return {
    bookingId,
    summaryText,
    customerName: customer.first_name,
    staffName: staff.name,
  };
}

async function sendWelcomeWhatsapp(lead, customer, staff) {
  // Send mts_summary template as the single welcome/confirmation message for all leads
  // This template includes "Confirm Enquiry" and "Talk to Agent" buttons
  // This replaces separate welcome and confirmation messages - one template does both

  if (!customer.phone) {
    console.log(
      `[CRM] ⚠️ Customer alert not sent for lead ${lead.id}: No phone number found for customer ${customer.id}.`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Skipped",
      `Welcome/confirmation template not sent to customer "${customer.first_name} ${customer.last_name}" - no phone number.`,
    );
    return;
  }

  // Check if summary template was already sent recently (prevent duplicates)
  const recentSummarySent = (lead.activity || []).some(
    (act) =>
      (act.type === "Summary Sent" || act.type === "WhatsApp Sent") &&
      (act.description?.includes("Summary sent") ||
        act.description?.includes("template")) &&
      new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
  );

  if (recentSummarySent) {
    console.log(
      `[CRM] ⚠️ Summary template already sent recently for lead ${lead.id}. Skipping duplicate.`,
    );
    return false;
  }

  // Check if customer already confirmed via button click - don't send summary again when status changes to Confirmed
  const customerAlreadyConfirmed = (lead.activity || []).some(
    (act) =>
      act.type === "Customer Confirmed" &&
      act.description?.includes("confirmed the enquiry via WhatsApp"),
  );

  if (customerAlreadyConfirmed && lead.status === "Confirmed") {
    console.log(
      `[CRM] ⚠️ Customer already confirmed via WhatsApp button for lead ${lead.id}. Skipping duplicate summary send.`,
    );
    return false;
  }

  // Validate that all required fields are filled before sending MTS summary
  const validation = validateMtsSummaryRequiredFields(lead);
  if (!validation.isValid) {
    // Only show truly required fields (Services, Destination, Duration)
    const requiredMissingFields = Object.entries(validation.missingFields)
      .filter(
        ([field, missing]) =>
          missing && ["services", "destination", "duration"].includes(field),
      )
      .map(([field]) => field)
      .join(", ");
    console.log(
      `[CRM] ⚠️ Cannot send MTS summary for lead ${lead.id}: Missing required fields: ${requiredMissingFields}`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Skipped",
      `MTS summary not sent - missing required fields: ${requiredMissingFields}. Please fill: Services, Destination, and Duration. (Date of Travel and Passenger Details are optional and can be filled by agents later.)`,
    );
    return false;
  }

  // Log optional missing fields for information (but don't block sending)
  const optionalMissingFields = Object.entries(validation.missingFields)
    .filter(
      ([field, missing]) =>
        missing && ["travelDate", "passengerDetails"].includes(field),
    )
    .map(([field]) => field)
    .join(", ");
  if (optionalMissingFields) {
    console.log(
      `[CRM] ℹ️ MTS summary will be sent for lead ${lead.id} but missing optional fields: ${optionalMissingFields}`,
    );
  }

  const { bookingId, summaryText, customerName, staffName } =
    generateLeadSummary(lead, customer, staff);

  // Clean summary text for template: Remove newlines, tabs, and multiple consecutive spaces
  // Meta Business Manager templates don't allow newlines/tabs in text parameters
  const cleanSummaryText = (summaryText || "")
    .replace(/\n/g, " ") // Replace newlines with spaces
    .replace(/\t/g, " ") // Replace tabs with spaces
    .replace(/[ ]{5,}/g, " ") // Replace 5+ consecutive spaces with single space
    .replace(/[ ]{2,}/g, " ") // Replace 2+ consecutive spaces with single space
    .trim();

  // Prepare template components for mts_summary template
  // The template must have buttons defined in Meta Business Manager: "Confirm Enquiry" and "Talk to Agent"
  const templateComponents = [
    {
      type: "body",
      parameters: [
        { type: "text", text: customerName || "" }, // {{1}} - Customer name
        { type: "text", text: bookingId || "" }, // {{2}} - Booking ID
        { type: "text", text: staffName || "" }, // {{3}} - Staff name
        { type: "text", text: cleanSummaryText }, // {{4}} - Summary (cleaned)
      ],
    },
  ];

  // Normalize phone number - try multiple methods for better compatibility
  let sanitizedPhone = normalizePhone(customer.phone, "IN");

  // If normalization fails, try manual cleanup for common formats
  if (!sanitizedPhone && customer.phone) {
    const phoneStr = String(customer.phone).trim();
    // Remove spaces and common separators
    const cleaned = phoneStr.replace(/[\s\-\(\)]/g, "");
    // If it's already in +91 format or starts with 91, use it
    if (cleaned.startsWith("+91") || cleaned.startsWith("919")) {
      sanitizedPhone = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
      console.log(
        `[CRM] 📞 Manual phone normalization: ${customer.phone} → ${sanitizedPhone}`,
      );
    } else if (cleaned.length === 10) {
      // 10 digits - assume India
      sanitizedPhone = `+91${cleaned}`;
      console.log(
        `[CRM] 📞 Manual phone normalization (10 digits): ${customer.phone} → ${sanitizedPhone}`,
      );
    }
  }

  if (!sanitizedPhone) {
    console.error(
      `[CRM] ❌ Could not normalize customer phone for lead ${lead.id}: ${customer.phone}`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Failed",
      `Failed to send welcome/confirmation template: Invalid phone number "${customer.phone}" for customer "${customer.first_name} ${customer.last_name}".`,
    );
    return false;
  }

  console.log(
    `[CRM] 📞 Normalized phone to ${sanitizedPhone} for lead ${lead.id} (original: ${customer.phone})`,
  );

  // Send mts_summary template (includes welcome message + confirmation buttons)
  // This is the ONLY message sent - it serves as both welcome and confirmation
  console.log(
    `[CRM] 📤 Sending mts_summary template (welcome + confirmation) to ${sanitizedPhone} for lead ${lead.id}.`,
  );

  const result = await sendCrmWhatsappTemplate(
    sanitizedPhone,
    "mts_summary",
    "en",
    templateComponents,
  );

  if (result) {
    const messageId = result.messages?.[0]?.id;
    if (messageId) {
      // Store message ID -> lead ID mapping for button click handling
      messageIdToLeadCache.set(messageId, {
        leadId: lead.id,
        customerId: customer.id,
        customerName: `${customer.first_name} ${customer.last_name}`,
        timestamp: Date.now(),
      });
      console.log(
        `[CRM] ✅ mts_summary template sent successfully to ${sanitizedPhone} for lead ${lead.id}. Message ID: ${messageId}`,
      );
    } else {
      console.log(
        `[CRM] ✅ mts_summary template sent successfully to ${sanitizedPhone} for lead ${lead.id} (no message ID in response).`,
      );
    }
    await logLeadActivity(
      lead.id,
      "Summary Sent",
      `Welcome/confirmation template (mts_summary) sent to customer "${customer.first_name} ${customer.last_name}" via WhatsApp.`,
    );
  } else {
    console.error(
      `[CRM] ❌ Failed to send mts_summary template for lead ${lead.id} to ${sanitizedPhone}. Template may not be approved or phone number invalid.`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Failed",
      `Failed to send welcome/confirmation template (mts_summary) to customer "${customer.first_name} ${customer.last_name}" at ${sanitizedPhone}. Template may not be approved in Meta Business Manager.`,
    );
    return false;
  }

  return true; // Success
}

async function sendStaffAssignmentNotification(
  lead,
  customer,
  assignee,
  assigneeType,
  primaryAssigneeName = null,
  specificService = null,
) {
  console.log(
    `[CRM] Preparing staff notification for ${assignee.name} (Type: ${assigneeType}, Lead: ${lead.id})`,
  );

  if (!customer) {
    console.error(
      `[CRM] Cannot send staff notification: Customer data missing for lead ${lead.id}`,
    );
    return;
  }

  if (!assignee.phone) {
    console.log(
      `[CRM] ⚠️ Staff alert not sent for lead ${lead.id}: No phone number found for staff ${assignee.name}.`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Skipped",
      `Assignment notification not sent to staff "${assignee.name}" (no phone number).`,
      "System",
    );
    return;
  }

  let message = "";
  const customerPhoneRaw = customer.phone || "";
  const customerPhoneSanitized = customerPhoneRaw.replace(/\s/g, ""); // Sanitize phone number for the URL

  // Generate MTS- format lead number (same format as in sendWelcomeWhatsapp)
  const today = new Date();
  const leadNumber = `MTS-${lead.id}${String(today.getDate()).padStart(
    2,
    "0",
  )}${String(today.getMonth() + 1).padStart(2, "0")}${String(
    today.getFullYear(),
  ).slice(-2)}`;

  // Services that don't require destination/travel date
  const nonTravelServices = ["Forex", "Passport", "Transport"];
  const hasNonTravelService = lead.services?.some((s) =>
    nonTravelServices.includes(s),
  );
  const hasTravelService = lead.services?.some(
    (s) => !nonTravelServices.includes(s),
  );

  if (assigneeType === "primary") {
    const totalAdults = (lead.requirements?.rooms || []).reduce(
      (sum, room) => sum + room.adults,
      0,
    );
    const totalChildren = (lead.requirements?.rooms || []).reduce(
      (sum, room) => sum + room.children,
      0,
    );
    const allServices = (lead.services || []).join(", ") || "N/A";

    // Build message parts conditionally based on service type
    const messageParts = [
      `*New Lead Assigned!* 🚀`,
      ``,
      `*Lead Number:* ${leadNumber}`,
      `*Services:* ${allServices}`,
      `*Customer:* ${customer.first_name} ${customer.last_name}`,
      `*Phone:* ${customer.phone}`,
    ];

    // Only show destination if it's a travel-related service
    if (hasTravelService && lead.destination && lead.destination !== "N/A") {
      messageParts.push(`*Destination:* ${lead.destination}`);
    }

    // Only show travel date if it's a travel-related service
    if (hasTravelService && lead.travel_date) {
      messageParts.push(
        `*Travel Date:* ${new Date(lead.travel_date).toLocaleDateString(
          "en-GB",
        )}`,
      );
    }

    // Only show passengers if it's a travel-related service
    if (hasTravelService && (totalAdults > 0 || totalChildren > 0)) {
      messageParts.push(
        `*Passengers:* ${totalAdults} Adults, ${totalChildren} Children`,
      );
    }

    // Build customer enquiry summary
    let enquirySummary = "";
    if (lead.summary && lead.summary.trim()) {
      enquirySummary = `\n\n*Customer Enquiry Summary:*\n${lead.summary}`;
    } else {
      // Fallback: create a basic summary from available data
      const summaryParts = [];
      if (hasTravelService && lead.destination && lead.destination !== "N/A") {
        summaryParts.push(`Travel to ${lead.destination}`);
      }
      if (hasTravelService && lead.travel_date) {
        summaryParts.push(
          `on ${new Date(lead.travel_date).toLocaleDateString("en-GB")}`,
        );
      }
      if (allServices) {
        summaryParts.push(`for ${allServices}`);
      }
      if (summaryParts.length > 0) {
        enquirySummary = `\n\n*Customer Enquiry Summary:*\n${summaryParts.join(
          " ",
        )}`;
      }
    }

    message = messageParts.join("\n") + enquirySummary;
  } else {
    // Secondary assignee
    const destinationText =
      hasTravelService && lead.destination && lead.destination !== "N/A"
        ? ` to *${lead.destination}*`
        : "";
    message = `*New Task Assigned!* 🛂\n\nYou've been assigned the *${specificService}* service for Lead ${leadNumber}${destinationText}.\n\nPlease coordinate with the primary agent, *${primaryAssigneeName}*, to process this request.`;
  }

  const initiateCallUrl = `https://api.maduratravel.com/api/initiate-call?leadId=${lead.id}&staffId=${assignee.id}&phone=${customerPhoneSanitized}`;

  // Use normalizePhone function for better phone number handling
  let sanitizedAssigneePhone = normalizePhone(assignee.phone, "IN");

  // Fallback: if normalizePhone fails, try manual cleanup for common formats
  if (!sanitizedAssigneePhone && assignee.phone) {
    const phoneStr = String(assignee.phone).trim();
    // Remove spaces and common separators
    const cleaned = phoneStr.replace(/[\s\-\(\)]/g, "");
    // If it's already in +91 format or starts with 91, use it
    if (cleaned.startsWith("+91") || cleaned.startsWith("919")) {
      sanitizedAssigneePhone = cleaned.startsWith("+")
        ? cleaned
        : `+${cleaned}`;
      console.log(
        `[CRM] Manual phone normalization for staff ${assignee.name}: ${assignee.phone} → ${sanitizedAssigneePhone}`,
      );
    } else if (cleaned.length === 10) {
      // 10 digits - assume India
      sanitizedAssigneePhone = `+91${cleaned}`;
      console.log(
        `[CRM] Manual phone normalization (10 digits) for staff ${assignee.name}: ${assignee.phone} → ${sanitizedAssigneePhone}`,
      );
    } else if (cleaned.length > 10 && cleaned.length <= 15) {
      // International number - try adding + prefix
      sanitizedAssigneePhone = cleaned.startsWith("+")
        ? cleaned
        : `+${cleaned}`;
      console.log(
        `[CRM] Manual phone normalization (international) for staff ${assignee.name}: ${assignee.phone} → ${sanitizedAssigneePhone}`,
      );
    }
  }

  if (sanitizedAssigneePhone) {
    console.log(
      `[CRM] Attempting to send assignment alert to ${assignee.name} at ${sanitizedAssigneePhone} (original: ${assignee.phone}).`,
    );

    let result = null;

    // Try sending via WhatsApp template first
    try {
      if (assigneeType === "primary") {
        // Use staff_lead_assigned template for primary assignments
        const templatePayload = {
          messaging_product: "whatsapp",
          to: sanitizedAssigneePhone,
          type: "template",
          template: {
            name: "staff_lead_assigned",
            language: { code: "en" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: leadNumber },
                  {
                    type: "text",
                    text: (lead.services || []).join(", ") || "N/A",
                  },
                  {
                    type: "text",
                    text: `${customer.first_name} ${customer.last_name}`,
                  },
                  { type: "text", text: customer.phone },
                  {
                    type: "text",
                    text:
                      lead.destination && lead.destination !== "N/A"
                        ? lead.destination
                        : "N/A",
                  },
                  {
                    type: "text",
                    text: lead.travel_date
                      ? new Date(lead.travel_date).toLocaleDateString("en-GB")
                      : "N/A",
                  },
                ],
              },
              {
                type: "button",
                sub_type: "url",
                index: 0,
                parameters: [{ type: "text", text: initiateCallUrl }],
              },
            ],
          },
        };

        console.log(
          `[CRM] 📤 Sending staff_lead_assigned template to ${sanitizedAssigneePhone}`,
        );
        const response = await fetch(WHATSAPP_GRAPH_API_BASE, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(templatePayload),
        });

        const apiResult = await response.json();
        console.log(
          `[CRM] 📋 Full WhatsApp API Response for ${assignee.name}:`,
          JSON.stringify(apiResult, null, 2),
        );

        if (response.ok && apiResult.messages) {
          result = apiResult;
          const messageId = apiResult.messages[0]?.id;
          console.log(
            `[CRM] ✅ Template message sent successfully to ${assignee.name} (${sanitizedAssigneePhone}). Message ID: ${messageId}`,
          );

          // Log warning if there are any issues in the response
          if (apiResult.messages[0]?.message_status) {
            console.log(
              `[CRM] ⚠️ Message status: ${apiResult.messages[0].message_status}`,
            );
          }
        } else {
          const errorDetails = apiResult.error || apiResult;
          // Check for token expiration (error code 190)
          if (
            errorDetails.code === 190 ||
            errorDetails.type === "OAuthException"
          ) {
            console.error(
              `[CRM] 🔴 TOKEN EXPIRED: WhatsApp token has expired!`,
              errorDetails.message || "",
            );
            console.error(
              `[CRM] ⚠️ Action required: Generate a new token and update WHATSAPP_TOKEN environment variable`,
            );
          }
          console.error(
            `[CRM] ❌ Template message failed for ${
              assignee.name
            } (${sanitizedAssigneePhone}). Status: ${
              response.status
            }, Error: ${JSON.stringify(errorDetails, null, 2)}`,
          );
          throw new Error(
            `WhatsApp API error: ${JSON.stringify(errorDetails)}`,
          );
        }
      } else {
        // Use staff_task_assigned template for secondary assignments
        const templatePayload = {
          messaging_product: "whatsapp",
          to: sanitizedAssigneePhone,
          type: "template",
          template: {
            name: "staff_task_assigned",
            language: { code: "en" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: specificService || "Task" },
                  { type: "text", text: leadNumber },
                  {
                    type: "text",
                    text: primaryAssigneeName || "Primary Agent",
                  },
                ],
              },
              {
                type: "button",
                sub_type: "url",
                index: 0,
                parameters: [{ type: "text", text: initiateCallUrl }],
              },
            ],
          },
        };

        console.log(
          `[CRM] 📤 Sending staff_task_assigned template to ${assignee.name} (${sanitizedAssigneePhone})`,
        );
        const response = await fetch(WHATSAPP_GRAPH_API_BASE, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(templatePayload),
        });

        const apiResult = await response.json();
        console.log(
          `[CRM] 📋 Full WhatsApp API Response for ${assignee.name}:`,
          JSON.stringify(apiResult, null, 2),
        );

        if (response.ok && apiResult.messages) {
          result = apiResult;
          const messageId = apiResult.messages[0]?.id;
          console.log(
            `[CRM] ✅ Template message sent successfully to ${assignee.name} (${sanitizedAssigneePhone}). Message ID: ${messageId}`,
          );

          // Log warning if there are any issues in the response
          if (apiResult.messages[0]?.message_status) {
            console.log(
              `[CRM] ⚠️ Message status: ${apiResult.messages[0].message_status}`,
            );
          }
        } else {
          const errorDetails = apiResult.error || apiResult;
          // Check for token expiration (error code 190)
          if (
            errorDetails.code === 190 ||
            errorDetails.type === "OAuthException"
          ) {
            console.error(
              `[CRM] 🔴 TOKEN EXPIRED: WhatsApp token has expired!`,
              errorDetails.message || "",
            );
            console.error(
              `[CRM] ⚠️ Action required: Generate a new token and update WHATSAPP_TOKEN environment variable`,
            );
          }
          console.error(
            `[CRM] ❌ Template message failed for ${
              assignee.name
            } (${sanitizedAssigneePhone}). Status: ${
              response.status
            }, Error: ${JSON.stringify(errorDetails, null, 2)}`,
          );
          throw new Error(
            `WhatsApp API error: ${JSON.stringify(errorDetails)}`,
          );
        }
      }
    } catch (templateError) {
      console.warn(
        `[CRM] ⚠️ Template message failed for ${assignee.name}. Trying plain text fallback:`,
        templateError.message,
      );
      // Fallback: Send as plain text WITHOUT URL (template should have the button)
      result = await sendCrmWhatsappText(sanitizedAssigneePhone, message);

      if (!result) {
        console.error(
          `[CRM] ❌ Both template and fallback failed for ${assignee.name} (${sanitizedAssigneePhone}). Original error: ${templateError.message}`,
        );
      }
    }

    // Check if result actually contains a message ID (real success)
    if (result) {
      const messageId = result.messages?.[0]?.id;
      if (messageId) {
        // Store message ID -> lead ID mapping for failure tracking
        messageIdToLeadCache.set(messageId, {
          leadId: lead.id,
          staffName: assignee.name,
          staffPhone: sanitizedAssigneePhone,
          timestamp: Date.now(),
        });

        await logLeadActivity(
          lead.id,
          "Summary Sent to Staff",
          `Assignment summary sent to staff "${assignee.name}" (${sanitizedAssigneePhone}) via WhatsApp.`,
          "System",
        );
        console.log(
          `[CRM] ✅ Successfully sent assignment notification to ${assignee.name} for lead ${lead.id}. WhatsApp Message ID: ${messageId}`,
        );
      } else {
        // Result exists but no message ID - might be a false positive
        const errorMsg = `WhatsApp API returned result but no message ID for staff "${
          assignee.name
        }" (${sanitizedAssigneePhone}). Response: ${JSON.stringify(result)}`;
        await logLeadActivity(lead.id, "WhatsApp Failed", errorMsg, "System");
        console.error(`[CRM] ❌ ${errorMsg}`);
      }
    } else {
      const errorMsg = `Failed to send assignment notification to staff "${assignee.name}" (${sanitizedAssigneePhone}). Template may not be approved, phone number invalid, or WhatsApp API error. Check server logs for details.`;
      await logLeadActivity(lead.id, "WhatsApp Failed", errorMsg, "System");
      console.error(`[CRM] ❌ ${errorMsg}`);
    }
  } else {
    console.log(
      `[CRM] ⚠️ Staff alert not sent for lead ${lead.id}: Invalid phone number for staff ${assignee.name}.`,
    );
    await logLeadActivity(
      lead.id,
      "WhatsApp Skipped",
      `Assignment notification not sent to staff "${assignee.name}" (invalid phone number).`,
    );
  }
}

// NOTE: TBO Flight API logic and endpoints removed from this codebase.
// The file preserves other integrations (website forms, WhatsApp webhooks, Razorpay,
// emailing suppliers, and AI itinerary generation). If you need to re-enable the
// flight provider proxy later, reintroduce a dedicated service module with secure
// credential management.

// --- SETTINGS API (for AI Toggle) ---
// B1: In-memory cache for GET settings (2 min TTL) to reduce DB load
const settingsCache = new Map();
const SETTINGS_CACHE_TTL_MS = 2 * 60 * 1000;

function getCachedSetting(key) {
  const entry = settingsCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.value;
}

function setCachedSetting(key, value) {
  settingsCache.set(key, {
    value,
    expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
  });
}

function invalidateCachedSetting(key) {
  settingsCache.delete(key);
}

app.get("/api/settings/:key", requireAuth, async (req, res) => {
  const { key } = req.params;
  const currentUser = req.user;

  if (currentUser.role !== "Super Admin") {
    return res
      .status(403)
      .json({ message: "Forbidden: Super Admin access required." });
  }

  const cached = getCachedSetting(key);
  if (cached !== null) {
    return res.json(cached);
  }

  try {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", key)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    const value = data?.value;
    let out;
    if (typeof value === "string") {
      try {
        out = JSON.parse(value);
      } catch {
        out = value;
      }
    } else {
      out = value ?? false;
    }
    setCachedSetting(key, out);
    res.json(out);
  } catch (error) {
    console.error(`[Settings] Error fetching setting ${key}:`, error);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/settings/:key", requireAuth, async (req, res) => {
  const currentUser = req.user;

  if (currentUser.role !== "Super Admin") {
    return res
      .status(403)
      .json({ message: "Forbidden: Super Admin access required." });
  }

  const { key } = req.params;
  const { value } = req.body;
  try {
    const { data, error } = await supabase
      .from("settings")
      .upsert({ key, value: JSON.stringify(value) }, { onConflict: "key" })
      .select();
    if (error) throw error;
    invalidateCachedSetting(key);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// NOTE: TBO (flight provider) endpoints removed. Flight search/booking proxy
// was intentionally eliminated from this codebase to avoid storing or proxying
// third-party flight provider credentials. If you need a flight provider
// integration, add a dedicated service module with secure credential handling.

// Helper function to search airports in database
async function searchAirportsInDB(query, limit = 20) {
  try {
    const searchTerm = query.toLowerCase().trim();
    const { data, error } = await supabase
      .from("airports")
      .select("code, name, city, country, country_code")
      .or(
        `code.ilike.%${searchTerm}%,name.ilike.%${searchTerm}%,city.ilike.%${searchTerm}%`,
      )
      .limit(limit);

    if (error) {
      console.error("[Airports] DB search error:", error.message);
      return [];
    }

    // Update last_searched_at for found airports
    if (data && data.length > 0) {
      const codes = data.map((a) => a.code);
      await supabase
        .from("airports")
        .update({ last_searched_at: new Date().toISOString() })
        .in("code", codes);
    }

    return (
      data?.map((a) => ({
        code: a.code,
        name: a.name,
        city: a.city || "",
        country: a.country || "",
      })) || []
    );
  } catch (err) {
    console.error("[Airports] Error searching DB:", err.message);
    return [];
  }
}

// Helper function to store airports in database
async function storeAirportsInDB(airports, source = "amadeus") {
  if (!airports || airports.length === 0) return;

  try {
    const airportsToInsert = airports
      .filter((a) => a.code && a.code.length >= 3)
      .map((airport) => ({
        code: airport.code.toUpperCase(),
        name: airport.name || "",
        city: airport.city || "",
        country: airport.country || "",
        country_code: airport.countryCode || airport.country_code || null,
        source: source,
        search_keywords: [
          airport.code?.toLowerCase(),
          airport.name?.toLowerCase(),
          airport.city?.toLowerCase(),
          airport.country?.toLowerCase(),
        ].filter(Boolean),
        last_searched_at: new Date().toISOString(),
      }));

    // Use upsert to avoid duplicates (on conflict with code)
    const { error } = await supabase.from("airports").upsert(airportsToInsert, {
      onConflict: "code",
      ignoreDuplicates: false, // Update existing records
    });

    if (error) {
      console.error("[Airports] Error storing in DB:", error.message);
    } else {
      console.log(
        `[Airports] ✅ Stored ${airportsToInsert.length} airports in DB (source: ${source})`,
      );
    }
  } catch (err) {
    console.error("[Airports] Error in storeAirportsInDB:", err.message);
  }
}

// --- TBO FLIGHT SEARCH & AUTOCOMPLETE ---
app.get("/api/airports", requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 30);

    if (!q || q.trim().length < 2) {
      return res
        .status(400)
        .json({ message: "Query parameter 'q' (min 2 chars) is required." });
    }

    const query = q.trim();
    const cacheKey = `${query.toLowerCase()}|${limit}`;

    // Check in-memory cache first (fastest)
    const cached = getCached(airportSearchCache, cacheKey);
    if (cached) {
      return res.json({ airports: cached, cached: true, source: "memory" });
    }

    let airports = [];
    let source = "unknown";

    // Step 1: Search in Database (saves API tokens)
    airports = await searchAirportsInDB(query, limit);
    if (airports.length > 0) {
      source = "database";
      setCache(airportSearchCache, cacheKey, airports, AIRPORT_CACHE_TTL);
      return res.json({ airports, cached: false, source: "database" });
    }

    // Step 2: Try TBO API (if available)
    try {
      const tboAirports = await searchTboAirports(query);
      if (tboAirports && tboAirports.length > 0) {
        airports = tboAirports.slice(0, limit);
        source = "tbo";

        // Store in DB for future use
        await storeAirportsInDB(airports, "tbo");
        setCache(airportSearchCache, cacheKey, airports, AIRPORT_CACHE_TTL);
        return res.json({ airports, cached: false, source: "tbo" });
      }
    } catch (tboError) {
      // TBO airport search may not be available (404), continue to Amadeus
      console.log("[Airports] TBO search not available, trying Amadeus...");
    }

    // Step 3: Fallback to Amadeus API
    try {
      const data = await searchLocations(query, { pageLimit: limit });
      airports = (data.data || [])
        .map((loc) => ({
          code: loc.iataCode || "",
          name: loc.name || "",
          city: loc.address?.cityName || loc.name || "",
          country: loc.address?.countryName || "",
          countryCode: loc.address?.countryCode || "",
        }))
        .filter((a) => a.code && a.code.length >= 3)
        .slice(0, limit);

      if (airports.length > 0) {
        source = "amadeus";

        // Store in DB for future use (saves tokens on next search)
        await storeAirportsInDB(airports, "amadeus");
        setCache(airportSearchCache, cacheKey, airports, AIRPORT_CACHE_TTL);
      }
    } catch (error) {
      console.error("[Airports] Amadeus search error:", error.message || error);
      airports = [];
    }

    res.json({ airports, cached: false, source });
  } catch (error) {
    console.error("Error in /api/airports:", error.message || error);
    res.status(500).json({
      message: error.message || "Failed to search airports/cities.",
    });
  }
});

// --- TBO HOTEL CITY SEARCH (AUTOCOMPLETE) ---
app.get("/api/hotels/cities", requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 30);

    if (!q || q.trim().length < 2) {
      return res
        .status(400)
        .json({ message: "Query parameter 'q' (min 2 chars) is required." });
    }

    const query = q.trim();
    const cacheKey = `hotel-${query.toLowerCase()}|${limit}`;
    const cached = getCached(airportSearchCache, cacheKey); // Reuse airport cache for hotel cities
    if (cached) {
      return res.json({ cities: cached, cached: true });
    }

    // Try TBO hotel city search
    let cities = [];
    try {
      cities = await searchTboHotelCities(query);

      // Limit results
      if (cities.length > limit) {
        cities = cities.slice(0, limit);
      }

      // Cache the results if we got data
      if (cities.length > 0) {
        setCache(airportSearchCache, cacheKey, cities, AIRPORT_CACHE_TTL);
      }
    } catch (error) {
      // TBO hotel city search failed - try database lookup from tbo_cities table
      try {
        console.log(
          `[Hotels] TBO city search API not available, using database lookup`,
        );
        const { data: dbCities, error: dbError } = await supabase
          .from("tbo_cities")
          .select("code, name, country_code, tbo_countries!inner(name)")
          .ilike("name", `%${query}%`)
          .limit(limit);

        if (!dbError && dbCities && dbCities.length > 0) {
          cities = dbCities.map((c) => ({
            code: String(c.code),
            name: c.name,
            country: c.tbo_countries?.name || "",
            countryCode: c.country_code || "",
          }));
          if (cities.length > 0) {
            setCache(airportSearchCache, cacheKey, cities, AIRPORT_CACHE_TTL);
          }
        } else {
          console.log(
            `[Hotels] No cities found in database for query: ${query}`,
          );
        }
      } catch (dbError) {
        console.error(
          "[Hotels] Database city lookup failed:",
          dbError.message || dbError,
        );
        cities = [];
      }
    }

    res.json({ cities, cached: false });
  } catch (error) {
    console.error("Error in /api/hotels/cities:", error.message || error);
    res.status(500).json({
      message: error.message || "Failed to search hotel cities.",
    });
  }
});

app.get("/api/flight-search", requireAuth, async (req, res) => {
  try {
    const { from, to, date, returnDate } = req.query;

    if (!from || !to || !date) {
      return res.status(400).json({
        message:
          "Missing required params. from, to (IATA codes or city), and date (YYYY-MM-DD) are required.",
      });
    }

    const originLocationCode = from.toString().trim().toUpperCase();
    const destinationLocationCode = to.toString().trim().toUpperCase();
    const departureDate = date.toString().trim();
    const adults = Math.max(parseInt(req.query.adults || "1", 10) || 1, 1);
    const children = Math.max(parseInt(req.query.children || "0", 10) || 0, 0);
    const infants = Math.max(parseInt(req.query.infants || "0", 10) || 0, 0);
    const currencyCode = (req.query.currency || "INR").toString().toUpperCase();
    const travelClass = (req.query.travelClass || "ECONOMY")
      .toString()
      .toUpperCase();
    const nonStop =
      req.query.nonStop === "true" || req.query.nonStop === "1" ? true : false;
    const max = Math.min(parseInt(req.query.max || "20", 10) || 20, 50);

    const cacheKey = JSON.stringify({
      originLocationCode,
      destinationLocationCode,
      departureDate,
      returnDate: returnDate || null,
      adults,
      children,
      infants,
      currencyCode,
      travelClass,
      nonStop,
      max,
    });

    const cached = getCached(flightSearchCache, cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    // Call both Amadeus and TBO in parallel
    const amadeusPromise = (async () => {
      try {
        const amadeusData = await searchFlightOffers({
          originLocationCode,
          destinationLocationCode,
          departureDate,
          returnDate,
          adults,
          children,
          infants,
          currencyCode,
          travelClass,
          nonStop,
          max,
        });
        return { ok: true, data: amadeusData };
      } catch (error) {
        console.error(
          "[Flight Search] Amadeus failed:",
          error.message || error,
        );
        return { ok: false, error };
      }
    })();

    const tboPromise = (async () => {
      try {
        if (
          !process.env.TBO_AUTH_URL ||
          !process.env.TBO_AIR_SEARCH_URL ||
          !process.env.TBO_CLIENT_ID
        ) {
          return { ok: false, skipped: true };
        }
        const tboParams = {
          segments: [
            {
              from: originLocationCode,
              to: destinationLocationCode,
              date: departureDate,
            },
          ],
          tripType: returnDate ? "roundtrip" : "oneway",
          returnDate: returnDate || null,
          passengers: { adults, children, infants },
          cabin: travelClass,
          directFlights: nonStop,
          currency: currencyCode,
          max: max,
        };
        const tboData = await searchTboFlights(tboParams);
        return { ok: true, data: tboData };
      } catch (error) {
        console.error("[Flight Search] TBO failed:", error.message || error);
        return { ok: false, error };
      }
    })();

    // Wait for both to complete in parallel
    const [amadeusResult, tboResult] = await Promise.all([
      amadeusPromise,
      tboPromise,
    ]);

    // Use Amadeus data if available, otherwise return empty (TBO results should come from /api/flights/search)
    let data = null;
    if (amadeusResult.ok && amadeusResult.data) {
      data = amadeusResult.data;
    } else if (tboResult.ok && tboResult.data) {
      // TBO succeeded but Amadeus failed - return empty Amadeus format
      // Frontend should use /api/flights/search for TBO results
      data = {
        data: [],
        dictionaries: {
          carriers: {},
          locations: {},
        },
        meta: {
          count: 0,
          traceId: tboResult.data.traceId || "tbo-fallback",
        },
      };
    } else {
      // Both failed
      const errorMsg =
        amadeusResult.error?.message ||
        tboResult.error?.message ||
        "Both Amadeus and TBO failed";
      throw new Error(errorMsg);
    }

    setCache(flightSearchCache, cacheKey, data, FLIGHT_CACHE_TTL);
    res.json({ ...data, cached: false });
  } catch (error) {
    console.error("Error in /api/flight-search:", error.message || error);
    res.status(500).json({
      message: error.message || "Failed to search flights.",
    });
  }
});

// --- HOTEL SEARCH (VIEW-ONLY) - TBO Only ---
// This endpoint uses TBO Hotel API for search.
// It does NOT perform any booking - view-only for CRM display.
app.get("/api/hotels/search", requireAuth, async (req, res) => {
  try {
    const {
      city,
      hotelCodes, // NEW: Accept hotelCodes directly (comma-separated list)
      checkIn,
      checkOut,
      nationality,
      searchTerm,
      rooms,
      stars,
    } = req.query;

    // Either city OR hotelCodes must be provided
    if (!city && !hotelCodes) {
      return res.status(400).json({
        message:
          "Missing required params. Either 'city' or 'hotelCodes' (comma-separated) is required, along with checkIn and checkOut.",
      });
    }

    if (!checkIn || !checkOut) {
      return res.status(400).json({
        message: "Missing required params. checkIn and checkOut are required.",
      });
    }

    // Parse rooms JSON
    let parsedRooms = [{ adults: 2, children: 0, childAges: [] }];
    if (rooms) {
      try {
        parsedRooms = JSON.parse(rooms);
      } catch {
        // ignore parse errors, use default
      }
    }

    let starFilter = [];
    if (stars) {
      starFilter = String(stars)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    }

    // Calculate nights
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const nights = Math.ceil(
      (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const totalAdults = parsedRooms.reduce(
      (sum, r) => sum + (r.adults || 0),
      0,
    );

    // Use only TBO for hotel search (as requested)
    let tboResult;
    try {
      tboResult = await searchTboHotels({
        city: city || undefined, // Only pass city if provided
        hotelCodes: hotelCodes || undefined, // Pass hotelCodes if provided directly
        checkIn,
        checkOut,
        rooms: parsedRooms,
        nationality: nationality || "IN",
        countryCode: nationality || "IN", // Use nationality as country code for city filtering
        searchTerm,
        starRatings: starFilter,
      });
    } catch (err) {
      // If TBO_HOTEL_SEARCH_URL is not configured, throw error
      if (err.message?.includes("TBO_HOTEL_SEARCH_URL is not configured")) {
        logger.error(
          "[Hotels] TBO hotel search not configured. Please set TBO_HOTEL_SEARCH_URL in environment.",
        );
        throw new Error(
          "TBO Hotel search is not configured. Please contact administrator.",
        );
      } else {
        logger.error("[Hotels] TBO search error:", err.message || err);
        throw err;
      }
    }

    // TBO only - no Amadeus fallback
    logger.info(
      `[Hotels] TBO: Retrieved ${
        (tboResult.results || []).length
      } hotel results`,
    );

    // Normalize TBO results (TBO only - no Amadeus)
    const normalizedResults = [];

    // Process TBO results
    // GetHotelResult response structure (per documentation):
    // HotelResult array, each with: HotelCode, Currency, Rooms array
    // Each Room has: Name[], BookingCode, TotalFare, TotalTax, IsRefundable, CancelPolicies, etc.
    if (tboResult && tboResult.results) {
      let loggedFirstHotel = false;
      // Recursively collect any string that looks like an image URL from an object (for unknown TBO shapes)
      function collectImageUrls(obj, out, seen) {
        if (!obj || typeof obj !== "object" || seen.has(obj)) return;
        seen.add(obj);
        if (Array.isArray(obj)) {
          obj.forEach((item) => collectImageUrls(item, out, seen));
          return;
        }
        for (const key of Object.keys(obj)) {
          const v = obj[key];
          if (
            typeof v === "string" &&
            /^https?:\/\//i.test(v) &&
            v.length < 1024
          ) {
            out.add(v.trim());
          } else if (typeof v === "object" && v !== null) {
            collectImageUrls(v, out, seen);
          }
        }
      }

      tboResult.results.forEach((hotel) => {
        // Log first hotel's top-level keys once to debug missing images
        if (!loggedFirstHotel) {
          loggedFirstHotel = true;
          const keys = Object.keys(hotel).filter((k) =>
            /image|picture|photo|thumb|url|img/i.test(k),
          );
          logger.info(
            "[Hotels] TBO first hotel image-related keys: " +
              (keys.length ? keys.join(", ") : "none") +
              " | all keys: " +
              Object.keys(hotel).slice(0, 25).join(", "),
          );
        }

        // GetHotelResult uses "Rooms" array (per documentation)
        const rooms = hotel.Rooms || hotel.Room || hotel.HotelRooms || [];

        if (rooms.length === 0) {
          // Skip hotels with no available rooms
          return;
        }

        // Find the cheapest room (lowest TotalFare)
        const cheapestRoom = rooms.reduce((cheapest, room) => {
          const roomFare = room.TotalFare || 0;
          const cheapestFare = cheapest.TotalFare || 0;
          return roomFare > 0 && (cheapestFare === 0 || roomFare < cheapestFare)
            ? room
            : cheapest;
        }, rooms[0]);

        // Extract price from Room structure
        const totalFare = cheapestRoom.TotalFare || 0;
        const totalTax = cheapestRoom.TotalTax || 0;
        const currency = hotel.Currency || "INR";

        // Room name is an array - get first one
        const roomName = Array.isArray(cheapestRoom.Name)
          ? cheapestRoom.Name[0]
          : cheapestRoom.Name || "Standard Room";

        const rawStar = hotel.StarRating ?? hotel.Rating ?? hotel.HotelRating;
        const starRating =
          rawStar != null && rawStar !== ""
            ? parseInt(String(rawStar), 10)
            : null;
        const starNum = Number.isNaN(starRating) ? null : starRating;

        const totalPriceNum = Number(totalFare) + Number(totalTax);
        const totalPrice = Number.isFinite(totalPriceNum) ? totalPriceNum : 0;
        const pricePerNight = nights > 0 ? totalPrice / nights : totalPrice;

        const hotelName =
          hotel.HotelName ||
          hotel.Hotelname ||
          hotel.Name ||
          hotel.HotelInfo?.HotelName ||
          hotel.HotelDetails?.HotelName ||
          (hotel.HotelCode ? `Hotel ${hotel.HotelCode}` : null) ||
          "Unknown Hotel";

        // TBO can return image as: HotelPicture, ImageUrl, Images[0], HotelImages[0].Url, Image.Url, etc.
        const firstImage =
          hotel.HotelPicture ||
          hotel.ImageUrl ||
          hotel.Image ||
          hotel.Picture ||
          hotel.Thumbnail ||
          (typeof hotel.HotelImage === "object" && hotel.HotelImage
            ? hotel.HotelImage.Url || hotel.HotelImage.ImageUrl
            : null) ||
          (Array.isArray(hotel.Images) && hotel.Images[0]
            ? typeof hotel.Images[0] === "string"
              ? hotel.Images[0]
              : hotel.Images[0]?.Url || hotel.Images[0]?.ImageUrl
            : null) ||
          (Array.isArray(hotel.HotelImages) && hotel.HotelImages[0]
            ? typeof hotel.HotelImages[0] === "string"
              ? hotel.HotelImages[0]
              : hotel.HotelImages[0]?.Url || hotel.HotelImages[0]?.ImageUrl
            : null) ||
          hotel.HotelInfo?.ImageUrl ||
          hotel.ResultInfo?.HotelPicture ||
          null;
        let thumbnailUrl =
          typeof firstImage === "string" && firstImage.trim()
            ? firstImage.trim()
            : null;

        // Collect up to 5 image URLs for detail gallery (main + 4 grid)
        let imageUrls = [];
        if (thumbnailUrl) imageUrls.push(thumbnailUrl);
        const extraImages = [
          ...(Array.isArray(hotel.Images) ? hotel.Images : []),
          ...(Array.isArray(hotel.HotelImages) ? hotel.HotelImages : []),
        ];
        for (const img of extraImages) {
          const url = typeof img === "string" ? img : img?.Url || img?.ImageUrl;
          if (
            url &&
            typeof url === "string" &&
            url.trim() &&
            !imageUrls.includes(url.trim())
          ) {
            imageUrls.push(url.trim());
            if (imageUrls.length >= 5) break;
          }
        }

        // Fallback: scan entire hotel object for any https URL (TBO may use non-standard field names)
        if (imageUrls.length === 0) {
          const found = new Set();
          collectImageUrls(hotel, found, new Set());
          const arr = [...found].filter(
            (u) => u.length > 10 && u.length < 1024,
          );
          if (arr.length > 0) {
            thumbnailUrl = arr[0];
            imageUrls = arr.slice(0, 5);
          }
        }

        const cancelPolicies = cheapestRoom.CancelPolicies
          ? Array.isArray(cheapestRoom.CancelPolicies)
            ? cheapestRoom.CancelPolicies
            : [cheapestRoom.CancelPolicies]
          : [];

        // Build room options for "Rooms & Rates" (all rooms, not just cheapest)
        const roomOptions = rooms.map((room, idx) => {
          const rFare = room.TotalFare || 0;
          const rTax = room.TotalTax || 0;
          const rTotal = Number(rFare) + Number(rTax);
          const rName = Array.isArray(room.Name)
            ? room.Name[0]
            : room.Name || "Room";
          const rMeal = room.MealType || room.BoardBasis || "Room Only";
          const rCancel = room.CancelPolicies
            ? Array.isArray(room.CancelPolicies)
              ? room.CancelPolicies
              : [room.CancelPolicies]
            : [];
          const penalty = rTotal; // TBO often uses total as penalty for display
          return {
            id: room.BookingCode || `room-${idx}`,
            name: rName,
            boardBasis: rMeal,
            refundable: room.IsRefundable || false,
            pricePerNight: nights > 0 ? rTotal / nights : rTotal,
            totalPrice: rTotal,
            currency: hotel.Currency || "INR",
            occupancy: {
              adults: parsedRooms.reduce((s, r) => s + (r.adults || 0), 0),
              children: parsedRooms.reduce((s, r) => s + (r.children || 0), 0),
            },
            cancelPolicies: rCancel,
            penalty,
            mealType: room.MealType || null,
            inclusion: room.Inclusion || null,
          };
        });

        normalizedResults.push({
          id: `tbo-${hotel.HotelCode || Math.random()}`,
          hotelCode: hotel.HotelCode ?? null,
          provider: "TBO",
          name: hotelName,
          city: hotel.CityName || hotel.City || city,
          country: hotel.CountryName || hotel.Country || nationality || "India",
          address: hotel.Address || hotel.Location || "",
          starRating: starNum,
          thumbnailUrl,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          pricePerNight,
          totalPrice,
          currency,
          nights,
          rooms: parsedRooms.length,
          refundable: cheapestRoom.IsRefundable || false,
          amenities:
            hotel.HotelFacilities || hotel.Amenities || hotel.Facilities || [],
          bookingCode: cheapestRoom.BookingCode || null,
          traceId: hotel.TraceId || tboResult.traceId || null,
          roomName: roomName,
          mealType: cheapestRoom.MealType || null,
          inclusion: cheapestRoom.Inclusion || null,
          cancelPolicies,
          roomOptions: roomOptions.length > 0 ? roomOptions : undefined,
        });
      });
    }

    // Resolve hotel names from DB when TBO didn't send name (e.g. "Hotel 123" or "Unknown Hotel")
    const needsNameLookup = normalizedResults.filter(
      (r) =>
        r.name === "Unknown Hotel" ||
        /^Hotel \d+$/.test(r.name) ||
        (r.name &&
          r.name.startsWith("Hotel ") &&
          /^\d+$/.test(r.name.replace(/^Hotel /, "").trim())),
    );
    if (needsNameLookup.length > 0) {
      const codes = [
        ...new Set(
          needsNameLookup
            .map((r) => (r.hotelCode != null ? String(r.hotelCode) : null))
            .filter(Boolean),
        ),
      ];
      if (codes.length > 0) {
        try {
          const { data: nameRows } = await supabase
            .from("tbo_hotel_codes")
            .select("hotel_code, hotel_name")
            .in(
              "hotel_code",
              codes.map((c) => parseInt(c, 10)).filter((n) => !Number.isNaN(n)),
            );
          const codeToName = new Map(
            (nameRows || [])
              .filter((row) => row.hotel_name && String(row.hotel_name).trim())
              .map((row) => [row.hotel_code, String(row.hotel_name).trim()]),
          );
          normalizedResults.forEach((r) => {
            if (
              (r.name === "Unknown Hotel" || /^Hotel \d+$/.test(r.name)) &&
              r.hotelCode != null
            ) {
              const dbName =
                codeToName.get(r.hotelCode) ||
                codeToName.get(Number(r.hotelCode));
              if (dbName) r.name = dbName;
            }
          });
        } catch (e) {
          logger.warn(
            "[Hotels] Hotel name lookup from tbo_hotel_codes failed:",
            e?.message,
          );
        }
      }
    }

    // Apply client-side filters
    let filtered = normalizedResults;
    if (searchTerm) {
      const term = String(searchTerm).toLowerCase();
      filtered = filtered.filter((h) => h.name.toLowerCase().includes(term));
    }
    if (starFilter.length > 0) {
      filtered = filtered.filter((h) => {
        const r =
          h.starRating != null && h.starRating !== ""
            ? parseInt(String(h.starRating), 10)
            : null;
        const num = Number.isNaN(r) ? null : r;
        // Include if rating matches filter, or if TBO didn't send rating (show results anyway)
        return (num != null && starFilter.includes(num)) || num === null;
      });
    }

    // Sort by price (lowest first)
    filtered.sort((a, b) => a.totalPrice - b.totalPrice);

    return res.json({
      results: filtered,
      traceId: tboResult?.traceId || "tbo",
    });
  } catch (error) {
    logger.error("Error in /api/hotels/search:", error.message || error);
    res.status(500).json({
      message: error.message || "Failed to search hotels.",
    });
  }
});

// Hotel details by code (images, facilities) - TBO HotelDetails API
app.get("/api/hotels/details/:hotelCode", requireAuth, async (req, res) => {
  try {
    const { hotelCode } = req.params;
    if (!hotelCode) {
      return res.status(400).json({ message: "hotelCode is required" });
    }
    logger.info(`[Hotels] Details requested for hotelCode: ${hotelCode}`);
    const details = await getTboHotelDetails(hotelCode);
    logger.info(
      `[Hotels] Details response: ${details?.imageUrls?.length ?? 0} images, ${details?.facilities?.length ?? 0} facilities`,
    );
    return res.json(details);
  } catch (err) {
    logger.warn("[Hotels] Details fetch failed:", err?.message);
    return res.status(500).json({
      message: err?.message || "Failed to fetch hotel details.",
      imageUrls: [],
      facilities: [],
    });
  }
});

// Combined flight search: Amadeus + optional TBO (search only, no booking)
app.post("/api/flights/search", requireAuth, async (req, res) => {
  try {
    const params = req.body || {};

    const firstSegment = params?.segments?.[0];
    if (!firstSegment?.from || !firstSegment?.to || !firstSegment?.date) {
      return res.status(400).json({
        message: "Missing required params: segments[0].from, to, or date.",
      });
    }

    const tripType = params.tripType || "oneway";
    const passengers = params.passengers || {};
    const cabin = (params.cabin || "ECONOMY").toString().toUpperCase();
    const directFlights = Boolean(params.directFlights);
    const currency = (params.currency || "INR").toString().toUpperCase();
    const maxTotal = Math.min(parseInt(params.max || 50, 10) || 50, 50);
    const maxPerProvider = Math.min(25, maxTotal);

    const originLocationCode = firstSegment.from.toUpperCase();
    const destinationLocationCode = firstSegment.to.toUpperCase();
    const departureDate = firstSegment.date;
    const returnDate =
      tripType === "roundtrip" ? params.returnDate || null : null;

    const adults = Math.max(Number(passengers.adults || 1), 1);
    const children = Math.max(Number(passengers.children || 0), 0);
    const infants = Math.max(Number(passengers.infants || 0), 0);

    // Call Amadeus and TBO in parallel (TBO is optional based on env)
    const amadeusPromise = (async () => {
      try {
        const amadeusData = await searchFlightOffers({
          originLocationCode,
          destinationLocationCode,
          departureDate,
          returnDate,
          adults,
          children,
          infants,
          currencyCode: currency,
          travelClass: cabin,
          nonStop: directFlights,
          max: maxPerProvider,
        });

        const offers = amadeusData.data || [];
        const dictionaries = amadeusData.dictionaries || {
          carriers: {},
          locations: {},
        };

        const results = (offers || []).map((offer, offerIndex) => {
          // Amadeus price.total is the TOTAL for ALL passengers, so divide by passenger count
          const totalFare = parseFloat(
            (offer.price && (offer.price.total || offer.price.grandTotal)) ||
              "0",
          );
          const totalPassengers = adults + children + infants;
          const fare =
            totalPassengers > 0 ? totalFare / totalPassengers : totalFare;

          const segmentsPerItinerary = (offer.itineraries || []).map((it) =>
            (it.segments || []).map((seg, segIndex) => {
              const dep = seg.departure || {};
              const arr = seg.arrival || {};
              const carrierCode = seg.carrierCode || "XX";
              let airlineName = dictionaries.carriers?.[carrierCode];
              if (!airlineName) {
                const airlineMap = {
                  AI: "Air India",
                  "6E": "IndiGo",
                  SG: "SpiceJet",
                  G8: "GoAir",
                  UK: "Vistara",
                  IX: "Air India Express",
                  I5: "AirAsia India",
                  QP: "Alliance Air",
                  "9W": "Jet Airways",
                  S2: "JetLite",
                };
                airlineName = airlineMap[carrierCode] || carrierCode;
              }
              return {
                Airline: {
                  AirlineCode: carrierCode,
                  AirlineName: airlineName,
                  FlightNumber: seg.number || `${carrierCode}${segIndex + 1}`,
                },
                Origin: {
                  Airport: {
                    AirportCode: dep.iataCode || "",
                    AirportName: dep.iataCode || "",
                    Terminal: dep.terminal || null,
                    CityCode: "",
                    CityName: "",
                    CountryCode: "",
                    CountryName: "",
                  },
                  DepTime: dep.at || "",
                },
                Destination: {
                  Airport: {
                    AirportCode: arr.iataCode || "",
                    AirportName: arr.iataCode || "",
                    Terminal: arr.terminal || null,
                    CityCode: "",
                    CityName: "",
                    CountryCode: "",
                    CountryName: "",
                  },
                  ArrTime: arr.at || "",
                },
                Duration: parseIsoDurationToMinutes(seg.duration),
                GroundTime: 0,
                Remark: undefined,
              };
            }),
          );

          return {
            Source: "Amadeus",
            ResultIndex: offer.id || `offer-${offerIndex}`,
            Fare: { PublishedFare: fare },
            Segments: segmentsPerItinerary,
          };
        });

        return {
          ok: true,
          results,
          traceId: amadeusData.meta?.traceId || "amadeus",
        };
      } catch (err) {
        console.error("[Flights] Amadeus search error:", err.message || err);
        return { ok: false, error: err };
      }
    })();

    const tboPromise = (async () => {
      try {
        if (
          !process.env.TBO_AUTH_URL ||
          !process.env.TBO_AIR_SEARCH_URL ||
          !process.env.TBO_CLIENT_ID
        ) {
          return { ok: false, skipped: true };
        }
        const tboParams = {
          ...params,
          passengers: { adults, children, infants },
          cabin,
          directFlights,
          currency,
          max: maxPerProvider,
        };
        const data = await searchTboFlights(tboParams);
        const results = (data.results || []).map((r) => ({
          ...r,
          Source: "TBO",
        }));
        return { ok: true, results, traceId: data.traceId || "tbo" };
      } catch (err) {
        console.error("[Flights] TBO search error:", err.message || err);
        return { ok: false, error: err };
      }
    })();

    const [amadeusResult, tboResult] = await Promise.all([
      amadeusPromise,
      tboPromise,
    ]);

    const combinedResults = [];
    let traceId = "combined";
    let amadeusCount = 0;
    let tboCount = 0;

    if (amadeusResult.ok && Array.isArray(amadeusResult.results)) {
      const limit = Math.min(amadeusResult.results.length, maxPerProvider);
      const slice = amadeusResult.results.slice(0, limit);
      combinedResults.push(...slice);
      amadeusCount = slice.length;
      if (amadeusResult.traceId) {
        traceId = amadeusResult.traceId;
      }
    }

    if (tboResult.ok && Array.isArray(tboResult.results)) {
      const remaining = maxTotal - combinedResults.length;
      if (remaining > 0) {
        const slice = tboResult.results.slice(0, remaining);
        combinedResults.push(...slice);
        tboCount = slice.length;
      }
    }

    return res.json({
      results: combinedResults,
      traceId,
      providers: {
        amadeus: amadeusCount,
        tbo: tboCount,
      },
    });
  } catch (error) {
    console.error("Error in /api/flights/search:", error.message || error);
    res.status(500).json({
      message: error.message || "Failed to search flights.",
    });
  }
});

app.get("/api/initiate-call", async (req, res) => {
  const { leadId, staffId, phone } = req.query;

  if (!leadId || !staffId || !phone) {
    return res
      .status(400)
      .send("Missing leadId, staffId, or phone query parameter.");
  }

  try {
    // Fetch staff name
    const { data: staff, error: staffError } = await supabase
      .from("staff")
      .select("name")
      .eq("id", staffId)
      .single();

    if (staffError || !staff) {
      throw new Error(
        staffError?.message || `Staff with ID ${staffId} not found.`,
      );
    }

    // Fetch lead's current activity
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("activity")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      throw new Error(
        leadError?.message || `Lead with ID ${leadId} not found.`,
      );
    }

    // Create and add new activity log
    const newActivity = {
      id: Date.now(),
      type: "Call Logged",
      description: `${staff.name} has initiated the call.`,
      user: staff.name,
      timestamp: new Date().toISOString(),
    };
    const updatedActivity = [newActivity, ...(lead.activity || [])];

    // Update the lead
    const { error: updateError } = await supabase
      .from("leads")
      .update({
        activity: updatedActivity,
        last_updated: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (updateError) {
      throw new Error(`Failed to log activity: ${updateError.message}`);
    }

    console.log(
      `[CRM] Logged call initiation for lead ${leadId} by ${staff.name}.`,
    );

    // Redirect to tel: link
    const sanitizedPhone = phone.replace(/[^0-9+]/g, ""); // Keep + and numbers
    res.redirect(`tel:${sanitizedPhone}`);
  } catch (error) {
    console.error("Error in /api/initiate-call:", error.message);
    res.status(500).send(`An error occurred: ${error.message}`);
  }
});

// --- PUBLIC STAFF LIST FOR WEBSITE (Branch 1) ---
// Returns minimal staff info for populating the staff dropdown in the website form.
app.get("/api/staff/branch/1", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("staff")
      .select("id, name, phone, branch_id, status, role_id")
      .eq("branch_id", 1)
      .eq("status", "Active")
      .neq("role_id", 1) // Exclude Super Admins
      .neq("name", "AI Assistant") // Exclude AI / bot user
      .order("name", { ascending: true });

    if (error) throw error;

    res.json(
      (data || []).map((s) => ({
        id: s.id,
        name: s.name,
        phone: s.phone,
      })),
    );
  } catch (err) {
    console.error("Error fetching Branch 1 staff list for website form:", err);
    res.status(500).json({ message: "Failed to load staff list." });
  }
});

// New endpoint to log customer-initiated calls
app.get("/api/log-customer-call", async (req, res) => {
  const { leadId, staffId, customerId } = req.query;
  if (!leadId || !staffId || !customerId) {
    return res.status(400).send("Missing required query parameters.");
  }

  try {
    const { data: staff, error: staffError } = await supabase
      .from("staff")
      .select("name, phone")
      .eq("id", staffId)
      .single();
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("first_name, last_name")
      .eq("id", customerId)
      .single();
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("activity")
      .eq("id", leadId)
      .single();

    if (
      staffError ||
      customerError ||
      leadError ||
      !staff ||
      !customer ||
      !lead
    ) {
      throw new Error("Could not find required information to log the call.");
    }

    const customerName = `${customer.first_name} ${customer.last_name}`;
    const newActivity = {
      id: Date.now(),
      type: "Call Initiated",
      description: `${customerName} initiated a call to ${staff.name}.`,
      user: "System",
      timestamp: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from("leads")
      .update({
        activity: [newActivity, ...(lead.activity || [])],
        last_updated: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (updateError) {
      throw new Error(`Failed to log activity: ${updateError.message}`);
    }

    console.log(
      `[CRM] Logged customer call initiation for lead ${leadId} to ${staff.name}.`,
    );

    const sanitizedStaffPhone = (staff.phone || "").replace(/[^0-9+]/g, "");
    if (!sanitizedStaffPhone) {
      throw new Error("Staff member does not have a phone number configured.");
    }

    res.redirect(`tel:${sanitizedStaffPhone}`);
  } catch (error) {
    console.error("Error in /api/log-customer-call:", error.message);
    res
      .status(500)
      .send(`Could not process your call request: ${error.message}`);
  }
});

// --- AUTOMATIC LEAD ASSIGNMENT & ITINERARY GENERATION ---
let branchStaffIndexes = {}; // For round-robin fallback within branches

const getSeason = (dateString) => {
  const date = new Date(dateString);
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "Spring";
  if (month >= 5 && month <= 7) return "Summer";
  if (month >= 8 && month <= 10) return "Autumn";
  return "Winter";
};

const sendWelcomeEmail = async (lead, customer, staff) => {
  if (!customer.email) {
    console.log(
      `Customer ${customer.id} has no email. Skipping welcome email for lead ${lead.id}.`,
    );
    return;
  }

  const { data: branch } = await supabase
    .from("branches")
    .select("welcome_email_template")
    .eq("id", lead.branch_ids[0])
    .single();

  const DEFAULT_WELCOME_TEMPLATE = `
        <div style="font-family: Arial, sans-serif; background-color: #e2e8f0; padding: 40px;">
            <div style="max-width: 600px; margin: auto;">
                <div style="background-color: #1f2937; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
                    <h1 style="font-size: 28px; font-weight: bold; margin: 0;">GT HOLIDAYS</h1>
                    <p style="font-size: 14px; margin: 4px 0 0; color: #cbd5e1;">Travel World Class</p>
                </div>
                <div style="background-color: #ffffff; padding: 30px; border-radius: 0 0 12px 12px;">
                    <p style="font-size: 20px; margin: 0;">Vanakkam {Customer Name}!</p>
                    <p style="font-size: 16px; color: #4b5563; margin-top: 4px;">Thank you for your enquiry. Your trip is in trusted hands.</p>
                    
                    <div style="margin-top: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <div style="padding: 16px; background-color: #f9fafb; border-bottom: 1px solid #e5e7eb; border-top-left-radius: 8px; border-top-right-radius: 8px;">
                            <h2 style="font-size: 18px; font-weight: bold; margin: 0;">Summary</h2>
                        </div>
                        <div style="padding: 16px;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                                <tbody>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Agent:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Agent Name}, {Agent Phone}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">MTS ID:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{MTS ID}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Name:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Customer Full Name}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Trip To:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Trip Destination}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">No. of Nights:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Trip Duration}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Start Date:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Trip Start Date}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">End Date:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Trip End Date}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Total Adults:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Total Adults}</td></tr>
                                    <tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 8px 0; color: #6b7280;">Total Kids:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Total Kids}</td></tr>
                                    <tr><td style="padding: 8px 0; color: #6b7280;">Kid’s Age:</td><td style="padding: 8px 0; font-weight: 600; color: #111827; text-align: right;">{Kid Ages}</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div style="margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px;">
                        <h2 style="font-size: 18px; font-weight: bold; margin: 0 0 8px 0;">Next Steps</h2>
                        <p style="font-size: 14px; color: #4b5563; line-height: 1.5;">Your dedicated travel agent, <strong>{Agent Name}</strong>, will get in touch with you shortly with a detailed itinerary and quotation. In the meantime, feel free to reach out to them with any questions.</p>
                    </div>
                </div>
            </div>
        </div>
    `;
  const template = branch?.welcome_email_template || DEFAULT_WELCOME_TEMPLATE;

  // Duration is stored as number of days (e.g. "5" or "5 Days"). End date = start + (days - 1).
  const getEndDate = (startDateStr, durationStr) => {
    if (!durationStr) return "Not specified";
    const numMatch = String(durationStr).match(/(\d+)/);
    if (!numMatch) return "Not specified";
    const days = parseInt(numMatch[1], 10);
    if (days < 1) return "Not specified";
    const startDate = new Date(startDateStr);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + (days - 1));
    return endDate.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const startDate = new Date(lead.travel_date);
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);

  const replacements = {
    "{Customer Name}": customer.first_name,
    "{Customer Full Name}": `${customer.first_name} ${customer.last_name}`,
    "{Agent Name}": staff.name,
    "{Agent Phone}": staff.phone,
    "{Agent Email}": staff.email,
    "{MTS ID}": `${lead.id}${mm}${yy}`,
    "{Trip Destination}": lead.destination,
    "{Trip Duration}": formatDurationToDays(lead.duration),
    "{Trip Start Date}": startDate.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    "{Trip End Date}": getEndDate(lead.travel_date, lead.duration),
    "{Total Adults}": lead.requirements.adults,
    "{Total Kids}": lead.requirements.children,
    "{Kid Ages}": lead.requirements.child_ages?.join(", ") || "N/A",
  };

  const htmlBody = template.replace(/{[A-Za-z\s]+}/g, (matched) => {
    return replacements[matched] !== undefined
      ? replacements[matched]
      : matched;
  });

  const mailOptions = {
    from: `"Madura Travel Service" <${process.env.SMTP_USER}>`,
    to: customer.email,
    cc: staff.email,
    subject: `Your Dream Vacay with Madura Travel! Trip to ${lead.destination}`,
    html: htmlBody,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Welcome email sent for lead ${lead.id} to ${customer.email}.`);
  } catch (error) {
    console.error(`Failed to send welcome email for lead ${lead.id}:`, error);
  }
};

// --- AUTOMATED LEAD ASSIGNMENT AND PROCESSING ---
// This function processes leads in batches and handles:
// - Bulk lead assignments (50-60 leads at once)
// - Rate-limited WhatsApp notifications (prevents API overload)
// - Concurrent processing with delays between operations
// - Staff notifications for both primary and secondary assignees
//
// Scalability features:
// - Rate limiting: 2 seconds minimum between messages to same recipient
// - Bulk delays: 500ms between different recipients in bulk operations
// - Sequential processing: Leads processed one by one to prevent overwhelming system
// - All notifications are sent, even if 10 staff get 10 leads each (100 notifications)
// OPTIMIZED: Event-driven assignment - processes specific lead immediately or batch of unassigned leads
const assignLeadsAndGenerateItineraries = async (specificLeadId = null) => {
  try {
    let leadsToAssign = [];

    if (specificLeadId) {
      // EVENT-DRIVEN: Process specific lead immediately (triggered by realtime listener)
      console.log(
        `[Assignment] Event-driven: Processing lead ${specificLeadId}...`,
      );

      // Quick check: Is this lead already assigned?
      const { data: existingAssignments, error: checkError } = await supabase
        .from("lead_assignees")
        .select("lead_id")
        .eq("lead_id", specificLeadId)
        .limit(1);

      if (checkError) throw checkError;

      if (existingAssignments && existingAssignments.length > 0) {
        console.log(
          `[Assignment] Lead ${specificLeadId} already assigned, skipping.`,
        );
        return;
      }

      // Fetch the specific lead (only if unassigned)
      const { data: leadData, error: leadError } = await supabase
        .from("leads")
        .select(
          "id, status, destination, requirements, customer_id, branch_ids, created_at, last_updated, customer:customers(id, first_name, last_name, email, phone), all_assignees:lead_assignees(staff(id, name, email, phone, branch_id))",
        )
        .eq("id", specificLeadId)
        .eq("status", "Enquiry")
        .single();

      if (leadError) throw leadError;

      if (!leadData) {
        console.log(
          `[Assignment] Lead ${specificLeadId} not found or not in Enquiry status.`,
        );
        return;
      }

      leadsToAssign = [leadData];
      console.log(
        `[Assignment] Processing lead ${specificLeadId} for assignment.`,
      );
    } else {
      // BATCH MODE: Check for unassigned leads (fallback, rarely used now)
      console.log("[Assignment] Batch mode: Checking for unassigned leads...");

      // Only check leads created more than 30 seconds ago (reduced from 1 minute for faster assignment)
      const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();
      const { data: potentialLeads, error: potentialError } = await supabase
        .from("leads")
        .select("id")
        .eq("status", "Enquiry")
        .lt("created_at", thirtySecondsAgo);

      if (potentialError) throw potentialError;
      if (!potentialLeads || potentialLeads.length === 0) {
        console.log("[Assignment] No leads found matching criteria.");
        return;
      }

      const leadIds = potentialLeads.map((l) => l.id);

      // Find which of these leads already have entries in the junction table
      const { data: assignedLeads, error: assignedError } = await supabase
        .from("lead_assignees")
        .select("lead_id")
        .in("lead_id", leadIds);

      if (assignedError) throw assignedError;

      const assignedLeadIds = new Set(assignedLeads.map((a) => a.lead_id));
      const unassignedLeadIds = leadIds.filter(
        (id) => !assignedLeadIds.has(id),
      );

      if (unassignedLeadIds.length === 0) {
        console.log("[Assignment] No unassigned leads to process.");
        return;
      }

      // Fetch the full data for the unassigned leads
      const { data: fetchedLeads, error: leadsError } = await supabase
        .from("leads")
        .select(
          "id, status, destination, requirements, customer_id, branch_ids, created_at, last_updated, customer:customers(id, first_name, last_name, email, phone), all_assignees:lead_assignees(staff(id, name, email, phone, branch_id))",
        )
        .in("id", unassignedLeadIds);

      if (leadsError) throw leadsError;

      if (!fetchedLeads || fetchedLeads.length === 0) {
        console.log("[Assignment] No leads to assign after fetch.");
        return;
      }

      leadsToAssign = fetchedLeads;
      console.log(
        `[Assignment] Found ${leadsToAssign.length} unassigned leads to process.`,
      );
    }

    // 5. Get all active, non-admin, non-AI staff
    // OPTIMIZATION: Select only necessary columns to reduce Disk IO
    const { data: allStaff, error: staffError } = await supabase
      .from("staff")
      .select(
        "id, name, email, phone, branch_id, status, role_id, leads_attended, destinations, services",
      )
      .eq("status", "Active")
      .neq("role_id", 1) // Exclude Super Admins
      .neq("name", "AI Assistant") // Exclude AI Assistant
      .order("id", { ascending: true });

    if (staffError) throw staffError;
    if (!allStaff || allStaff.length === 0) {
      console.log("No active, non-admin staff available for assignment.");
      return;
    }

    // Further restrict to staff who have the Sales role tag (role_tag_id = 3)
    let salesStaffOnly = allStaff;
    try {
      const { data: salesTagRows, error: salesTagError } = await supabase
        .from("staff_role_tags")
        .select("staff_id, role_tag_id")
        .eq("role_tag_id", 3);

      if (salesTagError) {
        console.warn(
          "[Assignment] Failed to fetch staff_role_tags for Sales role (id 3). Falling back to all eligible staff.",
          salesTagError.message || salesTagError,
        );
      } else if (salesTagRows && salesTagRows.length > 0) {
        const salesStaffIds = new Set(salesTagRows.map((row) => row.staff_id));
        salesStaffOnly = allStaff.filter((s) => salesStaffIds.has(s.id));

        if (salesStaffOnly.length === 0) {
          console.log(
            "[Assignment] No staff with Sales role tag (id 3) found among active staff. Skipping assignment.",
          );
          return;
        }
      } else {
        console.log(
          "[Assignment] No staff_role_tags rows found for Sales role tag (id 3). Skipping assignment.",
        );
        return;
      }
    } catch (err) {
      console.warn(
        "[Assignment] Error while restricting staff to Sales role tag (id 3). Falling back to all eligible staff.",
        err.message || err,
      );
    }

    // Group staff by branch for easier lookup
    const staffByBranch = salesStaffOnly.reduce((acc, staff) => {
      const branchId = staff.branch_id;
      if (!acc[branchId]) acc[branchId] = [];
      acc[branchId].push(staff);
      return acc;
    }, {});

    Object.keys(staffByBranch).forEach((branchId) => {
      if (branchStaffIndexes[branchId] === undefined) {
        branchStaffIndexes[branchId] = -1;
      }
    });

    for (const rawLead of leadsToAssign) {
      // Normalize lead object
      const lead = {
        ...rawLead,
        assigned_to: (rawLead.all_assignees || [])
          .map((a) => a.staff)
          .filter(Boolean),
      };

      let primaryAssignee = null;
      let slackThreadTs = null;

      try {
        // ----- CRITICAL PATH: STAFF ASSIGNMENT -----
        await supabase
          .from("leads")
          .update({ current_staff_name: "Assigning..." })
          .eq("id", lead.id);

        const customerData = lead.customer;
        if (!customerData) {
          console.warn(
            `Could not find customer with ID ${lead.customer_id} for lead ${lead.id}. Skipping notifications.`,
          );
        }

        const leadBranchId = 1; // HARDCODE to branch 1 as requested
        const branchStaffPool = staffByBranch[leadBranchId] || [];

        if (branchStaffPool.length === 0) {
          console.log(
            `No staff available in branch ${leadBranchId} for lead ${lead.id}`,
          );
          continue; // Skip to next lead
        }

        const leadServices = lead.services || [];
        const leadDestination = (lead.destination || "").toLowerCase().trim();
        const secondaryAssignees = new Set();

        // 1. Create the base eligible pool by filtering out anyone excluded.
        const eligiblePool = branchStaffPool.filter((staff) => {
          if (staff.role_id === 2) return true; // Managers are always eligible as a fallback

          const excludedServices = staff.excluded_services || [];
          if (leadServices.some((ls) => excludedServices.includes(ls))) {
            return false;
          }

          const excludedDestinations = (staff.excluded_destinations || "")
            .toLowerCase()
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
          if (
            excludedDestinations.length > 0 &&
            excludedDestinations.some((ed) => leadDestination.includes(ed))
          ) {
            return false;
          }

          return true;
        });

        if (eligiblePool.length === 0) {
          console.error(
            `No eligible staff (after exclusions) found for lead ${lead.id} in branch ${leadBranchId}.`,
          );
          await supabase
            .from("leads")
            .update({ current_staff_name: null })
            .eq("id", lead.id);
          continue;
        }

        // 2. Try to find a specialist for the primary service from the eligible pool
        const primaryService = leadServices[0];
        let assignmentPool = [];

        if (primaryService) {
          // A staff is a specialist if they explicitly list the service, or if they are a generalist (no services listed).
          assignmentPool = eligiblePool.filter((staff) => {
            const handledServices = staff.services || [];
            return (
              handledServices.length === 0 ||
              handledServices.includes(primaryService)
            );
          });
        }

        // 3. If no specialists found, use the entire eligible pool as the fallback.
        if (assignmentPool.length === 0) {
          console.log(
            `No specialists for '${primaryService}' found for lead ${lead.id}. Falling back to all eligible staff in branch.`,
          );
          assignmentPool = eligiblePool;
        }

        // 4. Perform round-robin assignment on the final pool.
        branchStaffIndexes[leadBranchId] =
          (branchStaffIndexes[leadBranchId] + 1) % assignmentPool.length;
        primaryAssignee = assignmentPool[branchStaffIndexes[leadBranchId]];

        if (!primaryAssignee) {
          console.error(
            `Could not find ANY eligible staff or manager to assign lead ${lead.id} in branch ${leadBranchId}.`,
          );
          await supabase
            .from("leads")
            .update({ current_staff_name: null })
            .eq("id", lead.id);
          continue;
        }

        // 5. Find secondary assignees for other services
        const otherServices = leadServices.filter(
          (s) => s !== lead.services[0],
        );
        for (const service of otherServices) {
          // Find a different, eligible staff member who specializes in this service
          const specialist = allStaff.find((s) => {
            if (s.id === primaryAssignee.id) return false; // Can't be the primary
            if (!s.services?.includes(service)) return false; // Must handle the service

            // Check exclusions for secondary assignee
            const excludedServices = s.excluded_services || [];
            if (excludedServices.includes(service)) return false;

            const excludedDestinations = (s.excluded_destinations || "")
              .toLowerCase()
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean);
            if (excludedDestinations.some((ed) => leadDestination.includes(ed)))
              return false;

            return true;
          });

          if (specialist) {
            secondaryAssignees.add(specialist);
          }
        }

        const finalAssignees = [
          primaryAssignee,
          ...Array.from(secondaryAssignees),
        ];
        const assignments = finalAssignees.map((staff) => ({
          lead_id: lead.id,
          staff_id: staff.id,
        }));
        const { error: assignError } = await supabase
          .from("lead_assignees")
          .insert(assignments);
        if (assignError) throw assignError;

        // Send Welcome messages and add activity
        // Note: Summary and staff notifications are handled by the realtime listener to prevent duplicates
        // The realtime listener will fire for these INSERTs and send notifications
        if (customerData) {
          // Small delay before sending staff notifications to prevent overwhelming WhatsApp API
          await new Promise((resolve) =>
            setTimeout(resolve, BULK_MESSAGE_DELAY),
          );

          // FALLBACK: Send MTS summary directly if realtime listener doesn't fire
          // Check if summary was already sent (prevent duplicates)
          const recentSummarySent = (lead.activity || []).some(
            (act) =>
              (act.type === "Summary Sent" || act.type === "WhatsApp Sent") &&
              (act.description?.includes("Summary sent") ||
                act.description?.includes("template")) &&
              new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
          );

          if (!recentSummarySent) {
            // Fetch fresh lead data with assignees to ensure we have latest activity
            const { data: freshLead } = await supabase
              .from("leads")
              .select("*, all_assignees:lead_assignees(staff(*))")
              .eq("id", lead.id)
              .single();

            if (freshLead) {
              // Double-check summary wasn't sent in the meantime
              const freshSummarySent = (freshLead.activity || []).some(
                (act) =>
                  (act.type === "Summary Sent" ||
                    act.type === "WhatsApp Sent") &&
                  (act.description?.includes("Summary sent") ||
                    act.description?.includes("template")) &&
                  new Date(act.timestamp) > new Date(Date.now() - 60000),
              );

              if (!freshSummarySent) {
                // DISABLED: MTS summary auto-sending
                // console.log(
                //   `[Task] Sending MTS summary to customer "${customerData.first_name} ${customerData.last_name}" (${customerData.phone}) for lead ${lead.id} (fallback after assignment)`
                // );
                // try {
                //   await sendWelcomeWhatsapp(
                //     freshLead,
                //     customerData,
                //     primaryAssignee
                //   );
                //   console.log(
                //     `[Task] ✅ MTS summary sent successfully to customer for lead ${lead.id}`
                //   );
                // } catch (summaryError) {
                //   console.error(
                //     `[Task] ❌ Error sending MTS summary to customer for lead ${lead.id}:`,
                //     summaryError.message
                //   );
                // }
                console.log(
                  `[Task] MTS summary auto-sending is disabled for lead ${lead.id}`,
                );
              } else {
                console.log(
                  `[Task] Summary already sent (detected in fresh lead data) for lead ${lead.id}. Skipping.`,
                );
              }
            }
          } else {
            console.log(
              `[Task] Summary already sent recently for lead ${lead.id}. Skipping duplicate.`,
            );
          }

          // Send Staff Notification to primary assignee (realtime listener will also try, but has duplicate prevention)
          // Summary will be sent by the realtime listener when primary staff assignment is detected
          await sendStaffAssignmentNotification(
            lead,
            customerData,
            primaryAssignee,
            "primary",
          );

          // Send notifications to secondary assignees with delays between each
          for (const secondaryStaff of Array.from(secondaryAssignees)) {
            // Find the specific service this secondary staff is handling
            const leadServicesSet = new Set(leadServices);
            const primaryServicesSet = new Set(primaryAssignee.services || []);
            const secondaryServicesSet = new Set(secondaryStaff.services || []);

            let specificService = null;
            // Find a service the secondary staff handles, that the lead requires, and the primary staff does NOT handle
            for (const service of secondaryServicesSet) {
              if (
                leadServicesSet.has(service) &&
                !primaryServicesSet.has(service)
              ) {
                specificService = service;
                break;
              }
            }
            // Fallback: just find any service they handle that's on the lead
            if (!specificService) {
              specificService =
                (secondaryStaff.services || []).find((s) =>
                  leadServicesSet.has(s),
                ) || "a task for this lead";
            }

            // Delay between secondary staff notifications
            await new Promise((resolve) =>
              setTimeout(resolve, BULK_MESSAGE_DELAY),
            );

            await sendStaffAssignmentNotification(
              lead,
              customerData,
              secondaryStaff,
              "secondary",
              primaryAssignee.name,
              specificService,
            );
          }
        }

        // Small delay between processing different leads to prevent API overload
        await new Promise((resolve) => setTimeout(resolve, BULK_MESSAGE_DELAY));

        // REMOVED: Automatic status change from Enquiry to Processing when staff is auto-assigned
        // Status should be changed manually by the user, not automatically
        await supabase
          .from("leads")
          .update({
            // status: "Processing", // REMOVED - don't auto-change status
            last_updated: new Date().toISOString(),
            // slack_thread_ts: slackThreadTs, // Slack disabled
            activity: lead.activity,
            needs_welcome_pdf_generation: true, // Set flag for client-side PDF generation
          })
          .eq("id", lead.id);
        console.log(
          `Assigned lead ${lead.id} to Primary: ${primaryAssignee.name}`,
        );

        // ----- START CONCURRENT TASKS -----
        const concurrentTasks = [];

        // Task 1: Auto-assign supplier (runs in parallel)
        if (lead.services.includes("Tour Package")) {
          concurrentTasks.push(
            (async () => {
              try {
                console.log(
                  `[Task] Attempting supplier assignment for lead ${lead.id}.`,
                );
                await supabase
                  .from("leads")
                  .update({ current_staff_name: "Assigning-Supplier..." })
                  .eq("id", lead.id);

                const { data: allSuppliers, error: supplierError } =
                  await supabase
                    .from("suppliers")
                    .select("*")
                    .eq("status", "Active");
                if (supplierError) throw supplierError;

                if (allSuppliers?.length > 0) {
                  const leadDestination = (lead.destination || "")
                    .toLowerCase()
                    .trim();
                  const destinationMatches = allSuppliers.filter((s) =>
                    (s.destinations || "")
                      .toLowerCase()
                      .includes(leadDestination),
                  );
                  const verifiedMatches = destinationMatches.filter(
                    (s) => s.is_verified,
                  );

                  let suppliersToAssign = [];
                  if (verifiedMatches.length > 0) {
                    suppliersToAssign = verifiedMatches;
                  } else {
                    const unverifiedMatches = destinationMatches.filter(
                      (s) => !s.is_verified,
                    );
                    suppliersToAssign = unverifiedMatches;
                  }

                  if (suppliersToAssign.length > 0) {
                    const supplierAssignments = suppliersToAssign.map((s) => ({
                      lead_id: lead.id,
                      supplier_id: s.id,
                    }));
                    const { error: supplierAssignError } = await supabase
                      .from("lead_suppliers")
                      .insert(supplierAssignments);
                    if (supplierAssignError) throw supplierAssignError;

                    const supplierNames = suppliersToAssign
                      .map((s) => `"${s.company_name}"`)
                      .join(", ");
                    const supplierMessage = `Supplier(s) ${supplierNames} automatically assigned by system.`;

                    const supplierLog = {
                      id: Date.now() + 1,
                      type: "Supplier Assigned",
                      description: supplierMessage,
                      user: "System",
                      timestamp: new Date().toISOString(),
                    };
                    const { data: currentLeadData } = await supabase
                      .from("leads")
                      .select("activity")
                      .eq("id", lead.id)
                      .single();
                    const updatedActivity = [
                      supplierLog,
                      ...(currentLeadData?.activity || []),
                    ];
                    await supabase
                      .from("leads")
                      .update({
                        activity: updatedActivity,
                        last_updated: new Date().toISOString(),
                      })
                      .eq("id", lead.id);
                    console.log(
                      `[Task] Successfully assigned ${suppliersToAssign.length} supplier(s) to lead ${lead.id}: ${supplierNames}.`,
                    );
                  } else {
                    console.log(
                      `[Task] No matching supplier found for lead ${lead.id}.`,
                    );
                  }
                }
              } catch (error) {
                console.error(
                  `[Task] Error during supplier assignment for lead ${lead.id}:`,
                  error.message,
                );
              }
            })(),
          );
        }

        // Task 2: Auto-generate itinerary v1
        // ONLY generate itinerary for Tour Package service
        // Do NOT generate for Passport, Forex, Transport, Visa, Air Ticket, or Hotel-only leads
        const hasTourPackage =
          lead.services && lead.services.includes("Tour Package");
        const nonTourServices = [
          "Passport",
          "Forex",
          "Transport",
          "Visa",
          "Air Ticket",
          "Hotel",
        ];

        // Check if lead has ONLY non-tour services (no Tour Package)
        const hasOnlyNonTourServices =
          lead.services &&
          lead.services.length > 0 &&
          lead.services.every((s) => nonTourServices.includes(s));

        // Only generate if Tour Package is explicitly present
        // Do NOT generate if lead has only non-tour services (Passport, Forex, etc.)
        // CRITICAL: Do NOT generate itinerary for leads with status "Enquiry"
        // Itineraries should only be generated when status changes to "Processing"
        if (
          hasTourPackage &&
          !hasOnlyNonTourServices &&
          lead.status === "Processing"
        ) {
          console.log(
            `[Task] Tour Package detected for lead ${
              lead.id
            }. Services: [${lead.services.join(", ")}]. Status: ${
              lead.status
            }. Generating itinerary.`,
          );
          concurrentTasks.push(
            (async () => {
              try {
                console.log(
                  `[Task] Starting AI itinerary v1 generation for lead ${lead.id}...`,
                );

                const { data: fullLeadData, error: fullLeadError } =
                  await supabase
                    .from("leads")
                    .select("*")
                    .eq("id", lead.id)
                    .single();
                if (fullLeadError)
                  throw new Error(
                    `Failed to fetch full lead details: ${fullLeadError.message}`,
                  );

                const notesContent =
                  fullLeadData.notes && fullLeadData.notes.length > 0
                    ? fullLeadData.notes
                        .map(
                          (note) => `- ${note.text.replace(/<[^>]*>?/gm, "")}`,
                        )
                        .join("\n")
                    : "No specific notes from customer.";
                const season = getSeason(fullLeadData.travel_date);

                // Determine if visa is needed (international tour)
                const destinationLower = (
                  fullLeadData.destination || ""
                ).toLowerCase();
                const startingPointLower = (
                  fullLeadData.starting_point || ""
                ).toLowerCase();
                const isIndianDestination = indianPlaces.some((place) =>
                  destinationLower.includes(place.toLowerCase()),
                );
                const isIndianStartingPoint = indianPlaces.some((place) =>
                  startingPointLower.includes(place.toLowerCase()),
                );
                const isInternational =
                  !isIndianDestination || !isIndianStartingPoint;
                const needsVisa = isInternational;

                // Get branch for default Terms & Conditions and Cancellation Policy
                const branchId = fullLeadData.branch_ids?.[0];
                let branchTerms = "";
                let branchCancellationPolicy = "";
                if (branchId) {
                  const { data: branchData } = await supabase
                    .from("branches")
                    .select("terms_and_conditions(*), cancellation_policy(*)")
                    .eq("id", branchId)
                    .single();
                  if (branchData?.terms_and_conditions?.length > 0) {
                    branchTerms =
                      branchData.terms_and_conditions.find((t) => t.is_default)
                        ?.content ||
                      branchData.terms_and_conditions[0].content ||
                      "";
                  }
                  if (branchData?.cancellation_policy?.length > 0) {
                    branchCancellationPolicy =
                      branchData.cancellation_policy.find((t) => t.is_default)
                        ?.content ||
                      branchData.cancellation_policy[0].content ||
                      "";
                  }
                }

                const hotelPreference =
                  fullLeadData.requirements?.hotelPreference || "No Preference";
                const stayPreference =
                  fullLeadData.requirements?.stayPreference || "No Preference";
                const hasVisaService =
                  fullLeadData.services &&
                  fullLeadData.services.includes("Visa");
                // Always generate visa - based on destination as an Indian traveler
                const shouldGenerateVisa = true;

                const contextPrompt = `
                  Act as an expert travel agent for Madura Travel. Create a structured itinerary based on the following lead.

                  **Lead Details:**
                  - Destination: ${fullLeadData.destination}
                  - Starting Point: ${
                    fullLeadData.starting_point || "Not specified"
                  }
                  - Duration: ${fullLeadData.duration || "Not specified"}
                  - Travel Date: ${fullLeadData.travel_date} (Season: ${season})
                  - Return Date: ${fullLeadData.return_date || "Not specified"}
                  - Tour Type: ${fullLeadData.tour_type || "General"}
                  - Passengers: ${fullLeadData.requirements.adults} Adults, ${
                    fullLeadData.requirements.children
                  } Children
                  - Hotel Preference: ${hotelPreference}
                  - Stay Preference: ${stayPreference}
                  - Is International: ${isInternational}
                  - Traveler Nationality: Indian

                  **Customer Notes & Requirements:**
                  ${notesContent}

                  **CRITICAL REQUIREMENTS:**
                  1. FLIGHTS: Use Google Search to find the CHEAPEST available flights (even with stops). ALWAYS generate:
                     - At least one 'onward' flight (from starting_point to destination on travel_date)
                     - A corresponding 'return' flight (from destination back to starting_point on return_date or calculated end_date)
                     - 'intercity' flights if the itinerary involves multiple cities
                     - Include proper dates (YYYY-MM-DD), times (HH:MM 24-hour), duration (ISO 8601 format like PT3H30M), and flight numbers
                     - Choose the CHEAPEST option available, even if it has stops
                     - Get REAL prices from MakeMyTrip, Booking.com, Expedia, or Google Flights
                  
                  2. HOTELS: Use Google Search to find GOOD hotels based on preferences. ALWAYS generate:
                     - At least ONE hotel for the trip duration
                     - Hotels matching hotel preference (${hotelPreference}) and stay preference (${stayPreference})
                     - Include hotel name, city, pricing type, nights, rooms, rate per night, check-in/check-out dates, and room type
                     - Get REAL prices per night (in INR) when possible
                     - Suggest hotels with reasons (e.g., "best for sunrise", "nearby to attractions")
                  
                  3. VISA: ALWAYS generate visa information for Indian travelers to ${
                    fullLeadData.destination
                  }. Use Google Search to find visa information:
                     - Search for "Indian passport visa requirements for ${
                       fullLeadData.destination
                     }"
                     - Type (e.g., Tourist Visa, E-Visa, On Arrival, etc.), price (per person in INR), duration, validity period, length of stay
                     - Documents required and requirements
                     - Processing time and important notes
                     - If visa is not required (e.g., for domestic destinations), still generate visa object with type "Not Required" and note explaining why
                  
                  4. INSURANCE: MUST be included in inclusions and insurance object
                  
                  5. DO NOT generate Sightseeing or Transfers - these should be added manually later

                  **Your Task:**
                  Generate a response in JSON format. The day-wise plan descriptions must be in clean HTML format (using <p> and <ul><li> tags). Be creative and logical.
                `;

                // Use full schema with flights, hotels, visa, insurance, important_notes
                const fullItinerarySchema = {
                  type: Type.OBJECT,
                  properties: {
                    creative_title: {
                      type: Type.STRING,
                      description:
                        "A creative, marketable title for the tour package.",
                    },
                    duration: {
                      type: Type.STRING,
                      description:
                        "The total duration of the trip in days, e.g., '5' or '7 Days'.",
                    },
                    overview: {
                      type: Type.STRING,
                      description:
                        "A brief, engaging overview of the trip (2-3 sentences).",
                    },
                    day_wise_plan: {
                      type: Type.ARRAY,
                      description: "A detailed day-by-day plan.",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          day: {
                            type: Type.INTEGER,
                            description: "The day number, starting from 1.",
                          },
                          title: {
                            type: Type.STRING,
                            description:
                              "A short, catchy title for the day's activities. MUST be in the format 'Day X – [Title]' (e.g., 'Day 1 – Arrival & Negombo Retreat', 'Day 2 – Exploring Colombo'). Always include the day number and a descriptive title.",
                          },
                          description: {
                            type: Type.STRING,
                            description:
                              "A detailed description of the day's events in well-formatted HTML. Structure:\n" +
                              "- DO NOT include date (date is shown separately) - NEVER use 📅 emoji\n" +
                              "- Use ONLY minimal emojis: ✨ for closing statement (optional), NO other emojis\n" +
                              "- Format: '<h4>[Section Title in Bold]</h4><p>[1-2 sentences max]</p>'\n" +
                              "- Section titles MUST be in bold using h4 tags: 'Morning Exploration', 'Afternoon Journey', 'Evening at Leisure', 'Dining', 'Overnight'\n" +
                              "- Common sections: 'Arrival & Welcome', 'Morning Exploration', 'Afternoon Journey', 'Evening at Leisure', 'Dining', 'Overnight'\n" +
                              "- For Dining: List meals included briefly (e.g., 'Breakfast and Dinner at the hotel')\n" +
                              "- For Overnight: List the city/location name only\n" +
                              "- End with closing: '<p>✨ [Very brief closing - one sentence only]</p>'\n" +
                              "- Be professional and concise",
                          },
                        },
                        required: ["day", "title", "description"],
                      },
                    },
                    inclusions: {
                      type: Type.ARRAY,
                      description:
                        "A detailed and comprehensive list of items included in the package. MUST be specific and detailed. Examples: '07 Nights hotel accommodation (DBL, TPL sharing basis)', 'Private air-conditioned transfers', 'English speaking tour guide', 'Entrance fees to [attractions]', 'Meals as indicated: B = Breakfast, L = Lunch, D = Dinner', '2 bottles of Mineral water per person per day on vehicle'. Include Flights, Hotels with details, Visa, Insurance with coverage details. Be specific about quantities, types, and details so customers know exactly what they're paying for.",
                      items: { type: Type.STRING },
                    },
                    exclusions: {
                      type: Type.ARRAY,
                      description:
                        "A detailed and comprehensive list of items excluded from the package. MUST be specific and detailed. Examples: 'International Flight fares', 'Visa service', 'Early Check in and late check out', 'Any expense on personal nature', 'Drinks during meals', 'Tips, portages and Gratitude', 'Video and camera permits', 'Beverage', 'Other services unspecified in the list', 'Compulsory tipping for tour guide and driver'. Be comprehensive and specific so customers understand what is NOT included.",
                      items: { type: Type.STRING },
                    },
                    flights: {
                      type: Type.ARRAY,
                      description:
                        "Flight details with CHEAPEST prices from web search. ALWAYS generate onward and return flights.",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          direction: {
                            type: Type.STRING,
                            description:
                              "One of: 'onward', 'return', 'intercity'",
                          },
                          airline: {
                            type: Type.STRING,
                            description: "Airline name",
                          },
                          flight_number: {
                            type: Type.STRING,
                            description: "Flight number",
                          },
                          from: {
                            type: Type.STRING,
                            description: "Origin airport code",
                          },
                          to: {
                            type: Type.STRING,
                            description: "Destination airport code",
                          },
                          departure_date: {
                            type: Type.STRING,
                            description: "Departure date in YYYY-MM-DD format",
                          },
                          departure_time: {
                            type: Type.STRING,
                            description:
                              "Departure time in HH:MM format (24-hour)",
                          },
                          arrival_date: {
                            type: Type.STRING,
                            description: "Arrival date in YYYY-MM-DD format",
                          },
                          arrival_time: {
                            type: Type.STRING,
                            description:
                              "Arrival time in HH:MM format (24-hour)",
                          },
                          duration: {
                            type: Type.STRING,
                            description:
                              "Flight duration in ISO 8601 format (e.g., 'PT3H30M')",
                          },
                          stops: {
                            type: Type.STRING,
                            description:
                              "Number of stops (e.g., '0', '1', '2')",
                          },
                          price: {
                            type: Type.NUMBER,
                            description: "CHEAPEST price per person in INR",
                          },
                          source: {
                            type: Type.STRING,
                            description: "Source website",
                          },
                        },
                        required: [
                          "direction",
                          "airline",
                          "from",
                          "to",
                          "departure_date",
                          "departure_time",
                          "arrival_date",
                          "arrival_time",
                          "duration",
                          "price",
                        ],
                      },
                    },
                    hotels: {
                      type: Type.ARRAY,
                      description:
                        "Hotel details. ALWAYS generate at least ONE hotel matching preferences.",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          name: {
                            type: Type.STRING,
                            description: "Hotel name",
                          },
                          city: { type: Type.STRING, description: "City name" },
                          pricing_type: {
                            type: Type.STRING,
                            description:
                              "One of: 'Per Adult', 'Per Adult (TWIN / DOUBLE SHARING)', etc.",
                          },
                          nights: {
                            type: Type.INTEGER,
                            description: "Number of nights",
                          },
                          rooms: {
                            type: Type.INTEGER,
                            description: "Number of rooms",
                          },
                          rate_per_night: {
                            type: Type.NUMBER,
                            description: "Price per night in INR",
                          },
                          check_in_date: {
                            type: Type.STRING,
                            description: "Check-in date (YYYY-MM-DD)",
                          },
                          check_out_date: {
                            type: Type.STRING,
                            description: "Check-out date (YYYY-MM-DD)",
                          },
                          room_type: {
                            type: Type.STRING,
                            description: "Room type",
                          },
                        },
                        required: [
                          "name",
                          "city",
                          "pricing_type",
                          "nights",
                          "rooms",
                          "rate_per_night",
                          "check_in_date",
                          "check_out_date",
                          "room_type",
                        ],
                      },
                    },
                    visa: {
                      type: Type.OBJECT,
                      description:
                        "Visa information for Indian travelers to the destination. ALWAYS generate this. Use Google Search to find visa requirements for Indian passport holders. Search for 'Indian passport visa requirements for [destination]'. If visa is not required (domestic), set type to 'Not Required' and explain in requirements.",
                      properties: {
                        type: {
                          type: Type.STRING,
                          description:
                            "Visa type (e.g., 'Tourist Visa', 'E-Visa', 'On Arrival', 'Not Required')",
                        },
                        price: {
                          type: Type.NUMBER,
                          description:
                            "Visa price per person in INR (0 if not required)",
                        },
                        duration: {
                          type: Type.STRING,
                          description:
                            "Processing duration (e.g., '5-7 business days', 'Instant for E-Visa')",
                        },
                        validity_period: {
                          type: Type.STRING,
                          description:
                            "Visa validity period (e.g., '2 months', '6 months', '1 year')",
                        },
                        length_of_stay: {
                          type: Type.STRING,
                          description:
                            "Maximum length of stay allowed (e.g., '30 days', '90 days')",
                        },
                        documents_required: {
                          type: Type.STRING,
                          description:
                            "List all required documents (passport, photos, application form, etc.)",
                        },
                        requirements: {
                          type: Type.STRING,
                          description:
                            "Detailed visa requirements and important notes. If visa not required, explain why.",
                        },
                      },
                      required: [
                        "type",
                        "price",
                        "duration",
                        "validity_period",
                        "length_of_stay",
                        "documents_required",
                        "requirements",
                      ],
                    },
                    insurance: {
                      type: Type.OBJECT,
                      description:
                        "Travel insurance information. Always include this.",
                      properties: {
                        type: { type: Type.STRING },
                        coverage: { type: Type.STRING },
                        note: { type: Type.STRING },
                      },
                    },
                    important_notes: {
                      type: Type.STRING,
                      description:
                        "Important notes and additional information for the itinerary.",
                    },
                  },
                  required: [
                    "creative_title",
                    "duration",
                    "overview",
                    "day_wise_plan",
                    "inclusions",
                    "exclusions",
                    "insurance",
                    "important_notes",
                    "visa",
                  ],
                };

                const response = await geminiAI.models.generateContent({
                  model: "gemini-2.5-flash",
                  contents: [{ text: contextPrompt }],
                  config: {
                    tools: [{ googleSearch: {} }],
                  },
                });

                let aiResultText = response.text.trim();
                // Remove markdown code blocks if present
                if (aiResultText.startsWith("```")) {
                  const lines = aiResultText.split("\n");
                  const startIndex = lines.findIndex((line) =>
                    line.trim().startsWith("```"),
                  );
                  const endIndex = lines.findIndex(
                    (line, idx) =>
                      idx > startIndex && line.trim().startsWith("```"),
                  );
                  if (startIndex !== -1 && endIndex !== -1) {
                    aiResultText = lines
                      .slice(startIndex + 1, endIndex)
                      .join("\n")
                      .trim();
                  }
                }
                const jsonMatch = aiResultText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  aiResultText = jsonMatch[0];
                }

                // Try to parse JSON, with better error handling for control characters
                let aiResult;
                try {
                  aiResult = JSON.parse(aiResultText);
                } catch (parseError) {
                  console.error(
                    `[Task] JSON parse error for lead ${lead.id}:`,
                    parseError.message,
                  );
                  const errorPos =
                    parseError.message.match(/position (\d+)/)?.[1];
                  if (errorPos) {
                    const pos = parseInt(errorPos);
                    console.error(
                      `[Task] Error at position ${pos}, context:`,
                      aiResultText.substring(
                        Math.max(0, pos - 50),
                        Math.min(aiResultText.length, pos + 50),
                      ),
                    );
                  }

                  // Try to fix control characters in JSON strings
                  // Improved sanitization: handle more edge cases including unicode escapes
                  let sanitizedText = "";
                  let insideString = false;
                  let escapeNext = false;
                  let inUnicodeEscape = false;
                  let unicodeEscapeCount = 0;

                  for (let i = 0; i < aiResultText.length; i++) {
                    const char = aiResultText[i];
                    const code = char.charCodeAt(0);

                    if (escapeNext) {
                      sanitizedText += char;
                      escapeNext = false;
                      if (char === "u") {
                        inUnicodeEscape = true;
                        unicodeEscapeCount = 0;
                      }
                      continue;
                    }

                    if (inUnicodeEscape) {
                      sanitizedText += char;
                      unicodeEscapeCount++;
                      if (unicodeEscapeCount >= 4) {
                        inUnicodeEscape = false;
                        unicodeEscapeCount = 0;
                      }
                      continue;
                    }

                    if (char === "\\") {
                      sanitizedText += char;
                      escapeNext = true;
                      continue;
                    }

                    if (char === '"') {
                      insideString = !insideString;
                      sanitizedText += char;
                      continue;
                    }

                    // If inside a string and we have a control character, escape it
                    if (insideString && (code < 0x20 || code === 0x7f)) {
                      if (code === 0x0a) sanitizedText += "\\n";
                      else if (code === 0x0d) sanitizedText += "\\r";
                      else if (code === 0x09) sanitizedText += "\\t";
                      else if (code === 0x08) sanitizedText += "\\b";
                      else if (code === 0x0c) sanitizedText += "\\f";
                      else
                        sanitizedText += `\\u${code
                          .toString(16)
                          .padStart(4, "0")}`;
                    } else {
                      sanitizedText += char;
                    }
                  }

                  try {
                    aiResult = JSON.parse(sanitizedText);
                    console.log(
                      `[Task] Successfully parsed JSON after sanitization for lead ${lead.id}`,
                    );
                  } catch (retryError) {
                    console.error(
                      `[Task] Failed to parse JSON even after sanitization for lead ${lead.id}:`,
                      retryError.message,
                    );
                    throw new Error(
                      `Failed to parse AI response as JSON: ${parseError.message}. Sanitization also failed: ${retryError.message}`,
                    );
                  }
                }

                const { data: newMetaData, error: metaError } = await supabase
                  .from("itineraries")
                  .insert({
                    lead_id: fullLeadData.id,
                    customer_id: fullLeadData.customer_id,
                    creative_title: aiResult.creative_title,
                    duration: formatDurationToDays(aiResult.duration),
                    destination: fullLeadData.destination,
                    travel_date: fullLeadData.travel_date,
                    starting_point: fullLeadData.starting_point,
                    adults: fullLeadData.requirements.adults,
                    children: fullLeadData.requirements.children,
                    infants: fullLeadData.requirements.babies,
                    created_by_staff_id: primaryAssignee.id,
                    branch_id: fullLeadData.branch_ids[0],
                    is_final: false,
                    modified_at: new Date().toISOString(),
                    status: "Prepared",
                  })
                  .select()
                  .single();
                if (metaError) throw metaError;

                const dayWisePlanForDb = aiResult.day_wise_plan.map(
                  (day, index) => ({
                    id: Date.now() + index,
                    day: day.day,
                    date: "", // Can be calculated on the frontend
                    title: day.title,
                    description: day.description,
                    meals: { b: false, l: false, d: false },
                    hotels: [],
                    transfers: [],
                    activities: [],
                  }),
                );

                // Process flights, hotels, visa from AI result
                const aiFlights = (aiResult.flights || []).map(
                  (flight, idx) => ({
                    id: Date.now() + idx + 1000,
                    direction: flight.direction || "onward",
                    segments: [
                      {
                        id: Date.now() + idx + 2000,
                        airline: flight.airline || "",
                        flight_number: flight.flight_number || "",
                        from: flight.from || "",
                        to: flight.to || "",
                        from_airport: flight.from || "",
                        to_airport: flight.to || "",
                        departure_time:
                          flight.departure_date && flight.departure_time
                            ? `${flight.departure_date}T${flight.departure_time}:00`
                            : null,
                        arrival_time:
                          flight.arrival_date && flight.arrival_time
                            ? `${flight.arrival_date}T${flight.arrival_time}:00`
                            : null,
                        duration: flight.duration || "",
                        stop: flight.stops || "0",
                        price: flight.price || 0,
                      },
                    ],
                    totalDuration: flight.duration || "",
                    price: flight.price || 0,
                  }),
                );

                const aiHotels = (aiResult.hotels || []).map((hotel, idx) => ({
                  id: Date.now() + idx + 3000,
                  name: hotel.name || "",
                  city: hotel.city || "",
                  check_in_date: hotel.check_in_date || "",
                  check_out_date: hotel.check_out_date || "",
                  nights: hotel.nights || 0,
                  rooms: hotel.rooms || 1,
                  room_type: hotel.room_type || "",
                  pricing_type: hotel.pricing_type || "Per Adult",
                  rate_per_night: hotel.rate_per_night || 0,
                  currency: "INR",
                  included: true,
                }));

                const aiVisa = aiResult.visa
                  ? {
                      type: aiResult.visa.type || "",
                      price: aiResult.visa.price || 0,
                      duration: aiResult.visa.duration || "",
                      validity_period: aiResult.visa.validity_period || "",
                      length_of_stay: aiResult.visa.length_of_stay || "",
                      documents_required:
                        aiResult.visa.documents_required || "",
                      requirements: aiResult.visa.requirements || "",
                    }
                  : null;

                const aiInsurance = aiResult.insurance || {
                  type: "Travel Insurance",
                  coverage: "Standard travel insurance coverage",
                  note: "Travel insurance included in the package",
                };

                const newVersionData = {
                  itinerary_id: newMetaData.id,
                  version_number: 1,
                  modified_at: new Date().toISOString(),
                  modified_by_staff_id: primaryAssignee.id,
                  overview: aiResult.overview,
                  day_wise_plan: dayWisePlanForDb,
                  inclusions: Array.isArray(aiResult.inclusions)
                    ? aiResult.inclusions.join("\n")
                    : aiResult.inclusions || "",
                  exclusions: Array.isArray(aiResult.exclusions)
                    ? aiResult.exclusions.join("\n")
                    : aiResult.exclusions || "",
                  terms_and_conditions: branchTerms || "", // Use default from branch
                  cancellation_policy: branchCancellationPolicy || "", // Use default from branch
                  important_notes: aiResult.important_notes || "",
                  detailed_flights: aiFlights,
                  detailed_hotels: aiHotels,
                  detailed_visa: aiVisa,
                  detailed_insurance: aiInsurance,
                };
                const { error: versionError } = await supabase
                  .from("itinerary_versions")
                  .insert(newVersionData);
                if (versionError) throw versionError;

                const { data: currentLeadData } = await supabase
                  .from("leads")
                  .select("itinerary_ids, activity")
                  .eq("id", lead.id)
                  .single();
                const updatedItineraryIds = [
                  ...(currentLeadData?.itinerary_ids || []),
                  newMetaData.id,
                ];
                const aiActivity = {
                  id: Date.now() + 2,
                  type: "Itinerary Generated",
                  description:
                    "AI generated the initial draft (v1) of the itinerary.",
                  user: "AI Assistant",
                  timestamp: new Date().toISOString(),
                };
                const updatedActivity = [
                  aiActivity,
                  ...(currentLeadData?.activity || []),
                ];

                await supabase
                  .from("leads")
                  .update({
                    itinerary_ids: updatedItineraryIds,
                    activity: updatedActivity,
                    last_updated: new Date().toISOString(),
                  })
                  .eq("id", lead.id);

                console.log(
                  `[Task] Successfully generated and created AI itinerary v1 for lead ${lead.id}.`,
                );
              } catch (error) {
                console.error(
                  `[Task] Error generating AI itinerary v1 for lead ${lead.id}:`,
                  error.message,
                );
              }
            })(),
          );
        } else {
          // Log why itinerary generation was skipped
          if (lead.status === "Enquiry") {
            console.log(
              `[Task] Skipping itinerary generation for lead ${lead.id}. Lead status is "Enquiry". Itineraries are only generated when status changes to "Processing".`,
            );
          } else if (hasOnlyNonTourServices) {
            console.log(
              `[Task] Skipping itinerary generation for lead ${
                lead.id
              }. Lead has only non-tour services: [${lead.services.join(
                ", ",
              )}]. Itinerary is only generated for Tour Package leads.`,
            );
          } else if (!hasTourPackage) {
            console.log(
              `[Task] Skipping itinerary generation for lead ${
                lead.id
              }. Tour Package not found in services: [${
                lead.services?.join(", ") || "none"
              }].`,
            );
          }
        }

        // Wait for all concurrent tasks to complete (or fail) before cleaning up.
        if (concurrentTasks.length > 0) {
          await Promise.allSettled(concurrentTasks);
        }
      } catch (error) {
        console.error(
          `[CRITICAL] Failed staff assignment process for lead ${lead.id}:`,
          error.message,
        );
        // Cleanup status hello -if critical path fails. The 'finally' block will also run.
        await supabase
          .from("leads")
          .update({ current_staff_name: null })
          .eq("id", lead.id);
        continue; // Skip to next lead
      } finally {
        // This 'finally' block guarantees that the UI status indicator is cleared
        // for this lead, regardless of whether the concurrent tasks succeeded or failed.
        await supabase
          .from("leads")
          .update({ current_staff_name: null })
          .eq("id", lead.id);
        console.log(`All tasks for lead ${lead.id} are complete.`);
      }
    }
    console.log("Lead processing check complete.");
  } catch (error) {
    console.error("Error during lead processing:", error.message);
  }
};

// FALLBACK: Lightweight polling as safety net (runs every 60 seconds)
// Primary assignment is event-driven via realtime listener, but this catches any leads that realtime might miss
// Checks ALL unassigned "Enquiry" leads to ensure nothing is left behind
const fallbackAssignmentCheck = async () => {
  try {
    // Check ALL unassigned "Enquiry" leads (not just recent ones) to ensure nothing is left behind
    // Limit to 50 leads per run to avoid overload - will catch more on next run if needed
    const { data: recentLeads, error: leadsError } = await supabase
      .from("leads")
      .select("id")
      .eq("status", "Enquiry")
      .order("created_at", { ascending: false })
      .limit(50); // Limit to 50 to avoid overload (processes more on next run if needed)

    if (leadsError) {
      const errorMsg =
        leadsError?.message ||
        leadsError?.toString() ||
        JSON.stringify(leadsError) ||
        "Unknown error";
      // Check if it's a Cloudflare/network error (HTML response)
      if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("<html>") ||
          errorMsg.includes("500 Internal Server Error"))
      ) {
        console.warn(
          "[FallbackAssignment] ⚠️ Network/Cloudflare error when fetching leads (likely temporary). Will retry on next cycle.",
        );
      } else {
        console.error("[FallbackAssignment] Error fetching leads:", errorMsg);
      }
      return;
    }

    if (!recentLeads || recentLeads.length === 0) {
      return; // No recent leads to check
    }

    const leadIds = recentLeads.map((l) => l.id);

    // Check which ones are already assigned
    const { data: assignedLeads, error: assignedError } = await supabase
      .from("lead_assignees")
      .select("lead_id")
      .in("lead_id", leadIds);

    if (assignedError) {
      const errorMessage =
        assignedError?.message ||
        assignedError?.toString() ||
        JSON.stringify(assignedError) ||
        "Unknown error";
      // Check if it's a Cloudflare/network error (HTML response)
      if (
        typeof errorMessage === "string" &&
        (errorMessage.includes("<html>") ||
          errorMessage.includes("500 Internal Server Error"))
      ) {
        console.warn(
          "[FallbackAssignment] ⚠️ Network/Cloudflare error when checking assignments (likely temporary). Will retry on next cycle.",
        );
      } else {
        console.error(
          "[FallbackAssignment] Error checking assignments:",
          errorMessage,
        );
      }
      return;
    }

    const assignedLeadIds = new Set(
      (assignedLeads || []).map((a) => a.lead_id),
    );
    const unassignedLeadIds = leadIds.filter((id) => !assignedLeadIds.has(id));

    if (unassignedLeadIds.length > 0) {
      console.log(
        `[FallbackAssignment] Found ${unassignedLeadIds.length} unassigned lead(s), triggering assignment...`,
      );
      // Process each unassigned lead (event-driven mode)
      for (const leadId of unassignedLeadIds) {
        assignLeadsAndGenerateItineraries(leadId).catch((err) => {
          const errorMsg =
            err?.message ||
            err?.toString() ||
            JSON.stringify(err) ||
            "Unknown error";
          console.error(
            `[FallbackAssignment] Error assigning lead ${leadId}:`,
            errorMsg,
          );
        });
      }
    }
  } catch (error) {
    const errorMessage =
      error?.message ||
      error?.toString() ||
      JSON.stringify(error) ||
      "Unknown error";
    console.error(
      "[FallbackAssignment] Error in fallback check:",
      errorMessage,
    );
  }
};

// Run fallback check every 60 seconds (lightweight safety net)
setInterval(fallbackAssignmentCheck, 60 * 1000);
// Also run immediately on startup (catches any leads created during server restart)
setTimeout(fallbackAssignmentCheck, 5000); // Wait 5 seconds after startup

// --- DAILY PRODUCTIVITY SUMMARY ---
// Sends daily summary at 8 PM to each branch admin
async function sendDailyProductivitySummary() {
  try {
    console.log(
      "[DailySummary] Starting daily productivity summary generation...",
    );

    // Get today's date range in IST (Indian Standard Time - UTC+5:30)
    const getISTDate = () => {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes
      const utcTime = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
      return new Date(utcTime + istOffset);
    };

    const istToday = getISTDate();
    istToday.setHours(0, 0, 0, 0);

    // Convert IST date back to UTC for database query
    const istOffset = 5.5 * 60 * 60 * 1000;
    const todayStart = new Date(istToday.getTime() - istOffset).toISOString();

    const istTomorrow = new Date(istToday);
    istTomorrow.setDate(istTomorrow.getDate() + 1);
    const todayEnd = new Date(istTomorrow.getTime() - istOffset).toISOString();

    // Get all active branches
    const { data: branches, error: branchesError } = await supabase
      .from("branches")
      .select("id, name, primary_contact")
      .eq("status", "Active");

    if (branchesError) {
      throw new Error(`Failed to fetch branches: ${branchesError.message}`);
    }

    if (!branches || branches.length === 0) {
      console.log("[DailySummary] No active branches found.");
      return;
    }

    // Process each branch
    for (const branch of branches) {
      try {
        // Use branch primary contact directly
        if (!branch.primary_contact) {
          console.log(
            `[DailySummary] Branch ${branch.name} (ID: ${branch.id}) has no primary contact. Skipping.`,
          );
          continue;
        }

        // Get leads for this branch created today
        // OPTIMIZATION: Use index-friendly query with limit to reduce Disk IO
        // Note: branch_ids is a JSON array, so we check if it contains the branch.id
        const { data: todayLeads, error: leadsError } = await supabase
          .from("leads")
          .select("id, status, created_at, branch_ids")
          .gte("created_at", todayStart)
          .lt("created_at", todayEnd)
          .limit(10000); // Add limit to prevent excessive data fetch

        // Filter leads that belong to this branch (branch_ids is a JSON array)
        const branchLeads =
          todayLeads?.filter((lead) => {
            if (!lead.branch_ids) return false;
            // Handle both array format and JSON string format
            const branchIds = Array.isArray(lead.branch_ids)
              ? lead.branch_ids
              : typeof lead.branch_ids === "string"
                ? JSON.parse(lead.branch_ids)
                : [];
            return branchIds.includes(branch.id);
          }) || [];

        if (leadsError) {
          console.error(
            `[DailySummary] Error fetching leads for branch ${branch.name}:`,
            leadsError.message,
          );
          continue;
        }

        // Calculate metrics (using filtered branchLeads instead of todayLeads)
        const totalLeads = branchLeads.length;
        const confirmedLeads = branchLeads.filter(
          (l) => l.status === "Confirmed",
        ).length;
        const rejectedLeads = branchLeads.filter(
          (l) => l.status === "Rejected",
        ).length;
        const paidLeads = branchLeads.filter(
          (l) => l.status === "Billing Completed",
        ).length;

        // Calculate conversion rate
        const conversionRate =
          totalLeads > 0
            ? ((confirmedLeads / totalLeads) * 100).toFixed(1)
            : "0.0";

        // Format date for display in IST
        const getISTDate = () => {
          const now = new Date();
          const istOffset = 5.5 * 60 * 60 * 1000;
          const utcTime = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
          return new Date(utcTime + istOffset);
        };
        const istToday = getISTDate();
        istToday.setHours(0, 0, 0, 0);
        const dateStr = istToday.toLocaleDateString("en-GB", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          timeZone: "Asia/Kolkata",
        });

        // Build summary message
        const summaryMessage = `📊 *Daily Productivity Summary*\n*${branch.name}*\n\n📅 *Date:* ${dateStr}\n\n📈 *Today's Performance:*\n\n🆕 *New Leads:* ${totalLeads}\n✅ *Confirmed:* ${confirmedLeads}\n💳 *Billing Completed:* ${paidLeads}\n❌ *Rejected/Lost:* ${rejectedLeads}\n\n📊 *Conversion Rate:* ${conversionRate}%\n\nKeep up the great work! 💪`;

        // Normalize branch primary contact phone
        let sanitizedPhone = normalizePhone(branch.primary_contact, "IN");
        if (!sanitizedPhone && branch.primary_contact) {
          const phoneStr = String(branch.primary_contact)
            .trim()
            .replace(/[\s\-\(\)]/g, "");
          if (phoneStr.startsWith("+91") || phoneStr.startsWith("919")) {
            sanitizedPhone = phoneStr.startsWith("+")
              ? phoneStr
              : `+${phoneStr}`;
          } else if (phoneStr.length === 10) {
            sanitizedPhone = `+91${phoneStr}`;
          }
        }

        if (!sanitizedPhone) {
          console.log(
            `[DailySummary] Invalid phone for branch ${branch.name} (primary_contact: ${branch.primary_contact}). Skipping.`,
          );
          continue;
        }

        // Try sending via template first
        let result = null;
        try {
          const templatePayload = {
            messaging_product: "whatsapp",
            to: sanitizedPhone,
            type: "template",
            template: {
              name: "daily_productivity_summary",
              language: { code: "en" },
              components: [
                {
                  type: "body",
                  parameters: [
                    { type: "text", text: branch.name },
                    { type: "text", text: dateStr },
                    { type: "text", text: totalLeads.toString() },
                    { type: "text", text: confirmedLeads.toString() },
                    { type: "text", text: partialPaymentLeads.toString() },
                    { type: "text", text: paidLeads.toString() },
                    { type: "text", text: rejectedLeads.toString() },
                    { type: "text", text: `${conversionRate}%` },
                  ],
                },
              ],
            },
          };

          console.log(
            `[DailySummary] 📤 Sending template to ${branch.name} (${sanitizedPhone})`,
          );
          const response = await fetch(WHATSAPP_GRAPH_API_BASE, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(templatePayload),
          });

          const apiResult = await response.json();
          if (response.ok && apiResult.messages) {
            result = apiResult;
            console.log(
              `[DailySummary] ✅ Template sent successfully to ${branch.name}`,
            );
          } else {
            const errorDetails = apiResult.error || apiResult;
            // Check for token expiration (error code 190)
            if (
              errorDetails.code === 190 ||
              errorDetails.type === "OAuthException"
            ) {
              console.error(
                `[DailySummary] 🔴 TOKEN EXPIRED: WhatsApp token has expired!`,
                errorDetails.message || "",
              );
              console.error(
                `[DailySummary] ⚠️ Action required: Generate a new token and update WHATSAPP_TOKEN environment variable`,
              );
            }
            console.warn(`[DailySummary] ⚠️ Template failed. Using fallback.`);
            throw new Error(`Template failed: ${JSON.stringify(apiResult)}`);
          }
        } catch (templateError) {
          // Fallback to plain text
          console.log(
            `[DailySummary] Using plain text fallback for ${branch.name}`,
          );
          result = await sendCrmWhatsappText(sanitizedPhone, summaryMessage);
        }

        if (result) {
          console.log(
            `[DailySummary] ✅ Summary sent to ${branch.name} (${sanitizedPhone})`,
          );
        } else {
          console.error(
            `[DailySummary] ❌ Failed to send summary to ${branch.name} (${sanitizedPhone})`,
          );
        }

        // Small delay between branches
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (branchError) {
        console.error(
          `[DailySummary] Error processing branch ${branch.name}:`,
          branchError.message,
        );
        continue;
      }
    }

    console.log("[DailySummary] Daily productivity summary completed.");
  } catch (error) {
    console.error(
      "[DailySummary] Error in daily productivity summary:",
      error.message,
    );
  }
}

// --- LEAD STATUS AUTO-SYNC (CRON) ---
// Voucher → On Travel when date of travel is today; On Travel → Feedback when end service date reached AND at least 24h in On Travel (manual change unrestricted)
const LEAD_STATUS_VOUCHER = "Voucher";
const LEAD_STATUS_ON_TOUR = "On Travel";
const LEAD_STATUS_FEEDBACK = "Feedback";
const LEAD_STATUS_ENQUIRY = "Enquiry";
const LEAD_TYPE_WARM = "Warm Lead";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeDate(s) {
  if (!s) return null;
  const part = String(s).split("T")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(part)) return part;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

// Parse duration to number of days (e.g. "5", "5 Days", "5 Days / 4 Nights" -> 5).
function parseDurationDays(duration) {
  if (!duration) return null;
  const match = String(duration).match(/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

// Format duration for display (e.g. "5 Days / 4 Nights" or "5" -> "5 Days").
function formatDurationToDays(duration) {
  const d = parseDurationDays(duration);
  return d != null ? `${d} Day${d !== 1 ? "s" : ""}` : "N/A";
}

// Normalize duration for storage (e.g. "5 Days / 4 Nights" -> "5"). Keeps lead duration as number of days.
function normalizeLeadDuration(duration) {
  const d = parseDurationDays(duration);
  return d != null ? String(d) : duration || null;
}

function addDaysToDateString(dateString, days) {
  const base = new Date(dateString);
  if (Number.isNaN(base.getTime())) return null;
  const updated = new Date(base);
  updated.setDate(updated.getDate() + days);
  return updated.toISOString().split("T")[0];
}

function getEndServiceDate(lead) {
  const ret = normalizeDate(lead.return_date);
  if (ret) return ret;
  if (!lead.travel_date) return null;
  const days = parseDurationDays(lead.duration);
  if (days === null) return null;
  return addDaysToDateString(lead.travel_date, days - 1);
}

async function runLeadStatusSync() {
  const today = getTodayDateString();
  const now = Date.now();
  try {
    const { data: leads, error } = await supabase
      .from("leads")
      .select("id, status, travel_date, return_date, duration, on_travel_since")
      .in("status", [LEAD_STATUS_VOUCHER, LEAD_STATUS_ON_TOUR]);
    if (error) {
      logger.warn("[LeadStatusSync] Failed to fetch leads:", error.message);
      return;
    }
    if (!leads || leads.length === 0) return;

    for (const lead of leads) {
      if (lead.status === LEAD_STATUS_VOUCHER && lead.travel_date) {
        const travelDateNorm = normalizeDate(lead.travel_date);
        if (travelDateNorm === today) {
          const onTravelSince = new Date().toISOString();
          const { error: upErr } = await supabase
            .from("leads")
            .update({
              status: LEAD_STATUS_ON_TOUR,
              lead_type: LEAD_TYPE_WARM,
              on_travel_since: onTravelSince,
            })
            .eq("id", lead.id);
          if (!upErr) {
            logger.info(
              `[LeadStatusSync] Lead ${lead.id} auto-updated Voucher → On Travel (travel_date today)`,
            );
          }
        }
      }

      if (lead.status === LEAD_STATUS_ON_TOUR) {
        const endDate = getEndServiceDate(lead);
        if (!endDate || endDate > today) continue;
        // Only skip if we have on_travel_since AND it's been less than 24h (new leads). Old leads with null on_travel_since get auto-moved when end date is reached.
        const onTravelSince = lead.on_travel_since
          ? new Date(lead.on_travel_since).getTime()
          : 0;
        if (onTravelSince && now - onTravelSince < TWENTY_FOUR_HOURS_MS)
          continue;

        const updates = {
          status: LEAD_STATUS_FEEDBACK,
          lead_type: LEAD_TYPE_WARM,
        };
        if (!lead.return_date && endDate) updates.return_date = endDate;
        const { error: upErr } = await supabase
          .from("leads")
          .update(updates)
          .eq("id", lead.id);
        if (!upErr) {
          logger.info(
            `[LeadStatusSync] Lead ${lead.id} auto-updated On Travel → Feedback (end date reached, 24h passed)`,
          );
        }
      }
    }
  } catch (err) {
    logger.warn("[LeadStatusSync] Error:", err?.message || err);
  }
}

function scheduleLeadStatusSync() {
  // Run every hour
  const INTERVAL_MS = 60 * 60 * 1000;
  runLeadStatusSync();
  setInterval(runLeadStatusSync, INTERVAL_MS);
  console.log("✅ Lead status auto-sync scheduled (every hour)");
}

// --- LEAD STAGNATION NOTIFICATIONS (ENQUIRY > 48 BUSINESS HOURS, MON–SAT) ---
function getBusinessHoursBetweenIST(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start
  ) {
    return 0;
  }
  let hours = 0;
  let t = start.getTime();
  const endTime = end.getTime();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  while (t < endTime) {
    const istString = new Date(t).toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    });
    const ist = new Date(istString);
    const day = ist.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    if (day !== 0) {
      hours += 1;
    }
    t += ONE_HOUR_MS;
  }
  return hours;
}

async function runStagnantEnquiryNotifications() {
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    const { data: enquiryLeads, error } = await supabase
      .from("leads")
      .select("id, created_at, status, services")
      .eq("status", LEAD_STATUS_ENQUIRY);
    if (error) {
      logger.warn(
        "[LeadStagnant] Failed to fetch enquiry leads:",
        error.message,
      );
      return;
    }
    if (!enquiryLeads || enquiryLeads.length === 0) return;

    const stagnantLeads = [];
    for (const lead of enquiryLeads) {
      const businessHours = getBusinessHoursBetweenIST(lead.created_at, nowIso);
      if (businessHours >= 48) {
        stagnantLeads.push(lead);
      }
    }
    if (stagnantLeads.length === 0) return;

    const stagnantLeadIds = stagnantLeads.map((l) => l.id);

    // Fetch assignees for all stagnant leads in a single query
    const { data: assigneeRows, error: assigneeError } = await supabase
      .from("lead_assignees")
      .select("lead_id, staff:staff_id(id, name)")
      .in("lead_id", stagnantLeadIds);
    if (assigneeError) {
      logger.warn(
        "[LeadStagnant] Failed to fetch lead assignees:",
        assigneeError.message,
      );
    }
    const assigneesByLead = new Map();
    (assigneeRows || []).forEach((row) => {
      const list = assigneesByLead.get(row.lead_id) || [];
      const staff = Array.isArray(row.staff) ? row.staff[0] : row.staff;
      if (staff && staff.name) {
        list.push(staff.name);
      }
      assigneesByLead.set(row.lead_id, list);
    });

    const { data: superAdmins, error: saError } = await supabase
      .from("staff")
      .select("id, name")
      .eq("role_id", 1);
    if (saError) {
      logger.warn(
        "[LeadStagnant] Failed to fetch Super Admins:",
        saError.message,
      );
      return;
    }
    if (!superAdmins || superAdmins.length === 0) {
      logger.warn(
        "[LeadStagnant] No Super Admins found; skipping stagnant enquiry notifications.",
      );
      return;
    }

    for (const lead of stagnantLeads) {
      const link = `/leads?openLead=${lead.id}&tab=details`;
      // Skip if we already created notifications for this lead/link.
      // NOTE: Do NOT filter by "type" here with a custom value, as notification_type is a Postgres enum.
      const { data: existing, error: existingError } = await supabase
        .from("notifications")
        .select("id")
        .eq("link", link)
        .limit(1);
      if (existingError) {
        logger.warn(
          `[LeadStagnant] Failed to check existing notifications for lead ${lead.id}:`,
          existingError.message,
        );
        continue;
      }
      if (existing && existing.length > 0) {
        continue;
      }

      const services = Array.isArray(lead.services)
        ? lead.services.join(", ")
        : "N/A";
      const assigneeNames = assigneesByLead.get(lead.id) || [];
      const assigneeLabel =
        assigneeNames.length > 0 ? assigneeNames.join(", ") : "Unassigned";

      const title = "Lead in Enquiry status for more than 2 business days";
      const body = `Lead ${lead.id} (${services}) has been in Enquiry status for more than 2 business days (48 business hours) without progress from the assigned staff (${assigneeLabel}). Please review this lead.`;

      for (const sa of superAdmins) {
        await supabase.from("notifications").insert({
          staff_id: sa.id,
          // Reuse an existing generic notification type to satisfy the Postgres enum.
          // Frontend treats this as a normal (non-task, non-mention) notification.
          type: "leave_pending_reminder",
          title,
          body,
          link,
        });
      }

      logger.info(
        `[LeadStagnant] Created stagnant enquiry notifications for lead ${lead.id}`,
      );
    }
  } catch (err) {
    logger.warn(
      "[LeadStagnant] Error while creating stagnant enquiry notifications:",
      err?.message || err,
    );
  }
}

function scheduleStagnantEnquiryNotifications() {
  // Run once per day at 12:05 AM IST (Asia/Kolkata)
  const CHECK_HOUR = 0; // 12 AM
  const CHECK_MINUTE = 5; // 12:05 AM

  function getISTNow() {
    // Current time in Asia/Kolkata as a Date object
    const now = new Date();
    return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  }

  function scheduleNextRun() {
    const istNow = getISTNow();
    let nextRun = new Date(istNow);
    nextRun.setHours(CHECK_HOUR, CHECK_MINUTE, 0, 0);

    // If it's already past today's scheduled time, schedule for tomorrow
    if (istNow >= nextRun) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    const msUntilNextRun = nextRun.getTime() - istNow.getTime();

    console.log(
      `[LeadStagnant] ⏰ Next stagnant enquiry check scheduled for ${nextRun.toLocaleString(
        "en-IN",
        { timeZone: "Asia/Kolkata" },
      )} (12:05 AM IST)`,
    );

    setTimeout(async () => {
      await runStagnantEnquiryNotifications();
      scheduleNextRun(); // Schedule the next daily run
    }, msUntilNextRun);
  }

  console.log(
    "[LeadStagnant] 🚀 Starting stagnant enquiry scheduler (daily at 12:05 AM IST)",
  );
  scheduleNextRun();
}

// Schedule daily summary at 8 PM IST (Indian Standard Time - UTC+5:30)
function scheduleDailySummary() {
  const getISTTime = () => {
    const now = new Date();
    // IST is UTC+5:30
    const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    const istTime = new Date(utcTime + istOffset);
    return istTime;
  };

  const getNext8PMIST = () => {
    const istNow = getISTTime();
    const targetTime = new Date(istNow);
    targetTime.setHours(20, 0, 0, 0); // 8 PM IST

    // If it's already past 8 PM IST today, schedule for tomorrow
    if (istNow >= targetTime) {
      targetTime.setDate(targetTime.getDate() + 1);
    }

    // Convert IST time back to UTC for scheduling
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utcTargetTime = new Date(targetTime.getTime() - istOffset);
    return utcTargetTime;
  };

  const now = new Date();
  const targetTime = getNext8PMIST();
  const msUntilTarget = targetTime.getTime() - now.getTime();

  const istTarget = getISTTime();
  istTarget.setHours(20, 0, 0, 0);
  if (getISTTime() >= istTarget) {
    istTarget.setDate(istTarget.getDate() + 1);
  }

  console.log(
    `[DailySummary] Scheduled for 8 PM IST (${istTarget.toLocaleString(
      "en-IN",
      { timeZone: "Asia/Kolkata" },
    )}). Will run in ${Math.round(msUntilTarget / 1000 / 60)} minutes.`,
  );

  setTimeout(() => {
    sendDailyProductivitySummary();
    // Schedule for next day (24 hours later)
    setInterval(sendDailyProductivitySummary, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}

/**
 * Schedule TBO Static Data Refresh
 * Runs on 1st, 15th, and last day of each month (approximately every 15 days)
 * Time: 2 AM IST (as per TBO recommendations)
 */
function scheduleTboStaticDataRefresh() {
  const REFRESH_HOUR = 2; // 2 AM IST
  const REFRESH_MINUTE = 0;
  const IST_OFFSET_HOURS = 5.5; // IST is UTC+5:30

  function getISTTime() {
    const now = new Date();
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    return new Date(utcTime + IST_OFFSET_HOURS * 60 * 60 * 1000);
  }

  function getLastDayOfMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function getNextRefreshDate() {
    const istNow = getISTTime();
    const currentDay = istNow.getDate();
    const currentMonth = istNow.getMonth();
    const currentYear = istNow.getFullYear();
    const lastDay = getLastDayOfMonth(currentYear, currentMonth);

    // Determine next refresh day: 1st, 15th, or last day
    let nextDay;
    if (currentDay < 1) {
      nextDay = 1;
    } else if (currentDay < 15) {
      nextDay = 15;
    } else if (currentDay < lastDay) {
      nextDay = lastDay;
    } else {
      // Move to next month's 1st
      const nextMonth = new Date(currentYear, currentMonth + 1, 1);
      return nextMonth;
    }

    const targetDate = new Date(currentYear, currentMonth, nextDay);
    targetDate.setHours(REFRESH_HOUR, REFRESH_MINUTE, 0, 0);

    // If target time has passed today, move to next refresh date
    if (targetDate <= istNow) {
      if (nextDay === 1) {
        targetDate.setDate(15);
      } else if (nextDay === 15) {
        const lastDayOfMonth = getLastDayOfMonth(currentYear, currentMonth);
        targetDate.setDate(lastDayOfMonth);
      } else {
        // Move to next month's 1st
        targetDate.setMonth(currentMonth + 1);
        targetDate.setDate(1);
      }
    }

    // Convert IST back to UTC
    const utcTarget = new Date(
      targetDate.getTime() - IST_OFFSET_HOURS * 60 * 60 * 1000,
    );
    return utcTarget;
  }

  async function runTboRefresh() {
    const startTime = Date.now();
    console.log(
      `\n[${new Date().toISOString()}] 🚀 Starting scheduled TBO static data refresh...\n`,
    );

    try {
      // Step 1: Refresh countries
      console.log("[TBO Refresh] Step 1/3: Refreshing countries...");
      const countries = await fetchTboCountryList();
      await storeTboCountries(countries);
      console.log(`[TBO Refresh] ✅ Refreshed ${countries.length} countries`);

      // Step 2: Refresh cities
      console.log("[TBO Refresh] Step 2/3: Refreshing cities...");
      const allCities = [];
      let citiesProcessed = 0;

      for (const country of countries) {
        try {
          const cities = await fetchTboCityList(country.code);
          await storeTboCities(cities, country.code);
          allCities.push(
            ...cities.map((c) => ({ ...c, countryCode: country.code })),
          );
          citiesProcessed += cities.length;
          await new Promise((resolve) => setTimeout(resolve, 300)); // Rate limiting
        } catch (error) {
          console.error(
            `[TBO Refresh] ⚠️  Skipping cities for ${country.code}: ${error.message}`,
          );
          continue;
        }
      }
      console.log(`[TBO Refresh] ✅ Refreshed ${citiesProcessed} cities`);

      // Step 3: Refresh hotels
      console.log("[TBO Refresh] Step 3/3: Refreshing hotels...");
      let totalHotels = 0;

      for (const city of allCities) {
        try {
          const hotels = await fetchTboHotelCodeList(city.code);
          await storeTboHotelCodes(
            hotels,
            city.code,
            city.name,
            city.countryCode,
          );
          totalHotels += hotels.length;
          await new Promise((resolve) => setTimeout(resolve, 300)); // Rate limiting
        } catch (error) {
          console.error(
            `[TBO Refresh] ⚠️  Skipping hotels for city ${city.code}: ${error.message}`,
          );
          continue;
        }
      }

      const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
      console.log(`[TBO Refresh] ✅ Refresh completed!`);
      console.log(
        `[TBO Refresh]   Countries: ${countries.length}, Cities: ${citiesProcessed}, Hotels: ${totalHotels}`,
      );
      console.log(`[TBO Refresh]   Duration: ${duration} minutes\n`);
    } catch (error) {
      console.error(`[TBO Refresh] ❌ Error during refresh:`, error.message);
      logger.error("[TBO Refresh] Scheduled refresh failed", {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  function scheduleNextRun() {
    const nextRun = getNextRefreshDate();
    const msUntilNext = nextRun.getTime() - Date.now();

    const istNextRun = new Date(
      nextRun.getTime() + IST_OFFSET_HOURS * 60 * 60 * 1000,
    );
    const daysUntilNext = (msUntilNext / (1000 * 60 * 60 * 24)).toFixed(1);

    console.log(
      `[TBO Refresh] Scheduled for ${istNextRun.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })} IST (${daysUntilNext} days)`,
    );

    setTimeout(
      async () => {
        await runTboRefresh();
        // Schedule next run after completion
        scheduleNextRun();
      },
      Math.max(0, msUntilNext),
    );
  }

  // Start scheduling
  scheduleNextRun();
}

// Start the daily summary scheduler
scheduleDailySummary();

// --- AUTOMATIC FEEDBACK LINK SENDING ---
// Sends Google review link when lead status changes to "Feedback"
async function sendFeedbackLinkMessage(lead, customer) {
  try {
    // Check if feedback message was already sent (prevent duplicates)
    const feedbackSent = (lead.activity || []).some(
      (act) =>
        act.type === "Feedback Request Sent" &&
        act.description?.includes("Feedback request sent to customer"),
    );

    if (feedbackSent) {
      console.log(
        `[Feedback] Feedback link already sent for lead ${lead.id}. Skipping duplicate.`,
      );
      return;
    }

    // Normalize customer phone number
    let sanitizedPhone = normalizePhone(customer.phone, "IN");

    // Fallback phone normalization
    if (!sanitizedPhone && customer.phone) {
      const phoneStr = String(customer.phone).trim();
      const cleaned = phoneStr.replace(/[\s\-\(\)]/g, "");
      if (cleaned.startsWith("+91") || cleaned.startsWith("919")) {
        sanitizedPhone = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
      } else if (cleaned.length === 10) {
        sanitizedPhone = `+91${cleaned}`;
      }
    }

    if (!sanitizedPhone) {
      console.warn(
        `[Feedback] Could not normalize customer phone for lead ${lead.id}: ${customer.phone}. Skipping feedback message.`,
      );
      await logLeadActivity(
        lead.id,
        "Feedback Request Failed",
        `Failed to send feedback request to customer "${customer.first_name} ${customer.last_name}" (invalid phone number: '${customer.phone}').`,
        "System",
      );
      return;
    }

    // Use the approved "feedback_request" WhatsApp template
    let result = null;
    try {
      // Use first name only for the template (as shown in the template: "Hello {{1}}!")
      const customerFirstName = customer.first_name || "Customer";

      // Template structure:
      // Body: Hello {{1}}! 👋 ... (uses customer first name)
      // Button: "Rate Your Experience" - URL is STATIC (hardcoded in Meta Business Manager)
      // Footer: "Madura Travel Service" - static text
      const templatePayload = {
        messaging_product: "whatsapp",
        to: sanitizedPhone,
        type: "template",
        template: {
          name: "feedback_request",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: customerFirstName }],
            },
            // Note: Button URL is static/hardcoded in template, so no button component needed
          ],
        },
      };

      console.log(
        `[Feedback] 📤 Sending feedback_request template to ${sanitizedPhone}`,
      );
      const response = await fetch(WHATSAPP_GRAPH_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(templatePayload),
      });

      const apiResult = await response.json();
      if (response.ok && apiResult.messages) {
        result = apiResult;
        console.log(
          `[Feedback] ✅ Template message sent successfully for lead ${lead.id}`,
        );
      } else {
        console.warn(
          `[Feedback] ⚠️ Template message failed. Reason: ${JSON.stringify(
            apiResult,
          )}`,
        );
        throw new Error(`WhatsApp API error: ${JSON.stringify(apiResult)}`);
      }
    } catch (templateError) {
      console.warn(
        `[Feedback] ⚠️ Template message failed for lead ${lead.id}. Trying plain text fallback:`,
        templateError.message,
      );
      // Fallback: Send as plain text with link in message
      const feedbackLink =
        "https://search.google.com/local/writereview?placeid=ChIJnVd0XJ9nUjoRblhbY-Aip8k";
      const fallbackMessage = `Hello ${customer.first_name}! 👋\n\nThank you for choosing Madura Travel Service! We hope you had a wonderful experience with us. 🌟\n\nWe would love to hear your feedback! Please take a moment to share your experience by clicking the link below:\n\n🔗 ${feedbackLink}\n\nYour feedback helps us serve you better! 🙏`;
      result = await sendCrmWhatsappText(sanitizedPhone, fallbackMessage);
    }

    if (result) {
      await logLeadActivity(
        lead.id,
        "Feedback Request Sent",
        `Feedback request with Google review link sent to customer "${customer.first_name} ${customer.last_name}" via WhatsApp.`,
        "System",
      );
      console.log(
        `[Feedback] ✅ Feedback link sent successfully to customer for lead ${lead.id}`,
      );
    } else {
      await logLeadActivity(
        lead.id,
        "Feedback Request Failed",
        `Failed to send feedback request to customer "${customer.first_name} ${customer.last_name}" via WhatsApp.`,
        "System",
      );
      console.error(
        `[Feedback] ❌ Failed to send feedback link for lead ${lead.id}`,
      );
    }
  } catch (error) {
    console.error(
      `[Feedback] Error sending feedback link for lead ${lead.id}:`,
      error.message,
    );
    await logLeadActivity(
      lead.id,
      "Feedback Request Failed",
      `Error sending feedback request: ${error.message}`,
      "System",
    );
  }
}

// Function to create Razorpay payment link for itinerary (without sending invoice template)
async function createRazorpayLinkForItinerary(lead, customer) {
  try {
    // Check if invoice with payment link already exists for this lead
    const { data: existingInvoice } = await supabase
      .from("invoices")
      .select("id, razorpay_payment_link_url")
      .eq("lead_id", lead.id)
      .not("razorpay_payment_link_url", "is", null)
      .limit(1)
      .maybeSingle();

    if (existingInvoice?.razorpay_payment_link_url) {
      console.log(
        `[Razorpay Link] Payment link already exists for lead ${lead.id}. Skipping creation.`,
      );
      return existingInvoice.razorpay_payment_link_url;
    }

    // Check if invoice exists but without payment link
    const { data: existingInvoiceWithoutLink } = await supabase
      .from("invoices")
      .select("id, invoice_number, balance_due, total_amount")
      .eq("lead_id", lead.id)
      .limit(1)
      .maybeSingle();

    let invoiceId = null;
    let amount = 5000; // Default booking fees

    if (existingInvoiceWithoutLink) {
      invoiceId = existingInvoiceWithoutLink.id;
      amount =
        existingInvoiceWithoutLink.balance_due ||
        existingInvoiceWithoutLink.total_amount ||
        5000;
      console.log(
        `[Razorpay Link] Found existing invoice #${existingInvoiceWithoutLink.invoice_number} for lead ${lead.id}. Creating payment link.`,
      );
    } else {
      // Create a minimal invoice for payment link
      const bookingFees = 5000;
      const today = new Date();
      const dueDate = new Date();
      dueDate.setDate(today.getDate() + 7);

      const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;
      const bookingId = `MTS-${lead.id}`;

      const newInvoice = {
        invoice_number: invoiceNumber,
        lead_id: lead.id,
        customer_id: customer.id,
        issue_date: today.toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        status: "DRAFT",
        items: [
          {
            id: Date.now(),
            description: `Booking Confirmation & Advance for ${
              lead.destination || "Tour Package"
            }`,
            qty: 1,
            rate: bookingFees,
            amount: bookingFees,
          },
        ],
        total_amount: bookingFees,
        balance_due: bookingFees,
        created_at: new Date().toISOString(),
      };

      const { data: createdInvoice, error: createError } = await supabase
        .from("invoices")
        .insert(newInvoice)
        .select()
        .single();

      if (createError || !createdInvoice) {
        throw new Error(createError?.message || "Failed to create invoice");
      }

      invoiceId = createdInvoice.id;
      amount = bookingFees;
      console.log(
        `[Razorpay Link] Created invoice #${invoiceNumber} for lead ${lead.id}`,
      );
    }

    // Generate Razorpay payment link
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      console.warn(
        `[Razorpay Link] Razorpay credentials not configured. Cannot generate payment link for lead ${lead.id}.`,
      );
      return null;
    }

    const auth = Buffer.from(
      `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`,
    ).toString("base64");

    const phoneDigits = customer.phone.replace(/[^0-9]/g, "");
    const contactPhone = phoneDigits.slice(-10);

    const razorpayResponse = await fetch(`${RAZORPAY_API_URL}/payment_links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: amount * 100, // Razorpay expects amount in paise
        currency: "INR",
        description: `Booking Payment - ${customer.first_name} ${
          customer.last_name
        } - ${lead.destination || "Tour Package"} - MTS-${lead.id}`,
        customer: {
          name: `${customer.first_name} ${customer.last_name}`,
          email: customer.email || "",
          contact: contactPhone,
        },
        notify: { sms: false, email: false }, // Don't notify - link is only in PDF
        reminder_enable: false, // No reminders
        callback_url: "https://crm.maduratravel.com/payments",
        callback_method: "get",
      }),
    });

    const razorpayData = await razorpayResponse.json();
    if (!razorpayResponse.ok) {
      console.error(
        `[Razorpay Link] Razorpay error for lead ${lead.id}:`,
        JSON.stringify(razorpayData, null, 2),
      );
      throw new Error(
        razorpayData.error?.description ||
          "Failed to create Razorpay payment link",
      );
    }

    // Update invoice with payment link
    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        razorpay_payment_link_id: razorpayData.id,
        razorpay_payment_link_url: razorpayData.short_url,
        status: "SENT",
      })
      .eq("id", invoiceId);

    if (updateError) {
      console.error(
        `[Razorpay Link] Failed to update invoice with payment link:`,
        updateError.message,
      );
    }

    console.log(
      `[Razorpay Link] Generated Razorpay payment link for lead ${lead.id}: ${razorpayData.short_url}`,
    );

    await logLeadActivity(
      lead.id,
      "Payment Link Created",
      `Razorpay payment link created for itinerary. Payment link will be included in PDF.`,
      "System",
    );

    return razorpayData.short_url;
  } catch (error) {
    console.error(
      `[Razorpay Link] Error creating payment link for lead ${lead.id}:`,
      error.message,
    );
    // Don't throw - just log the error so itinerary generation can continue
    return null;
  }
}

// REMOVED: Automatic invoice creation functionality
// Invoices should be created manually by staff through the CRM interface

// --- PERIODIC LEAD UPDATE NOTIFIER ---
// DISABLED: Customer message sending on lead changes
// Checks for leads with recent status/services/travel_date changes but does NOT send WhatsApp notifications to customers
// Only handles backend actions like invoice creation (without sending messages)
const checkLeadUpdatesAndNotify = async () => {
  console.log(
    "[UpdateNotifier] Checking for lead changes (customer messages disabled)...",
  );
  try {
    // Get leads that were modified in the last 5 minutes (buffer for consistency)
    // OPTIMIZATION: Increased window since we check every 5 minutes now
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // OPTIMIZATION: Only fetch necessary fields to reduce egress
    const { data: recentLeads, error: leadsError } = await supabase
      .from("leads")
      .select(
        "id, status, notified_status, customer_id, customer:customers(id, first_name, last_name, email, phone), all_assignees:lead_assignees(staff(id, name))",
      )
      .gt("last_updated", fiveMinutesAgo);

    if (leadsError) throw leadsError;
    if (!recentLeads || recentLeads.length === 0) {
      console.log("[UpdateNotifier] No recent lead changes detected.");
      return;
    }

    console.log(
      `[UpdateNotifier] Found ${recentLeads.length} leads updated in last 90 seconds. Customer messages disabled.`,
    );

    // For each lead, handle backend actions only (invoice creation, etc.) - NO customer messages
    for (const lead of recentLeads) {
      try {
        const customer = lead.customer;
        if (!customer) continue;

        // WhatsApp messages are only triggered for Feedback status
        // All other status changes do not trigger WhatsApp messages

        // Handle backend actions only - NO customer messages

        // Mark other significant statuses as notified (but don't send messages)
        // Note: significantStatuses removed - this block is now handled by specific status checks below

        // Mark Processing status as notified (but don't send messages)
        if (
          lead.status === "Processing" &&
          lead.notified_status !== "Processing"
        ) {
          console.log(
            `[UpdateNotifier] Lead ${lead.id} status changed to Processing. Marking as notified (no customer message).`,
          );
          await supabase
            .from("leads")
            .update({ notified_status: "Processing" })
            .eq("id", lead.id);
        }

        // Handle Feedback status - send feedback template
        if (lead.status === "Feedback" && lead.notified_status !== "Feedback") {
          console.log(
            `[UpdateNotifier] Lead ${lead.id} status is Feedback. Sending feedback template...`,
          );
          try {
            await sendFeedbackLinkMessage(lead, customer);
            // Mark as notified to prevent duplicate processing
            await supabase
              .from("leads")
              .update({ notified_status: "Feedback" })
              .eq("id", lead.id);
            console.log(
              `[UpdateNotifier] ✅ Feedback template sent for lead ${lead.id}`,
            );
          } catch (feedbackError) {
            console.error(
              `[UpdateNotifier] Error sending feedback template for lead ${lead.id}:`,
              feedbackError.message,
              feedbackError.stack,
            );
          }
        }
      } catch (err) {
        console.error(
          `[UpdateNotifier] Error processing lead ${lead.id}:`,
          err.message,
        );
      }
    }

    console.log(
      "[UpdateNotifier] Lead update check complete (no customer messages sent).",
    );
  } catch (error) {
    const errorMessage =
      error?.message ||
      error?.toString() ||
      JSON.stringify(error) ||
      "Unknown error";
    console.error("[UpdateNotifier] Error during check:", errorMessage);
  }
};

// OPTIMIZATION: Run every 5 minutes instead of 60 seconds to reduce egress by 83%
// For 9 users, checking every minute is excessive
setInterval(checkLeadUpdatesAndNotify, 5 * 60 * 1000);

// --- WEBSITE LEAD ENDPOINT ---

app.post("/api/lead/website", async (req, res) => {
  try {
    // Handle Elementor's potential 'form_fields' nesting or a flat payload
    const formData = req.body.form_fields || req.body;
    console.log(
      "Received website lead data:",
      JSON.stringify(formData, null, 2),
    );

    // Robustly extract fields, checking for multiple possible names (e.g., 'name' or 'Name')
    const name = formData.name || formData.Name;
    const phone = formData.phone || formData.Phone;
    const travel_date =
      formData.date ||
      formData.Date ||
      formData["Date of Travel"] ||
      formData.date_of_travel;
    const enquiry =
      formData.enquiry ||
      formData["Type of Enquiry?"] ||
      formData.type_of_enquiry;
    const nationality = formData.nationality || formData.Nationality;
    const email = formData.email || formData.Email;
    const destination = formData.destination || formData.Destination;

    // Other optional fields from the existing code
    const { duration, starting_point, summary } = formData;

    // Core fields required
    if (!name || !phone || !travel_date) {
      console.error("Validation failed: Missing name, phone, or travel_date.", {
        name,
        phone,
        travel_date,
      });
      return res.status(400).json({
        message:
          "Missing required fields: name, phone, and a travel date (field ID: 'date' or 'Date of Travel') are required.",
      });
    }

    // Use branch_id from form data if provided, otherwise default to branch 1
    const targetBranchId = formData.branch_id
      ? parseInt(formData.branch_id, 10)
      : 1;
    console.log(
      `[Website Lead] Using branch_id: ${targetBranchId} (from formData.branch_id: ${formData.branch_id})`,
    );

    // 1. Find or Create Customer
    let customer;

    // Normalize phone using the normalizePhone utility function
    let phoneNormalized = normalizePhone(phone, "IN");

    // Fallback: If normalizePhone fails, try manual normalization
    if (!phoneNormalized && phone) {
      const phoneStr = String(phone)
        .trim()
        .replace(/[\s\-\(\)]/g, "");

      // Handle phone numbers without + prefix (common from website forms)
      // If it starts with 91 (India) and is 12 digits, add +
      if (phoneStr.startsWith("91") && phoneStr.length === 12) {
        phoneNormalized = `+${phoneStr}`;
      }
      // If it's 10 digits (Indian number without country code), add +91
      else if (phoneStr.length === 10 && /^\d+$/.test(phoneStr)) {
        phoneNormalized = `+91${phoneStr}`;
      }
      // If it doesn't start with +, try to add it if it looks like a valid number
      else if (!phoneStr.startsWith("+") && /^\d+$/.test(phoneStr)) {
        // If it's 11-15 digits, assume it has country code and add +
        if (phoneStr.length >= 11 && phoneStr.length <= 15) {
          phoneNormalized = `+${phoneStr}`;
        }
      }
    }

    // Validate phone format (should start with + and have 7-15 digits after country code)
    if (!phoneNormalized || !phoneNormalized.match(/^\+\d{7,15}$/)) {
      console.error(
        "Invalid phone format:",
        phone,
        "normalized:",
        phoneNormalized,
      );
      return res.status(400).json({
        message:
          "Invalid phone number format. Please use format: +919876543210",
      });
    }

    const { data: existingCustomer, error: findError } = await supabase
      .from("customers")
      .select("*")
      .or(
        `phone.eq.${phoneNormalized},phone.eq.${phoneNormalized.replace(
          /^\+/,
          "",
        )}`,
      )
      .limit(1)
      .maybeSingle();

    if (findError) throw findError;

    if (existingCustomer) {
      customer = existingCustomer;

      // Sync customer's shared_with_branch_ids with target branch
      // Add target branch to shared_with_branch_ids if it's different from the customer's owner branch
      const updateFields = {};
      const customerOwnerBranch = customer.added_by_branch_id;

      // Only add to shared_with_branch_ids if target branch is different from owner branch
      if (targetBranchId !== customerOwnerBranch) {
        const currentSharedBranches = new Set(
          customer.shared_with_branch_ids || [],
        );

        // Add target branch to shared branches if not already present
        if (!currentSharedBranches.has(targetBranchId)) {
          currentSharedBranches.add(targetBranchId);
          updateFields.shared_with_branch_ids = Array.from(
            currentSharedBranches,
          );
          console.log(
            `[Website Lead] Adding branch ${targetBranchId} to customer ${customer.id} shared_with_branch_ids. Customer owner branch: ${customerOwnerBranch}`,
          );
        }
      }

      // Update nationality if provided and missing
      if (nationality && !customer.nationality) {
        updateFields.nationality = nationality;
      }

      // Update customer if any fields need updating
      if (Object.keys(updateFields).length > 0) {
        const { data: updatedCustomer, error: updateError } = await supabase
          .from("customers")
          .update(updateFields)
          .eq("id", customer.id)
          .select()
          .single();
        if (updateError)
          console.warn("Could not update customer:", updateError.message);
        else customer = updatedCustomer;
      }
    } else {
      const nameParts = name.split(" ");
      const first_name = nameParts[0];
      const last_name = nameParts.slice(1).join(" ") || first_name;

      const { data: newCustomer, error: createError } = await supabase
        .from("customers")
        .insert({
          salutation: "Mr.",
          first_name,
          last_name,
          email: email || null,
          phone: phoneNormalized, // Store in continuous format (no spaces): +917397670826
          nationality: nationality || null,
          username: `@${(first_name + last_name)
            .toLowerCase()
            .replace(/\s/g, "")}${Date.now().toString().slice(-4)}`,
          avatar_url: `https://avatar.iran.liara.run/public/boy?username=${Date.now()}`,
          date_added: new Date().toISOString(),
          added_by_branch_id: targetBranchId,
        })
        .select()
        .single();

      if (createError) throw createError;
      customer = newCustomer;
    }

    const enquiryType = enquiry;

    // Extract services array if provided, otherwise parse from enquiry
    let services = formData.services || [];
    let enquiryTypeForSummary = enquiryType;

    // If services array is provided, use it directly
    if (Array.isArray(services) && services.length > 0) {
      // Services array is already provided, use it as-is
      enquiryTypeForSummary = services.join(", ");
    } else {
      // No services array provided, parse from enquiry string
      services = ["Tour Package"]; // Default to 'Tour Package' for "Other" or unrecognized
      if (enquiryType) {
        const enquiryLower = String(enquiryType).toLowerCase();
        // Parse comma-separated services from enquiry
        if (enquiryLower.includes(",")) {
          services = enquiryType
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        } else {
          // Single service - parse as before
          if (enquiryLower.includes("tour")) services = ["Tour Package"];
          else if (enquiryLower.includes("visa")) services = ["Visa"];
          else if (
            enquiryLower.includes("air ticket") ||
            enquiryLower.includes("flight")
          )
            services = ["Air Ticket"];
          else if (
            enquiryLower.includes("forex") ||
            enquiryLower.includes("currency")
          )
            services = ["Forex"];
          else if (enquiryLower.includes("passport")) services = ["Passport"];
          else if (enquiryLower.includes("hotel")) services = ["Hotel"];
          else if (enquiryLower.includes("transport")) services = ["Transport"];
          else if (enquiryLower.includes("mice")) services = ["MICE"];
          else if (enquiryLower.includes("insurance")) services = ["Insurance"];
          // 'Other' will fall through to the default of 'Tour Package'
        }
      }
    }

    // Parse passenger details from the form data
    const adults =
      parseInt(formData.adults, 10) ||
      parseInt(formData.travelers, 10) ||
      parseInt(formData.attendees, 10) ||
      parseInt(formData.passengers, 10) ||
      1;
    const children = parseInt(formData.children, 10) || 0;
    const babies = parseInt(formData.babies, 10) || 0;

    // Handle child_ages - can be array or individual fields
    let child_ages = [];
    if (Array.isArray(formData.children_ages)) {
      child_ages = formData.children_ages
        .map((age) => parseInt(age, 10))
        .filter((age) => !isNaN(age) && age >= 1 && age <= 18);
    } else if (formData.children_ages) {
      // Handle comma-separated or space-separated ages
      child_ages = String(formData.children_ages)
        .split(/[,\s]+/)
        .map((age) => parseInt(age.trim(), 10))
        .filter((age) => !isNaN(age) && age >= 1 && age <= 18);
    } else {
      // Try to find child_age_1, child_age_2, etc.
      for (let i = 1; i <= children; i++) {
        const ageField =
          formData[`child_age_${i}`] || formData[`children_ages[${i - 1}]`];
        if (ageField) {
          const age = parseInt(ageField, 10);
          if (!isNaN(age) && age >= 1 && age <= 18) child_ages.push(age);
        }
      }
    }

    const leadRequirements = {
      adults: adults,
      children: children,
      babies: babies,
      child_ages: child_ages,
      hotelPreference: "No Preference",
      stayPreference: "No Preference",
      rooms: [
        {
          id: Date.now(),
          adults: adults,
          children: children,
          child_ages: child_ages.length > 0 ? child_ages : undefined,
        },
      ],
    };

    // Extract service-specific fields
    const {
      is_flexible_dates,
      is_return_ticket,
      return_date,
      visa_type,
      visa_duration,
      check_in_date,
      check_out_date,
      budget,
      forex_currency_have,
      forex_currency_required,
      passport_service_type,
      passport_city_of_residence,
      passport_number,
      passport_expiry_date,
      tour_type,
      tour_region,
      insurance_type,
      vehicle_type,
      pickup_location,
      dropoff_location,
      event_type,
      event_date,
      venue_location,
      attendees,
      mice_requirements,
      travelers,
      passengers,
      amount,
      rooms,
      hotel_stays,
      hotel_destinations,
      hotel_nights,
      staff_id,
    } = formData;

    // Fetch staff information if staff_id is provided (for activity log)
    let staffForActivity = null;
    if (staff_id) {
      const staffIdNum = parseInt(staff_id, 10);
      if (!isNaN(staffIdNum)) {
        try {
          const { data: staffData } = await supabase
            .from("staff")
            .select("id, name")
            .eq("id", staffIdNum)
            .single();
          if (staffData) {
            staffForActivity = staffData;
          }
        } catch (err) {
          console.warn(
            "[Website Lead] Could not fetch staff for activity log:",
            err.message,
          );
        }
      }
    }

    // 2. Create Lead
    const leadSource = staff_id ? "Staff Link" : "website";
    const activityDescription = staffForActivity
      ? `Lead created via website form (Staff Form) by ${staffForActivity.name} (Staff ID: ${staffForActivity.id}). Source: ${leadSource}.`
      : `Lead created via website form. Source: ${leadSource}.`;

    const newLead = {
      customer_id: customer.id,
      destination: destination || "N/A",
      travel_date,
      duration: normalizeLeadDuration(duration) || null,
      status: "Enquiry",
      priority: "Low",
      lead_type: "Cold",
      tour_type:
        tour_type || (services.includes("Tour Package") ? "customized" : null),
      tour_region: tour_region || null,
      requirements: leadRequirements,
      services,
      summary:
        summary ||
        `Lead from website form regarding ${
          enquiryTypeForSummary || enquiryType || "an enquiry"
        }.`,
      notes: [],
      activity: [
        {
          id: Date.now(),
          type: "Lead Created",
          description: activityDescription,
          user: staffForActivity ? staffForActivity.name : "System",
          timestamp: new Date().toISOString(),
        },
      ],
      branch_ids: [targetBranchId],
      source: leadSource,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      // Service-specific fields
      starting_point: starting_point || null,
      is_flexible_dates:
        is_flexible_dates === true ||
        is_flexible_dates === "true" ||
        is_flexible_dates === "yes",
      is_return_ticket:
        is_return_ticket === true ||
        is_return_ticket === "true" ||
        is_return_ticket === "yes",
      return_date: return_date || null,
      visa_type: visa_type || null,
      visa_duration: visa_duration || null,
      check_in_date: check_in_date || null,
      check_out_date: check_out_date || null,
      budget: budget
        ? typeof budget === "string"
          ? budget
          : String(budget)
        : null, // Store as text (supports both categories and numeric values)
      forex_currency_have: forex_currency_have || null,
      forex_currency_required: forex_currency_required || null,
      passport_service_type: passport_service_type || null,
      passport_city_of_residence: passport_city_of_residence || null,
      passport_number: passport_number || null,
      passport_expiry_date: passport_expiry_date || null,
      // Transport fields
      vehicle_type: vehicle_type || null,
      pickup_location: pickup_location || null,
      dropoff_location: dropoff_location || null,
      passengers: passengers ? parseInt(passengers, 10) : null,
      // MICE fields
      event_type: event_type || null,
      event_date: event_date || null,
      venue_location: venue_location || null,
      attendees: attendees ? parseInt(attendees, 10) : null,
      mice_requirements: mice_requirements || null,
      // Insurance fields
      insurance_type: insurance_type || null,
      travelers: travelers ? parseInt(travelers, 10) : null,
    };

    // Add additional service-specific data to summary if needed (for fields not in lead table)
    let serviceDetails = [];
    if (services.includes("Passport")) {
      if (formData.urgency) serviceDetails.push(`Urgency: ${formData.urgency}`);
    }
    if (services.includes("Hotel")) {
      if (rooms) serviceDetails.push(`Rooms: ${rooms}`);
      if (hotel_destinations)
        serviceDetails.push(`Destinations: ${hotel_destinations}`);
      if (hotel_nights) serviceDetails.push(`Nights: ${hotel_nights}`);
    }
    if (services.includes("Forex")) {
      if (amount) serviceDetails.push(`Amount: ${amount}`);
    }

    if (serviceDetails.length > 0) {
      newLead.summary += "\n\n" + serviceDetails.join("\n");
    }

    const { data: createdLead, error: leadError } = await supabase
      .from("leads")
      .insert(newLead)
      .select()
      .single();

    if (leadError) throw leadError;

    // 3b. If a staff was selected in the website form, auto-assign that staff to this lead
    let assignedStaff = null;
    if (staff_id && staffForActivity) {
      const staffIdNum = parseInt(staff_id, 10);
      if (!isNaN(staffIdNum)) {
        try {
          const { error: assignError } = await supabase
            .from("lead_assignees")
            .insert({
              lead_id: createdLead.id,
              staff_id: staffIdNum,
            });
          if (assignError) {
            console.warn(
              "[Website Lead] Failed to auto-assign staff from form:",
              assignError.message,
            );
          } else {
            // Use the staff data we already fetched for activity log
            // Fetch full staff details for sending welcome message
            const { data: staffData } = await supabase
              .from("staff")
              .select("*")
              .eq("id", staffIdNum)
              .single();
            if (staffData) {
              assignedStaff = staffData;
            }
          }
        } catch (assignErr) {
          console.warn(
            "[Website Lead] Exception while assigning staff:",
            assignErr.message,
          );
        }
      }
    }

    // 3c. Send welcome/confirmation template if staff is assigned
    // If staff was assigned from form, send immediately. Otherwise, it will be sent when staff is auto-assigned.
    if (assignedStaff) {
      console.log(
        `[Website Lead] Staff already assigned. Sending confirmation template for lead ${createdLead.id}.`,
      );
      try {
        // Use default staff if assigned staff doesn't have phone
        const staffForMessage = assignedStaff.phone
          ? assignedStaff
          : {
              id: 0,
              name: "Madura Travel Service",
              phone: process.env.DEFAULT_STAFF_PHONE || "",
            };

        // DISABLED: MTS summary auto-sending
        // await sendWelcomeWhatsapp(createdLead, customer, staffForMessage);
        // console.log(
        //   `[Website Lead] ✅ Confirmation template sent for lead ${createdLead.id}.`
        // );
        console.log(
          `[Website Lead] MTS summary auto-sending is disabled for lead ${createdLead.id}.`,
        );
      } catch (welcomeError) {
        console.error(
          `[Website Lead] ⚠️ Failed to send confirmation template for lead ${createdLead.id}:`,
          welcomeError.message,
        );
        // Don't fail the request if WhatsApp sending fails
      }
    }

    // Notify connected clients about the new lead
    await supabase.channel("crm-updates").send({
      type: "broadcast",
      event: "new-lead",
      payload: { leadId: createdLead.id },
    });

    res
      .status(201)
      .json({ message: "Lead created successfully.", lead: createdLead });
  } catch (error) {
    console.error("Error creating lead from website:", error);
    res
      .status(500)
      .json({ message: error.message || "An internal server error occurred." });
  }
});

// --- WEBSITE SUPPLIER ENDPOINT ---

app.post(
  "/api/supplier/website",
  supplierCardUpload.single("visiting_card"),
  async (req, res) => {
    try {
      const origin = req.headers.origin || "";
      if (
        origin &&
        !/https?:\/\/([a-z0-9-]+\.)?maduratravel\.com/i.test(origin)
      ) {
        console.warn("[Website Supplier] Blocked POST from origin:", origin);
        return res.status(403).json({ message: "Forbidden" });
      }

      const formData = req.body.form_fields || req.body || {};
      console.log(
        "[Website Supplier] Received data:",
        JSON.stringify(formData, null, 2),
      );

      const company_name =
        formData.company_name ||
        formData.CompanyName ||
        formData["Supplier / Company Name"];
      const category =
        formData.category || formData.Category || formData["Supplier Category"];
      const primary_contact_name =
        formData.primary_contact_name ||
        formData.PrimaryContactName ||
        formData["Primary Contact Name"] ||
        "";
      const primary_contact_email =
        formData.primary_contact_email ||
        formData.email ||
        formData.Email ||
        formData["Primary Contact Email Address"];
      const business_phone =
        formData.business_phone ||
        formData.phone ||
        formData.Phone ||
        formData["Business Phone Number (with Country Code)"];
      const city = formData.city || formData.City || "";
      const country = formData.country || formData.Country || "";
      const website =
        formData.website ||
        formData.Website ||
        formData["Website / Portal Link"] ||
        "";
      const key_destinations_services =
        formData.key_destinations_services ||
        formData.destinations ||
        formData.Destinations ||
        formData["Key Destinations / Services Provided"] ||
        "";
      const b2b_login_credentials =
        formData.b2b_login_credentials ||
        formData["B2B Login Credentials"] ||
        "";
      const contract_tariff_link =
        formData.contract_tariff_link ||
        formData["Contract / Tariff Link"] ||
        "";
      const notes =
        formData.notes || formData.Notes || formData["Notes / Remarks"] || "";

      if (
        !company_name ||
        !category ||
        !primary_contact_email ||
        !business_phone ||
        !city ||
        !country
      ) {
        console.error("[Website Supplier] Validation failed", {
          company_name,
          category,
          primary_contact_email,
          business_phone,
          city,
          country,
        });
        return res.status(400).json({
          message:
            "Missing required fields. Please provide company_name, category, primary_contact_email, business_phone, city, and country.",
        });
      }

      // Derive location as 'City, Country'
      const location =
        city && country ? `${city}, ${country}` : city || country;

      // Default branch 1 (or override via formData.branch_id)
      const branchId = formData.branch_id
        ? parseInt(formData.branch_id, 10) || 1
        : 1;

      // Pick a valid staff ID to satisfy NOT NULL + FK (use as "System" creator)
      let createdByStaffId = null;
      try {
        const { data: anyStaff, error: anyStaffError } = await supabase
          .from("staff")
          .select("id")
          .limit(1);
        if (anyStaffError) {
          console.warn(
            "[Website Supplier] Error fetching staff for created_by_staff_id:",
            anyStaffError,
          );
        }
        if (anyStaff && anyStaff.length > 0) {
          createdByStaffId = anyStaff[0].id;
        }
      } catch (staffErr) {
        console.warn(
          "[Website Supplier] Unexpected error while resolving created_by_staff_id:",
          staffErr,
        );
      }

      if (!createdByStaffId) {
        console.error(
          "[Website Supplier] No staff found to assign created_by_staff_id.",
        );
        return res.status(500).json({
          message:
            "Supplier could not be created because no staff record was found.",
        });
      }

      let visitingCardUrl = null;
      if (req.file) {
        try {
          const fileNameSafe = req.file.originalname.replace(
            /[^a-zA-Z0-9.\-_]/g,
            "_",
          );
          const visitingPath = `public/supplier-visiting-cards/website/${Date.now()}-${fileNameSafe}`;
          const { error: uploadError } = await supabase.storage
            .from("avatars")
            .upload(visitingPath, req.file.buffer, {
              upsert: true,
              cacheControl: "3600",
              contentType: req.file.mimetype,
            });
          if (uploadError) {
            console.error(
              "[Website Supplier] Visiting card upload error:",
              uploadError,
            );
          } else {
            const { data: visitingData } = supabase.storage
              .from("avatars")
              .getPublicUrl(visitingPath);
            visitingCardUrl = `${visitingData.publicUrl}?t=${new Date().getTime()}`;
          }
        } catch (uploadErr) {
          console.error(
            "[Website Supplier] Error uploading visiting card:",
            uploadErr,
          );
        }
      }

      const supplierRow = {
        company_name,
        category,
        contact_person_name: primary_contact_name,
        email: primary_contact_email,
        phone: business_phone,
        location,
        website,
        destinations: key_destinations_services,
        b2b_login_credentials,
        contract_link: contract_tariff_link,
        notes,
        visiting_card_url: visitingCardUrl,
        status: "Active",
        branch_id: branchId,
        created_by_staff_id: createdByStaffId,
        created_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("suppliers").insert(supplierRow);
      if (error) {
        console.error("[Website Supplier] Supabase insert error:", error);
        return res.status(500).json({
          message: "Failed to create supplier.",
          error: error.message,
        });
      }

      console.log(
        "[Website Supplier] Supplier created successfully:",
        company_name,
      );
      return res
        .status(200)
        .json({ message: "Supplier created successfully." });
    } catch (error) {
      const message =
        error?.message ||
        error?.toString() ||
        "Unknown error while creating supplier from website form.";
      console.error("[Website Supplier] Error:", message);
      return res.status(500).json({ message });
    }
  },
);

// Helper list for region detection
const indianPlaces = [
  "India",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
  "Mumbai",
  "Delhi",
  "Bangalore",
  "Hyderabad",
  "Ahmedabad",
  "Chennai",
  "Kolkata",
  "Surat",
  "Pune",
  "Jaipur",
].map((p) => p.toLowerCase());

// --- RAZORPAY INVOICING ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID?.trim();
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim();
const RAZORPAY_API_URL = "https://api.razorpay.com/v1";

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.log(
    "⚠️ WARNING: Razorpay Key ID or Key Secret is not defined. Invoicing will fail.",
  );
} else {
  console.log(`[Razorpay] Using Key ID: ${RAZORPAY_KEY_ID.substring(0, 8)}...`);
  // New: Add a debug log for the secret key's length.
  console.log(
    `[Razorpay] Key Secret is loaded. Length: ${RAZORPAY_KEY_SECRET.length}`,
  );
}

// --- WHATSAPP LEAD ENDPOINT ---
app.post("/api/lead/whatsapp", async (req, res) => {
  try {
    const formData = req.body;
    console.log(
      "Received WhatsApp lead data:",
      JSON.stringify(formData, null, 2),
    );

    const {
      name,
      phone,
      email,
      enquiry, // This is the service type, e.g., "Tour Package"
      services, // This is the new array of services
      date: travel_date,
      travel_date: travel_date_alt, // Alternative field name
      return_date,
      destination,
      duration,
      adults,
      children,
      babies,
      requirements, // The full requirements object
      summary,
      conversation_summary_note, // New field for raw query
      check_in_date,
      check_out_date,
      forex_currency_have,
      forex_currency_required,
      starting_point,
      visa_type,
      budget,
      passport_service_type,
      passport_city_of_residence,
      air_travel_type, // New field for air ticket travel type
    } = formData;

    // Use travel_date_alt if provided, otherwise use date, or check_in_date, or null if not provided
    // Note: If check_in_date is available but travel_date is not, use check_in_date as travel_date
    const finalTravelDate =
      travel_date_alt || travel_date || check_in_date || null;

    // Validate required fields (only phone is mandatory)
    if (!phone) {
      console.error("WhatsApp Validation failed: Missing phone.", {
        name,
        phone,
      });
      return res.status(400).json({
        message: "Missing required field: phone is required.",
      });
    }

    // Get branchId from request body, default to 1 (India) if not provided
    const targetBranchId = formData.branchId || 1;

    console.log(
      `[CRM] 🏢 Processing lead for Branch ID: ${targetBranchId} (${
        targetBranchId === 1 ? "India" : "Australia"
      })`,
    );

    // 1. Find or Create Customer (do this first to get name if customer exists)
    let customer;

    // Normalize phone using the normalizePhone utility function
    // This handles various formats including numbers without + prefix from WhatsApp
    let phoneNormalized = normalizePhone(phone, "IN");

    // Fallback: If normalizePhone fails, try manual normalization
    if (!phoneNormalized && phone) {
      const phoneStr = String(phone)
        .trim()
        .replace(/[\s\-\(\)]/g, "");

      // Handle phone numbers without + prefix (common from WhatsApp)
      // If it starts with 91 (India) and is 12 digits, add +
      if (phoneStr.startsWith("91") && phoneStr.length === 12) {
        phoneNormalized = `+${phoneStr}`;
      }
      // If it's 10 digits (Indian number without country code), add +91
      else if (phoneStr.length === 10 && /^\d+$/.test(phoneStr)) {
        phoneNormalized = `+91${phoneStr}`;
      }
      // If it doesn't start with +, try to add it if it looks like a valid number
      else if (!phoneStr.startsWith("+") && /^\d+$/.test(phoneStr)) {
        // If it's 11-15 digits, assume it has country code and add +
        if (phoneStr.length >= 11 && phoneStr.length <= 15) {
          phoneNormalized = `+${phoneStr}`;
        }
      }
    }

    // Validate phone format (should start with + and have 7-15 digits after country code)
    if (!phoneNormalized || !phoneNormalized.match(/^\+\d{7,15}$/)) {
      console.error(
        "Invalid phone format:",
        phone,
        "normalized:",
        phoneNormalized,
      );
      return res.status(400).json({
        message:
          "Invalid phone number format. Please use format: +919876543210",
      });
    }

    const { data: existingCustomer, error: findError } = await supabase
      .from("customers")
      .select("*")
      .or(
        `phone.eq.${phoneNormalized},phone.eq.${phoneNormalized.replace(
          /^\+/,
          "",
        )}`,
      )
      .limit(1)
      .maybeSingle();

    if (findError) throw findError;

    // Function to extract name and company from conversation text
    const extractNameAndCompanyFromText = (text) => {
      if (!text) return { name: null, company: null };

      let extractedName = null;
      let extractedCompany = null;

      // Pattern 1: "This side [name] from [company]" - handles "This side aijaz Ahmad from Kashmir GAT Holidays"
      const pattern1 =
        /this\s+side\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z\s]+)*)/i;
      const match1 = text.match(pattern1);
      if (match1 && match1[1] && match1[2]) {
        extractedName = match1[1].trim();
        // Extract company name - take everything after "from" until end of sentence or comma
        let companyText = match1[2].trim();
        // Remove trailing punctuation and common endings
        companyText = companyText.replace(/[.,;:!?]+$/, "").trim();
        extractedCompany = companyText;
      }

      // Pattern 2: "[name] from [company]" (general pattern) - handles "Aijaz Ahmad from Kashmir GAT Holidays"
      if (!extractedName) {
        const pattern2 =
          /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z\s]+)*)/i;
        const match2 = text.match(pattern2);
        if (match2 && match2[1] && match2[2]) {
          extractedName = match2[1].trim();
          let companyText = match2[2].trim();
          companyText = companyText.replace(/[.,;:!?]+$/, "").trim();
          extractedCompany = companyText;
        }
      }

      // Pattern 3: "I am [name]", "My name is [name]", "I'm [name]"
      if (!extractedName) {
        const pattern3 =
          /(?:i\s+am|i'm|my\s+name\s+is|name\s+is|myself)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i;
        const match3 = text.match(pattern3);
        if (match3 && match3[1]) {
          extractedName = match3[1].trim();
        }
      }

      // Pattern 4: Just a name at the start (capitalized words)
      if (!extractedName) {
        const pattern4 = /^([A-Z][a-z]+\s+[A-Z][a-z]+)/;
        const match4 = text.match(pattern4);
        if (match4 && match4[1]) {
          extractedName = match4[1].trim();
        }
      }

      // Validate extracted name
      if (extractedName) {
        // Validate it's a reasonable name (2-50 chars, contains letters)
        if (
          extractedName.length < 2 ||
          extractedName.length > 50 ||
          !/^[A-Za-z\s]+$/.test(extractedName)
        ) {
          extractedName = null;
        }
      }

      // Validate extracted company
      if (extractedCompany) {
        // Don't remove "holidays" etc. as they're part of the company name (e.g., "GAT Holidays")
        // Just trim and validate length
        extractedCompany = extractedCompany.trim();
        if (extractedCompany.length < 2 || extractedCompany.length > 100) {
          extractedCompany = null;
        }
      }

      return { name: extractedName, company: extractedCompany };
    };

    // Determine the name to use: prefer provided name, then extract from conversation, then existing customer name
    let customerName = name;
    let extractedCompany = null;

    // If no name provided, try to extract from conversation_summary_note
    if (!customerName && conversation_summary_note) {
      const extracted = extractNameAndCompanyFromText(
        conversation_summary_note,
      );
      if (extracted.name) {
        customerName = extracted.name;
        extractedCompany = extracted.company;
        console.log(
          `[WhatsApp Lead] Extracted name from conversation: "${customerName}"${
            extractedCompany ? `, Company: "${extractedCompany}"` : ""
          }`,
        );
      }
    }

    // Use existing customer's name if available
    if (!customerName && existingCustomer) {
      customerName = `${existingCustomer.first_name || ""} ${
        existingCustomer.last_name || ""
      }`.trim();
      if (customerName) {
        console.log(
          `[WhatsApp Lead] Using existing customer name: "${customerName}"`,
        );
      }
    }

    // If still no name, return error asking for name
    if (!customerName) {
      console.error(
        `[WhatsApp Lead] No name provided, could not extract from conversation, and no existing customer found for phone: ${phone}`,
      );
      return res.status(400).json({
        message: "Name is required. Please provide your name to proceed.",
        error_code: "NAME_REQUIRED",
      });
    }

    if (existingCustomer) {
      customer = existingCustomer;
    } else {
      const nameParts = customerName.split(" ");
      const first_name = nameParts[0] || "WhatsApp";
      const last_name = nameParts.slice(1).join(" ") || "Customer";

      const { data: newCustomer, error: createError } = await supabase
        .from("customers")
        .insert({
          salutation: "Mr.",
          first_name,
          last_name,
          email: email || null,
          phone: phoneNormalized, // Store in continuous format (no spaces): +917397670826
          username: `@${(first_name + last_name)
            .toLowerCase()
            .replace(/\s/g, "")}${Date.now().toString().slice(-4)}`,
          avatar_url: `https://avatar.iran.liara.run/public/boy?username=${Date.now()}`,
          date_added: new Date().toISOString(),
          added_by_branch_id: targetBranchId,
        })
        .select()
        .single();

      if (createError) throw createError;
      customer = newCustomer;
    }

    // Define a system user for notes and activities
    const systemUserAsStaff = {
      id: 0, // Using 0 for system/bot user
      user_id: "system_bot",
      name: "WhatsApp Bot",
      avatar_url: "https://i.imgur.com/T4lG3g9.png", // A simple bot icon
      email: "bot@system.local",
      phone: "",
      role_id: 3, // Staff role
      status: "Active",
      branch_id: targetBranchId,
      leads_attended: 0,
      leads_missed: 0,
      avg_response_time: null,
      last_response_at: null,
      last_active_at: null,
      work_hours_today: 0,
      activity_log: [],
      on_leave_until: null,
      destinations: "",
      services: [],
    };

    // Create notes
    const allNotes = [];

    // Add the AI-extracted conversation note first if it exists
    if (conversation_summary_note) {
      let noteText = `Initial user query via AI flow:\n"${conversation_summary_note}"`;
      if (extractedCompany) {
        noteText += `\n\nCompany: ${extractedCompany}`;
      }
      const conversationNote = {
        id: Date.now(),
        text: noteText,
        date: new Date().toISOString(),
        addedBy: systemUserAsStaff,
        mentions: [],
      };
      allNotes.push(conversationNote);
    }

    // Add the structured summary note
    const summaryText =
      summary || `Lead from WhatsApp bot regarding ${enquiry}.`;
    const summaryNote = {
      id: Date.now() + 1, // ensure unique id
      text: summaryText,
      date: new Date().toISOString(),
      addedBy: systemUserAsStaff,
      mentions: [],
    };
    allNotes.push(summaryNote);

    // Auto-detect tour region
    const destinationLower = (destination || "").toLowerCase();
    const isIndian = indianPlaces.some((place) =>
      destinationLower.includes(place),
    );
    // Normalize requirements - set adults/children to null if not provided (agents will fill)
    const normalizedRequirements = {
      adults: adults !== undefined && adults !== null ? parseInt(adults) : null,
      children:
        children !== undefined && children !== null ? parseInt(children) : null,
      babies: babies !== undefined && babies !== null ? parseInt(babies) : 0,
      hotelPreference: requirements?.hotelPreference || "No Preference",
      stayPreference: requirements?.stayPreference || "No Preference",
      rooms: requirements?.rooms || [], // Empty if not provided - agents will fill
    };

    // 2. Create Lead
    const newLead = {
      customer_id: customer.id,
      destination: destination || "N/A",
      travel_date: finalTravelDate, // Will be null if not provided - agents will fill
      return_date: return_date || null,
      duration: normalizeLeadDuration(duration) || null,
      status: "Enquiry", // Changed from "Confirmed" to "Enquiry"
      priority: "Low",
      lead_type: "Warm",
      tour_type: (services || []).includes("Tour Package")
        ? "customized"
        : null,
      requirements: normalizedRequirements,
      services: services || (enquiry ? [enquiry] : []),
      summary: summaryText,
      notes: allNotes,
      activity: [
        {
          id: Date.now(),
          type: "Lead Created",
          description: "Lead created via WhatsApp Bot.",
          user: "System",
          timestamp: new Date().toISOString(),
        },
      ],
      branch_ids: [targetBranchId],
      source: "whatsapp",
      check_in_date: check_in_date || null,
      check_out_date: check_out_date || null,
      forex_currency_have: forex_currency_have || null,
      forex_currency_required: forex_currency_required || null,
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      starting_point: starting_point || null,
      is_flexible_dates:
        formData.is_flexible_dates === true ||
        formData.is_flexible_dates === "true",
      is_return_ticket:
        formData.is_return_ticket === true ||
        formData.is_return_ticket === "true",
      // Only set air_travel_type for Air Ticket leads
      ...(services && services.includes("Air Ticket") && air_travel_type
        ? { air_travel_type: air_travel_type }
        : {}),
      budget: budget || null, // Store budget as string (Budget Friendly, Comfort Collection, etc.) or null
      visa_type: visa_type || null,
      passport_service_type: passport_service_type || null,
      passport_city_of_residence: passport_city_of_residence || null,
    };

    const { data: createdLead, error: leadError } = await supabase
      .from("leads")
      .insert(newLead)
      .select()
      .single();

    if (leadError) throw leadError;

    // --- START TOUR PACKAGE AUTOMATION ---
    if ((createdLead.services || []).includes("Tour Package")) {
      console.log(
        `[Tour Package Flow] Lead ${createdLead.id} created. Booking flow will start after agent assignment.`,
      );
    }
    // --- END TOUR PACKAGE AUTOMATION ---

    // Notify connected clients about the new lead
    await supabase.channel("crm-updates").send({
      type: "broadcast",
      event: "new-lead",
      payload: { leadId: createdLead.id },
    });

    res.status(201).json({
      message: "Lead created successfully from WhatsApp.",
      lead: createdLead,
    });
  } catch (error) {
    console.error("Error creating lead from WhatsApp:", error);
    res
      .status(500)
      .json({ message: error.message || "An internal server error occurred." });
  }
});

// --- META LEAD ADS WEBHOOK ---
// Meta sends GET for subscription verification and POST when a new lead is created.
// Configure in Meta App: Webhooks → Page → Subscribe to "leadgen".
// Env: META_LEADGEN_VERIFY_TOKEN, META_PAGE_ACCESS_TOKEN (Page token with leads_retrieval).

const META_LEADGEN_VERIFY_TOKEN = process.env.META_LEADGEN_VERIFY_TOKEN || "";
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || "";

app.get("/api/webhooks/meta-leadgen", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_LEADGEN_VERIFY_TOKEN) {
    console.log("[Meta Leadgen] Webhook verification successful.");
    return res.status(200).send(challenge);
  }
  res.status(403).send("Forbidden");
});

app.post("/api/webhooks/meta-leadgen", async (req, res) => {
  console.log(
    "[Meta Leadgen] POST body:",
    JSON.stringify(req.body || {}, null, 2),
  );

  // Respond 200 quickly so Meta doesn't retry; process async
  res.status(200).send("OK");

  if (!META_PAGE_ACCESS_TOKEN) {
    console.warn(
      "[Meta Leadgen] META_PAGE_ACCESS_TOKEN not set; cannot fetch lead details.",
    );
    return;
  }

  try {
    const body = req.body;
    if (body.object !== "page" || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "leadgen" || !change.value?.leadgen_id) continue;
        const leadgenId = change.value.leadgen_id;

        const url = `https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,created_time&access_token=${encodeURIComponent(META_PAGE_ACCESS_TOKEN)}`;
        const leadRes = await fetch(url);
        const leadJson = await leadRes.json();
        if (!leadRes.ok || leadJson.error) {
          console.error(
            "[Meta Leadgen] Graph API error for lead",
            leadgenId,
            leadJson.error || leadRes.status,
          );
          continue;
        }

        const fieldData = leadJson.field_data || [];
        const formData = {};
        for (const f of fieldData) {
          const name = (f.name || "").toLowerCase().replace(/\s+/g, "_");
          const val = Array.isArray(f.values) ? f.values[0] : f.value;
          if (val !== undefined && val !== null) formData[name] = val;
        }
        // Map common Meta field names to our keys
        const fullName =
          formData.full_name ||
          [formData.first_name, formData.last_name].filter(Boolean).join(" ") ||
          formData.name;
        const phone =
          formData.phone_number || formData.phone || formData.mobile_number;
        const email = formData.email || formData.email_address;
        if (!fullName && !phone && !email) {
          console.warn(
            "[Meta Leadgen] Lead",
            leadgenId,
            "has no name, phone, or email; skipping.",
          );
          continue;
        }

        const targetBranchId = parseInt(
          process.env.META_LEADGEN_BRANCH_ID || "1",
          10,
        );

        let customer;
        const phoneNormalized = phone
          ? normalizePhone(phone, "IN") ||
            (String(phone).replace(/\D/g, "").length >= 10
              ? `+91${String(phone).replace(/\D/g, "").slice(-10)}`
              : null)
          : null;

        if (phoneNormalized) {
          const { data: existing } = await supabase
            .from("customers")
            .select("*")
            .or(
              `phone.eq.${phoneNormalized},phone.eq.${phoneNormalized.replace(/^\+/, "")}`,
            )
            .limit(1)
            .maybeSingle();
          if (existing) customer = existing;
        }
        if (!customer && email) {
          const { data: existingByEmail } = await supabase
            .from("customers")
            .select("*")
            .eq("email", email)
            .limit(1)
            .maybeSingle();
          if (existingByEmail) customer = existingByEmail;
        }

        if (!customer) {
          const nameParts = (fullName || "Meta Lead").trim().split(" ");
          const first_name = nameParts[0] || "Meta";
          const last_name = nameParts.slice(1).join(" ") || "Lead";
          const { data: newCustomer, error: createErr } = await supabase
            .from("customers")
            .insert({
              salutation: "Mr.",
              first_name,
              last_name,
              email: email || null,
              phone: phoneNormalized || "",
              username: `@${(first_name + last_name).toLowerCase().replace(/\s/g, "")}${Date.now().toString().slice(-4)}`,
              avatar_url: `https://avatar.iran.liara.run/public/boy?username=${Date.now()}`,
              date_added: new Date().toISOString(),
              added_by_branch_id: targetBranchId,
            })
            .select()
            .single();
          if (createErr) {
            console.error("[Meta Leadgen] Customer create error:", createErr);
            continue;
          }
          customer = newCustomer;
        }

        const destination =
          formData.destination ||
          formData.travel_destination ||
          formData.interested_destination ||
          "N/A";
        const travelDate =
          formData.travel_date ||
          formData.date_of_travel ||
          formData.trip_date ||
          null;
        const summary =
          formData.message ||
          formData.comments ||
          formData.notes ||
          `Lead from Meta ads - FB. Form ID: ${leadgenId}.`;
        const normalizedRequirements = {
          adults: parseInt(formData.adults || formData.travelers, 10) || 1,
          children: parseInt(formData.children, 10) || 0,
          babies: parseInt(formData.babies, 10) || 0,
          hotelPreference: "No Preference",
          stayPreference: "No Preference",
          rooms: [],
        };

        const newLead = {
          customer_id: customer.id,
          destination,
          travel_date: travelDate || "To be confirmed",
          status: "Enquiry",
          priority: "Low",
          lead_type: "Cold",
          requirements: normalizedRequirements,
          services: ["Tour Package"],
          summary,
          notes: [],
          activity: [
            {
              id: Date.now(),
              type: "Lead Created",
              description: "Lead from Meta / Facebook Lead Ads.",
              user: "System",
              timestamp: new Date().toISOString(),
            },
          ],
          branch_ids: [targetBranchId],
          // By default, mark Meta Lead Ads webhook leads as coming from "Meta ads - FB".
          // You can manually change individual leads to "Meta ads - IG" from the CRM if needed.
          source: "Meta ads - FB",
          created_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        };

        const { data: createdLead, error: leadErr } = await supabase
          .from("leads")
          .insert(newLead)
          .select()
          .single();

        if (leadErr) {
          console.error("[Meta Leadgen] Lead create error:", leadErr);
          continue;
        }

        await supabase.channel("crm-updates").send({
          type: "broadcast",
          event: "new-lead",
          payload: { leadId: createdLead.id },
        });
        console.log(
          "[Meta Leadgen] Lead created:",
          createdLead.id,
          "from Meta leadgen_id:",
          leadgenId,
        );
      }
    }
  } catch (err) {
    console.error("[Meta Leadgen] Webhook processing error:", err);
  }
});

app.post("/api/invoicing/create-link", requireAuth, async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) {
      return res.status(400).json({ message: "Invoice ID is required." });
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*, customer:customers(*)")
      .eq("id", invoiceId)
      .single();

    if (invoiceError || !invoice) {
      throw new Error(invoiceError?.message || "Invoice not found.");
    }
    if (!invoice.customer) {
      throw new Error("Customer details not found for this invoice.");
    }

    if (invoice.balance_due <= 0) {
      return res.status(400).json({
        message:
          "Invoice amount must be greater than zero to generate a payment link.",
      });
    }

    const auth = Buffer.from(
      `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`,
    ).toString("base64");
    const response = await fetch(`${RAZORPAY_API_URL}/payment_links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: invoice.balance_due * 100,
        currency: "INR",
        description: `Payment for Invoice #${invoice.invoice_number}`,
        customer: {
          name: `${invoice.customer.first_name} ${invoice.customer.last_name}`,
          email: invoice.customer.email,
          contact: invoice.customer.phone.replace(/[^0-9]/g, "").slice(-10),
        },
        notify: { sms: true, email: true },
        reminder_enable: true,
        callback_url: "https://crm.maduratravel.com/payments",
        callback_method: "get",
      }),
    });

    const razorpayData = await response.json();
    if (!response.ok) {
      console.error("Razorpay Error:", razorpayData);
      throw new Error(
        razorpayData.error?.description || "Failed to create Razorpay link.",
      );
    }

    const { error: updateError } = await supabase
      .from("invoices")
      .update({
        razorpay_payment_link_id: razorpayData.id,
        razorpay_payment_link_url: razorpayData.short_url,
        status: "SENT",
      })
      .eq("id", invoiceId);

    if (updateError) {
      console.error(
        "Failed to update invoice with Razorpay link:",
        updateError,
      );
    }

    res.status(200).json({ paymentLink: razorpayData.short_url });
  } catch (error) {
    console.error("Error creating Razorpay payment link:", error);
    res
      .status(500)
      .json({ message: error.message || "An internal server error occurred." });
  }
});

// --- IMMEDIATE LEAD NOTIFICATION ENDPOINT ---
// Allows CRM UI to trigger WhatsApp notification immediately (no realtime delay)
app.post("/api/lead/notify-immediate", async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    const sendStartTime = Date.now();

    // Fetch lead, customer, and assigned staff in parallel
    const [
      { data: lead, error: leadErr },
      { data: customer, error: custErr },
      { data: assignees },
    ] = await Promise.all([
      supabase.from("leads").select("*").eq("id", leadId).single(),
      supabase.from("customers").select("*").eq("id", null).single(), // Placeholder
      supabase
        .from("lead_assignees")
        .select("staff(*)")
        .eq("lead_id", leadId)
        .limit(1),
    ]);

    if (leadErr || !lead) {
      return res
        .status(404)
        .json({ message: "Lead not found.", error: leadErr?.message });
    }

    // Fetch customer using lead's customer_id
    const { data: customerData, error: custErr2 } = await supabase
      .from("customers")
      .select("*")
      .eq("id", lead.customer_id)
      .single();

    if (custErr2 || !customerData) {
      return res
        .status(404)
        .json({ message: "Customer not found.", error: custErr2?.message });
    }

    const staff = (assignees && assignees[0] && assignees[0].staff) || {
      id: 0,
      name: "Madura Travel Service",
      phone: process.env.DEFAULT_STAFF_PHONE || "",
    };

    // Send WhatsApp immediately
    await sendWelcomeWhatsapp(lead, customerData, staff);
    const sendEndTime = Date.now();

    console.log(
      `[Notify API] WhatsApp sent for lead ${leadId} in ${
        sendEndTime - sendStartTime
      }ms.`,
    );
    res.status(200).json({
      message: "WhatsApp notification sent successfully.",
      leadId,
      timeMs: sendEndTime - sendStartTime,
    });
  } catch (error) {
    console.error("Error in /api/lead/notify-immediate:", error.message);
    res
      .status(500)
      .json({ message: error.message || "Internal server error." });
  }
});

/**
 * Send invoice via WhatsApp as PDF document (no Razorpay or other link).
 * Generates the invoice PDF, uploads to WhatsApp, and sends as document.
 */
async function sendInvoiceWhatsappMessage(
  invoice,
  customer,
  leadDestination = "",
) {
  if (!customer?.phone) {
    console.warn("[Invoice WhatsApp] Customer phone missing; skipping send.");
    return null;
  }

  let sanitizedPhone = normalizePhone(customer.phone, "IN");
  if (!sanitizedPhone && customer.phone) {
    const phoneStr = String(customer.phone)
      .trim()
      .replace(/[\s\-\(\)]/g, "");
    if (phoneStr.startsWith("+91") || phoneStr.startsWith("919")) {
      sanitizedPhone = phoneStr.startsWith("+") ? phoneStr : `+${phoneStr}`;
    } else if (phoneStr.length === 10) {
      sanitizedPhone = `+91${phoneStr}`;
    }
  }

  if (!sanitizedPhone) {
    console.warn(
      "[Invoice WhatsApp] Could not normalize phone number; skipping send.",
    );
    return null;
  }

  try {
    const { buffer, invoiceNumber } = await generateInvoicePdfBuffer(
      invoice.id,
    );
    const fileName = `Invoice_${invoiceNumber}.pdf`;
    const mediaId = await uploadWhatsappMedia(
      buffer,
      "application/pdf",
      fileName,
    );
    if (!mediaId) {
      console.warn("[Invoice WhatsApp] Failed to upload PDF to WhatsApp.");
      return null;
    }
    const firstName = customer.first_name || "Customer";
    const serviceLabel =
      invoice.service_type || invoice.display_name || "booking";
    const serviceLower = String(serviceLabel).toLowerCase();
    const showDestination =
      leadDestination &&
      (serviceLower.includes("tour") ||
        serviceLower.includes("visa") ||
        serviceLower.includes("air") ||
        serviceLower.includes("ticket") ||
        serviceLower.includes("hotel") ||
        serviceLower.includes("mice"));
    let caption = `Greetings, ${firstName}!\n\nPlease find your invoice #${invoiceNumber} attached for your ${serviceLabel}${showDestination ? `.\n\nDestination: ${leadDestination}` : "."}`;
    const docResult = await sendCrmWhatsappDocument(
      sanitizedPhone,
      mediaId,
      fileName,
      caption,
    );
    if (docResult) {
      console.log(
        `[Invoice WhatsApp] ✅ PDF sent for invoice #${invoice.invoice_number}`,
      );
      return { result: docResult, channel: "document" };
    }
  } catch (err) {
    console.warn(
      "[Invoice WhatsApp] Error generating/sending PDF:",
      err.message,
    );
  }
  console.warn(
    `[Invoice WhatsApp] ❌ Failed to send for #${invoice.invoice_number}`,
  );
  return null;
}

app.post("/api/invoicing/send-whatsapp", requireAuth, async (req, res) => {
  try {
    const { invoiceId } = req.body;
    if (!invoiceId) {
      return res.status(400).json({ message: "Invoice ID is required." });
    }

    const { data: invoice, error } = await supabase
      .from("invoices")
      .select("*, customer:customers(*), lead:leads(destination)")
      .eq("id", invoiceId)
      .single();

    if (error || !invoice || !invoice.customer) {
      throw new Error(error?.message || "Invoice or customer not found.");
    }

    const allowedStatusesForSend = [
      "INVOICED",
      "SENT", // user can manually resend
      "PARTIALLY PAID",
      "PAID",
      "OVERDUE",
    ];
    const status = (invoice.status || "").toUpperCase();
    if (!allowedStatusesForSend.includes(status)) {
      const msg =
        status === "DRAFT"
          ? "Can't send - invoice is in DRAFT."
          : status === "VOID"
            ? "Can't send - invoice is VOID."
            : `Invoice cannot be sent (status: ${invoice.status}).`;
      return res.status(400).json({ message: msg });
    }

    const sendResult = await sendInvoiceWhatsappMessage(
      invoice,
      invoice.customer,
      invoice.lead?.destination || "",
    );

    if (sendResult) {
      await supabase
        .from("invoices")
        .update({ status: "SENT" })
        .eq("id", invoiceId);
      if (invoice.lead_id) {
        await logLeadActivity(
          invoice.lead_id,
          "WhatsApp Sent",
          `Invoice #${invoice.invoice_number} sent to customer via WhatsApp (${sendResult.channel}).`,
        );
      }
    } else {
      if (invoice.lead_id)
        await logLeadActivity(
          invoice.lead_id,
          "WhatsApp Failed",
          `Failed to send invoice #${invoice.invoice_number} to customer.`,
        );
      throw new Error("Failed to send WhatsApp message via provider.");
    }

    res.status(200).json({ message: "WhatsApp message sent successfully." });
  } catch (error) {
    console.error("Error sending WhatsApp invoice:", error);
    res
      .status(500)
      .json({ message: error.message || "An internal server error occurred." });
  }
});

// Send lead summary via WhatsApp (uses mts_summary template)
// Send WhatsApp text message endpoint
app.post("/api/whatsapp/send-text", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      return res.status(400).json({ message: "to and text are required." });
    }

    // Normalize phone number
    let sanitizedPhone = normalizePhone(to, "IN");
    if (!sanitizedPhone) {
      const phoneStr = String(to)
        .trim()
        .replace(/[\s\-\(\)]/g, "");
      if (phoneStr.startsWith("+91") || phoneStr.startsWith("91")) {
        sanitizedPhone = phoneStr.startsWith("+") ? phoneStr : `+${phoneStr}`;
      } else if (phoneStr.length === 10) {
        sanitizedPhone = `+91${phoneStr}`;
      } else if (phoneStr.startsWith("+")) {
        sanitizedPhone = phoneStr;
      }
    }
    if (!sanitizedPhone) {
      return res.status(400).json({ message: "Invalid phone number format." });
    }

    const result = await sendCrmWhatsappText(sanitizedPhone, text);
    if (!result) {
      return res
        .status(500)
        .json({ message: "Failed to send WhatsApp message." });
    }

    res.json({ success: true, messageId: result.messages?.[0]?.id });
  } catch (err) {
    console.error("[CRM] Error in /api/whatsapp/send-text:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to send WhatsApp message." });
  }
});

app.post("/api/whatsapp/send-summary", async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    // Fetch lead with customer and assigned staff
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select(
        "*, customer:customers(*), all_assignees:lead_assignees(staff(*))",
      )
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      throw new Error(leadError?.message || "Lead not found.");
    }
    if (!lead.customer || !lead.customer.phone) {
      throw new Error("Customer phone not available for this lead.");
    }

    // Get primary assigned staff (first assignee)
    const primaryStaff =
      lead.all_assignees && lead.all_assignees.length > 0
        ? lead.all_assignees[0].staff
        : {
            id: 0,
            name: "Madura Travel Service",
            phone: process.env.DEFAULT_STAFF_PHONE || "",
          };

    // Normalize phone number
    let sanitizedPhone = normalizePhone(lead.customer.phone, "IN");
    if (!sanitizedPhone) {
      const phoneStr = String(lead.customer.phone)
        .trim()
        .replace(/[\s\-\(\)]/g, "");
      if (phoneStr.startsWith("+91") || phoneStr.startsWith("91")) {
        sanitizedPhone = phoneStr.startsWith("+") ? phoneStr : `+${phoneStr}`;
      } else if (phoneStr.length === 10) {
        sanitizedPhone = `+91${phoneStr}`;
      }
    }
    if (!sanitizedPhone) {
      throw new Error("Could not normalize customer phone.");
    }

    // Use the same summary generation function as sendWelcomeWhatsapp
    // Validate that all required fields are filled before sending MTS summary
    const validation = validateMtsSummaryRequiredFields(lead);
    if (!validation.isValid) {
      // Only show truly required fields (Services, Destination, Duration)
      const requiredMissingFields = Object.entries(validation.missingFields)
        .filter(
          ([field, missing]) =>
            missing && ["services", "destination", "duration"].includes(field),
        )
        .map(([field]) => field)
        .join(", ");
      console.log(
        `[Send Summary] ⚠️ Cannot send MTS summary for lead ${lead.id}: Missing required fields: ${requiredMissingFields}`,
      );
      return res.status(400).json({
        message: `Cannot send summary. Missing required fields: ${requiredMissingFields}. Please fill: Services, Destination, and Duration. (Date of Travel and Passenger Details are optional and can be filled by agents later.)`,
        missingFields: validation.missingFields,
      });
    }

    const { bookingId, summaryText, customerName, staffName } =
      generateLeadSummary(lead, lead.customer, primaryStaff);

    // Clean summary text for template: Remove newlines, tabs, and multiple consecutive spaces
    // Meta Business Manager templates don't allow newlines/tabs in text parameters
    const cleanSummaryText = (summaryText || "")
      .replace(/\n/g, " ") // Replace newlines with spaces
      .replace(/\t/g, " ") // Replace tabs with spaces
      .replace(/[ ]{5,}/g, " ") // Replace 5+ consecutive spaces with single space
      .replace(/[ ]{2,}/g, " ") // Replace 2+ consecutive spaces with single space
      .trim();

    // Prepare template components for mts_summary template
    // The template must have buttons defined in Meta Business Manager: "Confirm Enquiry" and "Talk to Agent"
    const templateComponents = [
      {
        type: "body",
        parameters: [
          { type: "text", text: customerName || "" }, // {{1}} - Customer name
          { type: "text", text: bookingId || "" }, // {{2}} - Booking ID
          { type: "text", text: staffName || "" }, // {{3}} - Staff name
          { type: "text", text: cleanSummaryText }, // {{4}} - Summary (cleaned)
        ],
      },
    ];

    // Send mts_summary template ONLY (includes welcome message + confirmation buttons)
    // This is the single welcome/confirmation message - no separate messages needed
    console.log(
      `[Send Summary] 📤 Sending mts_summary template (welcome + confirmation) to ${sanitizedPhone} for lead ${lead.id}.`,
    );

    const result = await sendCrmWhatsappTemplate(
      sanitizedPhone,
      "mts_summary",
      "en",
      templateComponents,
    );

    if (result) {
      const messageId = result.messages?.[0]?.id;
      if (messageId) {
        // Store message ID -> lead ID mapping for button click handling
        messageIdToLeadCache.set(messageId, {
          leadId: lead.id,
          customerId: lead.customer.id,
          customerName: `${lead.customer.first_name} ${lead.customer.last_name}`,
          timestamp: Date.now(),
        });
        console.log(
          `[Send Summary] ✅ Template sent successfully. Message ID: ${messageId}, Lead ID: ${lead.id}`,
        );
      } else {
        console.log(
          `[Send Summary] ✅ Template sent successfully (no message ID in response) for lead ${lead.id}.`,
        );
      }
    } else {
      console.error(
        `[Send Summary] ❌ Failed to send mts_summary template for lead ${lead.id} to ${sanitizedPhone}. Template may not be approved in Meta Business Manager.`,
      );
    }

    if (lead.id) {
      await logLeadActivity(
        lead.id,
        "Summary Sent",
        `Summary sent to customer "${lead.customer.first_name} ${lead.customer.last_name}" via WhatsApp.`,
      );
    }

    return res
      .status(200)
      .json({ message: "Summary sent via WhatsApp.", result });
  } catch (error) {
    console.error("[Send Summary] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to send summary." });
  }
});

// Send itinerary via WhatsApp template
app.post("/api/whatsapp/send-itinerary", async (req, res) => {
  try {
    const { leadId, itineraryId } = req.body;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }
    if (!itineraryId) {
      return res.status(400).json({ message: "itineraryId is required." });
    }

    // Fetch lead with customer
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("*, customer:customers(*)")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      throw new Error(leadError?.message || "Lead not found.");
    }
    if (!lead.customer || !lead.customer.phone) {
      throw new Error("Customer phone not available for this lead.");
    }

    // Fetch itinerary with latest version
    const { data: itineraryMeta, error: itineraryError } = await supabase
      .from("itineraries")
      .select(
        `
        *,
        itinerary_versions(*)
      `,
      )
      .eq("id", itineraryId)
      .single();

    if (itineraryError || !itineraryMeta) {
      throw new Error(itineraryError?.message || "Itinerary not found.");
    }

    // Get latest version
    let latestVersion = null;
    if (
      Array.isArray(itineraryMeta.itinerary_versions) &&
      itineraryMeta.itinerary_versions.length > 0
    ) {
      latestVersion = itineraryMeta.itinerary_versions.sort(
        (a, b) => (b.version_number || 0) - (a.version_number || 0),
      )[0];
    }

    if (!latestVersion) {
      throw new Error("No itinerary version found.");
    }

    // Normalize phone number
    let sanitizedPhone = normalizePhone(lead.customer.phone, "IN");
    if (!sanitizedPhone) {
      const phoneStr = String(lead.customer.phone)
        .trim()
        .replace(/[\s\-\(\)]/g, "");
      if (phoneStr.startsWith("+91") || phoneStr.startsWith("91")) {
        sanitizedPhone = phoneStr.startsWith("+") ? phoneStr : `+${phoneStr}`;
      } else if (phoneStr.length === 10) {
        sanitizedPhone = `+91${phoneStr}`;
      }
    }
    if (!sanitizedPhone) {
      throw new Error("Could not normalize customer phone.");
    }

    // Always generate PDF on-the-fly when sending (PDFs are cleaned up daily)
    // This ensures we always send the latest version
    console.log(
      `[Send Itinerary] Generating PDF on-the-fly for itinerary ${itineraryId}...`,
    );

    // Call the PDF generation endpoint internally to get the PDF buffer
    const pdfResponse = await fetch(
      `${
        process.env.SERVER_URL || "http://localhost:3001"
      }/api/itinerary/generate-pdf`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Call": "true", // Mark as internal call to use primary assignee
        },
        body: JSON.stringify({
          itineraryId: itineraryId,
          leadId: leadId,
        }),
      },
    );

    if (!pdfResponse.ok) {
      const pdfError = await pdfResponse
        .json()
        .catch(() => ({ message: pdfResponse.statusText }));
      throw new Error(pdfError.message || "Failed to generate itinerary PDF.");
    }

    // Get PDF buffer directly from response (it's sent as application/pdf)
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Generated PDF is empty");
    }

    console.log(
      `[Send Itinerary] ✅ PDF generated successfully (${pdfBuffer.length} bytes)`,
    );

    // Prepare template components
    // Template name: mts_itinerary (user will create this in Meta Business Manager)
    const customerName =
      `${lead.customer.first_name || ""} ${
        lead.customer.last_name || ""
      }`.trim() || "Customer";
    const destination = itineraryMeta.destination || "your destination";
    const duration = formatDurationToDays(itineraryMeta.duration);

    const templateComponents = [
      {
        type: "body",
        parameters: [
          { type: "text", text: customerName }, // {{1}} - Customer name
          { type: "text", text: destination }, // {{2}} - Destination
          { type: "text", text: duration }, // {{3}} - Duration (e.g. "5 Days")
        ],
      },
    ];

    // For template messages, WhatsApp requires the document to be publicly accessible via URL
    // We need to get the PDF URL from the generation response or upload it and get the URL
    // Since PDF is generated on-the-fly, we need to upload it to get a public URL
    let pdfUrl = null;
    try {
      // Generate MTS ID from lead (format: MTS-{lead.id}{day}{month}{year} from created_at)
      let mtsId = "MTS-NA";
      if (lead.id && lead.created_at) {
        const createdAt = new Date(lead.created_at);
        const day = String(createdAt.getDate()).padStart(2, "0");
        const month = String(createdAt.getMonth() + 1).padStart(2, "0");
        const year = String(createdAt.getFullYear()).slice(-2);
        mtsId = `MTS-${lead.id}${day}${month}${year}`;
      }

      // Generate filename: {mts_id}_{customer_first_name}_V{version}_{duration}_{adults}A{children}C.pdf
      const customerFirstName = (
        lead.customer.first_name || "Customer"
      ).replace(/\s+/g, "_");
      const versionNumber = latestVersion.version_number || 1;
      const adults = itineraryMeta.adults || 0;
      const children = itineraryMeta.children || 0;
      const durationFormatted = duration.replace(/\s+/g, "_");

      const fileName = `${mtsId}_${customerFirstName}_V${versionNumber}_${durationFormatted}_${adults}A${children}C.pdf`;

      const filePath = `public/itinerary-pdfs/${
        lead.customer.id
      }/${Date.now()}-${fileName}`;

      console.log(
        `[Send Itinerary] 📤 Uploading PDF to storage for public URL...`,
      );

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(
          `Failed to upload PDF to storage: ${uploadError.message}`,
        );
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);
      pdfUrl = urlData.publicUrl;

      console.log(`[Send Itinerary] ✅ PDF uploaded. Public URL: ${pdfUrl}`);

      // Add PDF as document parameter using public URL
      // For template messages with document in header, use URL (not media ID)
      if (pdfUrl) {
        templateComponents.push({
          type: "header",
          parameters: [
            {
              type: "document",
              document: {
                link: pdfUrl, // Use public URL for template messages
                filename: fileName,
              },
            },
          ],
        });
      }
    } catch (uploadError) {
      console.error(
        `[Send Itinerary] ❌ Error uploading PDF: ${uploadError.message}`,
      );
      throw new Error(`Failed to upload PDF: ${uploadError.message}`);
    }

    // Send mts_itinerary template
    console.log(
      `[Send Itinerary] 📤 Sending mts_itinerary template to ${sanitizedPhone} for lead ${leadId}, itinerary ${itineraryId}.`,
    );

    const result = await sendCrmWhatsappTemplate(
      sanitizedPhone,
      "mts_itinerary", // Template name - user will create this
      "en",
      templateComponents,
    );

    if (result) {
      const messageId = result.messages?.[0]?.id;
      if (messageId) {
        console.log(
          `[Send Itinerary] ✅ Template sent successfully. Message ID: ${messageId}, Lead ID: ${leadId}, Itinerary ID: ${itineraryId}`,
        );
      } else {
        console.log(
          `[Send Itinerary] ✅ Template sent successfully (no message ID in response) for lead ${leadId}, itinerary ${itineraryId}.`,
        );
      }

      // Update itinerary status to "sent"
      const { error: updateError } = await supabase
        .from("itineraries")
        .update({ status: "Sent" })
        .eq("id", itineraryId);

      if (updateError) {
        console.error(
          `[Send Itinerary] ⚠️ Failed to update itinerary status: ${updateError.message}`,
        );
      } else {
        console.log(
          `[Send Itinerary] ✅ Updated itinerary ${itineraryId} status to "Sent"`,
        );
      }

      // Log activity
      await logLeadActivity(
        leadId,
        "Itinerary Sent",
        `Itinerary sent to customer "${customerName}" via WhatsApp. Itinerary ID: ${itineraryId}, Destination: ${destination}, Duration: ${duration}.`,
      );
    } else {
      console.error(
        `[Send Itinerary] ❌ Failed to send mts_itinerary template for lead ${leadId} to ${sanitizedPhone}. Template may not be approved in Meta Business Manager.`,
      );
      await logLeadActivity(
        leadId,
        "WhatsApp Failed",
        `Failed to send itinerary template (mts_itinerary) to customer "${customerName}" at ${sanitizedPhone}. Template may not be approved in Meta Business Manager.`,
      );
    }

    return res
      .status(200)
      .json({ message: "Itinerary sent via WhatsApp.", result });
  } catch (error) {
    console.error("[Send Itinerary] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to send itinerary." });
  }
});

// ====================================================================
// USER SESSION TRACKING ENDPOINTS
// ====================================================================

// Record user login (called when user authenticates)
app.post("/api/sessions/login", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;
    const staffId = req.user.id; // staff.id from requireAuth
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    // Get or create today's session
    const { data: existingSession } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    const now = new Date().toISOString();

    if (existingSession) {
      // Update existing session - new login for the day
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({
          first_login_time: existingSession.first_login_time || now, // Keep first login
          last_activity_time: now,
          last_logout_time: null, // Reset logout time
          session_status: "active",
          updated_at: now,
        })
        .eq("id", existingSession.id);

      if (updateError) {
        throw new Error(`Failed to update session: ${updateError.message}`);
      }
    } else {
      // Create new session for today
      const { error: insertError } = await supabase
        .from("user_sessions")
        .insert({
          user_id: userId,
          staff_id: staffId,
          date: today,
          first_login_time: now,
          last_activity_time: now,
          session_status: "active",
          total_active_seconds: 0,
        });

      if (insertError) {
        throw new Error(`Failed to create session: ${insertError.message}`);
      }
    }

    return res.status(200).json({ message: "Login recorded successfully" });
  } catch (error) {
    console.error("[Session Login] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to record login" });
  }
});

// Heartbeat - Update activity time and accumulate active seconds
// B2: Heartbeat with one retry on connection pool timeout
app.post("/api/sessions/heartbeat", requireAuth, async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const staffId = req.user.id;
  const { activeSeconds = 0, isPageVisible = true } = req.body;
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();
  let sessionStatus = isPageVisible ? "active" : "idle";

  const isPoolTimeout = (err) =>
    err?.code === "PGRST003" ||
    /connection pool|Timed out acquiring/.test(err?.message || "");

  const runHeartbeat = async () => {
    const { data: existingSession } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    if (existingSession) {
      const newTotalSeconds =
        (existingSession.total_active_seconds || 0) +
        Math.max(0, Math.floor(activeSeconds));
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({
          last_activity_time: now,
          total_active_seconds: newTotalSeconds,
          session_status: sessionStatus,
          updated_at: now,
        })
        .eq("id", existingSession.id);
      if (updateError) throw updateError;
    } else {
      const { error: insertError } = await supabase
        .from("user_sessions")
        .insert({
          user_id: userId,
          staff_id: staffId,
          date: today,
          first_login_time: now,
          last_activity_time: now,
          session_status: sessionStatus,
          total_active_seconds: Math.max(0, Math.floor(activeSeconds)),
        });
      if (insertError) throw insertError;
    }
  };

  try {
    await runHeartbeat();
    return res.status(200).json({ message: "Heartbeat recorded" });
  } catch (error) {
    if (isPoolTimeout(error)) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await runHeartbeat();
        return res.status(200).json({ message: "Heartbeat recorded" });
      } catch (retryErr) {
        console.error(
          "[Session Heartbeat] Error (after retry):",
          retryErr.message,
        );
        return res
          .status(500)
          .json({ message: retryErr.message || "Failed to record heartbeat" });
      }
    }
    console.error("[Session Heartbeat] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to record heartbeat" });
  }
});

// Record user logout
app.post("/api/sessions/logout", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();

    // Update session with logout time
    const { data: existingSession } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .single();

    if (existingSession) {
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({
          last_logout_time: now,
          session_status: "logged_out",
          updated_at: now,
        })
        .eq("id", existingSession.id);

      if (updateError) {
        throw new Error(`Failed to update session: ${updateError.message}`);
      }
    }

    return res.status(200).json({ message: "Logout recorded successfully" });
  } catch (error) {
    console.error("[Session Logout] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to record logout" });
  }
});

// Get session report data
app.get("/api/sessions/report", requireAuth, async (req, res) => {
  try {
    const { staffId, startDate, endDate, period = "daily" } = req.query;

    // Check if user is admin/manager (can view all) or staff (can only view own)
    const isAdmin =
      req.user.role === "Super Admin" || req.user.role === "Manager";
    const requestingStaffId = req.user.id; // staff.id from requireAuth

    let query = supabase
      .from("user_sessions")
      .select(
        `
        *,
        staff:staff_id (
          id,
          name,
          email,
          branch_id
        )
      `,
      )
      .order("date", { ascending: false });

    // Apply filters
    if (startDate) {
      query = query.gte("date", startDate);
    }
    if (endDate) {
      query = query.lte("date", endDate);
    }

    // If not admin, only show own data
    if (!isAdmin) {
      query = query.eq("staff_id", requestingStaffId);
    } else if (staffId) {
      // Admin can filter by specific staff
      query = query.eq("staff_id", parseInt(staffId));
    }

    const { data: sessions, error: queryError } = await query;

    if (queryError) {
      throw new Error(`Failed to fetch sessions: ${queryError.message}`);
    }

    // Group by period if needed
    let groupedData = sessions || [];
    if (period === "weekly") {
      // Group by week
      const weekMap = new Map();
      sessions.forEach((session) => {
        const date = new Date(session.date);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay()); // Start of week (Sunday)
        const weekKey = weekStart.toISOString().split("T")[0];

        if (!weekMap.has(weekKey)) {
          weekMap.set(weekKey, {
            period: weekKey,
            first_login_time: session.first_login_time,
            last_logout_time: session.last_logout_time,
            total_active_seconds: 0,
            sessions: [],
          });
        }

        const weekData = weekMap.get(weekKey);
        weekData.total_active_seconds += session.total_active_seconds || 0;
        weekData.sessions.push(session);

        // Update first login (earliest) and last logout (latest)
        if (
          !weekData.first_login_time ||
          (session.first_login_time &&
            new Date(session.first_login_time) <
              new Date(weekData.first_login_time))
        ) {
          weekData.first_login_time = session.first_login_time;
        }
        if (
          !weekData.last_logout_time ||
          (session.last_logout_time &&
            new Date(session.last_logout_time) >
              new Date(weekData.last_logout_time))
        ) {
          weekData.last_logout_time = session.last_logout_time;
        }
      });
      groupedData = Array.from(weekMap.values());
    } else if (period === "monthly") {
      // Group by month
      const monthMap = new Map();
      sessions.forEach((session) => {
        const date = new Date(session.date);
        const monthKey = `${date.getFullYear()}-${String(
          date.getMonth() + 1,
        ).padStart(2, "0")}`;

        if (!monthMap.has(monthKey)) {
          monthMap.set(monthKey, {
            period: monthKey,
            first_login_time: session.first_login_time,
            last_logout_time: session.last_logout_time,
            total_active_seconds: 0,
            sessions: [],
          });
        }

        const monthData = monthMap.get(monthKey);
        monthData.total_active_seconds += session.total_active_seconds || 0;
        monthData.sessions.push(session);

        // Update first login (earliest) and last logout (latest)
        if (
          !monthData.first_login_time ||
          (session.first_login_time &&
            new Date(session.first_login_time) <
              new Date(monthData.first_login_time))
        ) {
          monthData.first_login_time = session.first_login_time;
        }
        if (
          !monthData.last_logout_time ||
          (session.last_logout_time &&
            new Date(session.last_logout_time) >
              new Date(monthData.last_logout_time))
        ) {
          monthData.last_logout_time = session.last_logout_time;
        }
      });
      groupedData = Array.from(monthMap.values());
    }

    return res.status(200).json({ data: groupedData, period });
  } catch (error) {
    console.error("[Session Report] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to fetch session report" });
  }
});

// Send feedback template to customer when lead status is Feedback
app.post("/api/feedback/send", async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) {
      return res.status(400).json({ message: "leadId is required." });
    }

    // Fetch lead with customer
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("*, customer:customers(*)")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      throw new Error(leadError?.message || "Lead not found.");
    }

    if (!lead.customer) {
      throw new Error("Customer not found for this lead.");
    }

    // Check if feedback was already sent
    if (lead.notified_status === "Feedback") {
      console.log(
        `[Feedback Endpoint] Feedback already sent for lead ${leadId}. Skipping.`,
      );
      return res.status(200).json({
        message: "Feedback already sent for this lead.",
        alreadySent: true,
      });
    }

    // Send feedback template
    await sendFeedbackLinkMessage(lead, lead.customer);

    // Mark as notified to prevent duplicate processing
    await supabase
      .from("leads")
      .update({ notified_status: "Feedback" })
      .eq("id", leadId);

    console.log(
      `[Feedback Endpoint] ✅ Feedback template sent successfully for lead ${leadId}`,
    );

    return res.status(200).json({
      message: "Feedback template sent successfully.",
      leadId: leadId,
    });
  } catch (error) {
    console.error("[Feedback Endpoint] Error:", error.message);
    return res
      .status(500)
      .json({ message: error.message || "Failed to send feedback." });
  }
});

app.post("/api/razorpay-webhook", async (req, res) => {
  // TODO: Add webhook signature verification in production
  console.log("[Webhook] Razorpay webhook received:", req.body);

  const event = req.body.event;
  const payload = req.body.payload;

  if (event === "payment_link.paid") {
    const paymentLinkId = payload.payment_link.entity.id;
    const amountPaid = payload.payment.entity.amount / 100; // Amount is in paise

    try {
      // 1. Find the invoice associated with the payment link
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .select("*, lead:leads(*), customer:customers(*)")
        .eq("razorpay_payment_link_id", paymentLinkId)
        .single();

      if (invoiceError || !invoice) {
        console.error(
          `[Webhook] Invoice not found for payment_link_id ${paymentLinkId}. Error: ${invoiceError?.message}`,
        );
        return res.status(404).json({ message: "Invoice not found." });
      }

      // 2. Record payment in payments table first
      const paymentEntity = payload.payment?.entity;
      const paymentId = paymentEntity?.id || paymentLinkId;
      const paymentDate = paymentEntity?.created_at
        ? new Date(paymentEntity.created_at * 1000).toISOString()
        : new Date().toISOString();

      const { error: paymentInsertError } = await supabase
        .from("payments")
        .insert({
          invoice_id: invoice.id,
          lead_id: invoice.lead_id,
          customer_id: invoice.customer_id,
          payment_date: paymentDate,
          amount: amountPaid,
          method: "Razorpay",
          reference_id: paymentId,
          razorpay_payment_id: paymentId,
          status: "Paid",
          notes: `Razorpay payment_link ${paymentLinkId}`,
          source: "RazorpayWebhook",
          created_at: new Date().toISOString(),
        });
      if (paymentInsertError) {
        throw new Error(
          `Failed to insert payment record: ${paymentInsertError.message}`,
        );
      }

      // 3. Recalculate invoice balance using helper function
      const { recalculateInvoiceBalance } =
        await import("./utils/invoiceBalance.js");
      await recalculateInvoiceBalance(supabase, invoice.id);
      console.log(
        `[Webhook] Invoice ${invoice.id} balance recalculated after payment.`,
      );

      // 4. Update Lead Status
      if (invoice.lead) {
        const activityDescription = `Payment of ₹${amountPaid.toLocaleString()} received via Razorpay for Invoice #${
          invoice.invoice_number
        }.`;
        const newActivity = {
          id: Date.now(),
          type: "Payment Received",
          description: activityDescription,
          user: "System",
          timestamp: new Date().toISOString(),
        };
        const updatedActivity = [newActivity, ...(invoice.lead.activity || [])];

        const { error: updateLeadError } = await supabase
          .from("leads")
          .update({
            status: "Billing Completed",
            lead_type: "Booked",
            activity: updatedActivity,
            last_updated: new Date().toISOString(),
          })
          .eq("id", invoice.lead.id);

        if (updateLeadError)
          throw new Error(`Failed to update lead: ${updateLeadError.message}`);
        console.log(
          `[Webhook] Lead ${invoice.lead.id} status updated to "Billing Completed" and type to "Booked".`,
        );

        // 5. Send confirmation to customer via WhatsApp
        if (invoice.customer && invoice.customer.phone) {
          let sanitizedPhone = invoice.customer.phone.replace(/[^0-9]/g, "");
          if (sanitizedPhone.length === 10)
            sanitizedPhone = "91" + sanitizedPhone;

          const confirmationMessage = `🎉 Your payment of ₹${amountPaid.toLocaleString()} for the trip to *${
            invoice.lead.destination
          }* has been received!\n\nYour booking is now confirmed. Our team will get in touch with you shortly with the next steps. Thank you for choosing Madura Travel Service!`;
          await sendCrmWhatsappText(sanitizedPhone, confirmationMessage);
        }
      }
    } catch (error) {
      console.error(
        `[Webhook] Error processing payment_link.paid event:`,
        error.message,
      );
      return res
        .status(500)
        .json({ message: "Internal server error during webhook processing." });
    }
  }

  res.status(200).json({ status: "ok" });
});

// --- EMAIL SUPPLIER REQUIREMENTS ---

const sendSupplierRequestEmails = async (
  lead,
  staff,
  suppliers,
  branchEmail,
  triggeredBy = "System (Automatic)",
) => {
  if (!suppliers || suppliers.length === 0) {
    console.log(`No suppliers to email for lead ${lead.id}.`);
    return;
  }

  console.log(
    `Preparing to send ${suppliers.length} requirement emails for lead ${lead.id}...`,
  );

  const emailPromises = suppliers.map((supplier) => {
    const subject = `Madura Travel Service Requirement – ${
      lead.starting_point || "N/A"
    } to ${lead.destination} (${new Date(
      lead.travel_date,
    ).toLocaleDateString()})`;

    const requirements = lead.requirements || {};
    const totalAdults = (requirements.rooms || []).reduce(
      (sum, room) => sum + room.adults,
      0,
    );
    const totalChildren = (requirements.rooms || []).reduce(
      (sum, room) => sum + room.children,
      0,
    );

    const roomConfigs = (requirements.rooms || [])
      .map(
        (room, index) =>
          `<li>Room ${index + 1}: ${room.adults} Adults, ${
            room.children
          } Children</li>`,
      )
      .join("");

    const body = `
            <p>Dear ${
              supplier.contact_person_name || supplier.company_name
            },</p>
            <p>Greetings from Madura Travel Service.</p>
            <p>We are reaching out to request your quotation and best available options for the following travel requirement:</p>
            
            <h3>Travel Details:</h3>
            <ul>
                <li><strong>Starting Point:</strong> ${
                  lead.starting_point || "N/A"
                }</li>
                <li><strong>Destination:</strong> ${lead.destination}</li>
                <li><strong>Date of Travel:</strong> ${new Date(
                  lead.travel_date,
                ).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}</li>
                <li><strong>Duration:</strong> ${lead.duration || "N/A"}</li>
                <li><strong>Type of Tour:</strong> ${
                  lead.tour_type
                    ? lead.tour_type.charAt(0).toUpperCase() +
                      lead.tour_type.slice(1)
                    : "N/A"
                }</li>
            </ul>

            <h3>Customer Requirements:</h3>
            <ul>
                <li><strong>Passengers:</strong> ${totalAdults} Adults, ${totalChildren} Children</li>
                <li><strong>Room Configuration:</strong><ul>${roomConfigs}</ul></li>
                <li><strong>Hotel Preference:</strong> ${
                  requirements.hotelPreference || "N/A"
                }</li>
                <li><strong>Stay Preference:</strong> ${
                  requirements.stayPreference || "N/A"
                }</li>
            </ul>

            <p>Kindly share with us your proposed itinerary, inclusions/exclusions, price details, and any available upgrade or customization options if available.</p>
            <p>Please let us know if you require any additional details to prepare the proposal.</p>
            <p>Looking forward to your prompt response.</p>
            <br>
            <p>Warm regards,</p>
            <p><strong>${staff.name}</strong><br>
            Madura Travel Service<br>
            ${staff.phone}<br>
            ${staff.email}</p>
        `;

    const mailOptions = {
      from: `"Madura Travel Service" <${process.env.SMTP_USER}>`,
      to: supplier.email,
      cc: [branchEmail, staff.email],
      subject: subject,
      html: body,
    };

    console.log(
      `Sending email to ${supplier.company_name} (${supplier.email}) for lead ${lead.id}.`,
    );
    return transporter.sendMail(mailOptions);
  });

  try {
    await Promise.all(emailPromises);
    console.log(
      `All ${suppliers.length} emails sent successfully for lead ${lead.id}.`,
    );

    // Create activity log entry
    const emailActivity = {
      id: Date.now(),
      type: "Supplier Email Sent",
      description: `Sent requirement emails to ${
        suppliers.length
      } supplier(s): ${suppliers.map((s) => s.company_name).join(", ")}.`,
      user: triggeredBy,
      timestamp: new Date().toISOString(),
    };

    // Fetch current lead to get its activity array
    const { data: currentLead, error: fetchError } = await supabase
      .from("leads")
      .select("activity")
      .eq("id", lead.id)
      .single();

    if (fetchError) {
      console.error(
        `Could not fetch lead ${lead.id} to update activity log for email sending:`,
        fetchError.message,
      );
    }

    const updatedActivity = currentLead
      ? [emailActivity, ...(currentLead.activity || [])]
      : [emailActivity];

    // Update the lead with the timestamp AND the new activity log
    const { error: updateError } = await supabase
      .from("leads")
      .update({
        supplier_email_sent_at: new Date().toISOString(),
        activity: updatedActivity,
        last_updated: new Date().toISOString(),
      })
      .eq("id", lead.id);

    if (updateError) {
      console.error(
        `Failed to update email sent status/activity for lead ${lead.id}:`,
        updateError,
      );
    } else {
      console.log(
        `Updated email sent status and activity for lead ${lead.id}.`,
      );
    }
  } catch (error) {
    console.error(
      `Error sending one or more supplier emails for lead ${lead.id}:`,
      error,
    );
    throw error;
  }
};

app.post("/api/email/send-supplier-request", async (req, res) => {
  const { lead, staff, suppliers, branchEmail } = req.body;

  if (
    !lead ||
    !staff ||
    !suppliers ||
    !Array.isArray(suppliers) ||
    !branchEmail
  ) {
    return res.status(400).json({
      message:
        "Missing required data: lead, staff, suppliers, and branchEmail.",
    });
  }

  try {
    await sendSupplierRequestEmails(
      lead,
      staff,
      suppliers,
      branchEmail,
      staff.name,
    );
    res
      .status(200)
      .json({ message: `Successfully sent ${suppliers.length} emails.` });
  } catch (error) {
    console.error("Error sending supplier emails:", error);
    res.status(500).json({
      message:
        error.message ||
        "An internal server error occurred while sending emails.",
    });
  }
});

// --- REALTIME LISTENER FOR MANUAL ASSIGNMENTS ---
// This listener handles BOTH primary and secondary staff assignments:
// - When a lead is first assigned (primary staff) → sends notification
// - When a 2nd, 3rd, etc. staff is added later (secondary staff) → sends notification
// - Works for both AI auto-assignments and manual assignments from CRM UI
let retryCount = 0;
const MAX_RETRIES = 10; // Limit retries to prevent infinite loops

const listenForManualAssignments = () => {
  // Prevent infinite retry loops
  if (retryCount >= MAX_RETRIES) {
    console.error(
      `[Realtime] ⚠️ Max retries (${MAX_RETRIES}) reached for lead assignee subscription. Stopping retries.`,
    );
    retryCount = 0; // Reset after a delay
    setTimeout(() => {
      retryCount = 0;
      console.log(
        "[Realtime] Retry counter reset. Will attempt subscription again on next trigger.",
      );
    }, 60000); // Reset after 1 minute
    return null;
  }

  const channel = supabase.channel("manual-lead-assignee-changes");
  channel
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "lead_assignees" },
      async (payload) => {
        console.log(
          "[Realtime] 🔔 New lead assignment detected:",
          JSON.stringify(payload.new, null, 2),
        );
        const { lead_id, staff_id } = payload.new;

        if (!lead_id || !staff_id) {
          console.error(
            "[Realtime] ❌ Invalid assignment payload - missing lead_id or staff_id:",
            payload.new,
          );
          return;
        }

        try {
          // Small delay to ensure database consistency after INSERT
          await new Promise((resolve) => setTimeout(resolve, 100));

          // Check if this staff is already assigned to this lead (prevent duplicate notifications)
          // This prevents spam when staff is assigned multiple times or assignment is replayed
          const { data: existingAssignments, error: checkError } =
            await supabase
              .from("lead_assignees")
              .select("id, created_at")
              .eq("lead_id", lead_id)
              .eq("staff_id", staff_id)
              .order("created_at", { ascending: false });

          if (checkError) {
            console.error(
              `[Realtime] Error checking existing assignments: ${checkError.message}`,
            );
            return;
          }

          // Get the most recent assignment
          const mostRecentAssignment = existingAssignments?.[0];
          if (!mostRecentAssignment) {
            console.log(
              `[Realtime] No assignment found for staff ${staff_id} to lead ${lead_id}. Skipping.`,
            );
            return;
          }

          // Check if this is a very recent assignment (within last 10 seconds)
          // If it's older, it might be a replay event, so skip it
          const assignmentTime = new Date(mostRecentAssignment.created_at);
          const now = new Date();
          const secondsDiff = (now - assignmentTime) / 1000;

          if (secondsDiff > 10) {
            console.log(
              `[Realtime] Assignment for staff ${staff_id} to lead ${lead_id} is older than 10 seconds (${secondsDiff.toFixed(
                1,
              )}s). Skipping notification (likely replay event).`,
            );
            return;
          }

          // Fetch lead, its customer, and ALL its assignees with their services
          const { data: lead, error: leadError } = await supabase
            .from("leads")
            .select(
              "*, customer:customers(*), all_assignees:lead_assignees(staff(*))",
            )
            .eq("id", lead_id)
            .single();

          if (leadError || !lead) {
            console.error(
              `[Realtime] Error fetching lead details for notification: ${leadError?.message}`,
            );
            return;
          }

          const newlyAssignedStaff = lead.all_assignees.find(
            (a) => a.staff.id === staff_id,
          )?.staff;
          const customer = lead.customer;

          if (!newlyAssignedStaff) {
            console.error(
              `[Realtime] ❌ Could not find newly assigned staff for lead ${lead_id}. Staff ID: ${staff_id}, Found assignees: ${
                lead.all_assignees?.length || 0
              }, Assignee IDs: ${
                lead.all_assignees?.map((a) => a.staff?.id).join(", ") || "none"
              }`,
            );
            await logLeadActivity(
              lead_id,
              "WhatsApp Failed",
              `Failed to find staff member (ID: ${staff_id}) for assignment notification.`,
              "System",
            );
            return;
          }

          if (!customer) {
            console.error(
              `[Realtime] ❌ Could not find customer for lead ${lead_id}. Customer ID: ${lead.customer_id}`,
            );
            await logLeadActivity(
              lead_id,
              "WhatsApp Failed",
              `Failed to find customer (ID: ${lead.customer_id}) for assignment notification.`,
              "System",
            );
            return;
          }

          console.log(
            `[Realtime] ✅ Found staff: ${newlyAssignedStaff.name} (Phone: ${newlyAssignedStaff.phone}), Customer: ${customer.first_name} ${customer.last_name}`,
          );

          // Check if we've already sent a notification for this assignment recently
          // by checking the lead's activity log (check by staff name, not ID)
          const recentNotification = (lead.activity || []).find(
            (act) =>
              act.type === "Summary Sent to Staff" &&
              act.description?.includes(newlyAssignedStaff.name) &&
              new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
          );

          if (recentNotification) {
            console.log(
              `[Realtime] Notification already sent to ${newlyAssignedStaff.name} for lead ${lead_id} in last 60 seconds. Skipping duplicate.`,
            );
            return;
          }

          if (lead.all_assignees.length === 1) {
            // If this is the only assignee, they are the primary.
            console.log(
              `[Realtime] Primary staff assigned. Checking if MTS summary needs to be sent for lead ${lead.id}`,
            );

            // Check if summary was already sent (prevent duplicates)
            const recentSummarySent = (lead.activity || []).some(
              (act) =>
                (act.type === "Summary Sent" || act.type === "WhatsApp Sent") &&
                (act.description?.includes("Summary sent") ||
                  act.description?.includes("template")) &&
                new Date(act.timestamp) > new Date(Date.now() - 60000), // Last 60 seconds
            );

            if (!recentSummarySent) {
              // DISABLED: MTS summary auto-sending
              // console.log(
              //   `[Realtime] Sending MTS summary to customer "${customer.first_name} ${customer.last_name}" (${customer.phone}) with assigned staff (${newlyAssignedStaff.name}) for lead ${lead.id}`
              // );
              // try {
              //   await sendWelcomeWhatsapp(lead, customer, newlyAssignedStaff);
              //   console.log(
              //     `[Realtime] ✅ MTS summary sent successfully to customer for lead ${lead.id}`
              //   );
              // } catch (summaryError) {
              //   console.error(
              //     `[Realtime] ❌ Error sending MTS summary to customer for lead ${lead.id}:`,
              //     summaryError.message,
              //     summaryError.stack
              //   );
              //   // Log error to lead activity
              //   await logLeadActivity(
              //     lead.id,
              //     "WhatsApp Failed",
              //     `Failed to send MTS summary to customer: ${summaryError.message}`,
              //     "System"
              //   );
              // }
              console.log(
                `[Realtime] MTS summary auto-sending is disabled for lead ${lead.id}`,
              );
            } else {
              console.log(
                `[Realtime] Summary already sent recently for lead ${lead.id}. Skipping duplicate.`,
              );
            }

            // Send staff notification
            await sendStaffAssignmentNotification(
              lead,
              customer,
              newlyAssignedStaff,
              "primary",
            );
          } else {
            // Multiple assignees exist. Assume this new one is secondary.
            // The first person on the list is conventionally the primary.
            const primaryAssignee = lead.all_assignees[0]?.staff;
            if (!primaryAssignee) {
              console.error(
                `[Realtime] Could not determine a primary assignee for lead ${lead.id}.`,
              );
              return;
            }

            // To provide a helpful message, infer the specific service this new staff member is likely responsible for.
            const primaryServices = new Set(primaryAssignee.services || []);
            const secondaryServices = new Set(
              newlyAssignedStaff.services || [],
            );
            const leadServices = new Set(lead.services || []);

            let specificService = null;
            // Find a service the new staff handles, that the lead requires, and the primary staff does NOT handle.
            for (const service of secondaryServices) {
              if (leadServices.has(service) && !primaryServices.has(service)) {
                specificService = service;
                break;
              }
            }
            // Fallback: just find any service they handle that's on the lead.
            if (!specificService) {
              specificService =
                (newlyAssignedStaff.services || []).find((s) =>
                  leadServices.has(s),
                ) || "a task for this lead";
            }

            console.log(
              `[Realtime] Sending SECONDARY assignment notification to ${newlyAssignedStaff.name} (ID: ${newlyAssignedStaff.id}, Phone: ${newlyAssignedStaff.phone}) for lead ${lead.id}`,
            );
            try {
              await sendStaffAssignmentNotification(
                lead,
                customer,
                newlyAssignedStaff,
                "secondary",
                primaryAssignee.name,
                specificService,
              );
            } catch (notifError) {
              console.error(
                `[Realtime] Error sending secondary assignment notification:`,
                notifError.message,
              );
              await logLeadActivity(
                lead.id,
                "WhatsApp Failed",
                `Failed to send assignment notification to staff "${newlyAssignedStaff.name}": ${notifError.message}`,
                "System",
              );
            }
          }
        } catch (error) {
          const errorMessage =
            error?.message ||
            error?.toString() ||
            JSON.stringify(error) ||
            "Unknown error";
          const errorStack = error?.stack || "No stack trace";
          console.error(
            "[Realtime] ❌ Error processing manual assignment notification:",
            errorMessage,
            errorStack,
          );
          // Log to lead activity if we have lead_id
          if (payload?.new?.lead_id) {
            try {
              await logLeadActivity(
                payload.new.lead_id,
                "WhatsApp Failed",
                `Error processing assignment notification: ${error.message}. Check server logs for details.`,
                "System",
              );
            } catch (logError) {
              console.error(
                "[Realtime] Failed to log error to activity:",
                logError.message,
              );
            }
          }
        }
      },
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log(
          "[Realtime] ✅ Listening for manual lead assignments to send notifications.",
        );
        retryCount = 0; // Reset on success
      } else {
        retryCount++;
        const errorMessage =
          err?.message ||
          err?.toString() ||
          JSON.stringify(err) ||
          "Unknown error";

        // Only log errors that aren't the known "mismatch" error (to reduce noise)
        if (
          !errorMessage.includes("mismatch between server and client bindings")
        ) {
          console.error(
            `[Realtime] ❌ Failed to subscribe to lead assignee changes (attempt ${retryCount}/${MAX_RETRIES}):`,
            errorMessage,
          );
        } else {
          // Log mismatch error less frequently (every 5th attempt)
          if (retryCount % 5 === 0) {
            console.warn(
              `[Realtime] ⚠️ Realtime subscription mismatch error (attempt ${retryCount}/${MAX_RETRIES}). This is a known Supabase issue and may resolve automatically.`,
            );
          }
        }

        // Retry with exponential backoff (5s, 10s, 20s, etc., max 30s)
        const retryDelay = Math.min(5000 * Math.pow(2, retryCount - 1), 30000);
        setTimeout(() => {
          if (retryCount < MAX_RETRIES) {
            console.log(
              `[Realtime] Retrying subscription to lead assignee changes... (attempt ${
                retryCount + 1
              }/${MAX_RETRIES})`,
            );
            listenForManualAssignments();
          }
        }, retryDelay);
      }
    });
  return channel;
};

// Use the imported handler for the route
// Function to generate itinerary when lead status changes to Processing
export async function generateItineraryForLead(leadId) {
  try {
    console.log(
      `[Itinerary Trigger] Generating itinerary for lead ${leadId}...`,
    );

    // Fetch lead with customer data
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("*, customer:customers(*)")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      throw new Error(`Failed to fetch lead: ${leadError?.message}`);
    }

    // Check if lead status is "Processing" - itineraries should only be generated for Processing status
    if (lead.status !== "Processing") {
      console.log(
        `[Itinerary Trigger] Lead ${leadId} status is "${lead.status}", not "Processing". Skipping itinerary generation. Itineraries are only generated when status is "Processing".`,
      );
      return;
    }

    // Check if lead has Tour Package service
    const hasTourPackage =
      lead.services && lead.services.includes("Tour Package");
    if (!hasTourPackage) {
      console.log(
        `[Itinerary Trigger] Lead ${leadId} does not have Tour Package service. Skipping itinerary generation.`,
      );
      return;
    }

    // Check if itinerary already exists
    const { data: existingItineraries } = await supabase
      .from("itineraries")
      .select("id")
      .eq("lead_id", leadId)
      .limit(1);

    if (existingItineraries && existingItineraries.length > 0) {
      console.log(
        `[Itinerary Trigger] Itinerary already exists for lead ${leadId}. Skipping generation.`,
      );
      return;
    }

    // Step 1: Check if destination has attractions (at least 1)
    const destination = lead.destination;
    if (!destination) {
      console.log(
        `[Itinerary Trigger] Lead ${leadId} has no destination. Using fallback itinerary generation.`,
      );
      // Proceed with fallback generation
    } else {
      // Fetch destinations to match by name
      const { data: destinations, error: destError } = await supabase
        .from("destinations")
        .select("id, name");

      if (!destError && destinations && destinations.length > 0) {
        // Find matching destination IDs
        const matchingDestinations = destinations.filter(
          (d) =>
            d.name.toLowerCase().includes(destination.toLowerCase()) ||
            destination.toLowerCase().includes(d.name.toLowerCase()),
        );

        if (matchingDestinations.length > 0) {
          const destIds = matchingDestinations.map((d) => d.id);

          // Check if destination has at least 1 attraction
          const { data: sightseeing, error: sightError } = await supabase
            .from("sightseeing")
            .select("id")
            .in("destination_id", destIds)
            .limit(1);

          if (!sightError && sightseeing && sightseeing.length > 0) {
            // Destination has attractions - generate activities first
            console.log(
              `[Itinerary Trigger] Destination "${destination}" has ${sightseeing.length}+ attractions. Auto-generating activities...`,
            );

            // Generate activities using internal helper function
            let generatedActivities = [];
            try {
              const activitiesResult = await generateActivitiesInternal({
                travelDate:
                  lead.travel_date || new Date().toISOString().split("T")[0],
                duration: lead.duration || "4 Days",
                destination: destination,
                adults: lead.adults || 2,
                children: lead.children || 0,
                existingActivities: [],
              });

              if (activitiesResult.success && activitiesResult.activities) {
                generatedActivities = activitiesResult.activities;
                console.log(
                  `[Itinerary Trigger] Generated ${generatedActivities.length} activities for destination "${destination}"`,
                );
              }
            } catch (activitiesError) {
              console.warn(
                `[Itinerary Trigger] Failed to generate activities, proceeding with fallback:`,
                activitiesError.message,
              );
            }

            // Generate itinerary with activities
            const response = await fetch(
              `http://localhost:${
                process.env.PORT || 3000
              }/api/itinerary/generate`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                },
                body: JSON.stringify({
                  destination: destination,
                  lead: lead,
                  attractions: generatedActivities, // Pass generated activities
                  pastedText: "", // Empty string instead of null
                  userInstructions: "", // Empty string instead of null
                  imageBase64: "", // Empty string instead of null
                  categoryEnabled: {
                    flights: true,
                    hotels: true,
                    sightseeing: true,
                    transfers: true,
                    visa: true,
                    insurance: true,
                  },
                }),
              },
            );

            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(
                errorData.message || "Itinerary generation failed",
              );
            }

            const result = await response.json();
            console.log(
              `[Itinerary Trigger] Itinerary generated successfully for lead ${leadId} with ${generatedActivities.length} activities`,
            );

            // Create itinerary metadata in database and link to lead
            if (result && result.creative_title) {
              // Get primary assigned staff for created_by_staff_id
              const { data: leadWithAssignees } = await supabase
                .from("leads")
                .select("*, all_assignees:lead_assignees(staff(*))")
                .eq("id", leadId)
                .single();

              const primaryStaff = leadWithAssignees?.all_assignees?.[0]
                ?.staff || {
                id: 0,
                name: "System",
              };

              // Calculate adults and children from requirements
              const totalAdults =
                (lead.requirements?.rooms || []).reduce(
                  (sum, room) => sum + (room.adults || 0),
                  0,
                ) ||
                (lead.requirements?.adults !== null &&
                lead.requirements?.adults !== undefined
                  ? parseInt(lead.requirements.adults) || 0
                  : 0);
              const totalChildren =
                (lead.requirements?.rooms || []).reduce(
                  (sum, room) => sum + (room.children || 0),
                  0,
                ) ||
                (lead.requirements?.children !== null &&
                lead.requirements?.children !== undefined
                  ? parseInt(lead.requirements.children) || 0
                  : 0);

              // Create itinerary metadata
              const { data: newMetaData, error: metaError } = await supabase
                .from("itineraries")
                .insert({
                  lead_id: leadId,
                  customer_id: lead.customer_id,
                  creative_title: result.creative_title,
                  duration: result.duration || lead.duration,
                  destination: lead.destination,
                  travel_date: lead.travel_date,
                  starting_point: lead.starting_point,
                  adults: totalAdults,
                  children: totalChildren,
                  infants: lead.requirements?.babies || 0,
                  created_by_staff_id: primaryStaff.id,
                  branch_id: (lead.branch_ids && lead.branch_ids[0]) || 1,
                  is_final: false,
                  modified_at: new Date().toISOString(),
                  status: "Prepared",
                })
                .select()
                .single();

              if (metaError) {
                console.error(
                  `[Itinerary Trigger] Failed to create itinerary metadata:`,
                  metaError.message,
                );
              } else {
                // Process day_wise_plan, flights, hotels, visa, insurance from AI result
                const dayWisePlanForDb = (result.day_wise_plan || []).map(
                  (day, index) => ({
                    id: Date.now() + index,
                    day: day.day,
                    date: "", // Can be calculated on the frontend
                    title: day.title,
                    description: day.description,
                    meals: { b: false, l: false, d: false },
                    hotels: [],
                    transfers: [],
                    activities: [],
                  }),
                );

                const aiFlights = (result.flights || []).map((flight, idx) => ({
                  id: Date.now() + idx + 1000,
                  direction: flight.direction || "onward",
                  segments: [
                    {
                      id: Date.now() + idx + 2000,
                      airline: flight.airline || "",
                      flight_number: flight.flight_number || "",
                      from: flight.from || "",
                      to: flight.to || "",
                      from_airport: flight.from || "",
                      to_airport: flight.to || "",
                      departure_time:
                        flight.departure_date && flight.departure_time
                          ? `${flight.departure_date}T${flight.departure_time}:00`
                          : null,
                      arrival_time:
                        flight.arrival_date && flight.arrival_time
                          ? `${flight.arrival_date}T${flight.arrival_time}:00`
                          : null,
                      duration: flight.duration || "",
                      stop: flight.stops || "0",
                      price: flight.price || 0,
                    },
                  ],
                  totalDuration: flight.duration || "",
                  price: flight.price || 0,
                }));

                const aiHotels = (result.hotels || []).map((hotel, idx) => ({
                  id: Date.now() + idx + 3000,
                  name: hotel.name || "",
                  city: hotel.city || "",
                  check_in_date: hotel.check_in_date || "",
                  check_out_date: hotel.check_out_date || "",
                  nights: hotel.nights || 0,
                  rooms: hotel.rooms || 1,
                  room_type: hotel.room_type || "",
                  pricing_type: hotel.pricing_type || "Per Adult",
                  rate_per_night: hotel.rate_per_night || 0,
                  currency: "INR",
                  included: true,
                }));

                const aiVisa = result.visa
                  ? {
                      type: result.visa.type || "",
                      price: result.visa.price || 0,
                      duration: result.visa.duration || "",
                      validity_period: result.visa.validity_period || "",
                      length_of_stay: result.visa.length_of_stay || "",
                      documents_required: result.visa.documents_required || "",
                      requirements: result.visa.requirements || "",
                    }
                  : null;

                const aiInsurance = result.insurance || {
                  type: "Travel Insurance",
                  coverage: "Standard travel insurance coverage",
                  note: "Travel insurance included in the package",
                };

                // Get branch terms and cancellation policy (defaults)
                const { data: branchData } = await supabase
                  .from("branches")
                  .select("terms_and_conditions, cancellation_policy")
                  .eq("id", (lead.branch_ids && lead.branch_ids[0]) || 1)
                  .single();
                const branchTerms = branchData?.terms_and_conditions || "";
                const branchCancellationPolicy =
                  branchData?.cancellation_policy || "";

                // Create itinerary version
                const newVersionData = {
                  itinerary_id: newMetaData.id,
                  version_number: 1,
                  modified_at: new Date().toISOString(),
                  modified_by_staff_id: primaryStaff.id,
                  overview: result.overview || "",
                  day_wise_plan: dayWisePlanForDb,
                  inclusions: Array.isArray(result.inclusions)
                    ? result.inclusions.join("\n")
                    : result.inclusions || "",
                  exclusions: Array.isArray(result.exclusions)
                    ? result.exclusions.join("\n")
                    : result.exclusions || "",
                  terms_and_conditions: branchTerms,
                  cancellation_policy: branchCancellationPolicy,
                  important_notes: result.important_notes || "",
                  detailed_flights: aiFlights,
                  detailed_hotels: aiHotels,
                  detailed_visa: aiVisa,
                  detailed_insurance: aiInsurance,
                };

                const { error: versionError } = await supabase
                  .from("itinerary_versions")
                  .insert(newVersionData);

                if (versionError) {
                  console.error(
                    `[Itinerary Trigger] Failed to create itinerary version:`,
                    versionError.message,
                  );
                }

                // Link itinerary to lead
                const currentItineraryIds = lead.itinerary_ids || [];
                const updatedItineraryIds = [
                  ...currentItineraryIds,
                  newMetaData.id,
                ];

                const aiActivity = {
                  id: Date.now(),
                  type: "Itinerary Generated",
                  description:
                    "AI generated the initial draft (v1) of the itinerary.",
                  user: "AI Assistant",
                  timestamp: new Date().toISOString(),
                };
                const updatedActivity = [aiActivity, ...(lead.activity || [])];

                await supabase
                  .from("leads")
                  .update({
                    itinerary_ids: updatedItineraryIds,
                    activity: updatedActivity,
                    last_updated: new Date().toISOString(),
                  })
                  .eq("id", leadId);

                console.log(
                  `[Itinerary Trigger] ✅ Itinerary metadata and version created and linked to lead ${leadId}. Itinerary ID: ${newMetaData.id}`,
                );
              }
            }

            // DISABLED: Automatic Razorpay payment link generation
            // await createRazorpayLinkForItinerary(lead, lead.customer);

            return result;
          }
        }
      }
    }

    // Step 2: No attractions found - use fallback (Supabase DB → WordPress → Gemini)
    console.log(
      `[Itinerary Trigger] No attractions found for destination "${destination}". Using fallback itinerary generation (DB → WordPress → Gemini)...`,
    );

    // Call the itinerary generation endpoint internally using fetch
    // Note: The endpoint requires auth, but we'll handle this via internal call
    const API_BASE =
      process.env.API_BASE_URL ||
      `http://localhost:${process.env.PORT || 3000}`;
    const response = await fetch(`${API_BASE}/api/itinerary/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // For internal calls, we need to bypass auth - the endpoint will need to handle this
        "X-Internal-Call": "true",
      },
      body: JSON.stringify({
        destination: destination,
        lead: lead,
        pastedText: "", // Empty string instead of null
        userInstructions: "", // Empty string instead of null
        imageBase64: "", // Empty string instead of null
        categoryEnabled: {
          flights: true,
          hotels: true,
          sightseeing: true,
          transfers: true,
          visa: true,
          insurance: true,
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Itinerary generation failed");
    }

    const result = await response.json();
    console.log(
      `[Itinerary Trigger] Itinerary generated successfully for lead ${leadId} using fallback`,
    );

    // Create itinerary metadata in database and link to lead
    if (result && result.creative_title) {
      // Get primary assigned staff for created_by_staff_id
      const { data: leadWithAssignees } = await supabase
        .from("leads")
        .select("*, all_assignees:lead_assignees(staff(*))")
        .eq("id", leadId)
        .single();

      const primaryStaff = leadWithAssignees?.all_assignees?.[0]?.staff || {
        id: 0,
        name: "System",
      };

      // Calculate adults and children from requirements
      const totalAdults =
        (lead.requirements?.rooms || []).reduce(
          (sum, room) => sum + (room.adults || 0),
          0,
        ) ||
        (lead.requirements?.adults !== null &&
        lead.requirements?.adults !== undefined
          ? parseInt(lead.requirements.adults) || 0
          : 0);
      const totalChildren =
        (lead.requirements?.rooms || []).reduce(
          (sum, room) => sum + (room.children || 0),
          0,
        ) ||
        (lead.requirements?.children !== null &&
        lead.requirements?.children !== undefined
          ? parseInt(lead.requirements.children) || 0
          : 0);

      // Create itinerary metadata
      const { data: newMetaData, error: metaError } = await supabase
        .from("itineraries")
        .insert({
          lead_id: leadId,
          customer_id: lead.customer_id,
          creative_title: result.creative_title,
          duration: result.duration || lead.duration,
          destination: lead.destination,
          travel_date: lead.travel_date,
          starting_point: lead.starting_point,
          adults: totalAdults,
          children: totalChildren,
          infants: lead.requirements?.babies || 0,
          created_by_staff_id: primaryStaff.id,
          branch_id: (lead.branch_ids && lead.branch_ids[0]) || 1,
          is_final: false,
          modified_at: new Date().toISOString(),
          status: "Prepared",
        })
        .select()
        .single();

      if (metaError) {
        console.error(
          `[Itinerary Trigger] Failed to create itinerary metadata:`,
          metaError.message,
        );
      } else {
        // Process day_wise_plan, flights, hotels, visa, insurance from AI result
        const dayWisePlanForDb = (result.day_wise_plan || []).map(
          (day, index) => ({
            id: Date.now() + index,
            day: day.day,
            date: "", // Can be calculated on the frontend
            title: day.title,
            description: day.description,
            meals: { b: false, l: false, d: false },
            hotels: [],
            transfers: [],
            activities: [],
          }),
        );

        const aiFlights = (result.flights || []).map((flight, idx) => ({
          id: Date.now() + idx + 1000,
          direction: flight.direction || "onward",
          segments: [
            {
              id: Date.now() + idx + 2000,
              airline: flight.airline || "",
              flight_number: flight.flight_number || "",
              from: flight.from || "",
              to: flight.to || "",
              from_airport: flight.from || "",
              to_airport: flight.to || "",
              departure_time:
                flight.departure_date && flight.departure_time
                  ? `${flight.departure_date}T${flight.departure_time}:00`
                  : null,
              arrival_time:
                flight.arrival_date && flight.arrival_time
                  ? `${flight.arrival_date}T${flight.arrival_time}:00`
                  : null,
              duration: flight.duration || "",
              stop: flight.stops || "0",
              price: flight.price || 0,
            },
          ],
          totalDuration: flight.duration || "",
          price: flight.price || 0,
        }));

        const aiHotels = (result.hotels || []).map((hotel, idx) => ({
          id: Date.now() + idx + 3000,
          name: hotel.name || "",
          city: hotel.city || "",
          check_in_date: hotel.check_in_date || "",
          check_out_date: hotel.check_out_date || "",
          nights: hotel.nights || 0,
          rooms: hotel.rooms || 1,
          room_type: hotel.room_type || "",
          pricing_type: hotel.pricing_type || "Per Adult",
          rate_per_night: hotel.rate_per_night || 0,
          currency: "INR",
          included: true,
        }));

        const aiVisa = result.visa
          ? {
              type: result.visa.type || "",
              price: result.visa.price || 0,
              duration: result.visa.duration || "",
              validity_period: result.visa.validity_period || "",
              length_of_stay: result.visa.length_of_stay || "",
              documents_required: result.visa.documents_required || "",
              requirements: result.visa.requirements || "",
            }
          : null;

        const aiInsurance = result.insurance || {
          type: "Travel Insurance",
          coverage: "Standard travel insurance coverage",
          note: "Travel insurance included in the package",
        };

        // Get branch terms and cancellation policy (defaults)
        const { data: branchData } = await supabase
          .from("branches")
          .select("terms_and_conditions, cancellation_policy")
          .eq("id", (lead.branch_ids && lead.branch_ids[0]) || 1)
          .single();
        const branchTerms = branchData?.terms_and_conditions || "";
        const branchCancellationPolicy = branchData?.cancellation_policy || "";

        // Create itinerary version
        const newVersionData = {
          itinerary_id: newMetaData.id,
          version_number: 1,
          modified_at: new Date().toISOString(),
          modified_by_staff_id: primaryStaff.id,
          overview: result.overview || "",
          day_wise_plan: dayWisePlanForDb,
          inclusions: Array.isArray(result.inclusions)
            ? result.inclusions.join("\n")
            : result.inclusions || "",
          exclusions: Array.isArray(result.exclusions)
            ? result.exclusions.join("\n")
            : result.exclusions || "",
          terms_and_conditions: branchTerms,
          cancellation_policy: branchCancellationPolicy,
          important_notes: result.important_notes || "",
          detailed_flights: aiFlights,
          detailed_hotels: aiHotels,
          detailed_visa: aiVisa,
          detailed_insurance: aiInsurance,
        };

        const { error: versionError } = await supabase
          .from("itinerary_versions")
          .insert(newVersionData);

        if (versionError) {
          console.error(
            `[Itinerary Trigger] Failed to create itinerary version:`,
            versionError.message,
          );
        }

        // Link itinerary to lead
        const currentItineraryIds = lead.itinerary_ids || [];
        const updatedItineraryIds = [...currentItineraryIds, newMetaData.id];

        const aiActivity = {
          id: Date.now(),
          type: "Itinerary Generated",
          description: "AI generated the initial draft (v1) of the itinerary.",
          user: "AI Assistant",
          timestamp: new Date().toISOString(),
        };
        const updatedActivity = [aiActivity, ...(lead.activity || [])];

        await supabase
          .from("leads")
          .update({
            itinerary_ids: updatedItineraryIds,
            activity: updatedActivity,
            last_updated: new Date().toISOString(),
          })
          .eq("id", leadId);

        console.log(
          `[Itinerary Trigger] ✅ Itinerary metadata and version created and linked to lead ${leadId}. Itinerary ID: ${newMetaData.id}`,
        );
      }
    }

    // DISABLED: Automatic Razorpay payment link generation
    // await createRazorpayLinkForItinerary(lead, lead.customer);

    return result;
  } catch (error) {
    console.error(
      `[Itinerary Trigger] Error generating itinerary for lead ${leadId}:`,
      error.message,
    );
    // Don't throw - just log the error so it doesn't break the status update
  }
}

app.post("/api/itinerary/generate-pdf", requireAuth, generateItineraryPdf);

app.post("/api/invoice/generate-pdf", requireAuth, generateInvoicePdf);

// Phone status check endpoint is now in whatsapp-crm.js

// --- AI KNOWLEDGE BASE / SOURCES API ---
// These endpoints manage the AI's knowledge base (sources) that are used for itinerary generation
// RESTRICTED TO SUPER ADMIN ONLY
// Note: requireAuth and requireSuperAdmin middleware are defined at the top of the file

// Itinerary generation endpoint (with rate limiting and auth)
app.post(
  "/api/itinerary/generate",
  requireAuth,
  aiGenerationLimiter,
  generateItinerary,
);

// Get all sources
app.get("/api/sources", requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ai_sources")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("[Sources API] Error fetching sources:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to fetch sources." });
  }
});

// Get a single source by ID
app.get("/api/sources/:id", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("ai_sources")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ message: "Source not found." });
    }
    res.json(data);
  } catch (error) {
    console.error("[Sources API] Error fetching source:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to fetch source." });
  }
});

// Create a new source (URL, text, or file reference)
// Supports both JSON (for URL/text sources) and multipart/form-data (for file uploads)
app.post(
  "/api/sources",
  requireSuperAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      // Get data from either JSON body or form-data
      const { type, title, url, content, file_url, file_name, file_type } =
        req.body || {};
      const uploadedFile = req.file;

      if (!type || !title) {
        return res
          .status(400)
          .json({ message: "Type and title are required." });
      }

      let finalFileUrl = file_url;
      let finalFileName = file_name;
      let finalFileType = file_type;
      let extractedContent = content;

      // Handle file upload if a file was uploaded via multer
      if (uploadedFile) {
        try {
          console.log(
            `[Sources API] Processing uploaded file: ${uploadedFile.originalname} (${uploadedFile.mimetype})`,
          );

          // Upload file to Supabase storage
          const fileExt = uploadedFile.originalname.split(".").pop();
          const fileName = `sources/${Math.random()
            .toString(36)
            .substring(7)}_${Date.now()}.${fileExt}`;

          const { data: uploadData, error: uploadError } =
            await supabase.storage
              .from("ai_sources")
              .upload(fileName, uploadedFile.buffer, {
                contentType: uploadedFile.mimetype,
              });

          if (uploadError) throw uploadError;

          // Get public URL
          const {
            data: { publicUrl },
          } = supabase.storage.from("ai_sources").getPublicUrl(fileName);

          finalFileUrl = publicUrl;
          finalFileName = uploadedFile.originalname;
          finalFileType = uploadedFile.mimetype;

          // Extract text from the uploaded file
          console.log(`[Sources API] Extracting text from uploaded file...`);
          try {
            extractedContent = await extractTextFromFile(
              uploadedFile.buffer,
              uploadedFile.mimetype,
            );
            console.log(
              `[Sources API] Successfully extracted ${extractedContent.length} characters from file.`,
            );
          } catch (extractError) {
            console.warn(
              `[Sources API] Text extraction failed: ${extractError.message}`,
            );
            extractedContent = `[File uploaded but text extraction failed: ${extractError.message}]`;
          }
        } catch (fileError) {
          console.error("[Sources API] File upload error:", fileError);
          return res.status(500).json({
            message: `Failed to upload file: ${fileError.message}`,
          });
        }
      }

      // Validate required fields based on type
      if (type === "url" && !url && !finalFileUrl) {
        return res
          .status(400)
          .json({ message: "URL is required for URL sources." });
      }

      if (type === "text" && !content) {
        return res
          .status(400)
          .json({ message: "Content is required for text sources." });
      }

      if (
        (type === "pdf" || type === "excel") &&
        !finalFileUrl &&
        !uploadedFile
      ) {
        return res
          .status(400)
          .json({ message: "File is required for PDF/Excel sources." });
      }

      // Extract content from URL if type is URL and content not provided
      if (type === "url" && !extractedContent && url) {
        try {
          // Check if user wants full website crawl (default: true for URL sources)
          const crawlFullSite = req.body.crawl_full_site !== false; // Default to true

          if (crawlFullSite) {
            // Generate unique crawl ID for tracking/cancellation
            const crawlId = `crawl_${Date.now()}_${Math.random()
              .toString(36)
              .substring(7)}`;

            console.log(
              `[Sources API] Starting full website crawl for: ${url} (ID: ${crawlId})`,
            );

            try {
              extractedContent = await crawlWebsite(url, {
                maxPages: 500, // Maximum pages to crawl (increased for comprehensive crawling)
                maxDepth: 999, // Effectively unlimited depth - crawl all levels deep
                delay: 500, // 500ms delay between requests
                crawlId: crawlId,
              });
              console.log(
                `[Sources API] Successfully crawled website: ${extractedContent.length} characters extracted.`,
              );
            } catch (crawlError) {
              if (crawlError.message === "Crawl cancelled by user") {
                throw new Error("Website crawl was cancelled");
              }
              throw crawlError;
            }
          } else {
            console.log(`[Sources API] Fetching single page: ${url}`);
            extractedContent = await fetchSinglePage(url);
            console.log(
              `[Sources API] Successfully extracted ${extractedContent.length} characters from single page.`,
            );
          }
        } catch (fetchError) {
          console.warn(
            "[Sources API] Failed to fetch/crawl URL content:",
            fetchError.message,
          );
          extractedContent = `Failed to extract content from URL: ${url}. Error: ${fetchError.message}`;
        }
      }

      // If file_url was provided but no content extracted, try to extract from the URL
      if (
        (type === "pdf" || type === "excel") &&
        finalFileUrl &&
        !extractedContent
      ) {
        try {
          console.log(
            `[Sources API] Extracting text from file URL: ${finalFileUrl}`,
          );
          extractedContent = await extractTextFromFileURL(
            finalFileUrl,
            finalFileType,
          );
          console.log(
            `[Sources API] Successfully extracted ${extractedContent.length} characters from file URL.`,
          );
        } catch (extractError) {
          console.warn(
            `[Sources API] Text extraction from file URL failed: ${extractError.message}`,
          );
          extractedContent = `[File uploaded but text extraction failed: ${extractError.message}]`;
        }
      }

      const newSource = {
        type,
        title,
        url: type === "url" ? url : null,
        content: type === "text" ? content : extractedContent || null,
        file_url: type === "pdf" || type === "excel" ? finalFileUrl : null,
        file_name: type === "pdf" || type === "excel" ? finalFileName : null,
        file_type: type === "pdf" || type === "excel" ? finalFileType : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("ai_sources")
        .insert(newSource)
        .select()
        .single();

      if (error) throw error;

      console.log(`[Sources API] Source created successfully: ${data.id}`);
      res.status(201).json(data);
    } catch (error) {
      console.error("[Sources API] Error creating source:", error);
      res
        .status(500)
        .json({ message: error.message || "Failed to create source." });
    }
  },
);

// Update a source
app.put(
  "/api/sources/:id",
  requireSuperAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, url, content, file_url, file_name, file_type } =
        req.body || {};
      const uploadedFile = req.file;

      // Fetch existing source to preserve fields
      const { data: existingSource, error: fetchError } = await supabase
        .from("ai_sources")
        .select("*")
        .eq("id", id)
        .single();

      if (fetchError || !existingSource) {
        return res.status(404).json({ message: "Source not found." });
      }

      const updateData = {
        title: title !== undefined ? title : existingSource.title,
        updated_at: new Date().toISOString(),
      };

      if (url !== undefined) updateData.url = url;
      if (content !== undefined) updateData.content = content;

      // Handle file upload if a new file was uploaded
      if (uploadedFile) {
        try {
          console.log(
            `[Sources API] Processing uploaded file for update: ${uploadedFile.originalname}`,
          );

          // Upload file to Supabase storage
          const fileExt = uploadedFile.originalname.split(".").pop();
          const fileName = `sources/${Math.random()
            .toString(36)
            .substring(7)}_${Date.now()}.${fileExt}`;

          const { error: uploadError } = await supabase.storage
            .from("ai_sources")
            .upload(fileName, uploadedFile.buffer, {
              contentType: uploadedFile.mimetype,
            });

          if (uploadError) throw uploadError;

          // Get public URL
          const {
            data: { publicUrl },
          } = supabase.storage.from("ai_sources").getPublicUrl(fileName);

          updateData.file_url = publicUrl;
          updateData.file_name = uploadedFile.originalname;
          updateData.file_type = uploadedFile.mimetype;

          // Extract text from the uploaded file
          try {
            const extractedContent = await extractTextFromFile(
              uploadedFile.buffer,
              uploadedFile.mimetype,
            );
            updateData.content = extractedContent;
            console.log(
              `[Sources API] Successfully extracted ${extractedContent.length} characters from file.`,
            );
          } catch (extractError) {
            console.warn(
              `[Sources API] Text extraction failed: ${extractError.message}`,
            );
          }
        } catch (fileError) {
          console.error("[Sources API] File upload error:", fileError);
          return res.status(500).json({
            message: `Failed to upload file: ${fileError.message}`,
          });
        }
      } else {
        // If file_url changed but no new file uploaded, try to extract from the new URL
        if (file_url !== undefined && file_url !== existingSource.file_url) {
          updateData.file_url = file_url;
          if (file_name !== undefined) updateData.file_name = file_name;
          if (file_type !== undefined) updateData.file_type = file_type;

          // Try to extract text from the new file URL
          try {
            const extractedContent = await extractTextFromFileURL(
              file_url,
              file_type || existingSource.file_type,
            );
            updateData.content = extractedContent;
          } catch (extractError) {
            console.warn(
              `[Sources API] Text extraction from file URL failed: ${extractError.message}`,
            );
          }
        } else {
          // Preserve existing file fields if not updating
          if (file_url === undefined)
            updateData.file_url = existingSource.file_url;
          if (file_name === undefined)
            updateData.file_name = existingSource.file_name;
          if (file_type === undefined)
            updateData.file_type = existingSource.file_type;
        }
      }

      // Handle URL source re-crawl if URL changed or refresh requested
      if (existingSource.type === "url" && existingSource.url) {
        const urlChanged = url !== undefined && url !== existingSource.url;
        const refreshRequested = req.body.refresh_content === true;

        if (urlChanged || refreshRequested) {
          const urlToCrawl = urlChanged ? url : existingSource.url;
          const crawlFullSite = req.body.crawl_full_site !== false; // Default to true

          try {
            if (crawlFullSite) {
              const crawlId = `crawl_${Date.now()}_${Math.random()
                .toString(36)
                .substring(7)}`;
              console.log(
                `[Sources API] Re-crawling website for update: ${urlToCrawl} (ID: ${crawlId})`,
              );

              try {
                const extractedContent = await crawlWebsite(urlToCrawl, {
                  maxPages: 500,
                  maxDepth: 999,
                  delay: 500,
                  crawlId: crawlId,
                });
                updateData.content = extractedContent;
                updateData.url = urlChanged ? url : existingSource.url;
                console.log(
                  `[Sources API] Successfully re-crawled website: ${extractedContent.length} characters extracted.`,
                );
              } catch (crawlError) {
                if (crawlError.message === "Crawl cancelled by user") {
                  throw new Error("Website crawl was cancelled");
                }
                throw crawlError;
              }
            } else {
              console.log(
                `[Sources API] Re-fetching single page: ${urlToCrawl}`,
              );
              const extractedContent = await fetchSinglePage(urlToCrawl);
              updateData.content = extractedContent;
              updateData.url = urlChanged ? url : existingSource.url;
              console.log(
                `[Sources API] Successfully re-fetched single page: ${extractedContent.length} characters extracted.`,
              );
            }
          } catch (fetchError) {
            console.warn(
              "[Sources API] Failed to re-fetch/crawl URL content:",
              fetchError.message,
            );
            // Don't update content if crawl fails - keep existing content
          }
        }
      }

      const { data, error } = await supabase
        .from("ai_sources")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ message: "Source not found." });
      }
      res.json(data);
    } catch (error) {
      console.error("[Sources API] Error updating source:", error);
      res
        .status(500)
        .json({ message: error.message || "Failed to update source." });
    }
  },
);

// Delete a source
app.delete("/api/sources/:id", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("ai_sources").delete().eq("id", id);

    if (error) throw error;
    res.json({ message: "Source deleted successfully." });
  } catch (error) {
    console.error("[Sources API] Error deleting source:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to delete source." });
  }
});

// Search sources by content (for AI to find relevant sources)
app.post("/api/sources/search", requireSuperAdmin, async (req, res) => {
  try {
    const { query, destination } = req.body;

    if (!query && !destination) {
      return res
        .status(400)
        .json({ message: "Query or destination is required." });
    }

    const searchTerm = destination || query;

    // Search in title and content
    const { data, error } = await supabase
      .from("ai_sources")
      .select("id, type, title, content, url, file_name")
      .or(`title.ilike.%${searchTerm}%,content.ilike.%${searchTerm}%`)
      .limit(10);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("[Sources API] Error searching sources:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to search sources." });
  }
});

// Cancel an active website crawl
app.post("/api/sources/crawl/cancel", requireSuperAdmin, async (req, res) => {
  try {
    const { crawlId } = req.body;

    if (!crawlId) {
      return res.status(400).json({ message: "Crawl ID is required." });
    }

    const cancelled = cancelCrawl(crawlId);

    if (!cancelled) {
      return res
        .status(404)
        .json({ message: "Crawl not found or already completed." });
    }

    res.json({
      message: "Crawl cancellation requested.",
      cancelled: true,
    });
  } catch (error) {
    console.error("[Sources API] Error cancelling crawl:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to cancel crawl." });
  }
});

// Get status of an active crawl
app.get(
  "/api/sources/crawl/status/:crawlId",
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { crawlId } = req.params;

      const crawlInfo = activeCrawls.get(crawlId);

      if (!crawlInfo) {
        return res.json({
          active: false,
          message: "Crawl not found or completed",
        });
      }

      res.json({
        active: true,
        cancelled: crawlInfo.cancelled,
        pagesCrawled: crawlInfo.pagesCrawled,
        totalPages: crawlInfo.totalPages,
        currentUrl: crawlInfo.currentUrl,
        elapsedTime: Date.now() - crawlInfo.startTime,
      });
    } catch (error) {
      console.error("[Sources API] Error getting crawl status:", error);
      res
        .status(500)
        .json({ message: error.message || "Failed to get crawl status." });
    }
  },
);

// Get all active crawls (for monitoring)
app.get("/api/sources/crawl/active", requireSuperAdmin, async (req, res) => {
  try {
    const activeCrawlList = Array.from(activeCrawls.entries()).map(
      ([id, info]) => ({
        crawlId: id,
        pagesCrawled: info.pagesCrawled,
        totalPages: info.totalPages,
        currentUrl: info.currentUrl,
        elapsedTime: Date.now() - info.startTime,
        cancelled: info.cancelled,
      }),
    );

    res.json(activeCrawlList);
  } catch (error) {
    console.error("[Sources API] Error getting active crawls:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to get active crawls." });
  }
});

// --- JOB APPLICANTS ENDPOINTS ---

// Create a new job applicant (public endpoint for form submission)
// Handle OPTIONS preflight request - MUST be before POST route
// ALLOW ALL ORIGINS for this public form endpoint
app.options("/api/job-applicants", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Middleware to set CORS headers - ALLOW ALL for job applicants endpoint
const setCorsHeaders = (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
};

// Support both FormData (multer) and JSON (base64) formats
app.post("/api/job-applicants", setCorsHeaders, async (req, res) => {
  try {
    // Check if request is JSON (with base64 file) or FormData
    const isJsonRequest =
      req.headers["content-type"]?.includes("application/json");

    let fileToUpload = null;
    let fileNameToUse = null;
    let fileTypeToUse = null;

    if (isJsonRequest) {
      // Handle JSON request with base64 file (like dynamic-whatsapp-form.html)
      const { resume_file, resume_file_name, resume_file_type } = req.body;

      if (resume_file) {
        try {
          // Convert base64 to buffer
          const fileBuffer = Buffer.from(resume_file, "base64");
          fileToUpload = fileBuffer;
          fileNameToUse = resume_file_name || "resume.pdf";
          fileTypeToUse = resume_file_type || "application/pdf";
        } catch (err) {
          return res.status(400).json({
            message:
              "Invalid file data. Please ensure the file is properly encoded.",
          });
        }
      }
    } else {
      // Handle FormData request (multer) - use middleware approach
      return resumeUpload.single("resume")(req, res, async (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              console.error(
                "[Job Applicants] ❌ File size error:",
                err.message,
              );
              return res.status(413).json({
                message: "File size too large. Maximum size is 10MB.",
              });
            }
            return res.status(400).json({
              message: `File upload error: ${err.message}`,
            });
          }
          return res.status(400).json({
            message: err.message || "File upload error",
          });
        }
        // Process FormData request
        fileToUpload = req.file?.buffer;
        fileNameToUse = req.file?.originalname;
        fileTypeToUse = req.file?.mimetype;
        await processApplication();
      });
    }

    // Process JSON request
    await processApplication();

    async function processApplication() {
      try {
        const {
          first_name,
          last_name,
          email,
          phone,
          educational_qualification,
          experience_level,
          brief_about_yourself,
          role_applied_for,
        } = req.body;

        // Log form submission
        console.log(`[Job Applicants] 📋 New job application form submitted`);
        console.log(`[Job Applicants] Name: ${first_name} ${last_name}`);
        console.log(
          `[Job Applicants] Role Applied For: ${
            role_applied_for || "Not specified"
          }`,
        );
        console.log(`[Job Applicants] Email: ${email}`);
        console.log(`[Job Applicants] Phone: ${phone}`);

        // Validate required fields
        if (
          !first_name ||
          !last_name ||
          !email ||
          !phone ||
          !role_applied_for ||
          !experience_level ||
          !fileToUpload
        ) {
          return res.status(400).json({
            message:
              "Missing required fields: first_name, last_name, email, phone, role_applied_for, experience_level, and resume are required.",
          });
        }

        // Validate experience_level
        if (!["Fresher", "Experienced"].includes(experience_level)) {
          return res.status(400).json({
            message:
              "Invalid experience_level. Must be 'Fresher' or 'Experienced'.",
          });
        }

        // Upload resume file to Supabase storage
        let resumeUrl = null;
        let finalResumeFileName = null;
        let finalResumeFileType = null;

        if (fileToUpload) {
          try {
            // Determine file extension from file name
            const fileExt = fileNameToUse.split(".").pop().toLowerCase();
            const fileName = `job-applicants/${Math.random()
              .toString(36)
              .substring(7)}_${Date.now()}.${fileExt}`;

            // fileToUpload is already a Buffer for both JSON and FormData cases
            const fileBuffer = Buffer.isBuffer(fileToUpload)
              ? fileToUpload
              : Buffer.from(fileToUpload);

            // Upload to Supabase storage (using avatars bucket as it's already configured)
            const { error: uploadError } = await supabase.storage
              .from("avatars")
              .upload(fileName, fileBuffer, {
                contentType: fileTypeToUse,
              });

            if (uploadError) throw uploadError;

            // Get public URL
            const {
              data: { publicUrl },
            } = supabase.storage.from("avatars").getPublicUrl(fileName);

            resumeUrl = publicUrl;
            finalResumeFileName = fileNameToUse;
            finalResumeFileType = fileTypeToUse;
            console.log(
              `[Job Applicants] ✅ Resume uploaded successfully: ${fileName}`,
            );
          } catch (uploadErr) {
            console.error(
              "[Job Applicants] ❌ Resume upload error:",
              uploadErr,
            );
            return res.status(500).json({
              message: `Failed to upload resume: ${uploadErr.message}`,
            });
          }
        }

        // Create job applicant record
        const newApplicant = {
          first_name,
          last_name,
          email,
          phone,
          educational_qualification: educational_qualification || null,
          experience_level,
          brief_about_yourself: brief_about_yourself || null,
          resume_url: resumeUrl,
          resume_file_name: finalResumeFileName,
          resume_file_type: finalResumeFileType,
          role_applied_for: role_applied_for || null,
          status: "Applied",
          activity: [
            {
              id: Date.now(),
              type: "Application Submitted",
              description: "Application submitted via website form",
              user: "System",
              timestamp: new Date().toISOString(),
            },
          ],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const { data: createdApplicant, error: applicantError } = await supabase
          .from("job_applicants")
          .insert(newApplicant)
          .select()
          .single();

        if (applicantError) throw applicantError;

        console.log(
          `[Job Applicants] ✅ Application created successfully with ID: ${createdApplicant.id}`,
        );

        res.status(201).json({
          message: "Application submitted successfully.",
          applicant: createdApplicant,
        });
      } catch (error) {
        console.error(
          "[Job Applicants] ❌ Error in processApplication:",
          error,
        );
        res.header("Access-Control-Allow-Origin", "*");
        return res.status(500).json({
          message: error.message || "An internal server error occurred.",
        });
      }
    } // End processApplication function
  } catch (error) {
    console.error("[Job Applicants] ❌ Error creating job applicant:", error);

    // Ensure CORS headers are set even on error (allow all)
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");

    res.status(500).json({
      message: error.message || "An internal server error occurred.",
    });
  }
});

// Error handler for multer file size errors (must be after routes)
app.use((error, req, res, next) => {
  // Set CORS headers for error responses - ALLOW ALL for job applicants endpoint
  if (req.path === "/api/job-applicants") {
    res.header("Access-Control-Allow-Origin", "*");
  } else {
    // For other endpoints, use normal CORS
    const origin = req.headers.origin;
    if (origin && origin.includes("maduratravel.com")) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (origin && origin.includes("maduraglobal.com")) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (
      origin &&
      (origin.includes("crm-madura.vercel.app") ||
        origin.includes("madura-crm-25.vercel.app"))
    ) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (origin && allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    } else if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    } else {
      res.header("Access-Control-Allow-Origin", "*");
    }
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (error instanceof multer.MulterError) {
    console.error("[Job Applicants] ❌ Multer error:", error);
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: "File size too large. Maximum size is 10MB.",
      });
    }
    return res.status(400).json({
      message: `File upload error: ${error.message}`,
    });
  }

  // Handle other errors
  if (error.message && error.message.includes("File")) {
    return res.status(400).json({
      message: error.message,
    });
  }

  // If headers haven't been sent, send error response
  if (!res.headersSent) {
    res.status(500).json({
      message: error.message || "An internal server error occurred.",
    });
  } else {
    next(error);
  }
});

// Get all job applicants (Super Admin, Manager, or Lead Manager tag)
app.get("/api/job-applicants", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    const hasAccess =
      currentUser.role_id === 1 ||
      currentUser.role_id === 2 ||
      currentUser.is_lead_manager === true;
    if (!hasAccess) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin, Manager, or Lead Manager can view job applicants.",
      });
    }

    const { data: applicants, error } = await supabase
      .from("job_applicants")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(applicants || []);
  } catch (error) {
    console.error("Error fetching job applicants:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch job applicants.",
    });
  }
});

// Get a single job applicant by ID
app.get("/api/job-applicants/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    const hasAccess =
      currentUser.role_id === 1 ||
      currentUser.role_id === 2 ||
      currentUser.is_lead_manager === true;
    if (!hasAccess) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin, Manager, or Lead Manager can view job applicants.",
      });
    }

    const { id } = req.params;
    const { data: applicant, error } = await supabase
      .from("job_applicants")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!applicant) {
      return res.status(404).json({ message: "Applicant not found." });
    }

    res.json(applicant);
  } catch (error) {
    console.error("Error fetching job applicant:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch job applicant.",
    });
  }
});

// Update job applicant (approve, reject, update status, etc.)
app.put("/api/job-applicants/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    const hasAccess =
      currentUser.role_id === 1 ||
      currentUser.role_id === 2 ||
      currentUser.is_lead_manager === true;
    if (!hasAccess) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin, Manager, or Lead Manager can update job applicants.",
      });
    }

    const { id } = req.params;
    const {
      status,
      approval_reason,
      rejection_reason,
      role_applied_for,
      first_name,
      last_name,
      email,
      phone,
      educational_qualification,
      experience_level,
      brief_about_yourself,
      activity,
    } = req.body;

    // Get current applicant
    const { data: currentApplicant, error: fetchError } = await supabase
      .from("job_applicants")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;
    if (!currentApplicant) {
      return res.status(404).json({ message: "Applicant not found." });
    }

    // Build update object
    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (status !== undefined) {
      updateData.status = status;

      // Set approval/rejection fields based on status
      if (status === "Approved") {
        updateData.approved_by_staff_id = currentUser.id;
        updateData.approval_reason = approval_reason || null;
        updateData.rejected_by_staff_id = null;
        updateData.rejection_reason = null;
      } else if (status === "Rejected") {
        updateData.rejected_by_staff_id = currentUser.id;
        updateData.rejection_reason = rejection_reason || null;
        updateData.approved_by_staff_id = null;
        updateData.approval_reason = null;
      }
    }

    if (role_applied_for !== undefined)
      updateData.role_applied_for = role_applied_for;
    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (educational_qualification !== undefined)
      updateData.educational_qualification = educational_qualification;
    if (experience_level !== undefined)
      updateData.experience_level = experience_level;
    if (brief_about_yourself !== undefined)
      updateData.brief_about_yourself = brief_about_yourself;
    if (activity !== undefined) updateData.activity = activity;

    const { data: updatedApplicant, error: updateError } = await supabase
      .from("job_applicants")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    console.log(
      `[Job Applicants] Applicant ${id} updated by ${currentUser.name}`,
    );

    res.json({
      message: "Applicant updated successfully.",
      applicant: updatedApplicant,
    });
  } catch (error) {
    console.error("Error updating job applicant:", error);
    res.status(500).json({
      message: error.message || "Failed to update job applicant.",
    });
  }
});

// Delete job applicant (Super Admin only)
app.delete("/api/job-applicants/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can delete
    if (currentUser.role_id !== 1) {
      return res.status(403).json({
        message: "Access denied. Only Super Admin can delete job applicants.",
      });
    }

    const { id } = req.params;

    // Get applicant to delete resume file if exists
    const { data: applicant, error: fetchError } = await supabase
      .from("job_applicants")
      .select("resume_url")
      .eq("id", id)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") throw fetchError;

    // Delete resume file from storage if exists
    if (applicant?.resume_url) {
      try {
        // Extract file path from URL
        const urlParts = applicant.resume_url.split("/");
        const fileName = urlParts[urlParts.length - 1].split("?")[0];
        const filePath = `job-applicants/${fileName}`;

        const { error: deleteError } = await supabase.storage
          .from("avatars")
          .remove([filePath]);

        if (deleteError) {
          console.warn(
            `[Job Applicants] Failed to delete resume file: ${deleteError.message}`,
          );
        }
      } catch (fileErr) {
        console.warn(
          `[Job Applicants] Error deleting resume file: ${fileErr.message}`,
        );
      }
    }

    const { error: deleteError } = await supabase
      .from("job_applicants")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    console.log(
      `[Job Applicants] Applicant ${id} deleted by ${currentUser.name}`,
    );

    res.json({ message: "Applicant deleted successfully." });
  } catch (error) {
    console.error("Error deleting job applicant:", error);
    res.status(500).json({
      message: error.message || "Failed to delete job applicant.",
    });
  }
});

// --- SUB-AGENT REGISTRATIONS API (Super Admin, Manager, or Lead Manager tag) ---
const hasSubAgentRegAccess = (currentUser) =>
  currentUser.role_id === 1 ||
  currentUser.role_id === 2 ||
  currentUser.is_lead_manager === true;

// In-memory CAPTCHA store for public sub-agent registration form (WordPress). id -> { code, expires }
const subAgentCaptchaStore = new Map();
const CAPTCHA_TTL_MS = 2 * 60 * 1000; // 2 minutes

function generateSubAgentCaptchaCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Public: get a new CAPTCHA for sub-agent registration form (WordPress)
app.get(
  "/api/captcha/sub-agent",
  (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
  },
  (req, res) => {
    const id = `sa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const code = generateSubAgentCaptchaCode();
    subAgentCaptchaStore.set(id, {
      code,
      expires: Date.now() + CAPTCHA_TTL_MS,
    });
    // Clean old entries
    for (const [k, v] of subAgentCaptchaStore.entries()) {
      if (v.expires < Date.now()) subAgentCaptchaStore.delete(k);
    }
    res.json({ id, code });
  },
);

app.options("/api/sub-agent-registrations/public", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Public: create sub-agent registration from WordPress form (with CAPTCHA + terms)
app.post(
  "/api/sub-agent-registrations/public",
  setCorsHeaders,
  async (req, res) => {
    try {
      const {
        captcha_id,
        captcha_value,
        terms_accepted,
        company_name,
        pan_number,
        do_not_have_pan,
        package: pkg,
        first_name_middle,
        last_name,
        email,
        mobile,
        sales_in_charge_id,
        gst_number,
        gst_name,
        gst_address,
        street,
        pin_code,
        country,
        state,
        city,
      } = req.body;

      if (!captcha_id || !captcha_value) {
        return res.status(400).json({
          message:
            "CAPTCHA is required. Please complete the CAPTCHA and try again.",
        });
      }
      const stored = subAgentCaptchaStore.get(captcha_id);
      if (!stored) {
        return res.status(400).json({
          message:
            "CAPTCHA expired or invalid. Please refresh the page and try again.",
        });
      }
      if (stored.expires < Date.now()) {
        subAgentCaptchaStore.delete(captcha_id);
        return res.status(400).json({
          message: "CAPTCHA expired. Please refresh the page and try again.",
        });
      }
      if (String(captcha_value).trim().toUpperCase() !== stored.code) {
        return res.status(400).json({
          message: "CAPTCHA code does not match. Please try again.",
        });
      }
      subAgentCaptchaStore.delete(captcha_id);

      if (!terms_accepted) {
        return res.status(400).json({
          message:
            "You must accept the Terms and Conditions of the Service Agreement.",
        });
      }

      if (
        !company_name ||
        !first_name_middle ||
        !last_name ||
        !email ||
        !mobile ||
        !street ||
        !pin_code
      ) {
        return res.status(400).json({
          message:
            "Required fields: company_name, first_name_middle, last_name, email, mobile, street, pin_code.",
        });
      }

      const insertRow = {
        company_name,
        pan_number: pan_number || null,
        do_not_have_pan: Boolean(do_not_have_pan),
        package: pkg || "Monthly Package",
        first_name_middle,
        last_name,
        email,
        mobile,
        sales_in_charge_id: sales_in_charge_id
          ? parseInt(sales_in_charge_id, 10)
          : null,
        gst_number: gst_number || null,
        gst_name: gst_name || null,
        gst_address: gst_address || null,
        street,
        pin_code,
        country: country || "",
        state: state || "",
        city: city || "",
        terms_accepted: true,
        status: "Enquiry",
      };

      const { data: created, error } = await supabase
        .from("sub_agent_registrations")
        .insert(insertRow)
        .select()
        .single();

      if (error) throw error;

      // Notify CRM to refresh: broadcast so DataProvider can refetch (if Supabase Realtime broadcast from server is used)
      try {
        const channel = supabase.channel("crm-updates");
        await channel.send({
          type: "broadcast",
          event: "new-sub-agent-registration",
          payload: {},
        });
      } catch (broadcastErr) {
        // Ignore if broadcast not supported from server
      }

      res.status(201).json(created);
    } catch (error) {
      console.error("Error creating sub-agent registration (public):", error);
      res.status(500).json({
        message: error.message || "Failed to submit registration.",
      });
    }
  },
);

app.get("/api/sub-agent-registrations", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!hasSubAgentRegAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can view sub-agent registrations.",
      });
    }

    const { data: rows, error } = await supabase
      .from("sub_agent_registrations")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(rows || []);
  } catch (error) {
    console.error("Error fetching sub-agent registrations:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch sub-agent registrations.",
    });
  }
});

app.get("/api/sub-agent-registrations/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!hasSubAgentRegAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can view sub-agent registrations.",
      });
    }

    const { id } = req.params;
    const { data: row, error } = await supabase
      .from("sub_agent_registrations")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!row) {
      return res
        .status(404)
        .json({ message: "Sub-agent registration not found." });
    }
    res.json(row);
  } catch (error) {
    console.error("Error fetching sub-agent registration:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch sub-agent registration.",
    });
  }
});

app.post("/api/sub-agent-registrations", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!hasSubAgentRegAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can create sub-agent registrations.",
      });
    }

    const {
      company_name,
      pan_number,
      do_not_have_pan,
      package: pkg,
      first_name_middle,
      last_name,
      email,
      mobile,
      sales_in_charge_id,
      gst_number,
      gst_name,
      gst_address,
      street,
      pin_code,
      country,
      state,
      city,
      terms_accepted,
      status,
    } = req.body;

    if (
      !company_name ||
      !first_name_middle ||
      !last_name ||
      !email ||
      !mobile ||
      !street ||
      !pin_code
    ) {
      return res.status(400).json({
        message:
          "Required fields: company_name, first_name_middle, last_name, email, mobile, street, pin_code.",
      });
    }

    const insertRow = {
      company_name,
      pan_number: pan_number || null,
      do_not_have_pan: Boolean(do_not_have_pan),
      package: pkg || "Monthly Package",
      first_name_middle,
      last_name,
      email,
      mobile,
      sales_in_charge_id: sales_in_charge_id
        ? parseInt(sales_in_charge_id, 10)
        : null,
      gst_number: gst_number || null,
      gst_name: gst_name || null,
      gst_address: gst_address || null,
      street,
      pin_code,
      country: country || "",
      state: state || "",
      city: city || "",
      terms_accepted: Boolean(terms_accepted),
      status: status || "Enquiry",
    };

    const { data: created, error } = await supabase
      .from("sub_agent_registrations")
      .insert(insertRow)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(created);
  } catch (error) {
    console.error("Error creating sub-agent registration:", error);
    res.status(500).json({
      message: error.message || "Failed to create sub-agent registration.",
    });
  }
});

app.put("/api/sub-agent-registrations/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!hasSubAgentRegAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can update sub-agent registrations.",
      });
    }

    const { id } = req.params;
    const body = req.body;

    const allowed = [
      "company_name",
      "pan_number",
      "do_not_have_pan",
      "package",
      "first_name_middle",
      "last_name",
      "email",
      "mobile",
      "sales_in_charge_id",
      "gst_number",
      "gst_name",
      "gst_address",
      "street",
      "pin_code",
      "country",
      "state",
      "city",
      "terms_accepted",
      "status",
    ];
    const updateData = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        if (key === "do_not_have_pan" || key === "terms_accepted") {
          updateData[key] = Boolean(body[key]);
        } else if (key === "sales_in_charge_id") {
          updateData[key] = body[key] ? parseInt(body[key], 10) : null;
        } else {
          updateData[key] = body[key];
        }
      }
    }

    const { data: updated, error } = await supabase
      .from("sub_agent_registrations")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!updated) {
      return res
        .status(404)
        .json({ message: "Sub-agent registration not found." });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error updating sub-agent registration:", error);
    res.status(500).json({
      message: error.message || "Failed to update sub-agent registration.",
    });
  }
});

// Delete sub-agent registration (Super Admin only)
app.delete(
  "/api/sub-agent-registrations/:id",
  requireAuth,
  async (req, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role_id !== 1) {
        return res.status(403).json({
          message:
            "Access denied. Only Super Admin can delete sub-agent registrations.",
        });
      }

      const { id } = req.params;
      const { data: deleted, error } = await supabase
        .from("sub_agent_registrations")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!deleted) {
        return res
          .status(404)
          .json({ message: "Sub-agent registration not found." });
      }
      res.status(200).json(deleted);
    } catch (error) {
      console.error("Error deleting sub-agent registration:", error);
      res.status(500).json({
        message: error.message || "Failed to delete sub-agent registration.",
      });
    }
  },
);

// --- VISAS API ENDPOINTS ---

// Get all visas - ALL STAFF CAN VIEW
app.get("/api/visas", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view visas

    const { data: visas, error } = await supabase
      .from("visas")
      .select("*")
      .order("visa_name", { ascending: true });

    if (error) throw error;

    // Parse arrays - JSONB returns as arrays, but handle backward compatibility for TEXT columns
    const parsedVisas = (visas || []).map((visa) => {
      // If it's already an array (JSONB), use it directly
      // If it's a string (old TEXT format), parse or convert to array
      if (!Array.isArray(visa.visa_category)) {
        if (visa.visa_category && typeof visa.visa_category === "string") {
          try {
            visa.visa_category = JSON.parse(visa.visa_category);
          } catch (e) {
            // If not JSON, convert single value to array
            visa.visa_category = visa.visa_category ? [visa.visa_category] : [];
          }
        } else {
          visa.visa_category = [];
        }
      }
      if (!Array.isArray(visa.visa_format)) {
        if (visa.visa_format && typeof visa.visa_format === "string") {
          try {
            visa.visa_format = JSON.parse(visa.visa_format);
          } catch (e) {
            // If not JSON, convert single value to array
            visa.visa_format = visa.visa_format ? [visa.visa_format] : [];
          }
        } else {
          visa.visa_format = [];
        }
      }
      return visa;
    });

    res.json(parsedVisas);
  } catch (error) {
    console.error("Error fetching visas:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch visas.",
    });
  }
});

// Download Excel template for bulk visa upload (MUST be before /api/visas/:id route)
app.get("/api/visas/template", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin and Lead Manager can download template
    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can download template.",
      });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Visa Template");

    // Define columns
    worksheet.columns = [
      { header: "Visa Name*", key: "visa_name", width: 30 },
      {
        header: "Maximum Processing Time",
        key: "maximum_processing_time",
        width: 25,
      },
      {
        header: "Duration of Stay (Length of Stay)",
        key: "duration_of_stay",
        width: 25,
      },
      { header: "Type of Visa", key: "type_of_visa", width: 20 },
      { header: "Visa Format", key: "visa_format", width: 25 },
      { header: "Entry Type", key: "entry_type", width: 20 },
      { header: "Validity Period", key: "validity_period", width: 15 },
      { header: "Cost (INR)", key: "cost", width: 12 },
      {
        header: "Documents Required (comma-separated)",
        key: "documents_required",
        width: 50,
      },
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // Add example row
    worksheet.addRow({
      visa_name: "Example: Tourist Visa for Sri Lanka",
      maximum_processing_time: "5-7 business days",
      duration_of_stay: "30 days",
      type_of_visa: "Tourist Visa",
      visa_format: "E-Visa",
      entry_type: "Single Entry",
      validity_period: "6 months",
      cost: 5000,
      documents_required: "Passport, Photo, Application Form, Bank Statement",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Visa_Bulk_Upload_Template.xlsx"',
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating template:", error);
    res.status(500).json({
      message: error.message || "Failed to generate template.",
    });
  }
});

// Get a single visa by ID
app.get("/api/visas/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view visas

    const { id } = req.params;
    const { data: visa, error } = await supabase
      .from("visas")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!visa) {
      return res.status(404).json({ message: "Visa not found." });
    }

    // Parse arrays - JSONB returns as arrays, but handle backward compatibility for TEXT columns
    if (!Array.isArray(visa.visa_category)) {
      if (visa.visa_category && typeof visa.visa_category === "string") {
        try {
          visa.visa_category = JSON.parse(visa.visa_category);
        } catch (e) {
          // If not JSON, convert single value to array
          visa.visa_category = visa.visa_category ? [visa.visa_category] : [];
        }
      } else {
        visa.visa_category = [];
      }
    }
    if (!Array.isArray(visa.visa_format)) {
      if (visa.visa_format && typeof visa.visa_format === "string") {
        try {
          visa.visa_format = JSON.parse(visa.visa_format);
        } catch (e) {
          // If not JSON, convert single value to array
          visa.visa_format = visa.visa_format ? [visa.visa_format] : [];
        }
      } else {
        visa.visa_format = [];
      }
    }

    res.json(visa);
  } catch (error) {
    console.error("Error fetching visa:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch visa.",
    });
  }
});

// Create a new visa - SUPER ADMIN & OFFICE ADMIN ONLY
app.post("/api/visas", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin and Lead Manager can create visas
    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can create visas.",
      });
    }

    const {
      visa_name,
      duration_of_stay,
      type_of_visa,
      visa_category,
      visa_format,
      validity_period,
      cost,
      documents_required,
    } = req.body;

    if (!visa_name || !visa_name.trim()) {
      return res.status(400).json({ message: "Visa name is required." });
    }

    // Handle arrays - convert to JSON if array, otherwise keep as is
    const visaCategoryValue = Array.isArray(visa_category)
      ? JSON.stringify(visa_category)
      : visa_category || null;
    const visaFormatValue = Array.isArray(visa_format)
      ? JSON.stringify(visa_format)
      : visa_format || null;

    const { data: newVisa, error } = await supabase
      .from("visas")
      .insert({
        visa_name: visa_name.trim(),
        maximum_processing_time: maximum_processing_time || "",
        duration_of_stay: duration_of_stay || "",
        type_of_visa: type_of_visa || "",
        visa_category: visaCategoryValue,
        visa_format: visaFormatValue,
        validity_period: validity_period || "",
        cost: cost || 0,
        documents_required: documents_required || "",
        created_by_staff_id: currentUser.id,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Visas] Visa created by ${currentUser.name}: ${visa_name}`);

    res.status(201).json({
      message: "Visa created successfully.",
      visa: newVisa,
    });
  } catch (error) {
    console.error("Error creating visa:", error);
    res.status(500).json({
      message: error.message || "Failed to create visa.",
    });
  }
});

// Update a visa - SUPER ADMIN & OFFICE ADMIN ONLY
app.put("/api/visas/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin and Lead Manager can update visas
    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can update visas.",
      });
    }

    const { id } = req.params;
    const {
      visa_name,
      maximum_processing_time,
      duration_of_stay,
      type_of_visa,
      visa_category,
      visa_format,
      validity_period,
      cost,
      documents_required,
    } = req.body;

    // Get current visa
    const { data: currentVisa, error: fetchError } = await supabase
      .from("visas")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;
    if (!currentVisa) {
      return res.status(404).json({ message: "Visa not found." });
    }

    // Build update object
    const updateData = {
      updated_at: new Date().toISOString(),
      updated_by_staff_id: currentUser.id,
    };

    if (visa_name !== undefined) updateData.visa_name = visa_name.trim();
    if (maximum_processing_time !== undefined)
      updateData.maximum_processing_time = maximum_processing_time;
    if (duration_of_stay !== undefined)
      updateData.duration_of_stay = duration_of_stay;
    if (type_of_visa !== undefined) updateData.type_of_visa = type_of_visa;
    if (visa_category !== undefined) {
      // Handle arrays - JSONB accepts arrays directly
      // Supabase will handle JSONB conversion automatically
      updateData.visa_category = Array.isArray(visa_category)
        ? visa_category
        : visa_category
          ? [visa_category]
          : null;
    }
    if (visa_format !== undefined) {
      // Handle arrays - JSONB accepts arrays directly
      // Supabase will handle JSONB conversion automatically
      updateData.visa_format = Array.isArray(visa_format)
        ? visa_format
        : visa_format
          ? [visa_format]
          : null;
    }
    if (validity_period !== undefined)
      updateData.validity_period = validity_period;
    if (cost !== undefined) updateData.cost = cost;
    if (documents_required !== undefined)
      updateData.documents_required = documents_required;

    const { data: updatedVisa, error: updateError } = await supabase
      .from("visas")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Parse arrays - JSONB returns as arrays, but handle backward compatibility for TEXT columns
    if (!Array.isArray(updatedVisa.visa_category)) {
      if (
        updatedVisa.visa_category &&
        typeof updatedVisa.visa_category === "string"
      ) {
        try {
          updatedVisa.visa_category = JSON.parse(updatedVisa.visa_category);
        } catch (e) {
          // If not JSON, convert single value to array
          updatedVisa.visa_category = updatedVisa.visa_category
            ? [updatedVisa.visa_category]
            : [];
        }
      } else {
        updatedVisa.visa_category = [];
      }
    }
    if (!Array.isArray(updatedVisa.visa_format)) {
      if (
        updatedVisa.visa_format &&
        typeof updatedVisa.visa_format === "string"
      ) {
        try {
          updatedVisa.visa_format = JSON.parse(updatedVisa.visa_format);
        } catch (e) {
          // If not JSON, convert single value to array
          updatedVisa.visa_format = updatedVisa.visa_format
            ? [updatedVisa.visa_format]
            : [];
        }
      } else {
        updatedVisa.visa_format = [];
      }
    }

    console.log(`[Visas] Visa ${id} updated by ${currentUser.name}`);

    res.json({
      message: "Visa updated successfully.",
      visa: updatedVisa,
    });
  } catch (error) {
    console.error("Error updating visa:", error);
    res.status(500).json({
      message: error.message || "Failed to update visa.",
    });
  }
});

// Delete a visa (Super Admin only)
app.delete("/api/visas/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can delete
    if (currentUser.role_id !== 1) {
      return res.status(403).json({
        message: "Access denied. Only Super Admin can delete visas.",
      });
    }

    const { id } = req.params;

    const { error: deleteError } = await supabase
      .from("visas")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    console.log(`[Visas] Visa ${id} deleted by ${currentUser.name}`);

    res.json({ message: "Visa deleted successfully." });
  } catch (error) {
    console.error("Error deleting visa:", error);
    res.status(500).json({
      message: error.message || "Failed to delete visa.",
    });
  }
});

// Bulk upload visas from Excel file
const visaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".xlsx") ||
      file.originalname.endsWith(".xls")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files (.xlsx, .xls) are allowed"), false);
    }
  },
});

app.post(
  "/api/visas/bulk-upload",
  requireAuth,
  visaUpload.single("file"),
  async (req, res) => {
    try {
      const currentUser = req.user;

      // Only Super Admin and Lead Manager can bulk upload
      if (!checkDestinationsEditAccess(currentUser)) {
        return res.status(403).json({
          message:
            "Access denied. Only Super Admin and Lead Manager can bulk upload visas.",
        });
      }

      // Handle multer errors
      if (req.fileValidationError) {
        console.error(
          "[Visas Bulk Upload] File validation error:",
          req.fileValidationError,
        );
        return res.status(400).json({ message: req.fileValidationError });
      }

      if (!req.file) {
        console.error("[Visas Bulk Upload] No file in request");
        return res.status(400).json({ message: "No file uploaded." });
      }

      console.log(
        `[Visas Bulk Upload] File received: ${req.file.originalname}, size: ${req.file.size} bytes, mimetype: ${req.file.mimetype}`,
      );

      let workbook;
      try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
      } catch (error) {
        console.error("[Visas Bulk Upload] Error loading Excel file:", error);
        return res.status(400).json({
          message: `Failed to parse Excel file: ${error.message}`,
        });
      }

      const worksheet = workbook.getWorksheet(1); // Get first worksheet
      if (!worksheet) {
        return res.status(400).json({ message: "Excel file is empty." });
      }

      console.log(
        `[Visas Bulk Upload] Worksheet found: ${worksheet.name}, row count: ${worksheet.rowCount}`,
      );

      const rows = [];
      const headers = {};

      // First, get all headers from row 1
      worksheet.getRow(1).eachCell((cell, colNumber) => {
        const headerValue = cell.value;
        if (headerValue) {
          headers[colNumber] = headerValue.toString().trim();
        }
      });

      console.log(`[Visas Bulk Upload] Headers found:`, Object.values(headers));

      // Then process data rows
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row

        const rowData = {};
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber];
          if (header) {
            rowData[header] = cell.value;
          }
        });

        if (Object.keys(rowData).length > 0) {
          rows.push(rowData);
        }
      });

      console.log(`[Visas Bulk Upload] Parsed ${rows.length} data rows`);

      if (rows.length === 0) {
        return res.status(400).json({
          message: "No data rows found in Excel file.",
        });
      }

      const results = {
        success: 0,
        errors: [],
      };

      // Process each row
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2; // +2 because we skip header and 0-indexed

        try {
          // Map Excel columns to database fields
          // Be tolerant of Excel-exported header variants (e.g. formulas or merged cells that append ranges)
          let visaName = row["Visa Name*"] || row["Visa Name"];
          if (!visaName) {
            const visaNameKey = Object.keys(row).find((k) =>
              k.toString().toLowerCase().startsWith("visa name"),
            );
            if (visaNameKey) {
              visaName = row[visaNameKey];
            }
          }
          if (!visaName || !visaName.toString().trim()) {
            results.errors.push({
              row: rowNumber,
              error: "Visa Name is required",
              data: row,
            });
            continue;
          }

          // Parse Maximum Processing Time
          const maximumProcessingTime = row["Maximum Processing Time"] || "";

          // Parse Duration of Stay (Length of Stay)
          const durationOfStay =
            row["Duration of Stay (Length of Stay)"] ||
            row["Duration of Stay"] ||
            row["Length of Stay"] ||
            "";

          // Parse Visa Format (can be comma-separated or single value)
          const visaFormatValue = row["Visa Format"] || "";
          const visaFormatArray = visaFormatValue
            ? visaFormatValue
                .toString()
                .split(",")
                .map((f) => f.trim())
                .filter((f) => f.length > 0)
            : [];

          // Parse Entry Type
          const entryType = row["Entry Type"] || "";

          // Parse Documents Required (comma-separated) and convert to bullet points
          const documentsRequiredRaw =
            row["Documents Required (comma-separated)"] ||
            row["Documents Required"] ||
            "";
          let documentsRequired = "";
          if (documentsRequiredRaw) {
            const documents = documentsRequiredRaw
              .toString()
              .split(",")
              .map((d) => d.trim())
              .filter((d) => d.length > 0);
            // Convert to bullet points format
            documentsRequired = documents.map((doc) => `• ${doc}`).join("\n");
          }

          // Parse cost
          let cost = 0;
          const costValue = row["Cost (INR)"] || row["Cost"];
          if (costValue) {
            const parsedCost = parseFloat(
              costValue.toString().replace(/[^0-9.]/g, ""),
            );
            if (!isNaN(parsedCost)) {
              cost = parsedCost;
            }
          }

          // Build visa_requirements with Entry Type if provided
          let visaRequirements = "";
          if (entryType) {
            visaRequirements = `Entry Type: ${entryType.toString().trim()}`;
          }

          const typeOfVisaText = (row["Type of Visa"] || "").toString().trim();

          const visaData = {
            visa_name: visaName.toString().trim(),
            maximum_processing_time: maximumProcessingTime.toString().trim(),
            duration_of_stay: durationOfStay.toString().trim(),
            type_of_visa: typeOfVisaText,
            // Initialize visa_category from the same Excel "Type of Visa" value so list chips are populated
            visa_category: typeOfVisaText ? [typeOfVisaText] : null,
            visa_format: visaFormatArray.length > 0 ? visaFormatArray : null,
            validity_period: (row["Validity Period"] || "").toString().trim(),
            cost: cost,
            documents_required: documentsRequired,
            created_by_staff_id: currentUser.id,
            created_at: new Date().toISOString(),
          };

          const { data: newVisa, error } = await supabase
            .from("visas")
            .insert(visaData)
            .select()
            .single();

          if (error) {
            results.errors.push({
              row: rowNumber,
              error: error.message,
              data: row,
            });
          } else {
            results.success++;
            console.log(
              `[Visas] Visa created via bulk upload by ${currentUser.name}: ${visaData.visa_name}`,
            );
          }
        } catch (error) {
          results.errors.push({
            row: rowNumber,
            error: error.message || "Unknown error",
            data: row,
          });
        }
      }

      console.log(
        `[Visas Bulk Upload] Processing complete. Success: ${results.success}, Errors: ${results.errors.length}`,
      );
      if (results.errors.length > 0) {
        console.log(
          `[Visas Bulk Upload] Error details:`,
          JSON.stringify(results.errors, null, 2),
        );
      }

      res.json({
        message: `Upload complete. ${results.success} visa(s) created successfully.`,
        success: results.success,
        errors: results.errors,
      });
    } catch (error) {
      console.error("[Visas Bulk Upload] Error bulk uploading visas:", error);
      console.error("[Visas Bulk Upload] Error stack:", error.stack);
      res.status(500).json({
        message: error.message || "Failed to bulk upload visas.",
      });
    }
  },
);

// --- DESTINATIONS & SIGHTSEEING API ENDPOINTS ---

// Helper function to generate slug from name
const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

// Check if user can EDIT destinations/attractions (Super Admin or Lead Manager tag)
const checkDestinationsEditAccess = (currentUser) => {
  return currentUser.role_id === 1 || currentUser.is_lead_manager === true;
};

// All staff can VIEW destinations/attractions, but only Super Admin & Lead Manager can EDIT
const checkDestinationsAccess = (currentUser) => {
  // This function is kept for backward compatibility but now only checks edit access
  // View access is allowed for all authenticated users
  return checkDestinationsEditAccess(currentUser);
};

// Get all destinations - ALL STAFF CAN VIEW
app.get("/api/destinations", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view destinations

    const { data: destinations, error } = await supabase
      .from("destinations")
      .select("*")
      .order("name", { ascending: true });

    if (error) throw error;

    res.json(destinations || []);
  } catch (error) {
    console.error("Error fetching destinations:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch destinations.",
    });
  }
});

// Get a single destination by ID or slug
app.get("/api/destinations/:identifier", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view destinations

    const { identifier } = req.params;
    const isNumeric = /^\d+$/.test(identifier);

    let query = supabase.from("destinations").select("*");

    if (isNumeric) {
      query = query.eq("id", parseInt(identifier));
    } else {
      query = query.eq("slug", identifier);
    }

    const { data: destination, error } = await query.single();

    if (error) throw error;
    if (!destination) {
      return res.status(404).json({ message: "Destination not found." });
    }

    res.json(destination);
  } catch (error) {
    console.error("Error fetching destination:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch destination.",
    });
  }
});

// Create a new destination - EDIT ACCESS REQUIRED
app.post("/api/destinations", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can create destinations.",
      });
    }

    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Destination name is required." });
    }

    const slug = generateSlug(name.trim());

    // Check if slug already exists
    const { data: existing } = await supabase
      .from("destinations")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existing) {
      return res
        .status(400)
        .json({ message: "A destination with this name already exists." });
    }

    const { data: newDestination, error } = await supabase
      .from("destinations")
      .insert({
        name: name.trim(),
        slug: slug,
        created_by_staff_id: currentUser.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    console.log(
      `[Destinations] Destination created by ${currentUser.name}: ${name}`,
    );

    res.status(201).json({
      message: "Destination created successfully.",
      destination: newDestination,
    });
  } catch (error) {
    console.error("Error creating destination:", error);
    res.status(500).json({
      message: error.message || "Failed to create destination.",
    });
  }
});

// Update a destination - EDIT ACCESS REQUIRED
app.put("/api/destinations/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can update destinations.",
      });
    }

    const { id } = req.params;
    const { name } = req.body;

    // Get current destination
    const { data: currentDestination, error: fetchError } = await supabase
      .from("destinations")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;
    if (!currentDestination) {
      return res.status(404).json({ message: "Destination not found." });
    }

    const updateData = {
      updated_at: new Date().toISOString(),
      updated_by_staff_id: currentUser.id,
    };

    if (name !== undefined && name.trim() !== currentDestination.name) {
      updateData.name = name.trim();
      const newSlug = generateSlug(name.trim());

      // Check if new slug already exists (excluding current destination)
      const { data: existing } = await supabase
        .from("destinations")
        .select("id")
        .eq("slug", newSlug)
        .neq("id", id)
        .single();

      if (existing) {
        return res
          .status(400)
          .json({ message: "A destination with this name already exists." });
      }

      updateData.slug = newSlug;
    }

    const { data: updatedDestination, error } = await supabase
      .from("destinations")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    console.log(
      `[Destinations] Destination ${id} updated by ${currentUser.name}`,
    );

    res.json({
      message: "Destination updated successfully.",
      destination: updatedDestination,
    });
  } catch (error) {
    console.error("Error updating destination:", error);
    res.status(500).json({
      message: error.message || "Failed to update destination.",
    });
  }
});

// Delete a destination - SUPER ADMIN ONLY
app.delete("/api/destinations/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can delete
    if (currentUser.role_id !== 1) {
      return res.status(403).json({
        message: "Access denied. Only Super Admin can delete destinations.",
      });
    }

    const { id } = req.params;

    const { error: deleteError } = await supabase
      .from("destinations")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    console.log(
      `[Destinations] Destination ${id} deleted by ${currentUser.name}`,
    );

    res.json({ message: "Destination deleted successfully." });
  } catch (error) {
    console.error("Error deleting destination:", error);
    res.status(500).json({
      message: error.message || "Failed to delete destination.",
    });
  }
});

// --- SIGHTSEEING (ATTRACTIONS) API ENDPOINTS ---

// Get all sightseeing (with optional destination filter) - ALL STAFF CAN VIEW
app.get("/api/sightseeing", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view sightseeing

    const { destination_id } = req.query;
    let query = supabase
      .from("sightseeing")
      .select("*, destinations(id, name, slug)")
      .order("attraction_name", { ascending: true });

    if (destination_id) {
      query = query.eq("destination_id", parseInt(destination_id));
    }

    const { data: sightseeing, error } = await query;

    if (error) {
      console.error("[Sightseeing API] Query error:", error);
      throw error;
    }

    // Log for debugging - check if data is being returned
    console.log(
      `[Sightseeing API] Returning ${
        sightseeing?.length || 0
      } attractions for user ${currentUser.name} (Role: ${currentUser.role})`,
    );

    res.json(sightseeing || []);
  } catch (error) {
    console.error("Error fetching sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch sightseeing.",
    });
  }
});

// Get a single sightseeing item by ID - ALL STAFF CAN VIEW
app.get("/api/sightseeing/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view sightseeing

    const { id } = req.params;
    const { data: sightseeing, error } = await supabase
      .from("sightseeing")
      .select("*, destinations(id, name, slug)")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!sightseeing) {
      return res.status(404).json({ message: "Sightseeing item not found." });
    }

    res.json(sightseeing);
  } catch (error) {
    console.error("Error fetching sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch sightseeing.",
    });
  }
});

// Create a new sightseeing item - EDIT ACCESS REQUIRED
app.post("/api/sightseeing", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can create sightseeing.",
      });
    }

    const {
      destination_id,
      attraction_name,
      per_adult_cost,
      per_child_cost,
      remarks,
    } = req.body;

    if (!destination_id) {
      return res.status(400).json({ message: "Destination ID is required." });
    }
    if (!attraction_name || !attraction_name.trim()) {
      return res.status(400).json({ message: "Attraction name is required." });
    }

    // Verify destination exists
    const { data: destination, error: destError } = await supabase
      .from("destinations")
      .select("id")
      .eq("id", destination_id)
      .single();

    if (destError || !destination) {
      return res.status(400).json({ message: "Invalid destination ID." });
    }

    const { data: newSightseeing, error } = await supabase
      .from("sightseeing")
      .insert({
        destination_id: parseInt(destination_id),
        attraction_name: attraction_name.trim(),
        per_adult_cost: per_adult_cost ? parseFloat(per_adult_cost) : 0,
        per_child_cost: per_child_cost ? parseFloat(per_child_cost) : 0,
        currency: currency || "USD",
        remarks: remarks || "",
        created_by_staff_id: currentUser.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*, destinations(id, name, slug)")
      .single();

    if (error) throw error;

    console.log(
      `[Sightseeing] Attraction created by ${currentUser.name}: ${attraction_name}`,
    );

    res.status(201).json({
      message: "Sightseeing item created successfully.",
      sightseeing: newSightseeing,
    });
  } catch (error) {
    console.error("Error creating sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to create sightseeing item.",
    });
  }
});

// Update a sightseeing item - EDIT ACCESS REQUIRED
app.put("/api/sightseeing/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can update sightseeing.",
      });
    }

    const { id } = req.params;
    const {
      destination_id,
      attraction_name,
      per_adult_cost,
      per_child_cost,
      currency,
      remarks,
      tag,
      opening_hours,
      average_duration_hours,
      latitude,
      longitude,
      category,
      best_time,
      images,
      pricing,
    } = req.body;

    // Get current sightseeing item
    const { data: currentSightseeing, error: fetchError } = await supabase
      .from("sightseeing")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;
    if (!currentSightseeing) {
      return res.status(404).json({ message: "Sightseeing item not found." });
    }

    const updateData = {
      updated_at: new Date().toISOString(),
      updated_by_staff_id: currentUser.id,
    };

    if (destination_id !== undefined) {
      // Verify destination exists
      const { data: destination, error: destError } = await supabase
        .from("destinations")
        .select("id")
        .eq("id", destination_id)
        .single();

      if (destError || !destination) {
        return res.status(400).json({ message: "Invalid destination ID." });
      }
      updateData.destination_id = parseInt(destination_id);
    }
    if (attraction_name !== undefined)
      updateData.attraction_name = attraction_name.trim();
    if (per_adult_cost !== undefined)
      updateData.per_adult_cost = parseFloat(per_adult_cost) || 0;
    if (per_child_cost !== undefined)
      updateData.per_child_cost = parseFloat(per_child_cost) || 0;
    if (currency !== undefined) updateData.currency = currency || "USD";
    if (remarks !== undefined) updateData.remarks = remarks;
    if (tag !== undefined) updateData.tag = tag || null;
    if (opening_hours !== undefined)
      updateData.opening_hours = opening_hours || null;
    if (average_duration_hours !== undefined)
      updateData.average_duration_hours = average_duration_hours
        ? parseFloat(average_duration_hours)
        : null;
    if (latitude !== undefined)
      updateData.latitude = latitude ? parseFloat(latitude) : null;
    if (longitude !== undefined)
      updateData.longitude = longitude ? parseFloat(longitude) : null;
    if (category !== undefined) updateData.category = category || null;
    if (best_time !== undefined) updateData.best_time = best_time || null;
    if (images !== undefined)
      updateData.images = images && Array.isArray(images) ? images : null;
    // Note: pricing column removed - it doesn't exist in the database schema
    // if (pricing !== undefined) updateData.pricing = pricing || null;

    const { data: updatedSightseeing, error } = await supabase
      .from("sightseeing")
      .update(updateData)
      .eq("id", id)
      .select("*, destinations(id, name, slug)")
      .single();

    if (error) throw error;

    console.log(
      `[Sightseeing] Attraction ${id} updated by ${currentUser.name}`,
    );

    res.json({
      message: "Sightseeing item updated successfully.",
      sightseeing: updatedSightseeing,
    });
  } catch (error) {
    console.error("Error updating sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to update sightseeing item.",
    });
  }
});

// Delete a sightseeing item - SUPER ADMIN ONLY
app.delete("/api/sightseeing/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can delete
    if (currentUser.role_id !== 1) {
      return res.status(403).json({
        message: "Access denied. Only Super Admin can delete sightseeing.",
      });
    }

    const { id } = req.params;

    const { error: deleteError } = await supabase
      .from("sightseeing")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    console.log(
      `[Sightseeing] Attraction ${id} deleted by ${currentUser.name}`,
    );

    res.json({ message: "Sightseeing item deleted successfully." });
  } catch (error) {
    console.error("Error deleting sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to delete sightseeing item.",
    });
  }
});

// Bulk create sightseeing items from Excel
app.post("/api/sightseeing/bulk-create", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can bulk create sightseeing items.",
      });
    }

    const { attractions } = req.body;

    if (!Array.isArray(attractions) || attractions.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one attraction is required." });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    // Insert attractions one by one to handle errors gracefully
    for (const attraction of attractions) {
      try {
        // Validate required fields
        if (!attraction.attraction_name || !attraction.destination_id) {
          failedCount++;
          errors.push(
            `Skipped: Missing required fields for "${
              attraction.attraction_name || "unknown"
            }"`,
          );
          continue;
        }

        // Prepare data
        const sightseeingData = {
          destination_id: parseInt(attraction.destination_id),
          attraction_name: String(attraction.attraction_name).trim(),
          per_adult_cost: parseFloat(attraction.per_adult_cost) || 0,
          per_child_cost: parseFloat(attraction.per_child_cost) || 0,
          currency: attraction.currency || "USD",
          remarks: String(attraction.remarks || "").trim(),
          created_by_staff_id: currentUser.id,
          updated_by_staff_id: currentUser.id,
        };

        // Insert into database
        const { data, error } = await supabase
          .from("sightseeing")
          .insert([sightseeingData])
          .select()
          .single();

        if (error) {
          failedCount++;
          errors.push(
            `Failed to create "${attraction.attraction_name}": ${error.message}`,
          );
        } else {
          successCount++;
        }
      } catch (error) {
        failedCount++;
        errors.push(
          `Error creating "${attraction.attraction_name}": ${error.message}`,
        );
      }
    }

    console.log(
      `[Sightseeing] Bulk create by ${currentUser.name}: ${successCount} successful, ${failedCount} failed out of ${attractions.length} items`,
    );

    res.json({
      message: `Successfully created ${successCount} attraction(s). ${
        failedCount > 0 ? `${failedCount} failed.` : ""
      }`,
      success: successCount,
      failed: failedCount,
      total: attractions.length,
      errors: failedCount > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error bulk creating sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to bulk create sightseeing items.",
    });
  }
});

// Bulk delete sightseeing items - SUPER ADMIN ONLY
app.post("/api/sightseeing/bulk-delete", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can bulk delete
    if (currentUser.role_id !== 1) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin can bulk delete sightseeing items.",
      });
    }

    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one sightseeing item ID is required." });
    }

    let deletedCount = 0;
    let failedCount = 0;
    const errors = [];

    // Delete attractions one by one to handle errors gracefully
    for (const id of ids) {
      try {
        const { error } = await supabase
          .from("sightseeing")
          .delete()
          .eq("id", id);

        if (error) {
          failedCount++;
          errors.push(`Failed to delete attraction ID ${id}: ${error.message}`);
        } else {
          deletedCount++;
        }
      } catch (error) {
        failedCount++;
        errors.push(`Error deleting attraction ID ${id}: ${error.message}`);
      }
    }

    console.log(
      `[Sightseeing] Bulk delete by ${currentUser.name}: ${deletedCount} deleted, ${failedCount} failed out of ${ids.length} items`,
    );

    res.json({
      message: `Successfully deleted ${deletedCount} attraction(s). ${
        failedCount > 0 ? `${failedCount} failed.` : ""
      }`,
      deleted_count: deletedCount,
      failed: failedCount,
      total: ids.length,
      errors: failedCount > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error bulk deleting sightseeing:", error);
    res.status(500).json({
      message: error.message || "Failed to bulk delete sightseeing items.",
    });
  }
});

// Bulk update prices for sightseeing items
app.post(
  "/api/sightseeing/bulk-update-prices",
  requireAuth,
  async (req, res) => {
    try {
      const currentUser = req.user;

      if (!checkDestinationsEditAccess(currentUser)) {
        return res.status(403).json({
          message:
            "Access denied. Only Super Admin and Lead Manager can bulk update prices.",
        });
      }

      const { ids, percentage, operation } = req.body; // operation: 'increase' or 'decrease'

      if (!Array.isArray(ids) || ids.length === 0) {
        return res
          .status(400)
          .json({ message: "At least one sightseeing item ID is required." });
      }
      if (!percentage || percentage <= 0) {
        return res
          .status(400)
          .json({ message: "Valid percentage is required." });
      }
      if (!operation || !["increase", "decrease"].includes(operation)) {
        return res
          .status(400)
          .json({ message: "Operation must be 'increase' or 'decrease'." });
      }

      // Get current items
      const { data: items, error: fetchError } = await supabase
        .from("sightseeing")
        .select("id, per_adult_cost, per_child_cost")
        .in("id", ids);

      if (fetchError) throw fetchError;

      const multiplier =
        operation === "increase" ? 1 + percentage / 100 : 1 - percentage / 100;

      // Update each item
      const updates = items.map((item) => ({
        id: item.id,
        per_adult_cost:
          Math.round(item.per_adult_cost * multiplier * 100) / 100,
        per_child_cost:
          Math.round(item.per_child_cost * multiplier * 100) / 100,
        updated_at: new Date().toISOString(),
        updated_by_staff_id: currentUser.id,
      }));

      // Perform bulk update
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from("sightseeing")
          .update({
            per_adult_cost: update.per_adult_cost,
            per_child_cost: update.per_child_cost,
            updated_at: update.updated_at,
            updated_by_staff_id: update.updated_by_staff_id,
          })
          .eq("id", update.id);

        if (updateError) throw updateError;
      }

      console.log(
        `[Sightseeing] Bulk price update by ${currentUser.name}: ${operation} ${percentage}% for ${ids.length} items`,
      );

      res.json({
        message: `Successfully ${
          operation === "increase" ? "increased" : "decreased"
        } prices by ${percentage}% for ${ids.length} items.`,
        updated_count: ids.length,
      });
    } catch (error) {
      console.error("Error bulk updating prices:", error);
      res.status(500).json({
        message: error.message || "Failed to bulk update prices.",
      });
    }
  },
);

// Bulk update currency for sightseeing items
app.post(
  "/api/sightseeing/bulk-update-currency",
  requireAuth,
  async (req, res) => {
    try {
      const currentUser = req.user;

      if (!checkDestinationsEditAccess(currentUser)) {
        return res.status(403).json({
          message:
            "Access denied. Only Super Admin and Lead Manager can bulk update currency.",
        });
      }

      const { ids, currency } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res
          .status(400)
          .json({ message: "At least one sightseeing item ID is required." });
      }
      if (!currency || typeof currency !== "string") {
        return res.status(400).json({ message: "Valid currency is required." });
      }

      // Valid currency check
      const validCurrencies = [
        "INR",
        "USD",
        "EUR",
        "GBP",
        "AUD",
        "CAD",
        "SGD",
        "JPY",
        "CHF",
        "CNY",
        "NZD",
      ];
      if (!validCurrencies.includes(currency)) {
        return res.status(400).json({
          message: `Invalid currency. Must be one of: ${validCurrencies.join(
            ", ",
          )}`,
        });
      }

      // Get current items with their prices and currencies
      const { data: items, error: fetchError } = await supabase
        .from("sightseeing")
        .select("id, per_adult_cost, per_child_cost, currency")
        .in("id", ids);

      if (fetchError) throw fetchError;

      // Fetch FX rates from API
      let fxRates = {};
      try {
        const fxResponse = await fetch(
          "https://api.frankfurter.app/latest?from=INR",
        );
        if (fxResponse.ok) {
          const fxData = await fxResponse.json();
          // Invert rates: API returns FROM INR, we need TO INR
          if (fxData.rates) {
            Object.keys(fxData.rates).forEach((curr) => {
              const rateFromInr = fxData.rates[curr];
              if (rateFromInr > 0 && rateFromInr < 1) {
                fxRates[curr] = 1 / rateFromInr; // Convert to TO INR rate
              } else if (rateFromInr >= 1) {
                fxRates[curr] = rateFromInr; // Already TO INR
              }
            });
          }
          fxRates["INR"] = 1;
        }
      } catch (fxError) {
        console.error("Error fetching FX rates:", fxError);
        // Fallback to static rates if API fails
        fxRates = {
          INR: 1,
          USD: 83.0,
          EUR: 90.0,
          GBP: 105.0,
          AUD: 54.0,
          CAD: 61.0,
          SGD: 61.5,
          JPY: 0.56,
          CHF: 95.0,
          CNY: 11.5,
          NZD: 50.0,
        };
      }

      // Convert prices for each item
      const updates = items.map((item) => {
        const oldCurrency = item.currency || "USD";
        const newCurrency = currency;

        // Get FX rates: convert FROM old currency TO INR, then FROM INR TO new currency
        const rateFromOldToInr =
          fxRates[oldCurrency] || (oldCurrency === "INR" ? 1 : 83.0);
        const rateFromInrToNew =
          fxRates[newCurrency] || (newCurrency === "INR" ? 1 : 83.0);

        // Calculate conversion rate: old currency -> INR -> new currency
        // If converting USD to EUR: USD -> INR -> EUR
        // Rate = (1 USD = X INR) / (1 EUR = Y INR) = X / Y
        const conversionRate = rateFromOldToInr / rateFromInrToNew;

        // Convert base prices using the conversion rate
        // Note: Markup formula ((price × FX_rate) + 2) × 1.15 is applied at calculation time in itinerary costing
        // Here we only convert the base price using FX rate
        const newAdultPrice =
          Math.round((item.per_adult_cost || 0) * conversionRate * 100) / 100;
        const newChildPrice =
          Math.round((item.per_child_cost || 0) * conversionRate * 100) / 100;

        // Prepare update object - only update legacy fields that exist in the database
        return {
          id: item.id,
          currency: newCurrency,
          per_adult_cost: newAdultPrice,
          per_child_cost: newChildPrice,
          updated_at: new Date().toISOString(),
          updated_by_staff_id: currentUser.id,
        };
      });

      // Perform bulk update - only update columns that exist in the database
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from("sightseeing")
          .update({
            currency: update.currency,
            per_adult_cost: update.per_adult_cost,
            per_child_cost: update.per_child_cost,
            updated_at: update.updated_at,
            updated_by_staff_id: update.updated_by_staff_id,
          })
          .eq("id", update.id);

        if (updateError) throw updateError;
      }

      console.log(
        `[Sightseeing] Bulk currency update by ${currentUser.name}: Changed to ${currency} for ${ids.length} items`,
      );

      res.json({
        message: `Successfully updated currency to ${currency} for ${ids.length} items.`,
        updated_count: ids.length,
      });
    } catch (error) {
      console.error("Error bulk updating currency:", error);
      res.status(500).json({
        message: error.message || "Failed to bulk update currency.",
      });
    }
  },
);

// Bulk generate attraction details using Google Places API
app.post("/api/sightseeing/generate-details", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can generate attraction details.",
      });
    }

    const { attractions } = req.body; // Array of { name: string, destination_name: string, destination_id: number }

    if (!Array.isArray(attractions) || attractions.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one attraction is required." });
    }

    const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
    if (!GOOGLE_PLACES_API_KEY) {
      return res.status(500).json({
        message: "Google Places API key is not configured.",
      });
    }

    const results = [];
    const errors = [];

    // Process attractions in batches to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < attractions.length; i += batchSize) {
      const batch = attractions.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (attraction) => {
          try {
            const { name, destination_name, destination_id } = attraction;

            if (!name) {
              const errorMsg = "Attraction name is required";
              console.error(
                `[Sightseeing AI] ${name || "Unknown"}: ${errorMsg}`,
              );
              errors.push({
                name: name || "Unknown",
                error: errorMsg,
                details: { destination_name, destination_id },
              });
              return;
            }

            // Parse attraction name to extract duration, time, and additional info
            let cleanedName = name;
            let extractedDuration = null;
            let extractedOpeningHours = null;
            let extractedRemarks = [];

            // Extract duration patterns: "2.5 Hours", "4 Hours", "2 Hours", "1 Hour", "30 Min", "45 Mins", etc.
            const durationPatterns = [
              /(\d+\.?\d*)\s*(?:Hours?|Hrs?|H)/i, // "2.5 Hours", "4 Hrs"
              /(\d+)\s*(?:Minutes?|Mins?|Min)/i, // "30 Minutes", "45 Mins"
            ];

            for (const pattern of durationPatterns) {
              const match = name.match(pattern);
              if (match) {
                let hours = parseFloat(match[1]);
                // Convert minutes to hours if needed
                if (pattern.toString().includes("Min")) {
                  hours = hours / 60;
                }
                extractedDuration = hours;
                // Remove the duration from the name
                cleanedName = cleanedName.replace(pattern, "").trim();
                break;
              }
            }

            // Extract time patterns: "6:15 PM Departure", "7:30pm Show", "10am", etc.
            const timePatterns = [
              /(\d{1,2}):(\d{2})\s*(AM|PM)\s*(?:Departure|Show|Start|Begin)/i, // "6:15 PM Departure", "7:30pm Show"
              /(\d{1,2}):(\d{2})\s*(AM|PM)/i, // "6:15 PM", "10:30 AM"
              /(\d{1,2})\s*(AM|PM)/i, // "6 PM", "10 AM"
            ];

            for (const pattern of timePatterns) {
              const match = name.match(pattern);
              if (match) {
                let hour = parseInt(match[1]);
                const minutes = match[2] ? parseInt(match[2]) : 0;
                const ampm = match[3] || match[2]; // Handle both formats

                // Convert to 24-hour format
                if (ampm && ampm.toUpperCase() === "PM" && hour !== 12) {
                  hour += 12;
                } else if (ampm && ampm.toUpperCase() === "AM" && hour === 12) {
                  hour = 0;
                }

                extractedOpeningHours = `${String(hour).padStart(
                  2,
                  "0",
                )}:${String(minutes).padStart(2, "0")}`;
                // Remove the time from the name
                cleanedName = cleanedName.replace(pattern, "").trim();
                break;
              }
            }

            // Extract parenthetical information for remarks
            const parenthesesPattern = /\(([^)]+)\)/g;
            const parenthesesMatches = [];
            let parenMatch;
            while ((parenMatch = parenthesesPattern.exec(name)) !== null) {
              parenthesesMatches.push(parenMatch[1]);
            }

            // Clean up the name by removing parentheses and extra spaces
            cleanedName = cleanedName.replace(/\([^)]+\)/g, "").trim();
            cleanedName = cleanedName.replace(/\s+/g, " ").trim();

            // Add parenthetical info to remarks (except if it's just time/duration which we already extracted)
            for (const parenInfo of parenthesesMatches) {
              // Skip if it's just a time pattern or duration we already extracted
              if (
                !parenInfo.match(/(\d+\.?\d*)\s*(?:Hours?|Hrs?|H)/i) &&
                !parenInfo.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i) &&
                !parenInfo.match(/(\d{1,2})\s*(AM|PM)/i)
              ) {
                extractedRemarks.push(parenInfo);
              }
            }

            // Step 1: Text Search using Places API (New) - use cleaned name for better search
            const searchQuery = `${cleanedName} ${
              destination_name || ""
            }`.trim();
            const searchUrl = `https://places.googleapis.com/v1/places:searchText`;

            console.log(
              `[Sightseeing AI] Searching for: "${searchQuery}" (Attraction: ${name}, Destination: ${
                destination_name || "N/A"
              })`,
            );

            // Log extracted information
            if (
              extractedDuration ||
              extractedOpeningHours ||
              extractedRemarks.length > 0
            ) {
              console.log(`[Sightseeing AI] Extracted from name "${name}":`, {
                cleanedName,
                extractedDuration,
                extractedOpeningHours,
                extractedRemarks:
                  extractedRemarks.length > 0 ? extractedRemarks : null,
              });
            }

            const searchResponse = await fetch(searchUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
                "X-Goog-FieldMask":
                  "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos",
              },
              body: JSON.stringify({
                textQuery: searchQuery,
                maxResultCount: 1,
              }),
            });

            if (!searchResponse.ok) {
              const errorText = await searchResponse.text();
              let errorData;
              try {
                errorData = JSON.parse(errorText);
              } catch {
                errorData = { error: { message: errorText } };
              }
              const errorMsg = `Place search failed: ${searchResponse.status}${
                errorData.error?.message ? ` - ${errorData.error.message}` : ""
              }`;
              console.error(`[Sightseeing AI] ${name}: ${errorMsg}`, {
                searchQuery,
                status: searchResponse.status,
                error: errorData,
              });
              errors.push({
                name,
                error: errorMsg,
                details: {
                  searchQuery,
                  status: searchResponse.status,
                  error: errorData,
                  destination_name,
                  destination_id,
                },
              });
              return;
            }

            const searchData = await searchResponse.json();

            if (!searchData.places || searchData.places.length === 0) {
              const errorMsg = `Place not found for query: "${searchQuery}"`;
              console.error(`[Sightseeing AI] ${name}: ${errorMsg}`, {
                searchQuery,
                response: searchData,
              });
              errors.push({
                name,
                error: errorMsg,
                details: {
                  searchQuery,
                  response: searchData,
                  destination_name,
                  destination_id,
                },
              });
              return;
            }

            const place = searchData.places[0];
            const placeId = place.id;
            console.log(
              `[Sightseeing AI] ${name}: Found place "${
                place.displayName?.text || placeId
              }" (Place ID: ${placeId})`,
            );

            // Step 2: Get Place Details using Places API (New)
            const detailsUrl = `https://places.googleapis.com/v1/places/${placeId}`;

            const detailsResponse = await fetch(detailsUrl, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
                "X-Goog-FieldMask":
                  "id,displayName,formattedAddress,location,types,photos,regularOpeningHours,currentOpeningHours",
              },
            });

            if (!detailsResponse.ok) {
              const errorText = await detailsResponse.text();
              let errorData;
              try {
                errorData = JSON.parse(errorText);
              } catch {
                errorData = { error: { message: errorText } };
              }
              const errorMsg = `Details not found: ${detailsResponse.status}${
                errorData.error?.message ? ` - ${errorData.error.message}` : ""
              }`;
              console.error(`[Sightseeing AI] ${name}: ${errorMsg}`, {
                placeId,
                status: detailsResponse.status,
                error: errorData,
              });
              errors.push({
                name,
                error: errorMsg,
                details: {
                  placeId,
                  status: detailsResponse.status,
                  error: errorData,
                  destination_name,
                  destination_id,
                },
              });
              return;
            }

            const details = await detailsResponse.json();

            // Extract opening hours (new API format)
            // Use extracted opening hours if available, otherwise use Google Places data
            let openingHours = extractedOpeningHours;
            if (!openingHours) {
              const openingHoursData =
                details.regularOpeningHours || details.currentOpeningHours;
              if (
                openingHoursData &&
                openingHoursData.weekdayDescriptions &&
                openingHoursData.weekdayDescriptions.length > 0
              ) {
                // Get the first day's hours as a simple format (e.g., "Monday: 10:00 AM – 7:00 PM")
                const firstDay = openingHoursData.weekdayDescriptions[0];
                // Extract time range (e.g., "Monday: 10:00 AM – 7:00 PM" -> "10:00-19:00")
                const timeMatch = firstDay.match(
                  /(\d{1,2}):(\d{2})\s*(AM|PM)\s*–\s*(\d{1,2}):(\d{2})\s*(AM|PM)/,
                );
                if (timeMatch) {
                  const [, startH, startM, startAMPM, endH, endM, endAMPM] =
                    timeMatch;
                  const startHour =
                    parseInt(startH) +
                    (startAMPM === "PM" && startH !== "12" ? 12 : 0) -
                    (startAMPM === "AM" && startH === "12" ? 12 : 0);
                  const endHour =
                    parseInt(endH) +
                    (endAMPM === "PM" && endH !== "12" ? 12 : 0) -
                    (endAMPM === "AM" && endH === "12" ? 12 : 0);
                  openingHours = `${String(startHour).padStart(
                    2,
                    "0",
                  )}:${startM}-${String(endHour).padStart(2, "0")}:${endM}`;
                } else {
                  // Fallback: use the full weekday text (remove day name prefix)
                  openingHours = firstDay.replace(/^\w+:\s*/, "");
                }
              }
            }

            // Extract location (new API format)
            const latitude = details.location?.latitude || null;
            const longitude = details.location?.longitude || null;

            // Extract category from types (new API format - types are still strings)
            let category = null;
            if (details.types && details.types.length > 0) {
              // Map Google Places types to our categories
              const typeMap = {
                amusement_park: "theme_park",
                theme_park: "theme_park",
                water_park: "water_park",
                zoo: "zoo",
                aquarium: "aquarium",
                museum: "museum",
                art_gallery: "art_gallery",
                park: "park",
                tourist_attraction: "tourist_attraction",
                night_club: "night_attraction",
                bar: "night_attraction",
                restaurant: "restaurant",
                shopping_mall: "shopping_mall",
              };

              for (const type of details.types) {
                // Types in new API might be prefixed with "places/" or just be the type name
                const typeName = type
                  .replace("places/", "")
                  .replace("types/", "");
                if (typeMap[typeName]) {
                  category = typeMap[typeName];
                  break;
                }
              }

              if (!category && details.types.length > 0) {
                // Use first type as fallback, clean it up
                const firstType = details.types[0]
                  .replace("places/", "")
                  .replace("types/", "");
                category = firstType;
              }
            }

            // Determine best_time based on opening hours
            let bestTime = null;
            if (openingHours) {
              const hourMatch = openingHours.match(/(\d{2}):(\d{2})/);
              if (hourMatch) {
                const openHour = parseInt(hourMatch[1]);
                if (openHour >= 18) {
                  bestTime = "Night";
                } else if (openHour >= 15) {
                  bestTime = "Sunset";
                } else if (openHour >= 12) {
                  bestTime = "Afternoon";
                } else {
                  bestTime = "Morning";
                }
              }
            }

            // Estimate average_duration_hours based on category
            // Use extracted duration if available, otherwise use category-based estimate
            let averageDurationHours = extractedDuration; // Use extracted duration first
            if (!averageDurationHours) {
              const durationMap = {
                theme_park: 6,
                water_park: 4,
                zoo: 3,
                aquarium: 2,
                museum: 2,
                art_gallery: 1.5,
                park: 2,
                tourist_attraction: 2,
                night_attraction: 3,
                restaurant: 1.5,
                shopping_mall: 3,
              };
              averageDurationHours = durationMap[category] || 2;
            }

            // Predict tag based on category, opening hours, and duration
            let predictedTag = null;

            // Check if it's Night-only (opens after 6 PM or only operates at night)
            if (openingHours) {
              const hourMatch = openingHours.match(/(\d{2}):(\d{2})/);
              if (hourMatch) {
                const openHour = parseInt(hourMatch[1]);
                // If opens at 6 PM or later, it's likely night-only
                if (openHour >= 18) {
                  predictedTag = "Night-only";
                }
              }
            }

            // Override based on category if it's clearly a night attraction
            if (
              category === "night_attraction" ||
              category === "night_club" ||
              category === "bar"
            ) {
              predictedTag = "Night-only";
            }

            // If not night-only, determine based on duration and category
            if (!predictedTag) {
              // Quick stop: less than 2 hours
              if (averageDurationHours < 2) {
                // Check if it's a simple attraction (viewpoints, quick photo spots)
                const quickStopCategories = [
                  "point_of_interest",
                  "establishment",
                  "store",
                ];
                const quickStopTypes = [
                  "viewpoint",
                  "lookout",
                  "monument",
                  "statue",
                ];

                if (
                  quickStopCategories.includes(category) ||
                  quickStopTypes.some((type) => category?.includes(type))
                ) {
                  predictedTag = "Quick stop";
                } else {
                  // Even if < 2 hours, if not a quick stop type, it's half-day
                  predictedTag = "Half-day";
                }
              }
              // Full-day: 8-9 hours OR theme parks/water parks/zoo (which typically take full day)
              else if (
                averageDurationHours >= 8 ||
                category === "theme_park" ||
                category === "water_park" ||
                category === "zoo"
              ) {
                predictedTag = "Full-day";
              }
              // Half-day: 3-4 hours (or 2-7 hours as fallback)
              else if (averageDurationHours >= 3 && averageDurationHours < 8) {
                predictedTag = "Half-day";
              }
              // Fallback: default to Half-day
              else {
                predictedTag = "Half-day";
              }
            }

            // Get photos (max 4) - new API format
            // TODO: COST OPTIMIZATION - Google Places API costs are high for image requests
            // Instead of storing live API URLs, download images and store them in:
            // 1. Supabase Storage (recommended) - upload images to a bucket
            // 2. Or convert to base64 and store in database (less recommended for large images)
            // This will eliminate ongoing API costs for image display
            const images = [];
            if (details.photos && details.photos.length > 0) {
              const photoCount = Math.min(4, details.photos.length);
              for (let i = 0; i < photoCount; i++) {
                const photo = details.photos[i];
                // New API: photos have name property which is the photo reference
                // Format: places/{place_id}/photos/{photo_reference}
                const photoReference = photo.name
                  ? photo.name.split("/").pop()
                  : photo.name;
                if (photoReference) {
                  // Use the new Places Photo API endpoint
                  // TODO: Download this image and store in Supabase Storage instead
                  const photoUrl = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=800&key=${GOOGLE_PLACES_API_KEY}`;
                  images.push(photoUrl);
                }
              }
            }

            // Combine extracted remarks with any existing remarks
            let combinedRemarks = null;
            if (extractedRemarks.length > 0) {
              combinedRemarks = extractedRemarks.join("; ");
            }

            results.push({
              name: cleanedName, // Use cleaned name (without parentheses and extracted info)
              original_name: name, // Keep original for reference
              destination_id,
              opening_hours: openingHours,
              average_duration_hours: averageDurationHours,
              latitude,
              longitude,
              category,
              best_time: bestTime,
              tag: predictedTag,
              images,
              remarks: combinedRemarks, // Add extracted remarks
            });

            console.log(
              `[Sightseeing AI] ${name}: Successfully generated details`,
              {
                opening_hours: openingHours,
                category,
                best_time: bestTime,
                tag: predictedTag,
                average_duration_hours: averageDurationHours,
                images_count: images.length,
              },
            );
          } catch (error) {
            const errorMsg = error.message || String(error);
            console.error(
              `[Sightseeing AI] Error processing "${attraction.name}":`,
              {
                error: errorMsg,
                stack: error.stack,
                attraction: {
                  name: attraction.name,
                  destination_name: attraction.destination_name,
                  destination_id: attraction.destination_id,
                },
              },
            );
            errors.push({
              name: attraction.name || "Unknown",
              error: errorMsg,
              details: {
                stack: error.stack,
                destination_name: attraction.destination_name,
                destination_id: attraction.destination_id,
              },
            });
          }
        }),
      );

      // Small delay between batches to avoid rate limits
      if (i + batchSize < attractions.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    console.log(
      `[Sightseeing] AI generation by ${currentUser.name}: Generated ${results.length} attractions, ${errors.length} errors`,
    );

    // Log first 10 errors in detail for debugging
    if (errors.length > 0) {
      console.log(
        `[Sightseeing AI] First ${Math.min(10, errors.length)} errors:`,
      );
      errors.slice(0, 10).forEach((err, idx) => {
        console.log(`  ${idx + 1}. ${err.name}: ${err.error}`);
        if (err.details) {
          console.log(`     Details:`, err.details);
        }
      });
      if (errors.length > 10) {
        console.log(`  ... and ${errors.length - 10} more errors`);
      }
    }

    res.json({
      results,
      errors,
      success_count: results.length,
      error_count: errors.length,
    });
  } catch (error) {
    console.error("Error generating attraction details:", error);
    res.status(500).json({
      message: error.message || "Failed to generate attraction details.",
    });
  }
});

// --- TRANSFER TYPES API ENDPOINTS ---

// Get all transfer types - ALL STAFF CAN VIEW
app.get("/api/transfer-types", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view transfer types

    const { category, destination_id } = req.query;
    let query = supabase
      .from("transfer_types")
      .select("*, destinations(id, name, slug)")
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (category) {
      query = query.eq("category", category);
    }

    if (destination_id) {
      query = query.eq("destination_id", parseInt(destination_id));
    }

    const { data: transferTypes, error } = await query;

    if (error) throw error;

    res.json(transferTypes || []);
  } catch (error) {
    console.error("Error fetching transfer types:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch transfer types.",
    });
  }
});

// --- TRANSFERS API ENDPOINTS ---

// Get all transfers (with optional destination filter) - ALL STAFF CAN VIEW
app.get("/api/transfers", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view transfers

    const { destination_id } = req.query;
    let query = supabase
      .from("transfers")
      .select("*, destinations(id, name, slug)")
      .order("name", { ascending: true });

    if (destination_id) {
      query = query.eq("destination_id", parseInt(destination_id));
    }

    const { data: transfers, error } = await query;

    if (error) throw error;

    res.json(transfers || []);
  } catch (error) {
    console.error("Error fetching transfers:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch transfers.",
    });
  }
});

// Download Excel template for bulk transfer upload (MUST be before /api/transfers/:id route)
app.get("/api/transfers/template", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin and Lead Manager can download template
    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can download template.",
      });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Transfer Template");

    // Columns aligned with current transfer fields; Cost* + Costing Type* and per-adult/per-child/total cost options
    worksheet.columns = [
      { header: "Transfer Name*", key: "name", width: 32 },
      { header: "Destination*", key: "destination", width: 25 },
      { header: "Transfer Type*", key: "transfer_type", width: 22 },
      { header: "Cost*", key: "cost", width: 12 },
      { header: "Currency*", key: "currency", width: 12 },
      { header: "Costing Type*", key: "costing_type", width: 28 },
      { header: "Per Adult Cost", key: "per_adult_cost", width: 16 },
      { header: "Per Child Cost", key: "per_child_cost", width: 16 },
      { header: "Total Cost", key: "total_cost", width: 14 },
      { header: "Vehicle Type", key: "vehicle_type", width: 18 },
      { header: "Capacity", key: "capacity", width: 10 },
      { header: "Duration", key: "duration", width: 18 },
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };

    // Example row 1: Per Adult & Per Child
    worksheet.addRow({
      name: "Airport to Hotel Transfer",
      destination: "Sri Lanka",
      transfer_type: "Main Segment",
      cost: 50,
      currency: "USD",
      costing_type: "Per Adult & Per Child",
      per_adult_cost: 50,
      per_child_cost: 25,
      total_cost: "",
      vehicle_type: "Sedan",
      capacity: 4,
      duration: "30 minutes",
    });
    // Example row 2: Total cost (÷ by pax)
    worksheet.addRow({
      name: "Hotel to Airport Transfer",
      destination: "Sri Lanka",
      transfer_type: "Main Segment",
      cost: "",
      currency: "USD",
      costing_type: "Total cost (÷ by pax)",
      per_adult_cost: "",
      per_child_cost: "",
      total_cost: 200,
      vehicle_type: "Van",
      capacity: 8,
      duration: "45 minutes",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Transfer_Bulk_Upload_Template.xlsx"',
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating template:", error);
    res.status(500).json({
      message: error.message || "Failed to generate template.",
    });
  }
});

// Get a single transfer by ID - ALL STAFF CAN VIEW
app.get("/api/transfers/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    // All authenticated staff can view transfers

    const { id } = req.params;

    const { data: transfer, error } = await supabase
      .from("transfers")
      .select("*, destinations(id, name, slug)")
      .eq("id", parseInt(id))
      .single();

    if (error) throw error;

    res.json(transfer);
  } catch (error) {
    console.error("Error fetching transfer:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch transfer.",
    });
  }
});

// Create a new transfer - EDIT ACCESS REQUIRED
app.post("/api/transfers", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can create transfers.",
      });
    }

    const {
      destination_id,
      name,
      cost,
      currency,
      image_url,
      vehicle_type,
      capacity,
      duration,
      remarks,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Transfer name is required." });
    }

    if (cost === undefined || cost === null) {
      return res.status(400).json({ message: "Transfer cost is required." });
    }

    // Verify destination exists if provided
    if (destination_id) {
      const { data: destination, error: destError } = await supabase
        .from("destinations")
        .select("id")
        .eq("id", destination_id)
        .single();

      if (destError || !destination) {
        return res.status(400).json({ message: "Invalid destination ID." });
      }
    }

    const { data: newTransfer, error } = await supabase
      .from("transfers")
      .insert({
        destination_id: destination_id ? parseInt(destination_id) : null,
        name: name.trim(),
        cost: parseFloat(cost),
        currency: currency || "USD",
        image_url: image_url || null,
        vehicle_type: vehicle_type || null,
        capacity: capacity ? parseInt(capacity) : null,
        duration: duration || null,
        remarks: remarks || null,
        created_by_staff_id: currentUser.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*, destinations(id, name, slug)")
      .single();

    if (error) throw error;

    console.log(`[Transfers] Transfer created by ${currentUser.name}: ${name}`);

    res.status(201).json({
      message: "Transfer created successfully.",
      transfer: newTransfer,
    });
  } catch (error) {
    console.error("Error creating transfer:", error);
    res.status(500).json({
      message: error.message || "Failed to create transfer.",
    });
  }
});

// Update a transfer - EDIT ACCESS REQUIRED
app.put("/api/transfers/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can update transfers.",
      });
    }

    const { id } = req.params;
    const {
      destination_id,
      name,
      cost,
      currency,
      image_url,
      vehicle_type,
      capacity,
      duration,
      remarks,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Transfer name is required." });
    }

    if (cost === undefined || cost === null) {
      return res.status(400).json({ message: "Transfer cost is required." });
    }

    // Verify destination exists if provided
    if (destination_id) {
      const { data: destination, error: destError } = await supabase
        .from("destinations")
        .select("id")
        .eq("id", destination_id)
        .single();

      if (destError || !destination) {
        return res.status(400).json({ message: "Invalid destination ID." });
      }
    }

    const { data: updatedTransfer, error } = await supabase
      .from("transfers")
      .update({
        destination_id: destination_id ? parseInt(destination_id) : null,
        name: name.trim(),
        cost: parseFloat(cost),
        currency: currency || "USD",
        image_url: image_url !== undefined ? image_url : undefined,
        vehicle_type: vehicle_type !== undefined ? vehicle_type : undefined,
        capacity:
          capacity !== undefined
            ? capacity
              ? parseInt(capacity)
              : null
            : undefined,
        duration: duration !== undefined ? duration : undefined,
        remarks: remarks !== undefined ? remarks : undefined,
        updated_by_staff_id: currentUser.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", parseInt(id))
      .select("*, destinations(id, name, slug)")
      .single();

    if (error) throw error;

    console.log(`[Transfers] Transfer updated by ${currentUser.name}: ${name}`);

    res.json({
      message: "Transfer updated successfully.",
      transfer: updatedTransfer,
    });
  } catch (error) {
    console.error("Error updating transfer:", error);
    res.status(500).json({
      message: error.message || "Failed to update transfer.",
    });
  }
});

// Delete a transfer - EDIT ACCESS REQUIRED
app.delete("/api/transfers/:id", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!checkDestinationsEditAccess(currentUser)) {
      return res.status(403).json({
        message:
          "Access denied. Only Super Admin and Lead Manager can delete transfers.",
      });
    }

    const { id } = req.params;

    const { error } = await supabase
      .from("transfers")
      .delete()
      .eq("id", parseInt(id));

    if (error) throw error;

    console.log(
      `[Transfers] Transfer deleted by ${currentUser.name}: ID ${id}`,
    );

    res.json({ message: "Transfer deleted successfully." });
  } catch (error) {
    console.error("Error deleting transfer:", error);
    res.status(500).json({
      message: error.message || "Failed to delete transfer.",
    });
  }
});

// Bulk upload transfers from Excel file
const transferUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    console.log(
      `[Transfers Bulk Upload] File filter check: ${file.originalname}, mimetype: ${file.mimetype}`,
    );
    if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".xlsx") ||
      file.originalname.endsWith(".xls")
    ) {
      cb(null, true);
    } else {
      const error = new Error("Only Excel files (.xlsx, .xls) are allowed");
      req.fileValidationError = error.message;
      cb(error, false);
    }
  },
});

// Error handler for multer
const handleTransferMulterError = (err, req, res, next) => {
  if (err) {
    console.error(
      "[Transfers Bulk Upload] Multer/file filter error:",
      err.message,
    );
    return res.status(400).json({
      message: err.message || "File upload error",
    });
  }
  next();
};

app.post(
  "/api/transfers/bulk-upload",
  requireAuth,
  transferUpload.single("file"),
  handleTransferMulterError,
  async (req, res) => {
    try {
      const currentUser = req.user;

      // Only Super Admin and Lead Manager can bulk upload
      if (!checkDestinationsEditAccess(currentUser)) {
        return res.status(403).json({
          message:
            "Access denied. Only Super Admin and Lead Manager can bulk upload transfers.",
        });
      }

      if (!req.file) {
        console.error("[Transfers Bulk Upload] No file in request");
        return res.status(400).json({ message: "No file uploaded." });
      }

      console.log(
        `[Transfers Bulk Upload] File received: ${req.file.originalname}, size: ${req.file.size} bytes, mimetype: ${req.file.mimetype}`,
      );

      let workbook;
      try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        console.log("[Transfers Bulk Upload] Excel file loaded successfully");
      } catch (error) {
        console.error(
          "[Transfers Bulk Upload] Error loading Excel file:",
          error,
        );
        return res.status(400).json({
          message: `Failed to parse Excel file: ${error.message}`,
        });
      }

      const worksheet = workbook.getWorksheet(1); // Get first worksheet
      if (!worksheet) {
        return res.status(400).json({ message: "Excel file is empty." });
      }

      console.log(
        `[Transfers Bulk Upload] Worksheet found: ${worksheet.name}, row count: ${worksheet.rowCount}`,
      );

      const rows = [];
      const headers = {};

      // First, get all headers from row 1
      worksheet.getRow(1).eachCell((cell, colNumber) => {
        const headerValue = cell.value;
        if (headerValue) {
          headers[colNumber] = headerValue.toString().trim();
        }
      });

      console.log(
        `[Transfers Bulk Upload] Headers found:`,
        Object.values(headers),
      );

      // Then process data rows
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row

        const rowData = {};
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber];
          if (header) {
            rowData[header] = cell.value;
          }
        });

        if (Object.keys(rowData).length > 0) {
          rows.push(rowData);
        }
      });

      console.log(`[Transfers Bulk Upload] Parsed ${rows.length} data rows`);

      if (rows.length === 0) {
        console.error(
          "[Transfers Bulk Upload] No data rows found after parsing",
        );
        return res.status(400).json({
          message: "No data rows found in Excel file.",
        });
      }

      // Get all destinations for name lookup
      const { data: allDestinations, error: destError } = await supabase
        .from("destinations")
        .select("id, name");

      if (destError) {
        console.error(
          "[Transfers Bulk Upload] Error fetching destinations:",
          destError,
        );
      }

      const destinationMap = new Map();
      if (allDestinations) {
        allDestinations.forEach((dest) => {
          destinationMap.set(dest.name.toLowerCase().trim(), dest.id);
        });
      }

      const results = {
        success: 0,
        errors: [],
      };

      // Process each row
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2; // +2 because we skip header and 0-indexed

        try {
          // Map Excel columns to database fields
          const transferName =
            row["Transfer Name*"] || row["Transfer Name"] || row["name"];
          if (!transferName || !transferName.toString().trim()) {
            results.errors.push({
              row: rowNumber,
              error: "Transfer Name is required",
              data: row,
            });
            continue;
          }

          // Parse Destination (by name) - required
          const destinationName = (
            row["Destination*"] ||
            row["Destination"] ||
            ""
          )
            .toString()
            .trim();
          let destinationId = null;
          if (destinationName) {
            const foundDest = destinationMap.get(destinationName.toLowerCase());
            if (foundDest) {
              destinationId = foundDest;
            } else {
              results.errors.push({
                row: rowNumber,
                error: `Destination "${destinationName}" not found`,
                data: row,
              });
              continue;
            }
          } else {
            results.errors.push({
              row: rowNumber,
              error: "Destination is required",
              data: row,
            });
            continue;
          }

          // Parse Transfer Type / Category - required
          const categoryRaw = (
            row["Transfer Type*"] ||
            row["Transfer Type"] ||
            row["Category"] ||
            ""
          )
            .toString()
            .trim();
          const validCategories = ["Main Segment", "Attraction Transfer"];
          const transferType = validCategories.includes(categoryRaw)
            ? categoryRaw
            : null;
          if (!transferType) {
            results.errors.push({
              row: rowNumber,
              error:
                "Transfer Type is required (Main Segment or Attraction Transfer)",
              data: row,
            });
            continue;
          }

          // Parse Vehicle Type
          const vehicleType =
            (row["Vehicle Type"] || "").toString().trim() || null;

          // Parse Capacity
          let capacity = null;
          const capacityValue = row["Capacity"];
          if (capacityValue !== undefined && capacityValue !== null) {
            const parsedCapacity = parseInt(capacityValue.toString());
            if (!isNaN(parsedCapacity)) {
              capacity = parsedCapacity;
            }
          }

          // Parse Duration
          const duration = (row["Duration"] || "").toString().trim() || null;

          // Parse Currency - required (default USD)
          const currencyRaw = (row["Currency*"] || row["Currency"] || "USD")
            .toString()
            .trim()
            .toUpperCase();
          const validCurrencies = ["USD", "INR", "EUR", "GBP"];
          const currency = validCurrencies.includes(currencyRaw)
            ? currencyRaw
            : "USD";

          // Parse Costing Type*: "Per Adult & Per Child" or "Total cost (÷ by pax)"
          const costingTypeRaw = (
            row["Costing Type*"] ||
            row["Costing Type"] ||
            "Per Adult & Per Child"
          )
            .toString()
            .trim();
          const isTotalCosting = /total\s*cost|÷\s*by\s*pax/i.test(
            costingTypeRaw,
          );
          const costingType = isTotalCosting ? "total" : "per_person";

          const parseNum = (val) => {
            if (
              val === undefined ||
              val === null ||
              val.toString().trim() === ""
            )
              return null;
            const n = parseFloat(val.toString().replace(/[^0-9.]/g, ""));
            return !isNaN(n) && n >= 0 ? n : null;
          };

          let cost = 0;
          let perAdultCost = null;
          let perChildCost = null;
          let totalCost = null;

          if (costingType === "total") {
            const totalVal =
              row["Total Cost"] != null
                ? row["Total Cost"]
                : row["Cost*"] || row["Cost"];
            totalCost = parseNum(totalVal);
            if (totalCost === null) {
              results.errors.push({
                row: rowNumber,
                error:
                  "Total Cost is required when Costing Type is 'Total cost (÷ by pax)' (must be a number >= 0)",
                data: row,
              });
              continue;
            }
            cost = totalCost;
          } else {
            perAdultCost = parseNum(row["Per Adult Cost"]);
            const costCol = parseNum(row["Cost*"] || row["Cost"]);
            if (perAdultCost === null && costCol === null) {
              results.errors.push({
                row: rowNumber,
                error:
                  "Cost* or Per Adult Cost is required when Costing Type is 'Per Adult & Per Child'",
                data: row,
              });
              continue;
            }
            perAdultCost = perAdultCost ?? costCol;
            perChildCost = parseNum(row["Per Child Cost"]);
            cost = perAdultCost;
          }

          const transferData = {
            destination_id: destinationId,
            name: transferName.toString().trim(),
            cost,
            currency: currency,
            costing_type: costingType,
            per_adult_cost: costingType === "per_person" ? perAdultCost : null,
            per_child_cost: costingType === "per_person" ? perChildCost : null,
            total_cost: costingType === "total" ? totalCost : null,
            vehicle_type: vehicleType,
            capacity: capacity,
            duration: duration,
            type: transferType,
            created_by_staff_id: currentUser.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          const { data: newTransfer, error } = await supabase
            .from("transfers")
            .insert(transferData)
            .select()
            .single();

          if (error) {
            results.errors.push({
              row: rowNumber,
              error: error.message,
              data: row,
            });
          } else {
            results.success++;
            console.log(
              `[Transfers] Transfer created via bulk upload by ${currentUser.name}: ${transferData.name}`,
            );
          }
        } catch (error) {
          results.errors.push({
            row: rowNumber,
            error: error.message || "Unknown error",
            data: row,
          });
        }
      }

      console.log(
        `[Transfers Bulk Upload] Processing complete. Success: ${results.success}, Errors: ${results.errors.length}`,
      );
      if (results.errors.length > 0) {
        console.log(
          `[Transfers Bulk Upload] Error details:`,
          JSON.stringify(results.errors, null, 2),
        );
      }

      res.json({
        message: `Upload complete. ${results.success} transfer(s) created successfully.`,
        success: results.success,
        errors: results.errors,
      });
    } catch (error) {
      console.error(
        "[Transfers Bulk Upload] Error bulk uploading transfers:",
        error,
      );
      console.error("[Transfers Bulk Upload] Error stack:", error.stack);
      res.status(500).json({
        message: error.message || "Failed to bulk upload transfers.",
      });
    }
  },
);

// ============================================================================
// AI ITINERARY ACTIVITY GENERATION ENDPOINTS
// ============================================================================

// Utility function: Calculate distance between two coordinates using Haversine formula (returns distance in km)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;

  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Utility function: Check if two attraction names are similar (for duplicate detection)
const areAttractionsSimilar = (name1, name2) => {
  if (!name1 || !name2) return false;

  // Normalize names: remove extra spaces, convert to lowercase
  const normalize = (str) => str.toLowerCase().replace(/\s+/g, " ").trim();
  const n1 = normalize(name1);
  const n2 = normalize(name2);

  // Exact match
  if (n1 === n2) return true;

  // Extract base name (before first dash or parentheses)
  const getBaseName = (str) => {
    const dashIndex = str.indexOf(" - ");
    const parenIndex = str.indexOf(" (");
    if (dashIndex > 0) return str.substring(0, dashIndex).trim();
    if (parenIndex > 0) return str.substring(0, parenIndex).trim();
    return str;
  };

  const base1 = getBaseName(n1);
  const base2 = getBaseName(n2);

  // If base names are similar (at least 80% match), consider them duplicates
  if (base1.length > 10 && base2.length > 10) {
    const longer = base1.length > base2.length ? base1 : base2;
    const shorter = base1.length > base2.length ? base2 : base1;

    // Check if shorter is contained in longer (with some tolerance)
    if (
      longer.includes(shorter) ||
      shorter.includes(
        longer.substring(0, Math.min(shorter.length + 5, longer.length)),
      )
    ) {
      return true;
    }

    // Calculate similarity using Levenshtein distance
    const similarity = calculateSimilarity(base1, base2);
    if (similarity > 0.8) return true;
  }

  return false;
};

// Calculate string similarity (0-1)
const calculateSimilarity = (str1, str2) => {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
};

// Levenshtein distance calculation
const levenshteinDistance = (str1, str2) => {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
};

// Utility function: Parse duration string to number of days (first number wins: "5", "5 Days", "5 Days / 4 Nights" -> 5)
const parseDurationToDays = (durationStr) => {
  if (!durationStr) return 4;
  const numberMatch = String(durationStr).match(/(\d+)/);
  if (numberMatch) {
    const n = parseInt(numberMatch[1], 10);
    return n >= 1 ? n : 4;
  }
  return 4; // Default fallback
};

// Utility function: Calculate date for a specific day number
const getDayDate = (travelDate, dayNumber) => {
  if (!travelDate) return "";
  const date = new Date(travelDate);
  date.setDate(date.getDate() + (dayNumber - 1));
  return date.toISOString().split("T")[0];
};

// Utility function: Generate time slots for an attraction
const generateTimeSlots = (openingHours, bestTime, durationHours) => {
  const slots = [];

  if (!openingHours || !durationHours) {
    // Default slots based on best_time
    if (bestTime === "Morning") {
      slots.push({ start: "08:00", end: "12:00", label: "Morning" });
      slots.push({ start: "09:00", end: "13:00", label: "Morning" });
    } else if (bestTime === "Afternoon") {
      slots.push({ start: "12:00", end: "16:00", label: "Afternoon" });
      slots.push({ start: "13:00", end: "17:00", label: "Afternoon" });
    } else if (bestTime === "Sunset") {
      slots.push({ start: "15:00", end: "19:00", label: "Sunset" });
      slots.push({ start: "16:00", end: "20:00", label: "Sunset" });
    } else if (bestTime === "Night") {
      slots.push({ start: "18:00", end: "22:00", label: "Night" });
      slots.push({ start: "19:00", end: "23:00", label: "Night" });
    } else {
      slots.push({ start: "09:00", end: "13:00", label: "Morning" });
      slots.push({ start: "14:00", end: "18:00", label: "Afternoon" });
    }
    return slots;
  }

  // Parse opening hours (format: "10:00-19:00")
  const hoursMatch = openingHours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (hoursMatch) {
    const openHour = parseInt(hoursMatch[1], 10);
    const openMin = parseInt(hoursMatch[2], 10);
    const closeHour = parseInt(hoursMatch[3], 10);
    const closeMin = parseInt(hoursMatch[4], 10);

    const openTime = openHour * 60 + openMin;
    const closeTime = closeHour * 60 + closeMin;
    const durationMinutes = durationHours * 60;

    // Generate 2-3 slots based on best_time
    if (bestTime === "Morning") {
      const slot1Start = openTime;
      const slot1End = Math.min(
        slot1Start + durationMinutes,
        openTime + 4 * 60,
      );
      if (slot1End <= closeTime) {
        slots.push({
          start: `${Math.floor(slot1Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot1Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot1End / 60)
            .toString()
            .padStart(2, "0")}:${(slot1End % 60).toString().padStart(2, "0")}`,
          label: "Morning",
        });
      }

      const slot2Start = openTime + 60;
      const slot2End = Math.min(
        slot2Start + durationMinutes,
        openTime + 5 * 60,
      );
      if (slot2End <= closeTime && slot2Start < 12 * 60) {
        slots.push({
          start: `${Math.floor(slot2Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot2Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot2End / 60)
            .toString()
            .padStart(2, "0")}:${(slot2End % 60).toString().padStart(2, "0")}`,
          label: "Morning",
        });
      }
    } else if (bestTime === "Afternoon") {
      const slot1Start = Math.max(12 * 60, openTime);
      const slot1End = Math.min(slot1Start + durationMinutes, closeTime);
      if (slot1End <= closeTime) {
        slots.push({
          start: `${Math.floor(slot1Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot1Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot1End / 60)
            .toString()
            .padStart(2, "0")}:${(slot1End % 60).toString().padStart(2, "0")}`,
          label: "Afternoon",
        });
      }

      const slot2Start = slot1Start + 60;
      const slot2End = Math.min(slot2Start + durationMinutes, closeTime);
      if (slot2End <= closeTime && slot2Start < 16 * 60) {
        slots.push({
          start: `${Math.floor(slot2Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot2Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot2End / 60)
            .toString()
            .padStart(2, "0")}:${(slot2End % 60).toString().padStart(2, "0")}`,
          label: "Afternoon",
        });
      }
    } else if (bestTime === "Sunset") {
      const slot1Start = Math.max(15 * 60, openTime);
      const slot1End = Math.min(slot1Start + durationMinutes, closeTime);
      if (slot1End <= closeTime) {
        slots.push({
          start: `${Math.floor(slot1Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot1Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot1End / 60)
            .toString()
            .padStart(2, "0")}:${(slot1End % 60).toString().padStart(2, "0")}`,
          label: "Sunset",
        });
      }
    } else if (bestTime === "Night") {
      const slot1Start = Math.max(18 * 60, openTime);
      const slot1End = Math.min(slot1Start + durationMinutes, closeTime);
      if (slot1End <= closeTime) {
        slots.push({
          start: `${Math.floor(slot1Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot1Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot1End / 60)
            .toString()
            .padStart(2, "0")}:${(slot1End % 60).toString().padStart(2, "0")}`,
          label: "Night",
        });
      }
    } else {
      // Default slots
      const slot1Start = openTime;
      const slot1End = Math.min(slot1Start + durationMinutes, closeTime);
      if (slot1End <= closeTime) {
        slots.push({
          start: `${Math.floor(slot1Start / 60)
            .toString()
            .padStart(2, "0")}:${(slot1Start % 60)
            .toString()
            .padStart(2, "0")}`,
          end: `${Math.floor(slot1End / 60)
            .toString()
            .padStart(2, "0")}:${(slot1End % 60).toString().padStart(2, "0")}`,
          label: "Morning",
        });
      }
    }
  }

  return slots.length > 0
    ? slots
    : [{ start: "09:00", end: "17:00", label: "Default" }];
};

// Helper function to generate activities (can be called internally or via endpoint)
async function generateActivitiesInternal({
  travelDate,
  duration,
  destination,
  adults = 2,
  children = 0,
  existingActivities = [],
}) {
  const numDays = parseDurationToDays(duration);
  if (numDays === 0) {
    throw new Error(
      "Invalid duration format. Expected format: 'X Days' or a number (e.g. 5).",
    );
  }

  // Fetch destinations to match by name
  const { data: destinations, error: destError } = await supabase
    .from("destinations")
    .select("id, name");

  if (destError) throw destError;

  // Find matching destination IDs
  const matchingDestinations = destinations.filter(
    (d) =>
      d.name.toLowerCase().includes(destination.toLowerCase()) ||
      destination.toLowerCase().includes(d.name.toLowerCase()),
  );

  if (matchingDestinations.length === 0) {
    throw new Error(`No destinations found matching "${destination}".`);
  }

  const destIds = matchingDestinations.map((d) => d.id);

  // Fetch all attractions for matching destinations
  const { data: sightseeing, error: sightError } = await supabase
    .from("sightseeing")
    .select("*")
    .in("destination_id", destIds);

  if (sightError) throw sightError;

  if (!sightseeing || sightseeing.length === 0) {
    // Fallback: use Gemini to suggest one attraction per day with approximate INR prices
    try {
      const prompt = `You are a travel expert. For a trip to "${destination}" over ${numDays} day(s), suggest exactly ONE popular attraction or activity per day. Use general knowledge and typical entry/experience prices in India (INR).

Return a valid JSON array only, no other text. Each object must have:
- day_number (number, 1 to ${numDays})
- name (string, attraction/activity name)
- duration_hours (number, e.g. 2 or 3)
- start_time (string, HH:MM, e.g. "09:00" or "14:00")
- price_inr (number, approximate per-adult cost in Indian Rupees)

Example format: [{"day_number":1,"name":"Marina Bay Sands SkyPark","duration_hours":2,"start_time":"15:00","price_inr":2500},{"day_number":2,"name":"Gardens by the Bay","duration_hours":3,"start_time":"09:00","price_inr":1200}]`;

      const response = await geminiAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      let text = (response.text || "").trim();
      const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlock) text = codeBlock[1].trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const items = JSON.parse(jsonMatch[0]);
        const generatedActivities = (Array.isArray(items) ? items : []).map(
          (a, idx) => {
            const day = Math.min(
              numDays,
              Math.max(1, Number(a.day_number) || idx + 1),
            );
            const durationHours = Number(a.duration_hours) || 2;
            const startTime =
              a.start_time &&
              /^\d{1,2}:\d{2}$/.test(String(a.start_time).trim())
                ? String(a.start_time).trim()
                : "09:00";
            const [sh, sm] = startTime.split(":").map(Number);
            const endM = sh * 60 + sm + durationHours * 60;
            const endH = Math.floor(endM / 60) % 24;
            const endMin = endM % 60;
            const endTime = `${String(endH).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`;
            return {
              id: idx + 1,
              name: String(a.name || `Day ${day} activity`).trim(),
              date: getDayDate(travelDate, day),
              day_number: day,
              start_time: startTime,
              end_time: endTime,
              duration: `${durationHours} hour${durationHours !== 1 ? "s" : ""}`,
              is_shared: false,
              inclusions: "",
              exclusions: "",
              image_url: "",
              warnings: [],
              price_per_adult_inr: Number(a.price_inr) || 0,
            };
          },
        );
        return {
          success: true,
          activities: generatedActivities,
          summary: {
            total_activities: generatedActivities.length,
            days: numDays,
            by_tag: {},
          },
        };
      }
    } catch (fallbackErr) {
      logger.warn("Activities AI fallback failed", {
        destination,
        error: fallbackErr.message,
      });
    }
    throw new Error("No attractions available for this destination.");
  }

  // Filter out already added attractions by ID and name similarity
  const addedSightseeingIds = new Set(
    existingActivities.map((a) => a.sightseeing_id).filter(Boolean),
  );
  const addedAttractionNames = existingActivities
    .map((a) => a.name)
    .filter(Boolean);

  let availableAttractions = sightseeing.filter((s) => {
    // Filter by ID
    if (addedSightseeingIds.has(s.id)) return false;

    // Filter by name similarity
    return !addedAttractionNames.some((name) =>
      areAttractionsSimilar(name, s.attraction_name),
    );
  });

  if (availableAttractions.length === 0) {
    throw new Error(
      "All attractions have already been added to this itinerary.",
    );
  }

  // Track used attractions to prevent duplicates
  const usedAttractionNames = new Set();
  const usedAttractionIds = new Set();

  // Helper function to check if attraction is already used
  const isAttractionUsed = (attraction) => {
    if (usedAttractionIds.has(attraction.id)) return true;
    return Array.from(usedAttractionNames).some((name) =>
      areAttractionsSimilar(name, attraction.attraction_name),
    );
  };

  // Helper function to mark attraction as used
  const markAttractionUsed = (attraction) => {
    usedAttractionIds.add(attraction.id);
    usedAttractionNames.add(attraction.attraction_name);
  };

  // Helper function to check if attractions are within distance
  const areWithinDistance = (attraction1, attraction2, maxDistance = 12) => {
    if (
      !attraction1.latitude ||
      !attraction1.longitude ||
      !attraction2.latitude ||
      !attraction2.longitude
    ) {
      return false; // Can't calculate distance, assume not nearby
    }
    const distance = calculateDistance(
      attraction1.latitude,
      attraction1.longitude,
      attraction2.latitude,
      attraction2.longitude,
    );
    return distance <= maxDistance;
  };

  // Classify attractions
  const fullDayAttractions = availableAttractions.filter(
    (s) => s.tag === "Full-day" && !isAttractionUsed(s),
  );
  const nightOnlyAttractions = availableAttractions.filter(
    (s) => s.tag === "Night-only" && !isAttractionUsed(s),
  );
  const halfDayAttractions = availableAttractions.filter(
    (s) => s.tag === "Half-day" && !isAttractionUsed(s),
  );
  const quickStopAttractions = availableAttractions.filter(
    (s) => s.tag === "Quick stop" && !isAttractionUsed(s),
  );
  const unclassifiedAttractions = availableAttractions.filter(
    (s) => !s.tag && !isAttractionUsed(s),
  );

  // Distribute attractions across days
  const dayAssignments = {};
  for (let day = 1; day <= numDays; day++) {
    dayAssignments[day] = [];
  }

  // DAY 1 (Arrival Day): Only activities after 5 PM, 2-3 hours duration OR Night-only tours after 6 PM
  const arrivalDayCandidates = [
    ...nightOnlyAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
    ...halfDayAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
    ...quickStopAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
    ...unclassifiedAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
  ];

  // Prefer night-only for arrival day
  const arrivalNightOnly = arrivalDayCandidates.filter(
    (s) => s.tag === "Night-only",
  );
  if (arrivalNightOnly.length > 0 && !isAttractionUsed(arrivalNightOnly[0])) {
    dayAssignments[1].push(arrivalNightOnly[0]);
    markAttractionUsed(arrivalNightOnly[0]);
  } else if (arrivalDayCandidates.length > 0) {
    // Pick one 2-3 hour activity
    const candidate = arrivalDayCandidates.find((s) => !isAttractionUsed(s));
    if (candidate) {
      dayAssignments[1].push(candidate);
      markAttractionUsed(candidate);
    }
  }

  // DEPARTURE DAY (Last Day): Only light 2-3 hour activities before 12 PM
  const departureDayCandidates = [
    ...halfDayAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
    ...quickStopAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
    ...unclassifiedAttractions.filter(
      (s) =>
        (s.average_duration_hours || 0) >= 2 &&
        (s.average_duration_hours || 0) <= 3,
    ),
  ];

  if (departureDayCandidates.length > 0) {
    const candidate = departureDayCandidates.find((s) => !isAttractionUsed(s));
    if (candidate) {
      dayAssignments[numDays].push(candidate);
      markAttractionUsed(candidate);
    }
  }

  // MIDDLE DAYS: Only 1 activity per day; minimum 2.55 hrs (prefer 3-4 hr, then 6-8 hr)
  // If no 3-4 hr, then 6-8 hr
  // If no 6-8 hr, then 2.55 hr
  // If no 2.55 hr, then fallback to one attraction with duration >= 2.55 hrs (and <= 8)
  // If no attraction with duration >= 2.55 hrs (and <= 8), then fallback to one attraction with duration >= 2.55 hrs (and <= 8)
  // If no attraction with duration >= 2.55 hrs (and <= 8), then fallback to one attraction with duration >= 2.55 hrs (and <= 8)

  const MIN_MIDDLE_DAY_HOURS = 2.55;
  const middleDays =
    numDays > 2 ? Array.from({ length: numDays - 2 }, (_, i) => i + 2) : [];

  const meetsMinDuration = (s) =>
    (s.average_duration_hours || 0) >= MIN_MIDDLE_DAY_HOURS;

  middleDays.forEach((day) => {
    const dayActivities = dayAssignments[day];
    const dayHours = dayActivities.reduce(
      (sum, a) => sum + (a.average_duration_hours || 0),
      0,
    );
    if (dayHours > 0) return; // Already have an activity for this day

    // Prefer one 3-4 hour attraction per middle day (min 2.55 satisfied)
    const threeToFourHour = [
      ...halfDayAttractions.filter(
        (s) =>
          (s.average_duration_hours || 0) >= 3 &&
          (s.average_duration_hours || 0) <= 4,
      ),
      ...unclassifiedAttractions.filter(
        (s) =>
          (s.average_duration_hours || 0) >= 3 &&
          (s.average_duration_hours || 0) <= 4,
      ),
    ].find((s) => !isAttractionUsed(s));

    if (threeToFourHour) {
      dayAssignments[day].push(threeToFourHour);
      markAttractionUsed(threeToFourHour);
      return;
    }

    // Else one full-day (6-8 hr) – min 2.55 satisfied
    const fullDayCandidate = fullDayAttractions.find(
      (s) => !isAttractionUsed(s) && (s.average_duration_hours || 0) <= 8,
    );
    if (fullDayCandidate) {
      dayAssignments[day].push(fullDayCandidate);
      markAttractionUsed(fullDayCandidate);
      return;
    }

    // Fallback: one attraction with duration >= 2.55 hrs (and <= 8)
    const minDurationPool = [
      ...halfDayAttractions,
      ...unclassifiedAttractions,
    ].filter(
      (s) =>
        !isAttractionUsed(s) &&
        meetsMinDuration(s) &&
        (s.average_duration_hours || 0) <= 8,
    );
    const fallback = minDurationPool[0];
    if (fallback) {
      dayAssignments[day].push(fallback);
      markAttractionUsed(fallback);
    }
  });

  // Generate activities with proper time slots
  const generatedActivities = [];

  for (let day = 1; day <= numDays; day++) {
    const dayAttractions = dayAssignments[day];

    dayAttractions.forEach((attraction, index) => {
      let startTime = "09:00";
      let endTime = "17:00";
      const durationHours = attraction.average_duration_hours || 2;
      const durationMinutes = durationHours * 60;

      // DAY 1 (Arrival Day): Activities after 5 PM
      if (day === 1) {
        if (attraction.tag === "Night-only") {
          // Night-only tours after 6 PM
          startTime = "18:00";
        } else {
          // Other activities after 5 PM
          startTime = "17:00";
        }
        const [startH, startM] = startTime.split(":").map(Number);
        const endMinutes = startH * 60 + startM + durationMinutes;
        const endH = Math.floor(endMinutes / 60);
        const endM = endMinutes % 60;
        endTime = `${endH.toString().padStart(2, "0")}:${endM
          .toString()
          .padStart(2, "0")}`;
      }
      // DEPARTURE DAY (Last Day): Activities before 12 PM (morning only)
      else if (day === numDays) {
        // Start early morning, ensure it ends before 12 PM
        startTime = "09:00";
        const [startH, startM] = startTime.split(":").map(Number);
        const endMinutes = startH * 60 + startM + durationMinutes;
        const endH = Math.floor(endMinutes / 60);
        const endM = endMinutes % 60;
        endTime = `${endH.toString().padStart(2, "0")}:${endM
          .toString()
          .padStart(2, "0")}`;
      }
      // MIDDLE DAYS: Use best_time and opening_hours
      else {
        const timeSlots = generateTimeSlots(
          attraction.opening_hours,
          durationMinutes,
          attraction.best_time,
        );
        if (timeSlots.length > 0) {
          const slot = timeSlots[0]; // Use first suggested slot
          startTime = slot.start;
          endTime = slot.end;
        }
      }

      generatedActivities.push({
        name: attraction.attraction_name,
        date: getDayDate(travelDate, day),
        day_number: day,
        start_time: startTime,
        end_time: endTime,
        duration: attraction.average_duration_hours
          ? `${attraction.average_duration_hours} hours`
          : "",
        is_shared: false,
        inclusions: "",
        exclusions: "",
        image_url:
          attraction.images && attraction.images.length > 0
            ? attraction.images[0]
            : "",
        tag: attraction.tag,
        opening_hours: attraction.opening_hours,
        average_duration_hours: attraction.average_duration_hours,
        latitude: attraction.latitude,
        longitude: attraction.longitude,
        category: attraction.category,
        best_time: attraction.best_time,
        sightseeing_id: attraction.id,
        warnings: [],
        transfer_id: undefined,
        transfer_name: undefined,
        transfer_cost: undefined,
        transfer_currency: undefined,
      });
    });
  }

  return {
    success: true,
    activities: generatedActivities,
    summary: {
      total_activities: generatedActivities.length,
      days: numDays,
      by_tag: {
        "Full-day": fullDayAttractions.length,
        "Half-day": halfDayAttractions.length,
        "Night-only": nightOnlyAttractions.length,
        "Quick stop": quickStopAttractions.length,
      },
    },
  };
}

// Main endpoint: Generate activities for entire itinerary
app.post(
  "/api/itinerary/generate-activities",
  requireAuth,
  async (req, res) => {
    try {
      const currentUser = req.user;
      const {
        travelDate,
        duration,
        destination,
        adults = 2,
        children = 0,
        existingActivities = [],
      } = req.body;

      if (!travelDate || !duration || !destination) {
        return res.status(400).json({
          message: "travelDate, duration, and destination are required.",
        });
      }

      // Use the helper function
      try {
        const result = await generateActivitiesInternal({
          travelDate,
          duration,
          destination,
          adults,
          children,
          existingActivities,
        });

        console.log(
          `[Itinerary AI] Generated ${result.activities.length} activities for ${result.summary.days} days by ${currentUser.name}`,
        );

        return res.json(result);
      } catch (error) {
        console.error("Error generating activities:", error);
        return res
          .status(
            error.message?.includes("No destinations")
              ? 404
              : error.message?.includes("already been added")
                ? 400
                : 500,
          )
          .json({
            message: error.message || "Failed to generate activities.",
          });
      }
    } catch (error) {
      console.error("Error generating activities:", error);
      res.status(500).json({
        message: error.message || "Failed to generate activities.",
      });
    }
  },
);

// OLD ENDPOINT HANDLER CODE REMOVED - Now using generateActivitiesInternal helper function
// The code below was the old implementation, kept for reference but not executed
/*
      const numDays = parseDurationToDays(duration);
      if (numDays === 0) {
        return res.status(400).json({
          message:
            "Invalid duration format. Expected format: 'X Days' or 'X Days / Y Nights'.",
        });
      }

      // Fetch destinations to match by name
      const { data: destinations, error: destError } = await supabase
        .from("destinations")
        .select("id, name");

      if (destError) throw destError;

      // Find matching destination IDs
      const matchingDestinations = destinations.filter(
        (d) =>
          d.name.toLowerCase().includes(destination.toLowerCase()) ||
          destination.toLowerCase().includes(d.name.toLowerCase())
      );

      if (matchingDestinations.length === 0) {
        return res.status(404).json({
          message: `No destinations found matching "${destination}".`,
        });
      }

      const destIds = matchingDestinations.map((d) => d.id);

      // Fetch all attractions for matching destinations
      const { data: sightseeing, error: sightError } = await supabase
        .from("sightseeing")
        .select("*")
        .in("destination_id", destIds);

      if (sightError) throw sightError;

      if (!sightseeing || sightseeing.length === 0) {
        return res.status(404).json({
          message: "No attractions available for this destination.",
        });
      }

      // Filter out already added attractions by ID and name similarity
      const addedSightseeingIds = new Set(
        existingActivities.map((a) => a.sightseeing_id).filter(Boolean)
      );
      const addedAttractionNames = existingActivities
        .map((a) => a.name)
        .filter(Boolean);

      let availableAttractions = sightseeing.filter((s) => {
        // Filter by ID
        if (addedSightseeingIds.has(s.id)) return false;

        // Filter by name similarity
        return !addedAttractionNames.some((name) =>
          areAttractionsSimilar(name, s.attraction_name)
        );
      });

      if (availableAttractions.length === 0) {
        return res.status(400).json({
          message: "All attractions have already been added to this itinerary.",
        });
      }

      // Track used attractions to prevent duplicates
      const usedAttractionNames = new Set();
      const usedAttractionIds = new Set();

      // Helper function to check if attraction is already used
      const isAttractionUsed = (attraction) => {
        if (usedAttractionIds.has(attraction.id)) return true;
        return Array.from(usedAttractionNames).some((name) =>
          areAttractionsSimilar(name, attraction.attraction_name)
        );
      };

      // Helper function to mark attraction as used
      const markAttractionUsed = (attraction) => {
        usedAttractionIds.add(attraction.id);
        usedAttractionNames.add(attraction.attraction_name);
      };

      // Helper function to check if attractions are within distance
      const areWithinDistance = (
        attraction1,
        attraction2,
        maxDistance = 12
      ) => {
        if (
          !attraction1.latitude ||
          !attraction1.longitude ||
          !attraction2.latitude ||
          !attraction2.longitude
        ) {
          return false; // Can't calculate distance, assume not nearby
        }
        const distance = calculateDistance(
          attraction1.latitude,
          attraction1.longitude,
          attraction2.latitude,
          attraction2.longitude
        );
        return distance <= maxDistance;
      };

      // Classify attractions
      const fullDayAttractions = availableAttractions.filter(
        (s) => s.tag === "Full-day" && !isAttractionUsed(s)
      );
      const nightOnlyAttractions = availableAttractions.filter(
        (s) => s.tag === "Night-only" && !isAttractionUsed(s)
      );
      const halfDayAttractions = availableAttractions.filter(
        (s) => s.tag === "Half-day" && !isAttractionUsed(s)
      );
      const quickStopAttractions = availableAttractions.filter(
        (s) => s.tag === "Quick stop" && !isAttractionUsed(s)
      );
      const unclassifiedAttractions = availableAttractions.filter(
        (s) => !s.tag && !isAttractionUsed(s)
      );

      // Distribute attractions across days
      const dayAssignments = {};
      for (let day = 1; day <= numDays; day++) {
        dayAssignments[day] = [];
      }

      // DAY 1 (Arrival Day): Only activities after 5 PM, 2-3 hours duration OR Night-only tours after 6 PM
      const arrivalDayCandidates = [
        ...nightOnlyAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
        ...halfDayAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
        ...quickStopAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
        ...unclassifiedAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
      ];

      // Prefer night-only for arrival day
      const arrivalNightOnly = arrivalDayCandidates.filter(
        (s) => s.tag === "Night-only"
      );
      if (
        arrivalNightOnly.length > 0 &&
        !isAttractionUsed(arrivalNightOnly[0])
      ) {
        dayAssignments[1].push(arrivalNightOnly[0]);
        markAttractionUsed(arrivalNightOnly[0]);
      } else if (arrivalDayCandidates.length > 0) {
        // Pick one 2-3 hour activity
        const candidate = arrivalDayCandidates.find(
          (s) => !isAttractionUsed(s)
        );
        if (candidate) {
          dayAssignments[1].push(candidate);
          markAttractionUsed(candidate);
        }
      }

      // DEPARTURE DAY (Last Day): Only light 2-3 hour activities before 12 PM
      const departureDayCandidates = [
        ...halfDayAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
        ...quickStopAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
        ...unclassifiedAttractions.filter(
          (s) =>
            (s.average_duration_hours || 0) >= 2 &&
            (s.average_duration_hours || 0) <= 3
        ),
      ];

      if (departureDayCandidates.length > 0) {
        const candidate = departureDayCandidates.find(
          (s) => !isAttractionUsed(s)
        );
        if (candidate) {
          dayAssignments[numDays].push(candidate);
          markAttractionUsed(candidate);
        }
      }

      // MIDDLE DAYS: Can mix - max 1 full-day OR max 2 nearby 2-3 hour attractions within 10-15km OR max 3 nearby 3-4 hour attractions within 10km
      const middleDays =
        numDays > 2 ? Array.from({ length: numDays - 2 }, (_, i) => i + 2) : [];

      middleDays.forEach((day) => {
        let dayActivities = dayAssignments[day];
        let dayHours = dayActivities.reduce(
          (sum, a) => sum + (a.average_duration_hours || 0),
          0
        );

        // Strategy 1: Try to add 1 full-day attraction
        if (dayHours === 0) {
          const fullDayCandidate = fullDayAttractions.find(
            (s) => !isAttractionUsed(s)
          );
          if (
            fullDayCandidate &&
            (fullDayCandidate.average_duration_hours || 0) <= 8
          ) {
            dayAssignments[day].push(fullDayCandidate);
            markAttractionUsed(fullDayCandidate);
            dayHours += fullDayCandidate.average_duration_hours || 0;
            dayActivities = dayAssignments[day]; // Update reference
          }
        }

        // Strategy 2: Add nearby 2-3 hour attractions (max 2, within 12km)
        if (dayHours < 8) {
          const twoToThreeHourAttractions = [
            ...halfDayAttractions.filter(
              (s) =>
                (s.average_duration_hours || 0) >= 2 &&
                (s.average_duration_hours || 0) <= 3
            ),
            ...unclassifiedAttractions.filter(
              (s) =>
                (s.average_duration_hours || 0) >= 2 &&
                (s.average_duration_hours || 0) <= 3
            ),
          ].filter((s) => !isAttractionUsed(s));

          let addedCount = 0;
          const lastAdded =
            dayActivities.length > 0
              ? dayActivities[dayActivities.length - 1]
              : null;

          for (const candidate of twoToThreeHourAttractions) {
            if (addedCount >= 2) break;
            if (dayHours + (candidate.average_duration_hours || 0) > 8)
              continue;

            // Check distance if we have a previous attraction
            if (lastAdded && !areWithinDistance(lastAdded, candidate, 12)) {
              continue; // Skip if too far
            }

            dayAssignments[day].push(candidate);
            markAttractionUsed(candidate);
            dayHours += candidate.average_duration_hours || 0;
            addedCount++;
            dayActivities = dayAssignments[day]; // Update reference
          }
        }

        // Strategy 3: Add nearby 3-4 hour attractions (max 3, within 10km)
        if (dayHours < 8 && dayAssignments[day].length < 3) {
          const threeToFourHourAttractions = [
            ...halfDayAttractions.filter(
              (s) =>
                (s.average_duration_hours || 0) >= 3 &&
                (s.average_duration_hours || 0) <= 4
            ),
            ...unclassifiedAttractions.filter(
              (s) =>
                (s.average_duration_hours || 0) >= 3 &&
                (s.average_duration_hours || 0) <= 4
            ),
          ].filter((s) => !isAttractionUsed(s));

          let addedCount = 0;
          dayActivities = dayAssignments[day]; // Update reference
          const lastAdded =
            dayActivities.length > 0
              ? dayActivities[dayActivities.length - 1]
              : null;

          for (const candidate of threeToFourHourAttractions) {
            if (addedCount >= 3 || dayAssignments[day].length >= 3) break;
            if (dayHours + (candidate.average_duration_hours || 0) > 8)
              continue;

            // Check distance - stricter for 3-4 hour attractions (10km)
            if (lastAdded && !areWithinDistance(lastAdded, candidate, 10)) {
              continue;
            }

            dayAssignments[day].push(candidate);
            markAttractionUsed(candidate);
            dayHours += candidate.average_duration_hours || 0;
            addedCount++;
            dayActivities = dayAssignments[day]; // Update reference
          }
        }

        // Add night-only attractions if there's room (after 6 PM)
        if (dayHours < 8) {
          const nightCandidate = nightOnlyAttractions.find(
            (s) =>
              !isAttractionUsed(s) &&
              (s.average_duration_hours || 0) <= 8 - dayHours
          );
          if (nightCandidate) {
            dayAssignments[day].push(nightCandidate);
            markAttractionUsed(nightCandidate);
          }
        }
      });

      // Generate activities with proper time slots
      const generatedActivities = [];

      for (let day = 1; day <= numDays; day++) {
        const dayAttractions = dayAssignments[day];

        dayAttractions.forEach((attraction, index) => {
          let startTime = "09:00";
          let endTime = "17:00";
          const durationHours = attraction.average_duration_hours || 2;
          const durationMinutes = durationHours * 60;

          // DAY 1 (Arrival Day): Activities after 5 PM
          if (day === 1) {
            if (attraction.tag === "Night-only") {
              // Night-only tours after 6 PM
              startTime = "18:00";
            } else {
              // Other activities after 5 PM
              startTime = "17:00";
            }
            const [startH, startM] = startTime.split(":").map(Number);
            const endMinutes = startH * 60 + startM + durationMinutes;
            const endH = Math.floor(endMinutes / 60);
            const endM = endMinutes % 60;
            endTime = `${endH.toString().padStart(2, "0")}:${endM
              .toString()
              .padStart(2, "0")}`;
          }
          // DEPARTURE DAY (Last Day): Activities before 12 PM (morning only)
          else if (day === numDays) {
            // Start early morning, ensure it ends before 12 PM
            startTime = "09:00";
            const [startH, startM] = startTime.split(":").map(Number);
            const endMinutes = startH * 60 + startM + durationMinutes;
            const endH = Math.floor(endMinutes / 60);
            const endM = endMinutes % 60;

            // Ensure it doesn't go past 12 PM
            if (endH >= 12) {
              // Adjust start time backwards
              const maxEndMinutes = 12 * 60; // 12:00 PM
              const adjustedStartMinutes = maxEndMinutes - durationMinutes;
              const adjustedStartH = Math.floor(adjustedStartMinutes / 60);
              const adjustedStartM = adjustedStartMinutes % 60;
              startTime = `${adjustedStartH
                .toString()
                .padStart(2, "0")}:${adjustedStartM
                .toString()
                .padStart(2, "0")}`;
              endTime = "12:00";
            } else {
              endTime = `${endH.toString().padStart(2, "0")}:${endM
                .toString()
                .padStart(2, "0")}`;
            }
          }
          // MIDDLE DAYS: Normal scheduling
          else {
            const timeSlots = generateTimeSlots(
              attraction.opening_hours,
              attraction.best_time,
              attraction.average_duration_hours
            );
            startTime = timeSlots[0]?.start || "09:00";
            endTime = timeSlots[0]?.end || "17:00";

            // For night-only attractions, ensure they start after 6:30 PM
            if (attraction.tag === "Night-only") {
              startTime = "18:30";
              const [startH, startM] = startTime.split(":").map(Number);
              const endMinutes = startH * 60 + startM + durationMinutes;
              const endH = Math.floor(endMinutes / 60);
              const endM = endMinutes % 60;
              endTime = `${endH.toString().padStart(2, "0")}:${endM
                .toString()
                .padStart(2, "0")}`;
            } else {
              // Adjust start time based on previous activities in the same day
              if (index > 0) {
                const prevActivity = generatedActivities.filter(
                  (a) => a.day_number === day
                )[index - 1];
                if (prevActivity && prevActivity.end_time) {
                  const [prevH, prevM] = prevActivity.end_time
                    .split(":")
                    .map(Number);
                  const nextHour = prevH + 1; // Add 1 hour break
                  startTime = `${nextHour.toString().padStart(2, "0")}:${prevM
                    .toString()
                    .padStart(2, "0")}`;
                }
              }

              // Calculate end time
              const [startH, startM] = startTime.split(":").map(Number);
              const endMinutes = startH * 60 + startM + durationMinutes;
              const endH = Math.floor(endMinutes / 60);
              const endM = endMinutes % 60;
              endTime = `${endH.toString().padStart(2, "0")}:${endM
                .toString()
                .padStart(2, "0")}`;
            }
          }

          generatedActivities.push({
            name: attraction.attraction_name,
            date: getDayDate(travelDate, day),
            day_number: day,
            start_time: startTime,
            end_time: endTime,
            duration: attraction.average_duration_hours
              ? `${attraction.average_duration_hours} hours`
              : "",
            is_shared: false,
            inclusions: "",
            exclusions: "",
            image_url:
              attraction.images && attraction.images.length > 0
                ? attraction.images[0]
                : "",
            tag: attraction.tag,
            opening_hours: attraction.opening_hours,
            average_duration_hours: attraction.average_duration_hours,
            latitude: attraction.latitude,
            longitude: attraction.longitude,
            category: attraction.category,
            best_time: attraction.best_time,
            sightseeing_id: attraction.id,
            warnings: [],
          });
        });
      }

      console.log(
        `[Itinerary AI] Generated ${generatedActivities.length} activities for ${numDays} days by ${currentUser.name}`
      );

      res.json({
        success: true,
        activities: generatedActivities,
        summary: {
          total_activities: generatedActivities.length,
          days: numDays,
          by_tag: {
            "Full-day": fullDayAttractions.length,
            "Half-day": halfDayAttractions.length,
            "Night-only": nightOnlyAttractions.length,
            "Quick stop": quickStopAttractions.length,
          },
        },
      });
*/

// Endpoint: Generate suggestions for a specific day
app.post(
  "/api/itinerary/generate-day-suggestions",
  requireAuth,
  async (req, res) => {
    try {
      const currentUser = req.user;
      const {
        travelDate,
        duration,
        destination,
        dayNumber,
        existingActivities = [],
        currentDayActivities = [],
      } = req.body;

      if (!travelDate || !duration || !destination || !dayNumber) {
        return res.status(400).json({
          message:
            "travelDate, duration, destination, and dayNumber are required.",
        });
      }

      const numDays = parseDurationToDays(duration);
      if (numDays === 0 || dayNumber < 1 || dayNumber > numDays) {
        return res.status(400).json({
          message: "Invalid day number or duration.",
        });
      }

      // Calculate current day hours
      const dayHours = currentDayActivities.reduce(
        (sum, a) => sum + (a.average_duration_hours || 0),
        0,
      );
      const remainingHours = Math.max(0, 8 - dayHours);

      if (remainingHours <= 0) {
        return res.status(400).json({
          message: "Day is already full (8 hours max).",
        });
      }

      // Fetch destinations
      const { data: destinations, error: destError } = await supabase
        .from("destinations")
        .select("id, name");

      if (destError) throw destError;

      const matchingDestinations = destinations.filter(
        (d) =>
          d.name.toLowerCase().includes(destination.toLowerCase()) ||
          destination.toLowerCase().includes(d.name.toLowerCase()),
      );

      if (matchingDestinations.length === 0) {
        return res.status(404).json({
          message: `No destinations found matching "${destination}".`,
        });
      }

      const destIds = matchingDestinations.map((d) => d.id);

      // Fetch attractions
      const { data: sightseeing, error: sightError } = await supabase
        .from("sightseeing")
        .select("*")
        .in("destination_id", destIds);

      if (sightError) throw sightError;

      // Filter out already added attractions by ID and name similarity
      const addedSightseeingIds = new Set(
        existingActivities.map((a) => a.sightseeing_id).filter(Boolean),
      );
      const addedAttractionNames = existingActivities
        .map((a) => a.name)
        .filter(Boolean);
      const currentDayAttractionNames = currentDayActivities
        .map((a) => a.name)
        .filter(Boolean);

      let availableAttractions = sightseeing.filter((s) => {
        // Filter by ID
        if (addedSightseeingIds.has(s.id)) return false;

        // Filter by name similarity (check both existing activities and current day)
        const allNames = [
          ...addedAttractionNames,
          ...currentDayAttractionNames,
        ];
        if (
          allNames.some((name) =>
            areAttractionsSimilar(name, s.attraction_name),
          )
        ) {
          return false;
        }

        return true;
      });

      // Apply day-specific constraints
      if (dayNumber === 1) {
        // Arrival day: Only activities after 5 PM, 2-3 hours OR Night-only after 6 PM
        availableAttractions = availableAttractions.filter((s) => {
          const hours = s.average_duration_hours || 0;
          return (hours >= 2 && hours <= 3) || s.tag === "Night-only";
        });
      } else if (dayNumber === numDays) {
        // Departure day: Only light 2-3 hour activities (morning only)
        availableAttractions = availableAttractions.filter((s) => {
          const hours = s.average_duration_hours || 0;
          return hours >= 2 && hours <= 3;
        });
      }

      // Check if day already has a long attraction (≥5 hours)
      const hasLongAttraction = currentDayActivities.some(
        (a) => (a.average_duration_hours || 0) >= 5,
      );
      if (hasLongAttraction) {
        availableAttractions = availableAttractions.filter(
          (s) => (s.average_duration_hours || 0) < 5,
        );
      }

      // Filter by remaining hours
      availableAttractions = availableAttractions.filter(
        (s) => (s.average_duration_hours || 0) <= remainingHours,
      );

      if (availableAttractions.length === 0) {
        return res.status(404).json({
          message: "No suitable attractions found for this day.",
        });
      }

      // Score attractions based on geo-clustering and best_time
      const scoredAttractions = availableAttractions.map((attraction) => {
        let score = 0;

        // Geo-clustering: prefer attractions close to existing ones
        const dayActivitiesWithCoords = currentDayActivities.filter(
          (a) => a.latitude && a.longitude,
        );
        if (
          dayActivitiesWithCoords.length > 0 &&
          attraction.latitude &&
          attraction.longitude
        ) {
          const minDistance = Math.min(
            ...dayActivitiesWithCoords.map((a) =>
              calculateDistance(
                a.latitude,
                a.longitude,
                attraction.latitude,
                attraction.longitude,
              ),
            ),
          );
          if (minDistance <= 12) {
            score += 10;
          } else {
            score -= 5;
          }
        } else if (currentDayActivities.length === 0) {
          score += 5;
        }

        // Best time matching
        if (currentDayActivities.length === 0) {
          if (attraction.best_time === "Morning") score += 5;
        } else {
          const usedTimes = currentDayActivities
            .map((a) => a.best_time)
            .filter(Boolean);
          if (!usedTimes.includes(attraction.best_time)) {
            score += 3;
          }
        }

        // Tag-based scoring
        if (attraction.tag === "Half-day" || attraction.tag === "Quick stop") {
          score += 2;
        }

        return { attraction, score };
      });

      // Sort by score and select attractions to fill the day
      const sortedAttractions = scoredAttractions.sort(
        (a, b) => b.score - a.score,
      );

      let currentDayHours = dayHours;
      const attractionsToAdd = [];

      for (const { attraction } of sortedAttractions) {
        const attractionHours = attraction.average_duration_hours || 0;
        if (currentDayHours + attractionHours <= 8) {
          attractionsToAdd.push(attraction);
          currentDayHours += attractionHours;

          if (attractionsToAdd.length >= 3 || currentDayHours >= 7) {
            break;
          }
        }
      }

      // Generate activities with time slots
      const generatedActivities = attractionsToAdd.map((attraction, index) => {
        const timeSlots = generateTimeSlots(
          attraction.opening_hours,
          attraction.best_time,
          attraction.average_duration_hours,
        );
        const selectedSlot = timeSlots[0] || { start: "09:00", end: "17:00" };

        // Adjust start time based on existing activities
        let startTime = selectedSlot.start;
        if (currentDayActivities.length > 0 && index === 0) {
          const lastActivity =
            currentDayActivities[currentDayActivities.length - 1];
          if (lastActivity.end_time) {
            const [lastHour, lastMin] = lastActivity.end_time
              .split(":")
              .map(Number);
            const nextHour = lastHour + 1;
            startTime = `${nextHour.toString().padStart(2, "0")}:${lastMin
              .toString()
              .padStart(2, "0")}`;
          }
        }

        // Calculate end time
        const [startH, startM] = startTime.split(":").map(Number);
        const durationMinutes = (attraction.average_duration_hours || 2) * 60;
        const endMinutes = startH * 60 + startM + durationMinutes;
        const endHour = Math.floor(endMinutes / 60);
        const endMin = endMinutes % 60;
        const endTime = `${endHour.toString().padStart(2, "0")}:${endMin
          .toString()
          .padStart(2, "0")}`;

        return {
          name: attraction.attraction_name,
          date: getDayDate(travelDate, dayNumber),
          day_number: dayNumber,
          start_time: startTime,
          end_time: endTime,
          duration: attraction.average_duration_hours
            ? `${attraction.average_duration_hours} hours`
            : "",
          is_shared: false,
          inclusions: "",
          exclusions: "",
          image_url:
            attraction.images && attraction.images.length > 0
              ? attraction.images[0]
              : "",
          tag: attraction.tag,
          opening_hours: attraction.opening_hours,
          average_duration_hours: attraction.average_duration_hours,
          latitude: attraction.latitude,
          longitude: attraction.longitude,
          category: attraction.category,
          best_time: attraction.best_time,
          sightseeing_id: attraction.id,
          warnings: [],
        };
      });

      console.log(
        `[Itinerary AI] Generated ${generatedActivities.length} suggestions for Day ${dayNumber} by ${currentUser.name}`,
      );

      res.json({
        success: true,
        activities: generatedActivities,
        summary: {
          day: dayNumber,
          activities_added: generatedActivities.length,
          hours_added: generatedActivities.reduce(
            (sum, a) => sum + (a.average_duration_hours || 0),
            0,
          ),
        },
      });
    } catch (error) {
      console.error("Error generating day suggestions:", error);
      res.status(500).json({
        message: error.message || "Failed to generate day suggestions.",
      });
    }
  },
);

// --- PDF CLEANUP API ENDPOINT ---
// Manual cleanup endpoint (for testing/admin use)
app.post("/api/admin/cleanup-pdfs", requireAuth, async (req, res) => {
  try {
    const currentUser = req.user;

    // Only Super Admin can trigger manual cleanup
    if (currentUser.role !== "Super Admin") {
      return res.status(403).json({
        message: "Forbidden: Super Admin access required.",
      });
    }

    const { dryRun = false } = req.body;

    logger.info("Manual PDF cleanup triggered", {
      userId: currentUser.id,
      userName: currentUser.name,
      dryRun,
    });

    const result = await cleanupOldPdfs({ dryRun });

    res.json({
      success: true,
      message: dryRun
        ? "Dry run completed. No files were deleted."
        : "PDF cleanup completed.",
      result,
    });
  } catch (error) {
    logger.error("Manual PDF cleanup failed", {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      message: `PDF cleanup failed: ${error.message}`,
    });
  }
});

// --- SERVER START ---
app.listen(PORT, () => {
  console.log(`✅ Secure API server listening on http://localhost:${PORT}`);
  listenForManualAssignments(); // Start listening for manual assignments.
  setupGlobalListeners(); // Start the global DB listeners (leads, assignments)

  // Start PDF cleanup scheduler
  scheduleDailyCleanup();
  console.log("✅ PDF cleanup scheduler started");

  // Start TBO static data refresh scheduler (every 15 days: 1st, 15th, last day of month)
  scheduleTboStaticDataRefresh();
  console.log("✅ TBO static data refresh scheduler started");

  // Lead status auto-sync: Voucher→On Travel when travel date is today; On Travel→Feedback after end date + 24h
  scheduleLeadStatusSync();
  // Stagnant enquiry notifications: Enquiry status for more than 2 business days (Mon–Sat, 48 business hours)
  scheduleStagnantEnquiryNotifications();

  // Start WhatsApp token monitoring (checks every 12 hours)
  if (WHATSAPP_TOKEN) {
    startTokenMonitoring(WHATSAPP_TOKEN, 12);
  } else {
    console.warn("[CRM] ⚠️ WHATSAPP_TOKEN not set, token monitoring disabled");
  }

  // Start customer notifications scheduler (birthdays and passport expiries)
  scheduleCustomerNotifications();
  console.log("✅ Customer notifications scheduler started");
});
