/**
 * TBO Static Data Refresh Script
 * 
 * This script fetches and stores TBO static data (Country List, City List, Hotel Code List)
 * in the database. Run every 14–15 days (TBO recommendation: store static data locally;
 * do not send static data with search requests).
 * 
 * IMPORTANT NOTES:
 * - Many cities will have 0 hotels - this is NORMAL. Not all cities have hotels.
 * - We need hotel codes to search hotels (GetHotelResult API requires hotelCodes).
 * - Two approaches:
 *   1. Pre-index hotels (current): Slower indexing, faster searches
 *   2. Fetch on-demand: Faster indexing, slower searches (not implemented)
 * 
 * TBO API Endpoints:
 * - CountryList: GET /CountryList (all countries)
 * - CityList: POST /CityList (cities for a country)
 * - TBOHotelCodeList: POST /TBOHotelCodeList (hotels for a city) - CURRENTLY USED
 * - hotelcodelist: GET /hotelcodelist (ALL hotels) - ALTERNATIVE (not implemented)
 * 
 * Usage:
 *   node scripts/refreshTboStaticData.js [options]
 * 
 * Options:
 *   --countries-only     Only refresh countries
 *   --cities-only        Only refresh cities (requires --country-code)
 *   --hotels-only        Only refresh hotels (requires cities to be already indexed)
 *   --skip-hotels        Skip hotel indexing (only refresh countries and cities)
 *   --country-code=XX    Country code for city/hotel refresh (e.g., IN, AE)
 *   --city-code=123      City code for hotel refresh
 * 
 * Examples:
 *   # Refresh all countries
 *   node scripts/refreshTboStaticData.js --countries-only
 * 
 *   # Refresh cities for India
 *   node scripts/refreshTboStaticData.js --cities-only --country-code=IN
 * 
 *   # Refresh hotels for a specific city
 *   node scripts/refreshTboStaticData.js --city-code=123 --country-code=IN
 * 
 *   # Full refresh (all countries, cities, hotels)
 *   node scripts/refreshTboStaticData.js
 * 
 *   # Refresh only countries and cities (skip hotels - faster)
 *   node scripts/refreshTboStaticData.js --skip-hotels
 */

import dotenv from "dotenv";
dotenv.config();

import {
  fetchTboCountryList,
  fetchTboCityList,
  fetchTboHotelCodeList,
  storeTboCountries,
  storeTboCities,
  storeTboHotelCodes,
} from "../tboClient.js";


async function refreshCountries() {
  console.log("\n=== Refreshing Countries ===");
  try {
    const countries = await fetchTboCountryList();
    await storeTboCountries(countries);
    console.log(`✅ Successfully refreshed ${countries.length} countries\n`);
    return countries;
  } catch (error) {
    console.error("❌ Error refreshing countries:", error.message);
    throw error;
  }
}

async function refreshCitiesForCountry(countryCode) {
  console.log(`\n=== Refreshing Cities for Country: ${countryCode} ===`);
  try {
    const cities = await fetchTboCityList(countryCode);
    await storeTboCities(cities, countryCode);
    console.log(`✅ Successfully refreshed ${cities.length} cities for ${countryCode}\n`);
    return cities;
  } catch (error) {
    console.error(`❌ Error refreshing cities for ${countryCode}:`, error.message);
    throw error;
  }
}

async function refreshHotelsForCity(cityCode, cityName, countryCode, verbose = false) {
  try {
    const hotels = await fetchTboHotelCodeList(cityCode);
    await storeTboHotelCodes(hotels, cityCode, cityName, countryCode);
    
    // Only log if there are hotels or if verbose mode is enabled
    if (hotels.length > 0 || verbose) {
      console.log(`✅ ${cityName} (${cityCode}): ${hotels.length} hotels`);
    }
    
    return hotels;
  } catch (error) {
    console.error(`❌ Error refreshing hotels for ${cityName} (${cityCode}):`, error.message);
    throw error;
  }
}

async function refreshAllCountries() {
  const countries = await refreshCountries();
  return countries;
}

async function refreshAllCities(countries) {
  console.log("\n=== Refreshing Cities for All Countries ===");
  const allCities = [];
  
  for (const country of countries) {
    try {
      const cities = await refreshCitiesForCountry(country.code);
      allCities.push(...cities.map(c => ({ ...c, countryCode: country.code })));
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`⚠️  Skipping cities for ${country.code} due to error`);
      continue;
    }
  }
  
  return allCities;
}

