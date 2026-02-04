const router = require('express').Router();
const controller = require('../controllers/userAuthController');

router.post('/register', controller.register);
router.post('/login', controller.login);
router.post('/google', controller.googleLogin); // New
router.post('/forgot-password', controller.forgotPassword); // New
router.post('/reset-password', controller.resetPassword); // New

module.exports = router;