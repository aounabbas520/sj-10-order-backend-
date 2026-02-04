const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
// Ensure this path matches exactly where your notification controller is
const { sendPushToUser } = require('./notificationController');

exports.notifyUserOrderUpdate = async (req, res) => {
    try {
        const { orderId, title, body, type } = req.body;
        
        console.log(`[Internal] Received Notification Trigger for Order: ${orderId}`);

        // 1. Find the User who owns this order
        const [orders] = await db.orders.query("SELECT user_id FROM orders WHERE id = ?", [orderId]);
        
        if (orders.length === 0) {
            console.warn(`[Internal] Order ${orderId} not found in DB.`);
            return res.status(404).json({ message: "Order not found" });
        }
        
        const userId = orders[0].user_id;

        // 2. Save Notification to Database
        // We use db.notifications.execute directly (no need for manual getConnection/release here)
        const notifId = uuidv4();
        await db.notifications.execute(
            `INSERT INTO notification_logs 
            (id, recipient_id, recipient_type, title, body, action_url, type, is_read, created_at) 
            VALUES (?, ?, 'user', ?, ?, ?, ?, 0, NOW())`,
            [notifId, userId, title, body, `/orders/${orderId}`, type || 'info']
        );

        // 3. Send Real-time Push to Browser
        // We do not await this, so if it fails, it doesn't crash the response
        sendPushToUser(userId, { title, body, url: `/orders/${orderId}` })
            .catch(err => console.error("[Internal] Push Send Failed:", err.message));

        console.log(`[Internal] Notification processed for User ${userId}`);
        res.json({ message: "Processed successfully" });

    } catch (e) {
        console.error("[Internal] Critical Error:", e);
        res.status(500).json({ message: "Internal Server Error", error: e.message });
    }
};


// ✅ THE NEW AUTOMATIC SWEEPER LOGIC
exports.runFinancialSyncInternal = async () => {
    console.log("🔄 Vercel Cron: Running Financial Sync...");
    
    // Connections create karo
    const orderConn = await db.orders.getConnection();
    const walletConn = await db.wallet.getConnection();
    
    let profitsProcessed = 0;
    let returnsProcessed = 0;

    try {
        // =========================================================
        // PART 1: DELIVERED ORDERS (Give Profit)
        // =========================================================
        const [pendingProfits] = await orderConn.query(`
            SELECT oi.id AS item_id, oi.order_id, oi.profit, oi.quantity, o.user_id 
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN shipments s ON s.order_id = oi.order_id
            WHERE LOWER(s.current_status) = 'delivered' 
            AND oi.profit_status = 'pending' AND oi.profit > 0
        `);

        if (pendingProfits.length > 0) {
            await walletConn.beginTransaction();
            await orderConn.beginTransaction();

            const userProfits = {};
            const itemIds = [];

            for (const item of pendingProfits) {
                const amount = parseFloat(item.profit) * item.quantity;
                // Group by user to avoid multiple DB hits for same user
                if (!userProfits[item.user_id]) userProfits[item.user_id] = 0;
                userProfits[item.user_id] += amount;
                itemIds.push(item.item_id);

                // Add History Entry
                await walletConn.execute(
                    `INSERT INTO wallet_transactions (user_id, amount, type, reason, reference_id, description) 
                     VALUES (?, ?, 'credit', 'order_profit', ?, ?)`,
                    [item.user_id, amount, item.order_id, `Profit for Order #${item.order_id}`]
                );
            }

            // Update User Wallets
            for (const [uid, amt] of Object.entries(userProfits)) {
                // Check if wallet exists
                const [w] = await walletConn.query("SELECT id FROM user_wallets WHERE user_id = ?", [uid]);
                if (w.length === 0) {
                    await walletConn.execute("INSERT INTO user_wallets (user_id, balance) VALUES (?, ?)", [uid, amt]);
                } else {
                    await walletConn.execute("UPDATE user_wallets SET balance = balance + ? WHERE user_id = ?", [amt, uid]);
                }
            }

            // Mark Items as PAID
            if (itemIds.length > 0) {
                // Prepare IN clause for safe execution
                const placeholders = itemIds.map(() => '?').join(',');
                await orderConn.query(
                    `UPDATE order_items SET profit_status = 'paid', is_locked = 1 WHERE id IN (${placeholders})`,
                    itemIds
                );
            }

            await walletConn.commit();
            await orderConn.commit();
            profitsProcessed = pendingProfits.length;
        }

        // =========================================================
        // PART 2: RETURNED ORDERS (Deduct Delivery Charges)
        // =========================================================
        const [pendingReturns] = await orderConn.query(`
            SELECT s.order_id, o.user_id, o.total_delivery_charge 
            FROM shipments s
            JOIN orders o ON o.id = s.order_id
            WHERE LOWER(s.current_status) IN ('returned', 'failed', 'rto', 'cancelled') 
            AND s.delivery_charge_deducted = 0
        `);

        if (pendingReturns.length > 0) {
            await walletConn.beginTransaction();
            await orderConn.beginTransaction();

            const orderIds = [];

            for (const ret of pendingReturns) {
                const charge = parseFloat(ret.total_delivery_charge || 200); // Default 200 if missing
                
                // Deduct from Wallet (Negative balance allowed)
                const [w] = await walletConn.query("SELECT id FROM user_wallets WHERE user_id = ?", [ret.user_id]);
                if (w.length === 0) {
                    await walletConn.execute("INSERT INTO user_wallets (user_id, balance) VALUES (?, ?)", [ret.user_id, -charge]);
                } else {
                    await walletConn.execute("UPDATE user_wallets SET balance = balance - ? WHERE user_id = ?", [charge, ret.user_id]);
                }

                // Add History Entry
                await walletConn.execute(
                    `INSERT INTO wallet_transactions (user_id, amount, type, reason, reference_id, description) 
                     VALUES (?, ?, 'debit', 'return_charge', ?, ?)`,
                    [ret.user_id, charge, ret.order_id, `Return Charge for Order #${ret.order_id}`]
                );
                
                orderIds.push(ret.order_id);
            }

            // Mark Shipment as Deducted
            if (orderIds.length > 0) {
                const placeholders = orderIds.map(() => '?').join(',');
                await orderConn.query(
                    `UPDATE shipments SET delivery_charge_deducted = 1 WHERE order_id IN (${placeholders})`,
                    orderIds
                );
            }

            await walletConn.commit();
            await orderConn.commit();
            returnsProcessed = pendingReturns.length;
        }

        console.log(`✅ Sync Complete. Profits: ${profitsProcessed}, Returns: ${returnsProcessed}`);
        return { success: true, processed: { profits: profitsProcessed, returns: returnsProcessed } };

    } catch (e) {
        if(walletConn) await walletConn.rollback();
        if(orderConn) await orderConn.rollback();
        console.error("Cron Logic Error:", e);
        return { success: false, error: e.message };
    } finally {
        if(walletConn) walletConn.release();
        if(orderConn) orderConn.release();
    }
};