async function refreshAllHotels(cities, skipEmpty = true) {
  console.log("\n=== Refreshing Hotels for All Cities ===");
  console.log(`Processing ${cities.length} cities... (cities with 0 hotels will be skipped in output)\n`);
  
  let totalHotels = 0;
  let citiesWithHotels = 0;
  let citiesProcessed = 0;
  
  for (const city of cities) {
    try {
      const hotels = await refreshHotelsForCity(city.code, city.name, city.countryCode, false);
      totalHotels += hotels.length;
      citiesProcessed++;
      
      if (hotels.length > 0) {
        citiesWithHotels++;
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Progress indicator every 100 cities
      if (citiesProcessed % 100 === 0) {
        console.log(`📊 Progress: ${citiesProcessed}/${cities.length} cities processed, ${citiesWithHotels} cities with hotels, ${totalHotels} total hotels`);
      }
    } catch (error) {
      console.error(`⚠️  Skipping hotels for city ${city.name} (${city.code}) due to error: ${error.message}`);
      continue;
    }
  }
  
  console.log(`\n✅ Hotel refresh completed:`);
  console.log(`   - Cities processed: ${citiesProcessed}/${cities.length}`);
  console.log(`   - Cities with hotels: ${citiesWithHotels}`);
  console.log(`   - Total hotels indexed: ${totalHotels}`);
  return totalHotels;
}


// Main execution
async function main() {
  const args = process.argv.slice(2);
  const countriesOnly = args.includes("--countries-only");
  const citiesOnly = args.includes("--cities-only");
  const hotelsOnly = args.includes("--hotels-only");
  const skipHotels = args.includes("--skip-hotels");
  
  const countryCodeArg = args.find(arg => arg.startsWith("--country-code="));
  const countryCode = countryCodeArg ? countryCodeArg.split("=")[1] : null;
  
  const cityCodeArg = args.find(arg => arg.startsWith("--city-code="));
  const cityCode = cityCodeArg ? parseInt(cityCodeArg.split("=")[1]) : null;

  try {
    if (countriesOnly) {
      await refreshCountries();
      return;
    }

    if (citiesOnly) {
      if (!countryCode) {
        console.error("❌ Error: --country-code is required when using --cities-only");
        process.exit(1);
      }
      await refreshCitiesForCountry(countryCode);
      return;
    }

    if (cityCode) {
      // Need to get city name from database or API
      const cities = await fetchTboCityList(countryCode || "IN");
      const city = cities.find(c => c.code === cityCode);
      if (!city) {
        console.error(`❌ City with code ${cityCode} not found`);
        process.exit(1);
      }
      await refreshHotelsForCity(cityCode, city.name, countryCode || "IN");
      return;
    }

    if (hotelsOnly) {
      // Only refresh hotels (cities must already be in database)
      console.log("\n🚀 Starting hotel refresh (cities must be already indexed)...\n");
      const { getSupabaseClient } = await import("../utils/supabase.js");
      const supabase = getSupabaseClient();
      const { data: cities, error } = await supabase
        .from("tbo_cities")
        .select("code, name, country_code");
      
      if (error || !cities || cities.length === 0) {
        console.error("❌ Error: No cities found in database. Please run full refresh first.");
        process.exit(1);
      }
      
      await refreshAllHotels(cities.map(c => ({ code: c.code, name: c.name, countryCode: c.country_code })));
      console.log("\n✅ Hotel refresh completed successfully!");
      return;
    }

    // Full refresh: Countries → Cities → Hotels
    console.log("\n🚀 Starting full TBO static data refresh...\n");
    const countries = await refreshAllCountries();
    const cities = await refreshAllCities(countries);
    
    if (!skipHotels) {
      await refreshAllHotels(cities);
    } else {
      console.log("\n⏭️  Skipping hotel indexing (--skip-hotels flag).");
      console.log("💡 Note: Hotels can be indexed later using: node scripts/refreshTboStaticData.js --hotels-only");
    }
    
    console.log("\n✅ Full refresh completed successfully!");
    console.log("\n💡 Remember to refresh this data every 15 days as per TBO recommendations.");
    
  } catch (error) {
    console.error("\n❌ Fatal error during refresh:", error);
    process.exit(1);
  }
}

main();
