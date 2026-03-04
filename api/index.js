require('dotenv').config();
const express = require('express');
// const cors = require('cors'); // <--- We are removing this dependency to use manual headers
const compression = require('compression');

// Routes Import
const userAuthRoutes = require('../routes/userAuthRoutes');
const userRoutes = require('../routes/userRoutes');
const orderRoutes = require('../routes/orderRoutes');
const walletRoutes = require('../routes/walletRoutes');
const chatRoutes = require('../routes/chatRoutes');
const notificationRoutes = require('../routes/notificationRoutes');
const internalRoutes = require('../routes/internalRoutes');
const cronRoutes = require('../routes/cronRoutes'); 
const dashboardRoutes = require('../routes/dashboardRoutes'); 

const app = express();

// =========================================================================
// 🔥 MANUAL CORS FIX (The "Nuclear Option")
// This replaces the 'cors' library to force headers on Vercel
// =========================================================================
app.use((req, res, next) => {
    const allowedOrigins = [
        'https://www.sj10.pk',
        'https://sj10.pk',
        'http://localhost:3000',
        'http://localhost:4004'
    ];

    const origin = req.headers.origin;

    // 1. Allow the specific Origin if it's in our list
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } 
    // Optional: Allow non-browser requests (Postman, Mobile Apps) that have no origin
    else if (!origin) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // 2. Allow Credentials (Cookies, Authorization headers)
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // 3. Allow specific HTTP Methods
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');

    // 4. Allow specific Headers (Auth, Content-Type, custom keys)
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-internal-api-key');

    // 5. Handle Preflight (OPTIONS) requests immediately
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Pass to next middleware
    next();
});
// =========================================================================

app.use(express.json());
app.use(compression());

// Internal API Security Middleware
const internalApiKeyAuth = (req, res, next) => {
    const apiKey = req.headers['x-internal-api-key'];
    if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
        next();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
};

// Routes Mounting
app.use('/auth/user', userAuthRoutes);
app.use('/api/user', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/internal', internalApiKeyAuth, internalRoutes);
app.use('/api/cron', cronRoutes); 
app.use('/api/dashboard', dashboardRoutes); 

// Health Check
app.get('/', (req, res) => {
    res.json({ status: "SJ10 Orders & Auth Service is Running 🛡️" });
});

module.exports = app;
if (require.main === module) {
    const PORT = process.env.PORT || 4004;
    app.listen(PORT, () => {
        console.log(`\n🚀 Server is running locally on: http://localhost:${PORT}`);
        console.log(`👉 Test Health Check: http://localhost:${PORT}/`);
    });
}