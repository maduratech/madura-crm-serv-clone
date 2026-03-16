import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

// Simple in-memory cache for TBO auth token
let tboTokenCache = {
  tokenId: null,
  expiresAt: 0,
};

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value;
}

// Normalize URLs - append endpoint paths if not already present
const TBO_AUTH_URL_RAW = getEnv("TBO_AUTH_URL"); // Base URL or full URL (e.g. https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate)
const TBO_SEARCH_URL_RAW = getEnv("TBO_AIR_SEARCH_URL"); // Base URL or full URL (e.g. https://searchapi.tboair.com or https://tboapi.travelboutiqueonline.com/AirAPI_V10/AirService.svc/rest/Search)
const TBO_API_VERSION = getEnv("TBO_API_VERSION", "V1"); // API version (default: V1) - used for new API structure: api/{apiVersion}/Search/Search

// Auto-append endpoint paths if not present
// TBO WCF services typically use /rest/ prefix for REST endpoints
// New API structure uses: api/{apiVersion}/Search/Search
const TBO_AUTH_URL = TBO_AUTH_URL_RAW?.endsWith("/rest/Authenticate")
  ? TBO_AUTH_URL_RAW
  : TBO_AUTH_URL_RAW?.endsWith("/Authenticate")
    ? TBO_AUTH_URL_RAW
    : `${TBO_AUTH_URL_RAW?.replace(/\/$/, "")}/rest/Authenticate`;

// Determine if using new API structure (searchapi.tboair.com) or old structure
const isNewApiStructure =
  TBO_SEARCH_URL_RAW?.includes("searchapi.tboair.com") ||
  TBO_SEARCH_URL_RAW?.includes("tboair.com");

// Build search URL based on API structure
let TBO_SEARCH_URL;
if (isNewApiStructure) {
  // New API structure: api/{apiVersion}/Search/Search
  const baseUrl = TBO_SEARCH_URL_RAW?.replace(/\/api\/.*$/, "").replace(
    /\/$/,
    "",
  );
  TBO_SEARCH_URL = TBO_SEARCH_URL_RAW?.includes("/api/")
    ? TBO_SEARCH_URL_RAW
    : `${baseUrl}/api/${TBO_API_VERSION}/Search/Search`;
} else {
  // Old API structure: /rest/Search
  TBO_SEARCH_URL = TBO_SEARCH_URL_RAW?.endsWith("/rest/Search")
    ? TBO_SEARCH_URL_RAW
    : TBO_SEARCH_URL_RAW?.endsWith("/Search")
      ? TBO_SEARCH_URL_RAW
      : `${TBO_SEARCH_URL_RAW?.replace(/\/$/, "")}/rest/Search`;
}

// TBO Hotel API URLs
// Based on TBO Hotel API v10.0 documentation: https://apidoc.tektravels.com/hotelnew/
// Common endpoint patterns:
// - https://api.travelboutiqueonline.com/HotelAPI/HotelService.svc/rest/Search
// - https://affiliate.travelboutiqueonline.com/HotelAPI/HotelService.svc/rest/Search
// - https://api.travelboutiqueonline.com/TBOHolidays_HotelAPI/HotelService.svc/rest/Search
const TBO_HOTEL_SEARCH_URL_RAW = getEnv("TBO_HOTEL_SEARCH_URL");
// Construct Hotel API URL - handle various formats and try multiple endpoint variations
let TBO_HOTEL_SEARCH_URL = null;
if (TBO_HOTEL_SEARCH_URL_RAW) {
  if (TBO_HOTEL_SEARCH_URL_RAW.endsWith("/rest/Search")) {
    TBO_HOTEL_SEARCH_URL = TBO_HOTEL_SEARCH_URL_RAW;
  } else if (TBO_HOTEL_SEARCH_URL_RAW.endsWith("/Search")) {
    TBO_HOTEL_SEARCH_URL = TBO_HOTEL_SEARCH_URL_RAW;
  } else if (TBO_HOTEL_SEARCH_URL_RAW.includes("/HotelService.svc")) {
    // Already has service path, just append /rest/Search
    TBO_HOTEL_SEARCH_URL = `${TBO_HOTEL_SEARCH_URL_RAW.replace(/\/$/, "")}/rest/Search`;
  } else if (TBO_HOTEL_SEARCH_URL_RAW.includes("/HotelAPI")) {
    // Has /HotelAPI but missing service path, add HotelService.svc/rest/Search
    TBO_HOTEL_SEARCH_URL = `${TBO_HOTEL_SEARCH_URL_RAW.replace(/\/$/, "")}/HotelService.svc/rest/Search`;
  } else if (TBO_HOTEL_SEARCH_URL_RAW.includes("/TBOHolidays_HotelAPI")) {
    // Has /TBOHolidays_HotelAPI, add HotelService.svc/rest/Search
    TBO_HOTEL_SEARCH_URL = `${TBO_HOTEL_SEARCH_URL_RAW.replace(/\/$/, "")}/HotelService.svc/rest/Search`;
  } else {
    // Base URL only, try common patterns
    const base = TBO_HOTEL_SEARCH_URL_RAW.replace(/\/$/, "");
    // Try standard HotelAPI path first
    TBO_HOTEL_SEARCH_URL = `${base}/HotelAPI/HotelService.svc/rest/Search`;
  }
}

// Store base URLs for fallback attempts
const TBO_AUTH_BASE = TBO_AUTH_URL_RAW?.replace(
  /\/rest\/Authenticate$/,
  "",
).replace(/\/Authenticate$/, "");
// Extract base URL for search - handle both new and old API structures
const TBO_SEARCH_BASE = isNewApiStructure
  ? TBO_SEARCH_URL_RAW?.replace(/\/api\/.*$/, "").replace(/\/$/, "")
  : TBO_SEARCH_URL_RAW?.replace(/\/rest\/Search$/, "").replace(/\/Search$/, "");

const TBO_CLIENT_ID = getEnv("TBO_CLIENT_ID");
const TBO_USER_ID = getEnv("TBO_USER_ID");
const TBO_PASSWORD = getEnv("TBO_PASSWORD");
// TBO_END_USER_IP should be your server's PUBLIC IP address (not private IP like 192.168.x.x)
// TBO will whitelist this IP. Default to empty string if not set (TBO may detect it automatically)
const TBO_END_USER_IP = getEnv("TBO_END_USER_IP", "");

function ensureTboConfigured() {
  if (
    !TBO_AUTH_URL ||
    !TBO_SEARCH_URL ||
    !TBO_CLIENT_ID ||
    !TBO_USER_ID ||
    !TBO_PASSWORD
  ) {
    throw new Error(
      "TBO credentials / URLs are not fully configured. Please set TBO_AUTH_URL, TBO_AIR_SEARCH_URL, TBO_CLIENT_ID, TBO_USER_ID, TBO_PASSWORD in the environment.",
    );
  }

  // Warn if password might be truncated due to # character (common .env file issue)
  // Passwords with special characters like # should be wrapped in quotes in .env file
  if (TBO_PASSWORD && TBO_PASSWORD.length < 8) {
    console.warn(
      `[TBO] Warning: Password seems short (${TBO_PASSWORD.length} chars). If your password contains special characters like #, wrap it in quotes in .env file: TBO_PASSWORD="your#password"`,
    );
  }
}

async function authenticateTbo() {
  ensureTboConfigured();

  // Return cached token if still valid (with 60s buffer)
  if (tboTokenCache.tokenId && Date.now() < tboTokenCache.expiresAt - 60_000) {
    return tboTokenCache.tokenId;
  }

  const body = {
    ClientId: TBO_CLIENT_ID,
    UserName: TBO_USER_ID,
    Password: TBO_PASSWORD,
    // Only include EndUserIp if it's set (TBO may auto-detect if not provided)
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
  };

  // Log the request details (mask password for security)
  console.log(`[TBO Auth] Attempting authentication to: ${TBO_AUTH_URL}`);
  console.log(
    `[TBO Auth] ClientId: ${TBO_CLIENT_ID}, UserName: ${TBO_USER_ID}, Password length: ${TBO_PASSWORD?.length || 0}`,
  );
  console.log(
    `[TBO Auth] EndUserIp being sent: ${TBO_END_USER_IP || "(not set - TBO will auto-detect)"}`,
  );

  // Warn if using private IP
  if (
    TBO_END_USER_IP &&
    (TBO_END_USER_IP.startsWith("192.168.") ||
      TBO_END_USER_IP.startsWith("10.") ||
      TBO_END_USER_IP.startsWith("172.16.") ||
      TBO_END_USER_IP === "127.0.0.1" ||
      TBO_END_USER_IP === "localhost")
  ) {
    console.warn(
      `[TBO Auth] ⚠️ WARNING: TBO_END_USER_IP is set to a private/local IP (${TBO_END_USER_IP}). TBO requires your PUBLIC IP address (e.g., 147.93.97.219). Update TBO_END_USER_IP in your .env file to your server's public IP.`,
    );
  }

  const response = await fetch(TBO_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => "");
  console.log(`[TBO Auth] Response status: ${response.status}`);
  console.log(
    `[TBO Auth] Response headers:`,
    Object.fromEntries(response.headers.entries()),
  );
  console.log(
    `[TBO Auth] Response body (first 500 chars):`,
    responseText.slice(0, 500),
  );

  if (!response.ok) {
    throw new Error(
      `TBO Authenticate failed (${response.status}) for URL ${TBO_AUTH_URL}: ${responseText || "Unknown error"}`,
    );
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    // If response is not JSON, it might be HTML (like the WCF metadata page)
    if (
      responseText.includes("Windows Communication Foundation") ||
      responseText.includes("WCF")
    ) {
      throw new Error(
        `TBO Authenticate endpoint returned WCF metadata page instead of JSON. This usually means:\n` +
          `1. The endpoint URL is incorrect (try adding /rest/Authenticate or /Authenticate)\n` +
          `2. TBO requires SOAP instead of REST\n` +
          `3. The service endpoint path is different\n` +
          `Current URL: ${TBO_AUTH_URL}\n` +
          `Response preview: ${responseText.slice(0, 200)}`,
      );
    }
    throw new Error(
      `TBO Authenticate response is not valid JSON: ${responseText.slice(0, 300)}`,
    );
  }

  if (!json.TokenId && !json.tokenId) {
    // Check for authentication errors
    if (
      json.Error?.ErrorMessage?.includes("Username or Password") ||
      json.Status === 4
    ) {
      const passwordHint =
        TBO_PASSWORD.length < 10
          ? ` (Password length: ${TBO_PASSWORD.length} chars - if your password contains # or other special chars, wrap it in quotes in .env: TBO_PASSWORD="your#password")`
          : "";
      throw new Error(
        `TBO Authentication failed: ${json.Error?.ErrorMessage || "Incorrect Username or Password"}${passwordHint}`,
      );
    }
    // Status 2 = Not authorized
    if (json.Status === 2) {
      throw new Error(
        `TBO Authentication failed: ${json.Error?.ErrorMessage || "You are not authorized to access TBO API"}\n` +
          `This usually means:\n` +
          `1. Your account (ClientId: ${TBO_CLIENT_ID}, UserId: ${TBO_USER_ID}) is not enabled for API access\n` +
          `2. Your IP address (${TBO_END_USER_IP || "auto-detected"}) is not whitelisted\n` +
          `   ⚠️ If you see a private IP like 192.168.x.x, update TBO_END_USER_IP in .env to your PUBLIC IP (147.93.97.219)\n` +
          `3. You need to contact TBO support to enable API access for your account\n` +
          `Full response: ${JSON.stringify(json)}`,
      );
    }
    throw new Error(
      `TBO Authenticate response missing TokenId: ${JSON.stringify(json).slice(
        0,
        300,
      )}`,
    );
  }

  const tokenId = json.TokenId || json.tokenId;
  // TBO typically returns a "validity" or we just cache for 20 minutes by default
  const expiresInMinutes = json.ExpiryInMinutes || 20;

  tboTokenCache = {
    tokenId,
    expiresAt: Date.now() + expiresInMinutes * 60_000,
  };

  return tokenId;
}

