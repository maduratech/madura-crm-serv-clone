// Context builder for itinerary generation
// Handles fetching data from Supabase, WordPress, and building context

import { createClient } from "@supabase/supabase-js";
import { logger } from "../logger.js";
import { cache } from "../cache.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fetch visa from database
export async function fetchVisaData(destination) {
  const cacheKey = cache.generateKey("visa", { destination });
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.debug("Visa data retrieved from cache", { destination });
    return cached;
  }

  try {
    logger.info("Fetching visa for destination", { destination });
    const { data: visaResults, error: visaError } = await supabase
      .from("visas")
      .select("*")
      .ilike("destination", `%${destination}%`)
      .limit(1);

    if (!visaError && visaResults && visaResults.length > 0) {
      const visaData = visaResults[0];
      logger.info("Found visa", { destination, visaName: visaData.visa_name });
      // Cache for 1 hour
      cache.set(cacheKey, visaData, 60 * 60 * 1000);
      return visaData;
    } else {
      logger.debug("No visa found", { destination });
      cache.set(cacheKey, null, 60 * 60 * 1000); // Cache null for 1 hour
      return null;
    }
  } catch (err) {
    logger.error("Visa fetch error", {
      destination,
      error: err.message,
      stack: err.stack,
    });
    return null;
  }
}

// Build base context from lead data
export function buildBaseContext(lead, destination) {
  let contextData = "";

  const hotelPreference =
    lead?.requirements?.hotelPreference || "No Preference";
  const stayPreference = lead?.requirements?.stayPreference || "No Preference";
  const hasVisaService = lead?.services && lead.services.includes("Visa");

  // Only add lead details if lead exists
  if (lead) {
    contextData += `LEAD DETAILS:\n${JSON.stringify({
      destination: lead.destination,
      duration: lead.duration,
      travel_date: lead.travel_date,
      return_date: lead.return_date,
      check_out_date: lead.check_out_date,
      starting_point: lead.starting_point,
      tour_type: lead.tour_type,
      requirements: lead.requirements,
      hotelPreference: hotelPreference,
      stayPreference: stayPreference,
      services: lead.services || [],
      visaRequired: hasVisaService,
    })}\n\n`;
  }

  // Calculate dates for day-wise plan
  const travelDate = lead?.travel_date ? new Date(lead.travel_date) : null;
  const returnDate = lead?.return_date ? new Date(lead.return_date) : null;
  const checkOutDate = lead?.check_out_date
    ? new Date(lead.check_out_date)
    : null;

  // Calculate end date
  let endDate = returnDate || checkOutDate;
  if (!endDate && travelDate && lead?.duration) {
    const nightsMatch = lead?.duration.match(/(\d+)\s*[Nn]/);
    const nights = nightsMatch ? parseInt(nightsMatch[1]) : 0;
    if (nights > 0) {
      endDate = new Date(travelDate);
      endDate.setDate(endDate.getDate() + nights);
    }
  }

  // Add date context for day-wise plan formatting
  if (travelDate) {
    contextData += `DATE CONTEXT FOR DAY-WISE PLAN:\n`;
    contextData += `- Travel Start Date: ${travelDate.toLocaleDateString(
      "en-US",
      { weekday: "long", year: "numeric", month: "long", day: "numeric" }
    )}\n`;
    contextData += `- Travel Start Date (ISO): ${
      travelDate.toISOString().split("T")[0]
    }\n`;
    if (endDate) {
      contextData += `- Travel End Date: ${endDate.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })}\n`;
      contextData += `- Travel End Date (ISO): ${
        endDate.toISOString().split("T")[0]
      }\n`;
    }
    contextData += `- Use these dates to format the day-wise plan dates correctly\n`;
    contextData += `- Day 1 should use the travel start date, Day 2 should be travel start date + 1 day, etc.\n\n`;
  }

  // Add hotel preference guidance
  if (hotelPreference !== "No Preference") {
    contextData += `HOTEL PREFERENCE: ${hotelPreference}\n`;
  } else {
    contextData += `HOTEL PREFERENCE: Use 4 Star or 5 Star hotels (default)\n`;
  }
  contextData += `STAY PREFERENCE: ${stayPreference}\n\n`;

  if (lead?.notes && lead.notes.length > 0) {
    const notesText = lead.notes.map((note) => `- ${note.text}`).join("\n");
    contextData += `IMPORTANT NOTES FROM LEAD:\n${notesText}\n\n`;
  }

  return contextData;
}

