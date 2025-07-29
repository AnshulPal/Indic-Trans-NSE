import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseHTML } from 'linkedom';
import { JSDOM } from 'jsdom';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();
const app = express(), PORT = process.env.PORT || 9000;

// SQLite database setup
let db;
const DB_PATH = path.join(__dirname, 'translations.db');

// Initialize database
async function initDatabase() {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });

    // Create translations table with TTL
    await db.exec(`
      CREATE TABLE IF NOT EXISTS translations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_text TEXT NOT NULL,
        target_language TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 1,
        ttl_hours INTEGER DEFAULT 24,
        UNIQUE(source_text, target_language)
      )
    `);

    // Create index for faster lookups
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_translations_lookup
      ON translations(source_text, target_language)
    `);

    // Create index for TTL cleanup
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_translations_ttl
      ON translations(created_at, ttl_hours)
    `);

    console.log('[DB] SQLite database initialized successfully');

    // Clean up expired entries on startup
    await cleanupExpiredEntries();

  } catch (error) {
    console.error('[DB] Database initialization error:', error);
  }
}

// Production TTL Configuration for 10,000+ users
const TTL_CONFIG = {
  // Base TTL values (in hours)
  BASE_TTL: 48,           // 2 days base (increased from 24h)
  FREQUENT_ACCESS: 336,   // 2 weeks for frequently accessed (10+ hits)
  VERY_FREQUENT: 1440,    // 2 months for very frequent (50+ hits)
  POPULAR: 4320,          // 6 months for popular content (100+ hits)

  // Access thresholds
  FREQUENT_THRESHOLD: 10,
  VERY_FREQUENT_THRESHOLD: 50,
  POPULAR_THRESHOLD: 100,

  // Length multipliers
  LONG_TEXT_MULTIPLIER: 2,    // 100+ chars
  VERY_LONG_MULTIPLIER: 3,    // 500+ chars

  // Maximum TTL cap
  MAX_TTL: 8760,              // 1 year maximum

  // Cleanup intervals
  CLEANUP_INTERVAL_HOURS: 6,  // Run cleanup every 6 hours
  BATCH_CLEANUP_SIZE: 1000    // Clean up in batches of 1000
};

// Smart TTL logic optimized for production
function calculateTTL(accessCount, textLength) {
  let baseTTL = TTL_CONFIG.BASE_TTL;

  // Increase TTL based on access frequency
  if (accessCount >= TTL_CONFIG.POPULAR_THRESHOLD) {
    baseTTL = TTL_CONFIG.POPULAR;
  } else if (accessCount >= TTL_CONFIG.VERY_FREQUENT_THRESHOLD) {
    baseTTL = TTL_CONFIG.VERY_FREQUENT;
  } else if (accessCount >= TTL_CONFIG.FREQUENT_THRESHOLD) {
    baseTTL = TTL_CONFIG.FREQUENT_ACCESS;
  }

  // Increase TTL for longer texts (more expensive to translate)
  if (textLength > 500) {
    baseTTL *= TTL_CONFIG.VERY_LONG_MULTIPLIER;
  } else if (textLength > 100) {
    baseTTL *= TTL_CONFIG.LONG_TEXT_MULTIPLIER;
  }

  // Cap at maximum TTL
  return Math.min(baseTTL, TTL_CONFIG.MAX_TTL);
}

// Clean up expired entries with batching for production
async function cleanupExpiredEntries() {
  try {
    let totalCleaned = 0;
    let batchCount = 0;

    while (true) {
      const result = await db.run(`
        DELETE FROM translations
        WHERE datetime(created_at, '+' || ttl_hours || ' hours') < datetime('now')
        LIMIT ?
      `, [TTL_CONFIG.BATCH_CLEANUP_SIZE]);

      totalCleaned += result.changes;
      batchCount++;

      // Stop if no more entries to clean
      if (result.changes < TTL_CONFIG.BATCH_CLEANUP_SIZE) {
        break;
      }

      // Small delay between batches to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (totalCleaned > 0) {
      console.log(`[DB] Cleaned up ${totalCleaned} expired entries in ${batchCount} batches`);
    }

    return totalCleaned;
  } catch (error) {
    console.error('[DB] Cleanup error:', error);
    return 0;
  }
}

// Scheduled cleanup for production
function startScheduledCleanup() {
  const cleanupInterval = TTL_CONFIG.CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000; // Convert to milliseconds

  setInterval(async () => {
    console.log('[DB] Running scheduled cleanup...');
    await cleanupExpiredEntries();
  }, cleanupInterval);

  console.log(`[DB] Scheduled cleanup every ${TTL_CONFIG.CLEANUP_INTERVAL_HOURS} hours`);
}

