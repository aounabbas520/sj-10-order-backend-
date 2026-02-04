const router = require('express').Router();
const controller = require('../controllers/orderController');
const auth = require('../middleware/authenticateUser');

// This middleware protects all order-related routes
router.use(auth);

// --- Existing Routes ---

// GET /api/orders/ -> Fetches the user's order list
router.get('/', controller.getMyOrders);

// POST /api/orders/ -> Creates a new order
router.post('/', controller.createOrder);

// POST /api/orders/cancel -> Cancels an order
router.post('/cancel', controller.cancelOrder);


// --- ✅ ADD THIS NEW ROUTE ---
// This is the missing piece. It handles requests for tracking information.
// GET /api/orders/:orderId/tracking
router.get('/:orderId/tracking', controller.getOrderTracking);


module.exports = router;