import fetch from "node-fetch";

// Global map to store active crawl processes for cancellation
export const activeCrawls = new Map();

/**
 * Cancel an active crawl process
 * @param {string} crawlId - The crawl ID to cancel
 */
export function cancelCrawl(crawlId) {
  const crawl = activeCrawls.get(crawlId);
  if (crawl) {
    crawl.cancelled = true;
    console.log(`[Crawler] Cancellation requested for crawl: ${crawlId}`);
    return true;
  }
  return false;
}

/**
 * Extract text content from HTML
 * @param {string} html - HTML content
 * @returns {string} - Extracted text
 */
function extractTextFromHTML(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract all links from HTML that belong to the same domain
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL to resolve relative links
 * @param {string} domain - Domain to filter links (e.g., "example.com")
 * @returns {string[]} - Array of absolute URLs
 */
function extractLinks(html, baseUrl, domain) {
  const links = new Set();
  const baseUrlObj = new URL(baseUrl);
  
  // Match all href attributes
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  
  while ((match = hrefRegex.exec(html)) !== null) {
    let link = match[1];
    
    // Skip anchors, javascript:, mailto:, tel:, etc.
    if (link.startsWith("#") || link.startsWith("javascript:") || 
        link.startsWith("mailto:") || link.startsWith("tel:") ||
        link.startsWith("data:") || link.startsWith("file:")) {
      continue;
    }
    
    try {
      // Resolve relative URLs
      const absoluteUrl = new URL(link, baseUrl).href;
      const linkUrl = new URL(absoluteUrl);
      
      // Only include links from the same domain
      if (linkUrl.hostname === domain || linkUrl.hostname.endsWith(`.${domain}`)) {
        // Remove fragments and query params for deduplication
        const cleanUrl = `${linkUrl.protocol}//${linkUrl.hostname}${linkUrl.pathname}`;
        links.add(cleanUrl);
      }
    } catch (e) {
      // Invalid URL, skip
      continue;
    }
  }
  
  return Array.from(links);
}

/**
 * Crawl a single page and extract content
 * @param {string} url - URL to crawl
 * @returns {Promise<{url: string, content: string, links: string[]}>}
 */
async function crawlPage(url) {
  try {
    console.log(`[Crawler] Fetching: ${url}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000, // 10 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const content = extractTextFromHTML(html);
    const baseUrl = new URL(url);
    const links = extractLinks(html, url, baseUrl.hostname);
    
    return {
      url,
      content,
      links,
    };
  } catch (error) {
    console.error(`[Crawler] Error crawling ${url}:`, error.message);
    return {
      url,
      content: `[Error fetching page: ${error.message}]`,
      links: [],
    };
  }
}

/**
 * Crawl an entire website starting from a base URL
 * @param {string} startUrl - Starting URL
 * @param {object} options - Crawling options
 * @param {number} options.maxPages - Maximum number of pages to crawl (default: 50)
 * @param {number} options.maxDepth - Maximum depth to crawl (default: 3)
 * @param {number} options.delay - Delay between requests in ms (default: 500)
 * @returns {Promise<string>} - Combined content from all crawled pages
 */
export async function crawlWebsite(startUrl, options = {}) {
  const {
    maxPages = 500,  // Increased to 500 pages
    maxDepth = 999,  // Effectively unlimited depth - crawl all levels
    delay = 500,
    crawlId = null,
  } = options;

  // Create crawl tracking object
  const crawlInfo = {
    cancelled: false,
    pagesCrawled: 0,
    totalPages: 0,
    currentUrl: startUrl,
    startTime: Date.now(),
  };

  if (crawlId) {
    activeCrawls.set(crawlId, crawlInfo);
  }
  
  try {
    const startUrlObj = new URL(startUrl);
    const domain = startUrlObj.hostname;
    
    console.log(`[Crawler] Starting website crawl: ${startUrl}${crawlId ? ` (ID: ${crawlId})` : ''}`);
    console.log(`[Crawler] Domain: ${domain}, Max pages: ${maxPages}, Max depth: ${maxDepth}`);
    
    const visited = new Set();
    const toVisit = [{ url: startUrl, depth: 0 }];
    const allContent = [];
    let pagesCrawled = 0;
    
    while (toVisit.length > 0 && pagesCrawled < maxPages) {
      // Check for cancellation before processing each page
      if (crawlInfo.cancelled) {
        console.log(`[Crawler] Crawl cancelled after ${pagesCrawled} pages`);
        if (crawlId) {
          activeCrawls.delete(crawlId);
        }
        throw new Error("Crawl cancelled by user");
      }

      const { url, depth } = toVisit.shift();
      
      // Skip if already visited or too deep
      if (visited.has(url) || depth > maxDepth) {
        continue;
      }
      
      visited.add(url);
      
      // Update crawl info
      crawlInfo.currentUrl = url;
      crawlInfo.pagesCrawled = pagesCrawled;
      crawlInfo.totalPages = toVisit.length + pagesCrawled + 1;
      
      // Crawl the page
      const pageData = await crawlPage(url);
      pagesCrawled++;
      crawlInfo.pagesCrawled = pagesCrawled;
      
      // Check again after crawling (in case cancelled during fetch)
      if (crawlInfo.cancelled) {
        console.log(`[Crawler] Crawl cancelled after ${pagesCrawled} pages`);
        if (crawlId) {
          activeCrawls.delete(crawlId);
        }
        throw new Error("Crawl cancelled by user");
      }
      
      // Add content
      if (pageData.content && pageData.content.length > 100) { // Only add substantial content
        allContent.push(`\n--- Page: ${url} ---\n${pageData.content}\n`);
      }
      
      // Add new links to queue if not at max depth
      if (depth < maxDepth && !crawlInfo.cancelled) {
        for (const link of pageData.links) {
          if (!visited.has(link) && !toVisit.some(item => item.url === link)) {
            toVisit.push({ url: link, depth: depth + 1 });
          }
        }
      }
      
      // Delay between requests to be respectful
      if (toVisit.length > 0 && delay > 0 && !crawlInfo.cancelled) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`[Crawler] Progress: ${pagesCrawled}/${maxPages} pages, ${toVisit.length} in queue`);
    }

    // Clean up crawl tracking
    if (crawlId) {
      activeCrawls.delete(crawlId);
    }
    
    const combinedContent = allContent.join("\n");
    console.log(`[Crawler] Completed: Crawled ${pagesCrawled} pages, extracted ${combinedContent.length} characters`);
    
    return combinedContent;
  } catch (error) {
    // Clean up on error
    if (crawlId) {
      activeCrawls.delete(crawlId);
    }
    
    if (error.message === "Crawl cancelled by user") {
      throw error; // Re-throw cancellation errors
    }
    
    console.error("[Crawler] Website crawl error:", error.message);
    throw new Error(`Failed to crawl website: ${error.message}`);
  }
}

/**
 * Fetch content from a single URL (non-crawling)
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - Extracted text content
 */
export async function fetchSinglePage(url) {
  try {
    console.log(`[Crawler] Fetching single page: ${url}`);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    const content = extractTextFromHTML(html);
    console.log(`[Crawler] Extracted ${content.length} characters from single page`);
    
    return content;
  } catch (error) {
    console.error(`[Crawler] Error fetching single page:`, error.message);
    throw new Error(`Failed to fetch URL: ${error.message}`);
  }
}

