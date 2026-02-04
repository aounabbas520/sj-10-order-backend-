const db = require('../config/database');
const webpush = require('web-push');

// 1. Configure VAPID
try {
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || "mailto:admin@sj10.com",
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
} catch (e) { console.error("VAPID Config Error:", e); }

// --- 2. GET PUBLIC KEY (JSON FIX) ---
exports.getVapidPublicKey = (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(500).json({ message: "VAPID Key not configured on server." });
    }
    // ✅ FIX: Send as JSON object, NOT res.send()
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
};

// 3. SUBSCRIBE USER (The Most Important Function)
exports.subscribeUser = async (req, res) => {
    try {
        const { subscription } = req.body;
        const userId = req.user.id;

        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ message: "Invalid subscription" });
        }

        // --- CHECK IF ALREADY EXISTS ---
        // We check if this specific endpoint already exists for this user to avoid duplicates
        const [existing] = await db.notifications.query(
            "SELECT id FROM user_subscriptions WHERE user_id = ? AND subscription LIKE ?", 
            [userId, `%${subscription.endpoint}%`]
        );

        if (existing.length > 0) {
            return res.status(200).json({ message: "Already subscribed" });
        }

        // --- INSERT INTO user_subscriptions ---
        await db.notifications.execute(
            `INSERT INTO user_subscriptions (user_id, subscription, created_at) VALUES (?, ?, NOW())`, 
            [userId, JSON.stringify(subscription)]
        );

        console.log(`✅ User ${userId} subscribed to notifications!`);
        res.status(201).json({ message: "Subscribed successfully" });

    } catch (e) { 
        console.error("Database Error:", e);
        res.status(500).json({ message: "Database error" }); 
    }
};

exports.sendPushToUser = async (userId, payload) => {
    try {
        const [subs] = await db.notifications.query(
            "SELECT id, subscription FROM user_subscriptions WHERE user_id = ?", 
            [userId]
        );
        
        // 🛑 FILTER DUPLICATES
        // We use a Map to keep only unique endpoints
        const uniqueSubs = new Map();
        subs.forEach(row => {
            try {
                const parsed = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
                if (parsed.endpoint) {
                    uniqueSubs.set(parsed.endpoint, { id: row.id, config: parsed });
                }
            } catch(e) {}
        });

        console.log(`[Push] Found ${subs.length} rows, sending to ${uniqueSubs.size} unique devices.`);

        const promises = Array.from(uniqueSubs.values()).map(async (item) => {
            try {
                await webpush.sendNotification(item.config, JSON.stringify(payload));
                console.log(`✅ Sent to device ID ${item.id}`);
            } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    await db.notifications.query("DELETE FROM user_subscriptions WHERE id = ?", [item.id]);
                } else {
                    console.error("Push Error:", err.statusCode);
                }
            }
        });

        await Promise.all(promises);
    } catch(e) {
        console.error("Send Logic Error:", e);
    }
};

// ... keep getMyNotifications and markAsRead as they were ...
exports.getMyNotifications = async (req, res) => {
    try {
        const [rows] = await db.notifications.query(
            "SELECT * FROM notification_logs WHERE recipient_id = ? AND recipient_type = 'user' ORDER BY created_at DESC LIMIT 50", 
            [req.user.id]
        );
        res.json({ notifications: rows, unreadCount: rows.filter(r => r.is_read === 0).length });
    } catch (e) { res.status(500).json({ message: "Error" }); }
};

exports.markAsRead = async (req, res) => {
    try {
        await db.notifications.query(
            "UPDATE notification_logs SET is_read = 1 WHERE recipient_id = ? AND id IN (?)",
            [req.user.id, req.body.notificationIds]
        );
        res.json({ message: "Read" });
    } catch (e) { res.status(500).json({ message: "Error" }); }
};