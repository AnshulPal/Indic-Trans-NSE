/**
 * DOM Scanner Class
 * Scans the DOM for translatable content using TxNativeDOM
 */
class DOMScanner {
  /**
   * Create a new DOMScanner
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.debugMode = options.debugMode || false;
    this.rootElement = options.rootElement || document.body;

    try {
      if (typeof TransifexDOM === 'undefined' || typeof TransifexDOM.TxNativeDOM === 'undefined') {
        throw new Error('Transifex DOM library not found. Make sure the browser version is loaded.');
      }

      const TxNativeDOM = TransifexDOM.TxNativeDOM;
      this.txdom = new TxNativeDOM({
        debug: this.debugMode,
        // Only ignore non-content tags
        ignoreTags: options.ignoreTags || ['script', 'style', 'noscript', 'iframe', 'code', 'pre'],
        ignoreClass: options.ignoreClass || ['notranslate'],
        parseAttr: options.parseAttr || ['title', 'alt', 'placeholder', 'aria-label'],
        generateIds: true,
        preserveWhitespace: true,
        preserveEntityFormat: true,
        // Change the following:
        preserveTags: false,     // Try setting this to true
        parseFormatting: false, // Add this to prevent formatting from being recognized
        useVariablesForTags: false
      });

      if (this.debugMode) {
        console.log('DOMScanner initialized with options:', options);
      }
    } catch (error) {
      console.error('Failed to initialize DOMScanner:', error);
    }
  }

  /**
   * Initialize the scanner by attaching to the DOM
   */
  initialize() {
    // Attach to the document
    this.txdom.attachDOM(document, this.rootElement);

    // Set up mutation observer for page changes
    this.setupMutationObserver();

    // Set up navigation event listeners
    this.setupNavigationListeners();

    if (this.debugMode) {
      console.log('TxNativeDOM attached to rootElement:', this.rootElement);
    }
  }

  /**
   * Scan the DOM for translatable content
   * Always returns only the current rootElement's strings (no accumulation)
   * @returns {Object} - Translatable content
   */
  scan() {
    // Always refresh and clear any internal state before scanning
    if (typeof this.txdom.detachDOM === 'function') {
      this.txdom.detachDOM(document);
    }
    this.txdom.attachDOM(document, this.rootElement);
    if (this.txdom.refresh) {
      this.txdom.refresh();
    }
    const scanResult = this.txdom.getStringsJSON();

    if (this.debugMode) {
      this.logScanResults(scanResult);
    }

    return scanResult;
  }

  /**
   * Force a complete rescan of the DOM
   * This is more thorough than a regular scan and useful after page navigation
   * @returns {Object} - Translatable content
   */
  rescan() {
    if (this.debugMode) {
      console.log('Performing full rescan of DOM content...');
    }

    try {
      if (typeof this.txdom.detachDOM === 'function') {
        this.txdom.detachDOM(document);
      }
      this.txdom.attachDOM(document, this.rootElement);
      if (this.txdom.refresh) {
        this.txdom.refresh();
      }

      const results = this.scan();

      if (this.debugMode) {
        console.log(`Full rescan complete. Found ${Object.keys(results).length} translatable segments`);
      }

      return results;
    } catch (error) {
      console.error('Error during rescan:', error);
      return {};
    }
  }

