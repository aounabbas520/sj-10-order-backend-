const router = require('express').Router();
const controller = require('../controllers/internalController');
router.post('/notify/order-update', controller.notifyUserOrderUpdate);
module.exports = router;