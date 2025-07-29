import { Transform } from 'stream';
import { Parser } from 'htmlparser2';
import fetch from 'node-fetch';

const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'canvas']);
const NON_VISIBLE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'canvas',
  'title', 'meta', 'link', 'head', 'base'
]);
const TRANSLATABLE_TAGS = new Set([
  'p', 'span', 'div', 'td', 'th', 'label', 'strong', 'em', 'li', 'a', 'button',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'i', 'u', 'small', 'mark', 
  'blockquote', 'figcaption', 'summary', 'caption', 'dd', 'dt', 'legend',
  'footer', 'header', 'article', 'section', 'aside', 'nav', 'main'
]);
const NON_TRANSLATABLE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'canvas',
  'title', 'meta', 'link', 'head', 'base', 'option', 'select',
  'code', 'pre', 'textarea', 'input', 'button[type="submit"]', 'time'
]);
const BATCH_SIZE = 3; // Reduced from 5 to 3 for faster processing
const SELF_CLOSING_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Creates a streaming HTML translator that:
 * 1. Rewrites navigation URLs to preserve language prefix
 * 2. Adds <base href="/lang/"> to <head>
 * 3. Translates text nodes in batches
 */
export function createHtmlTranslatorStream({ lang }) {
  let buffer = [];
  let tagStack = [];
  let headProcessed = false;
  let inIgnoredTag = false;
  let openTags = [];

  // Micro-batching and concurrency control
  let batchTimer = null;
  const BATCH_DELAY = 20; // Reduced for faster response
  const MAX_CONCURRENT = 1; // Reduced to 1 to prevent GPU overload
  let activeBatches = 0;
  const batchQueue = [];
  let flushDoneCallbacks = [];
  
  // No caching - always translate fresh

  // Create separate input and output transforms
  const inputTransform = new Transform({
    decodeStrings: false,
    writableObjectMode: false,
    readableObjectMode: false,
    transform(chunk, encoding, callback) {
      parser.write(chunk.toString('utf8'));
      callback();
    },
    flush(callback) {
      parser.end();
      callback();
    }
  });

  const outputTransform = new Transform({
    decodeStrings: false,
    writableObjectMode: false,
    readableObjectMode: false,
    transform(chunk, encoding, callback) {
      this.push(chunk);
      callback();
    }
  });

  // Helper to check if a URL is from NSE
  function isNseUrl(url) {
    return url && url.match(/^https?:\/\/(www\.)?nseindia\.com/);
  }

  // Navigation tags and attributes to rewrite
  const NAV_TAGS = {
    a:     ['href'],
    form:  ['action'],
    area:  ['href']
  };

  // Asset URL pattern to avoid rewriting
  const ASSET_PATTERN = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp[34]|webm|ogg|wav|pdf|zip|csv|xml|json)(\?.*)?$/i;

  // HTML escaping for text nodes
  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, function (m) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[m];
    });
  }

  // Helper to escape HTML entities
  function escapeHTML(str) {
    return str.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  }

  // Helper to check if text is whitespace
  function isWhitespace(text) {
    return !text || !text.trim();
  }

  // Output HTML as we parse
  function emit(data) {
    if (typeof data === 'string') {
      // Only log first 120 chars to avoid spam
      const preview = data.length > 120 ? data.slice(0, 120) + '...' : data;
      console.log('[EMIT]', preview);
    }
    outputTransform.push(data);
  }

  // Helper to process the next batch in the queue
  async function processNextBatch() {
    if (activeBatches >= MAX_CONCURRENT || batchQueue.length === 0) return;
    activeBatches++;
    const { snippets, originals, done } = batchQueue.shift();
    
    try {
      console.log(`[Translator] Processing batch of ${snippets.length} texts`);
      
      // Process all texts fresh (no caching)
      const texts = snippets;
      const translations = Array(snippets.length);
      
      // Call API for all texts
      if (texts.length > 0) {
        try {
          const startTime = Date.now();
          console.log(`[Translator] Sending ${texts.length} texts to API`);
          
          // Add timeout to prevent hanging requests
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
          
          const res = await fetch('http://127.0.0.1:8000/translate', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({ 
              texts: texts, 
              target_language: lang 
            }),
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          const data = await res.json();
          const elapsed = Date.now() - startTime;
          
          if (res.ok && data && Array.isArray(data.translations)) {
            console.log(`[Translator] API returned ${data.translations.length} translations in ${elapsed}ms`);
            
            // Update translations array
            data.translations.forEach((translatedText, i) => {
              translations[i] = translatedText || texts[i];
            });
          } else {
            console.error('[Translator] API returned invalid response:', data);
            
            // Use original text for failed translations
            texts.forEach((text, i) => {
              translations[i] = text;
            });
          }
        } catch (err) {
          console.error('[Translator] API request failed:', err.message);
          
          // Use original text for failed translations
          texts.forEach((text, i) => {
            translations[i] = text;
          });
          
          // Add delay to prevent rapid retries
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } else {
        console.log('[Translator] No texts to translate');
      }
      
      // Output translated spans
      for (let i = 0; i < snippets.length; i++) {
        const originalText = originals[i];
        const translatedText = translations[i] || snippets[i];
        const spanHtml = `<span data-translated="true" data-orig="${escapeHtml(originalText)}">${escapeHtml(translatedText)}</span>`;
        
        console.log(`[Translator] Output: "${originalText}" -> "${translatedText}"`);
        emit(spanHtml);
      }
    } finally {
      activeBatches--;
      processNextBatch();
      if (done) done();
    }
  }

  // New flushBuffer: called by timer or when batch is full
  function flushBuffer(done) {
    if (buffer.length === 0) {
      if (done) done();
      return;
    }
    
    // Log batch info
    console.log(`[Translator] Flushing batch of ${buffer.length} texts`);
    
    const snippets = buffer.map(i => i.snippet);
    const originals = buffer.map(i => i.originalText);
    
    // Add done callback to list
    if (done) {
      flushDoneCallbacks.push(done);
      done = () => {
        for (const cb of flushDoneCallbacks) {
          cb();
        }
        flushDoneCallbacks = [];
      };
    }
    
    batchQueue.push({ snippets, originals, done });
    buffer = [];
    processNextBatch();
  }

  // htmlparser2 parser
  const parser = new Parser({
    onopentag(name, attribs) {
      tagStack.push(name);
      openTags.push(name);
      if (IGNORED_TAGS.has(name)) inIgnoredTag = true;
      console.log('[PARSE] <' + name + '> stack:', tagStack.join(' > '));

      // Special case for <head>
      if (name === 'head' && !headProcessed) {
        headProcessed = true;
        emit('<head>');
        emit(`<base href="/${lang}/">\n`);
        return;
      }

      // Navigation URL rewriting
      let attrs = '';
      for (const [key, value] of Object.entries(attribs)) {
        let newValue = value;
        if (NAV_TAGS[name]?.includes(key)) {
          if (isNseUrl(value)) {
            // leave as is
          } else if (!value || value === '#' || value.startsWith('//')) {
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
        }
        attrs += ` ${key}="${escapeHtml(newValue)}"`;
      }
      if (SELF_CLOSING_TAGS.has(name)) {
        emit(`<${name}${attrs}>`);
      } else {
        emit(`<${name}${attrs}>`);
      }
    },
    ontext(text) {
      const parent = tagStack[tagStack.length - 1] || '';
      
      // Skip empty or whitespace-only text
      if (!text || !text.trim()) {
        emit(text);
        return;
      }
      
      const trimmed = text.trim();
      
      // Enhanced filtering to skip unwanted content
      const isUnwanted = (text) => {
        if (text.length < 2) return true; // Reduced from 3 to 2
        if (/^[_\-\s\d]+$/.test(text)) return true; // Only underscores, dashes, spaces, numbers
        if (/^[^\p{L}]*$/.test(text)) return true; // No letters at all
        if (text.length > 200) return true; // Increased from 100 to 200
        if (/^[0-9\.,\s]+$/.test(text)) return true; // Only numbers, commas, periods, spaces
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return true; // Time format
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return true; // Date format
        if (/^[A-Z]{1,3}$/.test(text)) return true; // Very short acronyms only
        return false;
      };
      
      // Skip number-only strings, very short text, and unwanted content
      if (!/\D/.test(trimmed) || trimmed.length < 3 || isUnwanted(trimmed)) {
        emit(text);
        return;
      }
      
      console.log('[PARSE] text node in <' + parent + '>:', JSON.stringify(trimmed.slice(0, 50)));
      
      // Check if this text node should be translated
      if (
        !inIgnoredTag &&
        (
          TRANSLATABLE_TAGS.has(parent) || 
          (parent === 'div' && trimmed.length > 8) ||   // Reduced from 10 to 8
          (!NON_TRANSLATABLE_TAGS.has(parent) && trimmed.length > 10) // Reduced from 15 to 10
        ) &&
        trimmed.length > 0 &&
        /[\p{L}]{2,}/u.test(trimmed) // At least 2 letters
      ) {
        // Add to translation buffer for batch processing
        buffer.push({ 
          snippet: trimmed,
          originalText: text
        });
        
        // If buffer is full, flush it
        if (buffer.length >= BATCH_SIZE) {
          flushBuffer();
        }
        
        // Schedule a timer to flush any remaining texts
        if (batchTimer) clearTimeout(batchTimer);
        batchTimer = setTimeout(() => flushBuffer(), BATCH_DELAY);
      } else {
        emit(text);
      }
    },
    onclosetag(name) {
      flushBuffer(); // flush any pending translations before closing a tag
      if (tagStack[tagStack.length - 1] === name) {
        tagStack.pop();
      } else {
        console.warn('[WARN] Mismatched close tag:', name, 'stack:', tagStack);
        const idx = tagStack.lastIndexOf(name);
        if (idx !== -1) tagStack.splice(idx, 1);
      }
      if (openTags.at(-1) !== name) {
        console.warn(`Mismatched tag: ${name}`);
      }
      openTags.pop();
      if (IGNORED_TAGS.has(name)) inIgnoredTag = false;
      console.log('[PARSE] </' + name + '> stack:', tagStack.join(' > '));
      emit(`</${name}>`);
    },
    oncomment(data) {
      console.log('[PARSE] <!--comment-->', data.slice(0, 80));
      emit(`<!--${data}-->`);
    },
    onprocessinginstruction(name, data) {
      console.log('[PARSE] <PI>', data);
      emit(`<${data}>`);
    },
    oncdatastart() {
      console.log('[PARSE] <![CDATA[ start');
      emit('<![CDATA[');
    },
    oncdataend() {
      console.log('[PARSE] ]]> end');
      emit(']]>');
    },
    onend() {
      console.log('[PARSE] END OF DOCUMENT');
      // Clear any pending flush timers
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      
      // Log completion statistics
      console.log(`[Translator] Translation processing complete`);
      
      // Ensure all batches are processed before ending the stream
      flushBuffer(() => {
        console.log('[Translator] Final flush complete, waiting for all batches to finish');
        
        // Wait for all active batches to finish
        const checkDone = () => {
          if (activeBatches === 0 && batchQueue.length === 0) {
            console.log('[Translator] All translation batches complete, ending stream');
            outputTransform.push(null);
          } else {
            console.log(`[Translator] Waiting for ${activeBatches} active batches and ${batchQueue.length} queued batches`);
            setTimeout(checkDone, 100);
          }
        };
        checkDone();
      });
    },
    onerror(err) {
      console.error('[PARSE] parser error:', err.message);
      emit(`<!-- parser error: ${err.message} -->`);
      outputTransform.push(null);
    }
  }, { decodeEntities: true });

  return {
    input: inputTransform,
    output: outputTransform,
    flushRemaining: flushBuffer
  };
}

/**
 * Transform stream for injecting scripts into streamed HTML.
 * Looks for </body> and injects scripts before it.
 */
export function createInjectionTransform() {
  let buffer = '';
  const injection = `\n  <script src="/static/DOMScanner.js" defer></script>\n  <script src="/static/translation-debug.js" defer></script>\n`;
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const idx = buffer.lastIndexOf('</body>');
      if (idx !== -1) {
        // Found </body>, inject scripts
        const before = buffer.slice(0, idx);
        const after = buffer.slice(idx);
        this.push(before + injection + after);
        buffer = '';
      } else if (buffer.length > 2048) {
        // Pass through all but the last 2KB (in case </body> is split)
        this.push(buffer.slice(0, -2048));
        buffer = buffer.slice(-2048);
      }
      callback();
    },
    flush(callback) {
      if (buffer) this.push(buffer);
      callback();
    }
  });
}