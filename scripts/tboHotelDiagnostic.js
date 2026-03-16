/**
 * TBO Hotel API Diagnostic Script
 *
 * Tests TBO's hotel API endpoints to identify the issue:
 * 1. Authenticate with TBO
 * 2. Fetch countries
 * 3. Fetch cities for a country
 * 4. Test hotel code endpoints with different methods
 * 5. Test actual GetHotelResult search
 */

import dotenv from "dotenv";
dotenv.config();

let TBO_AUTH_URL_RAW = process.env.TBO_AUTH_URL;
// Auto-append endpoint if not present
const TBO_AUTH_URL = TBO_AUTH_URL_RAW?.endsWith("/rest/Authenticate")
  ? TBO_AUTH_URL_RAW
  : TBO_AUTH_URL_RAW?.endsWith("/Authenticate")
    ? TBO_AUTH_URL_RAW
    : `${TBO_AUTH_URL_RAW?.replace(/\/$/, "")}/rest/Authenticate`;

const TBO_CLIENT_ID = process.env.TBO_CLIENT_ID;
const TBO_USER_ID = process.env.TBO_USER_ID;
const TBO_PASSWORD = process.env.TBO_PASSWORD;
const TBO_END_USER_IP = process.env.TBO_END_USER_IP;

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function authenticateTbo() {
  log("\n📌 STEP 1: Authenticating with TBO", "cyan");
  log(`URL: ${TBO_AUTH_URL}`);

  const body = {
    ClientId: TBO_CLIENT_ID,
    UserName: TBO_USER_ID,
    Password: TBO_PASSWORD,
    ...(TBO_END_USER_IP ? { EndUserIp: TBO_END_USER_IP } : {}),
  };

  try {
    const response = await fetch(TBO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await response.json();

    if (json.TokenId || json.tokenId) {
      const tokenId = json.TokenId || json.tokenId;
      log(`✅ Authentication successful!`, "green");
      log(`Token: ${tokenId.substring(0, 8)}...`);
      return tokenId;
    } else {
      log(
        `❌ Authentication failed: ${json.Error?.ErrorMessage || "Unknown error"}`,
        "red",
      );
      return null;
    }
  } catch (error) {
    log(`❌ Error: ${error.message}`, "red");
    return null;
  }
}

async function fetchCountryList(tokenId) {
  log("\n📌 STEP 2: Fetching Country List", "cyan");

  const endpoints = [
    "http://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList",
    "https://api.tektravels.com/TBOHolidays_HotelAPI/CountryList",
  ];

  for (const url of endpoints) {
    log(`Trying: ${url}`);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.TBO_STATIC_API_USERNAME || process.env.TBO_USER_ID}:${process.env.TBO_STATIC_API_PASSWORD || process.env.TBO_PASSWORD}`).toString("base64")}`,
        },
      });

      log(`  Response status: ${response.status}`);

      if (!response.ok) {
        log(`  ⚠️ HTTP ${response.status}`);
        continue;
      }

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        log(`  ⚠️ Invalid JSON: ${text.substring(0, 100)}`);
        continue;
      }

      // Debug: Show actual response structure
      log(
        `  📊 Response structure: ${JSON.stringify(json).substring(0, 150)}...`,
        "blue",
      );

      const countries = Array.isArray(json)
        ? json
        : json.countries || json.CountryList || [];

      if (countries.length > 0) {
        log(`✅ Found ${countries.length} countries`, "green");

        log(`First 3 countries (full object):`, "blue");
        countries.slice(0, 3).forEach((c, idx) => {
          log(`  [${idx}] ${JSON.stringify(c).substring(0, 120)}`);
        });

        return countries;
      } else {
        log(`  ⚠️ Got response but 0 countries in array`);
      }
    } catch (error) {
      log(`  ❌ Error: ${error.message}`);
    }
  }

  log(`⚠️ Could not fetch countries from any endpoint`, "yellow");
  return [];
}

