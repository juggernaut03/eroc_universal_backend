/**
 * In-app + push notification for a loyalty event. Mirrors the manual
 * "create doc, then send FCM" pattern used at controllers/notifications.js -
 * this codebase has no single shared helper that does both, so this is the
 * loyalty module's own copy of that pattern.
 *
 * Deliberately not sent for every low-value event (loyalty_rewards_frd.md
 * section 72: "should not create notification fatigue") - callers only
 * invoke this for reward redeemed, tier change, points expiring, challenge
 * completed, and referral successful, not for every routine points credit.
 */

const Notification = require('../models/Notification');
const fcm = require('./fcm');

const notifyLoyaltyEvent = async (user, { title, body, data = {}, projectCode }) => {
  try {
    await Notification.create({
      user: user._id,
      title,
      body,
      type: 'loyalty',
      data
    });
  } catch (error) {
    console.error('[loyalty] Failed to create in-app notification:', error.message);
  }

  try {
    if (user.fcmToken) {
      await fcm.sendNotificationToUser(user, title, body, data, projectCode);
    }
  } catch (error) {
    // A push failure must never fail the loyalty operation that triggered it.
    console.error('[loyalty] Failed to send push notification:', error.message);
  }
};

module.exports = { notifyLoyaltyEvent };
