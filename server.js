// Scraper for Thingiverse using Puppeteer
async function searchThingiverse(query) {
    let page = null;
    try {
        const url = `https://www.thingiverse.com/search?q=${encodeURIComponent(query)}&type=things`;
        console.log(`Thingiverse: Fetching ${url}`);

        const browser = await initBrowser();
        page = await browser.newPage();

        // Set extra headers to avoid detection
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        // Navigate with longer timeout and wait for DOM
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check page title to verify we're on the right page
        const pageTitle = await page.title();
        console.log('Thingiverse page title:', pageTitle);

        // If we hit a challenge or error page, return empty
        if (pageTitle.includes('Just a moment') || pageTitle.includes('Error')) {
            console.log('Thingiverse: Hit challenge or error page');
            return [];
        }

        const results = await page.evaluate(() => {
            const items = [];

            try {
                // Thingiverse uses ItemCardContainer divs
                const cards = Array.from(document.querySelectorAll('div[class*="ItemCardContainer"]'));

                console.log(`Thingiverse: Found ${cards.length} card containers`);

                cards.forEach((card, index) => {
                    if (items.length >= 10) return;

                    try {
                        // Find the main content link (the one with the image)
                        const linkElem = card.querySelector('a[class*="ItemCardContent"][href*="/thing:"]');
                        if (!linkElem) return;

                        const link = linkElem.getAttribute('href');

                        // Title is in an 'a' tag in the header section
                        const titleElem = card.querySelector('a[class*="ItemCardTitle"]') ||
                            card.querySelector('div[class*="ItemCardHeader"] a[title]');
                        let title = titleElem?.getAttribute('title') ||
                            titleElem?.textContent?.trim() ||
                            'Untitled';

                        // Image with ItemCardContent class
                        let thumbnail = card.querySelector('img[class*="ItemCardContent"]')?.getAttribute('src') ||
                            card.querySelector('img')?.getAttribute('src') ||
                            card.querySelector('img')?.getAttribute('data-src');

                        // Author - in ItemCardHeader
                        const authorElem = card.querySelector('div[class*="ItemCardHeader"] a[href*="/"]');
                        let author = authorElem?.textContent?.trim() || 'Unknown';

                        // Stats - find all text nodes with numbers
                        const textContent = card.textContent || '';
                        const numberMatches = textContent.match(/\d+[kKmM]?/g) || [];

                        let likes = 0;
                        if (numberMatches.length > 0) {
                            const likeText = numberMatches[0];
                            const likeNum = parseFloat(likeText.replace(/[^0-9.]/g, '')) || 0;
                            likes = likeText.toLowerCase().includes('k') ? Math.round(likeNum * 1000) : Math.round(likeNum);
                        }

                        console.log(`Thingiverse Item ${index}: title="${title}", link="${link}"`);

                        if (title && link) {
                            items.push({
                                title,
                                link: link.startsWith('http') ? link : `https://www.thingiverse.com${link}`,
                                thumbnail: thumbnail || '',
                                author,
                                likes,
                                downloads: 0
                            });
                        }
                    } catch (err) {
                        console.log(`Thingiverse: Error processing card ${index}:`, err.message);
                    }
                });
            } catch (err) {
                console.log('Thingiverse: Error in evaluate:', err.message);
            }

            return items;
        });

        const formattedResults = results.map(item => ({
            id: `thingiverse_${item.link}`,
            title: item.title,
            thumbnail: item.thumbnail,
            author: item.author,
            source: 'thingiverse',
            url: item.link,
            likes: item.likes || 0,
            downloads: item.downloads || 0
        }));

        console.log(`Thingiverse: Found ${formattedResults.length} results`);
        return formattedResults;

    } catch (error) {
        console.error('Thingiverse search error:', error.message);
        return [];
    } finally {
        if (page) await page.close();
    }
}

// server.js - Node.js backend for 3D model search aggregator with Puppeteer
// Install: npm install express cors node-cache puppeteer better-sqlite3

const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour memory cache
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Global browser instance
let browser = null;

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'search_cache.db'));

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE,
    results TEXT NOT NULL,
    sources TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE INDEX IF NOT EXISTS idx_query ON searches(query);
  CREATE INDEX IF NOT EXISTS idx_updated_at ON searches(updated_at);
