// Schema definitions for Gemini API

import { Type } from "@google/genai";

export function getItinerarySchema() {
  return {
    type: Type.OBJECT,
    properties: {
      creative_title: {
        type: Type.STRING,
        description: "A creative, marketable title for the tour package.",
      },
      duration: {
        type: Type.STRING,
        description:
          "The total duration of the trip in days, e.g., '5' or '7 Days'.",
      },
      overview: {
        type: Type.STRING,
        description: "A brief, engaging overview of the trip (2-3 sentences).",
      },
      day_wise_plan: {
        type: Type.ARRAY,
        description: "A detailed day-by-day plan of the itinerary.",
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
                "A short, catchy title for the day's activities, e.g., 'Arrival in Paris & Eiffel Tower Visit'.",
            },
            description: {
              type: Type.STRING,
              description:
                "A detailed description of the day's events in well-formatted HTML. Structure:\n" +
                "- DO NOT include date (date is shown separately) - NEVER use 📅 emoji\n" +
                "- Use ONLY minimal emojis: ✨ for closing statement (optional), NO other emojis\n" +
                "- Generate content normally without icons - write in plain, professional text\n" +
                "- Format: '<h4>[Section Title in Bold]</h4><p>[Detailed paragraph describing activities, transfers, and experiences]</p>'\n" +
                "- Section titles MUST be in bold using h4 tags: 'Arrival & Welcome' (Day 1), 'Morning Exploration', 'Afternoon Journey', 'Evening Exploration', 'Dining', 'Overnight'\n" +
                "- Common sections: 'Arrival & Welcome' (Day 1), 'Morning Exploration', 'Afternoon Journey', 'Evening Exploration', 'Dining', 'Overnight'\n" +
                "- INCLUDE SPECIFIC TIMES: When activities have start_time and end_time, include them as 'from [start_time] to [end_time]' (e.g., 'from 09:00 to 17:00', 'from 18:00 to 20:00')\n" +
                "- For each activity: Mention the full activity name and include time range if available (e.g., 'embark on the immersive BIG BUS - Night Tour from 18:00 to 20:00')\n" +
                "- Include transfers naturally in the narrative flow (e.g., 'After your arrival in Singapore, prepare to immerse yourself...', 'As dusk descends, embark on...')\n" +
                "- For Dining: List meals included (e.g., 'Dinner at leisure' or 'Breakfast at the hotel')\n" +
                "- For Overnight: List the city/location name only (e.g., 'Singapore')\n" +
                "- End with closing: '<p>✨ [Elegant, refined closing statement about the day - one sentence only]</p>'\n" +
                "- Use descriptive, engaging, premium language with specific details\n" +
                "- Include practical tips if relevant (e.g., weather-related advice)\n" +
                "- TRANSFER INCLUSION: When transfers are associated with activities, naturally include them in the narrative:\n" +
                "  * Use exact transfer name (e.g., 'SIC Airport to Hotel Transfer')\n" +
                "  * Day 1 with hotel + airport transfer: 'After your arrival at [airport/destination], you will be transferred by [transfer name] to your hotel'\n" +
                "  * First attraction: 'You will be transferred from your hotel to [attraction] by [transfer name]'\n" +
                "  * Middle attractions: 'You will be transferred from [previous] to [next] by [transfer name]'\n" +
                "  * Last attraction (departure): 'After your visit, you will be transferred to the airport by [transfer name]'\n" +
                "  * Use premium language (e.g., 'transferred by', 'enjoy a comfortable transfer via')\n" +
                "  * If no transfer is added, do NOT mention transfers\n" +
                "- End with closing: '<p>✨ [Very brief closing - one sentence only]</p>'\n" +
                "- Be professional and concise - no excessive adjectives or flowery language\n" +
                "- Consider current weather conditions and suggest weather-appropriate activities\n" +
                "- Mention any relevant festivals, events, or seasonal highlights happening during the travel period",
            },
          },
          required: ["day", "title", "description"],
        },
      },
      inclusions: {
        type: Type.ARRAY,
        description:
          "A detailed and comprehensive list of items included in the package. MUST be specific and detailed.",
        items: { type: Type.STRING },
      },
      exclusions: {
        type: Type.ARRAY,
        description:
          "A detailed and comprehensive list of items excluded from the package. MUST be specific and detailed.",
        items: { type: Type.STRING },
      },
      flights: {
        type: Type.ARRAY,
        description: "DO NOT generate flights - return empty array",
        items: {
          type: Type.OBJECT,
          properties: {
            direction: { type: Type.STRING },
            airline: { type: Type.STRING },
            from: { type: Type.STRING },
            to: { type: Type.STRING },
            departure_date: { type: Type.STRING },
            departure_time: { type: Type.STRING },
            arrival_date: { type: Type.STRING },
            arrival_time: { type: Type.STRING },
            duration: { type: Type.STRING },
            price: { type: Type.NUMBER },
            source: { type: Type.STRING },
          },
        },
      },
      hotels: {
        type: Type.ARRAY,
        description: "DO NOT generate hotels - return empty array",
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            city: { type: Type.STRING },
            pricing_type: { type: Type.STRING },
            nights: { type: Type.INTEGER },
            rooms: { type: Type.INTEGER },
            rate_per_night: { type: Type.NUMBER },
            check_in_date: { type: Type.STRING },
            check_out_date: { type: Type.STRING },
            room_type: { type: Type.STRING },
          },
        },
      },
      visa: {
        type: Type.OBJECT,
        description:
          "Visa information. Use visa data from database if available, otherwise null.",
        properties: {
          type: {
            type: Type.STRING,
            description:
              "Visa type (e.g., 'Tourist Visa', 'E-Visa', 'On Arrival', 'Not Required')",
          },
          price: {
            type: Type.NUMBER,
            description: "Visa price per person in INR (0 if not required)",
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
        description: "Travel insurance information. Always include this.",
        properties: {
          type: { type: Type.STRING },
          coverage: { type: Type.STRING },
          note: { type: Type.STRING },
        },
        required: ["type", "coverage", "note"],
      },
      manual_costing: {
        type: Type.OBJECT,
        description:
          "Manual costing information extracted from pasted content.",
        properties: {
          per_adult: { type: Type.NUMBER, description: "Cost per adult" },
          per_adult_twin: {
            type: Type.NUMBER,
            description: "Cost per adult (TWIN/DOUBLE SHARING)",
          },
          per_adult_triple: {
            type: Type.NUMBER,
            description: "Cost per adult (TRIPLE Sharing)",
          },
          per_adult_single: {
            type: Type.NUMBER,
            description: "Cost per adult (Single)",
          },
          per_child: { type: Type.NUMBER, description: "Cost per child" },
          per_infant: {
            type: Type.NUMBER,
            description: "Cost per infant (0 if FOC/free)",
          },
          gst_percentage: {
            type: Type.NUMBER,
            description: "GST percentage (e.g., 5 for 'GST 5%')",
          },
          tcs_percentage: {
            type: Type.NUMBER,
            description: "TCS percentage (e.g., 5 for 'TCS 5%')",
          },
          total_cost: { type: Type.NUMBER, description: "Total tour cost" },
        },
        required: [
          "per_adult",
          "per_adult_twin",
          "per_adult_triple",
          "per_adult_single",
          "per_child",
          "per_infant",
          "gst_percentage",
          "tcs_percentage",
          "total_cost",
        ],
      },
      important_notes: {
        type: Type.STRING,
        description:
          "Important notes and additional information for the itinerary. Include any special instructions, important reminders, booking conditions, or other relevant information that travelers should know. Format as HTML with paragraphs and bullet points if needed.",
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
      "manual_costing",
      "important_notes",
      "visa",
    ],
  };
}