// Build attractions-based context
export async function buildAttractionsContext(attractions, hotels, flights) {
  let contextData = "";

  // Separate attractions from transfers
  const attractionsOnly = attractions.filter(
    (a) =>
      a.sightseeing_id &&
      !a.transfer_id &&
      !a.linked_activity_id &&
      !a.linked_hotel_id &&
      !a.transfer_name
  );

  // Group attractions by day
  const attractionsByDay = {};
  attractionsOnly.forEach((attraction) => {
    const day = attraction.day_number || 1;
    if (!attractionsByDay[day]) {
      attractionsByDay[day] = [];
    }
    attractionsByDay[day].push(attraction);
  });

  // Fetch transfer data for activities that have transfer_id or transfer_name
  const transferIds = attractions
    .filter((a) => a.transfer_id)
    .map((a) => a.transfer_id)
    .filter((id, index, self) => self.indexOf(id) === index); // Unique IDs

  const transferNames = attractions
    .filter((a) => a.transfer_name && !a.transfer_id)
    .map((a) => a.transfer_name)
    .filter((name, index, self) => name && self.indexOf(name) === index); // Unique names

  const transfersMap = {};

  // Fetch transfers by ID
  if (transferIds.length > 0) {
    try {
      const { data: transfers, error } = await supabase
        .from("transfers")
        .select("*")
        .in("id", transferIds);

      if (!error && transfers) {
        transfers.forEach((transfer) => {
          transfersMap[transfer.id] = transfer;
          if (transfer.name) {
            transfersMap[transfer.name] = transfer;
          }
        });
      }
    } catch (err) {
      logger.error("Error fetching transfers by ID", { error: err.message });
    }
  }

  // Fetch transfers by name
  if (transferNames.length > 0) {
    try {
      const { data: transfersByName, error: nameError } = await supabase
        .from("transfers")
        .select("*")
        .in("name", transferNames);

      if (!nameError && transfersByName) {
        transfersByName.forEach((transfer) => {
          if (!transfersMap[transfer.id]) {
            transfersMap[transfer.id] = transfer;
          }
          if (transfer.name) {
            transfersMap[transfer.name] = transfer;
          }
        });
      }
    } catch (err) {
      logger.error("Error fetching transfers by name", { error: err.message });
    }
  }

  contextData += `\n*** CRITICAL: ATTRACTIONS-BASED ITINERARY GENERATION ***\n`;
  contextData += `You MUST generate a day-wise itinerary based ONLY on the attractions/activities that have been added by the user.\n`;
  contextData += `DO NOT add any new attractions, places, or activities. Only format and describe the existing attractions.\n\n`;

  // Separate transfers from attractions
  const transfersByDay = {};
  attractions.forEach((activity) => {
    const isTransfer =
      activity.transfer_id ||
      activity.linked_activity_id !== null ||
      activity.linked_hotel_id !== null ||
      (activity.transfer_name && !activity.sightseeing_id);
    if (isTransfer) {
      const day = activity.day_number || 1;
      if (!transfersByDay[day]) {
        transfersByDay[day] = [];
      }
      transfersByDay[day].push(activity);
    }
  });

  // Add attractions data organized by day with transfers
  Object.keys(attractionsByDay)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .forEach((day) => {
      const dayAttractions = attractionsByDay[day];
      const dayTransfers = transfersByDay[day] || [];

      contextData += `DAY ${day} ITINERARY FLOW:\n`;

      // Sort attractions by start_time if available
      const sortedAttractions = [...dayAttractions].sort((a, b) => {
        if (a.start_time && b.start_time) {
          return a.start_time.localeCompare(b.start_time);
        }
        return 0;
      });

      sortedAttractions.forEach((attraction, idx) => {
        // Find transfers linked to this attraction
        const transferBefore = dayTransfers.find(
          (t) =>
            t.linked_activity_id === attraction.id && t.position === "before"
        );
        const transferAfter = dayTransfers.find(
          (t) =>
            t.linked_activity_id === attraction.id && t.position === "after"
        );

        // Add transfer before attraction if exists
        if (transferBefore) {
          const transferName =
            transferBefore.transfer_name || transferBefore.name || "Transfer";
          contextData += `  → Transfer: ${transferName}\n`;
          if (
            transferBefore.transfer_id &&
            transfersMap[transferBefore.transfer_id]
          ) {
            const transfer = transfersMap[transferBefore.transfer_id];
            if (transfer.vehicle_type) {
              contextData += `     Vehicle Type: ${transfer.vehicle_type}\n`;
            }
            if (transfer.capacity) {
              contextData += `     Capacity: ${transfer.capacity} passengers\n`;
            }
          }
        }

        // Add attraction
        contextData += `  ${idx + 1}. ${attraction.name}\n`;
        if (attraction.start_time && attraction.end_time) {
          contextData += `     Time: ${attraction.start_time} - ${attraction.end_time} (INCLUDE THIS IN FORMAT: "from ${attraction.start_time} to ${attraction.end_time}")\n`;
        }
        if (attraction.duration) {
          contextData += `     Duration: ${attraction.duration}\n`;
        }
        if (attraction.tag) {
          contextData += `     Tag: ${attraction.tag}\n`;
        }
        if (attraction.opening_hours) {
          contextData += `     Opening Hours: ${attraction.opening_hours}\n`;
        }
        if (attraction.best_time) {
          contextData += `     Best Time: ${attraction.best_time}\n`;
        }
        if (attraction.inclusions) {
          contextData += `     Details: ${attraction.inclusions}\n`;
        }

        // Add transfer after attraction if exists
        if (transferAfter) {
          const transferName =
            transferAfter.transfer_name || transferAfter.name || "Transfer";
          contextData += `  → Transfer: ${transferName}\n`;
          if (
            transferAfter.transfer_id &&
            transfersMap[transferAfter.transfer_id]
          ) {
            const transfer = transfersMap[transferAfter.transfer_id];
            if (transfer.vehicle_type) {
              contextData += `     Vehicle Type: ${transfer.vehicle_type}\n`;
            }
            if (transfer.capacity) {
              contextData += `     Capacity: ${transfer.capacity} passengers\n`;
            }
          }
        }
      });

      // Add standalone transfers (not linked to any attraction)
      const standaloneTransfers = dayTransfers.filter(
        (t) => !t.linked_activity_id
      );
      standaloneTransfers.forEach((transfer) => {
        const transferName =
          transfer.transfer_name || transfer.name || "Transfer";
        contextData += `  → Standalone Transfer: ${transferName}\n`;
        if (transfer.transfer_id && transfersMap[transfer.transfer_id]) {
          const transferData = transfersMap[transfer.transfer_id];
          if (transferData.vehicle_type) {
            contextData += `     Vehicle Type: ${transferData.vehicle_type}\n`;
          }
          if (transferData.capacity) {
            contextData += `     Capacity: ${transferData.capacity} passengers\n`;
          }
        }
      });

      contextData += `\n`;
    });

  // Add hotel and flight context if available
  if (hotels && hotels.length > 0) {
    contextData += `\nHOTELS ADDED BY USER:\n`;
    hotels.forEach((hotel, idx) => {
      contextData += `  ${idx + 1}. ${hotel.name || "Hotel"}\n`;
      if (hotel.check_in_date)
        contextData += `     Check-in: ${hotel.check_in_date}\n`;
      if (hotel.check_out_date)
        contextData += `     Check-out: ${hotel.check_out_date}\n`;
      if (hotel.room_type) contextData += `     Room: ${hotel.room_type}\n`;
    });
    contextData += `\n`;
  }

  if (flights && flights.length > 0) {
    contextData += `\nFLIGHTS ADDED BY USER:\n`;
    flights.forEach((flight, idx) => {
      const segment = flight.segments?.[0];
      if (segment) {
        contextData += `  ${idx + 1}. ${segment.airline || "Flight"} from ${
          segment.from_airport || ""
        } to ${segment.to_airport || ""}\n`;
        if (segment.departure_time)
          contextData += `     Departure: ${segment.departure_time}\n`;
        if (segment.arrival_time)
          contextData += `     Arrival: ${segment.arrival_time}\n`;
      }
    });
    contextData += `\n`;
  }

  // Extract arrival airport from flights for Day 1 context
  let arrivalAirport = null;
  if (flights && flights.length > 0) {
    const onwardFlight = flights.find((f) => f.direction === "onward");
    if (
      onwardFlight &&
      onwardFlight.segments &&
      onwardFlight.segments.length > 0
    ) {
      arrivalAirport = onwardFlight.segments[0].to_airport;
    }
  }

  // Extract departure airport from flights for last day context
  let departureAirport = null;
  if (flights && flights.length > 0) {
    const returnFlight = flights.find((f) => f.direction === "return");
    if (
      returnFlight &&
      returnFlight.segments &&
      returnFlight.segments.length > 0
    ) {
      departureAirport = returnFlight.segments[0].from_airport;
    }
  }

  // Get the last day number for departure context
  const dayNumbers = Object.keys(attractionsByDay)
    .map(Number)
    .sort((a, b) => a - b);
  const lastDay =
    dayNumbers.length > 0 ? dayNumbers[dayNumbers.length - 1] : null;

  contextData += `\nINSTRUCTIONS FOR ATTRACTIONS-BASED GENERATION:\n`;
  contextData += `1. Write a professional, catchy day-wise itinerary describing each attraction\n`;
  contextData += `2. For each day, mention:\n`;
  contextData += `   - Arrival/transfer details (if Day 1, mention arrival in destination)\n`;
  contextData += `   - Hotel check-in (if hotels are added, mention hotel name)\n`;
  contextData += `   - Each attraction with its time slot, what to see/do there, and why it's special\n`;
  contextData += `   - Use opening hours intelligently (e.g., if museum closes at 1PM, mention "before 1PM")\n`;
  contextData += `   - Use general time periods: Morning, Afternoon, Evening\n`;
  contextData += `3. TRANSFER INCLUSION (CRITICAL):\n`;
  contextData += `   - If a transfer is associated with an activity, you MUST include it in the description using premium language\n`;
  contextData += `   - IMPORTANT: Check the transfer name to determine if it's SIC or Private Transfer:\n`;
  contextData += `     * If transfer name contains "SIC" (case-insensitive): Use "SIC" in the description (e.g., "transferred by SIC", "via SIC transfer")\n`;
  contextData += `     * If transfer name contains "Private" (case-insensitive): Use "Private Transfer" in the description (e.g., "transferred by Private Transfer", "via Private Transfer")\n`;
  contextData += `     * Always mention the service type (SIC or Private Transfer) when describing transfers\n`;
  if (arrivalAirport) {
    contextData += `   - For Day 1, if hotel is selected AND transfer is "SIC Airport to Hotel Transfer":\n`;
    contextData += `     * Mention: "After your arrival at ${arrivalAirport}, you will be transferred by SIC to your hotel"\n`;
    contextData += `   - For Day 1, if hotel is selected AND transfer is "Private Airport to Hotel Transfer":\n`;
    contextData += `     * Mention: "After your arrival at ${arrivalAirport}, you will be transferred by Private Transfer to your hotel"\n`;
  } else {
    contextData += `   - For Day 1, if hotel is selected AND transfer is "SIC Airport to Hotel Transfer":\n`;
    contextData += `     * Mention: "After your arrival at [destination name], you will be transferred by SIC to your hotel"\n`;
    contextData += `   - For Day 1, if hotel is selected AND transfer is "Private Airport to Hotel Transfer":\n`;
    contextData += `     * Mention: "After your arrival at [destination name], you will be transferred by Private Transfer to your hotel"\n`;
  }
  contextData += `   - For first attraction of the day: Mention "hotel to attraction" transfer (e.g., "You will be transferred from your hotel to [attraction name] by SIC" or "by Private Transfer")\n`;
  contextData += `   - For middle attractions: Mention "attraction to attraction" transfer (e.g., "You will be transferred from [previous attraction] to [next attraction] by SIC" or "by Private Transfer")\n`;
  if (departureAirport && lastDay) {
    contextData += `   - For last attraction of Day ${lastDay} (departure day): If transfer is "SIC Hotel Transfer to Airport", mention: "After your visit, you will be transferred to ${departureAirport} by SIC"\n`;
    contextData += `   - For last attraction of Day ${lastDay} (departure day): If transfer is "Private Hotel Transfer to Airport", mention: "After your visit, you will be transferred to ${departureAirport} by Private Transfer"\n`;
  } else {
    contextData += `   - For last attraction of the day: If it's a departure day, mention transfer type (e.g., "After your visit, you will be transferred to the airport by SIC" or "by Private Transfer")\n`;
  }
  contextData += `   - If no transfer is added for an activity, do NOT mention transfers for that activity\n`;
  contextData += `   - Use elegant, premium language when describing transfers (e.g., "transferred by SIC", "transferred by Private Transfer", "enjoy a comfortable SIC transfer", "your Private Transfer awaits")\n`;
  contextData += `4. Format: Mix of paragraphs and bullet points with Morning/Afternoon/Evening sections\n`;
  contextData += `5. Be professional and catchy - explain what makes each attraction special\n`;
  contextData += `6. DO NOT add any new attractions or places - only format existing ones\n\n`;

  return contextData;
}

