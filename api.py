from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import time
import uvicorn
import logging
import sys
import os
import torch
import asyncio
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
from IndicTransToolkit import IndicProcessor

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("translation-api")

# Model and processor loading (do this once at startup)
model_name = "ai4bharat/indictrans2-en-indic-1B"
tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
model = AutoModelForSeq2SeqLM.from_pretrained(model_name, trust_remote_code=True)
ip = IndicProcessor(inference=True)

# Try GPU first, fallback to CPU if CUDA fails
try:
    if torch.cuda.is_available():
        DEVICE = "cuda"
        model = model.to(DEVICE)
        # Test GPU with a small tensor
        test_tensor = torch.tensor([1, 2, 3]).to(DEVICE)
        print(f"[INIT] GPU initialized successfully: {DEVICE}")
    else:
        DEVICE = "cpu"
        print(f"[INIT] CUDA not available, using CPU")
except Exception as e:
    print(f"[INIT] GPU initialization failed: {e}, falling back to CPU")
    DEVICE = "cpu"
    model = model.to(DEVICE)

# Optimized batch size for speed vs memory balance
MODEL_BATCH_SIZE = 24  # Increased for better handling of longer texts
MAX_WORKERS = 4  # Number of parallel workers for CPU processing

# Create FastAPI app
app = FastAPI(title="IndicTrans Translation API")

# Add CORS middleware to allow browser requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development - restrict this in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define request and response models
class TranslationRequest(BaseModel):
    texts: List[str]
    source_language: str = "en"  # Default to English
    target_language: str
    request_id: str = None  # Add optional request ID for tracking

class TranslationResponse(BaseModel):
    translations: List[str]
    processing_time: float

# Mock translation dictionary for testing and static content
MOCK_TRANSLATIONS = {
    # Existing translations
    "Market Capitalization": "बाजार पूंजीकरण",
    "Option Chain": "विकल्प श्रृंखला",
    "Daily Report": "दैनिक रिपोर्ट",
    "About Us": "हमारे बारे में",
    "Contact Us": "संपर्क करें",
    # Added translations
    "Market Turnover": "बाजार टर्नओवर",
    "Listings": "सूचीकरण",
    "IPO": "आईपीओ",
    "Circulars": "परिपत्र",
    "Holidays": "छुट्टियां",
    "Corporates": "कॉर्पोरेट्स",
    "Press Releases": "प्रेस विज्ञप्तियां",
    "Home": "होम",
    "About": "हमारे बारे में",
    "Market Data": "बाजार डेटा",
    "Invest": "निवेश करें",
    "List": "सूचीबद्ध करें",
    "Trade": "ट्रेड करें",
    "Regulation": "विनियमन",
    "Learn": "सीखें",
    "Resources": "संसाधन",
    "Complaints": "शिकायतें",
    "RESEARCH": "अनुसंधान",
    "Structure & Key Personnel": "संरचना और प्रमुख कर्मी",
    "Investor Relations": "निवेशक संबंध",
    "Awards and Recognitions": "पुरस्कार और मान्यताएं",
    "Regulations": "विनियम",
    "Event Gallery": "इवेंट गैलरी",
    "Media": "मीडिया",
    "Careers": "करियर",
    "NSE Group Companies": "एनएसई समूह की कंपनियां",
    "NSE Academy": "एनएसई अकादमी",
    "NSE Clearing": "एनएसई क्लियरिंग",
    "NSE Data & Analytics": "एनएसई डेटा और एनालिटिक्स",
    "NSE Foundation": "एनएसई फाउंडेशन",
    "NSE Indices": "एनएसई सूचकांक",
    "NSE International Exchange": "एनएसई अंतर्राष्ट्रीय एक्सचेंज",
    "NSE International Clearing": "एनएसई अंतर्राष्ट्रीय क्लियरिंग",
    "NSE Investments": "एनएसई निवेश",
    "View all": "सभी देखें",
    "Products & Services": "उत्पाद और सेवाएं",
    "Equity Market": "इक्विटी बाजार",
    "Indices": "सूचकांक",
    "Emerge Platform": "इमर्ज प्लेटफॉर्म",
    "Mutual Funds": "म्यूचुअल फंड",
    "Equity Derivatives": "इक्विटी डेरिवेटिव्स",
    "Currency Derivatives": "करेंसी डेरिवेटिव्स",
    "Commodity Derivatives": "कमोडिटी डेरिवेटिव्स",
    "Interest Rate Derivatives": "ब्याज दर डेरिवेटिव्स",
    "Fixed Income and Debt": "निश्चित आय और ऋण",
    "Public Issues": "सार्वजनिक निर्गम",
    "Disclaimer": "अस्वीकरण",
    "Privacy Policy": "गोपनीयता नीति",
    "Terms of Use": "उपयोग की शर्तें",
    "Copyright": "कॉपीराइट",
    "Feedback": "प्रतिक्रिया",
    "Site Map": "साइट मैप",
    "Website Policies": "वेबसाइट नीतियां",
    "Empanelment of Internal Auditors of Members": "सदस्यों के आंतरिक लेखा परीक्षकों का पैनल",
    "List of Empaneled Audit Firms": "पैनल में शामिल ऑडिट फर्मों की सूची",
    "Download NSE App": "एनएसई ऐप डाउनलोड करें",
    "Scan QR to Download App": "ऐप डाउनलोड करने के लिए क्यूआर स्कैन करें",
    "NSE NMFII": "एनएसई एनएमएफआईआई",
    "NSE GO-BID": "एनएसई गो-बिड",
    "Login to Mutual Fund": "म्यूचुअल फंड में लॉगिन करें",
    "NCFM": "एनसीएफएम",
}

