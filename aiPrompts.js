import { Type } from "@google/genai";

export const triagePrompt = `
You are an AI assistant for a travel agency. Your task is to analyze the user's message and determine their intent. The bot may have just asked the user a question, and the user might be ignoring it to provide a detailed request instead.

Analyze the following user message and respond with ONLY one of the following JSON objects:

1.  If the user is sending a simple greeting ("hi", "hello"), a short, non-specific question ("can you help?"), or a simple one/two word answer that is likely a response to a previous question (like "yes", "tour package", "chennai"):
    { "intent": "SIMPLE_RESPONSE" }

2.  If the user provides a specific request for any travel service (like booking a tour, flight, visa, or forex), containing details like destinations, durations, currencies, amounts, or other specific plans.
    Examples: "I want a 9 day trip to Rameswaram", "book a flight from Chennai to Dubai", "I want to convert 1000 USD to INR".
    { "intent": "DETAILED_ENQUIRY" }
`;

export const dataExtractionSchema = {
  type: Type.OBJECT,
  properties: {
    destination: {
      type: Type.STRING,
      description:
        "The primary destination for the trip. e.g., 'Aarupadai veedu, Rameswaram and Coimbatore', 'Phuket'",
    },
    duration: {
      type: Type.STRING,
      description: "The duration of the trip. e.g., '9 days 8 nights', '7 days 6 nights'. Calculate this from start_date and end_date if provided.",
    },
    start_date: {
      type: Type.STRING,
      description: "The start date of travel in YYYY-MM-DD format. Extract from phrases like '13th February 2026', 'night of 13th February 2026', 'from 13 Feb 2026'",
    },
    end_date: {
      type: Type.STRING,
      description: "The end date of travel in YYYY-MM-DD format. Extract from phrases like '19th February 2026', 'to 19 Feb 2026', 'until 19th February 2026'",
    },
    starting_point: {
      type: Type.STRING,
      description: "The starting city or point of the journey. e.g., 'Chennai'",
    },
    arrival_details: {
      type: Type.STRING,
      description:
        "Arrival details like time or flight number. e.g., 'morning 7 am at Chennai'",
    },
    departure_details: {
      type: Type.STRING,
      description:
        "Departure details like time or flight number. e.g., '10 pm from Chennai'",
    },
    adults: {
      type: Type.INTEGER,
      description: "The number of adults traveling.",
    },
    children: {
      type: Type.INTEGER,
      description: "The number of children traveling.",
    },
    needs_airfare: {
      type: Type.BOOLEAN,
      description: "True if the user mentions airfare, air ticket, flight ticket, flights, or asks for package options with airfare. False otherwise.",
    },
    needs_visa: {
      type: Type.BOOLEAN,
      description: "True if the user mentions visa, visa assistance, or visa requirements. False otherwise.",
    },
    notes: {
      type: Type.STRING,
      description:
        "Any other miscellaneous details, requests, or context provided by the user that doesn't fit into the other fields. Combine all extra information here. e.g., 'with my family', 'package options both with airfare and without airfare'",
    },
  },
};

export const dataExtractionPrompt = (userInput) => `
You are an intelligent data extraction assistant for a travel agency.
Analyze the user's request and extract the following information into a JSON object.

IMPORTANT EXTRACTION RULES:
1. DATES: Extract start_date and end_date in YYYY-MM-DD format from phrases like:
   - "13th February 2026" → start_date: "2026-02-13"
   - "night of 13th February 2026" → start_date: "2026-02-13"
   - "from 13 Feb 2026 to 19 Feb 2026" → start_date: "2026-02-13", end_date: "2026-02-19"
   - "13th February 2026 to 19th February 2026" → start_date: "2026-02-13", end_date: "2026-02-19"

2. DURATION: Calculate duration from start_date and end_date if both are provided.
   Format: "X days Y nights" (e.g., "7 days 6 nights" for Feb 13 to Feb 19)
   If duration is explicitly mentioned, use that instead.

3. AIRFARE DETECTION: Set needs_airfare to true if user mentions:
   - "airfare", "air ticket", "flight ticket", "flights", "airline"
   - "with airfare", "without airfare", "package with airfare"
   - "flight price", "flight cost", "air ticket price"
   - Any request for flight booking or air travel

4. VISA DETECTION: Set needs_visa to true if user mentions:
   - "visa", "visa assistance", "visa requirements", "visa application"

5. DESTINATION: Extract the primary destination. If multiple destinations, list them all.

Extract the following fields:
- destination
- duration (calculate from dates if not explicitly mentioned)
- start_date (YYYY-MM-DD format)
- end_date (YYYY-MM-DD format)
- starting_point
- arrival_details
- departure_details
- adults
- children
- needs_airfare (boolean)
- needs_visa (boolean)
- notes (for any other information)

If a piece of information is not present, omit the key from the JSON object.
Do not make up information. Only extract what is explicitly mentioned.
Combine all extra details, special requests, or context into the 'notes' field.

User request: "${userInput}"

Respond with ONLY the JSON object.
`;

export const validationPrompt = (botQuestion, userReply) => `
You are an AI validation agent. A chatbot asked a question, and a user replied. Your task is to validate the user's reply.

The chatbot asked: "${botQuestion}"
The user replied: "${userReply}"

Analyze the reply in the context of the question.
Respond with ONLY one of the following JSON objects:

1.  If the user's reply is a reasonable and direct answer to the question (even if it's just one word or has typos):
    { "status": "VALID", "answer": "[The corrected or extracted answer]" }
    Example: Question: "What is your name?", Reply: "my name is john". Your response: { "status": "VALID", "answer": "john" }
    Example: Question: "Travel date?", Reply: "tmrw". Your response: { "status": "VALID", "answer": "tomorrow" }

2.  If the user's reply is completely unrelated, gibberish, or avoids the question:
    { "status": "INVALID" }
    Example: Question: "What is your name?", Reply: "tell me about tours". Your response: { "status": "INVALID" }

3.  If the user is asking a follow-up question instead of answering:
    { "status": "QUESTION" }
    Example: Question: "What is your email?", Reply: "why do you need my email?". Your response: { "status": "QUESTION" }
`;
