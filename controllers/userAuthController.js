const db = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { sendEmail } = require('../utils/emailService')
const axios = require('axios');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const DEFAULT_PROFILE_PIC = "https://pub-1390981b409c46698da5dc6c45e08eaa.r2.dev/product/SJ10-285129/SJ10-285129-1-20260201-072541.webp";

// Helper to generate JWT token
const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
};
exports.register = async (req, res) => {
    try {
        const { fullName, email, password, phone, brandName, confirmPassword } = req.body;

        // 1. Basic Validation
        if (!fullName || !email || !password || !phone) 
            return res.status(400).json({ message: 'Please fill all required fields.' });
        if (password !== confirmPassword) 
            return res.status(400).json({ message: 'Passwords do not match.' });

        // 2. Check if Email or Phone Number already exist in the database
        const [existing] = await db.users.query(
            "SELECT email, phone FROM users WHERE email = ? OR phone = ?", 
            [email, phone]
        );

        if (existing.length > 0) {
            if (existing[0].email === email) {
                return res.status(409).json({ message: 'This email is already registered.' });
            }
            if (existing[0].phone === phone) {
                return res.status(409).json({ message: 'This phone number is already registered.' });
            }
        }

        // 3. Hash Password and Prepare Data
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUserId = uuidv4();
        
        // Use a provided profile pic URL or the default one
        const profilePicToSave = req.body.profilePic || DEFAULT_PROFILE_PIC;

        // 4. Insert the new user into the database
        await db.users.execute(
            `INSERT INTO users (id, full_name, email, password_hash, phone, brand_name, role, status, profile_pic, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, 'customer', 'active', ?, NOW())`,
            [newUserId, fullName, email, hashedPassword, phone, brandName || null, profilePicToSave]
        );

        res.status(201).json({ message: 'Account created successfully!', userId: newUserId });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ message: 'Server error during registration.' });
    }
};


// --- LOGIN ---
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await db.users.query("SELECT * FROM users WHERE email = ?", [email]);
        
        if (rows.length === 0) return res.status(401).json({ message: 'Invalid email or password' });

        const user = rows[0];

        // Check Status
        if (user.status === 'banned') return res.status(403).json({ message: 'Your account has been banned.' });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            // Log failed attempt logic here if desired
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        await db.users.query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);

        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ message: 'Login successful', token });
    } catch (error) {
        res.status(500).json({ message: 'Login failed.' });
    }
};

// --- REPLACED GOOGLE LOGIN FUNCTION ---
exports.googleLogin = async (req, res) => {
    try {
        const { accessToken } = req.body; // We get the Access Token from the frontend

        if (!accessToken) {
            return res.status(400).json({ message: "No Google token provided." });
        }

        // 1. Use the Access Token to get user's profile info from Google
        const googleResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        const { email, name, picture, sub: google_id } = googleResponse.data;

        if (!email) {
            return res.status(400).json({ message: "Google account must have a verified email." });
        }

        // 2. Find-or-Create the user in your database
        const [rows] = await db.users.query("SELECT * FROM users WHERE email = ?", [email]);
        let user = rows[0];

        if (!user) {
            console.log(`[Auth] New user from Google: ${email}. Creating account...`);
            const newUserId = uuidv4();
            await db.users.execute(
                `INSERT INTO users (id, full_name, email, role, status, profile_pic, is_verified, auth_provider, google_id, created_at) 
                 VALUES (?, ?, ?, 'customer', 'active', ?, 1, 'google', ?, NOW())`,
                [newUserId, name, email, picture || DEFAULT_PROFILE_PIC, google_id]
            );
            
            const [newUserRows] = await db.users.query("SELECT * FROM users WHERE id = ?", [newUserId]);
            user = newUserRows[0];
        }

        if (user.status === 'banned') {
            return res.status(403).json({ message: 'Your account is banned.' });
        }
        
        // 3. Login the user by creating your own site's token
        const jwtToken = generateToken(user);
        
        res.json({ message: "Login successful", token: jwtToken });

    } catch (error) {
        // This will catch errors if the accessToken is invalid or expired
        console.error("Google Auth Error:", error.response?.data || error.message);
        res.status(400).json({ message: "Google authentication failed. The token may be invalid." });
    }
};
// --- FORGOT PASSWORD ---
exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const [rows] = await db.users.query("SELECT id, full_name FROM users WHERE email = ?", [email]);
        if (rows.length === 0) return res.status(404).json({ message: "Email not found" });

        const user = rows[0];
        const resetToken = uuidv4();
        // Expire in 1 hour
        const expiresAt = new Date(Date.now() + 3600000); 

        await db.users.query(
            "UPDATE users SET reset_password_token = ?, reset_password_expires = ? WHERE id = ?",
            [resetToken, expiresAt, user.id]
        );

        const link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/reset-password?token=${resetToken}`;

        await sendEmail({
            to: email,
            subject: "Reset Your Password - SJ10",
            html: `<p>Click <a href="${link}">here</a> to reset your password.</p>`
        });

        res.json({ message: "Recovery email sent." });
    } catch (e) {
        res.status(500).json({ message: "Error sending email" });
    }
};

// --- RESET PASSWORD ---
exports.resetPassword = async (req, res) => {
    try {
        const { token, newPassword, confirmPassword } = req.body;
        
        if (newPassword !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });

        const [rows] = await db.users.query(
            "SELECT id FROM users WHERE reset_password_token = ? AND reset_password_expires > NOW()", 
            [token]
        );

        if (rows.length === 0) return res.status(400).json({ message: "Invalid or expired token" });

        const newHash = await bcrypt.hash(newPassword, 10);
        await db.users.query(
            "UPDATE users SET password_hash = ?, reset_password_token = NULL, reset_password_expires = NULL WHERE id = ?",
            [newHash, rows[0].id]
        );

        res.json({ message: "Password reset successfully. Please login." });
    } catch (e) {
        res.status(500).json({ message: "Error resetting password" });
    }
};