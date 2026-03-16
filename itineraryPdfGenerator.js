import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { logger } from "./utils/logger.js";
import {
  getChromiumPathForLaunch,
  validateChromiumPath,
} from "./utils/chromiumHelper.js";

// Verbose PDF logs only when PDF_DEBUG=1 (e.g. for troubleshooting)
const pdfLog = (...args) => {
  if (process.env.PDF_DEBUG) console.log(...args);
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Replace dynamic date tags in text ({{date}} = 1 day from today)
// This function can be used both in generateItineraryHtml and in the main handler
function replaceDateTags(text) {
  if (!text) return text;

  // Calculate date 1 day from today
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  // Replace {{date}} with the calculated date
  return text.replace(/\{\{date\}\}/g, dateStr);
}

// Format phone number with country code: +91 94442 71821
function formatPhoneNumber(phone) {
  if (!phone) return "";

  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");

  // If starts with country code (91 for India, etc.)
  if (digits.length >= 10) {
    // Check if it starts with common country codes
    if (digits.startsWith("91") && digits.length === 12) {
      // India: +91 XXXXX XXXXX
      return `+91 ${digits.substring(2, 7)} ${digits.substring(7)}`;
    } else if (digits.startsWith("1") && digits.length === 11) {
      // US/Canada: +1 XXX XXX XXXX
      return `+1 ${digits.substring(1, 4)} ${digits.substring(
        4,
        7,
      )} ${digits.substring(7)}`;
    } else if (digits.length === 10) {
      // Assume India if 10 digits
      return `+91 ${digits.substring(0, 5)} ${digits.substring(5)}`;
    } else {
      // Generic formatting: +XX XXX XXX XXXX
      const countryCode = digits.substring(0, digits.length - 10);
      const rest = digits.substring(digits.length - 10);
      return `+${countryCode} ${rest.substring(0, 5)} ${rest.substring(5)}`;
    }
  }

  return phone; // Return original if can't format
}

// Currency symbol mapping
function getCurrencySymbol(currency) {
  const symbols = {
    INR: "₹",
    USD: "$",
    EUR: "€",
    GBP: "£",
    AUD: "A$",
    CAD: "C$",
    SGD: "S$",
    JPY: "¥",
    CHF: "CHF",
    CNY: "¥",
    NZD: "NZ$",
  };
  return symbols[currency] || currency;
}

// Format currency amount
function formatCurrency(amount, currency, fxRates) {
  if (currency === "INR") {
    return `₹ ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  }

  if (fxRates && fxRates[currency]) {
    const convertedAmount = amount / fxRates[currency];
    const symbol = getCurrencySymbol(currency);
    const locale =
      currency === "USD" ||
      currency === "CAD" ||
      currency === "AUD" ||
      currency === "NZD"
        ? "en-US"
        : currency === "GBP"
          ? "en-GB"
          : currency === "EUR"
            ? "de-DE"
            : currency === "JPY" || currency === "CNY"
              ? "ja-JP"
              : "en-IN";
    return `${symbol} ${convertedAmount.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  // Fallback to INR if rates not available
  return `₹ ${amount.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// Generate HTML template for itinerary PDF
function generateItineraryHtml(data) {
  const {
    bookingId,
    customerName,
    customerPhone,
    destination,
    startDate,
    endDate,
    duration,
    nights,
    days,
    adults,
    children,
    childrenAges,
    dayWisePlan,
    costing,
    flightsData = [],
    hotelsData = [],
    attractionsData = [],
    transfersData = [],
    transfersMap = {},
    visaInfo = null,
    inclusions,
    exclusions,
    termsAndConditions,
    cancellationPolicy,
    notes,
    branchName,
    branchLogo,
    frontPageImageUrl,
    finalPageImageUrl,
    bankDetails,
    itineraryImage,
    travelConsultant,
    tourRegion = "International",
    razorpayLink = null,
    branchRazorpayLink = null,
    categoryEnabled = {},
    infants = 0,
    displayCurrency = "INR",
    fxRates = {},
  } = data;

  // Parse date string without timezone issues
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    // Handle Date objects
    if (dateStr instanceof Date) {
      return dateStr;
    }
    // Handle date strings in YYYY-MM-DD format to avoid timezone issues
    if (typeof dateStr === "string") {
      // Try YYYY-MM-DD format first
      const ymdMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (ymdMatch) {
        const [, year, month, day] = ymdMatch;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      }
      // Try MM/DD/YYYY format (e.g., "1/10/2026")
      const mdyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (mdyMatch) {
        const [, month, day, year] = mdyMatch;
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      }
      // Try ISO string with time
      if (dateStr.includes("T")) {
        const datePart = dateStr.split("T")[0];
        const ymdMatch2 = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (ymdMatch2) {
          const [, year, month, day] = ymdMatch2;
          return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        }
      }
      // Fallback to standard Date parsing
      return new Date(dateStr);
    }
    return null;
  };

  // Format date to "Dec 14, 2025 (Sun)"
  const formatDate = (dateStr) => {
    if (!dateStr) return "";
    // If it's already a Date object, use it directly (no parsing needed)
    let date;
    if (dateStr instanceof Date) {
      date = dateStr;
    } else {
      date = parseDate(dateStr);
    }
    if (!date || isNaN(date.getTime())) return "";
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    // Use local date methods to avoid timezone issues
    return `${
      months[date.getMonth()]
    } ${date.getDate()}, ${date.getFullYear()} (${days[date.getDay()]})`;
  };

  // Helper function to limit text to 40-50 words
  const limitWords = (text, maxWords = 45) => {
    if (!text) return "";
    const words = text.split(" ");
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(" ") + "...";
  };

  // Helper function to format text with bullets (converts newlines and HTML lists to proper bullet format)
  const formatTextWithBullets = (text) => {
    if (!text) return "";

    // If text contains HTML list tags, preserve them
    if (text.includes("<ul>") || text.includes("<li>")) {
      // Clean up HTML and ensure proper formatting
      let formatted = text
        .replace(/<ul[^>]*>/gi, "<ul>")
        .replace(/<\/ul>/gi, "</ul>")
        .replace(/<li[^>]*>/gi, "<li>")
        .replace(/<\/li>/gi, "</li>");

      // If there are list items, return as-is (CSS will style them)
      if (formatted.includes("<li>")) {
        return formatted;
      }
    }

    // If text has newlines, convert to list
    if (text.includes("\n")) {
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length > 1) {
        return `<ul>${lines
          .map((line) => `<li>${line.replace(/^[•\-\*]\s+/, "").trim()}</li>`)
          .join("")}</ul>`;
      }
    }

    // If text contains bullet points (•, -, *, etc.), convert to list
    const bulletPattern = /^[\s]*[•\-\*]\s+(.+)$/gm;
    const matches = [...text.matchAll(bulletPattern)];
    if (matches.length > 0) {
      const items = matches.map((m) => m[1].trim());
      return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    }

    // Otherwise, return as paragraph
    return `<p>${text}</p>`;
  };

  // Helper function to parse text into points (split by periods for point-by-point)
  const parseToPoints = (text) => {
    if (!text) return [];
    if (Array.isArray(text)) {
      // If already an array, return as is (each item is a point)
      return text;
    }

    // First, check if text contains HTML list items (<li> tags)
    const liMatches = text.match(/<li[^>]*>(.*?)<\/li>/gi);
    if (liMatches && liMatches.length > 0) {
      return liMatches
        .map((li) => {
          let content = li.replace(/<li[^>]*>|<\/li>/gi, "").trim();
          // Remove any nested HTML tags but keep text
          content = content.replace(/<[^>]+>/g, "").trim();
          return content;
        })
        .filter((p) => p.length > 0);
    }

    // Check for HTML unordered/ordered lists
    const ulMatches = text.match(/<ul[^>]*>([\s\S]*?)<\/ul>/gi);
    if (ulMatches && ulMatches.length > 0) {
      const allPoints = [];
      ulMatches.forEach((ul) => {
        const items = ul.match(/<li[^>]*>(.*?)<\/li>/gi);
        if (items) {
          items.forEach((item) => {
            let content = item.replace(/<li[^>]*>|<\/li>/gi, "").trim();
            content = content.replace(/<[^>]+>/g, "").trim();
            if (content.length > 0) allPoints.push(content);
          });
        }
      });
      if (allPoints.length > 0) return allPoints;
    }

    // Split by newlines first (most common for bullet lists)
    let points = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If we got multiple points from newlines, clean them up
    if (points.length > 1) {
      points = points
        .map((p) => {
          // Remove bullet markers
          p = p
            .replace(/^[•\-\*]\s+/, "")
            .replace(/^\d+\.\s+/, "")
            .trim();
          return p;
        })
        .filter((p) => p.length > 0);
      if (points.length > 0) return points;
    }

    // Try splitting by bullet markers
    points = text
      .split(/(?:^|\n)\s*[•\-\*]\s+|(?:^|\n)\s*\d+\.\s+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.match(/^\d+\.?\s*$/));

    if (points.length > 1) return points;

    // Try splitting by periods followed by space and capital letter
    points = text
      .split(/\.\s+(?=[A-Z])|\.\s*$/)
      .map((p) => p.trim().replace(/^[•\-\*]\s*/, ""))
      .filter((p) => p.length > 0 && !p.match(/^\d+\.?\s*$/));

    if (points.length > 1) return points;

    // Try semicolons
    points = text
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Clean up and ensure each point ends with proper punctuation if it doesn't already
    points = points
      .map((p) => {
        p = p.trim();
        // Remove any remaining HTML tags
        p = p.replace(/<[^>]+>/g, "").trim();
        // If point doesn't end with punctuation, add period
        if (p.length > 0 && !p.match(/[.!?]$/)) {
          p = p + ".";
        }
        return p;
      })
      .filter((p) => p.length > 0);

    return points.length > 0 ? points : [text.replace(/<[^>]+>/g, "").trim()];
  };

  // Generate day-wise itinerary HTML (Modern Creative Card Design)
  const dayWiseHtml = (dayWisePlan || [])
    .map((day) => {
      const dayDate = day.date ? formatDate(day.date) : "";
      const dayNumber = day.day || "";
      const dayNumberFormatted = dayNumber
        ? String(dayNumber).padStart(2, "0")
        : "";
      // Remove date from description if it exists (since we show it separately)
      let description = day.description || "";
      // Remove date emoji line if present
      description = description.replace(/<p>📅\s*[^<]*<\/p>\s*/i, "");
      return `
      <div class="day-card-modern">
        <div class="day-card-modern-header">
          <div class="day-card-modern-number">${dayNumberFormatted}</div>
          <div class="day-card-modern-header-content">
            <div class="day-card-modern-title">${day.title || ""}</div>
            <div class="day-card-modern-date">${dayDate}</div>
          </div>
        </div>
        <div class="day-card-modern-body">
          <div class="day-card-modern-description">${description}</div>
        </div>
      </div>
    `;
    })
    .join("");

  // Generate Trip Cost Summary HTML (Modern Creative Table Format)
  /* Payment button commented out for now - original code was:
  (() => {
    const paymentLink = razorpayLink || branchRazorpayLink;
    return paymentLink ? `
    <div class="payment-button-container">
      <a href="${paymentLink}" target="_blank" class="payment-button">
        <span class="payment-button-icon">💳</span>
        <span class="payment-button-text">Make Payment</span>
      </a>
      <p class="payment-note">This special discounted price is available for a limited time. Pay the booking amount today to block your tour at this rate.</p>
    </div>
    ` : '';
  })()
  */
  // Only show Trip Cost Summary if costing exists AND grandTotal > 0
  const tripCostSummaryHtml =
    costing && costing.grandTotal && costing.grandTotal > 0
      ? `
    <div class="costing-section-modern">
      <div class="costing-card-modern">
        <div class="costing-card-modern-header">
          <div class="costing-card-modern-icon">💰</div>
          <div class="costing-card-modern-title-wrapper">
            <div class="costing-card-modern-label">Trip</div>
            <div class="costing-card-modern-title">Cost Summary</div>
          </div>
        </div>
        <div class="costing-card-modern-body">
          <div class="cost-table-modern">
            ${(() => {
              // Calculate per-person prices
              // For manual costing: perAdult is already per-person
              // For itemized costing: perAdult is total for all adults, need to divide
              const perPersonAdult = costing.isManual
                ? costing.perAdult
                : costing.adultsCount > 0
                  ? Math.round(costing.perAdult / costing.adultsCount)
                  : 0;
              const perPersonChild = costing.isManual
                ? costing.perChild
                : costing.childrenCount > 0
                  ? Math.round(costing.perChild / costing.childrenCount)
                  : 0;

              // Get unique child ages from childrenAges array
              const uniqueChildAges =
                childrenAges && childrenAges.length > 0
                  ? Array.from(new Set(childrenAges)).sort((a, b) => a - b)
                  : [];

              // Check if additional pricing options with allocated adults are available
              const hasAllocatedPricing =
                costing.additionalPricingOptions &&
                costing.additionalPricingOptions.some((opt) => opt.adults > 0);

              return `
              <!-- Per Person Prices -->
              ${
                hasAllocatedPricing && costing.additionalPricingOptions
                  ? (() => {
                      // Group by sharing type to show adult and child together
                      const grouped = {};
                      costing.additionalPricingOptions.forEach((opt) => {
                        const key = opt.sharingType || "default";
                        if (!grouped[key]) {
                          grouped[key] = { adult: null, child: null };
                        }
                        if (opt.type === "adult" && opt.adults > 0) {
                          grouped[key].adult = opt;
                        } else if (opt.type === "child" && opt.children > 0) {
                          grouped[key].child = opt;
                        }
                      });

                      // Generate HTML for each group
                      let html = "";
                      Object.keys(grouped).forEach((key) => {
                        const group = grouped[key];
                        if (group.adult) {
                          html += `
              <div class="cost-row-modern">
                <span class="cost-label-modern">${group.adult.label} (${
                  group.adult.adults
                } ${group.adult.adults === 1 ? "Adult" : "Adults"})</span>
                <span class="cost-value-modern">${formatCurrency(
                  group.adult.total,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `;
                        }
                        if (group.child) {
                          const ages = group.child.ages || [];
                          let ageText = "";
                          if (ages.length === 1) {
                            ageText = `, Age ${ages[0]}`;
                          } else if (ages.length > 1) {
                            ageText = `, Ages ${ages.join(", ")}`;
                          }
                          html += `
              <div class="cost-row-modern" style="margin-left: 1rem; color: #64748b;">
                <span class="cost-label-modern">${group.child.label} (${
                  group.child.children
                } ${
                  group.child.children === 1 ? "Child" : "Children"
                }${ageText})</span>
                <span class="cost-value-modern">${formatCurrency(
                  group.child.total,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `;
                        }
                      });
                      return html;
                    })()
                  : `
              <div class="cost-row-modern">
                <span class="cost-label-modern">Per Adult</span>
                <span class="cost-value-modern">${formatCurrency(
                  perPersonAdult,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `
              }
              ${
                costing.childrenCount > 0 &&
                perPersonChild > 0 &&
                uniqueChildAges.length > 0
                  ? uniqueChildAges
                      .map(
                        (age) => `
              <div class="cost-row-modern">
                <span class="cost-label-modern">Per Child (${age} years)</span>
                <span class="cost-value-modern">${formatCurrency(
                  perPersonChild,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `,
                      )
                      .join("")
                  : costing.childrenCount > 0 && perPersonChild > 0
                    ? `
              <div class="cost-row-modern">
                <span class="cost-label-modern">Per Child</span>
                <span class="cost-value-modern">${formatCurrency(
                  perPersonChild,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `
                    : ""
              }
              <!-- Subtotal -->
              <div class="cost-row-modern cost-row-subtotal">
                <span class="cost-label-modern">Subtotal (Before Taxes & Flights)</span>
                <span class="cost-value-modern">${formatCurrency(
                  costing.subtotal + (costing.discountAmount || 0),
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
              `;
            })()}
            ${
              costing.discountAmount !== undefined &&
              costing.discountAmount !== null &&
              costing.discountAmount > 0 &&
              costing.discountPercentage !== undefined &&
              costing.discountPercentage !== null &&
              costing.discountPercentage > 0
                ? `
              <div class="cost-row-modern cost-row-discount">
                <span class="cost-label-modern">
                  Discount (${costing.discountPercentage}%)
                </span>
                <span class="cost-value-modern discount-value">-₹ ${(
                  costing.discountAmount || 0
                ).toLocaleString("en-IN")}</span>
              </div>
              <div class="cost-row-modern">
                <span class="cost-label-modern">Subtotal (After Discount)</span>
                <span class="cost-value-modern">${formatCurrency(
                  costing.subtotal,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
            `
                : ""
            }
            ${
              costing.flightCost > 0
                ? (() => {
                    // Show detailed breakdown: Adult, Children, Infant (matching reference image)
                    const breakdownItems = [];
                    const adults = costing.adultsCount || 0;
                    const children = costing.childrenCount || 0;
                    // Use infants from data parameter (passed from templateData)

                    if (
                      costing.flightCostBreakdown?.adultCost > 0 &&
                      adults > 0
                    ) {
                      const perAdult = Math.round(
                        costing.flightCostBreakdown.adultCost / adults,
                      );
                      const totalAdultCost =
                        costing.flightCostBreakdown.adultCost;
                      breakdownItems.push({
                        label: `Adult ${adults} x ₹${perAdult.toLocaleString(
                          "en-IN",
                        )}`,
                        total: totalAdultCost,
                      });
                    }
                    // Show children by age if age-based breakdown is available
                    if (
                      costing.flightCostBreakdown?.childCost > 0 &&
                      children > 0
                    ) {
                      // Check if we have age-based breakdown
                      if (
                        costing.flightCostBreakdown?.childCostByAge &&
                        Object.keys(costing.flightCostBreakdown.childCostByAge)
                          .length > 0
                      ) {
                        // Show each age separately
                        Object.entries(
                          costing.flightCostBreakdown.childCostByAge,
                        ).forEach(([age, cost]) => {
                          const ageNum = parseInt(age);
                          const costNum =
                            typeof cost === "number"
                              ? cost
                              : parseFloat(cost) || 0;
                          if (costNum > 0) {
                            breakdownItems.push({
                              label: `Children (${age} years) x ₹${costNum.toLocaleString(
                                "en-IN",
                              )}`,
                              total: costNum,
                            });
                          }
                        });
                      } else {
                        // Fallback to average per child
                        const perChild = Math.round(
                          costing.flightCostBreakdown.childCost / children,
                        );
                        const totalChildCost =
                          costing.flightCostBreakdown.childCost;
                        breakdownItems.push({
                          label: `Children ${children} x ${formatCurrency(
                            perChild,
                            displayCurrency,
                            fxRates,
                          )}`,
                          total: totalChildCost,
                        });
                      }
                    }
                    if (costing.flightCostBreakdown?.infantCost > 0) {
                      const infantCost = costing.flightCostBreakdown.infantCost;
                      breakdownItems.push({
                        label: `Infant ${
                          infants || 1
                        } x ₹${infantCost.toLocaleString("en-IN")}`,
                        total: infantCost,
                      });
                    }

                    if (breakdownItems.length > 0) {
                      return `
              <div class="cost-row-modern">
                <span class="cost-label-modern" style="font-weight: 600;">Fare charges</span>
                <span></span>
              </div>
              ${breakdownItems
                .map(
                  (item) => `
              <div class="cost-row-modern">
                <span class="cost-label-modern">${item.label}</span>
                <span class="cost-value-modern">${formatCurrency(
                  item.total,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
            `,
                )
                .join("")}
              <div class="cost-row-modern">
                <span class="cost-label-modern">Total Flight Fare</span>
                <span class="cost-value-modern">${formatCurrency(
                  costing.flightCost,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
            `;
                    } else {
                      return `
              <div class="cost-row-modern">
                <span class="cost-label-modern">Flight Cost</span>
                <span class="cost-value-modern">${formatCurrency(
                  costing.flightCost,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
            `;
                    }
                  })()
                : ""
            }
            ${
              costing.isGstApplied
                ? `
              <div class="cost-row-modern">
                <span class="cost-label-modern">GST${
                  costing.gstPercentage
                    ? ` (${costing.gstPercentage}%)`
                    : " (5%)"
                }</span>
                <span class="cost-value-modern">${formatCurrency(
                  costing.gst,
                  displayCurrency,
                  fxRates,
                )}</span>
              </div>
            `
                : ""
            }
            <div class="cost-row-modern cost-row-total">
              <span class="cost-label-modern">Grand Total (All Inclusive)</span>
              <span class="cost-value-modern">${formatCurrency(
                costing.grandTotal,
                displayCurrency,
                fxRates,
              )}</span>
            </div>
          </div>
        </div>
      </div>
      ${
        costing.isTcsApplied
          ? `
        <div class="tcs-notice" style="margin-top: 15px; padding: 12px; background: #fff9e6; border-left: 3px solid #ffd700; border-radius: 6px; font-size: 11px; color: #333; line-height: 1.6;">
          <strong>Note:</strong> ${
            costing.tcsPercentage || 5
          }% TCS (${formatCurrency(
            costing.tcs,
            displayCurrency,
            fxRates,
          )}) is calculated but not included in the Grand Total above. TCS can be claimed while filing your Income Tax Return (ITR).
        </div>
      `
          : ""
      }
       ${(() => {
         const paymentLink = razorpayLink || branchRazorpayLink;
         const shouldShowPaymentButton =
           data.showPaymentButton !== undefined ? data.showPaymentButton : true;
         return paymentLink && shouldShowPaymentButton
           ? `
         <div style="margin-top: 20px;">
           <a href="${paymentLink}" target="_blank" style="display: block; width: 100%; padding: 14px 32px; background: #ffffff; color: #191974; border: 2px solid #191974; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none; text-align: center; transition: all 0.3s ease; box-shadow: 0 2px 8px rgba(25, 25, 116, 0.15);">
             💳 Make Payment
           </a>
           <p style="margin-top: 12px; font-size: 11px; color: #666; text-align: center; line-height: 1.5; font-style: italic;">
             ⚡ Pay your booking fees today to secure this tour at our special discounted rate! Limited time offer - don't miss out!
           </p>
         </div>
         `
           : "";
       })()}
    </div>
  `
      : "";

  // Helper to format flight duration: "PT3H30M" -> "03h 30m"
  const formatFlightDuration = (durationStr) => {
    if (!durationStr) return "";

    // Handle ISO 8601 duration format (PT3H30M)
    if (durationStr.startsWith("PT")) {
      const hoursMatch = durationStr.match(/(\d+)H/);
      const minutesMatch = durationStr.match(/(\d+)M/);
      const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
      const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
      return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(
        2,
        "0",
      )}m`;
    }

    // Handle formats like "3h 30m" or "03h 30m"
    const hourMatch = durationStr.match(/(\d+)h/i);
    const minuteMatch = durationStr.match(/(\d+)m/i);
    if (hourMatch || minuteMatch) {
      const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
      const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
      return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(
        2,
        "0",
      )}m`;
    }

    return durationStr; // Return as-is if can't parse
  };

  // Helper to format date-time for flights
  const formatFlightDateTime = (dateTimeStr) => {
    if (!dateTimeStr) return "";
    try {
      const date = new Date(dateTimeStr);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const timeStr = date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return `${
        months[date.getMonth()]
      } ${date.getDate()}, ${date.getFullYear()} (${
        days[date.getDay()]
      }) ${timeStr}`;
    } catch {
      return dateTimeStr;
    }
  };

  // Generate Addons section (Flights) - Modern Design
  const addonsHtml =
    flightsData && flightsData.length > 0
      ? `
    <div class="flights-section">
      <div class="flights-card">
        <div class="flights-card-header">
          <div class="flights-card-left">
            <div class="flights-card-label">Flight</div>
            <div class="flights-card-title">Details</div>
          </div>
        </div>
        <div class="flights-card-body">
          ${flightsData
            .map((flight) => {
              const directionLabel =
                flight.direction === "onward"
                  ? "Onward"
                  : flight.direction === "intercity"
                    ? "Intercity"
                    : "Return";
              const directionClass =
                flight.direction === "onward"
                  ? "onward"
                  : flight.direction === "intercity"
                    ? "intercity"
                    : "return";
              const segments = flight.segments || [];
              const firstSegment = segments[0] || {};
              const lastSegment = segments[segments.length - 1] || {};
              const fromAirport =
                firstSegment.from_airport || firstSegment.from || "N/A";
              const toAirport =
                lastSegment.to_airport || lastSegment.to || "N/A";
              const departureDateTime =
                firstSegment.departure_time || firstSegment.date || "";
              const arrivalDateTime = lastSegment.arrival_time || "";
              const airline = firstSegment.airline || "N/A";
              const flightNumber = firstSegment.flight_number || "";
              const duration =
                firstSegment.duration || flight.totalDuration || "";
              // Handle stops - can be "Non-stop", "0", "0 Stop", number, or string
              let stops = firstSegment.stop || "0";
              // Normalize stops value
              if (
                stops === "Non-stop" ||
                stops === "0" ||
                stops === 0 ||
                stops === "0 Stop"
              ) {
                stops = "Non-stop";
              } else if (typeof stops === "string" && stops.includes("stop")) {
                // Handle "1 Stop", "2 Stops" etc.
                const stopMatch = stops.match(/(\d+)/);
                if (stopMatch) {
                  const stopCount = parseInt(stopMatch[1]);
                  stops =
                    stopCount === 0
                      ? "Non-stop"
                      : stopCount === 1
                        ? "1 Stop"
                        : `${stopCount} Stops`;
                }
              } else if (typeof stops === "number") {
                stops =
                  stops === 0
                    ? "Non-stop"
                    : stops === 1
                      ? "1 Stop"
                      : `${stops} Stops`;
              }

              return `
              <div class="flight-item">
                <div class="flight-header">
                  <div class="flight-route">
                    <span class="flight-route-from">${fromAirport}</span>
                    <span class="flight-arrow">→</span>
                    <span class="flight-route-to">${toAirport}</span>
                  </div>
                  <span class="flight-badge ${directionClass}">${directionLabel}</span>
                </div>
                <div class="flight-details">
                  ${
                    airline !== "N/A"
                      ? `
                    <div class="flight-detail-row">
                      <span class="flight-detail-label">Airline:</span>
                      <span class="flight-detail-value">${airline}${
                        flightNumber ? " " + flightNumber : ""
                      }</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    departureDateTime
                      ? `
                    <div class="flight-detail-row">
                      <span class="flight-detail-label">Departure:</span>
                      <span class="flight-detail-value">${formatFlightDateTime(
                        departureDateTime,
                      )}</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    arrivalDateTime
                      ? `
                    <div class="flight-detail-row">
                      <span class="flight-detail-label">Arrival:</span>
                      <span class="flight-detail-value">${formatFlightDateTime(
                        arrivalDateTime,
                      )}</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    duration
                      ? `
                    <div class="flight-detail-row">
                      <span class="flight-detail-label">Duration:</span>
                      <span class="flight-detail-value">${formatFlightDuration(
                        duration,
                      )}</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    stops !== undefined && stops !== null
                      ? `
                    <div class="flight-detail-row">
                      <span class="flight-detail-label">Stops:</span>
                      <span class="flight-detail-value">${stops}</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    flight.price > 0
                      ? `
                    <div class="flight-detail-row flight-price-row">
                      <span class="flight-detail-label">Price:</span>
                      <span class="flight-detail-value flight-price">${
                        flight.currency || "INR"
                      } ${flight.price.toLocaleString("en-IN")}</span>
                    </div>
                  `
                      : ""
                  }
                </div>
              </div>
            `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `
      : "";

  // Generate Hotels section (Unique Modern Design)
  const hotelsHtml =
    hotelsData && hotelsData.length > 0
      ? `
    <div class="hotels-section">
      <div class="hotels-card-modern">
        <div class="hotels-card-modern-header">
          <div class="hotels-card-modern-icon">🏨</div>
          <div class="hotels-card-modern-title-wrapper">
            <div class="hotels-card-modern-label">Hotel</div>
            <div class="hotels-card-modern-title">Accommodation</div>
          </div>
        </div>
        <div class="hotels-card-modern-body">
          ${hotelsData
            .map((hotel, index) => {
              const checkInDate = hotel.check_in_date
                ? formatDate(hotel.check_in_date)
                : "";
              const checkOutDate = hotel.check_out_date
                ? formatDate(hotel.check_out_date)
                : "";
              // Format time if available (HH:MM format)
              const formatTime = (timeStr) => {
                if (!timeStr) return "";
                // Handle both HH:MM and HH:MM:SS formats
                const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})/);
                if (timeMatch) {
                  const hours = parseInt(timeMatch[1]);
                  const minutes = timeMatch[2];
                  const period = hours >= 12 ? "PM" : "AM";
                  const displayHours =
                    hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
                  return `${displayHours}:${minutes} ${period}`;
                }
                return timeStr;
              };
              const checkInTime = hotel.check_in_time
                ? formatTime(hotel.check_in_time)
                : "";
              const checkOutTime = hotel.check_out_time
                ? formatTime(hotel.check_out_time)
                : "";
              return `
              <div class="hotel-item-modern">
                <div class="hotel-item-header">
                  <div class="hotel-name-modern">${hotel.name || "Hotel"}</div>
                  <div class="hotel-location-modern">${hotel.city || ""}</div>
                </div>
                <div class="hotel-details-modern">
                  ${
                    checkInDate
                      ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Check-in:</span>
                      <span class="hotel-detail-value">${checkInDate}${
                        checkInTime ? ` ${checkInTime}` : ""
                      }</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    checkOutDate
                      ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Check-out:</span>
                      <span class="hotel-detail-value">${checkOutDate}${
                        checkOutTime ? ` ${checkOutTime}` : ""
                      }</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    hotel.nights
                      ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Nights:</span>
                      <span class="hotel-detail-value">${hotel.nights} ${
                        hotel.nights === 1 ? "Night" : "Nights"
                      }</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    hotel.quantity && hotel.quantity > 1
                      ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Rooms:</span>
                      <span class="hotel-detail-value">${hotel.quantity} ${
                        hotel.quantity === 1 ? "Room" : "Rooms"
                      }</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    hotel.room_type
                      ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Room Type:</span>
                      <span class="hotel-detail-value">${hotel.room_type}</span>
                    </div>
                  `
                      : ""
                  }
                  ${
                    hotel.rooms && hotel.rooms.length > 0
                      ? hotel.rooms
                          .map(
                            (room, roomIndex) => `
                    <div class="hotel-detail-row" style="margin-top: ${
                      roomIndex > 0 ? "8px" : "0"
                    }; padding-top: ${
                      roomIndex > 0 ? "8px" : "0"
                    }; border-top: ${
                      roomIndex > 0
                        ? "1px solid rgba(227, 235, 242, 0.5)"
                        : "none"
                    };">
                      <span class="hotel-detail-label">${
                        room.name || `Room ${roomIndex + 1}`
                      }:</span>
                      <span class="hotel-detail-value">
                        ${room.adults || 0} Adults, ${
                          room.children || 0
                        } Children
                      </span>
                    </div>
                    ${
                      String(data.itineraryStatus || "").toLowerCase() ===
                        "confirmed" &&
                      room.confirmation_number &&
                      String(room.confirmation_number).trim() !== ""
                        ? `
                    <div class="hotel-detail-row">
                      <span class="hotel-detail-label">Confirmation Number:</span>
                      <span class="hotel-detail-value"><strong style="color: #191975;">${room.confirmation_number}</strong></span>
                    </div>
                  `
                        : ""
                    }
                  `,
                          )
                          .join("")
                      : ""
                  }
                </div>
              </div>
            `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `
      : "";

  // Generate Attractions & Activities section
  const attractionsHtml =
    attractionsData && attractionsData.length > 0
      ? `
    <div class="hotels-section">
      <div class="hotels-card-modern">
        <div class="hotels-card-modern-header">
          <div class="hotels-card-modern-icon">🎯</div>
          <div class="hotels-card-modern-title-wrapper">
            <div class="hotels-card-modern-label">Attractions</div>
            <div class="hotels-card-modern-title">Activities & Transfers</div>
          </div>
        </div>
        <div class="hotels-card-modern-body">
          ${(() => {
            // Group by day
            const byDay = {};
            attractionsData.forEach((item) => {
              const day = item.day_number || 1;
              if (!byDay[day]) {
                byDay[day] = [];
              }
              byDay[day].push(item);
            });

            // Render each day's flow
            return Object.keys(byDay)
              .sort((a, b) => parseInt(a) - parseInt(b))
              .map((day) => {
                const dayItems = byDay[day];
                return `
                <div style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 2px solid rgba(227, 235, 242, 0.8);">
                  <div style="margin-bottom: 16px;">
                    <h3 style="font-size: 16px; font-weight: 700; color: #191975; margin: 0;">Day ${day}</h3>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 12px;">
                    ${dayItems
                      .map((item) => {
                        if (item.item_type === "transfer") {
                          // Render transfer
                          // Try to find transfer by ID first, then by name
                          const transfer = item.transfer_id
                            ? transfersMap[item.transfer_id]
                            : item.transfer_name
                              ? transfersMap[item.transfer_name]
                              : null;
                          const transferName =
                            item.transfer_name ||
                            item.name ||
                            transfer?.name ||
                            "Transfer";
                          const vehicleType = transfer?.vehicle_type || "";
                          const capacity = transfer?.capacity || "";

                          return `
                          <div class="hotel-item-modern" style="background: linear-gradient(135deg, #f0f4f8 0%, #e8f0f6 100%); border-left: 4px solid #4c49e6;">
                            <div class="hotel-item-header">
                              <div class="hotel-name-modern" style="color: #4c49e6;">${transferName}</div>
                              <div class="hotel-location-modern">${
                                item.location || ""
                              }</div>
                            </div>
                            <div class="hotel-details-modern">
                              ${
                                vehicleType
                                  ? `
                                <div class="hotel-detail-row">
                                  <span class="hotel-detail-label">Vehicle Type:</span>
                                  <span class="hotel-detail-value">${vehicleType}</span>
                                </div>
                              `
                                  : ""
                              }
                              ${
                                capacity
                                  ? `
                                <div class="hotel-detail-row">
                                  <span class="hotel-detail-label">Capacity:</span>
                                  <span class="hotel-detail-value">${capacity} passengers</span>
                                </div>
                              `
                                  : ""
                              }
                            </div>
                          </div>
                        `;
                        } else {
                          // Render attraction
                          return `
                          <div class="hotel-item-modern">
                            <div class="hotel-item-header">
                              <div class="hotel-name-modern">${
                                item.name || "Attraction"
                              }</div>
                              <div class="hotel-location-modern">${
                                item.location || ""
                              }</div>
                            </div>
                            <div class="hotel-details-modern">
                              ${
                                item.duration
                                  ? `
                                <div class="hotel-detail-row">
                                  <span class="hotel-detail-label">Duration:</span>
                                  <span class="hotel-detail-value">${item.duration}</span>
                                </div>
                              `
                                  : ""
                              }
                            </div>
                          </div>
                        `;
                        }
                      })
                      .join("")}
                  </div>
                </div>
              `;
              })
              .join("");
          })()}
        </div>
      </div>
    </div>
  `
      : "";

  // Generate Visa section (Unique Modern Design)
  // Show visa if visaInfo exists (for international tours) OR if detailed_visa exists in itinerary
  const visaHtml = visaInfo
    ? `
    <div class="visa-section-modern">
      <div class="visa-card-modern">
        <div class="visa-card-modern-header">
          <div class="visa-card-modern-icon">✈️</div>
          <div class="visa-card-modern-title-wrapper">
            <div class="visa-card-modern-label">Visa</div>
            <div class="visa-card-modern-title">Requirements</div>
          </div>
          ${
            visaInfo.destination
              ? `
          <div class="visa-card-modern-badge">${visaInfo.destination}</div>
          `
              : ""
          }
        </div>
        <div class="visa-card-modern-body">
          ${
            visaInfo.content
              ? `
            <div class="visa-content-modern">${visaInfo.content}</div>
          `
              : `
            <div class="visa-content-modern">
              ${
                visaInfo.type
                  ? `<div class="visa-info-row-modern"><strong>Type:</strong> ${visaInfo.type}</div>`
                  : ""
              }
              ${
                visaInfo.duration
                  ? `<div class="visa-info-row-modern"><strong>Processing Duration:</strong> ${visaInfo.duration}</div>`
                  : ""
              }
              ${
                visaInfo.validity_period
                  ? `<div class="visa-info-row-modern"><strong>Validity Period:</strong> ${visaInfo.validity_period}</div>`
                  : ""
              }
              ${
                visaInfo.length_of_stay
                  ? `<div class="visa-info-row-modern"><strong>Length of Stay:</strong> ${visaInfo.length_of_stay}</div>`
                  : ""
              }
              ${
                visaInfo.documents_required
                  ? `<div class="visa-info-row-modern"><strong>Documents Required:</strong> ${visaInfo.documents_required}</div>`
                  : ""
              }
              ${
                visaInfo.note
                  ? `<div class="visa-info-row-modern">${visaInfo.note}</div>`
                  : ""
              }
              ${
                visaInfo.includes
                  ? `<div class="visa-info-row-modern"><strong>Includes:</strong> ${visaInfo.includes}</div>`
                  : ""
              }
              ${
                visaInfo.requirements
                  ? `<div class="visa-info-row-modern"><strong>Requirements:</strong> ${visaInfo.requirements}</div>`
                  : ""
              }
              ${
                !visaInfo.type &&
                !visaInfo.duration &&
                !visaInfo.note &&
                !visaInfo.includes &&
                !visaInfo.requirements
                  ? `
                <div class="visa-info-row-modern">Visa information will be provided upon booking confirmation.</div>
              `
                  : ""
              }
            </div>
          `
          }
        </div>
      </div>
    </div>
  `
    : "";

  // Generate inclusions/exclusions HTML (modern card design)
  const inclusionsPoints = inclusions ? parseToPoints(inclusions) : [];
  const inclusionsHtml =
    inclusionsPoints.length > 0
      ? `
    <div class="inclusions-section-modern">
      <div class="inclusions-card-modern">
        <div class="inclusions-card-modern-header">
          <div class="inclusions-card-modern-icon">✓</div>
          <div class="inclusions-card-modern-title-wrapper">
            <div class="inclusions-card-modern-label">Package</div>
            <div class="inclusions-card-modern-title">Inclusions</div>
          </div>
        </div>
        <div class="inclusions-card-modern-body">
          <ul class="inclusions-list-modern">
            ${inclusionsPoints.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </div>
      </div>
    </div>
  `
      : "";

  const exclusionsPoints = exclusions ? parseToPoints(exclusions) : [];
  const exclusionsHtml =
    exclusionsPoints.length > 0
      ? `
    <div class="exclusions-section-modern">
      <div class="exclusions-card-modern">
        <div class="exclusions-card-modern-header">
          <div class="exclusions-card-modern-icon">✕</div>
          <div class="exclusions-card-modern-title-wrapper">
            <div class="exclusions-card-modern-label">Package</div>
            <div class="exclusions-card-modern-title">Exclusions</div>
          </div>
        </div>
        <div class="exclusions-card-modern-body">
          <ul class="exclusions-list-modern">
            ${exclusionsPoints.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </div>
      </div>
    </div>
  `
      : "";

  // Generate testimonials HTML
  const testimonialsHtml = `
    <div class="testimonials-section">
      <div class="testimonials-grid">
        <div class="testimonial-card">
          <div class="testimonial-quote">
            ${limitWords(
              "Mr. V.K.T. Balan was more than just a travel consultant; he was a cherished friend and pillar of support throughout my decades-long journey in cinema, right from my early days. His guidance and expertise enriched numerous travel programs and shoots. I extend my heartfelt wishes for continued success and prosperity to his entire team.",
            )}
          </div>
          <div class="testimonial-author">
            <img src="https://maduratravel.com/wp-content/uploads/2025/04/17zscZgz4wOlGDd3Gziw4YbI3G.jpg" alt="Kamal Haasan" class="testimonial-avatar">
            <div class="testimonial-info">
              <div class="testimonial-name">Mr. Kamal Haasan</div>
              <div class="testimonial-title">Cine Actor & Director</div>
            </div>
          </div>
        </div>
        <div class="testimonial-card">
          <div class="testimonial-quote">
            ${limitWords(
              "My long-standing association with Madura Travel Service has made my global travels seamless and stress-free. Their expertise in handling visas ensures timely approvals without any delays, making them my trusted travel partner. Truly exceptional service every time!",
            )}
          </div>
          <div class="testimonial-author">
            <img src="https://maduratravel.com/wp-content/uploads/2025/04/Venkatesh-Bhat.jpg" alt="Venkatesh Bhat" class="testimonial-avatar">
            <div class="testimonial-info">
              <div class="testimonial-name">Mr. Venkatesh Bhat</div>
              <div class="testimonial-title">TCDC Fame & CEO, Accord Hotels</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${bookingId} - ${destination}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-weight: 400;
      font-size: 12px;
      background: #191975 !important;
      color: #000000 !important;
      padding: 0;
      margin: 0;
      line-height: 1.5;
      min-height: 100vh;
      overflow: visible;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      color-adjust: exact;
    }

    .container {
      max-width: 380px;
      width: 100%;
      margin: 0;
      background: #191975;
      padding: 0;
      min-height: auto;
      overflow: visible;
    }
    
    /* Front Page */
    .front-page {
      position: relative;
      width: 100%;
      height: auto;
      min-height: 500px;
    }
    
    .front-page-bg {
      width: 100%;
      max-width: 100%;
      height: auto;
      min-height: 500px;
      display: block;
      object-fit: contain;
      object-position: top center;
      image-rendering: -webkit-optimize-contrast;
    }
    
    .front-page-overlay {
      position: absolute;
      top: calc(50% - 140px);
      left: 20px;
      transform: translateY(-50%);
      text-align: left;
      z-index: 10;
      color: #191975;
      padding-left: 20px;
    }
    
    .front-page-greeting {
      font-size: 13px;
      font-weight: 400;
      margin-bottom: 4px;
      color: #191975;
      opacity: 0.8;
    }
    
    .front-page-name {
      font-size: 22px;
      font-weight: 600;
      line-height: 1.2;
      color: #191975;
      font-family: Arial, sans-serif;
    }
    
    .front-page-dream-text {
      font-size: 12px;
      color: #191975;
      opacity: 0.9;
      margin-top: 6px;
      font-weight: 400;
    }
    
    /* White Box Container - Modern Design */
    .white-box {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
      color: #000000;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
    }

    .white-box::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
      border-radius: 12px 0 0 12px;
    }
    
    /* Container Background - Modern Design */
    .container-bg {
      background: linear-gradient(135deg, #e3ebf2 0%, #d4e0ed 100%);
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
      color: #000000;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
      border: 1px solid rgba(227, 235, 242, 0.8);
    }

    /* Header Section with Greeting */
    .header-section {
      position: relative;
      padding: 40px 20px 50px;
      background: linear-gradient(180deg, rgba(25, 25, 117, 0.85) 0%, rgba(25, 25, 117, 0.95) 100%);
      overflow: hidden;
      min-height: 250px;
    }

    .header-background {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 1;
      overflow: hidden;
    }
    
    .header-background img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .header-background-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(180deg, rgba(255, 107, 107, 0.3) 0%, rgba(255, 165, 0, 0.3) 50%, rgba(25, 25, 117, 0.7) 100%);
      z-index: 2;
    }
    
    .header-content {
      position: relative;
      z-index: 3;
    }

    .header-content {
      position: relative;
      z-index: 1;
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    .header-pins {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .pin-icon {
      width: 20px;
      height: 20px;
      background: #cc1715;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      position: relative;
    }

    .pin-icon::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(45deg);
      width: 8px;
      height: 8px;
      background: #fff;
      border-radius: 50%;
    }

    .pin-line {
      width: 30px;
      height: 2px;
      background: #e3ebf2;
      opacity: 0.5;
      border: 1px dashed #e3ebf2;
    }

    .header-logo {
      text-align: right;
    }

    .logo-box {
      display: inline-block;
    }

    .branch-logo-img {
      max-height: 60px;
      max-width: 160px;
      object-fit: contain;
      display: block;
    }

    .logo-text {
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      margin: 0;
      line-height: 1.3;
      text-align: center;
      white-space: nowrap;
    }

    .header-greeting {
      margin-top: 30px;
    }

    .greeting-text {
      font-size: 15px;
      font-weight: 300;
      color: rgba(255, 255, 255, 0.95);
      font-style: italic;
      margin-bottom: 8px;
    }

    .customer-name {
      font-size: 24px;
      font-weight: 400;
      color: #fff;
      margin-bottom: 8px;
    }

    .header-tagline {
      font-size: 16px;
      color: rgba(255, 255, 255, 0.85);
      margin-top: 8px;
    }

    /* Summary Section - Modern Design */
    .summary-section {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      padding: 20px;
      margin: 20px 15px;
      border: 1px solid rgba(227, 235, 242, 0.5);
      color: #191975;
      position: relative;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    }
    
    .summary-section::before {
      content: attr(data-tab-label);
      position: absolute;
      top: -12px;
      left: 20px;
      background: linear-gradient(135deg, #cc1715 0%, #e63946 100%);
      color: #fff;
      padding: 5px 16px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      box-shadow: 0 2px 6px rgba(204, 23, 21, 0.3);
    }

    .summary-section[data-tab-label=""]::before {
      display: none;
    }

    .summary-title {
      font-size: 14px;
      font-weight: 700;
      color: #cc1715;
      margin-bottom: 12px;
      margin-top: 5px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 15px;
    }

    .summary-item {
      display: flex;
      flex-direction: column;
    }

    .summary-label {
      font-size: 11px;
      color: #191975;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }

    .summary-value {
      font-size: 15px;
      font-weight: 600;
      color: #000000;
      word-break: break-word;
    }

    .summary-item:has(.summary-label:contains("Destination")) .summary-value,
    .summary-value.destination-title {
      font-size: 17px;
      font-weight: 700;
    }

    /* Awards Section - Single Line, 4 Columns */
    .awards-section {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin: 20px 0;
      padding: 15px 10px;
      background: rgba(227, 235, 242, 0.05);
      border-radius: 12px;
    }

    .award-item {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .award-logo {
      width: 100%;
      height: 120px;
      margin: 0 auto 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .award-logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .award-label {
      font-size: 8px;
      font-weight: 700;
      color: #e3ebf2;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(204, 23, 21, 0.2);
      padding: 4px 6px;
      border-radius: 4px;
      display: inline-block;
      margin-top: 4px;
      width: 100%;
      text-align: center;
      line-height: 1.2;
    }

    /* Day-wise Itinerary - Modern Creative Card Design */
    .itinerary-section {
      margin: 30px 0;
      padding: 0 20px;
    }

    .day-card-modern {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
      transition: transform 0.2s ease;
    }

    .day-card-modern::before {
      display: none;
    }

    .day-card-modern-header {
      background: linear-gradient(135deg, #191975 0%, #2a2a8a 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      position: relative;
    }

    .day-card-modern-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #cc1715 50%, transparent 100%);
    }

    .day-card-modern-number {
      background: linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%);
      color: #191975;
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      border: 2px solid #cc1715;
      position: relative;
    }

    .day-card-modern-number::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 12px;
      padding: 2px;
      background: linear-gradient(135deg, #cc1715, #191975);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
    }

    .day-card-modern-number {
      display: none !important;
    }

    .day-card-modern-header-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .day-card-modern-title {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.3;
      letter-spacing: -0.3px;
    }

    .day-card-modern-date {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.85);
      font-weight: 500;
      letter-spacing: 0.3px;
    }

    .day-card-modern-body {
      padding: 20px;
      background: #ffffff;
    }

    .day-card-modern-description {
      font-size: 12.5px;
      color: #000000;
      line-height: 1.7;
    }

    .day-card-modern-description p {
      margin-bottom: 10px;
      font-size: 12.5px;
      color: #000000;
    }

    .day-card-modern-description p:last-child {
      margin-bottom: 0;
    }

    .day-card-modern-description h4 {
      font-weight: 700;
      font-size: 13px;
      color: #191975;
      margin: 14px 0 8px 0;
      text-transform: none;
      letter-spacing: -0.2px;
    }

    .day-card-modern-description h4:first-child {
      margin-top: 0;
    }

    .day-card-modern-description ul {
      margin-left: 20px;
      margin-top: 8px;
      margin-bottom: 8px;
    }

    .day-card-modern-description li {
      margin-bottom: 6px;
      line-height: 1.6;
    }

    .day-card-modern-description strong {
      font-weight: 700;
      color: #191975;
    }

    /* Testimonials Section - Modern Creative Design */
    .testimonials-section {
      margin: 30px 0;
      padding: 0 20px;
      position: relative;
    }

    .testimonials-section::before {
      content: attr(data-tab-label);
      position: absolute;
      top: -12px;
      left: 40px;
      background: linear-gradient(135deg, #cc1715 0%, #e63946 100%);
      color: #fff;
      padding: 5px 16px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      box-shadow: 0 2px 6px rgba(204, 23, 21, 0.3);
      z-index: 10;
    }

    .testimonials-section[data-tab-label=""]::before,
    .testimonials-section:not([data-tab-label])::before {
      display: none;
    }

    .testimonials-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
    }

    .testimonial-card {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      padding: 20px;
      border: 2px solid #e3ebf2;
      position: relative;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
      overflow: hidden;
    }

    .testimonial-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
    }

    .testimonial-quote {
      font-size: 12px;
      line-height: 1.7;
      color: #000000;
      margin-bottom: 16px;
      position: relative;
      padding-left: 50px;
      padding-top: 20px;
      font-style: italic;
    }

    .testimonial-quote::before {
      content: '"';
      position: absolute;
      left: -25px;
      top: -10px;
      font-size: 80px;
      color: #cc1715;
      font-family: Georgia, serif;
      line-height: 1;
      opacity: 0.6;
      font-weight: 700;
      z-index: 1;
    }

    .testimonial-author {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 16px;
      border-top: 1px solid #e3ebf2;
    }

    .testimonial-avatar {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      object-fit: cover;
      border: 3px solid #cc1715;
      flex-shrink: 0;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      max-width: 80px;
      max-height: 80px;
      image-rendering: -webkit-optimize-contrast;
    }

    .testimonial-info {
      flex: 1;
    }

    .testimonial-name {
      font-size: 13px;
      font-weight: 700;
      color: #000000;
      margin-bottom: 4px;
    }

    .testimonial-title {
      font-size: 11px;
      color: #000000;
      opacity: 0.7;
      font-weight: 500;
    }

    /* Footer Section */
    .footer-section {
      margin: 40px 0 20px;
      padding: 25px 20px;
      background: rgba(227, 235, 242, 0.05);
      border-radius: 12px;
      border-top: 2px solid rgba(204, 23, 21, 0.3);
    }

    .footer-title {
      font-size: 14px;
      font-weight: 700;
      color: #cc1715;
      margin-bottom: 15px;
      text-align: center;
    }

    .footer-info {
      font-size: 11px;
      color: #e3ebf2;
      line-height: 1.8;
      margin-bottom: 12px;
    }

    .footer-info-item {
      margin-bottom: 10px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 11px;
    }

    .footer-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .footer-social {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid rgba(227, 235, 242, 0.1);
      text-align: center;
    }

    .footer-social-label {
      font-size: 12px;
      font-weight: 700;
      color: #cc1715;
      margin-bottom: 12px;
    }

    .footer-social-icons {
      display: flex;
      justify-content: center;
      gap: 20px;
    }

    .footer-social-icon {
      width: 24px;
      height: 24px;
      text-decoration: none;
      display: inline-block;
      transition: transform 0.2s;
      color: #e3ebf2;
    }

    .footer-social-icon svg {
      width: 100%;
      height: 100%;
    }

    .footer-social-icon:hover {
      transform: scale(1.2);
      color: #cc1715;
    }

    /* Costing Section */
    .costing-section {
      margin: 20px 15px;
    }

    .costing-subtitle {
      font-size: 14px;
      font-weight: 700;
      color: #cc1715;
      background: rgba(204, 23, 21, 0.15);
      padding: 8px 15px;
      border-radius: 6px;
      margin-bottom: 15px;
      display: inline-block;
    }

    .booking-item {
      background: rgba(227, 235, 242, 0.03);
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 10px;
    }

    .booking-location {
      font-size: 12px;
      font-weight: 600;
      color: #e3ebf2;
      margin-bottom: 4px;
    }

    .booking-details {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: #e3ebf2;
      opacity: 0.7;
    }

    .stars {
      color: #cc1715;
      font-size: 12px;
    }

    .payable-item {
      margin-bottom: 25px;
      background: rgba(227, 235, 242, 0.05);
      border-radius: 10px;
      padding: 15px;
      border: 1px solid rgba(227, 235, 242, 0.1);
    }

    .payable-title {
      font-size: 13px;
      font-weight: 700;
      color: #cc1715;
      margin-bottom: 12px;
      text-transform: uppercase;
    }

    .cost-breakdown {
      margin-top: 10px;
    }

    .cost-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #e3ebf2;
      margin-bottom: 8px;
      padding: 6px 0;
    }

    .cost-value {
      font-weight: 700;
      color: #cc1715;
    }

    .cost-total {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      background: #0f172a;
      padding: 12px 15px;
      border-radius: 6px;
      margin-top: 10px;
    }

    /* Trip Cost Summary */
    .trip-cost-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .trip-cost-item {
      background: rgba(227, 235, 242, 0.05);
      border: 1px solid rgba(227, 235, 242, 0.1);
      border-radius: 12px;
      padding: 20px;
    }

    .trip-cost-header {
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(227, 235, 242, 0.1);
    }

    .trip-cost-title {
      font-size: 12px;
      font-weight: 700;
      color: #cc1715;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .trip-cost-details {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .trip-cost-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #e3ebf2;
    }

    .trip-cost-value {
      font-weight: 700;
      color: #cc1715;
      font-size: 12px;
    }

    /* Inclusions/Exclusions - Modern Card Design */
    .inclusions-section-modern,
    .exclusions-section-modern {
      margin: 30px 0;
      padding: 0 20px;
    }

    .inclusions-card-modern,
    .exclusions-card-modern {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
    }

    .inclusions-card-modern::before,
    .exclusions-card-modern::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 5px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
    }

    .inclusions-card-modern-header,
    .exclusions-card-modern-header {
      background: linear-gradient(135deg, #191975 0%, #2a2a8a 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      position: relative;
    }

    .inclusions-card-modern-header::after,
    .exclusions-card-modern-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #cc1715 50%, transparent 100%);
    }

    .inclusions-card-modern-icon,
    .exclusions-card-modern-icon {
      font-size: 24px;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #ffffff;
      font-weight: 700;
    }

    .inclusions-card-modern-title-wrapper,
    .exclusions-card-modern-title-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .inclusions-card-modern-label,
    .exclusions-card-modern-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.75);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }

    .inclusions-card-modern-title,
    .exclusions-card-modern-title {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.3px;
    }

    .inclusions-card-modern-body,
    .exclusions-card-modern-body {
      padding: 20px;
      background: #ffffff;
    }

    .inclusions-list-modern,
    .exclusions-list-modern {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .inclusions-list-modern li,
    .exclusions-list-modern li {
      padding: 8px 0;
      padding-left: 24px;
      position: relative;
      font-size: 12.5px;
      color: #000000;
      line-height: 1.7;
      margin-bottom: 6px;
    }

    .inclusions-list-modern li::before {
      content: '✓';
      position: absolute;
      left: 0;
      color: #4ade80;
      font-weight: 700;
      font-size: 16px;
      line-height: 1.7;
    }

    .exclusions-list-modern li::before {
      content: '✕';
      position: absolute;
      left: 0;
      color: #cc1715;
      font-weight: 700;
      font-size: 16px;
      line-height: 1.7;
    }

    /* Terms & Conditions */
    .terms-section {
      margin: 30px 0;
      background: rgba(227, 235, 242, 0.05);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid rgba(227, 235, 242, 0.1);
    }

    .terms-content {
      font-size: 12.5px;
      color: #000000;
      line-height: 1.8;
    }
    
    .terms-content ul,
    .notes-content ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .terms-content li,
    .notes-content li {
      padding: 6px 0;
      padding-left: 24px;
      position: relative;
      font-size: 12.5px;
      color: #000000;
      line-height: 1.7;
      margin-bottom: 8px;
    }

    .terms-content li::before,
    .notes-content li::before {
      content: '●';
      position: absolute;
      left: 0;
      color: #cc1715;
      font-weight: 700;
      font-size: 14px;
      line-height: 1.7;
    }
    
    .terms-content p,
    .notes-content p {
      margin-bottom: 10px;
      font-size: 12.5px;
      color: #000000;
      line-height: 1.7;
    }
    
    .terms-content p:last-child,
    .notes-content p:last-child {
      margin-bottom: 0;
    }
    
    .terms-content strong,
    .notes-content strong {
      font-weight: 700;
      color: #191975;
    }
    
    /* Notes Section - Modern Design */
    .notes-content {
      font-size: 12.5px;
      color: #000000;
      line-height: 1.8;
    }

    /* Section Titles */
    .section-title {
      font-size: 17px;
      font-weight: 700;
      color: #cc1715;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
    }

    .section-title::before {
      content: '';
      width: 4px;
      height: 16px;
      background: #cc1715;
      border-radius: 2px;
    }
    
    /* Remove red dot for Notes, Terms & Conditions, Cancellation Policy, and Banking Details sections */
    .section-title[style*="padding-left: 0"]::before {
      display: none;
    }
    
    /* Costing Section - Modern Creative Card Design */
    .costing-section-modern {
      margin: 30px 0;
      padding: 0 20px;
    }

    .costing-card-modern {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
    }

    .costing-card-modern::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 5px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
    }

    .costing-card-modern-header {
      background: linear-gradient(135deg, #191975 0%, #2a2a8a 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      position: relative;
    }

    .costing-card-modern-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #cc1715 50%, transparent 100%);
    }

    .costing-card-modern-icon {
      font-size: 24px;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .costing-card-modern-title-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .costing-card-modern-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.75);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }

    .costing-card-modern-title {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.3px;
    }

    .costing-card-modern-body {
      padding: 20px;
      background: #ffffff;
    }

    .cost-table-modern {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .cost-row-modern {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(227, 235, 242, 0.6);
      transition: background-color 0.2s ease;
    }

    .cost-row-modern:last-child {
      border-bottom: none;
    }

    .cost-row-modern:hover {
      background-color: rgba(227, 235, 242, 0.1);
      margin: 0 -8px;
      padding-left: 8px;
      padding-right: 8px;
      border-radius: 6px;
    }

    .cost-row-subtotal {
      border-top: 2px solid rgba(227, 235, 242, 0.8);
      border-bottom: 1px solid rgba(227, 235, 242, 0.6);
      margin-top: 4px;
      padding-top: 14px;
      font-weight: 600;
    }

    .cost-row-total {
      border-top: 3px solid #cc1715;
      border-bottom: none;
      background: linear-gradient(135deg, #fff5f5 0%, #ffe5e5 100%);
      margin-top: 8px;
      padding: 16px 12px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(204, 23, 21, 0.1);
    }

    .cost-label-modern {
      font-size: 12.5px;
      color: #000000;
      font-weight: 500;
      letter-spacing: -0.1px;
    }

    .cost-row-subtotal .cost-label-modern {
      font-weight: 600;
      font-size: 13px;
    }

    .cost-row-total .cost-label-modern {
      font-weight: 700;
      font-size: 14px;
      color: #191975;
    }

    .cost-value-modern {
      font-size: 12.5px;
      font-weight: 600;
      color: #cc1715;
      text-align: right;
      letter-spacing: -0.2px;
    }

    .cost-row-subtotal .cost-value-modern {
      font-weight: 700;
      font-size: 13px;
    }

    .cost-row-discount {
      background: linear-gradient(135deg, #fff9e6 0%, #fff5d6 100%);
      border: 1px solid #ffd700;
      border-radius: 6px;
      margin-top: 6px;
      padding: 12px;
    }

    .discount-badge {
      display: inline-block;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
      color: #ffffff;
      font-weight: 700;
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.5px;
      margin-right: 6px;
      text-transform: uppercase;
    }

    .discount-value {
      color: #cc1715 !important;
      font-weight: 700 !important;
    }

    .cost-row-total .cost-value-modern {
      font-weight: 800;
      font-size: 18px;
      color: #cc1715;
    }
    
    /* Payment Button */
    .payment-button-container {
      margin-top: 20px;
      width: 100%;
    }
    
    .payment-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
      background: #ffffff;
      color: #191975;
      padding: 16px 24px;
      border-radius: 7px;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      transition: all 0.2s ease;
      border: 2px solid #e3ebf2;
    }
    
    .payment-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      border-color: #191975;
      background: #f8f9fa;
    }
    
    .payment-button-icon {
      font-size: 20px;
    }
    
    .payment-button-text {
      letter-spacing: 0.3px;
    }
    
    .payment-note {
      margin-top: 12px;
      font-size: 11px;
      color: #6b7280;
      font-style: italic;
      line-height: 1.5;
    }
    
    /* Flights Section - Modern Card Design */
    .flights-section {
      margin: 30px 0;
      padding: 0 20px;
    }

    .flights-card {
      background: #ffffff;
      border-radius: 7px;
      margin-bottom: 20px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
      border: 2px solid #e3ebf2;
    }

    .flights-card-header {
      background: #191975;
      padding: 12px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .flights-card-left {
      display: flex;
      flex-direction: column;
    }

    .flights-card-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.7);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }

    .flights-card-title {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
    }

    .flights-card-body {
      padding: 15px;
      color: #000000;
    }

    .flight-item {
      padding: 12px 0;
      border-bottom: 1px solid #e3ebf2;
    }

    .flight-item:last-child {
      border-bottom: none;
    }

    .flight-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .flight-route {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 700;
      color: #000000;
    }

    .flight-route-from,
    .flight-route-to {
      font-weight: 700;
      color: #000000;
    }

    .flight-arrow {
      color: #cc1715;
      font-size: 16px;
      font-weight: 700;
    }

    .flight-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .flight-badge.onward {
      background: #cc1715;
      color: #ffffff;
    }

    .flight-badge.return {
      background: #28a745;
      color: #ffffff;
    }

    .flight-badge.intercity {
      background: #6f42c1;
      color: #ffffff;
    }

    .flight-details {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .flight-detail-row {
      display: flex;
      font-size: 11px;
      color: #000000;
    }

    .flight-detail-label {
      font-weight: 600;
      margin-right: 8px;
      min-width: 70px;
      color: #000000;
    }

    .flight-detail-value {
      color: #000000;
      flex: 1;
    }

    .flight-price-row {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #e3ebf2;
    }

    .flight-price {
      font-weight: 700;
      color: #cc1715;
      font-size: 12px;
    }

    /* Hotels Section - Modern Creative Design */
    .hotels-section {
      margin: 30px 0;
      padding: 0 20px;
    }

    .hotels-card-modern {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
    }

    .hotels-card-modern::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 5px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
    }

    .hotels-card-modern-header {
      background: linear-gradient(135deg, #191975 0%, #2a2a8a 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      position: relative;
    }

    .hotels-card-modern-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #cc1715 50%, transparent 100%);
    }

    .hotels-card-modern-icon {
      font-size: 24px;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .hotels-card-modern-title-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .hotels-card-modern-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.75);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }

    .hotels-card-modern-title {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.3px;
    }

    .hotels-card-modern-body {
      padding: 20px;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .hotel-item-modern {
      padding: 16px;
      background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%);
      border-radius: 10px;
      border: 1px solid rgba(227, 235, 242, 0.6);
    }

    .hotel-item-header {
      margin-bottom: 12px;
    }

    .hotel-name-modern {
      font-size: 15px;
      font-weight: 700;
      color: #191975;
      margin-bottom: 4px;
    }

    .hotel-location-modern {
      font-size: 12px;
      color: #6b7280;
      font-weight: 500;
    }

    .hotel-details-modern {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .hotel-detail-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
    }

    .hotel-detail-label {
      font-weight: 600;
      color: #000000;
    }

    .hotel-detail-value {
      color: #000000;
      font-weight: 500;
    }

    /* Visa Section - Modern Creative Design */
    .visa-section-modern {
      margin: 30px 0;
      padding: 0 20px;
    }

    .visa-card-modern {
      background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(227, 235, 242, 0.5);
      position: relative;
    }

    .visa-card-modern::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 5px;
      height: 100%;
      background: linear-gradient(180deg, #cc1715 0%, #191975 100%);
    }

    .visa-card-modern-header {
      background: linear-gradient(135deg, #191975 0%, #2a2a8a 100%);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      position: relative;
    }

    .visa-card-modern-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #cc1715 50%, transparent 100%);
    }

    .visa-card-modern-icon {
      font-size: 24px;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      flex-shrink: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .visa-card-modern-title-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .visa-card-modern-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.75);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 600;
    }

    .visa-card-modern-title {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.3px;
    }

    .visa-card-modern-badge {
      background: rgba(255, 255, 255, 0.2);
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }

    .visa-card-modern-body {
      padding: 20px;
      background: #ffffff;
    }

    .visa-content-modern {
      font-size: 12.5px;
      color: #000000;
      line-height: 1.7;
    }

    .visa-info-row-modern {
      margin-bottom: 12px;
      font-size: 12.5px;
      color: #000000;
      line-height: 1.6;
    }

    .visa-info-row-modern:last-child {
      margin-bottom: 0;
    }

    .visa-info-row-modern strong {
      font-weight: 700;
      color: #191975;
      margin-right: 6px;
    }

    /* Old Visa Section - Keep for backward compatibility */
    .visa-section {
      margin: 30px 0;
      padding: 0 20px;
    }

    .visa-card {
      background: #ffffff;
      border-radius: 7px;
      margin-bottom: 20px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    }

    .visa-card-header {
      background: #191975;
      padding: 12px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .visa-card-left {
      display: flex;
      flex-direction: column;
    }

    .visa-card-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.7);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }

    .visa-card-title {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
    }

    .visa-card-right {
      display: flex;
      align-items: center;
    }

    .visa-card-badge {
      background: #ffffff;
      color: #191975;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      border: 2px solid #cc1715;
    }

    .visa-card-body {
      padding: 15px;
      color: #000000;
    }

    .visa-content-text {
      font-size: 11px;
      color: #000000;
      line-height: 1.6;
    }

    .visa-info-row {
      margin-bottom: 8px;
      font-size: 11px;
      color: #000000;
    }

    .visa-info-row strong {
      font-weight: 700;
      color: #000000;
    }
    
    /* Final Page - match container width so it is not side-cropped (same as front page) */
    .final-page {
      width: 100%;
      max-width: 100%;
      height: auto;
      min-height: 500px;
      display: block;
      margin: 20px 0;
      object-fit: contain;
      object-position: top center;
      image-rendering: -webkit-optimize-contrast;
    }

    /* Print styles - ensure single continuous page */
    @media print {
      @page {
        size: 380px auto;
        margin: 0;
      }
      body {
        background: #191975;
        margin: 0;
        padding: 0;
      }
      .container {
        max-width: 100%;
        padding: 0;
        page-break-inside: avoid;
      }
      .day-block,
      .testimonial-card,
      .costing-section,
      .inclusions-section,
      .exclusions-section,
      .terms-section,
      .summary-section,
      .awards-section,
      .header-section {
        page-break-inside: avoid;
        break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Front Page -->
    <div class="front-page">
      <img src="${frontPageImageUrl}" alt="Front Page" class="front-page-bg" />
      <div class="front-page-overlay">
        <div class="front-page-greeting">Vanakkam!</div>
        <div class="front-page-name">${
          customerName
            ? (customerName.includes("Mr.") ||
              customerName.includes("Mrs.") ||
              customerName.includes("Ms.")
                ? customerName
                : `Mr. ${customerName}`
              )
                .replace(/\n/g, " ")
                .trim()
            : ""
        }</div>
        <div class="front-page-dream-text">Let's Plan your dream holiday...</div>
      </div>
    </div>

    <!-- Summary Section -->
    <div class="summary-section" data-tab-label="TRIP SUMMARY">
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">Booking ID</div>
          <div class="summary-value">${bookingId}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Phone</div>
          <div class="summary-value">${
            formatPhoneNumber(customerPhone) || "N/A"
          }</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Destination</div>
          <div class="summary-value destination-title">${destination}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">No. of Nights</div>
          <div class="summary-value">${nights}N / ${days}D</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Start Date</div>
          <div class="summary-value">${formatDate(startDate)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">End Date</div>
          <div class="summary-value">${formatDate(endDate)}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Total Adults</div>
          <div class="summary-value">${adults}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Total Kids</div>
          <div class="summary-value">${children}</div>
        </div>
        ${
          childrenAges && childrenAges.length > 0
            ? `
        <div class="summary-item">
          <div class="summary-label">Kid's Age</div>
          <div class="summary-value">${childrenAges.join(", ")}</div>
        </div>
        `
            : ""
        }
      </div>
    </div>

    <!-- Travel Consultant Section -->
    <div class="summary-section" style="background: #ffffff; margin-top: 25px;" data-tab-label="TRAVEL CONSULTANT">
      <div class="summary-grid">
        <div class="summary-item">
          <div class="summary-label">Consultant Name</div>
          <div class="summary-value">${travelConsultant?.name || "N/A"}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Phone</div>
          <div class="summary-value">
            <a href="tel:+919092949494" style="color: #191975; text-decoration: none; font-weight: 600;">+91 90929 49494${
              travelConsultant?.extension_no
                ? ` (Ext. No. ${travelConsultant.extension_no})`
                : ""
            }</a>
          </div>
        </div>
        <div class="summary-item" style="grid-column: span 2;">
          <div class="summary-label">Email</div>
          <div class="summary-value">
            <a href="mailto:mail@maduratravel.com" style="color: #191975; text-decoration: none; font-weight: 600;">mail@maduratravel.com</a>
          </div>
        </div>
      </div>
      ${
        travelConsultant?.extension_no
          ? `
      <div style="margin-top: 15px; padding: 12px; background: #f8f9fa; border-left: 3px solid #191975; border-radius: 4px;">
        <p style="margin: 0; color: #333; font-size: 13px; line-height: 1.5;">
          <strong>Note:</strong> To directly contact the consultant, dial the number and press 0, then enter the extension number.
        </p>
      </div>
      `
          : ""
      }
    </div>

    <!-- Emergency Contact Section - Only visible when status is Confirmed -->
    ${
      data.itineraryStatus === "Confirmed" &&
      data.emergencyContacts &&
      data.emergencyContacts.length > 0
        ? `
    <div class="summary-section" style="background: #ffffff; margin-top: 25px;" data-tab-label="EMERGENCY CONTACT">
      <div class="summary-grid">
        ${data.emergencyContacts
          .map(
            (contact, index) => `
        <div class="summary-item" style="grid-column: span 1;">
          <div class="summary-label">${
            contact.card_title || (index === 0 ? "Emergency Contact" : "")
          }</div>
          <div class="summary-value" style="font-weight: 600;">
            ${contact.name || "N/A"}
          </div>
        </div>
        <div class="summary-item" style="grid-column: span 1;">
          <div class="summary-label">${
            index === 0 ? "Contact Number" : ""
          }</div>
          <div class="summary-value">
            <a href="tel:${
              contact.contact_number || ""
            }" style="color: #191975; text-decoration: none; font-weight: 600;">${
              contact.contact_number || "N/A"
            }</a>
          </div>
        </div>
        `,
          )
          .join("")}
      </div>
    </div>
    `
        : ""
    }
    
    <!-- Napoleon Testimonial (First) -->
    <div class="testimonials-section" data-tab-label="VIP TESTIMONIAL">
      <div class="testimonials-grid">
        <div class="testimonial-card">
          <div class="testimonial-quote">
            Mr. Sriharan Balan and his exceptional team provided seamless service, taking on the monumental task of organizing my son's wedding in Tokyo, Japan, in November 2024, with absolute ease. Every guest was treated like a VIP from start to finish, ensuring a memorable and stress-free experience for all involved.
          </div>
          <div class="testimonial-author">
            <img src="https://maduratravel.com/wp-content/uploads/2025/04/nepoleon010719-1-jpg.jpg" alt="Mr. Napoleon" class="testimonial-avatar">
            <div class="testimonial-info">
              <div class="testimonial-name">Mr. Napoleon</div>
              <div class="testimonial-title">Cine Actor & Politician</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Day-wise Itinerary -->
    <div class="itinerary-section" style="padding-top: 30px;">
      <div style="padding: 0 0 20px 0; margin: 0;">
        <h2 style="font-size: 17px; font-weight: 700; color: #ffffff; margin: 0; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
          <span style="color: #cc1715; font-size: 20px; font-weight: 800;">|</span>
          <span>Day-wise Itinerary</span>
        </h2>
      </div>
      ${dayWiseHtml}
    </div>

    <!-- Trip Cost Summary -->
    ${tripCostSummaryHtml}

    <!-- Flight Details card: show whenever this version has flights (so it appears in PDF even if "Flights" cost is unchecked) -->
    ${flightsData && flightsData.length > 0 ? addonsHtml : ""}

    <!-- Banking Details - same as invoice (standardized) -->
    ${(() => {
      const standardBank = {
        bank_name: "ICICI Bank",
        account_type: "Current Account",
        account_holder_name: "MADURA TRAVEL SERVICE PVT LTD",
        branch_name: "EGMORE",
        account_number: "603605017091",
        ifsc_code: "ICIC0006036",
        swift_code: "ICICNBBCTS",
        gstin: "33AACCM4908J1ZJ (TAMIL NADU)",
        cheque_instructions:
          "All Cheques / Drafts in payment of bills must be crossed 'A/c Payee Only' and drawn in favour of 'MADURA TRAVEL SERVICE (P) LTD.'.",
      };

      return `
    <div class="summary-section" data-tab-label="BANKING DETAILS" style="margin-top: 25px;">
      <div class="white-box">
        <div class="summary-grid">
          <div class="summary-item">
            <div class="summary-label">Bank</div>
            <div class="summary-value">${standardBank.bank_name}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Account type</div>
            <div class="summary-value">${standardBank.account_type}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Account holder Name</div>
            <div class="summary-value">${standardBank.account_holder_name}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Branch</div>
            <div class="summary-value">${standardBank.branch_name}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Account no</div>
            <div class="summary-value">${standardBank.account_number}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">IFSC Code</div>
            <div class="summary-value">${standardBank.ifsc_code}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">SWIFT Code</div>
            <div class="summary-value">${standardBank.swift_code}</div>
          </div>
          <div class="summary-item" style="grid-column: 1 / -1;">
            <div class="summary-label">GSTIN</div>
            <div class="summary-value">${standardBank.gstin}</div>
          </div>
          <div class="summary-item" style="grid-column: 1 / -1; margin-top: 10px;">
            <div class="summary-label" style="font-weight: 600; color: #191975;">CHEQUE</div>
            <div class="summary-value" style="font-size: 11.5px; line-height: 1.6;">${standardBank.cheque_instructions}</div>
          </div>
        </div>
      </div>
    </div>
    `;
    })()}

    <!-- Hotels Section - Only show if enabled -->
    ${categoryEnabled.hotels !== false ? hotelsHtml : ""}

    <!-- Attractions & Activities Section - Only show if enabled -->
    ${categoryEnabled.sightseeing !== false ? attractionsHtml : ""}

    <!-- Visa Section (only if visa exists and enabled) -->
    ${categoryEnabled.visa !== false ? visaHtml : ""}

    <!-- Inclusions Section -->
    ${inclusionsHtml}

    <!-- Exclusions Section -->
    ${exclusionsHtml}

    <!-- Notes Section -->
    ${
      notes
        ? `
    <div class="summary-section" data-tab-label="NOTES" style="margin-top: 25px;">
      <div class="white-box">
        <div class="notes-content">
          ${formatTextWithBullets(replaceDateTags(notes))}
        </div>
      </div>
    </div>
    `
        : ""
    }

    <!-- Terms & Conditions Section -->
    ${
      termsAndConditions
        ? `
    <div class="summary-section" data-tab-label="TERMS & CONDITIONS" style="margin-top: 25px;">
      <div class="white-box">
        <div class="terms-content">
          ${formatTextWithBullets(replaceDateTags(termsAndConditions))}
        </div>
      </div>
    </div>
    `
        : ""
    }
    
    <!-- Gautham Menon Testimonial (Last) -->
    <div class="testimonials-section" style="margin-top: 30px;">
      <div class="testimonials-grid">
        <div class="testimonial-card">
          <div class="testimonial-quote">
            The entire USA shoot of the blockbuster movie Vettaiyadu Villayadu was flawlessly coordinated by the professional team at Madura Travel Service. Their meticulous planning and seamless handling of all travel formalities elevated the production experience to a whole new level, allowing us to focus on the creative process without any worries. Truly commendable service!
          </div>
          <div class="testimonial-author">
            <img src="https://maduratravel.com/wp-content/uploads/2025/04/gautham-menon-releases-a-statement-after-the-recent-controversy-with-karthick-naren-photos-pictures-stills.jpg" alt="Mr. Gautham Menon" class="testimonial-avatar">
            <div class="testimonial-info">
              <div class="testimonial-name">Mr. Gautham Menon</div>
              <div class="testimonial-title">Cine Director</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Cancellation Policy Section -->
    ${
      cancellationPolicy
        ? `
    <div class="summary-section" style="margin-top: 25px;">
      <h2 class="section-title" style="padding-left: 0;">Cancellation Policy</h2>
      <div class="white-box">
        <div class="terms-content" style="color: #000; font-size: 12.5px; line-height: 1.8;">
          ${formatTextWithBullets(replaceDateTags(cancellationPolicy))}
        </div>
      </div>
    </div>
    `
        : ""
    }

    <!-- Testimonials Again -->
    ${testimonialsHtml}

    <!-- Final Page -->
    <img src="${finalPageImageUrl}" alt="Final Page" class="final-page" />
  </div>
</body>
</html>
  `;
}

// Main PDF generation function
export async function generateItineraryPdf(req, res) {
  try {
    const { itineraryId, leadId, versionNumber, adults: bodyAdults, children: bodyChildren, infants: bodyInfants } = req.body;

    if (!itineraryId) {
      return res.status(400).json({ message: "itineraryId is required" });
    }

    // Fetch itinerary metadata with all related data
    const { data: itineraryMeta, error: metaError } = await supabase
      .from("itineraries")
      .select(
        `
        *,
        lead:leads(
          *,
          customer:customers(*),
          assigned_to:lead_assignees(staff(*))
        ),
        itinerary_versions(*)
      `,
      )
      .eq("id", itineraryId)
      .single();

    if (metaError || !itineraryMeta) {
      throw new Error(metaError?.message || "Itinerary not found");
    }

    const lead = itineraryMeta.lead;
    const customer = lead?.customer;

    // Get consultant name - prefer current logged-in staff (who is downloading), fallback to primary assignee
    let travelConsultant = null;

    // Check if we have the current user from authentication (when called from frontend)
    // Skip if it's a System user (internal calls) - use primary assignee instead
    const currentUser = req.user;
    if (
      currentUser &&
      currentUser.id &&
      currentUser.id !== 0 &&
      currentUser.name &&
      currentUser.name !== "System"
    ) {
      // Use the staff member who is downloading/generating the PDF
      // The req.user already has staff info from requireAuth middleware
      travelConsultant = {
        name: currentUser.name || "N/A",
        phone: currentUser.phone || "N/A",
        email: currentUser.email || "N/A",
        extension_no: currentUser.extension_no || null,
      };
      pdfLog(
        `[PDF Generator] Using current logged-in staff (${travelConsultant.name}) as consultant`,
      );
    }

    // Fallback to primary assigned staff if no current user or it's an internal call
    if (!travelConsultant) {
      if (
        lead?.assigned_to &&
        Array.isArray(lead.assigned_to) &&
        lead.assigned_to.length > 0
      ) {
        const primaryAssignee = lead.assigned_to[0];
        if (primaryAssignee?.staff) {
          travelConsultant = {
            name: primaryAssignee.staff.name || "N/A",
            phone: primaryAssignee.staff.phone || "N/A",
            email: primaryAssignee.staff.email || "N/A",
            extension_no: primaryAssignee.staff.extension_no || null,
          };
          pdfLog(
            `[PDF Generator] Using primary assignee (${travelConsultant.name}) as consultant (fallback)`,
          );
        }
      }
    }

    // Handle itinerary_versions - get the specified version or latest version
    let itinerary = null;
    if (
      Array.isArray(itineraryMeta.itinerary_versions) &&
      itineraryMeta.itinerary_versions.length > 0
    ) {
      // If versionNumber is specified, use that version; otherwise use latest
      if (versionNumber !== undefined && versionNumber !== null) {
        // Convert both to numbers for comparison (handle string/number mismatch)
        const targetVersion = Number(versionNumber);
        itinerary = itineraryMeta.itinerary_versions.find(
          (v) => Number(v.version_number) === targetVersion,
        );
        if (!itinerary) {
          console.warn(
            `[PDF Generator] Version ${versionNumber} (as ${targetVersion}) not found. Available versions: ${itineraryMeta.itinerary_versions.map((v) => v.version_number).join(", ")}. Using latest version.`,
          );
        } else {
          pdfLog(
            `[PDF Generator] ✅ Selected version ${versionNumber} (${itinerary.version_number}). Flights count: ${Array.isArray(itinerary.detailed_flights) ? itinerary.detailed_flights.length : "N/A"}`,
          );
        }
      }
      // If version not found or not specified, use latest version
      if (!itinerary) {
        itinerary = itineraryMeta.itinerary_versions.sort(
          (a, b) => (b.version_number || 0) - (a.version_number || 0),
        )[0];
        pdfLog(
          `[PDF Generator] Using latest version ${itinerary.version_number}. Flights count: ${Array.isArray(itinerary.detailed_flights) ? itinerary.detailed_flights.length : "N/A"}`,
        );
      }
    } else if (
      itineraryMeta.itinerary_versions &&
      typeof itineraryMeta.itinerary_versions === "object"
    ) {
      itinerary = itineraryMeta.itinerary_versions;
    } else {
      // Fallback: fetch versions separately if not included
      let query = supabase
        .from("itinerary_versions")
        .select("*")
        .eq("itinerary_id", itineraryId);

      if (versionNumber !== undefined && versionNumber !== null) {
        // Convert to number for comparison
        query = query.eq("version_number", Number(versionNumber));
      } else {
        query = query.order("version_number", { ascending: false }).limit(1);
      }

      const { data: versions } = await query;

      if (versions && versions.length > 0) {
        itinerary = versions[0];
        pdfLog(
          `[PDF Generator] Fetched version ${itinerary.version_number} separately. Flights count: ${Array.isArray(itinerary.detailed_flights) ? itinerary.detailed_flights.length : "N/A"}`,
        );
      }
    }

    if (!customer) {
      throw new Error("Customer not found for this itinerary");
    }

    // Get display currency from metadata (default to INR)
    // Check both display_currency (snake_case from DB) and displayCurrency (camelCase)
    const displayCurrency =
      itineraryMeta.display_currency || itineraryMeta.displayCurrency || "INR";
    pdfLog(
      "[PDF Generator] Display currency from metadata:",
      displayCurrency,
      "itineraryMeta keys:",
      Object.keys(itineraryMeta).filter(
        (k) => k.includes("currency") || k.includes("Currency"),
      ),
    );

    // Get branch for terms & conditions and PDF images
    const { data: branch } = await supabase
      .from("branches")
      .select("*, terms_and_conditions(*), bank_details(*)")
      .eq("id", itineraryMeta.branch_id)
      .single();

    // Fetch Razorpay payment link from invoice for this lead (if exists)
    let razorpayLinkFromInvoice = null;
    if (lead?.id) {
      const { data: invoice } = await supabase
        .from("invoices")
        .select("razorpay_payment_link_url")
        .eq("lead_id", lead.id)
        .not("razorpay_payment_link_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (invoice?.razorpay_payment_link_url) {
        razorpayLinkFromInvoice = invoice.razorpay_payment_link_url;
        pdfLog(
          "[PDF Generator] Found Razorpay link from invoice:",
          razorpayLinkFromInvoice,
        );
      }
    }

    // Calculate dates and duration from day_wise_plan or metadata
    let startDate = null;
    let endDate = null;
    const dayWisePlan = itinerary?.day_wise_plan || [];

    // Helper function to parse dates without timezone issues
    const parseDateSafe = (dateStr) => {
      if (!dateStr) return null;
      // Handle Date objects
      if (dateStr instanceof Date) {
        return dateStr;
      }
      // Handle date strings in YYYY-MM-DD format to avoid timezone issues
      if (typeof dateStr === "string") {
        // Try YYYY-MM-DD format first
        const ymdMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (ymdMatch) {
          const [, year, month, day] = ymdMatch;
          return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        }
        // Try MM/DD/YYYY format (e.g., "1/10/2026")
        const mdyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mdyMatch) {
          const [, month, day, year] = mdyMatch;
          return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        }
        // Try ISO string with time
        if (dateStr.includes("T")) {
          const datePart = dateStr.split("T")[0];
          const ymdMatch2 = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (ymdMatch2) {
            const [, year, month, day] = ymdMatch2;
            return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
          }
        }
        // Fallback to standard Date parsing
        return new Date(dateStr);
      }
      return null;
    };

    // PRIORITY: Use travel_date from itineraryMeta as the source of truth for startDate
    // This ensures the PDF matches the "Date of Travel" shown in the CRM
    const travelDate = itineraryMeta.travel_date || lead?.travel_date;
    if (travelDate) {
      pdfLog(
        "[PDF Generator] Using travel_date as startDate (source of truth):",
        travelDate,
      );
      startDate = parseDateSafe(travelDate);
      if (!startDate || isNaN(startDate.getTime())) {
        pdfLog("[PDF Generator] Failed to parse travel_date:", travelDate);
        startDate = null;
      } else {
        pdfLog(
          "[PDF Generator] Parsed startDate from travel_date:",
          startDate.toISOString(),
          "Local date:",
          startDate.getDate(),
          "Local month:",
          startDate.getMonth() + 1,
          "Local year:",
          startDate.getFullYear(),
        );
      }
    }

    // Fallback to day_wise_plan[0].date only if travel_date is not available
    if (!startDate && dayWisePlan.length > 0) {
      const firstDay = dayWisePlan[0];
      pdfLog("[PDF Generator] Fallback: Using firstDay.date:", firstDay.date);
      if (firstDay.date) {
        startDate = parseDateSafe(firstDay.date);
        if (!startDate || isNaN(startDate.getTime())) {
          pdfLog(
            "[PDF Generator] Failed to parse firstDay.date:",
            firstDay.date,
          );
          startDate = null;
        } else {
          pdfLog(
            "[PDF Generator] Parsed startDate from firstDay:",
            startDate.toISOString(),
            "Local date:",
            startDate.getDate(),
            "Local month:",
            startDate.getMonth() + 1,
            "Local year:",
            startDate.getFullYear(),
          );
        }
      }
    }

    // For endDate, calculate from startDate + nights (more reliable than day_wise_plan)
    // Only use lastDay.date if we don't have startDate or nights
    if (startDate) {
      const durationStr = itineraryMeta.duration || "";
      const nightsMatch = durationStr.match(/(\d+)\s*[Nn]/);
      const nights = nightsMatch
        ? parseInt(nightsMatch[1])
        : dayWisePlan.length > 0
          ? dayWisePlan.length - 1
          : 0;

      if (nights > 0) {
        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + nights);
        pdfLog(
          "[PDF Generator] Calculated endDate from startDate + nights:",
          endDate.toISOString(),
          "Local date:",
          endDate.getDate(),
          "Local month:",
          endDate.getMonth() + 1,
          "Local year:",
          endDate.getFullYear(),
        );
      }
    }

    // Fallback to lastDay.date only if we couldn't calculate endDate
    if (!endDate && dayWisePlan.length > 0) {
      const lastDay = dayWisePlan[dayWisePlan.length - 1];
      pdfLog("[PDF Generator] Fallback: Using lastDay.date:", lastDay.date);
      if (lastDay.date) {
        endDate = parseDateSafe(lastDay.date);
        if (!endDate || isNaN(endDate.getTime())) {
          pdfLog("[PDF Generator] Failed to parse lastDay.date:", lastDay.date);
          endDate = null;
        } else {
          pdfLog(
            "[PDF Generator] Parsed endDate from lastDay:",
            endDate.toISOString(),
            "Local date:",
            endDate.getDate(),
            "Local month:",
            endDate.getMonth() + 1,
            "Local year:",
            endDate.getFullYear(),
          );
        }
      }
    }

    // Calculate duration (nights and days) - already calculated above for endDate, but need for template
    const durationStr = itineraryMeta.duration || "";
    const nightsMatch = durationStr.match(/(\d+)\s*[Nn]/);
    const daysMatch = durationStr.match(/(\d+)\s*[Dd]/);
    const nights = nightsMatch
      ? parseInt(nightsMatch[1])
      : dayWisePlan.length > 0
        ? dayWisePlan.length - 1
        : 0;
    const days = daysMatch
      ? parseInt(daysMatch[1])
      : nights > 0
        ? nights + 1
        : dayWisePlan.length;

    // Calculate end date if not set
    if (startDate && !endDate) {
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + nights);
      pdfLog(
        "[PDF Generator] Calculated endDate from startDate + nights:",
        endDate.toISOString(),
        "Local date:",
        endDate.getDate(),
        "Local month:",
        endDate.getMonth() + 1,
        "Local year:",
        endDate.getFullYear(),
      );
    }

    // Final date values before passing to template
    pdfLog(
      "[PDF Generator] Final startDate:",
      startDate
        ? `${startDate.getFullYear()}-${String(
            startDate.getMonth() + 1,
          ).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`
        : "null",
    );
    pdfLog(
      "[PDF Generator] Final endDate:",
      endDate
        ? `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(
            2,
            "0",
          )}-${String(endDate.getDate()).padStart(2, "0")}`
        : "null",
    );

    // Get children ages from lead requirements or itinerary
    const childrenAges = [];
    // First check direct child_ages from requirements (newer format)
    if (
      lead?.requirements?.child_ages &&
      Array.isArray(lead.requirements.child_ages)
    ) {
      childrenAges.push(...lead.requirements.child_ages);
    }
    // Also check rooms for backward compatibility
    if (lead?.requirements?.rooms) {
      lead.requirements.rooms.forEach((room) => {
        if (room.children_ages && Array.isArray(room.children_ages)) {
          // Avoid duplicates
          room.children_ages.forEach((age) => {
            if (!childrenAges.includes(age)) {
              childrenAges.push(age);
            }
          });
        }
      });
    }

    // Generate booking ID
    const generateBookingId = (lead) => {
      if (!lead || !lead.id || !lead.created_at) return "N/A";
      const createdAt = new Date(lead.created_at);
      const day = String(createdAt.getDate()).padStart(2, "0");
      const month = String(createdAt.getMonth() + 1).padStart(2, "0");
      const year = String(createdAt.getFullYear()).slice(-2);
      return `MTS-${lead.id}${day}${month}${year}`;
    };

    const bookingId = generateBookingId(lead);

    // Resolve pax counts once: request body (from CRM) overrides DB so PDF matches Trip Cost Summary
    const adultsForPdf =
      bodyAdults !== undefined && bodyAdults !== null
        ? Number(bodyAdults)
        : itineraryMeta.adults ?? lead?.requirements?.adults ?? 1;
    const childrenForPdf =
      bodyChildren !== undefined && bodyChildren !== null
        ? Number(bodyChildren)
        : itineraryMeta.children ?? lead?.requirements?.children ?? 0;
    const infantsForPdf =
      bodyInfants !== undefined && bodyInfants !== null
        ? Number(bodyInfants)
        : itineraryMeta.infants ?? lead?.requirements?.babies ?? 0;

    // Format costing data
    // costing_options is stored in itinerary_versions table (latest version)
    // Priority: itinerary (latest version) > itineraryMeta (fallback)
    // Handle JSONB parsing if needed (Supabase should auto-parse, but be safe)
    let itineraryCostingOptions = itinerary?.costing_options;
    let metaCostingOptions = itineraryMeta?.costing_options;

    // Parse if string (shouldn't happen with Supabase, but be defensive)
    if (typeof itineraryCostingOptions === "string") {
      try {
        itineraryCostingOptions = JSON.parse(itineraryCostingOptions);
      } catch (e) {
        console.error(
          "[PDF Generator] Failed to parse itinerary.costing_options:",
          e,
        );
      }
    }
    if (typeof metaCostingOptions === "string") {
      try {
        metaCostingOptions = JSON.parse(metaCostingOptions);
      } catch (e) {
        console.error(
          "[PDF Generator] Failed to parse itineraryMeta.costing_options:",
          e,
        );
      }
    }

    const costingOption =
      itineraryCostingOptions?.[0] || metaCostingOptions?.[0];
    let costing = null;

    // Debug logging - check where costing_options came from
    pdfLog(
      `[PDF Generator] Checking costing_options - itineraryMeta has: ${!!metaCostingOptions}, itinerary has: ${!!itineraryCostingOptions}`,
    );
    if (itineraryCostingOptions) {
      pdfLog(
        `[PDF Generator] Found costing_options in itinerary_versions, count: ${
          Array.isArray(itineraryCostingOptions)
            ? itineraryCostingOptions.length
            : "not an array"
        }, type: ${typeof itineraryCostingOptions}`,
      );
    }
    if (metaCostingOptions) {
      pdfLog(
        `[PDF Generator] Found costing_options in itineraries, count: ${
          Array.isArray(metaCostingOptions)
            ? metaCostingOptions.length
            : "not an array"
        }, type: ${typeof metaCostingOptions}`,
      );
    }

    // Parse costing.costing if it's a string (defensive check)
    if (costingOption && typeof costingOption.costing === "string") {
      try {
        costingOption.costing = JSON.parse(costingOption.costing);
        pdfLog("[PDF Generator] Parsed costingOption.costing from string");
      } catch (e) {
        console.error(
          "[PDF Generator] Failed to parse costingOption.costing:",
          e,
        );
      }
    }

    // Debug logging for GST/TCS values
    if (costingOption) {
      pdfLog(
        `[PDF Generator] Costing option found. GST: ${costingOption.gstPercentage}%, TCS: ${costingOption.tcsPercentage}%, isGstApplied: ${costingOption.isGstApplied}, isTcsApplied: ${costingOption.isTcsApplied}`,
      );
      pdfLog(
        `[PDF Generator] Costing object keys:`,
        Object.keys(costingOption),
      );
      pdfLog(
        `[PDF Generator] Costing.costing exists: ${!!costingOption.costing}, type: ${typeof costingOption.costing}`,
      );
      if (costingOption.costing) {
        pdfLog(
          `[PDF Generator] Costing.costing keys:`,
          Object.keys(costingOption.costing),
        );
      }
      pdfLog(
        `[PDF Generator] Costing structure:`,
        JSON.stringify(
          {
            sightseeing: costingOption.costing?.sightseeing?.length || 0,
            hotels: costingOption.costing?.hotels?.length || 0,
            transfers: costingOption.costing?.transfers?.length || 0,
            visa: costingOption.costing?.visa?.length || 0,
            insurance: costingOption.costing?.insurance?.length || 0,
            flights_outbound:
              costingOption.costing?.flights_outbound?.length || 0,
            flights_intercity:
              costingOption.costing?.flights_intercity?.length || 0,
            flights_return: costingOption.costing?.flights_return?.length || 0,
          },
          null,
          2,
        ),
      );
      // Full costing structure for debugging
      if (costingOption.costing?.sightseeing) {
        pdfLog(
          `[PDF Generator] Full sightseeing array:`,
          JSON.stringify(costingOption.costing.sightseeing, null, 2),
        );
      }
    } else {
      console.warn(
        `[PDF Generator] No costing option found in itineraryMeta or itinerary`,
      );
      pdfLog(
        `[PDF Generator] itineraryMeta.costing_options:`,
        metaCostingOptions,
      );
      pdfLog(
        `[PDF Generator] itinerary.costing_options:`,
        itineraryCostingOptions,
      );
    }
    let flightsData = [];
    let hotelsData = [];
    let visaInfo = null;

    // Extract flights data for Addons section
    // CRITICAL: Use ONLY flights from the selected version (itinerary object)
    // Do NOT fallback to flights from other versions or itineraryMeta
    console.log(
      `[PDF Generator] 🔍 Checking flights for version ${itinerary?.version_number || "unknown"}. Requested version: ${versionNumber}`,
    );

    if (!itinerary) {
      console.error(
        `[PDF Generator] ⚠️ ERROR: itinerary is null/undefined! Cannot extract flights.`,
      );
      flightsData = [];
    } else if (
      itinerary.detailed_flights &&
      Array.isArray(itinerary.detailed_flights)
    ) {
      // Filter out any null/undefined flights and ensure we only use flights from THIS version
      flightsData = itinerary.detailed_flights
        .filter((flight) => flight !== null && flight !== undefined)
        .map((flight) => ({
          direction: flight.direction || "onward",
          segments: flight.segments || [],
          price: flight.price || 0,
          currency: flight.currency || "INR",
          totalDuration: flight.totalDuration || "",
        }));

      console.log(
        `[PDF Generator] ✅ Extracted ${flightsData.length} flight(s) from version ${itinerary.version_number}. Flight directions: ${flightsData.map((f) => f.direction).join(", ")}`,
      );

      // Log flight details for debugging
      if (flightsData.length > 0) {
        pdfLog(
          `[PDF Generator] Version ${itinerary.version_number} has ${flightsData.length} flight(s) — Flight Details section will be included in PDF.`,
        );
        flightsData.forEach((flight, idx) => {
          const firstSeg = flight.segments?.[0];
          console.log(
            `[PDF Generator]   Flight ${idx + 1}: ${firstSeg?.from_airport || "N/A"} → ${firstSeg?.to_airport || "N/A"} (${flight.direction}) - Airline: ${firstSeg?.airline || "N/A"}`,
          );
        });
      }
    } else {
      console.log(
        `[PDF Generator] ❌ No flights found in version ${itinerary.version_number || "unknown"}. detailed_flights type: ${itinerary.detailed_flights ? (Array.isArray(itinerary.detailed_flights) ? `array(${itinerary.detailed_flights.length})` : typeof itinerary.detailed_flights) : "undefined"}`,
      );
      flightsData = [];
    }

    // Final safety check: Ensure flightsData is empty if version mismatch
    if (versionNumber !== undefined && versionNumber !== null) {
      const selectedVersionNum = Number(itinerary?.version_number);
      const requestedVersionNum = Number(versionNumber);
      if (
        flightsData.length > 0 &&
        selectedVersionNum !== requestedVersionNum
      ) {
        console.warn(
          `[PDF Generator] ⚠️ WARNING: Version mismatch! Selected version ${selectedVersionNum} but requested ${requestedVersionNum}. Clearing flights data.`,
        );
        flightsData = [];
      }
    }

    // Log final flightsData state
    console.log(
      `[PDF Generator] 📊 Final flightsData count: ${flightsData.length} (will ${flightsData.length > 0 ? "SHOW" : "NOT SHOW"} in PDF)`,
    );

    // ====================================================================
    // CRITICAL: Use ONLY data from the CURRENT VERSION (itinerary object)
    // Do NOT use data from old versions or fallback to other sources
    // ====================================================================
    // Extract hotels data - Use detailed_hotels from the selected version as source of truth
    // CRITICAL: Use ONLY hotels from the selected version's detailed_hotels
    // Do NOT use hotels from old versions or costing hotels as fallback
    const detailedHotels = itinerary?.detailed_hotels || [];

    // Debug: Log detailed_hotels structure to verify rooms are included
    pdfLog("[PDF Generator] detailed_hotels count:", detailedHotels.length);
    if (detailedHotels.length > 0) {
      detailedHotels.forEach((hotel, idx) => {
        pdfLog(
          `[PDF Generator] Hotel ${idx + 1}: ${hotel.name}, rooms:`,
          hotel.rooms ? `${hotel.rooms.length} room(s)` : "no rooms array",
        );
        if (hotel.rooms && hotel.rooms.length > 0) {
          hotel.rooms.forEach((room, roomIdx) => {
            pdfLog(
              `  Room ${roomIdx + 1}: ${
                room.name || "Unnamed"
              }, confirmation_number: ${room.confirmation_number || "N/A"}`,
            );
          });
        }
      });
    }

    // Get costing hotels ONLY from the current version's costing_options
    // This ensures we only match with hotels from the current version, not old versions
    const costingHotels = costingOption?.costing?.hotels || [];
    const includedCostingHotels = costingHotels.filter((h) => h.included);

    pdfLog(
      "[PDF Generator] Detailed hotels count (from selected version):",
      detailedHotels.length,
    );
    pdfLog(
      "[PDF Generator] Costing hotels count (from current version only):",
      includedCostingHotels.length,
    );

    // ONLY use detailed_hotels from the current version - no fallback to costing hotels
    if (detailedHotels.length > 0) {
      // Use detailed_hotels from the selected version as the ONLY source of truth
      hotelsData = detailedHotels
        .map((detailedHotel) => {
          // Filter out "New Hotel" placeholder
          if (
            !detailedHotel.name ||
            detailedHotel.name.toLowerCase().trim() === "new hotel"
          ) {
            return null;
          }

          // Use dates exactly as stored in CRM, no validation or modification
          let checkInDate = detailedHotel.check_in_date || "";
          let checkOutDate = detailedHotel.check_out_date || "";

          // Try to find matching hotel in costing by name for pricing info
          // Only match with costing hotels from the current version
          let costingHotel = null;
          if (includedCostingHotels.length > 0) {
            costingHotel = includedCostingHotels.find(
              (ch) =>
                ch.name &&
                detailedHotel.name &&
                ch.name.toLowerCase().trim() ===
                  detailedHotel.name.toLowerCase().trim(),
            );
          }

          // Only include hotels that are in costing (included) OR if no costing exists, include all
          // This ensures we only show hotels that are part of the package pricing
          if (costingHotels.length > 0 && !costingHotel) {
            // Hotel exists in detailed_hotels but not in costing - skip it
            console.warn(
              `[PDF Generator] Skipping hotel ${detailedHotel.name} - not found in current version's costing`,
            );
            return null;
          }

          // Map pricing type to room type display
          const pricingType = costingHotel?.pricingType || "";
          let roomTypeDisplay = detailedHotel.room_type || "Standard";

          // If pricing type indicates room sharing, use that for display
          if (pricingType.includes("TRIPLE")) {
            roomTypeDisplay = "TRIPLE Sharing";
          } else if (
            pricingType.includes("DOUBLE") ||
            pricingType.includes("TWIN")
          ) {
            roomTypeDisplay = "DOUBLE Sharing";
          } else if (pricingType.includes("Single")) {
            roomTypeDisplay = "Single";
          }

          // Use dates exactly as stored - no validation or modification

          return {
            name: detailedHotel.name || "Hotel",
            city: "", // detailed_hotels doesn't have city, but we can extract from name if needed
            check_in_date: checkInDate,
            check_out_date: checkOutDate,
            nights: detailedHotel.nights || 1,
            room_type: roomTypeDisplay,
            quantity: costingHotel?.quantity || 1, // Number of rooms from costing
            rooms: detailedHotel.rooms || [], // Include rooms with confirmation numbers
          };
        })
        .filter((h) => h !== null); // Remove null entries (hotels not in costing)

      // Remove duplicates by name, check-in date, and check-in time (if available)
      // NO VALIDATION - display hotels exactly as entered in CRM
      const seenHotels = new Map();
      hotelsData = hotelsData.filter((hotel) => {
        // Deduplicate by name, check-in date, and check-in time (if available)
        // This allows multiple hotels on the same day if they have different times
        const checkInTime = hotel.check_in_time || "";
        const key = `${hotel.name.toLowerCase().trim()}_${
          hotel.check_in_date
        }_${checkInTime}`;
        if (seenHotels.has(key)) {
          console.warn(
            `[PDF Generator] Removing duplicate hotel: ${hotel.name} (check-in: ${hotel.check_in_date} ${checkInTime})`,
          );
          return false;
        }
        seenHotels.set(key, true);
        return true;
      });

      pdfLog("[PDF Generator] Final hotelsData count:", hotelsData.length);
      pdfLog(
        "[PDF Generator] Hotels to display (from current version ONLY):",
        hotelsData
          .map((h) => `${h.name} (${h.check_in_date} - ${h.check_out_date})`)
          .join(", "),
      );
      // Debug: Log rooms with confirmation numbers
      hotelsData.forEach((hotel, idx) => {
        if (hotel.rooms && hotel.rooms.length > 0) {
          pdfLog(
            `[PDF Generator] Hotel ${idx + 1} (${hotel.name}) has ${
              hotel.rooms.length
            } room(s):`,
            hotel.rooms.map((r) => ({
              name: r.name,
              confirmation_number: r.confirmation_number,
              adults: r.adults,
              children: r.children,
            })),
          );
        } else {
          pdfLog(
            `[PDF Generator] Hotel ${idx + 1} (${
              hotel.name
            }) has no rooms array or empty rooms`,
          );
        }
      });
    } else {
      // NO FALLBACK: If no detailed_hotels in current version, don't show any hotels
      // This ensures we ONLY use the current version's data, not old versions
      console.warn(
        "[PDF Generator] No detailed_hotels found in current version - not using fallback to costing hotels",
      );
      hotelsData = [];
    }

    // Get visa information - ONLY from itinerary (NO internet scraping during PDF generation)
    // Show visa ONLY if visa items are selected/included in costing
    // First check if there are any visa items included in costing
    let hasVisaItemsIncluded = false;
    if (
      costingOption?.costing?.visa &&
      Array.isArray(costingOption.costing.visa)
    ) {
      hasVisaItemsIncluded = costingOption.costing.visa.some(
        (item) => item.included === true,
      );
    }

    pdfLog(
      "[PDF Generator] Visa items check - hasVisaItemsIncluded:",
      hasVisaItemsIncluded,
    );

    // Only show visa section if visa items are included AND detailed_visa exists AND visa category is enabled
    const categoryEnabled = costingOption?.categoryEnabled || {};
    if (
      hasVisaItemsIncluded &&
      itinerary?.detailed_visa &&
      categoryEnabled.visa !== false
    ) {
      visaInfo = {
        destination: itineraryMeta.destination || lead?.destination || "",
        type: itinerary.detailed_visa.type || "NORMAL",
        duration: itinerary.detailed_visa.duration || "",
        validity_period: itinerary.detailed_visa.validity_period || "",
        length_of_stay: itinerary.detailed_visa.length_of_stay || "",
        documents_required: itinerary.detailed_visa.documents_required || "",
        note: itinerary.detailed_visa.note || "",
        includes: itinerary.detailed_visa.includes || "",
        requirements: itinerary.detailed_visa.visa_requirements || "",
        source: "itinerary",
      };
      pdfLog(
        "[PDF Generator] Visa info set:",
        !!visaInfo,
        "Type:",
        visaInfo.type,
      );
    } else {
      if (categoryEnabled.visa === false) {
        pdfLog(
          "[PDF Generator] Visa category is disabled in Include in Cost Summary - hiding visa section",
        );
      } else {
        pdfLog(
          "[PDF Generator] No visa items included or no detailed_visa found - hiding visa section",
        );
      }
      visaInfo = null;
    }

    // Fetch FX rates for currency conversion (needed for both manual and itemized costing)
    // Define this outside the costingOption block so it's always available
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
        pdfLog(
          "[PDF Generator] FX rates fetched successfully. Available currencies:",
          Object.keys(fxRates).join(", "),
        );
      }
    } catch (fxError) {
      console.error("[PDF Generator] Error fetching FX rates:", fxError);
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

    if (costingOption) {
      // Extract hotels for "Own Booking"
      const hotels = (costingOption.costing?.hotels || []).filter(
        (h) => h.included,
      );
      const ownBooking = hotels.map((hotel) => ({
        location: hotel.city || hotel.name || "N/A",
        nights: hotel.nights || 0,
        stars: 4, // Default - can be enhanced if star rating is stored
      }));

      // Calculate totals and per-category costs
      let subtotal = 0;
      let gst = 0;
      let tcs = 0;
      let flightFee = 0; // Will be calculated from included flights

      const adults = adultsForPdf;
      const childrenCount = childrenForPdf;
      const infants = infantsForPdf;

      // Check if manual costing is used
      if (!costingOption) {
        console.error(
          `[PDF Generator] No costing option found. Cannot calculate costs.`,
        );
        throw new Error(
          "Costing options not found for this itinerary. Please ensure costing is configured.",
        );
      }

      if (costingOption.isManualCosting) {
        // Calculate flight cost for manual costing (only if flights category is enabled)
        const categoryEnabled = costingOption.categoryEnabled || {};
        let manualFlightCostBreakdown = { adultCost: 0, childCost: 0 };

        if (categoryEnabled.flights !== false) {
          const isManualFlightCost = costingOption.isManualFlightCost === true;

          if (isManualFlightCost) {
            // Use manual flight cost
            const manualFlightPerAdult =
              costingOption.manualFlightPerAdult || 0;
            const manualFlightPerChild =
              costingOption.manualFlightPerChild || 0;
            const manualFlightPerInfant =
              costingOption.manualFlightPerInfant || 0;

            // Calculate child cost using age-based pricing if available
            let childFlightCost = 0;
            const manualFlightChildPrices =
              costingOption.manualFlightChildPrices || {};
            const childAges = lead?.requirements?.child_ages || [];
            const childCostByAge = {};

            if (
              Object.keys(manualFlightChildPrices).length > 0 &&
              childAges.length > 0
            ) {
              // Use age-based pricing - group by age and calculate cost per age
              const ageGroups = {};
              childAges.forEach((age) => {
                ageGroups[age] = (ageGroups[age] || 0) + 1;
              });

              Object.entries(ageGroups).forEach(([ageStr, count]) => {
                const age = parseInt(ageStr);
                const price = manualFlightChildPrices[age] || 0;
                const ageCost = price * count;
                childCostByAge[age] = ageCost;
                childFlightCost += ageCost;
              });
            } else {
              // Fallback to per-child pricing
              childFlightCost = manualFlightPerChild * childrenCount;
            }

            // Calculate base flight cost (without GST - GST removed per user request)
            const baseFlightFee =
              manualFlightPerAdult * adults +
              childFlightCost +
              manualFlightPerInfant * infants;
            manualFlightCostBreakdown.adultCost = manualFlightPerAdult * adults;
            manualFlightCostBreakdown.childCost = childFlightCost;
            manualFlightCostBreakdown.childCostByAge = childCostByAge; // Add age-based breakdown
            manualFlightCostBreakdown.infantCost =
              manualFlightPerInfant * infants;

            // No GST on flights (removed per user request)
            flightFee = baseFlightFee;
          } else {
            // Get actual flight IDs from detailed_flights to ensure we only calculate costs for flights that exist
            const actualFlightIds = new Set(
              (itinerary?.detailed_flights || []).map((f) => f.id),
            );

            // Calculate actual flight cost from included flights that actually exist in detailed_flights
            const allFlights = [
              ...(costingOption.costing?.flights_outbound || []),
              ...(costingOption.costing?.flights_intercity || []),
              ...(costingOption.costing?.flights_return || []),
            ];
            allFlights.forEach((flight) => {
              // Only include flight cost if:
              // 1. The flight exists in detailed_flights (has matching ID)
              // 2. The flight is included (included !== false)
              if (actualFlightIds.has(flight.id) && flight.included !== false) {
                const unitPrice = flight.unitPrice || 0;
                const pricingType = flight.pricingType || "Per Adult";

                // Calculate cost based on pricing type and quantity
                // If Per Adult, multiply by number of adults
                // If Per Child, multiply by number of children
                // If Per Infant, multiply by number of infants
                // Otherwise, use quantity as-is (for backward compatibility)
                let multiplier = flight.quantity || 1;
                if (pricingType === "Per Adult") {
                  multiplier = adults;
                  manualFlightCostBreakdown.adultCost += unitPrice * adults;
                } else if (pricingType === "Per Child") {
                  multiplier = childrenCount;
                  manualFlightCostBreakdown.childCost +=
                    unitPrice * childrenCount;
                } else if (pricingType === "Per Infant") {
                  multiplier = infants;
                  manualFlightCostBreakdown.infantCost =
                    (manualFlightCostBreakdown.infantCost || 0) +
                    unitPrice * infants;
                } else {
                  manualFlightCostBreakdown.adultCost += unitPrice * multiplier;
                }

                // Flights don't have nights, so just unitPrice * multiplier
                flightFee += unitPrice * multiplier;
              }
            });

            // Apply GST on flights if enabled (for non-manual flight costs)
            if (costingOption.isFlightGstApplied && flightFee > 0) {
              const flightGst = flightFee * 0.05; // 5% GST
              flightFee += flightGst;
            }
          }
        }

        const manualPerAdultTwin = costingOption.manualPerAdultTwin || 0;
        const manualPerAdultTriple = costingOption.manualPerAdultTriple || 0;
        const manualPerAdultQuad = costingOption.manualPerAdultQuad || 0;
        const manualPerAdultSingle = costingOption.manualPerAdultSingle || 0;
        const manualPerAdult =
          costingOption.manualPerAdult ||
          manualPerAdultTwin ||
          manualPerAdultTriple ||
          manualPerAdultQuad ||
          manualPerAdultSingle ||
          0;
        const manualPerChild = costingOption.manualPerChild || 0;
        const manualPerInfant = costingOption.manualPerInfant || 0;

        // Get individual child prices from all sharing types
        const childPricesSingle = costingOption.manualChildPricesSingle || [];
        const childPricesDouble = costingOption.manualChildPricesDouble || [];
        const childPricesTriple = costingOption.manualChildPricesTriple || [];
        const childPricesQuad = costingOption.manualChildPricesQuad || [];

        // Get allocated adults for each type
        const allocatedAdultsSingle = costingOption.manualAdultsSingle || 0;
        const allocatedAdultsDouble = costingOption.manualAdultsDouble || 0;
        const allocatedAdultsTriple = costingOption.manualAdultsTriple || 0;
        const allocatedAdultsQuad = costingOption.manualAdultsQuad || 0;

        // Collect all selected additional pricing options with allocated adults (for display and calculation)
        const selectedPricingOptions = [];
        if (manualPerAdultSingle > 0 && allocatedAdultsSingle > 0) {
          selectedPricingOptions.push({
            label: "Per Adult (Single)",
            price: manualPerAdultSingle,
            adults: allocatedAdultsSingle,
            type: "adult",
            sharingType: "Single",
          });
        }
        // Add child pricing for Single
        if (childPricesSingle && childPricesSingle.length > 0) {
          const singleChildTotal = childPricesSingle.reduce((sum, child) => {
            return sum + parseFloat(String(child?.price || 0));
          }, 0);
          if (singleChildTotal > 0) {
            const ages = childPricesSingle
              .map((c) => c.age)
              .filter((age) => age > 0);
            selectedPricingOptions.push({
              label: "Per Child (Single)",
              price: singleChildTotal / childPricesSingle.length, // Average per child
              children: childPricesSingle.length,
              total: singleChildTotal,
              type: "child",
              sharingType: "Single",
              ages: ages,
            });
          }
        }
        if (manualPerAdultTwin > 0 && allocatedAdultsDouble > 0) {
          selectedPricingOptions.push({
            label: "Per Adult (Double Sharing)",
            price: manualPerAdultTwin,
            adults: allocatedAdultsDouble,
            type: "adult",
            sharingType: "Double",
          });
        }
        // Add child pricing for Double
        if (childPricesDouble && childPricesDouble.length > 0) {
          const doubleChildTotal = childPricesDouble.reduce((sum, child) => {
            return sum + parseFloat(String(child?.price || 0));
          }, 0);
          if (doubleChildTotal > 0) {
            const ages = childPricesDouble
              .map((c) => c.age)
              .filter((age) => age > 0);
            selectedPricingOptions.push({
              label: "Per Child (Double Sharing)",
              price: doubleChildTotal / childPricesDouble.length, // Average per child
              children: childPricesDouble.length,
              total: doubleChildTotal,
              type: "child",
              sharingType: "Double",
              ages: ages,
            });
          }
        }
        if (manualPerAdultTriple > 0 && allocatedAdultsTriple > 0) {
          selectedPricingOptions.push({
            label: "Per Adult (Triple Sharing)",
            price: manualPerAdultTriple,
            adults: allocatedAdultsTriple,
            type: "adult",
            sharingType: "Triple",
          });
        }
        // Add child pricing for Triple
        if (childPricesTriple && childPricesTriple.length > 0) {
          const tripleChildTotal = childPricesTriple.reduce((sum, child) => {
            return sum + parseFloat(String(child?.price || 0));
          }, 0);
          if (tripleChildTotal > 0) {
            const ages = childPricesTriple
              .map((c) => c.age)
              .filter((age) => age > 0);
            selectedPricingOptions.push({
              label: "Per Child (Triple Sharing)",
              price: tripleChildTotal / childPricesTriple.length, // Average per child
              children: childPricesTriple.length,
              total: tripleChildTotal,
              type: "child",
              sharingType: "Triple",
              ages: ages,
            });
          }
        }
        if (manualPerAdultQuad > 0 && allocatedAdultsQuad > 0) {
          selectedPricingOptions.push({
            label: "Per Adult (Quad Sharing)",
            price: manualPerAdultQuad,
            adults: allocatedAdultsQuad,
            type: "adult",
            sharingType: "Quad",
          });
        }
        // Add child pricing for Quad
        if (childPricesQuad && childPricesQuad.length > 0) {
          const quadChildTotal = childPricesQuad.reduce((sum, child) => {
            return sum + parseFloat(String(child?.price || 0));
          }, 0);
          if (quadChildTotal > 0) {
            const ages = childPricesQuad
              .map((c) => c.age)
              .filter((age) => age > 0);
            selectedPricingOptions.push({
              label: "Per Child (Quad Sharing)",
              price: quadChildTotal / childPricesQuad.length, // Average per child
              children: childPricesQuad.length,
              total: quadChildTotal,
              type: "child",
              sharingType: "Quad",
              ages: ages,
            });
          }
        }

        // Determine primary pricing type label (use first selected, or default)
        let pricingTypeLabel = "Per Adult";
        if (selectedPricingOptions.length > 0) {
          pricingTypeLabel = selectedPricingOptions[0].label;
        } else if (manualPerAdult > 0) {
          pricingTypeLabel = "Per Adult";
        }

        // Calculate subtotal: Use allocated adults if specified, otherwise use total adults
        let adultTotal = 0;
        if (
          allocatedAdultsSingle > 0 ||
          allocatedAdultsDouble > 0 ||
          allocatedAdultsTriple > 0 ||
          allocatedAdultsQuad > 0
        ) {
          // Use allocated adults
          if (manualPerAdultSingle > 0 && allocatedAdultsSingle > 0) {
            adultTotal += manualPerAdultSingle * allocatedAdultsSingle;
          }
          if (manualPerAdultTwin > 0 && allocatedAdultsDouble > 0) {
            adultTotal += manualPerAdultTwin * allocatedAdultsDouble;
          }
          if (manualPerAdultTriple > 0 && allocatedAdultsTriple > 0) {
            adultTotal += manualPerAdultTriple * allocatedAdultsTriple;
          }
          if (manualPerAdultQuad > 0 && allocatedAdultsQuad > 0) {
            adultTotal += manualPerAdultQuad * allocatedAdultsQuad;
          }
        } else {
          // Fallback to old behavior: use total adults for all selected options
          let additionalPricingTotal = 0;
          if (manualPerAdultSingle > 0)
            additionalPricingTotal += manualPerAdultSingle * adults;
          if (manualPerAdultTwin > 0)
            additionalPricingTotal += manualPerAdultTwin * adults;
          if (manualPerAdultTriple > 0)
            additionalPricingTotal += manualPerAdultTriple * adults;
          if (manualPerAdultQuad > 0)
            additionalPricingTotal += manualPerAdultQuad * adults;
          adultTotal =
            additionalPricingTotal > 0
              ? additionalPricingTotal
              : manualPerAdult * adults;
        }
        // Calculate child total from individual child prices
        let childTotal = 0;
        [
          ...childPricesSingle,
          ...childPricesDouble,
          ...childPricesTriple,
          ...childPricesQuad,
        ].forEach((child) => {
          if (child && child.price) {
            childTotal += parseFloat(String(child.price)) || 0;
          }
        });

        // Fallback to manualPerChild if no individual child prices are set
        if (childTotal === 0 && manualPerChild > 0) {
          childTotal = manualPerChild * childrenCount;
        }

        let baseSubtotal = adultTotal + childTotal + manualPerInfant * infants;

        // Apply markup if set
        const markup = costingOption.markup || 0;
        if (markup > 0) {
          baseSubtotal = baseSubtotal * (1 + markup / 100);
        }

        // Apply discount if set (on subtotal AFTER markup, BEFORE GST/TCS)
        const discount = costingOption.discount || 0;
        let discountAmount = 0;
        if (discount > 0) {
          discountAmount = baseSubtotal * (discount / 100);
          baseSubtotal -= discountAmount;
        }

        // Base Package is the subtotal before flight cost
        const basePackage = Math.round(baseSubtotal);

        // Calculate GST/TCS on base package only (not on flight cost)
        // Extract GST/TCS percentages from costingOption
        let gstPercent = costingOption?.gstPercentage;
        let tcsPercent = costingOption?.tcsPercentage;
        let isGstApplied = costingOption?.isGstApplied;
        let isTcsApplied = costingOption?.isTcsApplied;

        // Priority 1: If flags are explicitly set to true, use them (even if percentages are missing)
        // This handles cases where flags are set but percentages weren't saved
        if (isGstApplied === true) {
          // If flag is true but percentage is missing, use default 5%
          if (
            gstPercent === undefined ||
            gstPercent === null ||
            gstPercent === 0
          ) {
            gstPercent = 5;
            pdfLog(
              `[PDF Generator] Flag isGstApplied=true but percentage missing. Using default GST 5%`,
            );
          }
          // Ensure flag stays true
          isGstApplied = true;
        } else if (isGstApplied === false) {
          // If flag is explicitly false, respect it
          gstPercent = 0;
          isGstApplied = false;
        } else {
          // Flag is undefined/null - apply default 5% GST unless explicitly disabled
          if (
            gstPercent !== undefined &&
            gstPercent !== null &&
            gstPercent > 0
          ) {
            isGstApplied = true;
            pdfLog(
              `[PDF Generator] Inferred isGstApplied=true from gstPercentage=${gstPercent}%`,
            );
          } else if (gstPercent === 0) {
            // Explicitly set to 0, don't apply
            isGstApplied = false;
            gstPercent = 0;
          } else {
            // Default: Apply 5% GST when flag is undefined/null and percentage is also undefined/null
            isGstApplied = true;
            gstPercent = 5;
            pdfLog(
              `[PDF Generator] Defaulting to GST 5% (flag and percentage both undefined/null)`,
            );
          }
        }

        // Same logic for TCS
        if (isTcsApplied === true) {
          // If flag is true but percentage is missing, use default 5%
          if (
            tcsPercent === undefined ||
            tcsPercent === null ||
            tcsPercent === 0
          ) {
            tcsPercent = 5;
            pdfLog(
              `[PDF Generator] Flag isTcsApplied=true but percentage missing. Using default TCS 5%`,
            );
          }
          // Ensure flag stays true
          isTcsApplied = true;
        } else if (isTcsApplied === false) {
          // If flag is explicitly false, respect it
          tcsPercent = 0;
          isTcsApplied = false;
        } else {
          // Flag is undefined/null - apply default 5% TCS unless explicitly disabled
          if (
            tcsPercent !== undefined &&
            tcsPercent !== null &&
            tcsPercent > 0
          ) {
            isTcsApplied = true;
            pdfLog(
              `[PDF Generator] Inferred isTcsApplied=true from tcsPercentage=${tcsPercent}%`,
            );
          } else if (tcsPercent === 0) {
            // Explicitly set to 0, don't apply
            isTcsApplied = false;
            tcsPercent = 0;
          } else {
            // Default: Apply 5% TCS when flag is undefined/null and percentage is also undefined/null
            isTcsApplied = true;
            tcsPercent = 5;
            pdfLog(
              `[PDF Generator] Defaulting to TCS 5% (flag and percentage both undefined/null)`,
            );
          }
        }

        // Ensure we have valid numbers (final safety check)
        gstPercent =
          gstPercent !== undefined && gstPercent !== null ? gstPercent : 0;
        tcsPercent =
          tcsPercent !== undefined && tcsPercent !== null ? tcsPercent : 0;

        pdfLog(
          `[PDF Generator] Final GST/TCS values - GST: ${gstPercent}% (applied: ${isGstApplied}), TCS: ${tcsPercent}% (applied: ${isTcsApplied})`,
        );

        // GST is calculated on: baseSubtotal
        const calculatedGst = isGstApplied
          ? baseSubtotal * (gstPercent / 100)
          : 0;
        // TCS is calculated on: (baseSubtotal + GST) - matching itinerary page logic
        const calculatedTcs = isTcsApplied
          ? (baseSubtotal + calculatedGst) * (tcsPercent / 100)
          : 0;

        // Calculate actual base amounts (before GST/TCS)
        const actualPerAdult =
          adults > 0
            ? Math.round(baseSubtotal / adults)
            : Math.round(baseSubtotal);
        const actualPerChild =
          childrenCount > 0
            ? Math.round(manualPerChild * (markup > 0 ? 1 + markup / 100 : 1))
            : 0;

        // Use actual values directly - NO inflation, NO discount - match CRM exactly
        // The CRM shows actual values, so PDF must match
        const actualGst = calculatedGst;
        const actualTcs = calculatedTcs;
        // TCS is calculated but NOT included in grand total - shown only in notice below
        const actualGrandTotal = baseSubtotal + actualGst + flightFee;

        // Apply GST/TCS on the actual subtotal (matching CRM logic)
        // GST is calculated on: baseSubtotal (matching CRM)
        const gstOnSubtotal = isGstApplied
          ? Math.round(baseSubtotal * (gstPercent / 100))
          : 0;
        // TCS is calculated on: (baseSubtotal + GST) - matching CRM logic (excluding flights)
        const tcsOnSubtotal = isTcsApplied
          ? Math.round((baseSubtotal + gstOnSubtotal) * (tcsPercent / 100))
          : 0;

        pdfLog(
          `[PDF Generator] GST/TCS Calculation - Subtotal: ₹${baseSubtotal.toLocaleString(
            "en-IN",
          )}, GST (${gstPercent}%): ₹${gstOnSubtotal.toLocaleString(
            "en-IN",
          )}, TCS (${tcsPercent}% on subtotal+GST): ₹${tcsOnSubtotal.toLocaleString(
            "en-IN",
          )}`,
        );

        // Grand Total = Package (Subtotal + GST + TCS) + Flight Cost (matching CRM)
        const finalGrandTotal =
          baseSubtotal + gstOnSubtotal + tcsOnSubtotal + flightFee;

        costing = {
          isManual: true,
          pricingTypeLabel,
          perAdult: Math.round(actualPerAdult), // Show actual per adult (matching CRM)
          perChild: Math.round(actualPerChild), // Show actual per child (matching CRM)
          basePackage: Math.round(baseSubtotal + discountAmount), // Subtotal before discount (matching CRM)
          subtotal: Math.round(baseSubtotal), // Subtotal after discount (matching CRM)
          flightCost: flightFee,
          flightCostBreakdown: manualFlightCostBreakdown, // Breakdown for display
          gst: gstOnSubtotal, // GST on actual subtotal (matching CRM)
          tcs: tcsOnSubtotal, // TCS on actual subtotal + GST (matching CRM)
          discountAmount: Math.round(discountAmount), // Discount amount
          discountPercentage: discount, // Discount percentage
          grandTotal: Math.round(finalGrandTotal), // Actual grand total (matching CRM)
          adultsCount: adults,
          childrenCount: childrenCount,
          gstPercentage: gstPercent,
          tcsPercentage: tcsPercent,
          isGstApplied: isGstApplied || false,
          isTcsApplied: isTcsApplied || false,
          additionalPricingOptions: selectedPricingOptions.map((opt) => {
            const markupMultiplier = markup > 0 ? 1 + markup / 100 : 1;
            if (opt.type === "child") {
              // For child pricing, use the total directly
              return {
                label: opt.label,
                price: Math.round(
                  (opt.total / (opt.children || 1)) * markupMultiplier,
                ), // Average per child (with markup)
                children: opt.children || 0,
                total: Math.round(opt.total * markupMultiplier), // Total child cost (with markup)
                type: "child",
                sharingType: opt.sharingType,
                ages: opt.ages || [],
              };
            } else {
              // For adult pricing
              return {
                label: opt.label,
                price: Math.round(opt.price * markupMultiplier), // Actual price per adult (with markup)
                adults: opt.adults || 0, // Number of adults allocated to this pricing type
                total: Math.round(
                  opt.price * (opt.adults || 0) * markupMultiplier,
                ), // Total cost for this pricing type
                type: "adult",
                sharingType: opt.sharingType,
              };
            }
          }), // All selected pricing options for PDF display with allocated adults/children
        };
      } else {
        // Itemized costing (existing logic)
        // Category totals for Trip Cost Summary
        const categoryTotals = {
          Flights: { total: 0, gst: 0, tcs: 0 },
          Hotels: { total: 0, gst: 0, tcs: 0 },
          Sightseeing: { total: 0, gst: 0, tcs: 0 },
          Transfers: { total: 0, gst: 0, tcs: 0 },
          Visa: { total: 0, gst: 0, tcs: 0 },
          Insurance: { total: 0, gst: 0, tcs: 0 },
          Other: { total: 0, gst: 0, tcs: 0 },
        };

        // Track per adult and per child costs separately
        let perAdultTotal = 0;
        let perChildTotal = 0;

        // fxRates is already defined before the if-else block, so we can use it here

        // Process all costing items by category (GST/TCS NOT on individual items, only on subtotal)
        const processItems = (items, category) => {
          // Check if this category is enabled in "Include in Cost Summary"
          const categoryEnabled = costingOption.categoryEnabled || {};
          const categoryKey =
            category === "flights_outbound" ||
            category === "flights_intercity" ||
            category === "flights_return"
              ? "flights"
              : category === "hotels"
                ? "hotels"
                : category === "sightseeing"
                  ? "sightseeing"
                  : category === "transfers"
                    ? "transfers"
                    : category === "visa"
                      ? "visa"
                      : category === "insurance"
                        ? "insurance"
                        : null;

          // Skip processing if category is disabled (categoryEnabled[categoryKey] === false)
          if (categoryKey && categoryEnabled[categoryKey] === false) {
            pdfLog(
              `[PDF Generator] Skipping category ${category} - disabled in Include in Cost Summary`,
            );
            return; // Don't process items for disabled categories
          }

          const categoryName =
            category === "flights_outbound" ||
            category === "flights_intercity" ||
            category === "flights_return"
              ? "Flights"
              : category === "hotels"
                ? "Hotels"
                : category === "sightseeing"
                  ? "Sightseeing"
                  : category === "transfers"
                    ? "Transfers"
                    : category === "visa"
                      ? "Visa"
                      : category === "insurance"
                        ? "Insurance"
                        : "Other";

          items.forEach((item) => {
            if (!item.included) return;

            const unitPrice = item.unitPrice || 0;
            const currency = item.currency || "INR";

            // Flights and sightseeing don't have nights, so don't multiply by nights
            const isFlight =
              category === "flights_outbound" ||
              category === "flights_intercity" ||
              category === "flights_return";
            const isSightseeing = category === "sightseeing";
            const nights = isFlight || isSightseeing ? 1 : item.nights || 1;

            // For flights, calculate quantity based on pricing type
            // If Per Adult, multiply by number of adults; if Per Child, multiply by number of children; if Per Infant, multiply by number of infants
            let effectiveQuantity = item.quantity || 1;
            if (isFlight) {
              const pricingType = item.pricingType || "Per Adult";
              if (pricingType === "Per Adult") {
                effectiveQuantity = adults;
              } else if (pricingType === "Per Child") {
                effectiveQuantity = childrenCount;
              } else if (pricingType === "Per Infant") {
                effectiveQuantity = infants;
              }
              // For other pricing types or if no pricing type, use quantity as-is
            }

            // Skip items with quantity 0 - don't apply markup if there's no actual cost
            if (effectiveQuantity === 0) {
              return; // Skip this item entirely
            }

            // Skip items with unitPrice 0 - don't apply markup if there's no actual cost
            if (
              unitPrice === 0 ||
              unitPrice === null ||
              unitPrice === undefined
            ) {
              return; // Skip this item entirely
            }

            // Get FX rate - rates are stored as TO INR (e.g., USD: 83 means 1 USD = 83 INR)
            const fxRate = fxRates[currency] || (currency === "INR" ? 1 : 1);

            // For flights, do NOT apply markup - just currency conversion (matching frontend logic)
            // For other items (hotels, sightseeing, etc.), apply markup formula: ((unitPrice × qty × FX_rate × nights) + 2) × 1.15
            let itemCost;
            if (isFlight) {
              // Flights: unitPrice × effectiveQuantity × fxRate (no markup, no +2, no ×1.15)
              // This matches frontend: unitPrice * multiplier (where multiplier is adults/children)
              itemCost = unitPrice * effectiveQuantity * fxRate;
            } else {
              // Other items: Apply currency conversion and markup formula (if markup > 0)
              // For INR items, fxRate is 1, so formula becomes: ((unitPrice × qty × 1 × nights) + 2) × 1.15
              // fxRate is TO INR, so: USD 52.1 × 83 = 4,324.3 INR
              const baseAmount =
                unitPrice * effectiveQuantity * fxRate * nights;
              // Only apply markup if baseAmount > 0, otherwise skip (prevents ₹2 from 0 cost items)
              if (
                baseAmount === 0 ||
                baseAmount === null ||
                baseAmount === undefined
              ) {
                return; // Skip this item entirely
              }
              // Apply markup only if markup > 0, otherwise use base amount
              const markup = costingOption.markup || 0;
              itemCost =
                markup > 0 ? baseAmount * (1 + markup / 100) : baseAmount;
            }

            // Separate per adult, per child, and per infant costs (without GST/TCS)
            // All adult pricing types (including TWIN/DOUBLE, TRIPLE, SINGLE) go to perAdult
            const pricingType = item.pricingType || "Per Adult";
            if (pricingType === "Per Child") {
              perChildTotal += itemCost;
            } else if (pricingType === "Per Infant") {
              // Per Infant is free if 0, otherwise add to perChild for display
              if (itemCost > 0) {
                perChildTotal += itemCost;
              }
            } else {
              // All other types (Per Adult, TWIN/DOUBLE, TRIPLE, SINGLE) are per adult
              perAdultTotal += itemCost;
            }

            // Debug logging for sightseeing items
            if (category === "sightseeing") {
              const baseAmountForLog = isFlight
                ? unitPrice * effectiveQuantity * fxRate
                : unitPrice * effectiveQuantity * fxRate * nights;
              pdfLog(
                `[PDF Generator] Sightseeing item: ${
                  item.description || "N/A"
                }, unitPrice: ${unitPrice}, effectiveQuantity: ${effectiveQuantity}, currency: ${currency}, fxRate: ${fxRate}, baseAmount: ${baseAmountForLog}, itemCost: ${itemCost}, pricingType: ${pricingType}, perAdultTotal: ${perAdultTotal}, perChildTotal: ${perChildTotal}`,
              );
            }

            // Note: GST/TCS are NOT calculated on individual items - only at subtotal level
            categoryTotals[categoryName].total += itemCost;
            subtotal += itemCost;
          });
        };

        // Get detailed_hotels for room-based pricing calculation
        const detailedHotels = itinerary?.detailed_hotels || [];

        Object.entries(costingOption.costing || {}).forEach(
          ([category, items]) => {
            pdfLog(
              `[PDF Generator] Processing category: ${category}, items count: ${
                (items || []).length
              }`,
            );

            // Special handling for hotels with room data
            if (category === "hotels") {
              items.forEach((item) => {
                if (!item.included) return;

                // Check if this hotel has room data with adults and children
                const detailedHotel = detailedHotels.find(
                  (h) =>
                    h.name &&
                    item.name &&
                    h.name.toLowerCase().trim() ===
                      item.name.toLowerCase().trim(),
                );

                if (detailedHotel?.rooms && detailedHotel.rooms.length > 0) {
                  // Calculate costs from room data
                  let totalAdultCost = 0;
                  let totalChildCost = 0;
                  let totalAdults = 0;
                  let totalChildren = 0;

                  detailedHotel.rooms.forEach((room) => {
                    const nights = detailedHotel.nights || 1;
                    const adultCost =
                      room.adults * (room.pricePerAdultPerNight || 0) * nights;
                    totalAdultCost += adultCost;
                    totalAdults += room.adults;

                    // Calculate child costs by age (group by age to avoid double counting)
                    const childAgeGroups = {};
                    (room.childAges || []).forEach((age) => {
                      childAgeGroups[age] = (childAgeGroups[age] || 0) + 1;
                    });

                    Object.entries(childAgeGroups).forEach(
                      ([ageStr, count]) => {
                        const age = parseInt(ageStr);
                        const childPrice = room.childPrices?.[age] || 0;
                        const childCost = childPrice * count * nights;
                        totalChildCost += childCost;
                        totalChildren += count;
                      },
                    );
                  });

                  const currency = item.currency || "INR";
                  const fxRate =
                    fxRates[currency] || (currency === "INR" ? 1 : 1);
                  const markup = costingOption.markup || 0;

                  // Add adult cost if there are adults
                  if (totalAdultCost > 0 && totalAdults > 0) {
                    const adultBaseAmount = totalAdultCost * fxRate;
                    // Apply markup only if markup > 0, otherwise use base amount
                    const adultItemCost =
                      markup > 0
                        ? adultBaseAmount * (1 + markup / 100)
                        : adultBaseAmount;
                    perAdultTotal += adultItemCost;
                    categoryTotals["Hotels"].total += adultItemCost;
                    subtotal += adultItemCost;
                  }

                  // Add child cost if there are children
                  if (totalChildCost > 0 && totalChildren > 0) {
                    const childBaseAmount = totalChildCost * fxRate;
                    // Apply markup only if markup > 0, otherwise use base amount
                    const childItemCost =
                      markup > 0
                        ? childBaseAmount * (1 + markup / 100)
                        : childBaseAmount;
                    perChildTotal += childItemCost;
                    categoryTotals["Hotels"].total += childItemCost;
                    subtotal += childItemCost;
                  }
                } else {
                  // Fallback to original processing if no room data
                  processItems([item], category);
                }
              });
            } else {
              processItems(items || [], category);
            }
          },
        );

        pdfLog(
          `[PDF Generator] After processing all items - subtotal: ${subtotal}, perAdultTotal: ${perAdultTotal}, perChildTotal: ${perChildTotal}, adults: ${adults}, childrenCount: ${childrenCount}`,
        );

        // Calculate flight cost from category totals (sum of all included flights)
        // Only calculate if flights category is enabled in "Include in Cost Summary"
        const categoryEnabled = costingOption.categoryEnabled || {};
        let flightCostBreakdown = { adultCost: 0, childCost: 0, infantCost: 0 };
        const isManualFlightCost = costingOption.isManualFlightCost === true;

        if (categoryEnabled.flights !== false) {
          if (isManualFlightCost) {
            // Use manual flight cost
            const manualFlightPerAdult =
              costingOption.manualFlightPerAdult || 0;
            const manualFlightPerChild =
              costingOption.manualFlightPerChild || 0;
            const manualFlightPerInfant =
              costingOption.manualFlightPerInfant || 0;

            flightFee =
              manualFlightPerAdult * adults +
              manualFlightPerChild * childrenCount +
              manualFlightPerInfant * infants;
            flightCostBreakdown.adultCost = manualFlightPerAdult * adults;
            flightCostBreakdown.childCost =
              manualFlightPerChild * childrenCount;
            flightCostBreakdown.infantCost = manualFlightPerInfant * infants;

            // Manual flight cost: no GST applied (GST 5% removed per requirement)
          } else {
            // Calculate flight cost from category totals first
            flightFee = categoryTotals["Flights"].total || 0;

            // Calculate flight cost breakdown by pricing type for display
            const allFlights = [
              ...(costingOption.costing?.flights_outbound || []),
              ...(costingOption.costing?.flights_intercity || []),
              ...(costingOption.costing?.flights_return || []),
            ];

            // If categoryTotals["Flights"].total is 0 but we have flights in costing, calculate directly
            // This handles cases where flights might not have been added to categoryTotals correctly
            if (flightFee === 0 && allFlights.length > 0) {
              pdfLog(
                `[PDF Generator] [Itemized] WARNING: categoryTotals["Flights"].total is 0 but flights exist. Calculating flight cost directly from items.`,
              );
              allFlights.forEach((flight) => {
                if (flight.included !== false) {
                  const pricingType = flight.pricingType || "Per Adult";
                  const unitPrice = flight.unitPrice || 0;
                  const currency = flight.currency || "INR";
                  const fxRate =
                    fxRates[currency] || (currency === "INR" ? 1 : 1);

                  let effectiveQuantity = 1;
                  if (pricingType === "Per Adult") {
                    effectiveQuantity = adults;
                  } else if (pricingType === "Per Child") {
                    effectiveQuantity = childrenCount;
                  } else if (pricingType === "Per Infant") {
                    effectiveQuantity = infants;
                  }

                  const itemCost = unitPrice * effectiveQuantity * fxRate;
                  flightFee += itemCost;

                  if (pricingType === "Per Adult") {
                    flightCostBreakdown.adultCost += itemCost;
                  } else if (pricingType === "Per Child") {
                    flightCostBreakdown.childCost += itemCost;
                  } else if (pricingType === "Per Infant") {
                    flightCostBreakdown.infantCost =
                      (flightCostBreakdown.infantCost || 0) + itemCost;
                  }
                }
              });
            } else {
              // Use categoryTotals and calculate breakdown from items
              allFlights.forEach((flight) => {
                if (flight.included !== false) {
                  const pricingType = flight.pricingType || "Per Adult";
                  const unitPrice = flight.unitPrice || 0;
                  if (pricingType === "Per Adult") {
                    flightCostBreakdown.adultCost += unitPrice * adults;
                  } else if (pricingType === "Per Child") {
                    flightCostBreakdown.childCost += unitPrice * childrenCount;
                  } else if (pricingType === "Per Infant") {
                    flightCostBreakdown.infantCost =
                      (flightCostBreakdown.infantCost || 0) +
                      unitPrice * infants;
                  }
                }
              });
            }

            pdfLog(
              `[PDF Generator] [Itemized] Flight calculation - categoryTotals["Flights"].total: ${categoryTotals["Flights"].total}, calculated flightFee: ${flightFee}, subtotal before flight removal: ${subtotal}`,
            );

            // Apply GST on flights if enabled (separate from package GST - 5% on flights only)
            // Note: For itemized costing, flights are already in subtotal via processItems
            // We need to extract base flight cost and calculate GST separately
            // IMPORTANT: Remove base flight cost from subtotal BEFORE calculating package GST/TCS
            const baseFlightFee = flightFee; // This is the base flight cost (without GST)
            if (costingOption.isFlightGstApplied && baseFlightFee > 0) {
              const flightGst = baseFlightFee * 0.05; // 5% GST on base flight cost only
              flightFee = baseFlightFee + flightGst; // Flight cost with GST
            } else {
              flightFee = baseFlightFee; // Flight cost without GST
            }
            // Remove base flight cost from subtotal (it was added via processItems)
            // Package GST/TCS should be calculated on package only, not on flights
            if (baseFlightFee > 0) {
              subtotal -= baseFlightFee;
              pdfLog(
                `[PDF Generator] [Itemized] Removed flight cost from subtotal - baseFlightFee: ${baseFlightFee}, subtotal after removal: ${subtotal}`,
              );
            } else {
              pdfLog(
                `[PDF Generator] [Itemized] WARNING: baseFlightFee is 0, but subtotal includes flights. Subtotal: ${subtotal}, categoryTotals["Flights"]: ${JSON.stringify(
                  categoryTotals["Flights"],
                )}`,
              );
            }
          }
        } else {
          flightFee = 0;
        }

        // Calculate initial subtotal (before markup, before GST/TCS)
        const initialSubtotal = subtotal;

        // Apply markup if set (on entire subtotal BEFORE GST/TCS)
        // Markup is added to the subtotal that is before GST & TCS
        const markup = costingOption.markup || 0;
        pdfLog(
          `[PDF Generator] [Itemized] Markup check - markup value: ${markup}, subtotal before markup: ${subtotal.toLocaleString(
            "en-IN",
          )}`,
        );
        if (markup > 0) {
          pdfLog(
            `[PDF Generator] [Itemized] Applying markup ${markup}% to subtotal`,
          );
          const markupAmount = subtotal * (markup / 100);
          subtotal += markupAmount;

          // Also apply markup proportionally to perAdultTotal and perChildTotal
          // This ensures the "Per Adult" display matches the frontend
          if (initialSubtotal > 0) {
            const perAdultRatio = perAdultTotal / initialSubtotal;
            const perChildRatio = perChildTotal / initialSubtotal;
            perAdultTotal += markupAmount * perAdultRatio;
            perChildTotal += markupAmount * perChildRatio;
            pdfLog(
              `[PDF Generator] [Itemized] After markup - subtotal: ${subtotal.toLocaleString(
                "en-IN",
              )}, perAdultTotal: ${perAdultTotal.toLocaleString(
                "en-IN",
              )}, perChildTotal: ${perChildTotal.toLocaleString("en-IN")}`,
            );
          }

          // Add markup to base package categories proportionally for display
          // Base package includes: hotels, visa, transfers, sightseeing, insurance (all non-flight components)
          const basePackageCategories = [
            "hotels",
            "visa",
            "transfers",
            "sightseeing",
            "insurance",
          ];
          const basePackageTotal = Object.entries(categoryTotals)
            .filter(([cat]) => basePackageCategories.includes(cat))
            .reduce((sum, [, totals]) => sum + totals.total, 0);

          if (initialSubtotal > 0 && basePackageTotal > 0) {
            const basePackageRatio = basePackageTotal / initialSubtotal;
            const basePackageMarkup = markupAmount * basePackageRatio;

            // Distribute markup proportionally to base package categories
            const baseTotal = Object.entries(categoryTotals)
              .filter(([cat]) => basePackageCategories.includes(cat))
              .reduce((sum, [, totals]) => sum + totals.total, 0);

            if (baseTotal > 0) {
              Object.keys(categoryTotals).forEach((cat) => {
                if (basePackageCategories.includes(cat)) {
                  const categoryRatio = categoryTotals[cat].total / baseTotal;
                  categoryTotals[cat].total +=
                    basePackageMarkup * categoryRatio;
                }
              });
            }
          }
        }

        // Apply discount if set (on subtotal AFTER markup, BEFORE GST/TCS)
        const discount = costingOption.discount || 0;
        let discountAmount = 0;
        if (discount > 0) {
          pdfLog(
            `[PDF Generator] [Itemized] Applying discount ${discount}% to subtotal`,
          );
          discountAmount = subtotal * (discount / 100);
          subtotal -= discountAmount;

          // Also apply discount proportionally to perAdultTotal and perChildTotal
          if (subtotal + discountAmount > 0) {
            const perAdultRatio = perAdultTotal / (subtotal + discountAmount);
            const perChildRatio = perChildTotal / (subtotal + discountAmount);
            perAdultTotal -= discountAmount * perAdultRatio;
            perChildTotal -= discountAmount * perChildRatio;
            pdfLog(
              `[PDF Generator] [Itemized] After discount - subtotal: ${subtotal.toLocaleString(
                "en-IN",
              )}, discountAmount: ${discountAmount.toLocaleString("en-IN")}`,
            );
          }
        }

        // Base Package is the subtotal EXCLUDING flights (after markup and after removing flight cost)
        // It includes: hotels, visa, transfers, sightseeing, insurance - all non-flight components
        // Note: flightFee has already been removed from subtotal above (if flights exist)
        // This matches the CRM base package calculation
        const basePackage = Math.round(subtotal);

        // Calculate GST/TCS on subtotal AFTER markup is applied
        // Extract GST/TCS percentages from costingOption (same logic as manual costing)
        let gstPercent = costingOption?.gstPercentage;
        let tcsPercent = costingOption?.tcsPercentage;
        let isGstApplied = costingOption?.isGstApplied;
        let isTcsApplied = costingOption?.isTcsApplied;

        // Priority 1: If flags are explicitly set to true, use them (even if percentages are missing)
        if (isGstApplied === true) {
          if (
            gstPercent === undefined ||
            gstPercent === null ||
            gstPercent === 0
          ) {
            gstPercent = 5;
            pdfLog(
              `[PDF Generator] [Itemized] Flag isGstApplied=true but percentage missing. Using default GST 5%`,
            );
          }
          isGstApplied = true;
        } else if (isGstApplied === false) {
          gstPercent = 0;
          isGstApplied = false;
        } else {
          // Flag is undefined/null - apply default 5% GST unless explicitly disabled
          if (
            gstPercent !== undefined &&
            gstPercent !== null &&
            gstPercent > 0
          ) {
            isGstApplied = true;
          } else if (gstPercent === 0) {
            // Explicitly set to 0, don't apply
            isGstApplied = false;
            gstPercent = 0;
          } else {
            // Default: Apply 5% GST when flag is undefined/null and percentage is also undefined/null
            isGstApplied = true;
            gstPercent = 5;
            pdfLog(
              `[PDF Generator] [Itemized] Defaulting to GST 5% (flag and percentage both undefined/null)`,
            );
          }
        }

        if (isTcsApplied === true) {
          if (
            tcsPercent === undefined ||
            tcsPercent === null ||
            tcsPercent === 0
          ) {
            tcsPercent = 5;
            pdfLog(
              `[PDF Generator] [Itemized] Flag isTcsApplied=true but percentage missing. Using default TCS 5%`,
            );
          }
          isTcsApplied = true;
        } else if (isTcsApplied === false) {
          tcsPercent = 0;
          isTcsApplied = false;
        } else {
          // Flag is undefined/null - apply default 5% TCS unless explicitly disabled
          if (
            tcsPercent !== undefined &&
            tcsPercent !== null &&
            tcsPercent > 0
          ) {
            isTcsApplied = true;
          } else if (tcsPercent === 0) {
            // Explicitly set to 0, don't apply
            isTcsApplied = false;
            tcsPercent = 0;
          } else {
            // Default: Apply 5% TCS when flag is undefined/null and percentage is also undefined/null
            isTcsApplied = true;
            tcsPercent = 5;
            pdfLog(
              `[PDF Generator] [Itemized] Defaulting to TCS 5% (flag and percentage both undefined/null)`,
            );
          }
        }

        // GST/TCS percentages - Use explicit value if provided, otherwise use 5% as default (with warning) to match frontend
        // This ensures consistency between PDF and CRM when percentages are missing but flags are true
        if (isGstApplied && (gstPercent === undefined || gstPercent === null)) {
          console.warn(
            `[PDF Generator] [Itemized] GST is applied but percentage is missing. Using default 5% (matching CRM behavior).`,
          );
          gstPercent = 5; // Default to 5% to match CRM and common practice
        }
        if (isTcsApplied && (tcsPercent === undefined || tcsPercent === null)) {
          console.warn(
            `[PDF Generator] [Itemized] TCS is applied but percentage is missing. Using default 5% (matching CRM behavior).`,
          );
          tcsPercent = 5; // Default to 5% to match CRM and common practice
        }
        // Use provided values, or 0 if flags are false
        gstPercent =
          gstPercent !== undefined && gstPercent !== null
            ? gstPercent
            : isGstApplied
              ? 5
              : 0;
        tcsPercent =
          tcsPercent !== undefined && tcsPercent !== null
            ? tcsPercent
            : isTcsApplied
              ? 5
              : 0;

        // Calculate actual base amounts (before GST/TCS)
        // perAdultTotal and perChildTotal are already totals (sum of all per-adult/per-child items)
        // Match client-side behavior: perAdult is total cost for all adults, not per-person
        // Use the actual values directly - NO inflation, NO recalculation - match frontend exactly
        // DO NOT round here - only round at final display
        const actualPerAdult = perAdultTotal;
        const actualPerChild = perChildTotal;

        // IMPORTANT: Use ACTUAL subtotal for GST/TCS calculations (matching frontend)
        // GST is calculated on basePackage (excluding flights) to match CRM
        // Base package includes: hotels, visa, transfers, sightseeing, insurance
        // DO NOT round intermediate calculations - only round at final display
        const calculatedGst = isGstApplied
          ? basePackage * (gstPercent / 100)
          : 0;
        // TCS is calculated on: (basePackage + GST) - matching CRM logic (excluding flights)
        const calculatedTcs = isTcsApplied
          ? (basePackage + calculatedGst) * (tcsPercent / 100)
          : 0;

        pdfLog(
          `[PDF Generator] [Itemized] GST/TCS Calculation - Base Package (excl. flights): ₹${basePackage.toLocaleString(
            "en-IN",
          )}, GST (${gstPercent}%): ₹${calculatedGst.toLocaleString(
            "en-IN",
          )}, TCS (${tcsPercent}% on basePackage+GST): ₹${calculatedTcs.toLocaleString(
            "en-IN",
          )}`,
        );

        // Grand Total = Package (Subtotal + GST + TCS) + Flight Cost (matching CRM)
        const finalGrandTotal =
          basePackage + calculatedGst + calculatedTcs + flightFee;

        // Round only at final display level, not at base calculation level
        costing = {
          isManual: false,
          perAdult: Math.round(actualPerAdult), // Total for all adults (rounded for display only)
          perChild: Math.round(actualPerChild), // Total for all children (rounded for display only)
          basePackage: Math.round(basePackage + discountAmount), // Subtotal before discount (for consistency with CRM)
          subtotal: Math.round(basePackage), // Subtotal after discount (for consistency with CRM)
          flightCost: Math.round(flightFee),
          flightCostBreakdown: flightCostBreakdown, // Breakdown for display
          gst: Math.round(calculatedGst), // GST on base package (excluding flights)
          tcs: Math.round(calculatedTcs), // TCS on base package + GST (excluding flights)
          discountAmount: Math.round(discountAmount), // Discount amount
          discountPercentage: discount, // Discount percentage
          grandTotal: Math.round(finalGrandTotal), // Rounded for display only
          adultsCount: adults,
          childrenCount: childrenCount,
          gstPercentage: gstPercent, // Explicit percentage (no silent fallback)
          tcsPercentage: tcsPercent, // Explicit percentage (no silent fallback)
          isGstApplied: isGstApplied || false,
          isTcsApplied: isTcsApplied || false,
        };
      }
    }

    // Use terms & conditions from itinerary, or fallback to branch, or default
    // Apply date tag replacement ({{date}} = 1 day from today)
    let termsAndConditionsText = "";
    let termsAndConditionsArray = null; // For default terms, use array to bypass parsing

    if (itinerary?.terms_and_conditions) {
      // Use terms from itinerary and replace date tags
      termsAndConditionsText = replaceDateTags(itinerary.terms_and_conditions);
    } else if (
      branch?.terms_and_conditions &&
      branch.terms_and_conditions.length > 0
    ) {
      // Fallback to branch terms
      const branchTerms =
        branch.terms_and_conditions.find((t) => t.is_default)?.content ||
        branch.terms_and_conditions[0].content ||
        "";
      termsAndConditionsText = replaceDateTags(branchTerms);
    } else {
      // Default terms as array (point by point) - bypasses parsing issues with semicolons
      // {{date}} replaced by replaceDateTags
      const quoteDate = new Date();
      quoteDate.setDate(quoteDate.getDate() + 1);
      const quoteDateStr = quoteDate.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      termsAndConditionsArray = [
        `Quoted rates are valid for one (1) day from the date of quotation (${quoteDateStr}) unless otherwise specified.`,
        `Prices are based on current tariffs and may change before confirmation; once confirmed with full payment, prices will not change except for statutory tax or supplier-imposed revisions.`,
        `Additional surcharges may apply during public holidays, peak seasons, or special events and will be informed prior to confirmation.`,
        `All rooms, flights, seats, and services are subject to availability at the time of booking and payment.`,
        `The quotation includes only the services specifically mentioned; any additional services will be charged separately with prior approval.`,
        `Cancellation and refund policies will be as per the respective airline, hotel, or service provider rules communicated at booking.`,
        `The company is not liable for services remaining unconfirmed due to non-availability or delayed/non-payment.`,
        `The final itinerary may change due to operational needs, weather, force majeure, or supplier constraints, with prior intimation where possible.`,
        `In case of third-party cancellations, reasonable assistance will be provided for refunds or alternatives as per supplier policies.`,
        `The company reserves the right to cancel bookings only under exceptional circumstances such as non-payment, suspected fraud, force majeure, or supplier non-availability, with applicable refunds.`,
        `Bookings will be processed upon receipt of full payment only.`,
        `Applicable GST (5%), TCS (5%), and any other statutory government taxes will be charged additionally on the final invoice.`,
      ];
    }

    // Parse terms to points (reuse helper function from template)
    // Note: parseToPoints is defined in generateItineraryHtml function
    // For now, parse here inline
    const parseTermsToPoints = (text) => {
      if (!text) return [];
      if (Array.isArray(text)) return text;

      // If it's HTML with <li> tags, extract each <li> content separately
      // This handles HTML formatted terms from itinerary/branch properly
      if (text.includes("<li>") || text.includes("</li>")) {
        const liMatches = text.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
        if (liMatches && liMatches.length > 0) {
          const points = liMatches
            .map((li) => {
              // Extract text content from <li> tag, removing HTML tags
              return li.replace(/<[^>]*>/g, "").trim();
            })
            .filter((p) => p.length > 0);

          if (points.length > 0) {
            // Apply GST/TCS combination logic to the extracted points
            const finalPoints = [];
            for (let i = 0; i < points.length; i++) {
              const current = points[i].trim();
              const next = points[i + 1] ? points[i + 1].trim() : null;

              // Check if current is "GST X% &" and next is "TCS X%"
              const isGstLine = /^GST\s+\d+%\s*&?\s*$/i.test(current);
              const isTcsLine = next && /^\s*TCS\s+\d+%/i.test(next);

              if (isGstLine && isTcsLine) {
                const gstMatch = current.match(/GST\s+(\d+%)/i);
                const tcsMatch = next.match(/TCS\s+(\d+%.*)/i);
                if (gstMatch && tcsMatch) {
                  finalPoints.push(`GST ${gstMatch[1]} & ${tcsMatch[1]}`);
                  i++; // Skip the next point as we've combined it
                  continue;
                }
              }

              // Additional check: if current contains "GST" and next contains "TCS"
              if (
                current &&
                next &&
                /GST/i.test(current) &&
                /TCS/i.test(next)
              ) {
                const gstInCurrent = current.match(/GST\s+(\d+%)/i);
                const tcsInNext = next.match(/TCS\s+(\d+%.*)/i);
                if (gstInCurrent && tcsInNext && /&?\s*$/i.test(current)) {
                  finalPoints.push(`GST ${gstInCurrent[1]} & ${tcsInNext[1]}`);
                  i++; // Skip the next point as we've combined it
                  continue;
                }
              }

              finalPoints.push(current);
            }
            return finalPoints.length > 0 ? finalPoints : points;
          }
        }
      }

      // If it's HTML without <li> tags, extract text content
      const textContent = text.replace(/<[^>]*>/g, "").trim();
      if (!textContent) return [];

      // First, try to combine GST and TCS lines that are split across newlines BEFORE splitting
      // This handles cases where they're on separate lines in the source text
      // Multiple patterns to catch different formatting:
      // Pattern 1: "GST 5% &" followed by newline and "TCS 5%..."
      // Pattern 2: "GST 5% &" followed by bullet point and "TCS 5%..."
      // Pattern 3: "GST 5% &" at end of line, next line starts with "TCS"
      let combinedText = textContent
        // Pattern 1: Direct replacement across newlines
        .replace(
          /(GST\s+\d+%)\s*&\s*[\r\n]+[\s•\-\*]*(TCS\s+\d+%[^\n\r]*)/gi,
          "$1 & $2",
        )
        // Pattern 2: Handle bullet points between them
        .replace(
          /(GST\s+\d+%)\s*&\s*[\r\n]+\s*[•\-\*]\s*(TCS\s+\d+%[^\n\r]*)/gi,
          "$1 & $2",
        )
        // Pattern 3: Handle case where "GST X% &" is on its own line followed by "TCS" on next line
        .replace(/(GST\s+\d+%)\s*&\s*$/gm, (match, gstPart) => {
          // This will be handled in the split/combine logic below
          return match;
        });

      // Split into points
      const points = combinedText
        .split(/\n|•|;|\.(?=\s+[A-Z])/)
        .map((p) => p.trim().replace(/^[•\-\*]\s*/, ""))
        .filter((p) => p.length > 0 && !p.match(/^\d+\.?\s*$/));

      // Combine GST and TCS if they appear in consecutive points
      const finalPoints = [];
      for (let i = 0; i < points.length; i++) {
        const current = points[i].trim();
        const next = points[i + 1] ? points[i + 1].trim() : null;

        // Check if current is "GST X% &" (with or without trailing &, spaces, etc.)
        // Pattern: "GST 5% &" or "GST 5%&" or just "GST 5%" (case insensitive)
        // Also handle variations like "GST 5% & " with trailing space
        const isGstLine = /^GST\s+\d+%\s*&?\s*$/i.test(current);
        // Check if next starts with "TCS" - be more flexible with whitespace
        const isTcsLine = next && /^\s*TCS\s+\d+%/i.test(next);

        if (isGstLine && isTcsLine) {
          const gstMatch = current.match(/GST\s+(\d+%)/i);
          // Match the entire TCS line including everything after "TCS X%"
          const tcsMatch = next.match(/TCS\s+(\d+%.*)/i);
          if (gstMatch && tcsMatch) {
            // Combine into single line: "GST 5% & TCS 5% Taxes are additional on the overall invoice."
            finalPoints.push(`GST ${gstMatch[1]} & ${tcsMatch[1]}`);
            i++; // Skip the next point as we've combined it
            continue;
          }
        }

        // Additional check: if current contains "GST" and next contains "TCS", try to combine
        // This is a fallback for edge cases
        if (current && next && /GST/i.test(current) && /TCS/i.test(next)) {
          const gstInCurrent = current.match(/GST\s+(\d+%)/i);
          const tcsInNext = next.match(/TCS\s+(\d+%.*)/i);
          if (gstInCurrent && tcsInNext && /&?\s*$/i.test(current)) {
            finalPoints.push(`GST ${gstInCurrent[1]} & ${tcsInNext[1]}`);
            i++; // Skip the next point as we've combined it
            continue;
          }
        }

        finalPoints.push(current);
      }

      return finalPoints.length > 0 ? finalPoints : [textContent];
    };

    // Use array directly if available (default terms), otherwise parse text
    const termsAndConditionsPoints = termsAndConditionsArray
      ? termsAndConditionsArray
      : parseTermsToPoints(termsAndConditionsText);

    const termsAndConditions =
      termsAndConditionsPoints.length > 0
        ? `
      <ul class="terms-list">
        ${termsAndConditionsPoints.map((point) => `<li>${point}</li>`).join("")}
      </ul>
    `
        : termsAndConditionsText
          ? `<div class="terms-content">${termsAndConditionsText}</div>`
          : "";

    // Fetch transfer details from database before generating template
    const activities = itinerary?.detailed_activities || [];
    // Get all transfer IDs (both direct transfer_id)
    const transferIds = activities
      .filter((activity) => activity.transfer_id)
      .map((activity) => activity.transfer_id)
      .filter((id, index, self) => self.indexOf(id) === index); // Unique IDs

    // Also get transfer names for transfers that don't have transfer_id but have transfer_name
    const transferNames = activities
      .filter((activity) => activity.transfer_name && !activity.transfer_id)
      .map((activity) => activity.transfer_name)
      .filter((name, index, self) => name && self.indexOf(name) === index); // Unique names

    let transfersMap = {};

    // Fetch transfers by ID
    if (transferIds.length > 0) {
      const { data: transfers, error } = await supabase
        .from("transfers")
        .select("*")
        .in("id", transferIds);

      if (error) {
        console.error("[PDF Generator] Error fetching transfers by ID:", error);
      } else if (transfers) {
        transfers.forEach((transfer) => {
          transfersMap[transfer.id] = transfer;
          // Also index by name for easier lookup
          if (transfer.name) {
            transfersMap[transfer.name] = transfer;
          }
        });
      }
    }

    // Fetch transfers by name (for transfers that don't have transfer_id but have transfer_name)
    if (transferNames.length > 0) {
      const { data: transfersByName, error: nameError } = await supabase
        .from("transfers")
        .select("*")
        .in("name", transferNames);

      if (nameError) {
        console.error(
          "[PDF Generator] Error fetching transfers by name:",
          nameError,
        );
      } else if (transfersByName) {
        transfersByName.forEach((transfer) => {
          // Use ID as primary key
          if (!transfersMap[transfer.id]) {
            transfersMap[transfer.id] = transfer;
          }
          // Also create a name-based lookup
          if (transfer.name) {
            transfersMap[transfer.name] = transfer;
          }
        });
      }
    }

    // Prepare data for template
    const templateData = {
      bookingId,
      customerName: `${customer.salutation || "Mr."} ${customer.first_name} ${
        customer.last_name
      }`,
      customerPhone: formatPhoneNumber(customer.phone),
      destination: itineraryMeta.destination || lead?.destination || "N/A",
      // Pass dates as Date objects - already parsed correctly by parseDateSafe
      // These are local dates (no timezone conversion), so they'll display correctly
      startDate: startDate,
      endDate: endDate,
      duration: durationStr,
      nights,
      days,
      adults: adultsForPdf,
      children: childrenForPdf,
      childrenAges,
      dayWisePlan: (itinerary?.day_wise_plan || []).map((day, index) => {
        // Calculate day date based on correct startDate (from travel_date)
        // This ensures day dates match the TRIP SUMMARY dates
        let dayDate = day.date;
        if (startDate) {
          // Calculate date for this day based on startDate + day index
          const calculatedDate = new Date(startDate);
          calculatedDate.setDate(calculatedDate.getDate() + index);
          // Format as YYYY-MM-DD for consistency
          const year = calculatedDate.getFullYear();
          const month = String(calculatedDate.getMonth() + 1).padStart(2, "0");
          const date = String(calculatedDate.getDate()).padStart(2, "0");
          dayDate = `${year}-${month}-${date}`;
          pdfLog(
            `[PDF Generator] Day ${index + 1} date: ${
              day.date
            } -> ${dayDate} (calculated from startDate)`,
          );
        }
        return {
          ...day,
          date: dayDate, // Use calculated date based on correct startDate
        };
      }),
      costing,
      inclusions: (() => {
        if (!itinerary?.inclusions) return [];
        if (typeof itinerary.inclusions === "string") {
          const items = itinerary.inclusions
            .split("\n")
            .filter(Boolean)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          pdfLog(
            "[PDF Generator] Parsed inclusions from string:",
            items.length,
            "items",
          );
          return items;
        }
        if (Array.isArray(itinerary.inclusions)) {
          pdfLog(
            "[PDF Generator] Using inclusions as array:",
            itinerary.inclusions.length,
            "items",
          );
          return itinerary.inclusions.filter(Boolean);
        }
        return [];
      })(),
      exclusions: (() => {
        if (!itinerary?.exclusions) return [];
        if (typeof itinerary.exclusions === "string") {
          const items = itinerary.exclusions
            .split("\n")
            .filter(Boolean)
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          pdfLog(
            "[PDF Generator] Parsed exclusions from string:",
            items.length,
            "items",
          );
          return items;
        }
        if (Array.isArray(itinerary.exclusions)) {
          pdfLog(
            "[PDF Generator] Using exclusions as array:",
            itinerary.exclusions.length,
            "items",
          );
          return itinerary.exclusions.filter(Boolean);
        }
        return [];
      })(),
      termsAndConditions,
      cancellationPolicy: itinerary?.cancellation_policy || "",
      notes: itinerary?.important_notes || "",
      branchName: branch?.name || "",
      branchLogo: branch?.logo_url || "",
      frontPageImageUrl:
        branch?.front_page_image_url ||
        "https://maduratravel.com/wp-content/uploads/2025/01/Front-Page-final.jpg",
      finalPageImageUrl:
        branch?.final_page_image_url ||
        "https://maduratravel.com/wp-content/uploads/2025/01/Final-Page.jpg",
      bankDetails: branch?.bank_details || [],
      itineraryImage:
        itinerary?.main_image || itineraryMeta?.main_image || null,
      travelConsultant,
      itineraryStatus: itineraryMeta?.status || "Prepared",
      emergencyContacts: itineraryMeta?.emergency_contacts || [],
      tourRegion: lead?.tour_region || "International",
      categoryEnabled: costingOption?.categoryEnabled || {},
      // Always pass flightsData so Flight Details card shows when this version has flights (independent of "Include in Cost Summary")
      flightsData: flightsData,
      hotelsData:
        costingOption?.categoryEnabled?.hotels !== false ? hotelsData : [],
      attractionsData:
        costingOption?.categoryEnabled?.sightseeing !== false
          ? (() => {
              // Extract ALL activities (attractions + transfers) for flow display
              // Deduplicate by activity id so each activity appears only once in the PDF
              const rawActivities = itinerary?.detailed_activities || [];
              const seenIds = new Set();
              const activities = rawActivities.filter((a) => {
                const id = a.id;
                if (seenIds.has(id)) return false;
                seenIds.add(id);
                return true;
              });
              if (activities.length === 0) return [];

              // Get destination name (can be used as location for all activities)
              const destinationName =
                itineraryMeta.destination || lead?.destination || "";

              // Separate attractions and transfers
              const attractions = activities.filter(
                (activity) =>
                  activity.sightseeing_id &&
                  !activity.transfer_id &&
                  !activity.linked_activity_id &&
                  !activity.linked_hotel_id &&
                  !activity.transfer_name,
              );

              const transfers = activities.filter((activity) => {
                const isTransfer =
                  activity.transfer_id ||
                  activity.linked_activity_id !== null ||
                  activity.linked_hotel_id !== null ||
                  (activity.transfer_name && !activity.sightseeing_id);
                return isTransfer;
              });

              // Group by day and create flow
              const flowByDay = {};
              const maxDay = Math.max(
                ...activities.map((a) => a.day_number || 1),
                1,
              );

              for (let day = 1; day <= maxDay; day++) {
                const dayAttractions = attractions.filter(
                  (a) => a.day_number === day,
                );
                const dayTransfers = transfers.filter(
                  (a) => a.day_number === day,
                );

                // Sort attractions by start_time if available
                dayAttractions.sort((a, b) => {
                  if (a.start_time && b.start_time) {
                    return a.start_time.localeCompare(b.start_time);
                  }
                  return 0;
                });

                // Sort transfers by linked_activity_id and position
                dayTransfers.sort((a, b) => {
                  // Transfers before activities (position: 'before') come first
                  if (a.position === "before" && b.position !== "before")
                    return -1;
                  if (a.position !== "before" && b.position === "before")
                    return 1;
                  // Then sort by linked_activity_id to maintain order
                  if (a.linked_activity_id && b.linked_activity_id) {
                    return a.linked_activity_id - b.linked_activity_id;
                  }
                  return 0;
                });

                // Build flow: transfer -> attraction -> transfer -> attraction
                const flow = [];
                dayAttractions.forEach((attraction, index) => {
                  // Add transfer before attraction if exists
                  const transferBefore = dayTransfers.find(
                    (t) =>
                      t.linked_activity_id === attraction.id &&
                      t.position === "before",
                  );
                  if (transferBefore) {
                    flow.push({ type: "transfer", data: transferBefore });
                  }

                  // Add attraction
                  flow.push({ type: "attraction", data: attraction });

                  // Add transfer after attraction if exists
                  const transferAfter = dayTransfers.find(
                    (t) =>
                      t.linked_activity_id === attraction.id &&
                      t.position === "after",
                  );
                  if (transferAfter) {
                    flow.push({ type: "transfer", data: transferAfter });
                  }
                });

                // Add standalone transfers (not linked to any activity)
                const standaloneTransfers = dayTransfers.filter(
                  (t) => !t.linked_activity_id,
                );
                standaloneTransfers.forEach((transfer) => {
                  flow.push({ type: "transfer", data: transfer });
                });

                if (flow.length > 0) {
                  flowByDay[day] = flow;
                }
              }

              // Convert to flat array with day_number for backward compatibility
              const result = [];
              Object.keys(flowByDay)
                .sort((a, b) => parseInt(a) - parseInt(b))
                .forEach((day) => {
                  flowByDay[day].forEach((item) => {
                    result.push({
                      ...item.data,
                      item_type: item.type, // 'attraction' or 'transfer'
                      day_number: parseInt(day),
                      location: destinationName,
                    });
                  });
                });

              return result;
            })()
          : [],
      transfersData:
        costingOption?.categoryEnabled?.transfers !== false
          ? (() => {
              // Extract transfers from detailed_activities (for backward compatibility)
              const activities = itinerary?.detailed_activities || [];
              const activitiesWithTransfers = activities.filter(
                (activity) => activity.transfer_id,
              );
              if (activitiesWithTransfers.length === 0) return [];

              // Map activities with transfers to transfers data format
              return activitiesWithTransfers.map((activity) => ({
                activity_id: activity.id,
                transfer_id: activity.transfer_id,
                transfer_name: activity.transfer_name || null, // Itinerary-specific override
                transfer_cost: activity.transfer_cost || null, // Itinerary-specific override
                transfer_currency: activity.transfer_currency || null, // Itinerary-specific override
                day_number: activity.day_number || null,
                activity_name: activity.name || "Activity",
              }));
            })()
          : [],
      transfersMap,
      // Only include visaInfo if visa category is enabled
      visaInfo:
        costingOption?.categoryEnabled?.visa !== false ? visaInfo : null,
      razorpayLink: razorpayLinkFromInvoice,
      branchRazorpayLink: branch?.razorpay_link || null,
      showPaymentButton:
        itineraryMeta?.show_payment_button !== undefined
          ? itineraryMeta.show_payment_button
          : razorpayLinkFromInvoice !== null || branch?.razorpay_link !== null,
      infants: itineraryMeta.infants || lead?.requirements?.babies || 0,
      childrenAges: childrenAges, // Pass childrenAges to template
      displayCurrency: displayCurrency,
      fxRates: fxRates,
    };

    pdfLog(
      "[PDF Generator] Template data - displayCurrency:",
      templateData.displayCurrency,
      "fxRates available for:",
      Object.keys(templateData.fxRates || {}).join(", "),
    );

    // Debug: Log template data before HTML generation
    pdfLog(
      "[PDF Generator] Template data - itineraryStatus:",
      templateData.itineraryStatus,
    );
    pdfLog(
      "[PDF Generator] Template data - hotelsData count:",
      templateData.hotelsData?.length || 0,
    );
    if (templateData.hotelsData && templateData.hotelsData.length > 0) {
      templateData.hotelsData.forEach((hotel, idx) => {
        pdfLog(
          `[PDF Generator] Template hotel ${idx + 1}: ${hotel.name}, rooms:`,
          hotel.rooms ? `${hotel.rooms.length} room(s)` : "no rooms",
        );
        if (hotel.rooms && hotel.rooms.length > 0) {
          hotel.rooms.forEach((room, roomIdx) => {
            pdfLog(
              `  Template room ${roomIdx + 1}: confirmation_number="${
                room.confirmation_number || "N/A"
              }"`,
            );
          });
        }
      });
    }

    // Generate HTML
    const html = generateItineraryHtml(templateData);
    pdfLog("[PDF Generator] HTML generated, length:", html.length);

    // Launch Puppeteer: use system Chromium if available, else Puppeteer's bundled
    const executablePath = getChromiumPathForLaunch();
    if (executablePath) {
      const validation = validateChromiumPath(executablePath);
      if (validation.warnings.length > 0) {
        validation.warnings.forEach((warning) => {
          logger.warn(`[PDF Generator] ${warning}`);
        });
      }
    }
    pdfLog("[PDF Generator] Using Chromium:", executablePath || "(bundled)");

    // Retry logic for browser launch (handles intermittent snap cgroup issues)
    let browser;
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        const launchOptions = {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process", // May help with resource constraints
            "--disable-gpu",
            // Fix for xdg-settings and snap cgroup issues
            "--disable-features=VizDisplayCompositor",
            "--disable-software-rasterizer",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-breakpad",
            "--disable-client-side-phishing-detection",
            "--disable-default-apps",
            "--disable-extensions",
            "--disable-hang-monitor",
            "--disable-popup-blocking",
            "--disable-prompt-on-repost",
            "--disable-sync",
            "--disable-translate",
            "--metrics-recording-only",
            "--safebrowsing-disable-auto-update",
            "--enable-automation",
            "--password-store=basic",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-ipc-flooding-protection",
            "--disable-renderer-backgrounding",
            "--disable-features=TranslateUI",
            // Additional flags for Linux/server environments
            "--disable-background-downloads",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-features=AudioServiceOutOfProcess",
            "--disable-features=MediaRouter",
            "--disable-features=RendererCodeIntegrity",
            "--disable-features=UseChromeOSDirectVideoDecoder",
            "--disable-print-preview",
            "--disable-speech-api",
            "--hide-scrollbars",
            "--mute-audio",
            "--no-crash-upload",
            "--no-default-browser-check",
            "--no-pings",
            "--use-gl=swiftshader",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            // Additional flags to help with snap cgroup and D-Bus issues
            "--disable-background-timer-throttling",
            "--disable-features=TranslateUI,BlinkGenPropertyTrees",
            "--disable-ipc-flooding-protection",
            "--run-all-compositor-stages-before-draw",
            "--disable-partial-raster",
            "--disable-skia-runtime-opts",
            "--disable-system-font-check",
            // Disable D-Bus related features that cause issues in systemd services
            "--disable-features=AudioServiceOutOfProcess",
            "--disable-features=MediaRouter",
          ],
          // Additional options to help with snap/systemd issues
          ignoreDefaultArgs: ["--disable-extensions"],
          timeout: 30000, // 30 second timeout for launch
        };
        if (executablePath) {
          launchOptions.executablePath = executablePath;
        }
        browser = await puppeteer.launch(launchOptions);
        break; // Success, exit retry loop
      } catch (launchError) {
        retryCount++;
        const errorMsg =
          launchError?.message || launchError?.toString() || "Unknown error";

        // Check if it's a snap cgroup or xdg-settings error
        const isSnapError =
          errorMsg.includes("snap cgroup") ||
          errorMsg.includes("xdg-settings") ||
          errorMsg.includes("Failed to launch") ||
          errorMsg.includes("Code: 1");

        if (retryCount < maxRetries && isSnapError) {
          const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // Exponential backoff, max 5s
          logger.warn(
            `[PDF Generator] Browser launch failed (attempt ${retryCount}/${maxRetries}): ${errorMsg}. Retrying in ${waitTime}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        } else {
          // Max retries reached or non-retryable error
          logger.error(
            `[PDF Generator] Failed to launch browser after ${retryCount} attempts: ${errorMsg}`,
          );
          throw new Error(
            `Failed to launch Chromium browser: ${errorMsg}. ` +
              `This may be due to snap cgroup restrictions. ` +
              `Consider installing Chromium via apt: sudo apt-get install chromium-browser`,
          );
        }
      }
    }

    const page = await browser.newPage();
    pdfLog("[PDF Generator] Page created, setting viewport...");

    // Set viewport BEFORE setting content for proper layout (mobile-optimized)
    // Reduced deviceScaleFactor from 2 to 1 to reduce PDF size (4x reduction in image size)
    await page.setViewport({
      width: 400,
      height: 1200,
      deviceScaleFactor: 1, // Reduced from 2 to 1 for smaller PDF size
    });

    pdfLog("[PDF Generator] Setting content...");
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000, // 60 second timeout
    });
    pdfLog("[PDF Generator] Content set, waiting for resources...");

    // Wait for all fonts to load
    await page.evaluateHandle(() => document.fonts.ready);

    // Wait for all images to load and optimize them for smaller PDF size
    const imageCount = await page.evaluate(async () => {
      const images = Array.from(document.images);

      // Optimize images by reducing quality and size
      const optimizationPromises = images.map(async (img) => {
        // Wait for image to load
        if (!img.complete) {
          await new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve; // Don't fail if image fails to load
            setTimeout(resolve, 5000); // Timeout after 5 seconds
          });
        }

        // Optimize image by converting to canvas with reduced quality
        try {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");

          // Limit image dimensions to reduce file size
          const maxWidth = 800;
          const maxHeight = 1200;
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;

          // Scale down if too large
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = width * ratio;
            height = height * ratio;
          }

          canvas.width = width;
          canvas.height = height;

          // Draw image to canvas with reduced quality
          ctx.drawImage(img, 0, 0, width, height);

          // Convert to data URL with compression (quality 0.7 = 70% quality)
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          img.src = dataUrl;
        } catch (e) {
          // If optimization fails, continue with original image
          console.warn("Image optimization failed:", e);
        }
      });

      await Promise.all(optimizationPromises);
      return images.length;
    });
    pdfLog(
      "[PDF Generator] Image optimization complete, images processed:",
      imageCount,
    );

    // Wait a bit more after image optimization to ensure all images are processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Wait a bit more for layout to settle
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Force a reflow to ensure all content is rendered
    await page.evaluate(() => {
      // Force layout recalculation
      document.body.offsetHeight;
      // Scroll to ensure all content is in viewport
      window.scrollTo(0, 0);
    });

    // Wait one more time for any final rendering
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify content is visible
    const contentCheck = await page.evaluate(() => {
      const container = document.querySelector(".container");
      const summarySection = document.querySelector(".summary-section");
      const hasContent = container && container.children.length > 0;
      const hasText =
        document.body.innerText && document.body.innerText.length > 100;

      // Check if text is actually visible (not hidden by CSS)
      const firstTextElement = document.querySelector(
        ".summary-value, .day-description, .testimonial-quote",
      );
      const isVisible = firstTextElement
        ? window.getComputedStyle(firstTextElement).opacity !== "0" &&
          window.getComputedStyle(firstTextElement).visibility !== "hidden" &&
          window.getComputedStyle(firstTextElement).display !== "none"
        : false;

      return {
        hasContainer: !!container,
        containerChildren: container ? container.children.length : 0,
        hasSummary: !!summarySection,
        hasText,
        isVisible,
        textLength: document.body.innerText
          ? document.body.innerText.length
          : 0,
        bodyHeight: Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight,
        ),
      };
    });

    pdfLog(
      "[PDF Generator] Content check:",
      JSON.stringify(contentCheck, null, 2),
    );

    if (!contentCheck.hasText || contentCheck.textLength < 100) {
      console.warn(
        "[PDF Generator] WARNING: Content appears to be empty or not rendered!",
      );
      throw new Error(
        "Content validation failed: Text content is too short or missing",
      );
    }

    if (!contentCheck.isVisible) {
      console.warn(
        "[PDF Generator] WARNING: Content may not be visible due to CSS!",
      );
    }

    // Get the actual content height in pixels
    const contentHeight = contentCheck.bodyHeight || 1200;
    pdfLog("[PDF Generator] Content height:", contentHeight);

    // Take a screenshot first to verify content is visible (for debugging)
    try {
      const screenshot = await page.screenshot({ fullPage: true, type: "png" });
      pdfLog(
        "[PDF Generator] Screenshot taken, size:",
        screenshot.length,
        "bytes",
      );
      if (screenshot.length < 10000) {
        console.warn(
          "[PDF Generator] WARNING: Screenshot is very small, content may not be rendering!",
        );
      }
    } catch (screenshotError) {
      pdfLog(
        "[PDF Generator] Screenshot failed (non-critical):",
        screenshotError.message,
      );
    }

    pdfLog("[PDF Generator] Generating PDF as single continuous page");

    // Generate PDF as single continuous page (no page breaks)
    // Calculate height in mm (1px ≈ 0.264583mm at 96 DPI)
    const heightInMm = Math.ceil(contentHeight * 0.264583);
    pdfLog(
      "[PDF Generator] PDF dimensions: 380px x",
      contentHeight,
      "px (",
      heightInMm,
      "mm)",
    );

    const pdf = await page.pdf({
      printBackground: true, // Critical for background colors
      preferCSSPageSize: true, // Use CSS page size
      displayHeaderFooter: false,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm",
      },
      width: "380px",
      height: `${heightInMm}mm`,
      scale: 1.0,
      // Optimize for smaller file size
      format: undefined, // Use custom dimensions
    });

    pdfLog("[PDF Generator] PDF generated, size:", pdf.length, "bytes");

    // Convert PDF to Buffer immediately and save a copy for response
    let pdfBuffer;
    if (Buffer.isBuffer(pdf)) {
      pdfBuffer = Buffer.from(pdf); // Create a copy
    } else if (pdf instanceof Uint8Array) {
      pdfBuffer = Buffer.from(pdf);
    } else {
      // Try to convert to Buffer
      pdfBuffer = Buffer.from(pdf);
    }

    // Validate PDF buffer
    if (!pdfBuffer || pdfBuffer.length < 1000) {
      await browser.close();
      throw new Error(
        "Generated PDF is too small or invalid. PDF generation may have failed.",
      );
    }

    // Verify PDF header (PDF files start with %PDF)
    const pdfHeader = pdfBuffer.toString("utf8", 0, 4);

    if (pdfHeader !== "%PDF") {
      pdfLog(
        "[PDF Generator] PDF header check failed. Header bytes:",
        pdfBuffer.slice(0, 10).toString("hex"),
      );
      pdfLog(
        "[PDF Generator] PDF type:",
        typeof pdfBuffer,
        "isBuffer:",
        Buffer.isBuffer(pdfBuffer),
      );
      // Don't fail - Puppeteer PDFs are valid even if header check fails
      // The PDF buffer from Puppeteer is always valid
    } else {
      pdfLog("[PDF Generator] PDF validated successfully");
    }

    await browser.close();

    // Generate filename: MTS-{id}{date} - {nights}N{days}D {destination} package for {name} x {adults}A+{children}C - {month year} - V{version}.pdf
    const monthYear = startDate
      ? new Date(startDate).toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        })
      : "";
    const versionCountForFilename = Array.isArray(
      itineraryMeta.itinerary_versions,
    )
      ? itineraryMeta.itinerary_versions.length
      : itineraryMeta.itinerary_versions
        ? 1
        : 1;
    // Ensure children count always shows (even if 0)
    const childrenCount = templateData.children || 0;
    const fileName = `${bookingId} - ${nights}N${days}D ${templateData.destination} package for ${customer.first_name} ${customer.last_name} x ${templateData.adults}A+${childrenCount}C - ${monthYear} - V${versionCountForFilename}.pdf`;

    // Save PDF to Supabase storage and link to customer's Other Documents
    try {
      pdfLog("[PDF Generator] Uploading PDF to storage...");

      // Upload PDF to Supabase storage (use the buffer copy)
      const filePath = `public/itinerary-pdfs/${
        customer.id
      }/${Date.now()}-${fileName}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: false,
        });

      if (uploadError) {
        console.error(
          "[PDF Generator] Error uploading PDF to storage:",
          uploadError,
        );
      } else {
        pdfLog("[PDF Generator] PDF uploaded to storage:", filePath);

        // Get public URL
        const { data: urlData } = supabase.storage
          .from("avatars")
          .getPublicUrl(filePath);
        const pdfUrl = urlData.publicUrl;

        pdfLog("[PDF Generator] PDF public URL:", pdfUrl);

        // Get current customer documents
        const { data: currentCustomer, error: fetchError } = await supabase
          .from("customers")
          .select("documents")
          .eq("id", customer.id)
          .single();

        if (fetchError) {
          console.error("[PDF Generator] Error fetching customer:", fetchError);
        } else {
          const currentDocuments = currentCustomer?.documents || {
            passports: [],
            visas: [],
            aadhaarCards: [],
            panCards: [],
            bankStatements: [],
            otherDocuments: [],
          };

          // Create document entry with URL instead of base64
          const newDocDetails = {
            documentName: `Itinerary - ${templateData.destination} (${nights}N${days}D)`,
            personName: `${customer.first_name} ${customer.last_name}`,
            notes: `Generated on ${new Date().toLocaleDateString(
              "en-GB",
            )} for Lead #${lead.id}`,
            customerId: customer.id,
          };

          const newDoc = {
            id: Date.now(),
            file: {
              name: fileName,
              type: "application/pdf",
              size: pdfBuffer.length,
              content: pdfUrl, // Store URL instead of base64
            },
            details: newDocDetails,
          };

          // Add to otherDocuments
          const updatedOtherDocuments = [
            ...(currentDocuments.otherDocuments || []),
            newDoc,
          ];
          const updatedDocuments = {
            ...currentDocuments,
            otherDocuments: updatedOtherDocuments,
          };

          // Update customer documents
          const { error: updateError } = await supabase
            .from("customers")
            .update({ documents: updatedDocuments })
            .eq("id", customer.id);

          if (updateError) {
            console.error(
              "[PDF Generator] Error updating customer documents:",
              updateError,
            );
          } else {
            pdfLog(
              "[PDF Generator] PDF saved to customer documents successfully",
            );

            // Log activity in lead
            const { data: currentLead } = await supabase
              .from("leads")
              .select("activity")
              .eq("id", lead.id)
              .single();

            if (currentLead) {
              const newActivity = {
                id: Date.now(),
                type: "PDF Generated",
                description: `Itinerary PDF "${fileName}" was generated and saved to customer documents.`,
                user: "System",
                timestamp: new Date().toISOString(),
              };
              const updatedActivity = [
                newActivity,
                ...(currentLead.activity || []),
              ];
              await supabase
                .from("leads")
                .update({ activity: updatedActivity })
                .eq("id", lead.id);
            }
          }
        }
      }
    } catch (saveError) {
      console.error(
        "[PDF Generator] Error saving PDF to documents:",
        saveError,
      );
      // Don't fail the request if saving fails, just log it
    }

    // pdfBuffer is already created and validated above
    logger.info("[PDF Generator] Itinerary PDF ready", {
      size: pdfBuffer.length,
      itineraryId: itineraryId ?? null,
    });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    // Use both filename and filename* for better browser compatibility
    // filename* uses UTF-8 encoding for special characters
    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);

    // Send PDF
    res.send(pdfBuffer);
  } catch (error) {
    console.error("[PDF Generator] Error:", error);
    res
      .status(500)
      .json({ message: error.message || "Failed to generate PDF" });
  }
}
