// Shared many-to-many resolution helpers for the Category->Subcategory and
// Subcategory->Product cross-listing mappings (CategorySubcategoryMap,
// SubcategoryProductMap). Lives here rather than on either model, since it's
// consumed by two different route files (routes/subcategories.js and
// routes/products.js) and queries across three models.

const Subcategory = require('../models/Subcategory');
const CategorySubcategoryMap = require('../models/CategorySubcategoryMap');

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

module.exports = { resolveSubcategoryIdsForCategories };
