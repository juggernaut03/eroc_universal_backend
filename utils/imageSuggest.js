const fs = require('fs');

const { getProjectModel } = require('../models/Project');
const { getTenantDb } = require('../config/database');
const { getOrCreateSettings } = require('../models/PlatformSetting');
const {
  GROUNDED_SEARCH_COST_INR,
  GOOGLE_CSE_COST_INR,
  OPEN_FOOD_FACTS_COST_INR,
  VISION_VERIFY_COST_INR,
} = require('../config/geminiPricing');
const {
  findPoolFile,
  writeWebpToPool,
  copyPoolFileToTenant,
} = require('./imageSync');
require('../models/ProductMaster');
require('../models/ImageSuggestion');
require('../models/ImageSearchJob');

// Separately configurable per purpose, both defaulting to the model
// that's actually been confirmed working in production — NOT a guessed
// "cheaper" model name. Grounding (google_search tool) needs
// GEMINI_SEARCH_MODEL to actually support it; swapping either one is
// safe to try via env var without a code change, but verify a candidate
// model works (and is genuinely cheaper) with a real test call before
// relying on it — the API fails loudly (404/400) on an unknown model
// name, it doesn't silently downgrade.
const GEMINI_SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL || 'gemini-flash-latest';
const GEMINI_VERIFY_MODEL = process.env.GEMINI_VERIFY_MODEL || 'gemini-flash-latest';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash-vision-exp';
// Free, no API key — a community-run open product database, queried by
// barcode. Covers both food (openfoodfacts.org) and non-food
// (openproductsfacts.org) items under the same account/schema.
const OPEN_FOOD_FACTS_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const OPEN_PRODUCTS_FACTS_BASE = 'https://world.openproductsfacts.org/api/v2/product';
const GOOGLE_CSE_BASE = 'https://www.googleapis.com/customsearch/v1';

// Same tokenizer/scorer tested against real data in the architecture plan
// (§02) — brand-gated, IDF-weighted word overlap with a package-size
// penalty. Kept deliberately simple and explainable: no ML model, no GPU,
// every score traces back to "these words matched, this one didn't."
const STOPWORDS = new Set(['GM', 'GMS', 'KG', 'ML', 'LTR', 'LT', 'L', 'PC', 'PCS', 'PACK', 'PKT', 'N', 'NO', 'X', 'THE', 'AND', 'OF']);

function extractSize(name) {
  const m = /(\d+(?:\.\d+)?)\s*(KG|GM|GMS|G|ML|LTR|LT|L)\b/i.exec(name || '');
  if (!m) return null;
  let val = parseFloat(m[1]);
  let unit = m[2].toUpperCase();
  if (unit === 'KG') { val *= 1000; unit = 'GM'; }
  if (unit === 'G') unit = 'GM';
  if (unit === 'LTR' || unit === 'L') { val *= 1000; unit = 'ML'; }
  return { val, unit };
}

function tokenize(name) {
  if (!name) return [];
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d+(\.\d+)?$/.test(t));
}

// Scans every tenant's ProductMaster for barcodes that already have a real
// image in the pool, keeping every name that barcode is known by across
// every tenant. Rebuilt on demand — the whole scan took under a second in
// testing against all 5 live tenants, so no cache/background job needed
// yet (see the plan's §07 decision).
async function buildCrossTenantIndex() {
  const projects = await getProjectModel().find({}).select('project_code db_name').lean();
  const descriptors = [];
  const blocks = new Map();
  const df = new Map();

  for (const p of projects) {
    const db = getTenantDb(p.db_name);
    const ProductMaster = db.models.ProductMaster;
    const rows = await ProductMaster.find({ barcode: { $exists: true, $ne: null } })
      .select('barcode product_name brand_name')
      .lean();
    for (const r of rows) {
      if (!findPoolFile(r.barcode, 1)) continue;
      const tokens = tokenize(r.product_name);
      if (tokens.length === 0) continue;
      const entry = {
        barcode: r.barcode,
        tokens: new Set(tokens),
        size: extractSize(r.product_name),
        name: r.product_name,
        source: p.project_code,
      };
      descriptors.push(entry);
      const key = tokens[0];
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(descriptors.length - 1);
      for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
    }
  }

  const N = descriptors.length;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  return { descriptors, blocks, idf };
}