// Build pasted content context
export function buildPastedContentContext(
  pastedText,
  userInstructions,
  hotels,
  flights
) {
  let contextData = "";

  contextData += `\n*** CRITICAL: PASTED CONTENT-BASED ITINERARY GENERATION ***\n`;
  contextData += `You MUST generate a day-wise itinerary based STRICTLY on the pasted content below.\n`;
  contextData += `You can enhance/reformat the content while keeping the same attractions/places.\n`;
  contextData += `DO NOT add any new attractions, places, or activities.\n\n`;
  contextData += `PASTED CONTENT:\n${pastedText}\n\n`;

  if (userInstructions && userInstructions.trim().length > 0) {
    contextData += `USER INSTRUCTIONS:\n${userInstructions}\n\n`;
  }

  // Add hotel and flight context if available
  if (hotels && hotels.length > 0) {
    contextData += `\nHOTELS ADDED BY USER:\n`;
    hotels.forEach((hotel, idx) => {
      contextData += `  ${idx + 1}. ${hotel.name || "Hotel"}\n`;
      if (hotel.check_in_date)
        contextData += `     Check-in: ${hotel.check_in_date}\n`;
      if (hotel.check_out_date)
        contextData += `     Check-out: ${hotel.check_out_date}\n`;
    });
    contextData += `\n`;
  }

  if (flights && flights.length > 0) {
    contextData += `\nFLIGHTS ADDED BY USER:\n`;
    flights.forEach((flight, idx) => {
      const segment = flight.segments?.[0];
      if (segment) {
        contextData += `  ${idx + 1}. ${segment.airline || "Flight"} from ${
          segment.from_airport || ""
        } to ${segment.to_airport || ""}\n`;
      }
    });
    contextData += `\n`;
  }

  return contextData;
}