function mapCabinToTboClass(cabin) {
  // TBO FlightCabinClass enumeration:
  // 1 = All, 2 = Economy, 3 = PremiumEconomy, 4 = Business, 5 = PremiumBusiness, 6 = First
  const normalized = (cabin || "ECONOMY").toString().toUpperCase();
  switch (normalized) {
    case "ALL":
      return 1;
    case "ECONOMY":
      return 2;
    case "PREMIUM_ECONOMY":
    case "PREMIUM ECONOMY":
      return 3;
    case "BUSINESS":
      return 4;
    case "PREMIUM_BUSINESS":
    case "PREMIUM BUSINESS":
      return 5;
    case "FIRST":
      return 6;
    default:
      return 2; // Default to Economy (2) instead of All (1)
  }
}

/**
 * TBO Air Flight Search (Synchronous)
 *
 * Supports both old and new API structures:
 * - Old: /rest/Search (e.g., https://api-stage.tboair.com/InternalAirService.svc/rest/Search/)
 * - New: api/{apiVersion}/Search/Search (e.g., https://searchapi.tboair.com/api/V1/Search/Search)
 *
 * Request Requirements:
 * - BookingMode: 5 (mandatory)
 * - PreferredDepartureTime/PreferredArrivalTime: yyyy-MM-ddTHH:mm:ss or yyyy-MM-dd (for any time)
 * - FlightCabinClass: 1=All, 2=Economy, 3=PremiumEconomy, 4=Business, 5=PremiumBusiness, 6=First
 *
 * See: https://searchapi.tboair.com/Help/ApiDetails/POST-api-apiVersion-Search-Search
 *
 * @param {Object} searchParams - Search parameters
 * @param {Array} searchParams.segments - Array of {from, to, date, departureTime?, arrivalTime?}
 * @param {Object} searchParams.passengers - {adults, children, infants}
 * @param {string} searchParams.tripType - "oneway" | "roundtrip" | "multicity"
 * @param {string} searchParams.cabin - "ECONOMY" | "BUSINESS" | "FIRST" | etc.
 * @param {boolean} searchParams.directFlights - Filter for direct flights only
 * @param {boolean} searchParams.oneStopFlights - Filter for one-stop flights only
 * @param {string|Array} searchParams.preferredAirlines - Preferred airline codes
 * @param {Array} searchParams.sources - Airline sources ["GDS"], ["SG"], ["6E"], etc.
 * @returns {Promise<{results: Array, traceId: string}>} Search results
 */
export async function searchTboFlights(searchParams) {
  ensureTboConfigured();

  const tokenId = await authenticateTbo();

  const firstSegment = searchParams?.segments?.[0];
  if (!firstSegment?.from || !firstSegment?.to || !firstSegment?.date) {
    throw new Error("TBO search: missing from/to/date in segments[0].");
  }

  const adults = Number(searchParams.passengers?.adults || 1);
  const children = Number(searchParams.passengers?.children || 0);
  const infants = Number(searchParams.passengers?.infants || 0);

  const journeyType =
    searchParams.tripType === "roundtrip"
      ? 2
      : searchParams.tripType === "multicity"
        ? 3
        : 1; // 1: Oneway, 2: Return, 3: Multicity (convention used by TBO docs)

  const cabinClass = mapCabinToTboClass(searchParams.cabin);

  // Format date for TBO API: yyyy-MM-ddTHH:mm:ss or yyyy-MM-dd for any time
  // If time is provided, use full datetime; otherwise use just date
  const formatTboDateTime = (dateStr, timeStr = null) => {
    if (!dateStr) return null;
    // If date is already in full format, return as-is
    if (dateStr.includes("T")) return dateStr;
    // If time is provided, combine date and time
    if (timeStr && timeStr !== "00:00:00") {
      return `${dateStr}T${timeStr}`;
    }
    // For "any time", use just the date (yyyy-MM-dd)
    return dateStr;
  };

  // Build segments array
  let segments = (searchParams.segments || []).map((seg) => {
    const depTime = formatTboDateTime(seg.date, seg.departureTime || null);
    const arrTime =
      formatTboDateTime(seg.date, seg.arrivalTime || null) ||
      formatTboDateTime(seg.date);

    if (!seg.from || !seg.to || !depTime) {
      throw new Error(
        `Invalid segment: Missing required fields (from: ${seg.from}, to: ${seg.to}, date: ${seg.date})`,
      );
    }

    return {
      Origin: seg.from,
      Destination: seg.to,
      FlightCabinClass: cabinClass,
      // TBO expects: yyyy-MM-ddTHH:mm:ss (full datetime) or yyyy-MM-dd (any time)
      // Examples: "2026-03-18" (any time), "2024-07-26T00:00:00" (specific time)
      PreferredDepartureTime: depTime,
      PreferredArrivalTime: arrTime,
    };
  });

  // Validate segments
  if (segments.length === 0) {
    throw new Error(
      "Invalid segment length: At least one segment is required.",
    );
  }

  // For roundtrip flights (JourneyType: 2), TBO expects 2 segments: outbound and return
  // Add return segment (Destination -> Origin on returnDate)
  if (journeyType === 2 && searchParams.returnDate) {
    if (segments.length === 0) {
      throw new Error(
        "Invalid segment length: Outbound segment is required for roundtrip flights.",
      );
    }
    const firstSegment = segments[0];
    if (!firstSegment.Origin || !firstSegment.Destination) {
      throw new Error(
        "Invalid segment: Origin and Destination are required for roundtrip flights.",
      );
    }
    const returnSegment = {
      Origin: firstSegment.Destination, // Return from destination
      Destination: firstSegment.Origin, // Return to origin
      FlightCabinClass: cabinClass,
      PreferredDepartureTime: formatTboDateTime(searchParams.returnDate, null),
      PreferredArrivalTime: formatTboDateTime(searchParams.returnDate, null),
    };
    segments.push(returnSegment);
    console.log(
      `[TBO Search] Roundtrip: Added return segment ${returnSegment.Origin} -> ${returnSegment.Destination} on ${searchParams.returnDate}`,
    );
    console.log(
      `[TBO Search] Total segments: ${segments.length} (expected: 2 for roundtrip)`,
    );
  } else if (journeyType === 2 && !searchParams.returnDate) {
    throw new Error(
      "Invalid segment length: returnDate is required for roundtrip flights.",
    );
  }

  // Log segment structure for debugging
  console.log(
    `[TBO Search] JourneyType: ${journeyType}, Segments count: ${segments.length}`,
  );
  segments.forEach((seg, idx) => {
    console.log(
      `[TBO Search] Segment ${idx + 1}: ${seg.Origin} -> ${seg.Destination}, Departure: ${seg.PreferredDepartureTime}`,
    );
  });

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    AdultCount: adults,
    ChildCount: children,
    InfantCount: infants,
    BookingMode: 5, // Mandatory: Booking mode value 5 must be passed to all relevant processes
    JourneyType: journeyType,
    DirectFlight: Boolean(searchParams.directFlights),
    OneStopFlight: Boolean(searchParams.oneStopFlights || false),
    Segments: segments,
    PreferredAirlines: searchParams.preferredAirlines
      ? Array.isArray(searchParams.preferredAirlines)
        ? searchParams.preferredAirlines
        : [searchParams.preferredAirlines]
      : null,
    Sources: searchParams.sources || null, // Airline Sources: ["GDS"], ["SG"], ["6E"], etc. null for all
  };

  // Special Fare mapping – single selection as per UI
  // Exact field names depend on TBO documentation; we simply forward the chosen fare type
  if (searchParams.fareType && searchParams.fareType !== "Regular") {
    body.SpecialFare = searchParams.fareType; // Forward as-is for now; adjust mapping as per TBO docs if needed
  }

  // Additional optional fields from TBO API documentation
  if (searchParams.isDomestic !== undefined) {
    body.IsDomestic = Boolean(searchParams.isDomestic);
  }
  if (searchParams.preferredCurrency) {
    body.PreferredCurrency = searchParams.preferredCurrency;
  }
  if (searchParams.resultFareType !== undefined) {
    body.ResultFareType = searchParams.resultFareType; // 0 for RegularFare, etc.
  }

  // Log request body for debugging (without sensitive data)
  console.log(`[TBO Search] Request URL: ${TBO_SEARCH_URL}`);
  console.log(
    `[TBO Search] Request body:`,
    JSON.stringify(
      {
        ...body,
        TokenId: body.TokenId
          ? `${body.TokenId.substring(0, 8)}...`
          : "missing",
        Segments: body.Segments.map((seg, idx) => ({
          index: idx + 1,
          Origin: seg.Origin,
          Destination: seg.Destination,
          FlightCabinClass: seg.FlightCabinClass,
          PreferredDepartureTime: seg.PreferredDepartureTime,
          PreferredArrivalTime: seg.PreferredArrivalTime,
        })),
      },
      null,
      2,
    ),
  );

  const response = await fetch(TBO_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => "");

  if (!response.ok) {
    console.error(
      `[TBO Search] HTTP Error (${response.status}):`,
      responseText.substring(0, 500),
    );
    throw new Error(
      `TBO Search failed (${response.status}): ${responseText || "Unknown error"}`,
    );
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    console.error(
      `[TBO Search] Invalid JSON response:`,
      responseText.substring(0, 500),
    );
    throw new Error(
      `TBO Search response is not valid JSON: ${responseText.substring(0, 300)}`,
    );
  }

  // TBO wraps response in a "Response" object
  const responseData = json.Response || json;
  const responseStatus = responseData.ResponseStatus;
  const error = responseData.Error;

  // Check for errors in the Response object
  if (responseStatus && responseStatus !== 1) {
    const errMsg =
      error?.ErrorMessage ||
      responseData.ErrorMessage ||
      `TBO search returned non-success status (${responseStatus}).`;
    console.error(`[TBO Search] TBO API Error:`, {
      ResponseStatus: responseStatus,
      ErrorCode: error?.ErrorCode,
      ErrorMessage: errMsg,
      FullResponse: JSON.stringify(responseData, null, 2).substring(0, 1000),
    });
    throw new Error(errMsg);
  }

  // TBO usually returns Results as a 2D array: Results[solutionGroup][solution]
  const rawResults = Array.isArray(responseData.Results)
    ? responseData.Results.flat().filter(Boolean)
    : [];

  // Attach source flag so the frontend can filter/label
  rawResults.forEach((r) => {
    r.Source = "TBO";
  });

  return {
    results: rawResults,
    traceId:
      responseData.TraceId ||
      responseData.TraceID ||
      json.TraceId ||
      json.TraceID ||
      "tbo",
  };
}