def _translate_batch_on_gpu(batch_texts, src_lang, tgt_lang):
    global DEVICE  # Declare global at the beginning
    
    try:
        print(f"[GPU] Processing batch of {len(batch_texts)} texts")
        print(f"[GPU] Source language: {src_lang}, Target language: {tgt_lang}")
        print(f"[GPU] Sample texts: {batch_texts[:3]}")  # Show first 3 texts
        print(f"[GPU] Using device: {DEVICE}")
        
        # Process all texts fresh (no caching)
        if len(batch_texts) == 0:
            return []
        
        print(f"[GPU] Processing {len(batch_texts)} texts fresh (no caching)")
        
        # Add timeout protection (Windows compatible) - reduced for speed
        import signal
        import platform
        
        if platform.system() != 'Windows':
            def timeout_handler(signum, frame):
                raise TimeoutError("GPU processing timed out")
            
            # Set 30 second timeout (reduced for faster processing)
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(30)
        else:
            # Windows doesn't support SIGALRM, skip timeout for now
            print("[GPU] Timeout protection disabled on Windows")
        
        # Preprocess all texts
        batch = ip.preprocess_batch(batch_texts, src_lang=src_lang, tgt_lang=tgt_lang)
        
        # Tokenize entire batch
        inputs = tokenizer(
            batch,
            truncation=True,
            padding="longest",
            return_tensors="pt",
            return_attention_mask=True,
        )
        
        # Move to device with error handling
        try:
            inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        except Exception as device_error:
            print(f"[GPU] Device error, falling back to CPU: {device_error}")
            DEVICE = "cpu"
            model.to(DEVICE)
            inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        
        # Generate translations for entire batch (optimized for longer texts)
        with torch.no_grad():
            generated_tokens = model.generate(
                **inputs,
                use_cache=True,
                min_length=0,
                max_length=64,   # Increased for longer texts
                num_beams=1,     # Greedy decoding for speed
                num_return_sequences=1,
                do_sample=False, # Deterministic for speed
                early_stopping=True,
            )
        
        # Decode entire batch
        with tokenizer.as_target_tokenizer():
            decoded_tokens = tokenizer.batch_decode(
                generated_tokens.detach().cpu().tolist(),
                skip_special_tokens=True,
                clean_up_tokenization_spaces=True,
            )
        
        # Postprocess entire batch
        results = ip.postprocess_batch(decoded_tokens, lang=tgt_lang)
        
        # Ensure we have the right number of results
        if len(results) != len(batch_texts):
            print(f"[GPU] Warning: Result count mismatch. Expected {len(batch_texts)}, got {len(results)}")
            # Pad with original texts if needed
            while len(results) < len(batch_texts):
                results.append(batch_texts[len(results)])
            results = results[:len(batch_texts)]
        
        # Clean up GPU memory once for entire batch (optimized for speed)
        del inputs, generated_tokens
        # Only clear cache every 10 batches to reduce overhead and increase speed
        if DEVICE == "cuda" and hasattr(_translate_batch_on_gpu, '_batch_count'):
            _translate_batch_on_gpu._batch_count += 1
            if _translate_batch_on_gpu._batch_count % 10 == 0:  # Clear every 10 batches for speed
                try:
                    torch.cuda.empty_cache()
                except:
                    pass
        elif DEVICE == "cuda":
            _translate_batch_on_gpu._batch_count = 1
        
        print(f"[GPU] Batch processed successfully")
        if platform.system() != 'Windows':
            signal.alarm(0)  # Cancel timeout
        return results
        
    except TimeoutError:
        print(f"[GPU] Processing timed out after 60 seconds")
        if platform.system() != 'Windows':
            signal.alarm(0)  # Cancel timeout
        # Clean up GPU memory on timeout
        if DEVICE == "cuda":
            try:
                torch.cuda.empty_cache()
            except:
                pass
        return batch_texts
        
    except Exception as e:
        print(f"[GPU] Error in translation: {str(e)}")
        if platform.system() != 'Windows':
            signal.alarm(0)  # Cancel timeout
        # Clean up GPU memory on error
        if DEVICE == "cuda":
            try:
                torch.cuda.empty_cache()
            except:
                pass
        # Return original texts as fallback
        return batch_texts