// Fetch AI sources from knowledge base
export async function fetchAISources(destination) {
  const cacheKey = cache.generateKey("ai_sources", { destination });
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    logger.debug("AI sources retrieved from cache", { destination });
    return cached;
  }

  try {
    logger.info("Searching AI Knowledge Base", { destination });
    const { data: sources, error: sourceError } = await supabase
      .from("ai_sources")
      .select("id, type, title, content, url, file_name")
      .or(`title.ilike.%${destination}%,content.ilike.%${destination}%`)
      .limit(10);

    if (!sourceError && sources && sources.length > 0) {
      logger.info("Found AI sources", {
        destination,
        count: sources.length,
      });
      // Cache for 1 hour
      cache.set(cacheKey, sources, 60 * 60 * 1000);
      return sources;
    } else {
      logger.debug("No AI sources found", { destination });
      cache.set(cacheKey, [], 60 * 60 * 1000);
      return [];
    }
  } catch (err) {
    logger.error("AI sources fetch error", {
      destination,
      error: err.message,
    });
    return [];
  }
}

// Build AI sources context
export function buildAISourcesContext(sources) {
  if (!sources || sources.length === 0) return "";

  let contextData = `\n*** AI KNOWLEDGE BASE / SOURCES (HIGHEST PRIORITY - USE THIS AS PRIMARY REFERENCE) ***\n`;
  contextData += `The following information comes from our curated knowledge base. Use this as the PRIMARY and PREFERRED source of information for creating the itinerary. This data is more accurate and relevant than general internet searches.\n\n`;

  sources.forEach((source, index) => {
    contextData += `--- Source ${index + 1}: ${source.title} (Type: ${
      source.type
    }) ---\n`;
    if (source.url) {
      contextData += `URL: ${source.url}\n`;
    }
    if (source.file_name) {
      contextData += `File: ${source.file_name}\n`;
    }
    if (source.content) {
      // Limit content to first 5000 characters to avoid token limits
      const contentPreview =
        source.content.length > 5000
          ? source.content.substring(0, 5000) + "... [truncated]"
          : source.content;
      contextData += `Content: ${contentPreview}\n`;
    }
    contextData += `\n`;
  });

  return contextData;
}