`);

// Prepare SQL statements
const getSearchStmt = db.prepare('SELECT * FROM searches WHERE query = ?');
const insertSearchStmt = db.prepare(`
  INSERT INTO searches (query, results, sources) 
  VALUES (?, ?, ?)
  ON CONFLICT(query) DO UPDATE SET 
    results = excluded.results,
    sources = excluded.sources,
    updated_at = CURRENT_TIMESTAMP
`);
const cleanOldSearchesStmt = db.prepare(`DELETE FROM searches WHERE updated_at < datetime('now', '-7 days')`);

// Clean old cache entries on startup
cleanOldSearchesStmt.run();
console.log('Cleaned old database entries');

// Helper functions for database caching
function getCachedSearch(query) {
    try {
        const row = getSearchStmt.get(query);
        if (row) {
            return {
                query: row.query,
                results: JSON.parse(row.results),
                sources: JSON.parse(row.sources),
                total: JSON.parse(row.results).length,
                cached: true,
                cached_at: row.updated_at
            };
        }
    } catch (err) {
        console.error('Error reading from cache:', err);
    }
    return null;
}

function cacheSearch(query, results, sources) {
    try {
        insertSearchStmt.run(
            query,
            JSON.stringify(results),
            JSON.stringify(sources)
        );
    } catch (err) {
        console.error('Error writing to cache:', err);
    }
}

// Initialize browser on startup
async function initBrowser() {
    if (!browser) {
        console.log('Launching Puppeteer browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        console.log('Browser launched successfully');
    }
    return browser;
}

// Scraper for Printables.com using Puppeteer
async function searchPrintables(query) {
    let page = null;
    try {
        const url = `https://www.printables.com/search/models?q=${encodeURIComponent(query)}`;
        console.log(`Printables: Fetching ${url}`);

        const browser = await initBrowser();
        page = await browser.newPage();

        // Set viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Navigate to the page
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a bit for page to fully load
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Handle cookie consent popup - try multiple times
        let cookieHandled = false;
        for (let i = 0; i < 3; i++) {
            try {
                const acceptButton = await page.$('button:has-text("Accept All"), button:has-text("Accept all"), button[class*="accept"]');
                if (acceptButton) {
                    await acceptButton.click();
                    console.log('Printables: Accepted cookies');
                    cookieHandled = true;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    break;
                }
            } catch (e) {
                // Button not found, wait and try again
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!cookieHandled) {
            console.log('Printables: No cookie popup found or already accepted');
        }

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Debug: Take a screenshot and check page title
        const pageTitle = await page.title();
        console.log('Printables page title:', pageTitle);

        // Extract data from the page
        const results = await page.evaluate(() => {
            const items = [];

            // Printables uses article elements with data-testid="model"
            const articles = Array.from(document.querySelectorAll('article[data-testid="model"]'));

            console.log(`Printables: Found ${articles.length} model cards`);

            articles.forEach((article, index) => {
                if (items.length >= 10) return;

                // Find the main link to the model
                const linkElem = article.querySelector('a[href*="/model/"]');
                if (!linkElem) return;

                const link = linkElem.getAttribute('href');

                // Title is in the link text or in an h5
                let title = article.querySelector('h5')?.textContent?.trim() ||
                    linkElem.textContent?.trim();

                // Image - IMPORTANT: Skip profile pictures, find the model image
                // Model images are inside <picture class="image-inside"> elements
                let thumbnail = '';

                // First, try to find the picture element with image-inside class
                const pictureElem = article.querySelector('picture.image-inside, picture[class*="image-inside"]');
                if (pictureElem) {
                    // Try to get from source elements first (for responsive images)
                    const sourceElem = pictureElem.querySelector('source');
                    if (sourceElem) {
                        thumbnail = sourceElem.getAttribute('srcset')?.split(',')[0]?.split(' ')[0] ||
                            sourceElem.getAttribute('src');
                    }
                    // Fall back to img in the picture element
                    if (!thumbnail) {
                        const imgElem = pictureElem.querySelector('img');
                        if (imgElem) {
                            thumbnail = imgElem.getAttribute('src') || imgElem.getAttribute('data-src');
                        }
                    }
                }

                // If still no thumbnail, try finding any img that's not in an avatar link
                if (!thumbnail) {
                    const allImages = Array.from(article.querySelectorAll('img'));
                    for (const img of allImages) {
                        // Skip if parent is an avatar link
                        if (img.closest('a[class*="avatar"]')) continue;

                        thumbnail = img.getAttribute('src') || img.getAttribute('data-src');
                        if (thumbnail) break;
                    }
                }

                // Author - look for user link or username
                let authorElem = article.querySelector('a[href*="/@"]');
                let author = authorElem?.textContent?.trim() || 'Unknown';

                // Stats - look in stats-bar div
                let likes = 0;
                let downloads = 0;

                // Find all spans with numbers - they're usually stats
                const allSpans = Array.from(article.querySelectorAll('span'));
                const numberSpans = allSpans.filter(span => /^\d+(\.\d+)?[kKmM]?$/.test(span.textContent.trim()));

                if (numberSpans.length >= 2) {
                    // Usually first number is likes, third is downloads
                    const likeText = numberSpans[0]?.textContent.trim();
                    if (likeText) {
                        likes = parseInt(likeText.replace(/[^0-9]/g, '')) || 0;
                    }

                    if (numberSpans.length >= 3) {
                        const downloadText = numberSpans[2]?.textContent.trim();
                        if (downloadText) {
                            downloads = parseInt(downloadText.replace(/[^0-9]/g, '')) || 0;
                        }
                    }
                }

                console.log(`Printables Item ${index}: title="${title}", likes=${likes}, downloads=${downloads}, thumbnail=${thumbnail?.substring(0, 50)}`);

                if (title && link) {
                    items.push({
                        title,
                        link: link.startsWith('http') ? link : `https://www.printables.com${link}`,
                        thumbnail: thumbnail || '',
                        author,
                        likes,
                        downloads
                    });
                }
            });

            return items;
        });

        // Transform to our format
        const formattedResults = results.map(item => ({
            id: `printables_${item.link}`,
            title: item.title,
            thumbnail: item.thumbnail,
            author: item.author,
            source: 'printables',
            url: item.link,
            likes: item.likes || 0,
            downloads: item.downloads || 0
        }));

        console.log(`Printables: Found ${formattedResults.length} results`);
        return formattedResults;

    } catch (error) {
        console.error('Printables search error:', error.message);
        return [];
    } finally {
        if (page) await page.close();
    }
}