/**
 * TBO Air Flight Search (Asynchronous)
 *
 * Uses the new API structure: api/{apiVersion}/Search/SearchAsync
 * Requires TBO_AIR_SEARCH_URL to point to searchapi.tboair.com
 *
 * See: https://searchapi.tboair.com/Help/ApiDetails/POST-api-apiVersion-Search-SearchAsync
 *
 * @param {Object} searchParams - Search parameters
 * @returns {Promise<{traceId: string, sessionId?: string, status: number, message: string, results: Array}>}
 *   Search initiation response (may require polling for results)
 */
export async function searchTboFlightsAsync(searchParams) {
  ensureTboConfigured();

  const tokenId = await authenticateTbo();

  const firstSegment = searchParams?.segments?.[0];
  if (!firstSegment?.from || !firstSegment?.to || !firstSegment?.date) {
    throw new Error("TBO search: missing from/to/date in segments[0].");
  }

  const adults = Number(searchParams.passengers?.adults || 1);
  const children = Number(searchParams.passengers?.children || 0);
  const infants = Number(searchParams.passengers?.infants || 0);

  const journeyType =
    searchParams.tripType === "roundtrip"
      ? 2
      : searchParams.tripType === "multicity"
        ? 3
        : 1; // 1: Oneway, 2: Return, 3: Multicity

  const cabinClass = mapCabinToTboClass(searchParams.cabin);

  // Format date for TBO API: yyyy-MM-ddTHH:mm:ss or yyyy-MM-dd for any time
  const formatTboDateTime = (dateStr, timeStr = null) => {
    if (!dateStr) return null;
    if (dateStr.includes("T")) return dateStr;
    if (timeStr && timeStr !== "00:00:00") {
      return `${dateStr}T${timeStr}`;
    }
    return dateStr;
  };

  // Build segments array
  let segments = (searchParams.segments || []).map((seg) => {
    const depTime = formatTboDateTime(seg.date, seg.departureTime || null);
    const arrTime =
      formatTboDateTime(seg.date, seg.arrivalTime || null) ||
      formatTboDateTime(seg.date);

    if (!seg.from || !seg.to || !depTime) {
      throw new Error(
        `Invalid segment: Missing required fields (from: ${seg.from}, to: ${seg.to}, date: ${seg.date})`,
      );
    }

    return {
      Origin: seg.from,
      Destination: seg.to,
      FlightCabinClass: cabinClass,
      PreferredDepartureTime: depTime,
      PreferredArrivalTime: arrTime,
    };
  });

  // Validate segments
  if (segments.length === 0) {
    throw new Error(
      "Invalid segment length: At least one segment is required.",
    );
  }

  // For roundtrip flights (JourneyType: 2), TBO expects 2 segments: outbound and return
  // Add return segment (Destination -> Origin on returnDate)
  if (journeyType === 2 && searchParams.returnDate) {
    if (segments.length === 0) {
      throw new Error(
        "Invalid segment length: Outbound segment is required for roundtrip flights.",
      );
    }
    const firstSegment = segments[0];
    if (!firstSegment.Origin || !firstSegment.Destination) {
      throw new Error(
        "Invalid segment: Origin and Destination are required for roundtrip flights.",
      );
    }
    const returnSegment = {
      Origin: firstSegment.Destination, // Return from destination
      Destination: firstSegment.Origin, // Return to origin
      FlightCabinClass: cabinClass,
      PreferredDepartureTime: formatTboDateTime(searchParams.returnDate, null),
      PreferredArrivalTime: formatTboDateTime(searchParams.returnDate, null),
    };
    segments.push(returnSegment);
    console.log(
      `[TBO SearchAsync] Roundtrip: Added return segment ${returnSegment.Origin} -> ${returnSegment.Destination} on ${searchParams.returnDate}`,
    );
    console.log(
      `[TBO SearchAsync] Total segments: ${segments.length} (expected: 2 for roundtrip)`,
    );
  } else if (journeyType === 2 && !searchParams.returnDate) {
    throw new Error(
      "Invalid segment length: returnDate is required for roundtrip flights.",
    );
  }

  // Log segment structure for debugging
  console.log(
    `[TBO SearchAsync] JourneyType: ${journeyType}, Segments count: ${segments.length}`,
  );
  segments.forEach((seg, idx) => {
    console.log(
      `[TBO SearchAsync] Segment ${idx + 1}: ${seg.Origin} -> ${seg.Destination}, Departure: ${seg.PreferredDepartureTime}`,
    );
  });

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    AdultCount: adults,
    ChildCount: children,
    InfantCount: infants,
    BookingMode: 5, // Mandatory: Booking mode value 5 must be passed to all relevant processes
    JourneyType: journeyType,
    DirectFlight: Boolean(searchParams.directFlights),
    OneStopFlight: Boolean(searchParams.oneStopFlights || false),
    Segments: segments,
    PreferredAirlines: searchParams.preferredAirlines
      ? Array.isArray(searchParams.preferredAirlines)
        ? searchParams.preferredAirlines
        : [searchParams.preferredAirlines]
      : null,
    Sources: searchParams.sources || null,
  };

  if (searchParams.fareType && searchParams.fareType !== "Regular") {
    body.SpecialFare = searchParams.fareType;
  }

  // Additional optional fields
  if (searchParams.isDomestic !== undefined) {
    body.IsDomestic = Boolean(searchParams.isDomestic);
  }
  if (searchParams.preferredCurrency) {
    body.PreferredCurrency = searchParams.preferredCurrency;
  }
  if (searchParams.resultFareType !== undefined) {
    body.ResultFareType = searchParams.resultFareType;
  }

  // Build SearchAsync URL - only works with new API structure
  const searchAsyncUrl = isNewApiStructure
    ? `${TBO_SEARCH_BASE}/api/${TBO_API_VERSION}/Search/SearchAsync`
    : null;

  if (!searchAsyncUrl) {
    throw new Error(
      "TBO SearchAsync requires the new API structure (searchapi.tboair.com). " +
        "Please update TBO_AIR_SEARCH_URL to use the new API base URL.",
    );
  }

  const response = await fetch(searchAsyncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `TBO SearchAsync failed (${response.status}): ${responseText || "Unknown error"}`,
    );
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    throw new Error(
      `TBO SearchAsync response is not valid JSON: ${responseText.substring(0, 300)}`,
    );
  }

  // TBO wraps response in a "Response" object
  const responseData = json.Response || json;
  const responseStatus = responseData.ResponseStatus;
  const error = responseData.Error;

  if (responseStatus && responseStatus !== 1) {
    const errMsg =
      error?.ErrorMessage ||
      responseData.ErrorMessage ||
      `TBO SearchAsync returned non-success status (${responseStatus}).`;
    throw new Error(errMsg);
  }

  // SearchAsync typically returns a tracking ID or session ID for polling results
  // The actual results may need to be retrieved via a separate polling endpoint
  return {
    traceId:
      responseData.TraceId ||
      responseData.TraceID ||
      responseData.SessionId ||
      json.TraceId ||
      json.TraceID ||
      "tbo-async",
    sessionId: responseData.SessionId || responseData.SessionID,
    status: responseData.Status || responseStatus,
    message: responseData.Message || "Search initiated successfully",
    // If results are immediately available, include them
    results: Array.isArray(responseData.Results)
      ? responseData.Results.flat()
          .filter(Boolean)
          .map((r) => ({ ...r, Source: "TBO" }))
      : [],
  };
}

// TBO Airport/City Search
// Note: TBO AirService documentation doesn't list a dedicated airport/city search endpoint
// AirService handles: Air Search, Fare Rule, Fare Quote, SSR, Calendar Fare Search, Price RBD
// This function tries multiple possible endpoint variations, falls back to Amadeus if all fail
export async function searchTboAirports(query) {
  ensureTboConfigured();

  const tokenId = await authenticateTbo();

  // Use AirService base URL (AirAPI_V10) for airport/city search
  // AirService handles: Air Search, Fare Rule, Fare Quote, SSR, Calendar Fare Search, etc.
  const airServiceBase =
    TBO_SEARCH_BASE ||
    TBO_SEARCH_URL_RAW?.replace(/\/rest\/Search$/, "").replace(/\/Search$/, "");

  // Try multiple possible endpoint names
  const possibleEndpoints = [
    "GetCityAirport",
    "CityAirportSearch",
    "GetCityAirportList",
    "CitySearch",
  ];

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    SearchText: query.trim(),
  };

  let lastError = null;

  for (const endpoint of possibleEndpoints) {
    const cityAirportSearchUrl = `${airServiceBase}/rest/${endpoint}`;

    try {
      const response = await fetch(cityAirportSearchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        if (
          response.status === 404 &&
          endpoint !== possibleEndpoints[possibleEndpoints.length - 1]
        ) {
          // Try next endpoint
          continue;
        }
        const text = await response.text().catch(() => "");
        throw new Error(
          `TBO Airport Search failed (${response.status}): ${text || "Unknown error"}`,
        );
      }

      const json = await response.json().catch(() => ({}));

      // TBO wraps response in a "Response" object
      const responseData = json.Response || json;
      const responseStatus = responseData.ResponseStatus;

      if (responseStatus && responseStatus !== 1) {
        if (endpoint !== possibleEndpoints[possibleEndpoints.length - 1]) {
          // Try next endpoint
          continue;
        }
        const errMsg =
          responseData.Error?.ErrorMessage ||
          responseData.ErrorMessage ||
          `TBO airport search returned non-success status (${responseStatus}).`;
        throw new Error(errMsg);
      }

      // TBO typically returns CityAirportList, CityList, or AirportList as an array
      const airports = Array.isArray(responseData.CityAirportList)
        ? responseData.CityAirportList
        : Array.isArray(responseData.CityList)
          ? responseData.CityList
          : Array.isArray(responseData.AirportList)
            ? responseData.AirportList
            : Array.isArray(responseData.Results)
              ? responseData.Results
              : [];

      // Transform TBO format to our standard format
      return airports.map((item) => ({
        code: item.AirportCode || item.Code || item.IATACode || "",
        name: item.AirportName || item.Name || item.CityName || "",
        city: item.CityName || item.City || "",
        country: item.CountryName || item.Country || "",
      }));
    } catch (error) {
      lastError = error;
      // Continue to next endpoint if this one fails
      if (endpoint !== possibleEndpoints[possibleEndpoints.length - 1]) {
        continue;
      }
    }
  }

  // If all endpoints failed, throw the last error
  if (lastError) {
    console.error(
      "[TBO Client] All airport search endpoints failed:",
      lastError.message,
    );
    throw lastError;
  }

  throw new Error("TBO airport search: No valid endpoint found");
}

