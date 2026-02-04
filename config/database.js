require('dotenv').config();
const mysql = require('mysql2/promise');
const { URL } = require('url');

// Helper to create connection pools safely
const createPool = (connectionUrl) => {
    if (!connectionUrl) {
        console.warn("⚠️ Warning: A Database URL is missing in .env");
        return null;
    }
    try {
        const url = new URL(connectionUrl);
        return mysql.createPool({
            host: url.hostname,
            user: url.username,
            password: url.password,
            database: url.pathname.substring(1),
            port: url.port || 3306, // Default MySQL port, TiDB often uses 4000
            ssl: { rejectUnauthorized: true }, // Required for TiDB Cloud / Azure
            waitForConnections: true,
            connectionLimit: 5, // Optimized for Vercel serverless environment
            queueLimit: 0,
            connectTimeout: 20000,
            enableKeepAlive: true
        });
    } catch (error) {
        console.error(`🔴 DB Config Error for URL: ${connectionUrl}`, error.message);
        return null;
    }
};

const pools = {
    users: createPool(process.env.DB_USERS_URL),
    orders: createPool(process.env.DB_ORDERS_URL),
    wallet: createPool(process.env.DB_WALLET_URL),
    chats: createPool(process.env.DB_CHATS_URL),
    notifications: createPool(process.env.DB_NOTIFICATIONS_URL),
    carts: createPool(process.env.DB_CARTS_URL),
    // ✅ ADDED: TiDB Connection for Suppliers
    suppliers: createPool(process.env.DB_SUPPLIERS_URL) 
};

module.exports = pools;