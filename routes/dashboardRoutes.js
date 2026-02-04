// routes/dashboardRoutes.js
const router = require('express').Router();
const controller = require('../controllers/dashboardController');
const auth = require('../middleware/authenticateUser');

router.use(auth); // Protect all routes

router.get('/', controller.getDashboardStats);

module.exports = router;