/**
 * TBO Hotel Search (GetHotelResult Method)
 * Based on official TBO Hotel API certification documentation
 * Service URL: https://affiliate.tektravels.com/HotelAPI/Search
 *
 * Note: This method requires HotelCodes (comma-separated list of TBO hotel codes).
 * For city-based search, you need to first get hotel codes for the city, then search.
 * Recommended: Send parallel searches for 100 hotel codes chunks in each search request.
 *
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.hotelCodes - Comma-separated list of TBO hotel codes (required, max 100 per request)
 * @param {string} searchParams.checkIn - Check-in date (YYYY-MM-DD)
 * @param {string} searchParams.checkOut - Check-out date (YYYY-MM-DD)
 * @param {Array} searchParams.rooms - Array of room configurations [{ adults, children, childAges }]
 * @param {string} searchParams.nationality - Guest nationality code ISO 3166-1 alpha-2 (default: "IN")
 * @param {number} searchParams.responseTime - Expected response time in seconds (optional)
 * @param {boolean} searchParams.isDetailedResponse - Get detailed response with day-wise breakup (default: false)
 * @param {Object} searchParams.filters - Filter options { refundable: boolean, mealType: "All"|"WithMeal"|"RoomOnly" }
 * @returns {Promise<{results: Array, traceId: string}>} Search results with TraceId
 */

/**
 * Normalize guest nationality to ISO 3166-1 alpha-2 (TBO expects 2-letter code, e.g. IN not "India").
 * @param {string} nationality - Country name or code from client
 * @returns {string} Two-letter ISO code
 */
