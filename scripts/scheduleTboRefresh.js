/**
 * TBO Static Data Scheduled Refresh
 * 
 * Provider recommendation: Store static data at your end and refresh every 14–15 days.
 * Hotel search uses only this local data (no static API calls with search).
 * 
 * This script can be run as a scheduled task/cron job to refresh TBO static data
 * (countries, cities, hotel codes) every ~15 days.
 * 
 * Schedule: Runs on 1st, 16th, and last day of each month (~every 14–15 days)
 * 
 * Setup Instructions:
 * 
 * 1. LINUX/UNIX (cron):
 *    Add to crontab: crontab -e
 *    
 *    # TBO Static Data Refresh - 1st, 16th, and last day of month at 2 AM
 *    0 2 1,16,28-31 * * cd /path/to/madura-crm-25-serv && node scripts/scheduleTboRefresh.js
 * 
 * 2. WINDOWS (Task Scheduler):
 *    - Open Task Scheduler
 *    - Create Basic Task
 *    - Trigger: Monthly, on days 1, 16, and last day
 *    - Action: Start a program
 *    - Program: node
 *    - Arguments: scripts/scheduleTboRefresh.js
 *    - Start in: D:\MyBuilds\madura-crm\madura-crm-25-serv
 * 
 * 3. PM2 (Process Manager):
 *    pm2 start scripts/scheduleTboRefresh.js --cron "0 2 1,16,28-31 * *" --name tbo-refresh
 * 
 * 4. Node-cron (if running in Node.js):
 *    See index.js for integration example
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

async function scheduledRefresh() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] 🚀 Starting scheduled TBO static data refresh...\n`);

  try {
    // Step 1: Refresh all countries
    console.log("Step 1/3: Refreshing countries...");
    const countries = await fetchTboCountryList();
    await storeTboCountries(countries);
    console.log(`✅ Refreshed ${countries.length} countries\n`);

    // Step 2: Refresh cities for all countries
    console.log("Step 2/3: Refreshing cities...");
    const allCities = [];
    let citiesProcessed = 0;
    
    for (const country of countries) {
      try {
        const cities = await fetchTboCityList(country.code);
        await storeTboCities(cities, country.code);
        allCities.push(...cities.map(c => ({ ...c, countryCode: country.code })));
        citiesProcessed += cities.length;
        
        // Progress update every 10 countries
        if ((countries.indexOf(country) + 1) % 10 === 0) {
          console.log(`  Progress: ${countries.indexOf(country) + 1}/${countries.length} countries, ${citiesProcessed} cities...`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`  ⚠️  Skipping cities for ${country.code}: ${error.message}`);
        continue;
      }
    }
    
    console.log(`✅ Refreshed ${citiesProcessed} cities across ${countries.length} countries\n`);

    // Step 3: Refresh hotels for all cities
    console.log("Step 3/3: Refreshing hotels...");
    let totalHotels = 0;
    let hotelsProcessed = 0;
    
    for (const city of allCities) {
      try {
        const hotels = await fetchTboHotelCodeList(city.code);
        await storeTboHotelCodes(hotels, city.code, city.name, city.countryCode);
        totalHotels += hotels.length;
        hotelsProcessed++;
        
        // Progress update every 50 cities
        if (hotelsProcessed % 50 === 0) {
          console.log(`  Progress: ${hotelsProcessed}/${allCities.length} cities, ${totalHotels} hotels...`);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`  ⚠️  Skipping hotels for city ${city.code}: ${error.message}`);
        continue;
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
    console.log(`\n✅ Scheduled refresh completed successfully!`);
    console.log(`   - Countries: ${countries.length}`);
    console.log(`   - Cities: ${citiesProcessed}`);
    console.log(`   - Hotels: ${totalHotels}`);
    console.log(`   - Duration: ${duration} minutes`);
    console.log(`   - Next refresh: ${getNextRefreshDate()}\n`);
    
  } catch (error) {
    console.error(`\n❌ Fatal error during scheduled refresh:`, error);
    console.error(`   Error details:`, error.message);
    console.error(`   Stack:`, error.stack);
    // Don't exit with error code - let the scheduler handle retries
    process.exit(0);
  }
}

function getNextRefreshDate() {
  const now = new Date();
  const day = now.getDate();
  
  // Determine next refresh date (1st, 16th, or last day of month)
  let nextDay;
  if (day < 1) {
    nextDay = 1;
  } else if (day < 16) {
    nextDay = 16;
  } else if (day < 28) {
    // Last day of month (28-31 depending on month)
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    nextDay = lastDay;
  } else {
    // Next month's 1st
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.toISOString().split('T')[0];
  }
  
  const nextDate = new Date(now.getFullYear(), now.getMonth(), nextDay);
  return nextDate.toISOString().split('T')[0];
}

// Run the scheduled refresh
scheduledRefresh();
