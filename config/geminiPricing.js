// Rough INR-per-request cost estimates, used ONLY to drive the spend
// guardrail on web-search jobs (utils/imageSuggest.js's
// generateWebSearchSuggestions / startWebSearchJob) and the admin panel's
// pre-run cost estimate. NOT real-time billing — none of these APIs expose
// per-request cost, so these are fixed estimates, not measurements of any
// specific call.
//
// GROUNDED_SEARCH_COST_INR — Gemini's Grounding-with-Google-Search tool.
// Derived from a real incident (2026-09-08): a job made 87 real grounded
// web-search calls before the account's prepay balance ran dry, and
// Google's billing dashboard showed ~₹2,740 spent for that period.
// ₹2,740 / 87 ≈ ₹31.5/search — rounded up to ₹32 so the guardrail trips a
// little early rather than a little late. Billed as a flat per-request
// tool fee, independent of tokens used, and independent of whether the
// search found an image or came back NONE_FOUND.
//
// GOOGLE_CSE_COST_INR — Google's plain Custom Search JSON API (no LLM
// bundled in, just raw search results): $5 per 1,000 queries beyond the
// first 100/day free ≈ $0.005/query ≈ ₹0.44 at ~₹88/$, rounded up to ₹1.
// Roughly 30x cheaper than Grounding for a similar "find a URL" job — see
// utils/imageSuggest.js's findImageUrlViaGoogleCSE. Requires its own
// Custom Search Engine (cx) + API key with the Custom Search API enabled;
// falls back to Gemini grounding automatically when not configured.
//
// OPEN_FOOD_FACTS_COST_INR — a free, open community database queried by
// barcode (openfoodfacts.org / openproductsfacts.org), always tried first
// when the product has one. Zero cost, but incomplete coverage — most
// useful as a free first pass, not a full replacement for either search
// API above. See findImageUrlViaOpenFoodFacts.
//
// VISION_VERIFY_COST_INR — Gemini vision verification (verifyWithGemini)
// does NOT use the grounding tool — it's a plain generateContent call with
// an inline image, billed by token count instead of a flat fee. Far less
// precisely measured than GROUNDED_SEARCH_COST_INR (it's never dominated a
// real bill yet) — treat it as a rough floor, not a tight number.
//
// Override any of these via env if pricing changes, your tier differs, or
// real observed spend suggests a better number.
const GROUNDED_SEARCH_COST_INR = parseFloat(process.env.GEMINI_GROUNDED_SEARCH_COST_INR) || 32;
const GOOGLE_CSE_COST_INR = parseFloat(process.env.GOOGLE_CSE_COST_INR) || 1;
const OPEN_FOOD_FACTS_COST_INR = 0;
const VISION_VERIFY_COST_INR = parseFloat(process.env.GEMINI_VISION_VERIFY_COST_INR) || 2;

module.exports = {
  GROUNDED_SEARCH_COST_INR,
  GOOGLE_CSE_COST_INR,
  OPEN_FOOD_FACTS_COST_INR,
  VISION_VERIFY_COST_INR,
};
