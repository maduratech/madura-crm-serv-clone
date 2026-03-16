import fetch from "node-fetch";

const AMADEUS_API_KEY = process.env.AMADEUS_API_KEY;
const AMADEUS_API_SECRET = process.env.AMADEUS_API_SECRET;
const AMADEUS_ENV = process.env.AMADEUS_ENV || "test"; // "test" or "production"

const AMADEUS_HOST =
  AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function ensureCredentials() {
  if (!AMADEUS_API_KEY || !AMADEUS_API_SECRET) {
    throw new Error(
      "Amadeus credentials are missing. Please set AMADEUS_API_KEY and AMADEUS_API_SECRET."
    );
  }
}

export async function getAccessToken() {
  ensureCredentials();

  // Return cached token if valid
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 5000) {
    return tokenCache.accessToken;
  }

  const url = `${AMADEUS_HOST}/v1/security/oauth2/token`;
  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", AMADEUS_API_KEY);
  body.append("client_secret", AMADEUS_API_SECRET);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Amadeus auth failed (${response.status}): ${errText || "unknown error"}`
    );
  }

  const json = await response.json();
  const expiresIn = json.expires_in || 0;
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000, // refresh 60s early
  };

  return tokenCache.accessToken;
}

async function authedGet(url) {
  const token = await getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    let errorData = null;
    try {
      errorData = JSON.parse(text);
    } catch {
      // Not JSON, use text as-is
    }
    
    // Create enhanced error with details
    const error = new Error(
      `Amadeus request failed (${response.status}): ${text || "unknown error"}`
    );
    error.status = response.status;
    error.responseText = text;
    error.errors = errorData?.errors || errorData;
    error.code = errorData?.errors?.[0]?.code || errorData?.code;
    throw error;
  }

  return response.json();
}

export async function searchLocations(keyword, options = {}) {
  if (!keyword || keyword.trim().length < 2) {
    throw new Error("Search keyword must be at least 2 characters.");
  }

  const {
    subType = "CITY,AIRPORT",
    pageLimit = 10,
    sort = "analytics.travelers.score",
  } = options;

  const url = new URL(`${AMADEUS_HOST}/v1/reference-data/locations`);
  url.searchParams.set("keyword", keyword.trim());
  url.searchParams.set("subType", subType);
  url.searchParams.set("page[limit]", pageLimit.toString());
  url.searchParams.set("sort", sort);

  return authedGet(url.toString());
}

export async function searchFlightOffers(params) {
  const {
    originLocationCode,
    destinationLocationCode,
    departureDate,
    returnDate,
    adults = 1,
    children,
    infants,
    currencyCode = "INR",
    travelClass = "ECONOMY",
    nonStop = false,
    max = 20,
  } = params;

  if (!originLocationCode || !destinationLocationCode || !departureDate) {
    throw new Error(
      "originLocationCode, destinationLocationCode, and departureDate are required."
    );
  }

  const url = new URL(`${AMADEUS_HOST}/v2/shopping/flight-offers`);
  url.searchParams.set("originLocationCode", originLocationCode);
  url.searchParams.set("destinationLocationCode", destinationLocationCode);
  url.searchParams.set("departureDate", departureDate);
  if (returnDate) url.searchParams.set("returnDate", returnDate);
  url.searchParams.set("adults", adults.toString());
  if (children) url.searchParams.set("children", children.toString());
  if (infants) url.searchParams.set("infants", infants.toString());
  url.searchParams.set("currencyCode", currencyCode);
  url.searchParams.set("travelClass", travelClass);
  url.searchParams.set("nonStop", nonStop ? "true" : "false");
  url.searchParams.set("max", Math.min(max, 50).toString()); // Amadeus cap is 250; we keep low for quota

  return authedGet(url.toString());
}

// Amadeus Hotel List API - Get hotels by city code or coordinates
export async function searchHotelList(params) {
  const {
    cityCode,
    latitude,
    longitude,
    radius = 50,
    hotelIds,
    chainCodes,
    amenities,
    ratings,
    max = 20,
  } = params;

  if (!cityCode && (!latitude || !longitude) && !hotelIds) {
    throw new Error("cityCode, (latitude+longitude), or hotelIds is required.");
  }

  // Try v1 endpoint first (more widely available), fallback to v3 if needed
  const url = new URL(`${AMADEUS_HOST}/v1/reference-data/locations/hotels/by-city`);
  
  if (cityCode) {
    url.searchParams.set("cityCode", cityCode);
  } else if (latitude && longitude) {
    url.searchParams.set("latitude", latitude.toString());
    url.searchParams.set("longitude", longitude.toString());
    url.searchParams.set("radius", radius.toString());
  }

  if (hotelIds && Array.isArray(hotelIds)) {
    hotelIds.forEach(id => url.searchParams.append("hotelIds", id));
  }
  if (chainCodes && Array.isArray(chainCodes)) {
    chainCodes.forEach(code => url.searchParams.append("chainCodes", code));
  }
  if (amenities && Array.isArray(amenities)) {
    amenities.forEach(amenity => url.searchParams.append("amenities", amenity));
  }
  if (ratings && Array.isArray(ratings)) {
    ratings.forEach(rating => url.searchParams.append("ratings", rating.toString()));
  }

  return authedGet(url.toString());
}

// Amadeus Hotel Offers Search API - Get offers for specific hotels
export async function searchHotelOffers(params) {
  const {
    hotelIds,
    checkInDate,
    checkOutDate,
    adults = 2,
    roomQuantity = 1,
    currencyCode = "INR",
    max = 20,
  } = params;

  if (!hotelIds || !Array.isArray(hotelIds) || hotelIds.length === 0) {
    throw new Error("hotelIds array is required.");
  }
  if (!checkInDate || !checkOutDate) {
    throw new Error("checkInDate and checkOutDate are required.");
  }

  const url = new URL(`${AMADEUS_HOST}/v3/shopping/hotel-offers`);
  
  hotelIds.forEach(id => url.searchParams.append("hotelIds", id));
  url.searchParams.set("checkInDate", checkInDate);
  url.searchParams.set("checkOutDate", checkOutDate);
  url.searchParams.set("adults", adults.toString());
  url.searchParams.set("roomQuantity", roomQuantity.toString());
  url.searchParams.set("currency", currencyCode);
  url.searchParams.set("view", "FULL");
  url.searchParams.set("lang", "EN");

  return authedGet(url.toString());
}