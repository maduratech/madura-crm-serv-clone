import { geminiAI } from "./index.js";
import { runAiJob } from "./aiJobHelper.js";
import { logger } from "./utils/logger.js";
import { cache } from "./utils/cache.js";
import { validateItineraryRequest } from "./utils/itinerary/validator.js";
import {
  fetchVisaData,
  buildBaseContext,
  buildAttractionsContext,
  buildPastedContentContext,
  fetchAISources,
  buildAISourcesContext,
  fetchExistingItineraries,
  buildExistingItineraryContext,
  fetchWordPressPackage,
  buildWordPressContext,
} from "./utils/itinerary/contextBuilder.js";
import { buildPrompt } from "./utils/itinerary/promptBuilder.js";
import { getItinerarySchema } from "./utils/itinerary/schema.js";
import { processAIResponse } from "./utils/itinerary/responseProcessor.js";
import { createProgressCallback } from "./utils/progressTracker.js";
import fetch from "node-fetch";

// This handler is exported and used in the main index.js
export const generateItinerary = async (req, res) => {
  const startTime = Date.now();
  const requestId =
    req.headers["x-request-id"] ||
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const progressCallback = createProgressCallback(requestId);

  try {
    progressCallback(5, "Validating input");

    const {
      destination,
      lead,
      pastedText,
      userInstructions,
      imageBase64,
      categoryEnabled,
      attractions, // Array of DetailedActivity objects
      flights, // Array of DetailedFlight objects
      hotels, // Array of DetailedHotel objects
    } = req.body;

    // Validate input
    const validation = validateItineraryRequest({
      destination,
      attractions,
      flights,
      hotels,
      pastedText,
      userInstructions,
      imageBase64,
      categoryEnabled,
    });

    if (!validation.isValid) {
      logger.warn("Invalid itinerary request", {
        requestId,
        errors: validation.errors,
      });
      return res.status(400).json({
        message: "Invalid request",
        errors: validation.errors,
      });
    }

    // Check cache first
    const cacheKey = cache.generateKey("itinerary", {
      destination,
      attractions:
        attractions?.map((a) => ({
          id: a.sightseeing_id,
          day: a.day_number,
        })) || [],
      pastedText: pastedText?.substring(0, 100) || "",
      hotels: hotels?.map((h) => h.id) || [],
      flights: flights?.map((f) => f.id) || [],
    });

    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      logger.info("Itinerary retrieved from cache", {
        requestId,
        destination,
      });
      return res.json(cachedResult);
    }

    progressCallback(10, "Determining priority mode");

    // Determine priority: attractions → pasted content → fallback
    const hasAttractions =
      attractions && Array.isArray(attractions) && attractions.length > 0;
    const hasPastedContent = pastedText && pastedText.trim().length > 0;
    const hasFlights = flights && Array.isArray(flights) && flights.length > 0;
    const hasHotels = hotels && Array.isArray(hotels) && hotels.length > 0;

    const priorityMode = hasAttractions
      ? "ATTRACTIONS"
      : hasPastedContent
      ? "PASTED_CONTENT"
      : "FALLBACK";

    logger.info("Starting itinerary generation", {
      requestId,
      destination,
      priorityMode,
      hasAttractions,
      hasPastedContent,
      userId: req.user?.id,
    });

    progressCallback(15, "Building context");

    // Build base context
    let contextData = buildBaseContext(lead, destination);

    // Fetch visa data
    progressCallback(20, "Fetching visa information");
    const visaData = await fetchVisaData(destination);

    // Build context based on priority mode
    if (priorityMode === "ATTRACTIONS") {
      logger.info("Building attractions-based context", {
        requestId,
        attractionCount: attractions.length,
      });
      contextData += await buildAttractionsContext(
        attractions,
        hotels,
        flights
      );
    } else if (priorityMode === "PASTED_CONTENT") {
      logger.info("Building pasted content context", {
        requestId,
        contentLength: pastedText.length,
      });
      contextData += buildPastedContentContext(
        pastedText,
        userInstructions,
        hotels,
        flights
      );
    } else if (priorityMode === "FALLBACK") {
      progressCallback(25, "Searching knowledge base");
      // Fetch AI sources
      const sources = await fetchAISources(destination);
      const hasSources = sources && sources.length > 0;
      if (hasSources) {
        contextData += buildAISourcesContext(sources);
      }

      progressCallback(35, "Searching existing itineraries");
      // Fetch existing itineraries
      const existingItinerary = await fetchExistingItineraries(destination);
      if (existingItinerary) {
        contextData += buildExistingItineraryContext(
          existingItinerary,
          hasSources
        );
      }

      // Only fetch WordPress if no sources or existing itinerary found
      if (!hasSources && !existingItinerary) {
        progressCallback(45, "Searching WordPress packages");
        const wordPressProduct = await fetchWordPressPackage(destination);
        if (wordPressProduct) {
          contextData += buildWordPressContext(wordPressProduct);
        }
      }
    }

    progressCallback(50, "Building inclusions and exclusions");

    // Build inclusions/exclusions based on what's actually added
    const actualInclusions = [];
    const actualExclusions = [
      "Optional tours and activities not mentioned in the inclusions",
      "Early check-in and late check-out (subject to hotel availability)",
      "Any expenses arising due to unforeseen circumstances (flight delays, weather conditions, etc.)",
    ];

    if (hasFlights) {
      actualInclusions.push("Flight tickets");
    }
    if (hasHotels) {
      actualInclusions.push("Accommodation");
    }
    if (hasAttractions) {
      actualInclusions.push(
        "All sightseeing and transfers by air-conditioned shared coach"
      );
      actualInclusions.push(
        "Services of a professional local tour coordinator"
      );
    }
    if (visaData) {
      actualInclusions.push("Visa processing and related services");
    }
    if (categoryEnabled?.insurance !== false) {
      actualInclusions.push("Travel insurance");
    }

    progressCallback(60, "Building prompt");

    // Build prompt
    const prompt = buildPrompt(
      priorityMode,
      contextData,
      actualInclusions,
      actualExclusions,
      visaData,
      userInstructions,
      categoryEnabled
    );

    // Build prompt parts
    const promptParts = [{ text: prompt }];
    if (imageBase64) {
      logger.debug("Adding image context to prompt", { requestId });
      promptParts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: imageBase64,
        },
      });
    }

    progressCallback(70, "Generating itinerary with AI");

    // Use retry mechanism for AI generation
    const aiJobResult = await runAiJob({
      jobType: "itinerary_generation",
      leadId: lead?.id,
      payload: {
        destination,
        priorityMode,
        hasAttractions,
        hasPastedContent,
      },
      maxRetries: 3,
      backoffBaseMs: 1000,
      runFn: async ({ attempt }) => {
        logger.info("Calling Gemini API", {
          requestId,
          attempt,
          destination,
        });

        const response = await geminiAI.models.generateContent({
          model: "gemini-2.5-flash",
          contents: { parts: promptParts },
          config: {
            tools: [
              {
                googleSearch: {},
              },
            ],
          },
        });

        let aiResultText = response.text.trim();
        logger.debug("Received response from Gemini", { requestId });

        // Remove markdown code blocks if present
        if (aiResultText.startsWith("```")) {
          const lines = aiResultText.split("\n");
          const startIndex = lines.findIndex((line) =>
            line.trim().startsWith("```")
          );
          const endIndex = lines.findIndex(
            (line, idx) => idx > startIndex && line.trim().startsWith("```")
          );
          if (startIndex !== -1 && endIndex !== -1) {
            aiResultText = lines
              .slice(startIndex + 1, endIndex)
              .join("\n")
              .trim();
          } else if (startIndex !== -1) {
            aiResultText = lines
              .slice(startIndex + 1)
              .join("\n")
              .trim();
          }
        }

        // Try to extract JSON if there's extra text
        const jsonMatch = aiResultText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiResultText = jsonMatch[0];
        }

        // Parse JSON with error handling
        let aiResult;
        try {
          aiResult = JSON.parse(aiResultText);
        } catch (parseError) {
          logger.error("JSON parse error", {
            requestId,
            error: parseError.message,
            attempt,
          });

          // Try to fix control characters
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

            if (insideString && (code < 0x20 || code === 0x7f)) {
              if (code === 0x0a) sanitizedText += "\\n";
              else if (code === 0x0d) sanitizedText += "\\r";
              else if (code === 0x09) sanitizedText += "\\t";
              else if (code === 0x08) sanitizedText += "\\b";
              else if (code === 0x0c) sanitizedText += "\\f";
              else sanitizedText += `\\u${code.toString(16).padStart(4, "0")}`;
            } else {
              sanitizedText += char;
            }
          }

          try {
            aiResult = JSON.parse(sanitizedText);
            logger.info("Successfully parsed JSON after sanitization", {
              requestId,
            });
          } catch (retryError) {
            logger.error("Failed to parse JSON even after sanitization", {
              requestId,
              error: retryError.message,
            });
            throw new Error(
              `Failed to parse AI response as JSON: ${parseError.message}. Sanitization also failed: ${retryError.message}`
            );
          }
        }

        return aiResult;
      },
    });

    if (!aiJobResult.success) {
      logger.error("AI generation failed after retries", {
        requestId,
        error: aiJobResult.error,
      });
      throw new Error(
        `AI generation failed: ${aiJobResult.error?.message || "Unknown error"}`
      );
    }

    progressCallback(85, "Processing response");

    // Process AI response
    let aiResult = aiJobResult.result;

    // Process visa data format
    let processedVisaData = null;
    if (visaData) {
      processedVisaData = {
        type:
          visaData.type_of_visa ||
          (Array.isArray(visaData.visa_format) &&
          visaData.visa_format.length > 0
            ? visaData.visa_format[0]
            : "NORMAL"),
        price: visaData.price || 0,
        duration: visaData.duration_of_stay || "",
        validity_period: visaData.validity_period || "",
        length_of_stay: visaData.duration_of_stay || "",
        documents_required: visaData.documents_required || "",
        requirements: visaData.visa_requirements || "",
      };
    }

    // Process response
    aiResult = processAIResponse(
      aiResult,
      actualInclusions,
      actualExclusions,
      processedVisaData
    );

    progressCallback(90, "Fetching images");

    // Fetch images from Unsplash (optional, non-critical)
    try {
      const imageDestination =
        aiResult.creative_title?.toLowerCase().split(" ")[0] ||
        lead?.destination ||
        destination ||
        "travel";
      const unsplashAccessKey =
        process.env.UNSPLASH_ACCESS_KEY || "your-unsplash-access-key";

      const coverImageResponse = await fetch(
        `https://api.unsplash.com/photos/random?query=${encodeURIComponent(
          imageDestination
        )}&orientation=landscape&client_id=${unsplashAccessKey}`
      );
      if (coverImageResponse.ok) {
        const coverImageData = await coverImageResponse.json();
        aiResult.cover_image_url =
          coverImageData.urls?.regular || coverImageData.urls?.full || "";
      }

      const galleryResponse = await fetch(
        `https://api.unsplash.com/photos/random?query=${encodeURIComponent(
          imageDestination
        )}&count=4&client_id=${unsplashAccessKey}`
      );
      if (galleryResponse.ok) {
        const galleryData = await galleryResponse.json();
        aiResult.gallery_image_urls = Array.isArray(galleryData)
          ? galleryData
              .map((img) => img.urls?.regular || img.urls?.full || "")
              .filter(Boolean)
          : [];
      }
    } catch (imageError) {
      logger.warn("Failed to fetch images from Unsplash", {
        requestId,
        error: imageError.message,
      });
    }

    progressCallback(100, "Complete");

    // Cache the result for 24 hours
    cache.set(cacheKey, aiResult, 24 * 60 * 60 * 1000);

    const duration = Date.now() - startTime;
    logger.info("Itinerary generation completed", {
      requestId,
      destination,
      duration,
      priorityMode,
    });

    // Log slow requests
    if (duration > 10000) {
      logger.warn("Slow itinerary generation", {
        requestId,
        duration,
        destination,
      });
    }

    res.json(aiResult);
  } catch (error) {
    logger.error("Itinerary generation error", {
      requestId,
      error: error.message,
      stack: error.stack,
      destination: req.body.destination,
    });

    res.status(500).json({
      message: `Failed to generate itinerary: ${error.message}`,
      requestId,
    });
  }
};
