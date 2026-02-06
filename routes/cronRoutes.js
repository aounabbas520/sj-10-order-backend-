const router = require('express').Router();
const internalController = require('../controllers/internalController');

// Middleware to verify Vercel Cron request
const verifyCron = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // Strict comparison
    if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
        next();
    } else {
        // Return 401 without exposing debug info
        return res.status(401).json({ message: "Unauthorized Cron Request" });
    }
};

// The Route Vercel will hit every 10 mins
router.get('/sync-financials', verifyCron, async (req, res) => {
    try {
        const result = await internalController.runFinancialSyncInternal();
        res.json(result);
    } catch (error) {
        console.error("Cron Route Error:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;