async function fetchCityList(tokenId, countryCode = "IN") {
  log(`\n📌 STEP 3: Fetching Cities for Country: ${countryCode}`, "cyan");
  const url = `http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList`;
  log(`URL: ${url} (POST method)`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${process.env.TBO_STATIC_API_USERNAME || process.env.TBO_USER_ID}:${process.env.TBO_STATIC_API_PASSWORD || process.env.TBO_PASSWORD}`).toString("base64")}`,
      },
      body: JSON.stringify({ CountryCode: countryCode }),
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      log(`  ⚠️ Invalid JSON: ${text.substring(0, 100)}`);
      return { cities: [], mumbaiCode: null };
    }

    log(
      `  📊 Response structure: ${JSON.stringify(json).substring(0, 150)}...`,
      "blue",
    );

    const cities = Array.isArray(json)
      ? json
      : json.cities || json.CityList || [];

    log(`✅ Found ${cities.length} cities`);

    // Show Mumbai and other major cities
    if (cities.length > 0) {
      log(`First 10 cities:`, "blue");
      cities.slice(0, 10).forEach((c) => {
        const cityName = c.name || c.CityName || c.Name;
        const cityCode = c.code || c.CityCode || c.Code;
        log(`  - ${cityName} (${cityCode})`);
      });

      const mumbai = cities.find(
        (c) =>
          (c.name || c.CityName || c.Name || "")
            .toLowerCase()
            .includes("mumbai") ||
          (c.name || c.CityName || "").toLowerCase().includes("bombay"),
      );
      if (mumbai) {
        const cityCode = mumbai.code || mumbai.CityCode || mumbai.Code;
        log(
          `\n🎯 Found Mumbai: ${mumbai.name || mumbai.CityName || mumbai.Name} (code: ${cityCode})`,
          "yellow",
        );
        return { cities, mumbaiCode: cityCode };
      }
    }

    return { cities, mumbaiCode: null };
  } catch (error) {
    log(`❌ Error: ${error.message}`, "red");
    return { cities: [], mumbaiCode: null };
  }
}

async function testHotelCodeEndpoints(tokenId, cityCode) {
  log(
    `\n📌 STEP 4: Testing Hotel Code Endpoints for City: ${cityCode}`,
    "cyan",
  );

  const endpoints = [
    {
      name: "TBOHotelCodeList (POST)",
      url: "http://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList",
      method: "POST",
      body: { CityCode: cityCode },
    },
    {
      name: "hotelcodelist (GET)",
      url: `http://api.tbotechnology.in/TBOHolidays_HotelAPI/hotelcodelist?CityCode=${cityCode}`,
      method: "GET",
      body: null,
    },
    {
      name: "GetHotelCodes (POST)",
      url: "http://api.tbotechnology.in/TBOHolidays_HotelAPI/GetHotelCodes",
      method: "POST",
      body: { CityCode: cityCode },
    },
  ];

  for (const endpoint of endpoints) {
    log(`\nTesting: ${endpoint.name}`, "blue");
    log(`URL: ${endpoint.url}`);

    try {
      const options = {
        method: endpoint.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${process.env.TBO_STATIC_API_USERNAME || process.env.TBO_USER_ID}:${process.env.TBO_STATIC_API_PASSWORD || process.env.TBO_PASSWORD}`).toString("base64")}`,
        },
      };

      if (endpoint.body) {
        options.body = JSON.stringify(endpoint.body);
      }

      const response = await fetch(endpoint.url, options);
      const text = await response.text();
      let json;

      try {
        json = JSON.parse(text);
      } catch (e) {
        json = { raw: text.substring(0, 200) };
      }

      const hotelCount = Array.isArray(json)
        ? json.length
        : json.hotels
          ? json.hotels.length
          : json.HotelCodeList
            ? json.HotelCodeList.length
            : 0;

      if (hotelCount > 0) {
        log(`✅ ${endpoint.name}: ${hotelCount} hotels found`, "green");
      } else {
        log(
          `⚠️ ${endpoint.name}: 0 hotels (response: ${JSON.stringify(json).substring(0, 100)})`,
          "yellow",
        );
      }
    } catch (error) {
      log(`❌ ${endpoint.name}: ${error.message}`, "red");
    }
  }
}

