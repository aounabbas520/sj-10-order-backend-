const router = require('express').Router();
const controller = require('../controllers/notificationController');
const auth = require('../middleware/authenticateUser');
router.get('/vapid-key', controller.getVapidPublicKey);
router.use(auth);
router.post('/subscribe', controller.subscribeUser);
router.get('/', controller.getMyNotifications);
router.put('/read', controller.markAsRead);
module.exports = router;