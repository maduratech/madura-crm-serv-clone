// Input validation for itinerary generation

export function validateItineraryRequest(req) {
  const errors = [];

  // Validate destination
  if (!req.destination) {
    errors.push("Destination is required");
  } else if (typeof req.destination !== "string") {
    errors.push("Destination must be a string");
  } else if (req.destination.length > 100) {
    errors.push("Destination name is too long (max 100 characters)");
  } else if (req.destination.trim().length === 0) {
    errors.push("Destination cannot be empty");
  } else if (req.destination.trim().toUpperCase() === "N/A") {
    errors.push(
      "Destination cannot be N/A; provide a real destination (e.g. city or country)",
    );
  }

  // Validate attractions if provided
  if (req.attractions !== undefined) {
    if (!Array.isArray(req.attractions)) {
      errors.push("Attractions must be an array");
    } else {
      req.attractions.forEach((attraction, idx) => {
        if (!attraction.name || typeof attraction.name !== "string") {
          errors.push(`Attraction at index ${idx} must have a valid name`);
        }
        if (attraction.day_number !== undefined) {
          if (
            !Number.isInteger(attraction.day_number) ||
            attraction.day_number < 1
          ) {
            errors.push(
              `Attraction at index ${idx} must have a valid day_number (>= 1)`,
            );
          }
        }
      });
    }
  }

  // Validate flights if provided
  if (req.flights !== undefined) {
    if (!Array.isArray(req.flights)) {
      errors.push("Flights must be an array");
    }
  }

  // Validate hotels if provided
  if (req.hotels !== undefined) {
    if (!Array.isArray(req.hotels)) {
      errors.push("Hotels must be an array");
    }
  }

  // Validate pastedText if provided
  if (req.pastedText !== undefined && typeof req.pastedText !== "string") {
    errors.push("Pasted text must be a string");
  }

  // Validate userInstructions if provided
  if (
    req.userInstructions !== undefined &&
    typeof req.userInstructions !== "string"
  ) {
    errors.push("User instructions must be a string");
  }

  // Validate imageBase64 if provided
  if (req.imageBase64 !== undefined && typeof req.imageBase64 !== "string") {
    errors.push("Image base64 must be a string");
  }

  // Validate categoryEnabled if provided
  if (
    req.categoryEnabled !== undefined &&
    typeof req.categoryEnabled !== "object"
  ) {
    errors.push("Category enabled must be an object");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
