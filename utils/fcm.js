const admin = require('firebase-admin');

// Multi-tenant Firebase Admin SDK.
//
// Each app flavor mints its FCM tokens against ITS OWN Firebase project
// (see android/app/src/<flavor>/google-services.json) — myneedmart's tokens
// belong to `my-need-mart-46f0d`, pagariya's to `patelrmartnotifications`,
// neither of which is the single `shalviecomweb` project this file used to
// send everything through. Sending a token via the wrong project's
// credentials always fails with "SenderId mismatch" (seen live for
// My Need Mart, 2026-08-22) — the token and the sending credential have to
// belong to the same Firebase project.
//
// Falls back to the shared default app (FIREBASE_SERVICE_ACCOUNT_JSON) for
// any tenant that hasn't been given its own service account yet in
// Project.secrets.firebase_service_account_json — so this is backward
// compatible until each tenant's credential is added.

const namedApps = new Map(); // project_code -> admin.app.App
let defaultApp; // the original single shared app

const initializeDefaultFirebase = () => {
    if (defaultApp) {
        return defaultApp;
    }

    try {
        const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

        if (serviceAccountJson) {
            const serviceAccount = JSON.parse(serviceAccountJson);
            defaultApp = admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase Admin SDK (default) initialized successfully');
            return defaultApp;
        } else {
            console.warn('Firebase Admin SDK not initialized: No service account credentials provided');
            return null;
        }
    } catch (error) {
        console.error('Failed to initialize default Firebase Admin SDK:', error.message);
        return null;
    }
};

/**
 * Resolve the Firebase Admin app to send through for a tenant: its own
 * project if Project.secrets.firebase_service_account_json is set, else the
 * shared default app.
 * @param {string} [projectCode]
 * @returns {Promise<admin.app.App|null>}
 */
const getFirebaseApp = async (projectCode) => {
    if (!projectCode) {
        return initializeDefaultFirebase();
    }

    if (namedApps.has(projectCode)) {
        return namedApps.get(projectCode);
    }

    let serviceAccountJson;
    try {
        const { getProjectModel } = require('../models/Project');
        const project = await getProjectModel()
            .findOne({ project_code: projectCode })
            .select('+secrets.firebase_service_account_json')
            .lean();
        serviceAccountJson = project?.secrets?.firebase_service_account_json;
    } catch (error) {
        console.error(`Failed to look up Firebase config for ${projectCode}:`, error.message);
    }

    if (!serviceAccountJson) {
        return initializeDefaultFirebase();
    }

    try {
        const serviceAccount = JSON.parse(serviceAccountJson);
        const app = admin.initializeApp(
            { credential: admin.credential.cert(serviceAccount) },
            `tenant-${projectCode}`
        );
        namedApps.set(projectCode, app);
        console.log(`Firebase Admin SDK initialized for tenant ${projectCode} (project ${serviceAccount.project_id})`);
        return app;
    } catch (error) {
        console.error(`Failed to initialize Firebase app for ${projectCode}:`, error.message);
        return initializeDefaultFirebase();
    }
};

/**
 * Send push notification to a specific user
 * @param {string} fcmToken - User's FCM token
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional custom data payload
 * @param {string} [projectCode] - Tenant, to pick the right Firebase project
 * @returns {Promise<Object>} Response from FCM
 */