  /**
   * Helper to check if an element or any ancestor has data-translated="true"
   * @param {Element} el - Element to check
   * @returns {boolean} - Whether the element or any ancestor has data-translated="true"
   */
  hasTranslatedAncestor(el) {
    while (el) {
      if (el.getAttribute && el.getAttribute('data-translated') === 'true') return true;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * Get translatable segments as an array for easier processing
   * @returns {Array} - Array of translatable segments
   */
  getSegmentsAsArray() {
    const scanResult = this.scan();
    // Convert object format to array format, but skip nodes with data-translated="true" (unless hydration reverted it), non-whitelisted tags, or ignored classes
    const segments = Object.entries(scanResult).map(([text, data]) => {
      return {
        id: data.meta?.id || text,
        text: text,
        meta: data.meta || {}
      };
    }).filter(segment => {
      // Try to find the element containing this segment
      let element = null;
      const elementId = segment.meta?.domNode || segment.meta?.elementId;
      if (elementId) {
        element = document.getElementById(elementId);
      }
      if (!element) {
        // Fallback: search for text content
        const textContainers = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div, a, button, label, li');
        for (const el of textContainers) {
          if (el.textContent?.trim() === segment.text) {
            element = el;
            break;
          }
        }
      }
      // Only translate if parent tag is in whitelist
      if (!element || !TRANSLATABLE_TAGS.has(element.tagName.toLowerCase())) {
        return false;
      }
      // Skip if element or any ancestor is actually translated or has ignored class
      let skip = false;
      let el = element;
      while (el) {
        if (isActuallyTranslated(el)) { skip = true; break; }
        if (hasIgnoredAncestor(el)) { skip = true; break; }
        el = el.parentElement;
      }
      return !skip;
    });
    console.log(`Converted ${segments.length} segments to array format (skipping already translated, non-whitelisted tags, and ignored classes)`);
    return segments;
  }

  /**
   * Check if an element is visible
   * @param {Element} el - Element to check
   * @returns {boolean} - Whether the element is visible
   */
  isElementVisible(el) {
    if (!el) return false;

    const style = window.getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           el.offsetParent !== null;
  }

  /**
   * Get only visible segments as an array
   * @returns {Array} - Array of visible translatable segments
   */
  getVisibleSegmentsAsArray() {
    const allSegments = this.getSegmentsAsArray();
    const visibleSegments = [];

    // Create a set for faster lookup if we've already determined an element is visible
    const visibleElementIds = new Set();
    const invisibleElementIds = new Set();

    for (const segment of allSegments) {
      // Try to find the element containing this segment
      const elementId = segment.meta?.domNode || segment.meta?.elementId;
      let element = null;
      let isVisible = false;

      // Check if we've already determined visibility for this element ID
      if (elementId) {
        if (visibleElementIds.has(elementId)) {
          visibleSegments.push(segment);
          continue;
        } else if (invisibleElementIds.has(elementId)) {
          continue;
        }

        // Look up element by ID
        element = document.getElementById(elementId);
      }

      // If no element found by ID, try to find by text content
      if (!element) {
        // More efficient query - only search elements that could contain text
        const textContainers = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div, a, button, label, li');
        for (const el of textContainers) {
          if (el.textContent?.trim() === segment.text) {
            element = el;
            break;
          }
        }
      }

      // Check visibility if we found an element
      if (element) {
        isVisible = this.isElementVisible(element);

        // Cache result for future lookups
        if (elementId) {
          if (isVisible) {
            visibleElementIds.add(elementId);
          } else {
            invisibleElementIds.add(elementId);
          }
        }

        if (isVisible) {
          visibleSegments.push(segment);
        }
      }
    }

    if (this.debugMode) {
      console.log(`Found ${visibleSegments.length} visible segments out of ${allSegments.length} total`);
    }

    return visibleSegments;
  }

  /**
   * Apply translations to the DOM using consistent segment IDs
   * @param {Object} translations - Key-value pairs of translations, keyed by ID or text
   */
  applyTranslations(translations) {
    // Disconnect observer to prevent feedback loop
    if (this.mutationObserver) this.mutationObserver.disconnect();
    this.txdom.toLanguage('translated', (text) => {
      // First check if there's a direct text match
      if (translations[text]) {
        // Wrap in span to mark as translated
        return `<span data-translated=\"true\">${translations[text]}</span>`;
      }
      // If not, look up by ID if available in the segment metadata
      const segmentData = this.txdom.getStringsJSON()[text];
      const id = segmentData?.meta?.id;
      if (id && translations[id]) {
        return `<span data-translated=\"true\">${translations[id]}</span>`;
      }
      // Fall back to original text
      return text;
    });
    if (this.debugMode) {
      console.log('Applied translations to DOM');
    }
    // Reconnect observer
    this.setupMutationObserver();
  }

  /**
   * Apply pseudo-translations (for testing)
   */
  applyPseudoTranslations() {
    this.txdom.pseudoTranslate();

    if (this.debugMode) {
      console.log('Applied pseudo-translations');
    }
  }

  /**
   * Restore original content
   */
  restoreContent() {
    this.txdom.toSource();

    if (this.debugMode) {
      console.log('Restored original content');
    }
  }

  /**
   * Setup mutation observer to detect major DOM changes (like page navigation)
   */
  setupMutationObserver() {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    const debouncedHandle = debounce(() => {
      if (nodesToTranslate.size === 0) return;
      // Only translate new/uncached text from changed nodes
      const segments = [];
      nodesToTranslate.forEach(node => {
        // Get all text nodes under this node
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        while ((textNode = walker.nextNode())) {
          const text = textNode.textContent.trim();
          if (text && !translationCache.hasOwnProperty(text)) {
            segments.push({ text });
          }
        }
      });
      nodesToTranslate.clear();
      const uniqueTexts = Array.from(new Set(segments.map(s => s.text)));
      if (uniqueTexts.length > 0) {
        window.translateAndApply && window.translateAndApply('hi', uniqueTexts);
      }
    }, 500);

    this.mutationObserver = new MutationObserver((mutations) => {
      let found = false;
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          // The parentElement of the changed text node
          const parent = mutation.target.parentElement;
          if (parent) collectTranslatableNodes(parent);
          found = true;
        }
        mutation.addedNodes.forEach(node => {
          collectTranslatableNodes(node);
          found = true;
        });
      }
      if (found) debouncedHandle();
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: true
    });
  }

