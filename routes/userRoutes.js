const router = require('express').Router();
const controller = require('../controllers/userController');
const auth = require('../middleware/authenticateUser');

// This middleware will be used to process file uploads for specific routes
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.use(auth); // Protect all user routes

router.get('/profile', controller.getMyProfile);
router.put('/profile', controller.updateMyProfile);
router.put('/password', controller.changePassword);

// --- NEW ROUTE for uploading an avatar ---
// 'avatar' must match the key the frontend sends in FormData
router.post('/profile/avatar', upload.single('avatar'), controller.uploadAvatar);

module.exports = router;