def _translate_batch_parallel(batch_texts, src_lang, tgt_lang):
    """Translate a batch of texts using parallel processing with timeout and fallback"""
    try:
        print(f"[PARALLEL] Processing batch of {len(batch_texts)} texts")
        
        # For now, use sequential processing to avoid getting stuck
        # We'll implement safer parallel processing later
        print(f"[PARALLEL] Using sequential processing to avoid deadlocks")
        return _translate_batch_on_gpu(batch_texts, src_lang, tgt_lang)
        
    except Exception as e:
        print(f"[PARALLEL] Error in processing: {str(e)}")
        return batch_texts

def translate_texts_with_model(texts_to_translate, target_language):
    """Translate texts using the IndicTrans2 model"""
    print(f"[MODEL] Starting translation for {len(texts_to_translate)} texts to {target_language}")
    try:
        src_lang = "eng_Latn"
        
        # Direct mapping - server_try.js sends full IndicTrans2 codes
        # Validate that the target_language is a valid IndicTrans2 code
        valid_target_langs = {
            "hin_Deva", "mar_Deva", "tam_Taml", "tel_Telu", "guj_Gujr", "kan_Knda",
            "ben_Beng", "asm_Beng", "brx_Deva", "doi_Deva", "eng_Latn", "gom_Deva",
            "kas_Arab", "kas_Deva", "mai_Deva", "mal_Mlym", "mni_Beng", "mni_Mtei",
            "nep_Deva", "npi_Deva", "ory_Orya", "pan_Guru", "san_Deva", "sat_Olck",
            "snd_Arab", "snd_Deva", "urd_Arab"
        }
        
        # Use the target_language directly if it's a valid IndicTrans2 code
        if target_language in valid_target_langs:
            tgt_lang = target_language
        else:
            # Fallback mapping for short codes
            tgt_lang_map = {
                "hi": "hin_Deva", "mr": "mar_Deva", "ta": "tam_Taml", "te": "tel_Telu",
                "gu": "guj_Gujr", "kn": "kan_Knda", "ben": "ben_Beng", "bn": "ben_Beng",
                "asm": "asm_Beng", "brx": "brx_Deva", "doi": "doi_Deva", "eng": "eng_Latn",
                "gom": "gom_Deva", "kas": "kas_Arab", "kas_Deva": "kas_Deva", "mai": "mai_Deva",
                "mal": "mal_Mlym", "mni": "mni_Beng", "mni_Mtei": "mni_Mtei", "nep": "nep_Deva",
                "npi": "npi_Deva", "ory": "ory_Orya", "pan": "pan_Guru", "san": "san_Deva",
                "sat": "sat_Olck", "snd": "snd_Arab", "snd_Deva": "snd_Deva", "tel": "tel_Telu",
                "urd": "urd_Arab", "as": "asm_Beng", "en": "eng_Latn", "ks": "kas_Arab",
                "ml": "mal_Mlym", "ne": "nep_Deva", "or": "ory_Orya", "pa": "pan_Guru",
                "sa": "san_Deva", "sd": "snd_Arab", "ur": "urd_Arab"
            }
            tgt_lang = tgt_lang_map.get(target_language)
        
        if not tgt_lang:
            print(f"❌ Unknown language: {target_language}, returning original texts")
            return texts_to_translate
        
        print(f"Translating from {src_lang} to {tgt_lang}")
        
        # Simple filtering - capture almost everything with letters
        filtered_texts = []
        text_indices = []
        for i, text in enumerate(texts_to_translate):
            text = text.strip()
            # Very permissive filtering - capture almost everything
            if (len(text) > 0 and  # Any non-empty text
                any(c.isalpha() for c in text) and  # Must have at least one letter
                len(text) <= 1000):  # Allow much longer texts
                filtered_texts.append(text)
                text_indices.append(i)
            else:
                # Debug: log what's being filtered out
                if len(text) > 0:
                    print(f"[API] Filtered out: '{text[:50]}...' (length: {len(text)}, has_alpha: {any(c.isalpha() for c in text)})")
        
        print(f"[MODEL] Filtered {len(texts_to_translate)} -> {len(filtered_texts)} translatable texts")
        
        if not filtered_texts:
            print("[MODEL] No texts passed filtering, returning originals")
            return texts_to_translate
        
        # Process texts in batches for maximum efficiency
        all_translations = []
        batch_size = MODEL_BATCH_SIZE
        
        for i in range(0, len(filtered_texts), batch_size):
            sub_batch = filtered_texts[i:i + batch_size]
            print(f"Processing batch {i//batch_size + 1} with {len(sub_batch)} texts")
            
            try:
                translations_chunk = _translate_batch_on_gpu(sub_batch, src_lang, tgt_lang)
                all_translations.extend(translations_chunk)
            except Exception as batch_error:
                print(f"Error in batch: {str(batch_error)}")
                # Fallback: use original texts for this batch
                all_translations.extend(sub_batch)
        
        # Reconstruct full results with original texts for skipped items
        final_results = texts_to_translate.copy()
        for i, (orig_idx, translation) in enumerate(zip(text_indices, all_translations)):
            final_results[orig_idx] = translation
        
        return final_results
        
    except Exception as e:
        print(f"Error in translation: {str(e)}")
        return texts_to_translate