// Fetch existing itineraries from database
export async function fetchExistingItineraries(destination) {
  const cacheKey = cache.generateKey("existing_itineraries", { destination });
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    logger.debug("Existing itineraries retrieved from cache", { destination });
    return cached;
  }

  try {
    logger.info("Searching internal DB for itineraries", { destination });
    // Exclude Archived; only use Prepared, Sent, or Confirmed (preference: Confirmed > Sent > Prepared)
    const { data: existingItineraries, error: dbError } = await supabase
      .from("itineraries")
      .select(
        `
                creative_title,
                status,
                itinerary_versions (
                    overview,
                    day_wise_plan,
                    inclusions,
                    exclusions
                )
            `
      )
      .ilike("destination", `%${destination}%`)
      .neq("status", "Archived")
      .limit(10);

    if (!dbError && existingItineraries && existingItineraries.length > 0) {
      const withVersions = existingItineraries.filter(
        (i) => i.itinerary_versions && i.itinerary_versions.length > 0
      );
      // Prefer Confirmed, then Sent, then Prepared
      const statusOrder = { Confirmed: 1, Sent: 2, Prepared: 3 };
      const sorted = withVersions.sort((a, b) => {
        const orderA = statusOrder[a.status] ?? 99;
        const orderB = statusOrder[b.status] ?? 99;
        return orderA - orderB;
      });
      const validMatch = sorted[0];

      if (validMatch) {
        logger.info("Found internal template", {
          destination,
          title: validMatch.creative_title,
          status: validMatch.status,
        });
        // Cache for 1 hour
        cache.set(cacheKey, validMatch, 60 * 60 * 1000);
        return validMatch;
      }
    }

    logger.debug("No existing itineraries found", { destination });
    cache.set(cacheKey, null, 60 * 60 * 1000);
    return null;
  } catch (err) {
    logger.error("Internal DB search error", {
      destination,
      error: err.message,
    });
    return null;
  }
}