  /**
   * Setup navigation event listeners for SPA routing
   */
  setupNavigationListeners() {
    // Listen for SPA navigation events
    window.addEventListener('popstate', () => {
      if (this.debugMode) {
        console.log('Navigation detected - rescanning DOM');
      }

      // Wait for the DOM to update after navigation
      setTimeout(() => {
        this.rescan();
      }, 300);
    });

    // Handle click events on links for SPA navigation
    document.addEventListener('click', (event) => {
      // If a link was clicked, rescan after a short delay
      if (event.target.tagName === 'A' || event.target.closest('a')) {
        setTimeout(() => {
          this.rescan();
        }, 300);
      }
    });
  }

  /**
   * Log scan results for debugging
   * @param {Object} scanResult - Results from scan
   */
  logScanResults(scanResult) {
    const count = Object.keys(scanResult).length;
    console.log(`DOM scan complete. Found ${count} translatable segments:`);

    if (count > 20) {
      console.log('First 20 segments:', Object.keys(scanResult).slice());
    } else {
      console.log('All segments:', Object.keys(scanResult));
    }
  }

  /**
   * Debug method to inspect the raw output from txdom.getStringsJSON()
   */
  debugStringsJSON() {
    const rawStrings = this.txdom.getStringsJSON();
    console.group('TxDOM Raw String Data');
    console.log('Full object:', rawStrings);

    // Log a few specific entries to examine their structure
    const entries = Object.entries(rawStrings);
    if (entries.length > 0) {
      console.log('Sample entries:');
      const sampleSize = Math.min(5, entries.length);

      for (let i = 0; i < sampleSize; i++) {
        const [text, data] = entries[i];
        console.log(`Entry ${i+1}:`);
        console.log('Text:', text);
        console.log('Data:', data);
        console.log('Meta:', data.meta);
      }

      // Check if any entries contain the {var0} pattern
      const varEntries = entries.filter(([text]) => text.includes('{var'));
      if (varEntries.length > 0) {
        console.log(`Found ${varEntries.length} entries with {var} placeholders:`);
        varEntries.slice(0, 3).forEach(([text, data], i) => {
          console.log(`Variable entry ${i+1}:`, text, data);
        });
      }
    }
    console.groupEnd();

    return rawStrings;
  }
}

// Initialize the DOM scanner when the document is ready and library is loaded
function initDOMScanner() {
  if (typeof TransifexDOM !== 'undefined' && typeof TransifexDOM.TxNativeDOM !== 'undefined') {
    window.domScanner = new DOMScanner({
      debugMode: true,
    });

    window.domScanner.initialize();
    console.log('DOMScanner initialized successfully');
  } else {
    console.warn('Transifex DOM library not loaded yet, will retry in 100ms');
    setTimeout(initDOMScanner, 100);
  }
}

// Begin initialization when the document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDOMScanner);
} else {
  // Document already loaded, initialize now
  initDOMScanner();
}