function scoreCandidate(tokensA, sizeA, cand, idf) {
  const tokensB = cand.tokens;
  let interW = 0;
  let unionW = 0;
  const all = new Set([...tokensA, ...tokensB]);
  for (const t of all) {
    const w = idf(t);
    unionW += w;
    if (tokensA.has(t) && tokensB.has(t)) interW += w;
  }
  let s = unionW > 0 ? interW / unionW : 0;
  if (sizeA && cand.size && sizeA.unit === cand.size.unit) {
    const diff = Math.abs(sizeA.val - cand.size.val) / Math.max(sizeA.val, cand.size.val);
    if (diff > 0.15) s *= 0.35;
  }
  return s;
}

// Best cross-tenant candidate for one product, or null if nothing clears
// the threshold. 0.55 is the plan's proposed default (§07) — precision
// over recall.
function findBestCrossTenantMatch(product, index, threshold = 0.55) {
  const tokensArr = tokenize(product.product_name);
  if (tokensArr.length === 0) return null;
  const tokensA = new Set(tokensArr);
  const sizeA = extractSize(product.product_name);
  const bucket = index.blocks.get(tokensArr[0]) || [];

  let best = null;
  for (const idx of bucket) {
    const cand = index.descriptors[idx];
    if (cand.barcode === product.barcode) continue; // not a real suggestion
    const score = scoreCandidate(tokensA, sizeA, cand, index.idf);
    if (!best || score > best.score) best = { ...cand, score };
  }
  return best && best.score >= threshold ? best : null;
}

// ---------------------------------------------------------------------
// Vision verification — Gemini and (optionally) DeepSeek independently
// judge whether a candidate photo really shows the product it's being
// suggested for. Never used to silently discard a candidate; both
// verdicts are just shown to the admin alongside Accept/Reject.

function buildVerifyPrompt(productDescriptor) {
  return `This image is a candidate photo suggested for an e-commerce product listing. The product it needs to match is: "${productDescriptor}". Does the image genuinely show this exact product (same brand, same variant, and a plausible matching pack size)? Answer with MATCH or NO_MATCH on the first line, then one sentence explaining why.`;
}

function parseVerdict(text) {
  if (!text) return null;
  const firstLine = text.trim().split('\n')[0].toUpperCase();
  const verdict = firstLine.includes('NO_MATCH') ? 'NO_MATCH' : firstLine.includes('MATCH') ? 'MATCH' : null;
  const reason = text.trim().split('\n').slice(1).join(' ').trim() || text.trim();
  return verdict ? { verdict, reason } : null;
}

