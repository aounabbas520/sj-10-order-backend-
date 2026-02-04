// controllers/dashboardController.js
const db = require('../config/database');

exports.getDashboardStats = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Get Delivered Orders & Total Sales (Price of Delivered Orders)
        const [orders] = await db.orders.query(
            `SELECT 
                COUNT(o.id) as total_delivered,
                SUM(o.total_price) as total_sales
             FROM orders o
             JOIN shipments s ON o.id = s.order_id
             WHERE o.user_id = ? AND LOWER(s.current_status) = 'delivered'`,
            [userId]
        );

        // 2. Get Total Profit (From Wallet Transactions - Most Accurate)
        const [profit] = await db.wallet.query(
            `SELECT SUM(amount) as total_profit 
             FROM wallet_transactions 
             WHERE user_id = ? AND type = 'credit' AND reason = 'order_profit'`,
            [userId]
        );

        res.json({
            completedOrders: orders[0].total_delivered || 0,
            totalSales: parseFloat(orders[0].total_sales || 0), // The Big Number (Rs. 0 in your screenshot)
            totalProfit: parseFloat(profit[0].total_profit || 0),
            totalBonus: 0 // Placeholder for now as requested
        });

    } catch (e) {
        console.error("Dashboard Stats Error:", e);
        res.status(500).json({ message: "Error fetching stats" });
    }
};