// Test function to log visible segments vs all segments
function testVisibleSegmentDetection() {
  if (!window.domScanner) {
    console.error("DOMScanner not initialized yet");
    return;
  }

  console.group("Testing Visible Segments Detection");

  // Get all segments
  const allSegments = window.domScanner.getSegmentsAsArray();
  console.log(`Total segments found: ${allSegments.length}`);

  // Get visible segments
  const visibleSegments = window.domScanner.getVisibleSegmentsAsArray();
  console.log(`Visible segments found: ${visibleSegments.length}`);

  // Calculate percentage visible
  const percentVisible = Math.round((visibleSegments.length / allSegments.length) * 100);
  console.log(`Percentage of content visible: ${percentVisible}%`);

  // Show first 10 visible segments
  if (visibleSegments.length > 0) {
    console.log("First 10 visible segments:");
    visibleSegments.slice(0, 10).forEach((segment, index) => {
      console.log(`${index + 1}. "${segment.text.substring(0, 50)}${segment.text.length > 50 ? '...' : ''}"`);
    });
  }

  // Show first 10 invisible segments (for comparison)
  const invisibleSegments = allSegments.filter(segment =>
    !visibleSegments.some(vs => vs.id === segment.id)
  );

  if (invisibleSegments.length > 0) {
    console.log("First 10 non-visible segments:");
    invisibleSegments.slice(0, 10).forEach((segment, index) => {
      console.log(`${index + 1}. "${segment.text.substring(0, 50)}${segment.text.length > 50 ? '...' : ''}"`);
    });
  }

  console.log("Run the following to test translation of visible content only:");
  console.log("testVisibleTranslation()");

  console.groupEnd();
}

// Test function to simulate translating only visible segments
function testVisibleTranslation() {
  if (!window.domScanner) {
    console.error("DOMScanner not initialized yet");
    return;
  }

  console.group("Testing Visible-Only Translation");

  // Get visible segments
  const visibleSegments = window.domScanner.getVisibleSegmentsAsArray();
  console.log(`Found ${visibleSegments.length} visible segments`);

  // Create mock translations (just append "[translated]" to each text)
  const mockTranslations = {};
  visibleSegments.forEach(segment => {
    mockTranslations[segment.text] = `${segment.text} [translated]`;
  });

  console.log("Applying translations to visible segments only...");
  console.log(`Translation object has ${Object.keys(mockTranslations).length} entries`);

  // Apply translations
  window.domScanner.applyTranslations(mockTranslations);

  console.log("✓ Translations applied!");
  console.log("Look at the page to see only visible content translated");
  console.log("To restore original content, run: domScanner.restoreContent()");

  console.groupEnd();
}

// Make these functions available globally for testing in browser console
window.testVisibleSegmentDetection = testVisibleSegmentDetection;
window.testVisibleTranslation = testVisibleTranslation;

// Let's improve the getVisibleSegmentsAsArray method for better performance
// by optimizing the element search and visibility detection
DOMScanner.prototype.getVisibleSegmentsAsArray = function() {
  const allSegments = this.getSegmentsAsArray();
  const visibleSegments = [];

  // Create a set for faster lookup if we've already determined an element is visible
  const visibleElementIds = new Set();
  const invisibleElementIds = new Set();

  for (const segment of allSegments) {
    // Try to find the element containing this segment
    const elementId = segment.meta?.domNode || segment.meta?.elementId;
    let element = null;
    let isVisible = false;

    // Check if we've already determined visibility for this element ID
    if (elementId) {
      if (visibleElementIds.has(elementId)) {
        visibleSegments.push(segment);
        continue;
      } else if (invisibleElementIds.has(elementId)) {
        continue;
      }

      // Look up element by ID
      element = document.getElementById(elementId);
    }

    // If no element found by ID, try to find by text content
    if (!element) {
      // More efficient query - only search elements that could contain text
      const textContainers = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div, a, button, label, li');
      for (const el of textContainers) {
        if (el.textContent?.trim() === segment.text) {
          element = el;
          break;
        }
      }
    }

    // Check visibility if we found an element
    if (element) {
      isVisible = this.isElementVisible(element);

      // Cache result for future lookups
      if (elementId) {
        if (isVisible) {
          visibleElementIds.add(elementId);
        } else {
          invisibleElementIds.add(elementId);
        }
      }

      if (isVisible) {
        visibleSegments.push(segment);
      }
    }
  }

  if (this.debugMode) {
    console.log(`Found ${visibleSegments.length} visible segments out of ${allSegments.length} total`);
  }

  return visibleSegments;
};

// --- MoxVeda-style Smart Client-Side Translation (Single Trigger, Debounced) ---

// IndicTrans2 language mapping (short code to IndicTrans2 code) - matches server_try.js
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

const TRANSLATABLE_TAGS = new Set([
  'p', 'span', 'div', 'td', 'th', 'label', 'strong', 'em', 'li', 'a', 'button',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'i', 'u', 'small', 'mark'
]);
const translatedSet = new Set(); // Tracks already translated text
const translationCache = {}; // In-memory cache: text -> translation

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

