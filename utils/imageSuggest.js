const fs = require('fs');

const { getProjectModel } = require('../models/Project');
const { getTenantDb } = require('../config/database');
const { getOrCreateSettings } = require('../models/PlatformSetting');
const {
  findPoolFile,
  writeWebpToPool,
  copyPoolFileToTenant,
} = require('./imageSync');
require('../models/ProductMaster');
require('../models/ImageSuggestion');

const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash-vision-exp';

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
    const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
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
  const prompt = `Find a real product photo image URL for this Indian retail item: barcode ${product.barcode}, ${product.product_name}. Reply with ONLY the exact direct image URL (ending in .jpg/.png/.webp), or NONE_FOUND if you cannot find one.`;
  const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
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

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null;
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function generateWebSearchSuggestions(projectCode, { limit, triggeredBy, deepseekApiKey } = {}) {
  const project = await getProjectModel().findOne({ project_code: projectCode }).lean();
  if (!project) throw new Error(`Unknown project_code: ${projectCode}`);

  const settings = await getOrCreateSettings('+gemini_api_key');
  const geminiApiKey = settings.gemini_api_key;
  if (!geminiApiKey) {
    const err = new Error('No Gemini API key configured — set one in Image CDN settings first.');
    err.code = 'NO_GEMINI_KEY';
    throw err;
  }

  const db = getTenantDb(project.db_name);
  const ProductMaster = db.models.ProductMaster;
  const ImageSuggestion = db.models.ImageSuggestion;

  const alreadyTried = await ImageSuggestion.find({ project_code: projectCode, source: 'web_search' })
    .select('p_code').lean();
  const triedSet = new Set(alreadyTried.map((s) => s.p_code));

  const candidates = await ProductMaster.find({
    project_code: projectCode,
    $or: [{ pcode_img: null }, { pcode_img: '' }],
  }).select('p_code barcode product_name').lean();

  const batch = candidates.filter((c) => !triedSet.has(c.p_code)).slice(0, limit);

  let found = 0;
  let notFound = 0;
  let errored = 0;
  const results = [];

  for (const product of batch) {
    try {
      const url = await findImageUrlViaGemini(product, geminiApiKey);
      if (!url) { notFound++; results.push({ p_code: product.p_code, status: 'NONE_FOUND' }); continue; }

      const buffer = await downloadImage(url);
      if (!buffer) { notFound++; results.push({ p_code: product.p_code, status: 'URL_DID_NOT_RESOLVE', url }); continue; }

      // Written under the product's OWN real barcode — it's genuinely
      // that barcode's image now, useful to any future tenant sharing it,
      // not just this one.
      const poolPath = await writeWebpToPool(product.barcode, 1, buffer);
      const vision = await verifyCandidate(poolPath, product.product_name, { geminiApiKey, deepseekApiKey });

      await ImageSuggestion.create({
        project_code: projectCode,
        p_code: product.p_code,
        product_name: product.product_name,
        suffix: 1,
        source: 'web_search',
        suggested_barcode: product.barcode,
        source_url: url,
        vision_gemini: vision.gemini || {},
        vision_deepseek: vision.deepseek || {},
      });
      found++;
      results.push({ p_code: product.p_code, status: 'FOUND', url });
    } catch (err) {
      errored++;
      results.push({ p_code: product.p_code, status: 'ERROR', reason: err.message });
    }
  }

  return { requested: limit, processed: batch.length, found, not_found: notFound, errored, results };
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

module.exports = {
  generateCrossTenantSuggestions,
  generateWebSearchSuggestions,
  acceptSuggestion,
  rejectSuggestion,
};
