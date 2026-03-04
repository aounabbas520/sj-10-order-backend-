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

// Define allowed origins
const allowedOrigins = [
  'https://www.sj10.pk',
  'https://sj10.pk',
  'http://localhost:3000',
  'http://localhost:4004'
];

// --- ROBUST CORS CONFIGURATION ---
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        } else {
            // Optional: Block unknown origins, or allow them for debugging
            // return callback(new Error('Not allowed by CORS'));
            console.log("Blocked Origin:", origin);
            return callback(null, false);
        }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-internal-api-key"]
}));

// Handle Preflight for all routes
app.options('*', cors());

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

// Health 
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