// Shared many-to-many resolution helpers for the Category->Subcategory and
// Subcategory->Product cross-listing mappings (CategorySubcategoryMap,
// SubcategoryProductMap). Lives here rather than on either model, since it's
// consumed by two different route files (routes/subcategories.js and
// routes/products.js) and queries across three models.

const Subcategory = require('../models/Subcategory');
const CategorySubcategoryMap = require('../models/CategorySubcategoryMap');
const SubcategoryProductMap = require('../models/SubcategoryProductMap');

// Every subcategory id (primary + mapped) that should show under any of
// `categoryIds` for `storeCode`, hidden ones excluded. Used both to build the
// displayed subcategory list for a category, and to build the subcategory-id
// scope for an "ALL subcategories" product query.
async function resolveSubcategoryIdsForCategories(categoryIds, storeCode) {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) return [];

  const primary = await Subcategory.find({
    category_id: { $in: categoryIds },
    is_visible: { $ne: false }
  }).distinct('idsub_category_master');

  const mappings = await CategorySubcategoryMap.findByCategoryIds(categoryIds, storeCode);
  const mappedIds = mappings.map((m) => m.idsub_category_master);

  const extra = mappedIds.length
    ? await Subcategory.find({
        idsub_category_master: { $in: mappedIds },
        is_visible: { $ne: false }
      }).distinct('idsub_category_master')
    : [];

  return [...new Set([...primary, ...extra])];
}

// A ProductMaster query fragment matching every product that belongs under
// any of `subcategoryIds` — by primary sub_category_id, OR by being
// cross-mapped there via SubcategoryProductMap even though the product's own
// primary subcategory is elsewhere. Spread the result into a larger query
// object alongside store_code/pcode_status/search filters; it never sets
// dept_id or category_id, which must NOT be used as ProductMaster match
// filters once cross-mapping exists (see catalogueResolution's callers: a
// mapped subcategory can belong to a different category than the products
// under it were originally tagged with).
async function buildProductScopeFilter(subcategoryIds, storeCode) {
  if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) {
    return { sub_category_id: { $in: [] } }; // deliberately matches nothing
  }

  const mappings = await SubcategoryProductMap.findBySubcategoryIds(subcategoryIds, storeCode);
  const mappedPCodes = mappings.map((m) => m.p_code);

  return mappedPCodes.length
    ? { $or: [{ sub_category_id: { $in: subcategoryIds } }, { p_code: { $in: mappedPCodes } }] }
    : { sub_category_id: { $in: subcategoryIds } };
}

module.exports = { resolveSubcategoryIdsForCategories, buildProductScopeFilter };
