const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

exports.addPaymentMethod = async (req, res) => {
    try {
        const { provider_name, account_holder_name, account_number, iban } = req.body;
        const id = uuidv4();
        
        // ✅ FIX: Use (val || null) to ensure 'undefined' is never sent to MySQL
        await db.wallet.execute(
            "INSERT INTO users_payments_method (id, user_id, provider_name, account_holder_name, account_number, iban) VALUES (?, ?, ?, ?, ?, ?)", 
            [
                id, 
                req.user.id, 
                provider_name || null, 
                account_holder_name || null, 
                account_number || null, 
                iban || null // <--- This fixes the crash
            ]
        );
        res.status(201).json({ message: "Added" });
    } catch (e) { 
        console.error("Add Payment Method Error:", e); // Log the actual error
        res.status(500).json({ message: "Error adding payment method" }); 
    }
};


exports.getPaymentMethods = async (req, res) => {
    try {
        const [rows] = await db.wallet.query("SELECT * FROM users_payments_method WHERE user_id = ?", [req.user.id]);
        res.json(rows);
    } catch (e) { res.status(500).json({ message: "Error fetching methods" }); }
};
exports.deletePaymentMethod = async (req, res) => {
    try {
        const { id } = req.params;
        // Ensure user can only delete their own data
        await db.wallet.execute(
            "DELETE FROM users_payments_method WHERE id = ? AND user_id = ?", 
            [id, req.user.id]
        );
        res.json({ message: "Deleted successfully" });
    } catch (e) {
        console.error("Delete Error:", e);
        res.status(500).json({ message: "Error deleting account" });
    }
};

exports.updatePaymentMethod = async (req, res) => {
    try {
        const { id } = req.params;
        const { account_holder_name, account_number, iban } = req.body;
        
        await db.wallet.execute(
            "UPDATE users_payments_method SET account_holder_name = ?, account_number = ?, iban = ? WHERE id = ? AND user_id = ?", 
            [account_holder_name, account_number, iban || null, id, req.user.id]
        );
        res.json({ message: "Updated successfully" });
    } catch (e) {
        console.error("Update Error:", e);
        res.status(500).json({ message: "Error updating account" });
    }
};

exports.getPaymentMethodById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.wallet.query(
            "SELECT * FROM users_payments_method WHERE id = ? AND user_id = ?", 
            [id, req.user.id]
        );
        if(rows.length === 0) return res.status(404).json({message: "Not found"});
        res.json(rows[0]);
    } catch (e) { res.status(500).json({ message: "Error fetching details" }); }
};

exports.getMyWallet = async (req, res) => {
    try {
        // 1. Get Current Balance
        const [wallet] = await db.wallet.query(
            "SELECT balance FROM user_wallets WHERE user_id = ?", 
            [req.user.id]
        );

        // 2. Get Lifetime Earnings (Sum of all 'order_profit' credits)
        const [lifetime] = await db.wallet.query(
            `SELECT SUM(amount) as total 
             FROM wallet_transactions 
             WHERE user_id = ? AND type = 'credit' AND reason = 'order_profit'`,
            [req.user.id]
        );

        // 3. Get Pending Withdrawals (Optional, for dashboard stats)
        const [pending] = await db.wallet.query(
            `SELECT SUM(amount) as total 
             FROM user_withdrawals 
             WHERE user_id = ? AND status = 'pending'`,
            [req.user.id]
        );

        res.json({
            balance: wallet.length > 0 ? parseFloat(wallet[0].balance) : 0.00,
            lifetimeEarnings: lifetime.length > 0 ? (parseFloat(lifetime[0].total) || 0) : 0.00,
            pendingWithdrawals: pending.length > 0 ? (parseFloat(pending[0].total) || 0) : 0.00
        });

    } catch (e) { 
        console.error(e);
        res.status(500).json({ message: "Error fetching wallet stats" }); 
    }
};