// Get translation from cache
async function getCachedTranslation(sourceText, targetLanguage) {
  try {
    const row = await db.get(`
      SELECT translated_text, access_count, created_at, ttl_hours
      FROM translations
      WHERE source_text = ? AND target_language = ?
    `, [sourceText, targetLanguage]);

    if (row) {
      // Check if entry is expired
      const isExpired = await db.get(`
        SELECT 1 FROM translations
        WHERE source_text = ? AND target_language = ?
        AND datetime(created_at, '+' || ttl_hours || ' hours') < datetime('now')
      `, [sourceText, targetLanguage]);

      if (isExpired) {
        // Remove expired entry
        await db.run(`
          DELETE FROM translations
          WHERE source_text = ? AND target_language = ?
        `, [sourceText, targetLanguage]);
        return null;
      }

      // Update access count and last accessed time
      await db.run(`
        UPDATE translations
        SET access_count = access_count + 1,
            last_accessed = CURRENT_TIMESTAMP,
            ttl_hours = ?
        WHERE source_text = ? AND target_language = ?
      `, [calculateTTL(row.access_count + 1, sourceText.length), sourceText, targetLanguage]);

      return row.translated_text;
    }

    return null;
  } catch (error) {
    console.error('[DB] Cache lookup error:', error);
    return null;
  }
}

// Store translation in cache
async function cacheTranslation(sourceText, targetLanguage, translatedText) {
  try {
    const ttl = calculateTTL(1, sourceText.length);

    await db.run(`
      INSERT OR REPLACE INTO translations
      (source_text, target_language, translated_text, ttl_hours)
      VALUES (?, ?, ?, ?)
    `, [sourceText, targetLanguage, translatedText, ttl]);

    console.log(`[DB] Cached translation for "${sourceText.substring(0, 30)}..." (TTL: ${ttl}h)`);
  } catch (error) {
    console.error('[DB] Cache store error:', error);
  }
}

// Initialize database on startup
initDatabase();
startScheduledCleanup(); // Start scheduled cleanup on server startup

app.use('/client-scripts', express.static(__dirname + '/client-scripts'));

// IndicTrans2 language mapping (short code to IndicTrans2 code)
const INDIC_CODE_MAP = {
  hi: 'hin_Deva',
  bn: 'ben_Beng',
  as: 'asm_Beng',
  brx: 'brx_Deva',
  doi: 'doi_Deva',
  en: 'eng_Latn',
  gu: 'guj_Gujr',
  gom: 'gom_Deva',
  kn: 'kan_Knda',
  kas: 'kas_Arab', // default to Arabic, add kas_deva if needed
  kas_deva: 'kas_Deva',
  kas_arab: 'kas_Arab',
  mai: 'mai_Deva',
  ml: 'mal_Mlym',
  mr: 'mar_Deva',
  mni: 'mni_Beng',
  mni_mtei: 'mni_Mtei',
  npi: 'npi_Deva',
  or: 'ory_Orya',
  pa: 'pan_Guru',
  sa: 'san_Deva',
  sat: 'sat_Olck',
  sd: 'snd_Arab', // default to Arabic, add snd_deva if needed
  snd_deva: 'snd_Deva',
  snd_arab: 'snd_Arab',
  ta: 'tam_Taml',
  te: 'tel_Telu',
  ur: 'urd_Arab'
};

// Helper to extract leading/trailing symbols and core text
function extractCoreText(text) {
  // Match leading/trailing non-word (not letter/number) characters
  const match = text.match(/^([\s\W]*)([\p{L}\p{N}].*[\p{L}\p{N}])([\s\W]*)$/u);
  if (match) {
    return {
      leading: match[1],
      core: match[2],
      trailing: match[3]
    };
  } else {
    // If no match, treat all as core
    return { leading: '', core: text, trailing: '' };
  }
}

