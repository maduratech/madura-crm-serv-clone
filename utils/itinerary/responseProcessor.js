// Response processor for itinerary generation

import { logger } from "../logger.js";

export function processAIResponse(
  aiResult,
  actualInclusions,
  actualExclusions,
  visaData,
) {
  // Override inclusions, exclusions, and visa with actual values
  aiResult.inclusions = actualInclusions;
  aiResult.exclusions = actualExclusions;
  aiResult.visa = visaData || null;

  // Ensure flights and hotels are empty arrays
  aiResult.flights = [];
  aiResult.hotels = [];

  // Validate required fields
  const requiredFields = [
    "creative_title",
    "duration",
    "overview",
    "day_wise_plan",
    "inclusions",
    "exclusions",
    "insurance",
    "manual_costing",
    "important_notes",
  ];

  const missingFields = requiredFields.filter(
    (field) => !aiResult[field] && aiResult[field] !== 0,
  );

  if (missingFields.length > 0) {
    logger.warn("Missing required fields in AI response", {
      missingFields,
    });
    // Fill missing fields with defaults
    missingFields.forEach((field) => {
      if (field === "manual_costing") {
        aiResult[field] = {
          per_adult: 0,
          per_adult_twin: 0,
          per_adult_triple: 0,
          per_adult_single: 0,
          per_child: 0,
          per_infant: 0,
          gst_percentage: 0,
          tcs_percentage: 0,
          total_cost: 0,
        };
      } else if (field === "insurance") {
        aiResult[field] = {
          type: "Travel Insurance",
          coverage: "Standard travel insurance coverage",
          note: "Travel insurance is recommended for all travelers",
        };
      } else if (field === "day_wise_plan") {
        aiResult[field] = [];
      } else if (field === "inclusions" || field === "exclusions") {
        aiResult[field] = [];
      } else {
        aiResult[field] = "";
      }
    });
  }

  // Validate day_wise_plan structure
  if (Array.isArray(aiResult.day_wise_plan)) {
    aiResult.day_wise_plan = aiResult.day_wise_plan.map((day, index) => {
      if (!day.day) {
        day.day = index + 1;
      }
      if (!day.title) {
        day.title = `Day ${day.day}`;
      }
      if (!day.description) {
        day.description = "";
      }
      return day;
    });
    // Build overview strictly from day_wise_plan (summary derived from day-wise content only)
    const lines = aiResult.day_wise_plan.map((day) => {
      const title = day.title || `Day ${day.day}`;
      const desc = (day.description || "").trim();
      const firstSentence = desc
        ? desc.split(/(?<=[.!?])\s+/)[0] ||
          desc.slice(0, 120).replace(/\s+\S*$/, "") ||
          desc.slice(0, 120)
        : "";
      return firstSentence
        ? `Day ${day.day} – ${title}: ${firstSentence}`
        : `Day ${day.day} – ${title}`;
    });
    aiResult.overview = lines.join(" ");
  } else {
    logger.warn("day_wise_plan is not an array, initializing empty array");
    aiResult.day_wise_plan = [];
  }

  return aiResult;
}
