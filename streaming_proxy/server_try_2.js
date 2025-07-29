import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseHTML } from 'linkedom';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config();
const app = express(), PORT = process.env.PORT || 9000;

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
    // Use JSDOM for homepage, linkedom for other pages
    let dom, document;
    const isHomepage = req.path === `/${lang}` || req.path === `/${lang}/`;
    
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
        console.log(`[Node.js] Sending ${coreTexts.length} texts in a single API call to ${mappedTarget}`);
        console.log(`[Node.js] API request body:`, { texts: coreTexts.slice(0, 3), source_language: 'en', target_language: mappedTarget });
        
        // Use IndicTrans2 translation endpoint here
        const apiRes = await fetch('http://127.0.0.1:8005/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: coreTexts, source_language: 'en', target_language: mappedTarget })
        });
        
        console.log(`[Node.js] API response status:`, apiRes.status);
        const data = await apiRes.json();
        console.log(`[Node.js] API response data:`, { translations_count: data.translations?.length, processing_time: data.processing_time });
        
        if (apiRes.ok && Array.isArray(data.translations)) {
          translations = data.translations;
        } else {
          translations = coreTexts;
        }
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

    // Inject client-side scripts before </body
    let finalHtml;
    if (isHomepage) {
      finalHtml = dom.serialize();
    } else {
      finalHtml = document.toString();
    }
    finalHtml = finalHtml.replace(
      /<\/body>/i,
      `\n  <script src="/client-scripts/DOMScanner.js" defer></script>\n</body>`
    );
    res.send(finalHtml);
  } else {
    response.body.pipe(res);
  }
});

// Proxy /api/translate to Flask translation API
app.use('/api/translate', createProxyMiddleware({
  target: 'http://127.0.0.1:8005',
  changeOrigin: true,
  pathRewrite: { '^/api/translate': '/api/translate' }
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
});