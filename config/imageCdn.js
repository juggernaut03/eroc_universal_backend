// Configuration for the self-hosted product-image CDN (see the
// "Barcode Image Pipeline" architecture plan). Three paths/URLs, all
// overridable by env so dev/prod and any future move of the pool don't need
// a code change:
//
//   IMAGE_POOL_ROOT     private, app-only. The master pool, seeded once from
//                        the local images_cdn/webp_barcode_img/ folder via
//                        rsync, then grown through the admin upload tool.
//                        Filenames: <barcode>_1.webp / <barcode>_2.webp.
//   IMAGE_CDN_STORE_ROOT public, nginx-served. One folder per project_code,
//                        filenames <p_code>_1.webp / <p_code>_2.webp — what
//                        the sync engine copies pool files into.
//   IMAGE_CDN_BASE_URL   the public base the served folder answers on. A
//                        product's image URL is always
//                        `${IMAGE_CDN_BASE_URL}/${project_code}/${p_code}_1.webp`.
//
// Defaults match the dev server (Hostinger KVM2, 187.127.164.170):
// cdn.shalviadvision.com is the DNS-mapped domain for this.
const POOL_ROOT = process.env.IMAGE_POOL_ROOT || '/var/data/product_image_pool';
const CDN_STORE_ROOT = process.env.IMAGE_CDN_STORE_ROOT || '/var/www/cdn-store';
const CDN_BASE_URL = (process.env.IMAGE_CDN_BASE_URL || 'https://cdn.shalviadvision.com').replace(/\/$/, '');

module.exports = { POOL_ROOT, CDN_STORE_ROOT, CDN_BASE_URL };