@app.post("/translate")
async def translate_texts(request: TranslationRequest):
    start_time = time.time()
    logger.info(f"Translating {len(request.texts)} texts from {request.source_language} to {request.target_language}")
    print(f"[API] Incoming translation request: {len(request.texts)} texts")
    print(f"[API] Source: {request.source_language}, Target: {request.target_language}")
    print(f"[API] Sample texts: {request.texts[:3]}")
    
    # Performance monitoring
    api_start = time.time()
    
    try:
        # For now, always use model translation (no mock translations)
        # This ensures all languages work properly
        texts_to_translate = request.texts
        
        print(f"[API] Translating {len(texts_to_translate)} texts using model")

        # Use the IndicTrans2 model for translation
        batch_results = translate_texts_with_model(texts_to_translate, request.target_language)
        print("[API] Model batch input:", texts_to_translate[:5])  # Show first 5
        print("[API] Model batch output:", batch_results[:5])      # Show first 5
        
        # Validate response format
        if not isinstance(batch_results, list):
            print(f"[API] ERROR: batch_results is not a list: {type(batch_results)}")
            batch_results = texts_to_translate
        
        if len(batch_results) != len(texts_to_translate):
            print(f"[API] WARNING: Result length mismatch: {len(batch_results)} vs {len(texts_to_translate)}")
            # Pad or truncate to match
            if len(batch_results) < len(texts_to_translate):
                batch_results.extend(texts_to_translate[len(batch_results):])
            else:
                batch_results = batch_results[:len(texts_to_translate)]
        
        processing_time = time.time() - start_time
        api_time = time.time() - api_start
        
        # Performance metrics
        texts_per_second = len(request.texts) / processing_time if processing_time > 0 else 0
        api_overhead = api_time - processing_time
        
        print(f"[API] Translation completed in {processing_time:.2f}s ({texts_per_second:.1f} texts/sec)")
        print(f"[API] Final response: {len(batch_results)} translations")
        logger.info(f"Translation completed in {processing_time:.2f}s ({texts_per_second:.1f} texts/sec)")
        logger.info(f"API overhead: {api_overhead:.3f}s")
        
        response_data = {"translations": batch_results, "processing_time": processing_time}
        print(f"[API] Response format: {type(response_data)} with keys: {list(response_data.keys())}")
        return response_data

    except Exception as e:
        logger.error(f"Translation error: {str(e)}")
        print(f"[API] ERROR: {str(e)}")
        # Return original texts as fallback
        return {"translations": request.texts, "processing_time": time.time() - start_time, "error": str(e)}

