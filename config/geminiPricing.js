// Rough INR-per-request cost estimates, used ONLY to drive the spend
// guardrail on web-search jobs (utils/imageSuggest.js's
// generateWebSearchSuggestions / startWebSearchJob) and the admin panel's
// pre-run cost estimate. NOT real-time billing — the Gemini API doesn't
// expose per-request cost, so this is a fixed estimate, not a measurement
// of any specific call.
//
// Derived from a real incident (2026-09-08): a job made 87 real grounded
// web-search calls (google_search tool) before the account's prepay
// balance ran dry, and Google's billing dashboard showed ~₹2,740 spent for
// that period. ₹2,740 / 87 ≈ ₹31.5/search — rounded up to ₹32 here so the
// guardrail trips a little early rather than a little late. Grounding is
// billed as a flat per-request tool fee, independent of how many tokens
// the surrounding prompt/response used, so this held steady whether a
// search found an image or came back NONE_FOUND.
//
// Vision verification (verifyWithGemini) does NOT use the grounding tool —
// it's a plain generateContent call with an inline image, billed by
// token count instead of a flat fee. This estimate is far less precisely
// measured than the search cost above (it's never dominated a real bill
// yet) — treat it as a rough floor, not a tight number.
//
// Override either via env if Google's pricing changes, your tier differs,
// or real observed spend suggests a better number.
const GROUNDED_SEARCH_COST_INR = parseFloat(process.env.GEMINI_GROUNDED_SEARCH_COST_INR) || 32;
const VISION_VERIFY_COST_INR = parseFloat(process.env.GEMINI_VISION_VERIFY_COST_INR) || 2;

module.exports = { GROUNDED_SEARCH_COST_INR, VISION_VERIFY_COST_INR };
