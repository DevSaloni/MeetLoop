import { register, login, getProfile, updateProfile, forgotPassword, resetPassword, deleteAccount } from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { loginRateLimit } from '../middleware/rateLimiter.js';
import express from "express";

const router = express.Router();

router.post('/register', register);
router.post('/login', loginRateLimit, login);
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);
router.delete('/purge', protect, deleteAccount);
router.post('/forgotpassword', forgotPassword);
router.put('/resetpassword/:resettoken', resetPassword);

export default router;