function scanAndTranslate() {
  const nodes = [];
  const selector = Array.from(TRANSLATABLE_TAGS).join(',');
  document.querySelectorAll(selector).forEach(el => {
    // Only process visible elements
    if (window.getComputedStyle(el).display === 'none' || el.offsetParent === null) return;
    el.childNodes.forEach(node => {
      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        if (
          text && /\D/.test(text) &&
          !translatedSet.has(text) &&
          !el.closest('[data-translated="true"]')
        ) {
          translatedSet.add(text);
          nodes.push({ node, text });
        }
      }
    });
  });
  if (!nodes.length) return;
  const texts = nodes.map(n => n.text);
  // Filter out texts that are only numbers or whitespace
  const uncached = texts.filter(t => !(t in translationCache) && /\D/.test(t) && t.trim() !== '');
  if (uncached.length === 0) {
    // All cached, just apply
    nodes.forEach(({ node, text }) => {
      const span = document.createElement('span');
      span.setAttribute('data-translated', 'true');
      span.setAttribute('data-orig', text);
      span.textContent = translationCache[text];
      node.parentNode.replaceChild(span, node);
    });
    if (window.domScanner && window.domScanner.debugMode) {
      console.log('[DOMScanner] All texts cached. Skipping translation call.');
    }
    return;
  }
  // Fetch uncached translations
  // Dynamically detect language code from URL and map to IndicTrans2 code
  let targetLang = 'hin_Deva'; // Default to Hindi
  const pathSegments = window.location.pathname.split('/');
  if (pathSegments[1] && pathSegments[1].length === 2) {
    const shortCode = pathSegments[1];
    targetLang = INDIC_CODE_MAP[shortCode] || 'hin_Deva'; // Map short code to full code
  }
  console.log('[DOMScanner1] Sending translation request:', { texts: uncached, target_language: targetLang });
  fetch('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: uncached, target_language: targetLang })
  })
    .then(r => {
      console.log('[DOMScanner1] Received response status:', r.status);
      return r.json();
    })
    .then(r => {
      console.log('[DOMScanner1] Translation response:', r);
      uncached.forEach((t, i) => {
        translationCache[t] = (r.translations && r.translations[i]) || t;
      });
      // Now apply all
      nodes.forEach(({ node, text }) => {
        const translated = translationCache[text];
        if (translated && translated !== text) {
          const span = document.createElement('span');
          span.setAttribute('data-translated', 'true');
          span.setAttribute('data-orig', text);
          span.textContent = translated;
          if (node.parentNode) {
            node.parentNode.replaceChild(span, node);
          } else {
            console.warn('[DOMScanner1] Could not replace node, parentNode missing:', text);
          }
        }
      });
      if (window.domScanner && window.domScanner.debugMode) {
        console.log('[DOMScanner] Translations applied!');
      }
    })
    .catch((err) => {
      console.error('[DOMScanner1] Translation request failed:', err);
      // Fallback: just apply original text
      nodes.forEach(({ node, text }) => {
        const span = document.createElement('span');
        span.setAttribute('data-translated', 'true');
        span.setAttribute('data-orig', text);
        span.textContent = text;
        node.parentNode.replaceChild(span, node);
      });
    });
}