@app.post("/api/translate")
async def api_translate_texts(request: TranslationRequest):
    """Alternative endpoint for /api/translate - matches server_try.js proxy"""
    print(f"[API] Received /api/translate request")
    print(f"[API] Request details: {len(request.texts)} texts, target: {request.target_language}")
    
    try:
        # Use the same logic as the main endpoint
        return await translate_texts(request)
    except Exception as e:
        print(f"[API] /api/translate ERROR: {str(e)}")
        # Return original texts as fallback
        return {"translations": request.texts, "processing_time": 0.0, "error": str(e)}

@app.get("/")
async def root():
    """Health check endpoint"""
    return {"status": "online", "message": "IndicTrans Translation API is running"}

@app.get("/health")
def health_check():
    gpu_memory_info = {}
    if DEVICE == "cuda" and torch.cuda.is_available():
        gpu_memory_info = {
            "allocated": f"{torch.cuda.memory_allocated() / 1024**3:.2f} GB",
            "cached": f"{torch.cuda.memory_reserved() / 1024**3:.2f} GB",
            "total": f"{torch.cuda.get_device_properties(0).total_memory / 1024**3:.2f} GB"
        }
    
    return {
        "status": "healthy",
        "device": DEVICE,
        "model_loaded": model is not None,
        "gpu_memory": gpu_memory_info
    }

@app.get("/test-model")
def test_model():
    """Test endpoint to verify model is working correctly"""
    try:
        # Test with multiple sentences to test parallel processing
        test_texts = [
            "Hello world", "Welcome to NSE", "Market data", "Investment opportunities",
            "Trading platform", "Financial services", "Stock exchange", "Market analysis",
            "NSE", "BSE", "SEBI", "IPO", "ETF", "Mutual Fund", "Derivatives", "Equity"
        ]
        
        start_time = time.time()
        result = translate_texts_with_model(test_texts, "hin_Deva")
        processing_time = time.time() - start_time
        
        texts_per_second = len(test_texts) / processing_time if processing_time > 0 else 0
        
        return {
            "status": "success",
            "test_input": test_texts,
            "test_output": result,
            "processing_time": f"{processing_time:.3f}s",
            "texts_per_second": f"{texts_per_second:.1f}",
            "model_loaded": model is not None,
            "device": DEVICE,
            "model_name": model_name,
            "gpu_available": torch.cuda.is_available() if hasattr(torch, 'cuda') else False,
            "batch_size": MODEL_BATCH_SIZE,
            "max_workers": MAX_WORKERS
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "model_loaded": model is not None,
            "device": DEVICE,
            "gpu_available": torch.cuda.is_available() if hasattr(torch, 'cuda') else False
        }

@app.get("/debug-filter")
def debug_filter():
    """Debug endpoint to test text filtering"""
    test_texts = [
        "Hello", "123", "NSE", "Market Data", "A", "B", "C", "D", "E", "F",
        "Welcome to the National Stock Exchange", "Trading platform for investors",
        "Financial services and market analysis", "Investment opportunities available",
        "Derivatives trading", "Equity markets", "Mutual funds", "ETFs",
        "Initial Public Offering", "Securities and Exchange Board of India"
    ]
    
    # Test the filtering logic
    filtered_texts = []
    text_indices = []
    for i, text in enumerate(test_texts):
        text = text.strip()
        if (len(text) >= 1 and 
            any(c.isalpha() for c in text) and 
            not text.isdigit() and
            len(text) <= 200):
            filtered_texts.append(text)
            text_indices.append(i)
        else:
            print(f"[DEBUG] Filtered out: '{text}'")
    
    return {
        "original_texts": test_texts,
        "filtered_texts": filtered_texts,
        "filtered_indices": text_indices,
        "filtered_count": len(filtered_texts),
        "total_count": len(test_texts)
    }

# Run the server when executed directly
if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8005, reload=False)