function normalizeNationalityToISO(nationality) {
  if (!nationality || typeof nationality !== "string") return "IN";
  const s = nationality.trim();
  if (s.length === 2 && /^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const nameToCode = {
    india: "IN",
    "united arab emirates": "AE",
    uae: "AE",
    usa: "US",
    "united states": "US",
    "united kingdom": "GB",
    uk: "GB",
    singapore: "SG",
    malaysia: "MY",
    srilanka: "LK",
    "sri lanka": "LK",
    thailand: "TH",
    indonesia: "ID",
    australia: "AU",
    canada: "CA",
    germany: "DE",
    france: "FR",
    japan: "JP",
    china: "CN",
    "hong kong": "HK",
    "saudi arabia": "SA",
    qatar: "QA",
    oman: "OM",
    kuwait: "KW",
    bahrain: "BH",
  };
  return nameToCode[s.toLowerCase()] || "IN";
}

/**
 * Helper function to process TBO hotel search response
 * Extracts and validates the response data
 * @private
 */
function processHotelSearchResponse(json) {
  // TBO wraps response in a "Response" object or uses Status object
  const responseData = json.Response || json;
  const status = responseData.Status || responseData.ResponseStatus;
  const error =
    responseData.Error || (status && status.Code !== 1 ? status : null);

  // Check for errors in the Response object
  // Status.Code: 200 = Successful with results (per TBO GetHotelResult documentation)
  // Status.Code: 201 = No Available rooms for given criteria (valid response, not an error)
  // Status.Code: 1 = Success (alternative success code used by some TBO APIs)
  const isSuccess =
    status &&
    (status.Code === 200 ||
      status.Code === 201 ||
      status.Code === 1 ||
      (status.Description &&
        status.Description.toLowerCase().includes("success")));

  // Only throw error for actual failure codes
  // 201 means "no results found" which is a valid response, not an error
  const isActualError =
    status && status.Code && !isSuccess && status.Code !== 201;

  if (isActualError) {
    const errMsg =
      status.Description ||
      error?.ErrorMessage ||
      `TBO hotel search returned error code ${status.Code}.`;
    console.error(`[TBO Hotel] API Error:`, {
      Code: status.Code,
      Description: status.Description,
      ErrorMessage: error?.ErrorMessage,
    });
    throw new Error(errMsg);
  }

  // Log when no rooms are available (Code 201)
  if (status && status.Code === 201) {
    console.log(
      `[TBO Hotel] No available rooms for the given criteria. This is a valid response.`,
    );
  }

  // TBO hotel results structure according to GetHotelResult Response
  let rawResults = [];
  if (Array.isArray(responseData.HotelResult)) {
    rawResults = responseData.HotelResult;
  } else if (Array.isArray(json.HotelResult)) {
    rawResults = json.HotelResult;
  } else if (Array.isArray(responseData)) {
    rawResults = responseData;
  }

  // Attach source flag
  rawResults.forEach((r) => {
    r.Source = "TBO";
  });

  console.log(
    `[TBO Hotel] Search successful: Found ${rawResults.length} hotels`,
  );

  return {
    results: rawResults,
    traceId: "tbo-hotel",
  };
}

export async function searchTboHotels(searchParams) {
  ensureTboConfigured();

  // TBO Hotel API endpoints
  // GetHotelResult: Uses TBO_HOTEL_SEARCH_URL if configured (requires hotelCodes)
  // Falls back to: https://api.travelboutiqueonline.com/HotelAPI/HotelService.svc/rest/Search
  const TBO_HOTEL_GET_RESULT_ENDPOINT =
    TBO_HOTEL_SEARCH_URL ||
    "https://api.travelboutiqueonline.com/HotelAPI/HotelService.svc/rest/Search";

  const tokenId = await authenticateTbo();

  const {
    hotelCodes, // New API: comma-separated list of TBO hotel codes (required for GetHotelResult)
    city, // Legacy: city name (for city-based search fallback)
    checkIn,
    checkOut,
    rooms = [{ adults: 2, children: 0, childAges: [] }],
    nationality: nationalityParam = "IN", // May be "India" from UI; normalized to ISO alpha-2 for TBO
    countryCode, // Optional: Filter cities by country code (e.g., "IN" for India)
    responseTime,
    isDetailedResponse = false,
    filters = {},
    searchTerm, // Legacy: hotel name filter
    starRatings = [], // Legacy: star rating filter
    currency = "INR", // Legacy: currency
    resultCount = 50, // Legacy: result count
  } = searchParams;

  // TBO requires ISO 3166-1 alpha-2 (e.g. IN). Frontend often sends "India" – normalize.
  const nationality = normalizeNationalityToISO(nationalityParam);

  // Use countryCode if provided, otherwise use normalized nationality for city filtering (DB has ISO codes)
  const cityCountryCode = countryCode || nationality;

  // Validate required parameters
  if (!checkIn || !checkOut) {
    throw new Error(
      "TBO hotel search: missing required parameters (checkIn or checkOut).",
    );
  }

  // TBO Hotel API has two methods:
  // 1. GetHotelResult - requires hotelCodes (new certification API) - RECOMMENDED
  // 2. HotelSearch - accepts city name (legacy/alternative method) - DEPRECATED

  // Priority: If hotelCodes are provided directly, use them immediately
  // Otherwise, if city is provided, try to get hotel codes from database
  let useGetHotelResult = !!hotelCodes;
  let finalHotelCodes = hotelCodes;

  // If hotelCodes provided directly, validate and use them
  if (hotelCodes) {
    const codesArray = hotelCodes
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    if (codesArray.length === 0) {
      throw new Error(
        "TBO hotel search: hotelCodes parameter must contain at least one hotel code.",
      );
    }
    finalHotelCodes = codesArray.join(",");
    useGetHotelResult = true;
    console.log(
      `[TBO Hotel] Using ${codesArray.length} hotel codes provided; will search in batches of 100.`,
    );
  } else if (city) {
    // Use only locally stored static data (provider recommendation: do not call static data with search).
    // Hotel codes are stored in DB and refreshed every 14–15 days via scripts/refreshTboStaticData.js or scheduleTboRefresh.js
    console.log(
      `[TBO Hotel] Resolving city and hotel codes from local database for: ${city}${cityCountryCode ? ` (country: ${cityCountryCode})` : ""}`,
    );

    try {
      const supabase = getSupabaseClient();

      // Clean city name: remove state/province info, handle slashes
      let cleanCityName = city.trim();
      const commaIndex = cleanCityName.indexOf(",");
      if (commaIndex > 0) {
        cleanCityName = cleanCityName.substring(0, commaIndex).trim();
      }
      cleanCityName = cleanCityName.replace(/\s+/g, " ").trim();

      const searchTerms = cleanCityName.includes("/")
        ? [
            ...cleanCityName
              .split("/")
              .map((p) => p.trim())
              .filter((p) => p.length > 0),
            cleanCityName.replace(/\//g, " ").trim(),
          ]
        : [cleanCityName];
      const uniqueSearchTerms = [
        ...new Set(searchTerms.filter((t) => t.length > 0)),
      ];

      let cityResult = null;
      for (const term of uniqueSearchTerms) {
        const termLower = term.toLowerCase();
        if (cityCountryCode && cityCountryCode.length === 2) {
          cityResult = await supabase
            .from("tbo_cities")
            .select("code, name, country_code")
            .ilike("name", `%${termLower}%`)
            .eq("country_code", cityCountryCode.toUpperCase())
            .limit(10);
          if (cityResult.data?.length) break;
        }
        cityResult = await supabase
          .from("tbo_cities")
          .select("code, name, country_code")
          .ilike("name", `%${termLower}%`)
          .limit(10);
        if (cityResult.data?.length) break;
      }

      if (!cityResult?.data?.length) {
        const { count } = await supabase
          .from("tbo_cities")
          .select("code", { count: "exact", head: true });
        const cityCount = count ?? 0;
        if (cityCount === 0) {
          throw new Error(
            "No cities in database. Run: node scripts/refreshTboStaticData.js (refresh static data every 14–15 days).",
          );
        }
        throw new Error(
          `City "${city}" not found in database. Ensure the city is correct or run: node scripts/refreshTboStaticData.js`,
        );
      }

      const cityData = cityResult.data[0];
      console.log(
        `[TBO Hotel] Using city: "${cityData.name}" (code: ${cityData.code})`,
      );

      // Get hotel codes from local DB only (no TBO API call for static data)
      const codes = await getTboHotelCodesByCityCode(cityData.code);
      if (!codes.length) {
        throw new Error(
          `No hotel codes in database for "${cityData.name}". ` +
            `Refresh static data every 14–15 days: node scripts/refreshTboStaticData.js or node scripts/scheduleTboRefresh.js`,
        );
      }

      finalHotelCodes = codes.join(",");
      useGetHotelResult = true;
      console.log(
        `[TBO Hotel] Using ${codes.length} hotel codes from local DB (no static API call). Will search in batches of 100.`,
      );
    } catch (error) {
      const errorMsg =
        `TBO Hotel: ${error.message} ` +
        `(Static data is stored locally; refresh every 14–15 days.)`;
      console.error(`[TBO Hotel] ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  if (useGetHotelResult && !finalHotelCodes) {
    throw new Error(
      "TBO hotel search: hotelCodes parameter is required for GetHotelResult method.",
    );
  }

  if (!useGetHotelResult && !city) {
    throw new Error(
      "TBO hotel search: Either hotelCodes or city parameter is required.",
    );
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(checkIn) || !dateRegex.test(checkOut)) {
    throw new Error(
      "TBO hotel search: checkIn and checkOut must be in YYYY-MM-DD format.",
    );
  }

  // Validate check-out is after check-in
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  if (checkOutDate <= checkInDate) {
    throw new Error(
      "TBO hotel search: checkOut date must be after checkIn date.",
    );
  }

  // Validate and chunk hotel codes (API allows max 100 per request; we send multiple batches and merge)
  let hotelCodesArray = [];
  if (useGetHotelResult && finalHotelCodes) {
    hotelCodesArray = finalHotelCodes
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean);
    if (hotelCodesArray.length === 0) {
      throw new Error(
        "TBO hotel search: hotelCodes must contain at least one hotel code.",
      );
    }
  }

  const BATCH_SIZE = 100;
  const chunks = [];
  for (let i = 0; i < hotelCodesArray.length; i += BATCH_SIZE) {
    chunks.push(hotelCodesArray.slice(i, i + BATCH_SIZE));
  }

  let body;
  let endpoint;

  if (useGetHotelResult) {
    // Base request body (HotelCodes set per batch)
    body = {
      TokenId: tokenId,
      CheckIn: checkIn,
      CheckOut: checkOut,
      GuestNationality: nationality || "IN",
      PaxRooms: rooms.map((r) => {
        // Validate and enforce TBO API limits
        // Adults: 1-8 per room (per TBO documentation)
        const adults = Math.max(1, Math.min(8, r.adults || 2));
        // Children: 0-4 per room (per TBO documentation)
        const children = Math.max(0, Math.min(4, r.children || 0));
        // ChildrenAges: Array of ages (0-18 years), length must match number of children
        let childrenAges = r.childAges || [];
        // Ensure ages array length matches number of children
        if (childrenAges.length < children) {
          // Fill missing ages with default (6 years)
          while (childrenAges.length < children) {
            childrenAges.push(6);
          }
        } else if (childrenAges.length > children) {
          // Trim excess ages
          childrenAges = childrenAges.slice(0, children);
        }
        // Validate ages are between 0-18
        childrenAges = childrenAges.map((age) =>
          Math.max(0, Math.min(18, age)),
        );

        return {
          Adults: adults,
          Children: children,
          ChildrenAges: children > 0 ? childrenAges : null, // null if no children
        };
      }),
    };

    // Optional parameters
    if (responseTime !== undefined) {
      body.ResponseTime = responseTime;
    }

    if (isDetailedResponse !== undefined) {
      body.IsDetailedResponse = isDetailedResponse;
    } else {
      // Default to true for detailed response
      body.IsDetailedResponse = true;
    }

    // Filters object - must match exact structure from documentation
    body.Filters = {};
    if (filters.refundable !== undefined) {
      body.Filters.Refundable = Boolean(filters.refundable);
    } else {
      body.Filters.Refundable = false; // Default value
    }

    // NoOfRooms: 0 to get all rooms, or specific number (1, 2, etc.)
    // Set to 0 to get all available rooms from supplier
    body.Filters.NoOfRooms = 0;

    if (
      filters.mealType &&
      ["All", "WithMeal", "RoomOnly"].includes(filters.mealType)
    ) {
      body.Filters.MealType = filters.mealType;
    }

    // StarRating filter (if provided in starRatings parameter)
    if (starRatings && starRatings.length > 0) {
      const validStars = starRatings.filter((s) => s >= 1 && s <= 5);
      if (validStars.length > 0) {
        body.Filters.StarRating = validStars.join(",");
      }
    }

    endpoint = TBO_HOTEL_GET_RESULT_ENDPOINT;

    console.log(`[TBO Hotel] GetHotelResult: ${chunks.length} batch(es), ${hotelCodesArray.length} total codes`, {
      URL: endpoint,
      CheckIn: checkIn,
      CheckOut: checkOut,
      GuestNationality: nationality,
    });
  } else {
    // Legacy city-based search is deprecated - GetHotelResult requires hotelCodes
    // This code path should not be reached if hotelCodes are properly retrieved from database
    throw new Error(
      "TBO hotel search: GetHotelResult method requires hotelCodes. " +
        "Please ensure hotel codes are indexed in the database by running: node scripts/refreshTboStaticData.js " +
        "Alternatively, provide hotelCodes directly in the search request.",
    );

    // Calculate nights
    const nights = Math.ceil(
      (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Build legacy request body (city-based)
    body = {
      ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
      TokenId: tokenId,
      CheckInDate: checkIn, // Format: YYYY-MM-DD
      CheckOutDate: checkOut, // Format: YYYY-MM-DD
      CityName: city, // City name
      GuestNationality: nationality || "IN",
      NoOfRooms: rooms.length || 1,
      RoomGuests: rooms.map((r) => ({
        NoOfAdults: r.adults || 2,
        NoOfChild: r.children || 0,
        ChildAge: r.childAges || [],
      })),
      PreferredCurrency: currency || "INR",
      ResultCount: Math.min(resultCount || 50, 100),
    };

    // Optional filters for legacy API
    if (searchTerm && searchTerm.trim()) {
      body.HotelName = searchTerm.trim();
    }

    if (starRatings && starRatings.length > 0) {
      const validStars = starRatings.filter((s) => s >= 1 && s <= 5);
      if (validStars.length > 0) {
        body.StarRating = validStars.join(",");
      }
    }

    endpoint = TBO_HOTEL_SEARCH_URL;

    // Log request for debugging
    console.log(`[TBO Hotel] Legacy city-based search request:`, {
      URL: endpoint,
      City: city,
      CheckIn: checkIn,
      CheckOut: checkOut,
      Rooms: rooms.length,
      Nights: nights,
      Currency: currency || "INR",
      ...(searchTerm ? { HotelName: searchTerm } : {}),
      ...(starRatings.length > 0 ? { StarRating: starRatings.join(",") } : {}),
    });
  }

  try {
    const hotelSearchAuth = Buffer.from(
      `${TBO_USER_ID}:${TBO_PASSWORD}`,
    ).toString("base64");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${hotelSearchAuth}`,
    };

    if (!useGetHotelResult || !endpoint) {
      throw new Error("TBO hotel search: GetHotelResult path not configured.");
    }

    // One request per chunk (max 100 codes per request); run in parallel
    const batchRequests = chunks.map((chunk) => {
      const batchBody = { ...body, HotelCodes: chunk.join(",") };
      return fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(batchBody),
      });
    });

    const batchResponses = await Promise.all(batchRequests);
    const allResults = [];
    const seenHotelCodes = new Set();

    for (let i = 0; i < batchResponses.length; i++) {
      const response = batchResponses[i];
      const responseText = await response.text().catch(() => "");

      if (!response.ok) {
        console.error(
          `[TBO Hotel] Batch ${i + 1}/${batchResponses.length} HTTP ${response.status}:`,
          responseText.substring(0, 300),
        );
        throw new Error(
          `TBO Hotel Search failed (${response.status}): ${responseText || "Unknown error"}`,
        );
      }

      let json;
      try {
        json = JSON.parse(responseText);
      } catch (e) {
        console.error(
          `[TBO Hotel] Batch ${i + 1} invalid JSON:`,
          responseText.substring(0, 300),
        );
        throw new Error("TBO Hotel Search response is not valid JSON.");
      }

      const parsed = processHotelSearchResponse(json);
      for (const hotel of parsed.results || []) {
        const code = hotel.HotelCode ?? hotel.HotelId;
        if (code != null && !seenHotelCodes.has(code)) {
          seenHotelCodes.add(code);
          allResults.push(hotel);
        }
      }
    }

    console.log(
      `[TBO Hotel] Search successful: Found ${allResults.length} hotels (${chunks.length} batch(es))`,
    );
    return { results: allResults, traceId: "tbo-hotel" };
  } catch (error) {
    console.error("[TBO Client] Error searching hotels:", error);
    throw error;
  }
}

/**
 * TBO Hotel Details by HotelCode (images, facilities).
 * Search response does not include images; this separate API returns ImageUrls.
 * @param {string|number} hotelCode - TBO hotel code
 * @returns {Promise<{ imageUrls: string[], facilities?: string[] }>}
 */
export async function getTboHotelDetails(hotelCode) {
  if (hotelCode == null || hotelCode === "") {
    throw new Error("getTboHotelDetails: hotelCode is required");
  }
  const code = String(hotelCode).trim();
  if (!code) throw new Error("getTboHotelDetails: hotelCode is required");

  if (!TBO_HOTEL_SEARCH_URL) {
    throw new Error("TBO_HOTEL_SEARCH_URL is not configured");
  }

  const base = TBO_HOTEL_SEARCH_URL.replace(/\/rest\/Search$/i, "").replace(/\/Search$/i, "");
  const urlsToTry = [
    `${base}/rest/HotelDetails`,
    `${base}/HotelDetails`,
    `${base}/rest/GetHotelDetails`,
    ...(base.includes("HotelService.svc")
      ? []
      : [`${base}/HotelService.svc/rest/HotelDetails`, `${base}/HotelService.svc/HotelDetails`]),
  ];
  const tokenId = await authenticateTbo();
  const auth = Buffer.from(`${TBO_USER_ID}:${TBO_PASSWORD}`).toString("base64");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Basic ${auth}`,
  };
  const body = { HotelCode: code, TokenId: tokenId };

  let text = "";
  let response;
  let lastUrl = "";
  for (const hotelDetailsUrl of urlsToTry) {
    lastUrl = hotelDetailsUrl;
    response = await fetch(hotelDetailsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    text = await response.text().catch(() => "");
    console.log(`[TBO Hotel] HotelDetails ${response.status} ${hotelDetailsUrl}`);
    if (response.ok) break;
    if (response.status === 404) continue;
    break;
  }

  if (!response.ok) {
    console.warn(`[TBO Hotel] HotelDetails failed for code ${code} (tried ${lastUrl}):`, text.substring(0, 300));
    return { imageUrls: [], facilities: [] };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { imageUrls: [], facilities: [] };
  }

  const data = json.Response || json.HotelDetailsResponse || json;
  const details = data.HotelDetails || data;
  const imageUrls = [];
  const imgList = details.ImageUrls || details.ImageUrlList;
  if (!imgList && typeof details === "object") {
    const topKeys = Object.keys(details).slice(0, 30);
    console.log(`[TBO Hotel] HotelDetails response keys (no ImageUrls/ImageUrlList):`, topKeys.join(", "));
  }
  if (imgList) {
    const raw = imgList.ImageUrl ?? imgList;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [raw].filter(Boolean);
    for (const u of list) {
      const url = typeof u === "string" ? u : u?.Url || u?.url;
      if (url && typeof url === "string" && /^https?:\/\//i.test(url)) imageUrls.push(url.trim());
    }
  }
  const facilities = [];
  const facList = details.HotelFacilities || details.Facilities;
  if (facList) {
    const raw = facList.HotelFacility ?? facList;
    const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [raw].filter(Boolean);
    for (const f of arr) {
      const name = typeof f === "string" ? f : f?.Name || f?.name;
      if (name) facilities.push(String(name));
    }
  }
  console.log(`[TBO Hotel] HotelDetails success for ${code}: ${imageUrls.length} images, ${facilities.length} facilities`);
  return { imageUrls, facilities };
}

/**
 * TBO Hotel Codes List (GetHotelCodes)
 * Gets list of TBO hotel codes for a city
 * Based on TBO Hotel API documentation: https://apidoc.tektravels.com/hotelnew/
 *
 * @param {Object} params - Parameters
 * @param {string} params.city - City name or city code
 * @param {string} params.countryCode - Optional country code
 * @returns {Promise<Array<string>>} Array of TBO hotel codes
 */
export async function getTboHotelCodes(params) {
  ensureTboConfigured();

  const tokenId = await authenticateTbo();
  const { city, countryCode } = params;

  if (!city) {
    throw new Error("TBO getHotelCodes: city parameter is required.");
  }

  // Try multiple possible endpoints for getting hotel codes
  const possibleEndpoints = [
    "https://affiliate.tektravels.com/HotelAPI/HotelCodes",
    "https://affiliate.tektravels.com/HotelAPI/TBOHotelCodeList",
    "https://affiliate.tektravels.com/HotelAPI/GetHotelCodes",
    "https://api.travelboutiqueonline.com/HotelAPI/HotelCodes",
  ];

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    CityName: city,
    ...(countryCode ? { CountryCode: countryCode } : {}),
  };

  let lastError = null;

  for (const endpoint of possibleEndpoints) {
    try {
      console.log(`[TBO Hotel] Trying to get hotel codes from: ${endpoint}`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text().catch(() => "");

      if (!response.ok) {
        if (
          response.status === 404 &&
          endpoint !== possibleEndpoints[possibleEndpoints.length - 1]
        ) {
          continue; // Try next endpoint
        }
        throw new Error(
          `TBO GetHotelCodes failed (${response.status}): ${responseText}`,
        );
      }

      const json = JSON.parse(responseText);
      const responseData = json.Response || json;

      // Extract hotel codes from response
      // Response structure may vary: HotelCodes, HotelCodeList, Results, etc.
      let hotelCodes = [];
      if (Array.isArray(responseData.HotelCodes)) {
        hotelCodes = responseData.HotelCodes;
      } else if (Array.isArray(responseData.HotelCodeList)) {
        hotelCodes = responseData.HotelCodeList;
      } else if (Array.isArray(responseData.Results)) {
        hotelCodes = responseData.Results;
      } else if (Array.isArray(responseData)) {
        hotelCodes = responseData;
      }

      // Extract codes if they're objects with a code property
      const codes = hotelCodes
        .map((item) =>
          typeof item === "string" ? item : item.HotelCode || item.Code || item,
        )
        .filter(Boolean);

      console.log(
        `[TBO Hotel] Found ${codes.length} hotel codes for city: ${city}`,
      );
      return codes;
    } catch (error) {
      lastError = error;
      if (endpoint !== possibleEndpoints[possibleEndpoints.length - 1]) {
        continue;
      }
    }
  }

  if (lastError) {
    console.error("[TBO Client] Error getting hotel codes:", lastError);
    throw new Error(
      `Failed to get hotel codes for city "${city}": ${lastError.message}`,
    );
  }

  throw new Error(`Failed to get hotel codes: All endpoint variations failed.`);
}

// TBO Hotel City Search (for autocomplete)
// Uses database lookup from tbo_cities table (recommended) or falls back to TBO API
// TBO HotelAPI CityList endpoint: http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList
// This endpoint uses basic authentication (static API credentials)
export async function searchTboHotelCities(query) {
  ensureTboConfigured();

  // First, try database lookup (fastest and recommended)
  try {
    const supabase = getSupabaseClient();
    const { data: dbCities, error: dbError } = await supabase
      .from("tbo_cities")
      .select("code, name, country_code, tbo_countries!inner(name)")
      .ilike("name", `%${query}%`)
      .limit(20);

    if (!dbError && dbCities && dbCities.length > 0) {
      return dbCities.map((c) => ({
        code: String(c.code),
        name: c.name,
        country: c.tbo_countries?.name || "",
        countryCode: c.country_code || "",
      }));
    }
  } catch (dbError) {
    console.log(
      `[TBO Hotel] Database city lookup failed, trying API: ${dbError.message}`,
    );
  }

  // Fallback to TBO API (requires static API credentials)
  // TBO HotelAPI CityList endpoint uses basic auth (static API credentials)
  const { username: staticUsername, password: staticPassword } =
    getStaticApiCredentials();

  if (!staticUsername || !staticPassword) {
    console.warn(
      "[TBO Hotel] Static API credentials not configured. Using database only.",
    );
    return [];
  }

  // TBO CityList endpoint (uses basic auth, not TokenId)
  const cityListUrl =
    "http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList";

  try {
    // Basic authentication for static data APIs
    const authString = Buffer.from(
      `${staticUsername}:${staticPassword}`,
    ).toString("base64");

    const response = await fetch(cityListUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${authString}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(
        `[TBO Hotel] City List API failed (${response.status}): ${text.substring(0, 200)}`,
      );
      // Return empty array instead of throwing - database lookup already tried
      return [];
    }

    const json = await response.json().catch(() => ({}));

    // TBO CityList response structure: { Status: { Code, Description }, CityList: [...] }
    const responseData = json.Response || json;
    const status = responseData.Status;

    if (status && status.Code && status.Code !== 1 && status.Code !== 200) {
      console.warn(
        `[TBO Hotel] City List API returned error: ${status.Description || status.Code}`,
      );
      return [];
    }

    const allCities = Array.isArray(responseData.CityList)
      ? responseData.CityList
      : Array.isArray(responseData)
        ? responseData
        : Array.isArray(json.CityList)
          ? json.CityList
          : [];

    // Filter cities by search query (client-side filtering since TBO returns all cities)
    const searchLower = query.trim().toLowerCase();
    const filteredCities = allCities.filter((item) => {
      const cityName = (item.CityName || item.Name || "").toLowerCase();
      const countryName = (
        item.CountryName ||
        item.Country ||
        ""
      ).toLowerCase();
      const cityCode = String(item.CityCode || item.Code || "").toLowerCase();
      return (
        cityName.includes(searchLower) ||
        countryName.includes(searchLower) ||
        cityCode.includes(searchLower)
      );
    });

    // Transform TBO format to our standard format
    return filteredCities.slice(0, 20).map((item) => ({
      code: String(item.CityCode || item.Code || ""),
      name: item.CityName || item.Name || "",
      country: item.CountryName || item.Country || "",
      countryCode: item.CountryCode || "",
    }));
  } catch (error) {
    console.error("[TBO Client] Error searching hotel cities:", error);
    // Return empty array instead of throwing - database lookup already tried
    return [];
  }
}

/**
 * TBO Hotel Pre-Book (Universal Hotel API v10.0)
 * Verifies price and availability before final booking
 *
 * @param {Object} params - Pre-book parameters
 * @param {string} params.TraceId - TraceId from search response
 * @param {string} params.ResultIndex - ResultIndex of selected hotel/room
 * @param {string} params.HotelCode - Hotel code
 * @param {string} params.HotelName - Hotel name
 * @param {string} params.GuestNationality - Guest nationality code
 * @param {Array} params.RoomDetails - Room details array
 * @returns {Promise<Object>} Pre-book response with price verification
 */
export async function preBookTboHotel(params) {
  ensureTboConfigured();

  if (!TBO_HOTEL_SEARCH_URL) {
    throw new Error("TBO_HOTEL_SEARCH_URL is not configured.");
  }

  const tokenId = await authenticateTbo();

  // Extract base URL for pre-book endpoint
  const baseUrl = TBO_HOTEL_SEARCH_URL.replace(/\/rest\/Search$/, "");
  const preBookUrl = `${baseUrl}/rest/PreBook`;

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    HotelCode: params.HotelCode,
    HotelName: params.HotelName,
    GuestNationality: params.GuestNationality || "IN",
    RoomDetails: params.RoomDetails || [],
  };

  try {
    const response = await fetch(preBookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `TBO Hotel Pre-Book failed (${response.status}): ${responseText}`,
      );
    }

    const json = JSON.parse(responseText);
    const responseData = json.Response || json;

    if (responseData.ResponseStatus && responseData.ResponseStatus !== 1) {
      throw new Error(
        responseData.Error?.ErrorMessage ||
          `TBO Pre-Book returned non-success status (${responseData.ResponseStatus}).`,
      );
    }

    return responseData;
  } catch (error) {
    console.error("[TBO Client] Error in hotel pre-book:", error);
    throw error;
  }
}

/**
 * TBO Hotel Book (Universal Hotel API v10.0)
 * Final booking confirmation
 *
 * @param {Object} params - Booking parameters
 * @param {string} params.TraceId - TraceId from search response
 * @param {string} params.ResultIndex - ResultIndex of selected hotel/room
 * @param {Object} params.GuestDetails - Guest information
 * @param {Object} params.PaymentInfo - Payment information
 * @returns {Promise<Object>} Booking confirmation response
 */
export async function bookTboHotel(params) {
  ensureTboConfigured();

  if (!TBO_HOTEL_SEARCH_URL) {
    throw new Error("TBO_HOTEL_SEARCH_URL is not configured.");
  }

  const tokenId = await authenticateTbo();

  const baseUrl = TBO_HOTEL_SEARCH_URL.replace(/\/rest\/Search$/, "");
  const bookUrl = `${baseUrl}/rest/Book`;

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    GuestDetails: params.GuestDetails,
    PaymentInfo: params.PaymentInfo,
  };

  try {
    const response = await fetch(bookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `TBO Hotel Book failed (${response.status}): ${responseText}`,
      );
    }

    const json = JSON.parse(responseText);
    const responseData = json.Response || json;

    if (responseData.ResponseStatus && responseData.ResponseStatus !== 1) {
      throw new Error(
        responseData.Error?.ErrorMessage ||
          `TBO Book returned non-success status (${responseData.ResponseStatus}).`,
      );
    }

    return responseData;
  } catch (error) {
    console.error("[TBO Client] Error in hotel booking:", error);
    throw error;
  }
}

/**
 * TBO Hotel Get Booking Details (Universal Hotel API v10.0)
 * Retrieves booking information by booking reference
 *
 * @param {Object} params - Query parameters
 * @param {string} params.BookingId - Booking ID or reference number
 * @returns {Promise<Object>} Booking details response
 */
export async function getTboHotelBookingDetails(params) {
  ensureTboConfigured();

  if (!TBO_HOTEL_SEARCH_URL) {
    throw new Error("TBO_HOTEL_SEARCH_URL is not configured.");
  }

  const tokenId = await authenticateTbo();

  const baseUrl = TBO_HOTEL_SEARCH_URL.replace(/\/rest\/Search$/, "");
  const bookingDetailsUrl = `${baseUrl}/rest/GetBookingDetails`;

  const body = {
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
    TokenId: tokenId,
    BookingId: params.BookingId,
  };

  try {
    const response = await fetch(bookingDetailsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `TBO Get Booking Details failed (${response.status}): ${responseText}`,
      );
    }

    const json = JSON.parse(responseText);
    const responseData = json.Response || json;

    if (responseData.ResponseStatus && responseData.ResponseStatus !== 1) {
      throw new Error(
        responseData.Error?.ErrorMessage ||
          `TBO Get Booking Details returned non-success status (${responseData.ResponseStatus}).`,
      );
    }

    return responseData;
  } catch (error) {
    console.error("[TBO Client] Error getting hotel booking details:", error);
    throw error;
  }
}

// ============================================================================
// TBO Static Data API Functions (Country List, City List, Hotel Code List)
// Data should be downloaded and indexed in database, refreshed every 15 days
// ============================================================================

// Static data API credentials (CountryList, CityList, HotelCodeList)
// Set TBO_STATIC_API_USERNAME and TBO_STATIC_API_PASSWORD in .env
// If not set, falls back to TBO_USERNAME and TBO_PASSWORD
// Note: Read dynamically to support dotenv.config() in scripts
function getStaticApiCredentials() {
  const username = getEnv("TBO_STATIC_API_USERNAME") || getEnv("TBO_USERNAME");
  const password = getEnv("TBO_STATIC_API_PASSWORD") || getEnv("TBO_PASSWORD");
  return { username, password };
}

// TBO Static Data API Base URL (configurable via .env)
const TBO_STATIC_API_BASE_URL = getEnv(
  "TBO_STATIC_API_BASE_URL",
  "http://api.tbotechnology.in/TBOHolidays_HotelAPI",
);

// Initialize Supabase client for database operations
let supabaseClient = null;
function getSupabaseClient() {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    supabaseClient = createClient(supabaseUrl, supabaseKey);
  }
  return supabaseClient;
}

/**
 * Fetch Country List from TBO Static Data API
 * GET http://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList
 *
 * @returns {Promise<Array<{code: string, name: string}>>} Array of countries
 */
export async function fetchTboCountryList() {
  try {
    const { username, password } = getStaticApiCredentials();

    if (!username || !password) {
      throw new Error(
        "TBO Static API credentials not configured. " +
          "Please set TBO_STATIC_API_USERNAME and TBO_STATIC_API_PASSWORD in .env file. " +
          "These are different from regular TBO search API credentials. " +
          "Contact TBO support to get static data API credentials.",
      );
    }

    const url = `${TBO_STATIC_API_BASE_URL}/CountryList`;
    console.log(`[TBO Static] Fetching country list from: ${url}`);
    console.log(
      `[TBO Static] Using username: ${username} (password length: ${password?.length || 0})`,
    );

    const auth = Buffer.from(`${username}:${password}`).toString("base64");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `[TBO Static] HTTP Error (${response.status}):`,
        errorText.substring(0, 500),
      );
      throw new Error(
        `TBO CountryList failed (${response.status}): ${errorText.substring(0, 200)}`,
      );
    }

    const json = await response.json();
    const responseData = json.Response || json;
    const status = responseData.Status || responseData;

    // Status.Code: 1 = Success, 200 = Success (per some TBO APIs)
    if (status.Code !== 1 && status.Code !== 200 && status.Code !== undefined) {
      const errorMsg =
        status.Description || status.ErrorMessage || "Unknown error";
      console.error(`[TBO Static] API Error:`, {
        Code: status.Code,
        Description: status.Description,
        ErrorMessage: status.ErrorMessage,
      });

      if (
        errorMsg.toLowerCase().includes("credential") ||
        errorMsg.toLowerCase().includes("access")
      ) {
        throw new Error(
          `TBO CountryList error: ${errorMsg}. ` +
            `Please verify TBO_STATIC_API_USERNAME and TBO_STATIC_API_PASSWORD are correct. ` +
            `These credentials are different from regular TBO search API credentials. ` +
            `Contact TBO support if you need static data API credentials.`,
        );
      }

      throw new Error(`TBO CountryList error: ${errorMsg}`);
    }

    const countryList = responseData.CountryList || [];
    const countries = countryList.map((country) => ({
      code: country.Code,
      name: country.Name,
    }));

    console.log(`[TBO Static] Fetched ${countries.length} countries`);
    return countries;
  } catch (error) {
    console.error("[TBO Static] Error fetching country list:", error);
    throw error;
  }
}

/**
 * Fetch City List from TBO Static Data API for a specific country
 * GET http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList?CountryCode={code}
 *
 * @param {string} countryCode - ISO country code (e.g., "AE", "IN")
 * @returns {Promise<Array<{code: number, name: string}>>} Array of cities
 */
export async function fetchTboCityList(countryCode) {
  if (!countryCode) {
    throw new Error("TBO CityList: countryCode parameter is required.");
  }

  try {
    const { username, password } = getStaticApiCredentials();

    if (!username || !password) {
      throw new Error(
        "TBO Static API credentials not configured. Please set TBO_STATIC_API_USERNAME and TBO_STATIC_API_PASSWORD in .env file.",
      );
    }

    // TBO CityList API requires POST method with CountryCode in body
    const url = `${TBO_STATIC_API_BASE_URL}/CityList`;
    console.log(
      `[TBO Static] Fetching city list for country ${countryCode} from: ${url}`,
    );

    const auth = Buffer.from(`${username}:${password}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        CountryCode: countryCode,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`TBO CityList failed (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    const responseData = json.Response || json;
    const status = responseData.Status || responseData;

    // Debug: Log the response structure to understand what TBO returns
    console.log(
      `[TBO Static] CityList response for ${countryCode}:`,
      JSON.stringify({
        hasStatus: !!responseData.Status,
        statusCode: status?.Code,
        statusDesc: status?.Description,
        hasCityList: !!responseData.CityList,
        cityListLength: responseData.CityList?.length || 0,
      }),
    );

    // Check for actual errors (not success messages)
    // Success codes: 1, 200, or Description contains "Success" (case-insensitive)
    const isSuccess =
      status.Code === 1 ||
      status.Code === 200 ||
      (status.Description &&
        status.Description.toLowerCase().includes("success")) ||
      (status.Code === undefined && !status.Description); // No status means success

    // If Description is "Success", treat as success even if Code is not 1 or 200
    if (
      status.Description &&
      status.Description.toLowerCase().trim() === "success"
    ) {
      // This is definitely a success, proceed to extract CityList
    } else if (!isSuccess && status.Code !== undefined) {
      const errorMsg =
        status.Description || status.ErrorMessage || "Unknown error";
      throw new Error(`TBO CityList error: ${errorMsg}`);
    }

    const cityList = responseData.CityList || [];
    const cities = cityList.map((city) => ({
      code: city.Code,
      name: city.Name,
    }));

    console.log(
      `[TBO Static] Fetched ${cities.length} cities for country ${countryCode}`,
    );
    return cities;
  } catch (error) {
    console.error(
      `[TBO Static] Error fetching city list for ${countryCode}:`,
      error,
    );
    throw error;
  }
}

/**
 * Fetch TBO Hotel Code List from TBO Static Data API for a specific city
 * GET http://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList?CityCode={code}
 *
 * @param {number} cityCode - TBO city code
 * @returns {Promise<Array<{hotelCode: number, hotelName: string, description?: string}>>} Array of hotel codes
 */
export async function fetchTboHotelCodeList(cityCode) {
  if (!cityCode) {
    throw new Error("TBO HotelCodeList: cityCode parameter is required.");
  }

  try {
    const { username, password } = getStaticApiCredentials();

    if (!username || !password) {
      throw new Error(
        "TBO Static API credentials not configured. Please set TBO_STATIC_API_USERNAME and TBO_STATIC_API_PASSWORD in .env file.",
      );
    }

    // TBO HotelCodeList API requires POST method with CityCode in body
    const url = `${TBO_STATIC_API_BASE_URL}/TBOHotelCodeList`;
    console.log(
      `[TBO Static] Fetching hotel code list for city ${cityCode} from: ${url}`,
    );

    const auth = Buffer.from(`${username}:${password}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        CityCode: cityCode,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `TBO HotelCodeList failed (${response.status}): ${errorText}`,
      );
    }

    const json = await response.json();
    const responseData = json.Response || json;
    const status = responseData.Status || responseData;

    // Check for actual errors (not success messages)
    // Success codes: 1, 200, or Description contains "Success" (case-insensitive)
    const isSuccess =
      status.Code === 1 ||
      status.Code === 200 ||
      (status.Description &&
        status.Description.toLowerCase().includes("success")) ||
      (status.Code === undefined && !status.Description); // No status means success

    if (!isSuccess && status.Code !== undefined) {
      const errorMsg =
        status.Description || status.ErrorMessage || "Unknown error";
      throw new Error(`TBO HotelCodeList error: ${errorMsg}`);
    }

    // TBO returns hotels in different field names - try all variations
    const hotelCodeList =
      responseData.Hotels ||
      responseData.TBOHotelCodeList ||
      responseData.HotelCodeList ||
      responseData.HotelCodes ||
      [];
    const hotels = hotelCodeList
      .map((hotel) => ({
        hotelCode: hotel.HotelCode || hotel.Code || hotel,
        hotelName: hotel.HotelName || hotel.Name || "",
        description: hotel.Description || hotel.ShortDescription || "",
      }))
      .filter((h) => h.hotelCode);

    console.log(
      `[TBO Static] Fetched ${hotels.length} hotel codes for city ${cityCode}`,
    );
    return hotels;
  } catch (error) {
    console.error(
      `[TBO Static] Error fetching hotel code list for city ${cityCode}:`,
      error,
    );
    throw error;
  }
}