// Build existing itinerary context
export function buildExistingItineraryContext(existingItinerary, hasSources) {
  if (!existingItinerary) return "";

  const baseVersion = existingItinerary.itinerary_versions[0];
  let contextData = `\n*** REFERENCE FROM INTERNAL DATABASE (SECONDARY SOURCE) ***\n`;
  contextData += `We already have a successful itinerary for "${
    existingItinerary.creative_title
  }" in our system. Use the following structure as a reference. ${
    hasSources
      ? "This should complement the Knowledge Base information above."
      : "Use this as the PRIMARY FOUNDATION if Knowledge Base is empty."
  }\n`;
  contextData += `Existing Title: ${existingItinerary.creative_title}\n`;
  contextData += `Existing Overview: ${baseVersion.overview || ""}\n`;
  contextData += `Existing Day-Wise Plan: ${JSON.stringify(
    baseVersion.day_wise_plan
  )}\n`;
  contextData += `Existing Inclusions: ${baseVersion.inclusions || ""}\n`;
  contextData += `Existing Exclusions: ${baseVersion.exclusions || ""}\n\n`;

  return contextData;
}

// Fetch WordPress tour package
export async function fetchWordPressPackage(destination) {
  const cacheKey = cache.generateKey("wordpress_package", { destination });
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    logger.debug("WordPress package retrieved from cache", { destination });
    return cached;
  }

  const consumerKey = process.env.WP_CONSUMER_KEY;
  const consumerSecret = process.env.WP_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    logger.warn("WordPress credentials missing", { destination });
    return null;
  }

  try {
    const productApiUrl = new URL(
      "https://maduratravel.com/wp-json/wc/v3/products"
    );
    productApiUrl.searchParams.append("search", destination);
    productApiUrl.searchParams.append("consumer_key", consumerKey);
    productApiUrl.searchParams.append("consumer_secret", consumerSecret);

    logger.info("Searching WordPress for tour package", { destination });
    const productResponse = await fetch(productApiUrl.toString());

    if (productResponse.ok) {
      const products = await productResponse.json();
      if (products.length > 0) {
        const product = products[0];
        logger.info("Found WordPress tour package", {
          destination,
          productName: product.name,
        });
        // Cache for 1 hour
        cache.set(cacheKey, product, 60 * 60 * 1000);
        return product;
      }
    }

    logger.debug("No WordPress package found", { destination });
    cache.set(cacheKey, null, 60 * 60 * 1000);
    return null;
  } catch (err) {
    logger.error("WordPress search error", {
      destination,
      error: err.message,
    });
    return null;
  }
}