// Scraper for MakerWorld using Puppeteer
async function searchMakerWorld(query) {
    let page = null;
    try {
        const url = `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(query)}`;
        console.log(`MakerWorld: Fetching ${url}`);

        const browser = await initBrowser();
        page = await browser.newPage();

        // Set extra headers and properties to avoid detection
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        // Hide webdriver property
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait longer for Cloudflare

        // Check if we hit Cloudflare challenge
        const pageTitle = await page.title();
        const pageContent = await page.content();

        if (pageTitle.includes('Just a moment') || pageContent.includes('Cloudflare')) {
            console.log('MakerWorld: Detected Cloudflare challenge, waiting...');
            // Wait up to 10 seconds for Cloudflare to resolve
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        const results = await page.evaluate(() => {
            const items = [];
            const seenUrls = new Set(); // Track URLs to avoid duplicates

            // MakerWorld uses links with /models/ or /en/models/
            const selectors = [
                'a[href*="/models/"]',
                'a[href*="/en/models/"]'
            ];

            let elements = [];
            let usedSelector = '';
            for (const selector of selectors) {
                elements = Array.from(document.querySelectorAll(selector));
                if (elements.length > 0) {
                    usedSelector = selector;
                    break;
                }
            }

            console.log(`MakerWorld: Found ${elements.length} elements using selector: ${usedSelector}`);

            // Filter to only model links (not category or other links)
            elements = elements.filter(elem => {
                const href = elem.getAttribute('href');
                return href && /\/models\/\d+/.test(href);
            });

            console.log(`MakerWorld: After filtering, ${elements.length} valid model links`);

            elements.forEach((elem, index) => {
                if (items.length >= 10) return;

                let link = elem.getAttribute('href');

                // Skip if we've already processed this URL
                if (seenUrls.has(link)) return;
                seenUrls.add(link);

                // The title is in the img alt attribute or h3
                let title = elem.querySelector('img')?.getAttribute('alt') ||
                    elem.querySelector('h3')?.textContent?.trim() ||
                    elem.getAttribute('title') ||
                    elem.textContent?.trim();

                // The image src
                let thumbnail = elem.querySelector('img')?.getAttribute('src') ||
                    elem.querySelector('img')?.getAttribute('data-src');

                // Author might be in a separate element
                let author = elem.closest('[class*="card"]')?.querySelector('[class*="author"], [class*="creator"]')?.textContent?.trim();

                // Stats - look for the icon containers
                let likes = 0;
                let downloads = 0;
                const cardParent = elem.closest('[class*="card"]') || elem.parentElement;

                if (cardParent) {
                    // Find all spans with numbers that look like stats
                    const allSpans = Array.from(cardParent.querySelectorAll('span'));
                    const statSpans = allSpans.filter(span => {
                        const text = span.textContent?.trim();
                        return text && /^\d+(\.\d+)?\s*[kKmM]?$/.test(text);
                    });

                    console.log(`MakerWorld Item ${items.length}: Found ${statSpans.length} stat spans`);

                    // MakerWorld typically has: prints, likes, downloads in that order
                    // We want likes (index 1) and downloads (index 2)
                    if (statSpans.length >= 2) {
                        const likeText = statSpans[1]?.textContent?.trim();
                        if (likeText) {
                            const likeNum = parseFloat(likeText.replace(/[^0-9.]/g, '')) || 0;
                            likes = likeText.toLowerCase().includes('k') ? Math.round(likeNum * 1000) : Math.round(likeNum);
                        }
                    }

                    if (statSpans.length >= 3) {
                        const downloadText = statSpans[2]?.textContent?.trim();
                        if (downloadText) {
                            const downloadNum = parseFloat(downloadText.replace(/[^0-9.]/g, '')) || 0;
                            downloads = downloadText.toLowerCase().includes('k') ? Math.round(downloadNum * 1000) : Math.round(downloadNum);
                        }
                    }
                }

                console.log(`MakerWorld Item ${items.length}: title="${title}", likes=${likes}, downloads=${downloads}`);

                if (title && link) {
                    items.push({
                        title,
                        link: link.startsWith('http') ? link : `https://makerworld.com${link}`,
                        thumbnail: thumbnail || '',
                        author: author || 'Unknown',
                        likes,
                        downloads
                    });
                }
            });

            return items;
        });

        const formattedResults = results.map(item => ({
            id: `makerworld_${item.link}`,
            title: item.title,
            thumbnail: item.thumbnail,
            author: item.author,
            source: 'makerworld',
            url: item.link,
            likes: item.likes || 0,
            downloads: item.downloads || 0
        }));

        console.log(`MakerWorld: Found ${formattedResults.length} results`);
        return formattedResults;

    } catch (error) {
        console.error('MakerWorld search error:', error.message);
        return [];
    } finally {
        if (page) await page.close();
    }
}

// Main search endpoint
app.get('/api/search', async (req, res) => {
    const { q: query } = req.query;

    if (!query) {
        return res.status(400).json({ error: 'Query parameter required' });
    }

    console.log(`\n=== Search request for: "${query}" ===`);

    // Check database cache first
    const dbCached = getCachedSearch(query);
    if (dbCached) {
        // Check if any platform has 0 results - if so, re-search that platform
        const needsRefresh = dbCached.sources.thingiverse === 0 ||
            dbCached.sources.printables === 0 ||
            dbCached.sources.makerworld === 0;

        if (needsRefresh) {
            console.log('Cache has missing platforms, performing partial refresh...');

            const searchPromises = [];

            // Only search platforms that had 0 results
            if (dbCached.sources.thingiverse === 0) {
                console.log('Re-searching Thingiverse...');
                searchPromises.push(searchThingiverse(query));
            } else {
                searchPromises.push(Promise.resolve(dbCached.results.filter(r => r.source === 'thingiverse')));
            }

            if (dbCached.sources.printables === 0) {
                console.log('Re-searching Printables...');
                searchPromises.push(searchPrintables(query));
            } else {
                searchPromises.push(Promise.resolve(dbCached.results.filter(r => r.source === 'printables')));
            }

            if (dbCached.sources.makerworld === 0) {
                console.log('Re-searching MakerWorld...');
                searchPromises.push(searchMakerWorld(query));
            } else {
                searchPromises.push(Promise.resolve(dbCached.results.filter(r => r.source === 'makerworld')));
            }

            const settledPromises = await Promise.allSettled(searchPromises);

            const thingiverseResults = settledPromises[0].status === 'fulfilled' ? settledPromises[0].value : [];
            const printablesResults = settledPromises[1].status === 'fulfilled' ? settledPromises[1].value : [];
            const makerworldResults = settledPromises[2].status === 'fulfilled' ? settledPromises[2].value : [];

            const allResults = [
                ...thingiverseResults,
                ...printablesResults,
                ...makerworldResults
            ];

            const response = {
                query,
                total: allResults.length,
                results: allResults,
                sources: {
                    thingiverse: thingiverseResults.length,
                    printables: printablesResults.length,
                    makerworld: makerworldResults.length
                }
            };

            // Update cache with new results
            cache.set(`search_${query}`, response);
            cacheSearch(query, allResults, response.sources);
            console.log('Cache updated with refreshed results');

            return res.json(response);
        }

        console.log(`Returning cached results from database (cached at: ${dbCached.cached_at})`);
        return res.json(dbCached);
    }

    // Check memory cache
    const cacheKey = `search_${query}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log('Returning cached results from memory');
        return res.json(cached);
    }

    try {
        // Search all platforms in parallel
        const searchPromises = await Promise.allSettled([
            searchThingiverse(query),
            searchPrintables(query),
            searchMakerWorld(query)
        ]);

        const thingiverseResults = searchPromises[0].status === 'fulfilled' ? searchPromises[0].value : [];
        const printablesResults = searchPromises[1].status === 'fulfilled' ? searchPromises[1].value : [];
        const makerworldResults = searchPromises[2].status === 'fulfilled' ? searchPromises[2].value : [];

        if (searchPromises[0].status === 'rejected') console.error('Thingiverse failed:', searchPromises[0].reason?.message);
        if (searchPromises[1].status === 'rejected') console.error('Printables failed:', searchPromises[1].reason?.message);
        if (searchPromises[2].status === 'rejected') console.error('MakerWorld failed:', searchPromises[2].reason?.message);

        const allResults = [
            ...thingiverseResults,
            ...printablesResults,
            ...makerworldResults
        ];

        const response = {
            query,
            total: allResults.length,
            results: allResults,
            sources: {
                thingiverse: thingiverseResults.length,
                printables: printablesResults.length,
                makerworld: makerworldResults.length
            }
        };

        console.log(`Total results: ${allResults.length}`);
        console.log('=== Search complete ===\n');

        // Cache results in both memory and database
        cache.set(cacheKey, response);
        cacheSearch(query, allResults, response.sources);
        console.log('Results cached to database');

        res.json(response);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    const cacheStats = db.prepare('SELECT COUNT(*) as count, MAX(updated_at) as last_update FROM searches').get();

    res.json({
        status: 'ok',
        scrapers: ['thingiverse', 'printables', 'makerworld'],
        browserRunning: browser !== null,
        cacheStats: {
            totalSearches: cacheStats.count,
            lastUpdate: cacheStats.last_update
        }
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    if (browser) {
        await browser.close();
        console.log('Browser closed');
    }
    db.close();
    console.log('Database closed');
    process.exit(0);
});

app.listen(PORT, async () => {
    console.log(`\n3D Model Search API running on http://localhost:${PORT}`);
    console.log('\nConfiguration:');
    console.log(`- Thingiverse: ✓ Puppeteer scraping`);
    console.log(`- Printables: ✓ Puppeteer scraping`);
    console.log(`- MakerWorld: ✓ Puppeteer scraping`);
    console.log('\nInitializing browser...');
    await initBrowser();
    console.log('Ready to accept requests!\n');
});