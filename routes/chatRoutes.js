const router = require('express').Router();
const controller = require('../controllers/chatController');
const auth = require('../middleware/authenticateUser');
router.use(auth);
router.get('/', controller.getMyChats);
router.get('/:chatId/messages', controller.getMessagesForChat);
router.post('/find-or-create', controller.findOrCreateChat);
module.exports = router;