// Dynamic language route for all supported IndicTrans2 languages (short code)
app.get(['/:lang', '/:lang/*'], async (req, res, next) => {
  const { lang } = req.params;
  const mappedTarget = INDIC_CODE_MAP[lang];
  console.log('[DEBUG] Language route:', req.path, 'Lang:', lang, 'Mapped:', mappedTarget);

  if (!mappedTarget) {
    console.log('[DEBUG] Language not supported, falling back');
    return next(); // Not a supported language, fallback
  }

  const actualPath = req.path === `/${lang}` ? '/' : req.path.slice(lang.length + 1) || '/';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstreamUrl = `https://www.nseindia.com${actualPath}${qs}`;
  console.log('[DEBUG] Fetching', upstreamUrl);

  let response;
  try {
    response = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.nseindia.com/',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Upgrade-Insecure-Requests': '1',
        'Host': 'www.nseindia.com'
      }
    });
    console.log('[DEBUG] fetch returned', response.status);
  } catch (err) {
    console.error('[DEBUG] fetch error', err);
    return res.status(502).send('Upstream fetch failed');
  }

  if (!response.ok) {
    console.error('[DEBUG] upstream status not OK', response.status);
    return res.status(response.status).send(response.statusText);
  }

  const ct = response.headers.get('content-type') || '';
  res.setHeader('content-type', ct);
  console.log('[DEBUG] Upstream content-type:', ct);

  if (ct.includes('text/html')) {
    let html;
    try {
      html = await response.text();
    } catch (err) {
      console.error('[DEBUG] Error reading upstream HTML:', err);
      return res.status(502).send('Failed to read upstream HTML');
    }

    // --- DOM-based translation ---
    // Use DOMScanner1.js for homepage, linkedom for other pages
    const isHomepage = req.path === `/${lang}` || req.path === `/${lang}/`;

    if (isHomepage) {
      // Inject DOMScanner1.js for client-side translation, no server-side translation
      html = html.replace(
        /<\/body>/i,
        `\n  <script src="https://cdn.jsdelivr.net/npm/@transifex/dom/dist/browser.dom.min.js" defer></script>\n  <script src="/client-scripts/language-selector.js" defer></script>\n  <script src="/client-scripts/DOMScanner1.js" defer></script>\n</body>`
      );
      return res.send(html);
    }

    // Use JSDOM for homepage, linkedom for other pages
    let dom, document;
    // Remove the second isHomepage declaration and logic

    if (isHomepage) {
      console.log('[DEBUG] Using JSDOM for homepage');
      dom = new JSDOM(html);
      document = dom.window.document;
    } else {
      console.log('[DEBUG] Using linkedom for sub-pages');
      const parsed = parseHTML(html);
      document = parsed.document;
    }

    // Define your whitelist of tags to translate (expanded for better coverage)
    const selector = [
      'p', 'span', 'div', 'td', 'th', 'label', 'strong', 'em', 'li', 'a', 'button',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'i', 'u', 'small', 'mark', 'title',
      'caption', 'legend', 'option', 'figcaption', 'blockquote', 'cite', 'abbr',
      'article', 'section', 'header', 'footer', 'aside', 'main', 'nav', 'menu'
    ].join(',');

    // Collect all text nodes in whitelisted tags, filter for at least one Unicode letter
    const nodes = [];
    const letterRegex = /\p{L}/u; // Unicode letter
    const NAV_TAGS_SET = new Set(['A', 'BUTTON', 'LI', 'NAV', 'UL', 'OL']);

    // Function to check if text should be skipped (much less aggressive)
    const shouldSkipText = (text, parentTag) => {
      const trimmed = text.trim();

      // Skip only completely empty text
      if (trimmed.length === 0) return true;

      // Skip if no letters at all
      if (!letterRegex.test(trimmed)) return true;

      // Skip only extremely long text (increased limit significantly)
      if (trimmed.length > 2000) return true;

      // Skip navigation text only if extremely long or has newlines
      if (NAV_TAGS_SET.has(parentTag) && (trimmed.length > 300 || trimmed.includes('\n'))) {
        return true;
      }

      // Skip only very specific non-translatable patterns
      const skipPatterns = [
        /^\d+$/, // Just numbers
        /^[A-Z]{1}$/, // Single letter only
        /^[a-z]+\.com$/, // Domain names
        /^\d{1,2}:\d{2}$/, // Time format
        /^\d{1,2}\/\d{1,2}\/\d{4}$/, // Date format
      ];

      for (const pattern of skipPatterns) {
        if (pattern.test(trimmed)) return true;
      }

      return false;
    };

    document.querySelectorAll(selector).forEach(el => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { // Text node
          const text = node.textContent;
          if (!shouldSkipText(text, el.tagName)) {
            nodes.push(node);
          } else {
            // Debug: log what's being skipped (only for longer texts)
            if (text.trim().length > 10 && /\p{L}/u.test(text.trim())) {
              console.log(`[DEBUG] Skipped text: "${text.trim().substring(0, 50)}..." (tag: ${el.tagName}, length: ${text.trim().length})`);
            }
          }
        }
      }
    });

    console.log(`[DEBUG] Found ${nodes.length} text nodes after filtering`);

    // Also try to capture text from elements that might have been missed
    const additionalNodes = [];
    // Scan for additional text content in common elements
    const additionalSelectors = ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'article', 'section'];
    additionalSelectors.forEach(tag => {
      document.querySelectorAll(tag).forEach(el => {
        // Skip if already processed
        if (selector.includes(el.tagName.toLowerCase())) return;

        // Check for direct text content in elements
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          const text = el.textContent.trim();
          if (text.length > 0 && /\p{L}/u.test(text) && text.length <= 2000) {
            // Check if this looks like translatable content
            const hasLetters = /\p{L}/u.test(text);
            const notJustNumbers = !/^\d+$/.test(text);
            const notJustSymbols = !/^[\s\W]+$/.test(text);

            if (hasLetters && notJustNumbers && notJustSymbols) {
              additionalNodes.push(el.childNodes[0]);
              if (additionalNodes.length <= 10) { // Limit debug output
                console.log(`[DEBUG] Additional capture: "${text.substring(0, 50)}..." (tag: ${el.tagName}, length: ${text.length})`);
              }
            }
          }
        }
      });
    });

    // Combine all nodes
    const allNodes = [...nodes, ...additionalNodes];
    console.log(`[DEBUG] Total nodes after additional capture: ${allNodes.length}`);

    // Extract texts to translate (robust: only core, preserve prefix/suffix)
    const prefixSuffixes = [];
    const coreTexts = allNodes.map(n => {
      const { leading, core, trailing } = extractCoreText(n.textContent);
      prefixSuffixes.push({ leading, trailing });
      return core;
    });

    console.log(`[DEBUG] Found ${allNodes.length} text nodes, extracted ${coreTexts.length} core texts`);
    console.log(`[DEBUG] Sample core texts:`, coreTexts.slice(0, 10));

    // Show some examples of what we're capturing
    if (coreTexts.length > 0) {
      console.log(`[DEBUG] Text capture examples:`);
      coreTexts.slice(0, 10).forEach((text, i) => {
        console.log(`  ${i + 1}. "${text}"`);
      });
    }

    let translations = [];
    if (coreTexts.length > 0) {
      try {
        console.log(`[Node.js] Processing ${coreTexts.length} texts with SQLite cache`);

        // Check cache for each text
        const uncachedTexts = [];
        const uncachedIndices = [];
        const cachedTranslations = new Array(coreTexts.length);

        for (let i = 0; i < coreTexts.length; i++) {
          const text = coreTexts[i];
          const cachedTranslation = await getCachedTranslation(text, mappedTarget);

          if (cachedTranslation) {
            cachedTranslations[i] = cachedTranslation;
            console.log(`[CACHE] Hit for "${text.substring(0, 30)}..."`);
          } else {
            uncachedTexts.push(text);
            uncachedIndices.push(i);
          }
        }

        console.log(`[CACHE] Found ${coreTexts.length - uncachedTexts.length} cached, ${uncachedTexts.length} need translation`);

        // Translate uncached texts
        if (uncachedTexts.length > 0) {
          console.log(`[Node.js] Sending ${uncachedTexts.length} texts to API for translation`);

          const apiRes = await fetch('http://127.0.0.1:8005/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts: uncachedTexts, source_language: 'en', target_language: mappedTarget })
          });

          console.log(`[Node.js] API response status:`, apiRes.status);
          const data = await apiRes.json();
          console.log(`[Node.js] API response data:`, { translations_count: data.translations?.length, processing_time: data.processing_time });

          if (apiRes.ok && Array.isArray(data.translations)) {
            // Cache the new translations
            for (let i = 0; i < uncachedTexts.length; i++) {
              const originalText = uncachedTexts[i];
              const translatedText = data.translations[i];
              const cacheIndex = uncachedIndices[i];

              // Store in cache
              await cacheTranslation(originalText, mappedTarget, translatedText);

              // Store in results array
              cachedTranslations[cacheIndex] = translatedText;
            }
          } else {
            // Fallback to original texts
            for (let i = 0; i < uncachedTexts.length; i++) {
              cachedTranslations[uncachedIndices[i]] = uncachedTexts[i];
            }
          }
        }

        // Use cached translations as final result
        translations = cachedTranslations;

      } catch (err) {
        console.error('[DEBUG] Translation API error:', err);
        translations = coreTexts;
      }
    }

    console.log('Original texts:', coreTexts.slice(0, 10));
    console.log('Translations:', translations.slice(0, 10));

    // Check if translations are actually different
    const changedTranslations = translations.filter((trans, i) => trans !== coreTexts[i]);
    console.log(`[DEBUG] ${changedTranslations.length} out of ${translations.length} texts were actually translated`);

    if (changedTranslations.length > 0) {
      console.log('[DEBUG] Sample translation changes:');
      changedTranslations.slice(0, 5).forEach((trans, i) => {
        const origIndex = translations.indexOf(trans);
        const original = coreTexts[origIndex];
        console.log(`  "${original}" -> "${trans}"`);
      });
    } else {
      console.log('[DEBUG] WARNING: No translations were different from originals!');
      console.log('[DEBUG] This might indicate an API issue or all texts are already in target language');
    }

    // --- LINK REWRITING LOGIC ---
    function isNseUrl(url) {
      return url && url.match(/^https?:\/\/(www\.)?nseindia\.com/);
    }
    const ASSET_PATTERN = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp[34]|webm|ogg|wav|pdf|zip|csv|xml|json)(\?.*)?$/i;
    const NAV_TAGS = {
      a:     ['href'],
      form:  ['action'],
      area:  ['href']
    };
    Object.entries(NAV_TAGS).forEach(([tag, attrs]) => {
      document.querySelectorAll(tag).forEach(el => {
        attrs.forEach(attr => {
          let value = el.getAttribute(attr);
          if (!value) return;
          let newValue = value;
          if (isNseUrl(value)) {
            // leave as is
          } else if (value === '#' || value.startsWith('//')) {
            // leave as is
          } else if (value.startsWith(`/${lang}/`) || value.startsWith(`/${lang}`)) {
            // leave as is
          } else if (ASSET_PATTERN.test(value)) {
            // leave as is
          } else if (value.startsWith('/')) {
            newValue = `/${lang}${value}`;
          } else if (value.match(/^https?:\/\/(www\.)?nseindia\.com/)) {
            const path = value.replace(/^https?:\/\/(www\.)?nseindia\.com/, '');
            if (!ASSET_PATTERN.test(path)) {
              newValue = `/${lang}${path}`;
            }
          }
          if (newValue !== value) {
            el.setAttribute(attr, newValue);
          }
        });
      });
    });

    // Replace text nodes with translated <span>
    console.log(`[DEBUG] Starting DOM replacement for ${allNodes.length} nodes`);
    let replacedCount = 0;

    allNodes.forEach((node, i) => {
      try {
        const { leading, trailing } = prefixSuffixes[i];
        const translatedCore = translations[i] || coreTexts[i];
        const originalText = node.textContent;
        const finalText = leading + translatedCore + trailing;

        // Only replace if the text actually changed
        if (finalText !== originalText) {
          const span = document.createElement('span');
          span.setAttribute('data-translated', 'true');
          span.setAttribute('data-orig', originalText);
          span.textContent = finalText;

          if (node.parentNode && node.parentNode.contains(node)) {
            node.parentNode.replaceChild(span, node);
            replacedCount++;
            if (replacedCount <= 5) {
              console.log(`[DEBUG] Replaced: "${originalText}" -> "${finalText}"`);
            }
          } else {
            console.log(`[DEBUG] Node no longer in DOM, skipping: "${originalText}"`);
          }
        } else {
          console.log(`[DEBUG] No change needed: "${originalText}"`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error replacing node ${i}:`, error.message);
      }
    });

    console.log(`[DEBUG] Successfully replaced ${replacedCount} out of ${allNodes.length} nodes`);

    // Always inject language-selector.js on all HTML pages
    let finalHtml;
    if (isHomepage) {
      finalHtml = dom.serialize();
    } else {
      finalHtml = document.toString();
    }
    // Determine if this is a language homepage (e.g., /hi, /bn, /ta, etc.)
    const langHomeRegex = /^\/[a-z]{2}$/i;
    const isLangHomepage = langHomeRegex.test(req.path);
    // Inject language-selector.js always, DOMScanner.js only on language homepages
    if (isLangHomepage) {
      finalHtml = finalHtml.replace(
        /<\/body>/i,
        `\n  <script src="/client-scripts/language-selector.js" defer></script>\n  <script src="/client-scripts/DOMScanner.js" defer></script>\n</body>`
      );
    } else {
      finalHtml = finalHtml.replace(
        /<\/body>/i,
        `\n  <script src="/client-scripts/language-selector.js" defer></script>\n</body>`
      );
    }
    res.send(finalHtml);
  } else {
    response.body.pipe(res);
  }
});

// Add cache management endpoints
app.get('/cache/stats', async (req, res) => {
  try {
    // Basic stats
    const basicStats = await db.get('SELECT COUNT(*) as total, SUM(access_count) as total_access FROM translations');

    // Recent activity
    const recent1h = await db.get('SELECT COUNT(*) as count FROM translations WHERE last_accessed > datetime("now", "-1 hour")');
    const recent24h = await db.get('SELECT COUNT(*) as count FROM translations WHERE last_accessed > datetime("now", "-24 hours")');
    const recent7d = await db.get('SELECT COUNT(*) as count FROM translations WHERE last_accessed > datetime("now", "-7 days")');

    // TTL distribution
    const ttlStats = await db.all(`
      SELECT
        CASE
          WHEN ttl_hours <= 48 THEN 'short'
          WHEN ttl_hours <= 336 THEN 'medium'
          WHEN ttl_hours <= 1440 THEN 'long'
          ELSE 'very_long'
        END as ttl_category,
        COUNT(*) as count
      FROM translations
      GROUP BY ttl_category
    `);

    // Top accessed translations
    const topAccessed = await db.all(`
      SELECT source_text, target_language, access_count, ttl_hours, last_accessed
      FROM translations
      ORDER BY access_count DESC
      LIMIT 10
    `);

    // Language distribution
    const languageStats = await db.all(`
      SELECT target_language, COUNT(*) as count, SUM(access_count) as total_access
      FROM translations
      GROUP BY target_language
      ORDER BY total_access DESC
    `);

    // Database size info
    const dbSize = await db.get('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');

    res.json({
      // Basic metrics
      total_entries: basicStats.total,
      total_access: basicStats.total_access,
      average_access_per_entry: basicStats.total_access ? Math.round(basicStats.total_access / basicStats.total) : 0,

      // Recent activity
      recent_activity: {
        last_1_hour: recent1h.count,
        last_24_hours: recent24h.count,
        last_7_days: recent7d.count
      },

      // TTL distribution
      ttl_distribution: ttlStats,

      // Top accessed content
      top_accessed: topAccessed.map(item => ({
        text: item.source_text.substring(0, 50) + (item.source_text.length > 50 ? '...' : ''),
        language: item.target_language,
        access_count: item.access_count,
        ttl_hours: item.ttl_hours,
        last_accessed: item.last_accessed
      })),

      // Language distribution
      language_distribution: languageStats,

      // System info
      database_path: DB_PATH,
      database_size_bytes: dbSize.size,
      ttl_config: TTL_CONFIG,

      // Performance metrics
      cache_hit_rate: recent24h.count > 0 ? Math.round((recent24h.count / basicStats.total) * 100) : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/cache/cleanup', async (req, res) => {
  try {
    await cleanupExpiredEntries();
    res.json({ message: 'Cache cleanup completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy /api/translate to Flask translation API
app.use('/api/translate', createProxyMiddleware({
  target: 'http://127.0.0.1:8005',
  changeOrigin: true,
  pathRewrite: { '^/api/translate': '/api/translate' }
}));

// Proxy /translate to FastAPI translation API
app.use('/translate', createProxyMiddleware({
  target: 'http://127.0.0.1:8005',
  changeOrigin: true,
  pathRewrite: { '^/translate': '/translate' }
}));

// Fallback for everything else
app.use(createProxyMiddleware({
  target: 'https://www.nseindia.com',
  changeOrigin: true,
  logLevel: 'debug',
  onProxyReq: p => p.setHeader('host', 'www.nseindia.com')
}));

app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📝 Test URLs:`);
  console.log(`   - http://localhost:${PORT}/hi (Hindi homepage)`);
  console.log(`   - http://localhost:${PORT}/hi/ (Hindi homepage)`);
  console.log(`   - http://localhost:${PORT}/hi/about-us (Hindi about-us)`);
  console.log(`   - http://localhost:${PORT}/about-us (Direct about-us)`);
  console.log(`   - http://localhost:${PORT}/ (Direct homepage)`);
  console.log(`📊 Cache endpoints:`);
  console.log(`   - http://localhost:${PORT}/cache/stats (Cache statistics)`);
  console.log(`   - http://localhost:${PORT}/cache/cleanup (Manual cleanup)`);
});