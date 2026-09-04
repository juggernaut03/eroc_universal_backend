require('dotenv').config();

const { connectDB, disconnectDB } = require('../config/database');
const { getProjectModel } = require('../models/Project');

// Registers the known clients in the control DB. Idempotent (upserts by
// project_code) — safe to re-run. Onboard a new client by adding a row here
// or inserting directly via the admin panel later.
const PROJECTS = [
  {
    // Config mirrors what the dev API serves from GET /api/project-config on
    // 2026-08-01. It had drifted — the colours here were #E53935/#FDD835, so
    // seeding a control DB branded the app in a palette no environment used,
    // and left razorpay_key_id empty, which silently disables checkout.
    project_code: 'RET5677',
    client_name: 'Pagariya Mart',
    db_name: 'Pagariya_DB',
    status: 'active',
    config: {
      app_name: 'Pagariya Mart',
      currency: 'INR',
      primary_color: '#863283',
      secondary_color: '#24c278',
      accent_color: '#9d41c8',
      font_family: 'Poppins',
      min_app_version: '4.0.0',
      latest_app_version: '4.0.13',
      android_store_url: '',
      ios_store_url: '',
      force_update_message: 'A new version of the app is available. Please update to continue.',
      splash_logo_url: 'https://pagariyamart.com/media/branding/095df452-192a-41f3-a618-052783ddff4e.jpg',
      splash_background_image_url: 'https://pagariyamart.com/media/branding/67b42371-a90f-4302-aea8-de68a61ac9f7.jpg',
      splash_tagline: 'Tagline Test',
      splash_tagline_color: '#ffffff',
      splash_animation: 'none',
      splash_show_loader: 'false',
      home_feed_enabled: 'true',
      // Razorpay TEST key — the same one dev serves. Never seed a live key here.
      razorpay_key_id: 'rzp_test_5yy0US6kMQYbpU',
    },
  },
  {
    project_code: 'RET9575',
    client_name: 'Grahak Peth',
    db_name: 'GrahakPeth_DB',
    status: 'active',
    config: {
      app_name: 'Grahak Peth',
      currency: 'INR',
      primary_color: '#2E7D32',
      secondary_color: '#FF8F00',
      min_app_version: '4.0.0',
      latest_app_version: '4.0.13',
      android_store_url: '',
      ios_store_url: '',
      force_update_message: 'A new version of the app is available. Please update to continue.',
    },
  },
  {
    project_code: 'RET6978',
    client_name: 'My Need Mart',
    db_name: 'MyNeedMart_DB',
    status: 'active',
    config: { app_name: 'My Need Mart', currency: 'INR' },
  },
  {
    project_code: 'RET6602',
    client_name: 'Sansar Pariwar',
    db_name: 'SansarPariwar_DB',
    status: 'active',
    config: { app_name: 'Sansar Pariwar', currency: 'INR' },
  },
  {
    // Catalog built by scripts/onboard_shree_mega_mart.js from the client's
    // two CSV exports. Store ops (pincodes served, delivery slots, payment
    // modes, a physical store record) intentionally not set up yet — the
    // CSVs only carried a product catalog.
    project_code: 'RET2690',
    client_name: 'Shree Mega Mart',
    db_name: 'ShreeMegaMart_DB',
    status: 'active',
    config: { app_name: 'Shree Mega Mart', currency: 'INR' },
  },
];

const seed = async () => {
  await connectDB();
  const Project = getProjectModel();

  for (const project of PROJECTS) {
    const result = await Project.findOneAndUpdate(
      { project_code: project.project_code },
      { $set: project },
      { upsert: true, new: true }
    );
    console.log(`✔ ${result.project_code} → ${result.db_name} (${result.client_name})`);
  }

  const total = await Project.countDocuments();
  console.log(`\nProject registry now holds ${total} project(s).`);
  await disconnectDB();
};

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