/**
 * Store countries in database
 * @param {Array<{code: string, name: string}>} countries - Array of countries
 */
export async function storeTboCountries(countries) {
  if (!countries || countries.length === 0) return;

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const countriesToInsert = countries.map((country) => ({
    code: country.code,
    name: country.name,
    last_refreshed_at: now,
  }));

  const { error } = await supabase
    .from("tbo_countries")
    .upsert(countriesToInsert, { onConflict: "code" });

  if (error) {
    console.error("[TBO Static] Error storing countries:", error);
    throw error;
  }

  console.log(
    `[TBO Static] ✅ Stored ${countries.length} countries in database`,
  );
}

/**
 * Store cities in database
 * @param {Array<{code: number, name: string}>} cities - Array of cities
 * @param {string} countryCode - Country code
 */
export async function storeTboCities(cities, countryCode) {
  if (!cities || cities.length === 0) return;
  if (!countryCode) {
    throw new Error("storeTboCities: countryCode is required");
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const citiesToInsert = cities.map((city) => ({
    code: city.code,
    name: city.name,
    country_code: countryCode,
    last_refreshed_at: now,
  }));

  const { error } = await supabase
    .from("tbo_cities")
    .upsert(citiesToInsert, { onConflict: "code" });

  if (error) {
    console.error("[TBO Static] Error storing cities:", error);
    throw error;
  }

  console.log(
    `[TBO Static] ✅ Stored ${cities.length} cities for country ${countryCode} in database`,
  );
}

/**
 * Store hotel codes in database
 * @param {Array<{hotelCode: number, hotelName: string, description?: string}>} hotels - Array of hotels
 * @param {number} cityCode - City code
 * @param {string} cityName - City name (optional)
 * @param {string} countryCode - Country code (optional)
 */
export async function storeTboHotelCodes(
  hotels,
  cityCode,
  cityName = null,
  countryCode = null,
) {
  if (!hotels || hotels.length === 0) return;
  if (!cityCode) {
    throw new Error("storeTboHotelCodes: cityCode is required");
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const hotelsToInsert = hotels.map((hotel) => ({
    hotel_code: hotel.hotelCode,
    hotel_name: hotel.hotelName,
    city_code: cityCode,
    city_name: cityName,
    country_code: countryCode,
    description: hotel.description,
    last_refreshed_at: now,
  }));

  const { error } = await supabase
    .from("tbo_hotel_codes")
    .upsert(hotelsToInsert, { onConflict: "hotel_code" });

  if (error) {
    console.error("[TBO Static] Error storing hotel codes:", error);
    throw error;
  }

  console.log(
    `[TBO Static] ✅ Stored ${hotels.length} hotel codes for city ${cityCode} in database`,
  );
}

/**
 * Get hotel codes from database by city code (for search – no TBO API call).
 * Provider recommends storing static data locally and refreshing every 14–15 days.
 * @param {string|number} cityCode - TBO city code
 * @returns {Promise<Array<number>>} Array of hotel codes
 */
export async function getTboHotelCodesByCityCode(cityCode) {
  if (cityCode == null || cityCode === "") {
    throw new Error("getTboHotelCodesByCityCode: cityCode is required");
  }
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("tbo_hotel_codes")
    .select("hotel_code")
    .eq("city_code", String(cityCode));

  if (error) {
    console.error("[TBO Static] Error fetching hotel codes by city code:", error);
    throw error;
  }

  return (data || []).map((h) => h.hotel_code).filter((c) => c != null);
}

/**
 * Get hotel codes from database by city name
 * @param {string} cityName - City name
 * @param {string} countryCode - Optional country code for better matching
 * @returns {Promise<Array<number>>} Array of hotel codes
 */
export async function getTboHotelCodesFromDB(cityName, countryCode = null) {
  if (!cityName) {
    throw new Error("getTboHotelCodesFromDB: cityName is required");
  }

  const supabase = getSupabaseClient();

  // Extract city name (handle "City, State" or "City,   State" format)
  // Remove state/province info after comma
  let cleanCityName = cityName.trim();
  const commaIndex = cleanCityName.indexOf(",");
  if (commaIndex > 0) {
    cleanCityName = cleanCityName.substring(0, commaIndex).trim();
  }

  // Remove extra spaces
  cleanCityName = cleanCityName.replace(/\s+/g, " ").trim();
  const cityNameLower = cleanCityName.toLowerCase().trim();

  // Try multiple search strategies:
  // 1. Exact match (case-insensitive)
  // 2. Starts with
  // 3. Contains
  // 4. Try without common suffixes/prefixes

  let cities = [];
  let cityError = null;

  // Strategy 1: Try exact match first (most accurate)
  let cityQuery = supabase
    .from("tbo_cities")
    .select("code, name, country_code")
    .ilike("name", cityNameLower)
    .limit(5);

  if (countryCode) {
    cityQuery = cityQuery.eq("country_code", countryCode);
  }

  let result = await cityQuery;
  cities = result.data || [];
  cityError = result.error;

  // Strategy 2: If no exact match, try "starts with"
  if (cities.length === 0 && !cityError) {
    cityQuery = supabase
      .from("tbo_cities")
      .select("code, name, country_code")
      .ilike("name", `${cityNameLower}%`)
      .limit(20);

    if (countryCode) {
      cityQuery = cityQuery.eq("country_code", countryCode);
    }

    result = await cityQuery;
    cities = result.data || [];
    cityError = result.error;
  }

  // Strategy 3: If still no match, try "contains"
  if (cities.length === 0 && !cityError) {
    cityQuery = supabase
      .from("tbo_cities")
      .select("code, name, country_code")
      .ilike("name", `%${cityNameLower}%`)
      .limit(20);

    if (countryCode) {
      cityQuery = cityQuery.eq("country_code", countryCode);
    }

    result = await cityQuery;
    cities = result.data || [];
    cityError = result.error;
  }

  // Strategy 4: Try alternative names (e.g., "Madras" for "Chennai")
  // This is a fallback for well-known city aliases
  if (cities.length === 0 && !cityError) {
    const cityAliases = {
      chennai: ["madras"],
      mumbai: ["bombay"],
      kolkata: ["calcutta"],
      pune: ["poona"],
      bangalore: ["bengaluru"],
    };

    const aliases = cityAliases[cityNameLower] || [];
    for (const alias of aliases) {
      cityQuery = supabase
        .from("tbo_cities")
        .select("code, name, country_code")
        .ilike("name", `%${alias}%`)
        .limit(10);

      if (countryCode) {
        cityQuery = cityQuery.eq("country_code", countryCode);
      }

      result = await cityQuery;
      if (result.data && result.data.length > 0) {
        cities = result.data;
        break;
      }
    }
  }

  // Debug: Log what we're searching for and what we found
  console.log(
    `[TBO Static] City search: "${cityName}" -> "${cleanCityName}" (lower: "${cityNameLower}")`,
  );
  if (cities && cities.length > 0) {
    console.log(
      `[TBO Static] Found ${cities.length} cities, first few:`,
      cities.slice(0, 5).map((c) => `${c.name} (${c.country_code})`),
    );
  } else if (cityError) {
    console.error(`[TBO Static] Database query error:`, cityError);
  } else {
    // If no cities found, try to see what cities exist for debugging
    console.log(
      `[TBO Static] No cities found. Trying to find similar cities for debugging...`,
    );
    const debugQuery = supabase
      .from("tbo_cities")
      .select("name, country_code")
      .ilike("name", `%${cityNameLower.slice(0, 3)}%`)
      .limit(5);
    if (countryCode) {
      debugQuery.eq("country_code", countryCode);
    }
    const debugResult = await debugQuery;
    if (debugResult.data && debugResult.data.length > 0) {
      console.log(
        `[TBO Static] Similar cities found:`,
        debugResult.data.map((c) => c.name),
      );
    }
  }

  // Sort results: exact matches first, then starts-with, then contains
  if (cities && cities.length > 0) {
    cities.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();

      // Exact match gets highest priority
      const aExact = aName === cityNameLower;
      const bExact = bName === cityNameLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Starts with gets second priority
      const aStarts = aName.startsWith(cityNameLower);
      const bStarts = bName.startsWith(cityNameLower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      // Prefer shorter names (more specific)
      return aName.length - bName.length;
    });
  }

  if (cityError) {
    console.error("[TBO Static] Error finding city in database:", cityError);
    throw cityError;
  }

  if (!cities || cities.length === 0) {
    console.log(
      `[TBO Static] No city found in database for: ${cityName} (searched as: ${cleanCityName})`,
    );
    return [];
  }

  // Use the first matching city (prefer exact match)
  const exactMatch = cities.find((c) => c.name.toLowerCase() === cityNameLower);
  const city = exactMatch || cities[0];

  console.log(
    `[TBO Static] Selected city: ${city.name} (code: ${city.code}) for search: "${cityName}"`,
  );

  // Get hotel codes for this city
  const { data: hotels, error: hotelError } = await supabase
    .from("tbo_hotel_codes")
    .select("hotel_code")
    .eq("city_code", city.code);

  if (hotelError) {
    console.error(
      "[TBO Static] Error fetching hotel codes from database:",
      hotelError,
    );
    throw hotelError;
  }

  const hotelCodes = hotels.map((h) => h.hotel_code).filter(Boolean);
  console.log(
    `[TBO Static] Found ${hotelCodes.length} hotel codes in database for city: ${city.name} (code: ${city.code})`,
  );

  if (hotelCodes.length === 0) {
    console.warn(
      `[TBO Static] ⚠️ No hotel codes found in database for city "${city.name}". ` +
        `This means hotels haven't been indexed yet. Please run: node scripts/refreshTboStaticData.js`,
    );
  }

  return hotelCodes;
}