// Add this function for client-side link rewriting
function rewriteLinksForLanguage(lang) {
  const NAV_TAGS = {
    a: ['href'],
    form: ['action'],
    area: ['href']
  };
  const ASSET_PATTERN = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp[34]|webm|ogg|wav|pdf|zip|csv|xml|json)(\?.*)?$/i;
  Object.entries(NAV_TAGS).forEach(([tag, attrs]) => {
    document.querySelectorAll(tag).forEach(el => {
      attrs.forEach(attr => {
        let value = el.getAttribute(attr);
        if (!value) return;
        let newValue = value;
        if (value.startsWith(`/${lang}/`) || value.startsWith(`/${lang}`)) {
          // already rewritten
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
}

window.addEventListener('load', () => {
  setTimeout(() => {
    window.domScanner = new DOMScanner({ debugMode: false });
    window.domScanner.initialize();
    // Use requestIdleCallback for smoother UX on large pages
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => {
        scanAndTranslate();
        // Single debounced MutationObserver for dynamic content
        const observer = new MutationObserver(
          debounce(() => {
            scanAndTranslate(); // will use cache and skip already translated
          }, 1000)
        );
        observer.observe(document.body, { childList: true, subtree: true });
      });
    } else {
      window.setTimeout(() => {
        scanAndTranslate();
        // Single debounced MutationObserver for dynamic content
        const observer = new MutationObserver(
          debounce(() => {
            scanAndTranslate(); // will use cache and skip already translated
          }, 1000)
        );
        observer.observe(document.body, { childList: true, subtree: true });
      }, 0);
    }
  }, 300);
});

// After applying translations, rewrite links for language
let lang = 'hi';
const pathSegments = window.location.pathname.split('/');
if (pathSegments[1] && pathSegments[1].length === 2) {
  lang = pathSegments[1];
}
rewriteLinksForLanguage(lang);

// Add this line at the end of your DOMScanner.js file
window.debugTxDOM = function() {
  if (!window.domScanner) {
    console.error('DOMScanner not initialized');
    return;
  }
  return window.domScanner.debugStringsJSON();
};

// --- Translation API Integration ---
/**
 * Get the current target language code from URL and map to IndicTrans2 format
 * @returns {string} - The mapped target language code
 */
function getCurrentTargetLanguage() {
  const pathSegments = window.location.pathname.split('/');
  if (pathSegments[1] && pathSegments[1].length === 2) {
    const shortCode = pathSegments[1];
    return INDIC_CODE_MAP[shortCode] || 'hin_Deva'; // Map short code to full code
  }
  return 'hin_Deva'; // Default to Hindi
}

/**
 * Fetch translations from the backend translation API
 * @param {Object} payload - { texts: string[], target_language?: string }
 * @returns {Promise<{translations: string[]}>}
 */
async function fetchTranslations(payload) {
  // Ensure target_language is properly mapped
  if (!payload.target_language) {
    payload.target_language = getCurrentTargetLanguage();
  } else if (payload.target_language.length === 2) {
    // If it's a short code, map it
    payload.target_language = INDIC_CODE_MAP[payload.target_language] || payload.target_language;
  }
  
  console.log('[fetchTranslations] Sending request:', payload);
  
  const response = await fetch("/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Translation API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('[fetchTranslations] Received response:', data);
  return data;
}


function hasIgnoredAncestor(el) {
  while (el) {
    if (el.classList) {
      for (const cls of el.classList) {
        if (IGNORE_CLASSES.has(cls)) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

// Track nodes needing translation
let nodesToTranslate = new Set();

// Helper to collect translatable nodes from a subtree
function collectTranslatableNodes(node) {
  if (node.nodeType !== 1) return; // Only elements
  if (!TRANSLATABLE_TAGS.has(node.tagName.toLowerCase())) return;
  if (hasIgnoredAncestor(node) || window.domScanner.hasTranslatedAncestor(node)) return;
  nodesToTranslate.add(node);
  // Also check children
  node.querySelectorAll && node.querySelectorAll(Array.from(TRANSLATABLE_TAGS).join(',')).forEach(child => {
    if (!hasIgnoredAncestor(child) && !window.domScanner.hasTranslatedAncestor(child)) {
      nodesToTranslate.add(child);
    }
  });
}

// Use requestIdleCallback for chunked processing
function processNodesInChunks(nodes, processFn, done) {
  const nodeArr = Array.from(nodes);
  let i = 0;
  function nextChunk(deadline) {
    while (i < nodeArr.length && deadline.timeRemaining() > 0) {
      processFn(nodeArr[i]);
      i++;
    }
    if (i < nodeArr.length) {
      requestIdleCallback(nextChunk);
    } else {
      done();
    }
  }
  requestIdleCallback(nextChunk);
}

// Utility: Check if a node is actually translated (handles hydration revert)
function isActuallyTranslated(el) {
  if (!el || el.getAttribute('data-translated') !== 'true') return false;
  const orig = el.getAttribute('data-orig');
  const text = el.textContent.trim();
  // If data-orig is present and matches, hydration reverted it
  if (orig && orig === text) return false;
  // If no data-orig, check for Devanagari (Hindi)
  const devanagari = /\p{Script=Devanagari}/u;
  if (!orig && !devanagari.test(text)) return false;
  return true;
}

// Add at the top of the file (or near other constants):
const IGNORE_CLASSES = new Set(['notranslate', 'error-overlay', 'system-message']);