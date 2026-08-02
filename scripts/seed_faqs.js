// Seeds the FAQ collection for every active tenant.
//
// The content is lifted from what the mobile app had hardcoded in
// faq_screen.dart, so moving the screen onto the API loses nothing — the same
// questions appear, in the same order, until an admin edits them.
//
// Idempotent: matches on (category, question) and upserts, so re-running
// updates wording in place rather than duplicating rows. Nothing is deleted.
//
//   node scripts/seed_faqs.js [--project RET5677]

require('dotenv').config();

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Faq'); // registers the schema for getTenantDb()

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

// Categories are seeded in this order and questions in array order; `sequence`
// is assigned from the index so the app renders them exactly as listed here.
const CATEGORIES = [
  {
    title: 'General',
    faqs: [
      { question: 'What is {client}?', answer: '{client} brings your neighbourhood store online — groceries, personal care, household essentials and more, delivered to your door.' },
      { question: 'What are the operating hours?', answer: 'Delivery hours vary by store. Open Store Information from the menu to see the hours and contact details for the store you are shopping from.' },
    ],
  },
  {
    title: 'Products',
    faqs: [
      { question: 'I cannot find a product I want.', answer: 'Use the search at the top of the app. If it still does not appear, the item may be out of stock or not carried by the store you have selected — try another store from Change Location.' },
      { question: 'Are the products the same price as in store?', answer: 'Prices shown in the app are the prices you pay, and they already include GST. They can differ between stores, so the cart is always priced for the store you have selected.' },
      { question: 'How do I know if something is in stock?', answer: 'Only items the store currently has are shown as available. If stock runs out between adding to your cart and checking out, the app tells you before payment and adjusts the quantity.' },
    ],
  },
  {
    title: 'Ordering & Payment',
    faqs: [
      { question: 'How do I place an order?', answer: 'Set your pincode, pick a store, add items to your cart, then choose a delivery slot and a payment method at checkout.' },
      { question: 'Which payment methods can I use?', answer: 'Cash on delivery, or online payment by UPI, card or netbanking through Razorpay. The amount you are shown at checkout is the amount charged.' },
      { question: 'Can I change or cancel an order?', answer: 'Open the order from the Orders screen and tap Cancel while it is still being confirmed. Once a store has started picking your order it can no longer be cancelled from the app.' },
    ],
  },
  {
    title: 'Delivery',
    faqs: [
      { question: 'How do I choose a delivery time?', answer: 'Pick a date and a slot during checkout. Available slots depend on the store and how busy it is.' },
      { question: 'How much does delivery cost?', answer: 'Delivery charges depend on the store and your distance from it, and are shown at checkout before you pay.' },
    ],
  },
  {
    title: 'Returns & Refunds',
    faqs: [
      { question: 'An item arrived damaged or is missing.', answer: 'Contact support within 48 hours of delivery and we will refund or replace it.' },
      { question: 'How long does a refund take?', answer: 'Refunds for online payments go back to the original payment method within 5–7 working days.' },
      { question: 'Can I return something I simply do not want?', answer: 'Perishables cannot be returned once delivered. For everything else, contact support within 48 hours and we will help.' },
    ],
  },
  {
    title: 'Account',
    faqs: [
      { question: 'How do I change my delivery address?', answer: 'Open Account, then Addresses, to add, edit or remove addresses. You choose which one to use during checkout.' },
      { question: 'How do I delete my account?', answer: 'Use Delete Account in the menu. This removes your profile and addresses; completed orders are retained where the law requires it.' },
    ],
  },
];

const seed = async () => {
  await connectDB();

  const filter = { status: 'active' };
  const only = arg('project');
  if (only) filter.project_code = only.toUpperCase();

  const projects = await getProjectModel().find(filter).lean();
  if (!projects.length) throw new Error(`No active project matched${only ? ` ${only}` : ''}.`);

  for (const project of projects) {
    const db = getTenantDb(project.db_name);
    const Faq = db.models.Faq;
    const client = project.config?.app_name || project.client_name || 'We';

    let inserted = 0;
    let updated = 0;
    let sequence = 0;

    for (const category of CATEGORIES) {
      for (const faq of category.faqs) {
        const question = faq.question.replace(/\{client\}/g, client);
        const answer = faq.answer.replace(/\{client\}/g, client);
        const res = await Faq.updateOne(
          { category: category.title, question },
          { $set: { answer, sequence: sequence++, is_active: true } },
          { upsert: true, setDefaultsOnInsert: true }
        );
        if (res.upsertedCount) inserted++;
        else if (res.modifiedCount) updated++;
      }
    }

    const total = await Faq.countDocuments({});
    console.log(`✔ ${project.project_code} (${project.db_name}): +${inserted} new, ${updated} updated, ${total} total`);
  }

  await disconnectDB();
};

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
