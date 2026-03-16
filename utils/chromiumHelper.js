import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { logger } from "./logger.js";

/**
 * Detects if the path is a snap "stub" that only tells user to run snap install
 * (e.g. on Ubuntu when chromium-browser package is a transitional stub)
 * @param {string} path - Path to the executable
 * @returns {boolean} True if it's a stub, false if real binary
 */
function isSnapStub(path) {
  if (!path || !existsSync(path)) return false;
  try {
    const content = readFileSync(path, { encoding: "utf-8", flag: "r" });
    const stubMarkers = [
      "requires the chromium snap",
      "snap install chromium",
      "Please install it with:",
    ];
    return stubMarkers.some((m) => content.includes(m));
  } catch (e) {
    return false;
  }
}

/**
 * Finds Chromium executable path with fallback options
 * Skips snap stubs (e.g. /usr/bin/chromium-browser that only says "snap install chromium")
 * @returns {string|null} Path to Chromium executable or null if not found / is stub
 */
export function findChromiumPath() {
  // First, check environment variables (user-specified)
  const envPath =
    process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) {
    if (isSnapStub(envPath)) {
      logger.warn(
        `[Chromium Helper] ${envPath} is a snap stub (not a real Chromium). Using Puppeteer bundled Chromium.`,
      );
      return null;
    }
    // Check if it's a snap installation (real binary inside snap)
    try {
      const realPath = execSync(`readlink -f "${envPath}"`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (realPath.includes("/snap/")) {
        logger.warn(
          `[Chromium Helper] ⚠️ Warning: ${envPath} points to snap installation. This may cause cgroup issues with PM2. Consider installing Chromium via apt or using bundled Chromium.`,
        );
      }
    } catch (e) {
      // readlink failed, but file exists, so use it
    }
    return envPath;
  }

  // Try to find Chromium in common locations (prioritize non-snap)
  const possiblePaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/local/bin/chromium",
    "/usr/local/bin/chromium-browser",
    "/opt/chromium/chromium",
    "/snap/chromium/current/usr/lib/chromium-browser/chromium-browser",
    "/snap/chromium/current/usr/lib/chromium-browser/chromium",
  ];

  for (const path of possiblePaths) {
    if (existsSync(path) && !isSnapStub(path)) {
      if (path.includes("/snap/")) {
        logger.warn(
          `[Chromium Helper] ⚠️ Found snap-installed Chromium at ${path}. This may cause issues with PM2 systemd service.`,
        );
      }
      return path;
    }
  }

  // Try using 'which' command as last resort
  try {
    const whichPath = execSync("which chromium-browser chromium 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
    if (whichPath && existsSync(whichPath) && !isSnapStub(whichPath)) {
      if (whichPath.includes("/snap/")) {
        logger.warn(
          `[Chromium Helper] ⚠️ Found snap-installed Chromium via 'which' at ${whichPath}.`,
        );
      }
      return whichPath;
    }
  } catch (e) {
    // which command failed
  }

  return null;
}

/**
 * Returns path for puppeteer.launch(). If no real Chromium is found (or only stub),
 * returns null so caller can use Puppeteer's bundled Chromium (requires "puppeteer" pkg).
 * @returns {string|null} Path to Chromium or null to use bundled
 */
export function getChromiumPathForLaunch() {
  return findChromiumPath();
}

/**
 * Gets Chromium executable path with helpful error message
 * @returns {string} Path to Chromium executable
 * @throws {Error} If Chromium path cannot be found
 */
export function getChromiumPath() {
  const path = findChromiumPath();
  if (!path) {
    const errorMessage = `[PDF Generator] Chromium executable not found.

Please install Chromium using one of these methods:

1. RECOMMENDED - Install via apt (non-snap):
   sudo apt-get update
   sudo apt-get install -y chromium-browser
   Then set: export CHROMIUM_PATH=/usr/bin/chromium-browser

2. OR use Puppeteer's bundled Chromium:
   npm install puppeteer (instead of puppeteer-core)
   This will download Chromium automatically.

3. OR download standalone Chromium:
   Visit: https://www.chromium.org/getting-involved/download-chromium
   Extract and set: export CHROMIUM_PATH=/path/to/chromium

Current environment variables:
  PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH || "not set"}
  CHROMIUM_PATH: ${process.env.CHROMIUM_PATH || "not set"}

NOTE: Snap-installed Chromium (/snap/chromium/...) may cause cgroup issues 
with PM2 systemd services. Use apt installation instead.`;
    throw new Error(errorMessage);
  }
  return path;
}

/**
 * Validates Chromium path and checks for common issues
 * @param {string} chromiumPath - Path to Chromium executable
 * @returns {object} Validation result with warnings/errors
 */
export function validateChromiumPath(chromiumPath) {
  const result = {
    valid: true,
    warnings: [],
    errors: [],
  };

  if (!existsSync(chromiumPath)) {
    result.valid = false;
    result.errors.push(`Chromium path does not exist: ${chromiumPath}`);
    return result;
  }

  // Check if it's a snap installation
  if (chromiumPath.includes("/snap/")) {
    result.warnings.push(
      "Chromium is installed via snap. This may cause cgroup permission issues with PM2 systemd services.",
    );
    result.warnings.push(
      "Consider installing Chromium via apt: sudo apt-get install chromium-browser",
    );
  }

  // Check if it's executable
  try {
    execSync(`test -x "${chromiumPath}"`, { stdio: "ignore" });
  } catch (e) {
    result.warnings.push(`Chromium path may not be executable: ${chromiumPath}`);
  }

  return result;
}
