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
const cronRoutes = require('../routes/cronRoutes'); // <--- NEW IMPORT
const dashboardRoutes = require('../routes/dashboardRoutes'); // <--- Import

const app = express();

app.use(cors());
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
app.use('/api/cron', cronRoutes); // <--- NEW ROUTE MOUNTING
app.use('/api/dashboard', dashboardRoutes); // <--- Add this line

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