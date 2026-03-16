/**
 * Airport Import Script
 * 
 * This script imports popular airports from a public source into the database.
 * Run this once to populate the airports table with common airports.
 * 
 * Usage: node scripts/importAirports.js
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Popular airports data (can be expanded or fetched from external API)
const POPULAR_AIRPORTS = [
  // India
  { code: "DEL", name: "Indira Gandhi International Airport", city: "Delhi", country: "India", country_code: "IN" },
  { code: "BOM", name: "Chhatrapati Shivaji Maharaj International Airport", city: "Mumbai", country: "India", country_code: "IN" },
  { code: "BLR", name: "Kempegowda International Airport", city: "Bangalore", country: "India", country_code: "IN" },
  { code: "MAA", name: "Chennai International Airport", city: "Chennai", country: "India", country_code: "IN" },
  { code: "CCU", name: "Netaji Subhas Chandra Bose International Airport", city: "Kolkata", country: "India", country_code: "IN" },
  { code: "HYD", name: "Rajiv Gandhi International Airport", city: "Hyderabad", country: "India", country_code: "IN" },
  { code: "COK", name: "Cochin International Airport", city: "Kochi", country: "India", country_code: "IN" },
  { code: "GOI", name: "Dabolim Airport", city: "Goa", country: "India", country_code: "IN" },
  { code: "PNQ", name: "Pune Airport", city: "Pune", country: "India", country_code: "IN" },
  { code: "AMD", name: "Sardar Vallabhbhai Patel International Airport", city: "Ahmedabad", country: "India", country_code: "IN" },
  
  // UAE
  { code: "DXB", name: "Dubai International Airport", city: "Dubai", country: "United Arab Emirates", country_code: "AE" },
  { code: "AUH", name: "Abu Dhabi International Airport", city: "Abu Dhabi", country: "United Arab Emirates", country_code: "AE" },
  { code: "SHJ", name: "Sharjah International Airport", city: "Sharjah", country: "United Arab Emirates", country_code: "AE" },
  
  // Singapore
  { code: "SIN", name: "Singapore Changi Airport", city: "Singapore", country: "Singapore", country_code: "SG" },
  
  // Thailand
  { code: "BKK", name: "Suvarnabhumi Airport", city: "Bangkok", country: "Thailand", country_code: "TH" },
  { code: "DMK", name: "Don Mueang International Airport", city: "Bangkok", country: "Thailand", country_code: "TH" },
  
  // Malaysia
  { code: "KUL", name: "Kuala Lumpur International Airport", city: "Kuala Lumpur", country: "Malaysia", country_code: "MY" },
  
  // UK
  { code: "LHR", name: "London Heathrow Airport", city: "London", country: "United Kingdom", country_code: "GB" },
  { code: "LGW", name: "London Gatwick Airport", city: "London", country: "United Kingdom", country_code: "GB" },
  
  // USA
  { code: "JFK", name: "John F. Kennedy International Airport", city: "New York", country: "United States", country_code: "US" },
  { code: "LAX", name: "Los Angeles International Airport", city: "Los Angeles", country: "United States", country_code: "US" },
  { code: "SFO", name: "San Francisco International Airport", city: "San Francisco", country: "United States", country_code: "US" },
  
  // Australia
  { code: "SYD", name: "Sydney Kingsford Smith Airport", city: "Sydney", country: "Australia", country_code: "AU" },
  { code: "MEL", name: "Melbourne Airport", city: "Melbourne", country: "Australia", country_code: "AU" },
  
  // Europe
  { code: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France", country_code: "FR" },
  { code: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", country_code: "DE" },
  { code: "AMS", name: "Amsterdam Airport Schiphol", city: "Amsterdam", country: "Netherlands", country_code: "NL" },
  
  // Middle East
  { code: "DOH", name: "Hamad International Airport", city: "Doha", country: "Qatar", country_code: "QA" },
  { code: "JED", name: "King Abdulaziz International Airport", city: "Jeddah", country: "Saudi Arabia", country_code: "SA" },
  { code: "RUH", name: "King Khalid International Airport", city: "Riyadh", country: "Saudi Arabia", country_code: "SA" },
];

async function importAirports() {
  console.log("🚀 Starting airport import...");
  
  const airportsToInsert = POPULAR_AIRPORTS.map((airport) => ({
    code: airport.code.toUpperCase(),
    name: airport.name,
    city: airport.city,
    country: airport.country,
    country_code: airport.country_code,
    source: "manual",
    search_keywords: [
      airport.code.toLowerCase(),
      airport.name.toLowerCase(),
      airport.city.toLowerCase(),
      airport.country.toLowerCase(),
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  try {
    // Use upsert to avoid duplicates
    const { data, error } = await supabase
      .from("airports")
      .upsert(airportsToInsert, {
        onConflict: "code",
        ignoreDuplicates: false, // Update existing records
      })
      .select();

    if (error) {
      console.error("❌ Error importing airports:", error.message);
      console.error("Full error:", error);
      process.exit(1);
    }

    console.log(`✅ Successfully imported ${airportsToInsert.length} airports!`);
    console.log(`📊 Total airports in database: ${data?.length || airportsToInsert.length}`);
    
    // Show some statistics
    const { count } = await supabase
      .from("airports")
      .select("*", { count: "exact", head: true });
    
    console.log(`📈 Total airports in database: ${count}`);
    
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  }
}

// Run the import
importAirports()
  .then(() => {
    console.log("✨ Import completed!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("💥 Import failed:", err);
    process.exit(1);
  });
