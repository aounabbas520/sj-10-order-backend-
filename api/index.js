require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

// --- START OF CORS FIX ---
// 1. Define the config object separately so we can use it twice
const corsOptions = {
    origin: [
        "https://www.sj10.pk", 
        "https://sj10.pk", 
        "http://localhost:3000", 
        "http://localhost:4004"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true, // This allows cookies/auth headers
    allowedHeaders: ["Content-Type", "Authorization", "x-internal-api-key"]
};

// 2. Apply CORS to all normal requests
app.use(cors(corsOptions));

// 3. Apply CORS to Preflight (OPTIONS) requests
// (The previous error happened because 'corsOptions' was missing here)
app.options('*', cors(corsOptions));
// --- END OF CORS FIX ---

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