async function verifyWithGemini(buffer, mimeType, productDescriptor, apiKey) {
  if (!apiKey) return null;
  try {
    const body = {
      contents: [{
        parts: [
          { text: buildVerifyPrompt(productDescriptor) },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
        ],
      }],
    };
    const res = await fetch(`${GEMINI_BASE}/${GEMINI_VERIFY_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { verdict: null, reason: data.error?.message || `HTTP ${res.status}` };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return parseVerdict(text) || { verdict: null, reason: 'Unparseable response' };
  } catch (err) {
    return { verdict: null, reason: err.message };
  }
}

async function verifyWithDeepSeek(buffer, mimeType, productDescriptor, apiKey) {
  if (!apiKey) return null;
  try {
    const body = {
      model: DEEPSEEK_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildVerifyPrompt(productDescriptor) },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
        ],
      }],
    };
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { verdict: null, reason: data.error?.message || `HTTP ${res.status}` };
    const text = data.choices?.[0]?.message?.content;
    return parseVerdict(text) || { verdict: null, reason: 'Unparseable response' };
  } catch (err) {
    return { verdict: null, reason: err.message };
  }
}

async function verifyCandidate(poolPath, productDescriptor, { geminiApiKey, deepseekApiKey }) {
  const buffer = fs.readFileSync(poolPath);
  const [gemini, deepseek] = await Promise.all([
    verifyWithGemini(buffer, 'image/webp', productDescriptor, geminiApiKey),
    verifyWithDeepSeek(buffer, 'image/webp', productDescriptor, deepseekApiKey),
  ]);
  return { gemini, deepseek };
}

// ---------------------------------------------------------------------
// Source 1: cross-tenant text matching (free, always available).

async function generateCrossTenantSuggestions(projectCode, { deepseekApiKey } = {}) {
  const project = await getProjectModel().findOne({ project_code: projectCode }).lean();
  if (!project) throw new Error(`Unknown project_code: ${projectCode}`);
  const db = getTenantDb(project.db_name);
  const ProductMaster = db.models.ProductMaster;
  const ImageSuggestion = db.models.ImageSuggestion;

  const settings = await getOrCreateSettings('+gemini_api_key');
  const geminiApiKey = settings.gemini_api_key || null;

  const missing = await ProductMaster.find({
    project_code: projectCode,
    $or: [{ pcode_img: null }, { pcode_img: '' }],
  }).select('p_code barcode product_name').lean();

  // Skip anything already suggested from this source and not rejected —
  // regenerating never re-proposes a rejected match, and never duplicates
  // a still-pending one.
  const existing = await ImageSuggestion.find({ project_code: projectCode, source: 'cross_tenant' })
    .select('p_code status').lean();
  const skip = new Set(existing.map((e) => e.p_code));

  const index = await buildCrossTenantIndex();
  let created = 0;
  let skipped = 0;

  for (const product of missing) {
    if (skip.has(product.p_code)) { skipped++; continue; }
    const match = findBestCrossTenantMatch(product, index);
    if (!match) continue;

    const poolPath = findPoolFile(match.barcode, 1);
    if (!poolPath) continue; // shouldn't happen — index is built from pool contents

    const vision = await verifyCandidate(poolPath, product.product_name, { geminiApiKey, deepseekApiKey });

    await ImageSuggestion.create({
      project_code: projectCode,
      p_code: product.p_code,
      product_name: product.product_name,
      suffix: 1,
      source: 'cross_tenant',
      suggested_barcode: match.barcode,
      suggested_from_project: match.source,
      suggested_from_name: match.name,
      text_score: Math.round(match.score * 100) / 100,
      vision_gemini: vision.gemini || {},
      vision_deepseek: vision.deepseek || {},
    });
    created++;
  }

  return { total_missing: missing.length, created, skipped_existing: skipped };
}

// ---------------------------------------------------------------------
// Source 2: live web search (Gemini grounding — real cost, admin-gated by
// how many products they ask for). Only ever runs against products that
// still have no image AND no existing web_search suggestion, so re-running
// with a bigger limit naturally continues from where the last run stopped
// rather than re-spending on the same products.

const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|webp)\b/i;

async function findImageUrlViaGemini(product, apiKey) {
  // Deliberately NOT including the barcode: caught live (FOGG ABSOLUTE
  // SPRAY 120ML, p_code 12149) where the stored barcode's brand_name
  // ("STREAX") didn't match the product name at all — a real client-data
  // mismatch, same class of issue documented throughout this catalog's
  // onboarding. Including that wrong barcode made Gemini report NONE_FOUND;
  // the identical prompt with just the product name found a correct image
  // on the first try. The product name is the reliable signal the web is
  // actually indexed by — the barcode is this catalog's least trustworthy
  // field, so it doesn't belong in a search query where a wrong value can
  // only ever hurt, never help.
  const prompt = `Find a real product photo image URL for this Indian retail item: ${product.product_name}. Reply with ONLY the exact direct image URL (ending in .jpg/.png/.webp), or NONE_FOUND if you cannot find one.`;
  const res = await fetch(`${GEMINI_BASE}/${GEMINI_SEARCH_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = IMAGE_URL_RE.exec(text);
  return match ? match[0] : null;
}

// Free, no API key, no cost — a community-run open product database keyed
// by barcode (the one signal this catalog actually trusts least for
// *matching* purposes, per findImageUrlViaGemini's comment above, but is
// still a perfectly good lookup key here since it's an exact hit-or-miss,
// not a fuzzy match). Tried first for every product that has a barcode,
// before spending anything on a paid search — coverage is incomplete
// (community-contributed) so this won't find everything, but every hit
// costs ₹0 instead of ₹1–32. Checks the food database first, then the
// non-food one, since most of this catalog is FMCG/grocery.
async function findImageUrlViaOpenFoodFacts(barcode) {
  if (!barcode) return null;
  for (const base of [OPEN_FOOD_FACTS_BASE, OPEN_PRODUCTS_FACTS_BASE]) {
    try {
      const res = await fetch(`${base}/${encodeURIComponent(barcode)}.json?fields=image_front_url,image_url`);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status !== 1 || !data.product) continue;
      const url = data.product.image_front_url || data.product.image_url;
      if (url) return url;
    } catch {
      // Non-fatal — falls through to the next base, then to whatever paid
      // search step is configured.
    }
  }
  return null;
}

// Google's plain Custom Search JSON API — real web search results with no
// LLM reasoning bundled in, ~30x cheaper per request than Gemini's
// Grounding tool (see config/geminiPricing.js). Needs its own Search
// Engine ID (cx) configured to search the whole web with Image Search
// turned on, from https://programmablesearchengine.google.com/, plus an
// API key with the Custom Search API enabled — set both in Image CDN
// settings. `num: 1, searchType: 'image'` asks for exactly one image
// result, so this is one request per product like the Gemini path, not a
// bigger multi-result fetch.
async function findImageUrlViaGoogleCSE(product, apiKey, cx) {
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: product.product_name,
    searchType: 'image',
    num: '1',
    safe: 'active',
  });
  const res = await fetch(`${GOOGLE_CSE_BASE}?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data.items?.[0]?.link || null;
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null;
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Cheap pre-flight check — one plain, ungrounded generateContent call
// (trivial prompt, no image, no search tool) to confirm the configured
// key actually authenticates BEFORE a job commits to a whole batch. Added
// after a real incident: a placeholder key ("asdfgh...") got saved into
// Image CDN settings, and every web-search attempt for the next ~11 hours
// failed instantly with "API key not valid" — harmless cost-wise (Google
// rejects before any billable work happens) but wasted the admin's time
// and looked identical to "nothing found" until someone checked the raw
// error. This turns that into an immediate, clear rejection instead.
async function verifyGeminiKeyWorks(apiKey) {
  try {
    const res = await fetch(`${GEMINI_BASE}/${GEMINI_VERIFY_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, reason: data.error?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Same idea as verifyGeminiKeyWorks, for the (opt-in) Google Custom Search
// path — one real query against a throwaway term, so a bad key/cx pair
// fails the whole job immediately instead of erroring out on every single
// product in the batch.
async function verifyGoogleCseWorks(apiKey, cx) {
  try {
    const params = new URLSearchParams({ key: apiKey, cx, q: 'test', num: '1' });
    const res = await fetch(`${GOOGLE_CSE_BASE}?${params.toString()}`);
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, reason: data.error?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// `pCodes`, when given, is the admin explicitly picking exactly which
// missing products to spend a web search on from the Missing Images list
// — takes priority over `limit` (an arbitrary "just pick the next N"
// batch), which stays as a convenience for bulk-searching without
// hand-picking every row. Either way, a product that already has a
// web_search suggestion doc (pending or resolved) is skipped — re-selecting
// it wouldn't do anything new and would hit the schema's unique index.
// A product that came back NONE_FOUND last time has no doc at all, so
// selecting it again is a legitimate, working retry.
//
// `onProgress`, when given, is called after every product the loop below
// actually processes (found/not-found/errored — not the ones skipped up
// front) with the running totals so far, so a caller tracking a background
// job (see startWebSearchJob) can persist live progress instead of only
// learning the outcome once the whole batch is done.
//
// `maxBudgetInr`, when given, is a spend guardrail — see config/geminiPricing.js
// for where the per-request estimate comes from. Checked BEFORE each
// grounded search call (not after), so the running estimate never
// knowingly goes over budget by even one more call; whatever's left in the
// batch at that point is recorded as BUDGET_STOPPED rather than silently
// dropped, so `processed` still accounts for the full batch either way.
async function generateWebSearchSuggestions(projectCode, { limit, pCodes, deepseekApiKey, maxBudgetInr, onProgress } = {}) {
  const project = await getProjectModel().findOne({ project_code: projectCode }).lean();
  if (!project) throw new Error(`Unknown project_code: ${projectCode}`);

  // Real money per item below this point — a caller MUST bound the run
  // explicitly, either by picking products or by a numeric limit. Belt and
  // suspenders alongside the route's own check: without this, an empty
  // pCodes array plus an unset limit would fall through to
  // `untried.slice(0, undefined)`, which in JS returns the WHOLE array —
  // silently searching every missing product in the catalog. Caught this
  // exact bug live while testing the route (killed after 2 real calls);
  // this is the fix, not just the route-level guard.
  const hasExplicitSelection = Array.isArray(pCodes) && pCodes.length > 0;
  if (!hasExplicitSelection && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('generateWebSearchSuggestions requires a non-empty pCodes array or a positive limit');
  }

  const settings = await getOrCreateSettings('+gemini_api_key +google_cse_api_key +google_cse_id');
  const geminiApiKey = settings.gemini_api_key;
  if (!geminiApiKey) {
    const err = new Error('No Gemini API key configured — set one in Image CDN settings first.');
    err.code = 'NO_GEMINI_KEY';
    throw err;
  }
  // Opt-in — only used when both pieces are set. Gemini grounding remains
  // the fallback (see the search step below), so a tenant that hasn't set
  // this up yet sees no behavior change.
  const googleCseApiKey = settings.google_cse_api_key || null;
  const googleCseId = settings.google_cse_id || null;
  const hasGoogleCse = !!(googleCseApiKey && googleCseId);

  const db = getTenantDb(project.db_name);
  const ProductMaster = db.models.ProductMaster;
  const ImageSuggestion = db.models.ImageSuggestion;

  const existing = await ImageSuggestion.find({ project_code: projectCode, source: 'web_search' })
    .select('p_code status').lean();
  const triedStatusByPCode = new Map(existing.map((s) => [s.p_code, s.status]));

  const query = {
    project_code: projectCode,
    $or: [{ pcode_img: null }, { pcode_img: '' }],
  };
  if (hasExplicitSelection) {
    query.p_code = { $in: pCodes };
  }

  const candidates = await ProductMaster.find(query).select('p_code barcode product_name').lean();
  const candidatePCodes = new Set(candidates.map((c) => c.p_code));

  const untried = candidates.filter((c) => !triedStatusByPCode.has(c.p_code));
  const alreadyTried = candidates.filter((c) => triedStatusByPCode.has(c.p_code));
  const batch = hasExplicitSelection ? untried : untried.slice(0, limit);

  // Selected p_codes that vanished from the "missing" query entirely (an
  // image already landed for them some other way, or the p_code is stale)
  // — only meaningful for an explicit selection; a limit-based auto-pick
  // has nothing outside the query to compare against. Without surfacing
  // these (and the already-tried ones below) explicitly, "searched 5 of 10
  // selected" reads as a bug rather than the accounted-for rest of the 10.
  const results = [];
  if (hasExplicitSelection) {
    for (const pc of pCodes) {
      if (!candidatePCodes.has(pc)) results.push({ p_code: pc, status: 'NOT_MISSING' });
    }
  }
  for (const c of alreadyTried) {
    results.push({ p_code: c.p_code, status: 'ALREADY_HAS_SUGGESTION', existing_status: triedStatusByPCode.get(c.p_code) });
  }

  let found = 0;
  let notFound = 0;
  let errored = 0;
  let budgetStopped = 0;
  let estimatedCostInr = 0;
  const hasBudget = typeof maxBudgetInr === 'number' && maxBudgetInr > 0;

  for (const product of batch) {
    // Free pass first, for every product that has a barcode — never
    // budget-gated (costs nothing whether it hits or misses). Its own
    // try/catch: a failure here (OFF down, network blip) must fall
    // through silently to the paid step, never get attributed a cost or
    // counted as this item's ERROR.
    let url = null;
    let foundVia = null;
    if (product.barcode) {
      try {
        url = await findImageUrlViaOpenFoodFacts(product.barcode);
        if (url) foundVia = 'open_food_facts';
      } catch {
        // Falls through to the paid step below.
      }
    }

    // Prefer Google Custom Search when configured — far cheaper per
    // request than Gemini's Grounding tool (see config/geminiPricing.js);
    // Gemini grounding is the automatic fallback otherwise. Checked BEFORE
    // spending — a paid search call (win or lose) always costs the same
    // flat fee, so that's the number to guard against, not the
    // possibly-larger total after a FOUND also adds the vision-verify
    // cost. Only reached when the free pass above didn't already find
    // something.
    if (!url) {
      const paidCostInr = hasGoogleCse ? GOOGLE_CSE_COST_INR : GROUNDED_SEARCH_COST_INR;
      if (hasBudget && estimatedCostInr + paidCostInr > maxBudgetInr) {
        budgetStopped++;
        results.push({ p_code: product.p_code, status: 'BUDGET_STOPPED' });
        continue;
      }
    }

    try {
      if (!url) {
        const paidCostInr = hasGoogleCse ? GOOGLE_CSE_COST_INR : GROUNDED_SEARCH_COST_INR;
        url = hasGoogleCse
          ? await findImageUrlViaGoogleCSE(product, googleCseApiKey, googleCseId)
          : await findImageUrlViaGemini(product, geminiApiKey);
        estimatedCostInr += paidCostInr;
        if (url) foundVia = hasGoogleCse ? 'google_cse' : 'gemini_grounding';
      }

      if (!url) { notFound++; results.push({ p_code: product.p_code, status: 'NONE_FOUND' }); continue; }

      const buffer = await downloadImage(url);
      if (!buffer) { notFound++; results.push({ p_code: product.p_code, status: 'URL_DID_NOT_RESOLVE', url }); continue; }

      // Written under the product's OWN real barcode — it's genuinely
      // that barcode's image now, useful to any future tenant sharing it,
      // not just this one.
      const poolPath = await writeWebpToPool(product.barcode, 1, buffer);
      const vision = await verifyCandidate(poolPath, product.product_name, { geminiApiKey, deepseekApiKey });
      estimatedCostInr += VISION_VERIFY_COST_INR;

      await ImageSuggestion.create({
        project_code: projectCode,
        p_code: product.p_code,
        product_name: product.product_name,
        suffix: 1,
        source: 'web_search',
        suggested_barcode: product.barcode,
        source_url: url,
        found_via: foundVia,
        vision_gemini: vision.gemini || {},
        vision_deepseek: vision.deepseek || {},
      });
      found++;
      results.push({ p_code: product.p_code, status: 'FOUND', url, found_via: foundVia });
    } catch (err) {
      // A call that failed before being billed (invalid key, depleted
      // prepay balance, network error) didn't cost anything — but there's
      // no reliable way to tell that apart from a call that failed AFTER
      // being billed, so this still counts toward the estimate. Better to
      // over-estimate spend on a bad run than under it and let the
      // guardrail miss a real problem.
      estimatedCostInr += hasGoogleCse ? GOOGLE_CSE_COST_INR : GROUNDED_SEARCH_COST_INR;
      errored++;
      results.push({ p_code: product.p_code, status: 'ERROR', reason: err.message });
    } finally {
      if (onProgress) {
        await onProgress({
          processed: found + notFound + errored,
          found,
          not_found: notFound,
          errored,
          total: batch.length,
          estimated_cost_inr: Math.round(estimatedCostInr)
        });
      }
    }
  }

  return {
    requested: hasExplicitSelection ? pCodes.length : limit,
    processed: batch.length,
    already_tried: alreadyTried.length,
    not_missing: results.filter((r) => r.status === 'NOT_MISSING').length,
    budget_stopped: budgetStopped,
    estimated_cost_inr: Math.round(estimatedCostInr),
    found,
    not_found: notFound,
    errored,
    results
  };
}

// ---------------------------------------------------------------------
// Web search jobs — queues generateWebSearchSuggestions in the background
// instead of holding the admin's request open for the whole batch. Every
// DB access here resolves the tenant connection directly via
// getTenantDb(project.db_name), the same as generateWebSearchSuggestions
// itself, rather than the request-scoped `req.tenant.db` — this code keeps
// running long after the HTTP response that started it has been sent, so
// it can't depend on anything tied to that request's lifetime.

async function getImageSearchJobModel(projectCode) {
  const project = await getProjectModel().findOne({ project_code: projectCode }).lean();
  if (!project) throw new Error(`Unknown project_code: ${projectCode}`);
  const db = getTenantDb(project.db_name);
  return db.models.ImageSearchJob;
}

async function findRunningWebSearchJob(projectCode) {
  const ImageSearchJob = await getImageSearchJobModel(projectCode);
  return ImageSearchJob.findOne({ project_code: projectCode, status: 'running' }).lean();
}

async function listWebSearchJobs(projectCode, limit = 10) {
  const ImageSearchJob = await getImageSearchJobModel(projectCode);
  return ImageSearchJob.find({ project_code: projectCode })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-results')
    .lean();
}

async function getWebSearchJob(projectCode, jobId) {
  const ImageSearchJob = await getImageSearchJobModel(projectCode);
  return ImageSearchJob.findOne({ _id: jobId, project_code: projectCode }).lean();
}

// Creates the job doc and returns it immediately — the actual search keeps
// running in the background afterwards (deliberately not awaited past that
// point). Throws JOB_ALREADY_RUNNING (with the existing job's id attached)
// rather than letting two searches for the same tenant race each other, and
// INVALID_GEMINI_KEY if a cheap pre-flight ping fails — see
// verifyGeminiKeyWorks's own comment for why that check exists.
async function startWebSearchJob(projectCode, { limit, pCodes, budgetInr, triggeredByEmail, deepseekApiKey }) {
  const ImageSearchJob = await getImageSearchJobModel(projectCode);

  const running = await ImageSearchJob.findOne({ project_code: projectCode, status: 'running' });
  if (running) {
    const err = new Error('A web search job is already running for this tenant — wait for it to finish first.');
    err.code = 'JOB_ALREADY_RUNNING';
    err.jobId = running._id;
    throw err;
  }

  const settings = await getOrCreateSettings('+gemini_api_key +google_cse_api_key +google_cse_id');
  const geminiApiKey = settings.gemini_api_key;
  if (!geminiApiKey) {
    const err = new Error('No Gemini API key configured — set one in Image CDN settings first.');
    err.code = 'NO_GEMINI_KEY';
    throw err;
  }
  const keyCheck = await verifyGeminiKeyWorks(geminiApiKey);
  if (!keyCheck.ok) {
    const err = new Error(`Gemini API key rejected: ${keyCheck.reason} — fix it in Image CDN settings before starting a search.`);
    err.code = 'INVALID_GEMINI_KEY';
    throw err;
  }
  // Same fail-fast principle, for the (opt-in) cheaper search path — a bad
  // cx/key pair here would otherwise fail every single item in the batch
  // individually instead of the whole job up front.
  if (settings.google_cse_api_key && settings.google_cse_id) {
    const cseCheck = await verifyGoogleCseWorks(settings.google_cse_api_key, settings.google_cse_id);
    if (!cseCheck.ok) {
      const err = new Error(`Google Custom Search key/ID rejected: ${cseCheck.reason} — fix it in Image CDN settings before starting a search.`);
      err.code = 'INVALID_GOOGLE_CSE';
      throw err;
    }
  }

  const hasExplicitSelection = Array.isArray(pCodes) && pCodes.length > 0;
  const hasBudget = typeof budgetInr === 'number' && budgetInr > 0;
  const job = await ImageSearchJob.create({
    project_code: projectCode,
    status: 'running',
    requested: hasExplicitSelection ? pCodes.length : limit,
    budget_inr: hasBudget ? budgetInr : undefined,
    triggered_by_email: triggeredByEmail
  });

  generateWebSearchSuggestions(projectCode, {
    limit,
    pCodes,
    deepseekApiKey,
    maxBudgetInr: hasBudget ? budgetInr : undefined,
    onProgress: (progress) =>
      ImageSearchJob.updateOne({ _id: job._id }, {
        $set: {
          batch_total: progress.total,
          processed: progress.processed,
          found: progress.found,
          not_found: progress.not_found,
          errored: progress.errored,
          estimated_cost_inr: progress.estimated_cost_inr
        }
      }).catch(() => {}),
  })
    .then((result) =>
      ImageSearchJob.updateOne({ _id: job._id }, {
        $set: {
          status: 'completed',
          processed: result.processed,
          found: result.found,
          not_found: result.not_found,
          already_tried: result.already_tried,
          not_missing: result.not_missing,
          budget_stopped: result.budget_stopped,
          estimated_cost_inr: result.estimated_cost_inr,
          errored: result.errored,
          results: result.results,
          finished_at: new Date()
        }
      })
    )
    .catch((err) =>
      ImageSearchJob.updateOne({ _id: job._id }, {
        $set: { status: 'failed', error_message: err.message, finished_at: new Date() }
      })
    );

  return job;
}

// ---------------------------------------------------------------------
// Accept / reject — shared by both sources, since both end up as "a real
// file already sitting in the pool under suggested_barcode".

async function acceptSuggestion(suggestion, reviewedBy) {
  const poolPath = findPoolFile(suggestion.suggested_barcode, suggestion.suffix);
  if (!poolPath) throw new Error(`Pool file for barcode ${suggestion.suggested_barcode} is missing — cannot accept`);

  // A web_search suggestion already sits in the pool under this product's
  // OWN barcode (written at generation time — see generateWebSearchSuggestions).
  // A cross_tenant suggestion doesn't: the file only exists under a
  // DIFFERENT tenant's barcode. Accepting one is the moment a human
  // confirms the match is real, so promote it into the pool under this
  // product's own barcode too — a plain copy, keeping the original
  // barcode's file untouched. From then on, a plain barcode-exact sync
  // (this tenant's re-syncs, or any other tenant importing the same
  // barcode later) finds it directly, no fuzzy matching needed again.
  if (suggestion.source === 'cross_tenant') {
    const project = await getProjectModel().findOne({ project_code: suggestion.project_code }).lean();
    const db = getTenantDb(project.db_name);
    const ProductMaster = db.models.ProductMaster;
    const product = await ProductMaster.findOne({ project_code: suggestion.project_code, p_code: suggestion.p_code })
      .select('barcode').lean();
    if (product?.barcode && !findPoolFile(product.barcode, suggestion.suffix)) {
      await writeWebpToPool(product.barcode, suggestion.suffix, poolPath);
    }
  }

  const url = await copyPoolFileToTenant(poolPath, suggestion.project_code, suggestion.p_code, suggestion.suffix);

  suggestion.status = 'accepted';
  suggestion.reviewed_by = reviewedBy;
  suggestion.reviewed_at = new Date();
  await suggestion.save();

  return url;
}

async function rejectSuggestion(suggestion, reviewedBy) {
  suggestion.status = 'rejected';
  suggestion.reviewed_by = reviewedBy;
  suggestion.reviewed_at = new Date();
  await suggestion.save();
}

// Counts for the admin UI's own KPI row — separate from the plain
// coverage/missing tiles above it, since those describe the catalog, not
// how much progress the suggestion queue itself has made.
async function getSuggestionStats(projectCode) {
  const project = await getProjectModel().findOne({ project_code: projectCode }).lean();
  if (!project) throw new Error(`Unknown project_code: ${projectCode}`);
  const db = getTenantDb(project.db_name);
  const ImageSuggestion = db.models.ImageSuggestion;

  const [pending, accepted, rejected, pendingCrossTenant, pendingWebSearch] = await Promise.all([
    ImageSuggestion.countDocuments({ project_code: projectCode, status: 'pending' }),
    ImageSuggestion.countDocuments({ project_code: projectCode, status: 'accepted' }),
    ImageSuggestion.countDocuments({ project_code: projectCode, status: 'rejected' }),
    ImageSuggestion.countDocuments({ project_code: projectCode, status: 'pending', source: 'cross_tenant' }),
    ImageSuggestion.countDocuments({ project_code: projectCode, status: 'pending', source: 'web_search' }),
  ]);

  return { pending, accepted, rejected, pending_cross_tenant: pendingCrossTenant, pending_web_search: pendingWebSearch };
}

module.exports = {
  generateCrossTenantSuggestions,
  generateWebSearchSuggestions,
  startWebSearchJob,
  findRunningWebSearchJob,
  listWebSearchJobs,
  getWebSearchJob,
  acceptSuggestion,
  rejectSuggestion,
  getSuggestionStats,
  // Exported mainly for direct testing/reuse — the free lookup step has no
  // API key or job wiring of its own, so it's safe to call standalone.
  findImageUrlViaOpenFoodFacts,
};