// Build WordPress context
export function buildWordPressContext(product) {
  if (!product) return "";

  let contextData = `\n*** CRITICAL: EXACT WORDPRESS CONTENT - USE AS-IS ***\n`;
  contextData += `EXISTING ITINERARY DETAILS FROM MADURATRAVEL.COM FOR "${product.name}":\n`;
  contextData += `Title: ${product.name}\n`;

  // Extract price from product
  if (product.price) {
    contextData += `\nPRICING FROM WEBSITE:\n`;
    contextData += `- Per Adult Cost: ${product.price} ${
      product.currency || "INR"
    }\n`;
    if (product.regular_price && product.regular_price !== product.price) {
      contextData += `- Regular Price: ${product.regular_price} ${
        product.currency || "INR"
      }\n`;
    }
  }

  // Extract day-wise plan, inclusions, and exclusions
  if (product.description) {
    const descriptionText = product.description;
    contextData += `\nDAY-WISE ITINERARY FROM WEBSITE (EXTRACT EXACTLY):\n`;
    contextData += `${descriptionText}\n`;

    // Try to extract inclusions and exclusions
    const inclusionsMatch = descriptionText.match(
      /inclusions?:?\s*([^]*?)(?:exclusions?|$)/i
    );
    const exclusionsMatch = descriptionText.match(
      /exclusions?:?\s*([^]*?)(?:inclusions?|terms|conditions|$)/i
    );

    if (inclusionsMatch) {
      contextData += `\nINCLUSIONS FROM WEBSITE (EXTRACT EXACTLY):\n${inclusionsMatch[1]}\n`;
    }
    if (exclusionsMatch) {
      contextData += `\nEXCLUSIONS FROM WEBSITE (EXTRACT EXACTLY):\n${exclusionsMatch[1]}\n`;
    }
  }
  if (product.short_description) {
    contextData += `\nSHORT DESCRIPTION FROM WEBSITE:\n${product.short_description}\n`;
  }

  contextData += `\n*** CRITICAL INSTRUCTIONS FOR WORDPRESS CONTENT ***\n`;
  contextData += `1. Use EXACT same day 1, day 2, day 3, day 4, etc. structure from the website\n`;
  contextData += `2. Use EXACT same inclusions and exclusions from the website\n`;
  contextData += `3. Use EXACT same cost from the website page - add it as "Per Adult cost"\n`;
  contextData += `4. DO NOT add or remove activities - use only what's on the website\n`;
  contextData += `5. DO NOT develop new content - just rewrite existing content professionally\n`;
  contextData += `6. Maintain the same day structure and activities as shown on the website\n`;
  contextData += `7. Only improve English/professional tone - do NOT change content structure\n\n`;

  return contextData;
}
