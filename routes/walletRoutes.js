const router = require('express').Router();
const controller = require('../controllers/walletController');
const auth = require('../middleware/authenticateUser');

router.use(auth);

// Balance & History
router.get('/', controller.getMyWallet);       // GET /api/wallet/
router.get('/history', controller.getWalletHistory); // GET /api/wallet/history

// Payment Methods
router.get('/payment-methods', controller.getPaymentMethods);
router.post('/payment-methods', controller.addPaymentMethod);
router.get('/payment-methods/:id', controller.getPaymentMethodById);
router.put('/payment-methods/:id', controller.updatePaymentMethod);
router.delete('/payment-methods/:id', controller.deletePaymentMethod);

// Withdrawals
router.post('/withdrawals', controller.requestWithdrawal);

module.exports = router;