const sendNotification = async (fcmToken, title, body, data = {}, projectCode) => {
    const app = await getFirebaseApp(projectCode);

    if (!app) {
        throw new Error('Firebase Admin SDK not initialized');
    }

    if (!fcmToken) {
        throw new Error('FCM token is required');
    }

    // Ensure all data values are strings (FCM requirement for iOS)
    const stringifiedData = {};
    Object.keys(data).forEach(key => {
        const value = data[key];
        stringifiedData[key] = typeof value === 'string' ? value : JSON.stringify(value);
    });

    const message = {
        notification: {
            title: title || 'Notification',
            body: body || ''
        },
        data: stringifiedData,
        token: fcmToken,
        // iOS specific configuration
        apns: {
            payload: {
                aps: {
                    alert: {
                        title: title || 'Notification',
                        body: body || ''
                    },
                    sound: 'default',
                    badge: 1
                }
            }
        },
        // Android specific configuration
        android: {
            notification: {
                title: title || 'Notification',
                body: body || '',
                sound: 'default',
                priority: 'high'
            }
        }
    };

    try {
        const response = await app.messaging().send(message);
        console.log('Successfully sent notification:', response);
        return { success: true, messageId: response };
    } catch (error) {
        console.error('Error sending notification:', error);
        throw error;
    }
};

/**
 * Send push notification to a user by user ID
 * @param {Object} user - User object with fcmToken
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional custom data payload
 * @param {string} [projectCode] - Tenant, to pick the right Firebase project
 * @returns {Promise<Object>} Response from FCM
 */
const sendNotificationToUser = async (user, title, body, data = {}, projectCode) => {
    if (!user || !user.fcmToken) {
        throw new Error('User does not have an FCM token');
    }

    return await sendNotification(user.fcmToken, title, body, data, projectCode);
};

/**
 * Send push notification to multiple users
 * @param {Array} users - Array of user objects with fcmTokens
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional custom data payload
 * @param {string} [projectCode] - Tenant, to pick the right Firebase project
 * @returns {Promise<Object>} Summary of results
 */
const sendNotificationToMultipleUsers = async (users, title, body, data = {}, projectCode) => {
    const app = await getFirebaseApp(projectCode);

    if (!app) {
        throw new Error('Firebase Admin SDK not initialized');
    }

    // Filter users who have FCM tokens
    const usersWithTokens = users.filter(user => user.fcmToken);

    if (usersWithTokens.length === 0) {
        throw new Error('No users have FCM tokens');
    }

    const tokens = usersWithTokens.map(user => user.fcmToken);

    // Ensure all data values are strings (FCM requirement for iOS)
    const stringifiedData = {};
    Object.keys(data).forEach(key => {
        const value = data[key];
        stringifiedData[key] = typeof value === 'string' ? value : JSON.stringify(value);
    });

    const message = {
        notification: {
            title: title || 'Notification',
            body: body || ''
        },
        data: stringifiedData,
        tokens: tokens,
        // iOS specific configuration
        apns: {
            payload: {
                aps: {
                    alert: {
                        title: title || 'Notification',
                        body: body || ''
                    },
                    sound: 'default',
                    badge: 1
                }
            }
        },
        // Android specific configuration
        android: {
            notification: {
                title: title || 'Notification',
                body: body || '',
                sound: 'default',
                priority: 'high'
            }
        }
    };

    try {
        const response = await app.messaging().sendEachForMulticast(message);
        console.log(`Successfully sent notifications: ${response.successCount}/${tokens.length}`);

        return {
            success: true,
            totalUsers: users.length,
            usersWithTokens: usersWithTokens.length,
            successCount: response.successCount,
            failureCount: response.failureCount,
            responses: response.responses
        };
    } catch (error) {
        console.error('Error sending notifications to multiple users:', error);
        throw error;
    }
};

/**
 * Send notification to all users with FCM tokens
 * @param {Array} users - Array of all user objects
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional custom data payload
 * @param {string} [projectCode] - Tenant, to pick the right Firebase project
 * @returns {Promise<Object>} Summary of results
 */
const sendNotificationToAllUsers = async (users, title, body, data = {}, projectCode) => {
    return await sendNotificationToMultipleUsers(users, title, body, data, projectCode);
};

module.exports = {
    initializeFirebase: initializeDefaultFirebase,
    getFirebaseApp,
    sendNotification,
    sendNotificationToUser,
    sendNotificationToMultipleUsers,
    sendNotificationToAllUsers
};
