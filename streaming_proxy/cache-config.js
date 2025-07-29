// Cache Configuration for Production (10,000+ users)
// This file can be easily modified without touching the main server code

const PRODUCTION_TTL_CONFIG = {
  // ===== TTL VALUES (in hours) =====
  BASE_TTL: 48,           // 2 days - base TTL for new translations
  FREQUENT_ACCESS: 336,   // 2 weeks - for content accessed 10+ times
  VERY_FREQUENT: 1440,    // 2 months - for content accessed 50+ times  
  POPULAR: 4320,          // 6 months - for content accessed 100+ times
  MAX_TTL: 8760,          // 1 year - maximum TTL cap
  
  // ===== ACCESS THRESHOLDS =====
  FREQUENT_THRESHOLD: 10,      // Hits needed for 2-week TTL
  VERY_FREQUENT_THRESHOLD: 50, // Hits needed for 2-month TTL
  POPULAR_THRESHOLD: 100,      // Hits needed for 6-month TTL
  
  // ===== LENGTH MULTIPLIERS =====
  LONG_TEXT_MULTIPLIER: 2,     // 100+ characters get 2x TTL
  VERY_LONG_MULTIPLIER: 3,     // 500+ characters get 3x TTL
  
  // ===== CLEANUP SETTINGS =====
  CLEANUP_INTERVAL_HOURS: 6,   // Run cleanup every 6 hours
  BATCH_CLEANUP_SIZE: 1000,    // Clean up in batches of 1000 entries
  
  // ===== PERFORMANCE SETTINGS =====
  MAX_CACHE_SIZE_MB: 500,      // Maximum database size (approximate)
  COMPRESSION_THRESHOLD: 1000, // Compress text longer than 1000 chars
};

// Development/Testing TTL Config (lower values for testing)
const DEVELOPMENT_TTL_CONFIG = {
  BASE_TTL: 2,            // 2 hours
  FREQUENT_ACCESS: 24,    // 1 day
  VERY_FREQUENT: 168,     // 1 week
  POPULAR: 720,           // 1 month
  MAX_TTL: 1440,          // 2 months max
  
  FREQUENT_THRESHOLD: 5,
  VERY_FREQUENT_THRESHOLD: 20,
  POPULAR_THRESHOLD: 50,
  
  LONG_TEXT_MULTIPLIER: 1.5,
  VERY_LONG_MULTIPLIER: 2,
  
  CLEANUP_INTERVAL_HOURS: 1,
  BATCH_CLEANUP_SIZE: 100,
  
  MAX_CACHE_SIZE_MB: 50,
  COMPRESSION_THRESHOLD: 500,
};

// High-Traffic Production Config (100,000+ users)
const HIGH_TRAFFIC_TTL_CONFIG = {
  BASE_TTL: 72,           // 3 days
  FREQUENT_ACCESS: 720,   // 1 month
  VERY_FREQUENT: 2160,    // 3 months
  POPULAR: 8760,          // 1 year
  MAX_TTL: 17520,         // 2 years max
  
  FREQUENT_THRESHOLD: 20,
  VERY_FREQUENT_THRESHOLD: 100,
  POPULAR_THRESHOLD: 500,
  
  LONG_TEXT_MULTIPLIER: 2.5,
  VERY_LONG_MULTIPLIER: 4,
  
  CLEANUP_INTERVAL_HOURS: 12,
  BATCH_CLEANUP_SIZE: 2000,
  
  MAX_CACHE_SIZE_MB: 2000,
  COMPRESSION_THRESHOLD: 2000,
};

// Export based on environment
const NODE_ENV = process.env.NODE_ENV || 'production';
const USER_COUNT = parseInt(process.env.USER_COUNT) || 10000;

function getTTLConfig() {
  if (NODE_ENV === 'development' || NODE_ENV === 'test') {
    return DEVELOPMENT_TTL_CONFIG;
  }
  
  if (USER_COUNT >= 100000) {
    return HIGH_TRAFFIC_TTL_CONFIG;
  }
  
  return PRODUCTION_TTL_CONFIG;
}

module.exports = {
  PRODUCTION_TTL_CONFIG,
  DEVELOPMENT_TTL_CONFIG,
  HIGH_TRAFFIC_TTL_CONFIG,
  getTTLConfig
}; 