async function testDirectHotelSearch(tokenId) {
  log(
    `\n📌 STEP 4.5: Testing Direct Hotel Search (with different auth methods)`,
    "cyan",
  );
  log(`This tests if the GetHotelResult endpoint works at all`, "blue");

  // Try with some common hotel codes that should exist
  const testCases = [
    { codes: "1,2,3,4,5", desc: "Generic codes 1-5" },
    { codes: "123456", desc: "Single code 123456" },
  ];

  for (const testCase of testCases) {
    log(`\nTesting: ${testCase.desc}`);

    // Try METHOD 1: TokenId in body (current method)
    log(`  METHOD 1: TokenId in body`);
    const body1 = {
      TokenId: tokenId,
      CheckIn: "2026-02-10",
      CheckOut: "2026-02-12",
      HotelCodes: testCase.codes,
      GuestNationality: "IN",
      NoOfRooms: 1,
      PaxRooms: [
        {
          Adults: 2,
          Children: 0,
          ChildrenAges: [],
        },
      ],
      IsDetailedResponse: false,
    };

    try {
      const response = await fetch(
        "https://affiliate.tektravels.com/HotelAPI/Search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body1),
        },
      );

      const responseText = await response.text();
      let json;
      try {
        json = JSON.parse(responseText);
      } catch (e) {
        log(`    ⚠️ Invalid JSON response`);
        continue;
      }

      const hotelResults = json.HotelResult || json.hotelResult || [];
      const status = json.Status || json.ResponseStatus || json.status;
      const error = json.Error || json.error || {};

      log(`    Status: ${JSON.stringify(status)}`);

      if (hotelResults.length > 0) {
        log(`    ✅ SUCCESS! This auth method works!`, "green");
        return true;
      }
    } catch (error) {
      log(`    ❌ Error: ${error.message}`);
    }

    // Try METHOD 2: Basic Auth with ClientId:Password
    log(`  METHOD 2: Basic Auth with ClientId + UserName + Password`);
    const body2 = {
      ClientId: process.env.TBO_CLIENT_ID,
      UserName: process.env.TBO_USER_ID,
      Password: process.env.TBO_PASSWORD,
      CheckIn: "2026-02-10",
      CheckOut: "2026-02-12",
      HotelCodes: testCase.codes,
      GuestNationality: "IN",
      NoOfRooms: 1,
      PaxRooms: [
        {
          Adults: 2,
          Children: 0,
          ChildrenAges: [],
        },
      ],
      IsDetailedResponse: false,
    };

    try {
      const response = await fetch(
        "https://affiliate.tektravels.com/HotelAPI/Search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body2),
        },
      );

      const responseText = await response.text();
      let json;
      try {
        json = JSON.parse(responseText);
      } catch (e) {
        log(`    ⚠️ Invalid JSON response`);
        continue;
      }

      const hotelResults = json.HotelResult || json.hotelResult || [];
      const status = json.Status || json.ResponseStatus || json.status;

      log(`    Status: ${JSON.stringify(status)}`);

      if (hotelResults.length > 0) {
        log(`    ✅ SUCCESS! This auth method works!`, "green");
        return true;
      }
    } catch (error) {
      log(`    ❌ Error: ${error.message}`);
    }
  }

  log(`\n⚠️ All auth methods returned 0 hotels or errors`, "yellow");
}

async function runDiagnostics() {
  log("\n╔════════════════════════════════════════════╗", "cyan");
  log("║  TBO HOTEL API DIAGNOSTIC SCRIPT           ║", "cyan");
  log("╚════════════════════════════════════════════╝", "cyan");

  const tokenId = await authenticateTbo();
  if (!tokenId) {
    log("\n❌ Cannot proceed without authentication", "red");
    return;
  }

  const countries = await fetchCountryList(tokenId);
  if (countries.length === 0) {
    log("\n⚠️ Could not fetch countries. Static API might be down.", "yellow");
  }

  // Test direct hotel search even if static API is down
  log("\n⚡ Skipping city/static data checks...");
  log("🔍 Testing direct hotel search API instead...", "blue");
  const searchWorks = await testDirectHotelSearch(tokenId);

  if (!searchWorks) {
    const { cities, mumbaiCode } = await fetchCityList(tokenId, "IN");
    if (mumbaiCode) {
      await testHotelCodeEndpoints(tokenId, mumbaiCode);
    }
  }

  log("\n╔════════════════════════════════════════════╗", "cyan");
  log("║  DIAGNOSTIC COMPLETE                       ║", "cyan");
  log("╚════════════════════════════════════════════╝", "cyan");

  log("\n📋 SUMMARY:", "blue");
  log("1. ✅ If auth works: Your credentials are correct");
  log("2. ✅ If cities load: Your city database is synced");
  log(
    "3. ⚠️  If 0 hotels for all endpoints: Your TBO account doesn't have hotel inventory",
  );
  log("\n💡 NEXT STEPS:", "blue");
  log(
    "• If you see 0 hotels everywhere → Contact TBO support to activate hotel module",
  );
  log("• If some cities have hotels → Run refresh script to index them");
  log("• If endpoints fail → TBO API might be down; try again later");
}

runDiagnostics().catch((error) => {
  log(`\n❌ Fatal error: ${error.message}`, "red");
  process.exit(1);
});