exports.getWalletHistory = async (req, res) => {
    try {
        const [rows] = await db.wallet.query(
            `SELECT 
                wt.*, 
                upm.provider_name as bank_name,
                uw.status as withdrawal_status  -- <--- FETCHING STATUS
             FROM wallet_transactions wt
             LEFT JOIN user_withdrawals uw ON wt.reference_id = uw.id AND wt.reason = 'withdrawal'
             LEFT JOIN users_payments_method upm ON uw.payment_method_id = upm.id
             WHERE wt.user_id = ? 
             ORDER BY wt.created_at DESC 
             LIMIT 50`, 
            [req.user.id]
        );
        res.json(rows);
    } catch (e) { 
        console.error(e);
        res.status(500).json({ message: "Error fetching history" }); 
    }
};
// 3. Request Withdrawal (With Balance Check)
exports.requestWithdrawal = async (req, res) => {
    const connection = await db.wallet.getConnection();
    try {
        await connection.beginTransaction();

        const { amount, payment_method_id } = req.body;
        const reqAmount = parseFloat(amount);

        // Check Balance
        const [wallets] = await connection.query(
            "SELECT id, balance FROM user_wallets WHERE user_id = ? FOR UPDATE", 
            [req.user.id]
        );

        if (wallets.length === 0 || parseFloat(wallets[0].balance) < reqAmount) {
            await connection.rollback();
            return res.status(400).json({ message: "Insufficient balance" });
        }

        // Deduct Balance
        await connection.execute(
            "UPDATE user_wallets SET balance = balance - ? WHERE id = ?",
            [reqAmount, wallets[0].id]
        );

        const withdrawalId = uuidv4();

        // Create Request
        await connection.execute(
            `INSERT INTO user_withdrawals (id, user_id, amount, status, payment_method_id, requested_at) 
             VALUES (?, ?, ?, 'pending', ?, NOW())`, 
            [withdrawalId, req.user.id, reqAmount, payment_method_id]
        );

        // Log Transaction
        await connection.execute(
            `INSERT INTO wallet_transactions (user_id, amount, type, reason, reference_id, description) 
             VALUES (?, ?, 'debit', 'withdrawal', ?, 'Withdrawal Request')`,
            [req.user.id, reqAmount, withdrawalId]
        );

        await connection.commit();
        res.status(201).json({ message: "Withdrawal requested successfully" });

    } catch (e) { 
        await connection.rollback();
        console.error(e);
        res.status(500).json({ message: "Error processing withdrawal" }); 
    } finally {
        connection.release();
    }
};



exports.processWithdrawalStatus = async (req, res) => {
    const { withdrawalId, status, adminComment } = req.body; // status = 'approved' or 'rejected'
    
    const connection = await db.wallet.getConnection();
    try {
        await connection.beginTransaction();

        // Get Withdrawal Details
        const [withdrawals] = await connection.query(
            "SELECT * FROM user_withdrawals WHERE id = ? FOR UPDATE", 
            [withdrawalId]
        );
        
        if (withdrawals.length === 0) throw new Error("Withdrawal not found");
        const tx = withdrawals[0];

        if (tx.status !== 'pending') throw new Error("Request is already processed");

        // UPDATE STATUS
        await connection.execute(
            "UPDATE user_withdrawals SET status = ?, processed_at = NOW() WHERE id = ?",
            [status, withdrawalId]
        );

        // --- CRITICAL: IF REJECTED, REFUND THE USER ---
        if (status === 'rejected') {
            // 1. Add Money Back
            await connection.execute(
                "UPDATE user_wallets SET balance = balance + ? WHERE user_id = ?",
                [tx.amount, tx.user_id]
            );

            // 2. Add "Refund" Transaction Record
            await connection.execute(
                `INSERT INTO wallet_transactions 
                (user_id, amount, type, reason, reference_id, description) 
                VALUES (?, ?, 'credit', 'withdrawal_refund', ?, ?)`,
                [
                    tx.user_id, 
                    tx.amount, 
                    tx.id, 
                    `Refund: Withdrawal Rejected ${adminComment ? '('+adminComment+')' : ''}`
                ]
            );
        }

        await connection.commit();
        res.json({ message: `Withdrawal ${status}` });

    } catch (e) {
        await connection.rollback();
        res.status(500).json({ message: e.message });
    } finally {
        connection.release();
    }
};