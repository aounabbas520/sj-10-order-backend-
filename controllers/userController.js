const db = require('../config/database');
const bcrypt = require('bcryptjs');
const multer = require('multer'); // <-- 1. Import multer
const cloudinary = require('../config/cloudinaryConfig'); // <-- 1. Import our new config
const streamifier = require('streamifier'); // <-- 2. Import streamifier
// Configure Multer for in-memory storage. It's safer and more flexible for cloud uploads.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
exports.getMyProfile = async (req, res) => {
    try {
        const userId = req.user.id; 
        const [userRows, paymentRows] = await Promise.all([
            db.users.query("SELECT * FROM users WHERE id = ?", [userId]),
            db.wallet.query("SELECT * FROM users_payments_method WHERE user_id = ?", [userId])
        ]);
        
        if (userRows.length === 0 || userRows[0].length === 0) return res.status(404).json({ message: "User not found." });
        
        const fullProfile = { ...userRows[0][0], payment_methods: paymentRows[0] };
        delete fullProfile.password_hash;
        res.status(200).json(fullProfile);
    } catch (error) { 
        console.error(error);
        res.status(500).json({ message: "Error" }); 
    }
};
// --- 2. NEW FUNCTION: To handle the actual image upload ---
exports.uploadAvatar = async (req, res) => {
    // The 'upload.single('avatar')' middleware in the route will have processed the file.
    if (!req.file) {
        return res.status(400).json({ message: "No image file provided." });
    }

    // ===================================================================
    //  IMPORTANT: YOUR R2 / S3 UPLOAD LOGIC GOES HERE
    // ===================================================================
    //  - Use your cloud storage SDK (e.g., aws-sdk for S3/R2).
    //  - Upload `req.file.buffer` to your bucket.
    //  - Get the public URL of the uploaded image back from your cloud service.
    // ===================================================================
    
    // For now, we will simulate a successful upload and return a placeholder URL.
    // Replace this with the REAL URL you get from your cloud storage.
    const newImageUrl = `https://your-cloud-storage.com/path/to/new-image-${Date.now()}.webp`;

    console.log(`[Upload] User ${req.user.id} uploaded a new avatar. Stored at: ${newImageUrl}`);

    res.status(200).json({
        message: "Image uploaded successfully",
        newImageUrl: newImageUrl 
    });
};
exports.updateMyProfile = async (req, res) => {
    try {
        const { fullName, phone, brandName, profilePic } = req.body; // <-- Added brandName & profilePic
        const fields = [], values = [];

        if (fullName) { fields.push('full_name = ?'); values.push(fullName); }
        if (phone) { fields.push('phone = ?'); values.push(phone); }
        if (brandName) { fields.push('brand_name = ?'); values.push(brandName); }
        if (profilePic) { fields.push('profile_pic = ?'); values.push(profilePic); } // <-- Handle profile pic URL

        if (fields.length === 0) return res.status(400).json({ message: "No fields to update." });
        
        values.push(req.user.id);
        
        await db.users.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
        res.status(200).json({ message: "Profile updated successfully" });
    } catch (error) { 
        console.error("Update Profile Error:", error);
        res.status(500).json({ message: "Error updating profile." }); 
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ message: "Invalid input" });

        const [rows] = await db.users.query("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
        if (!await bcrypt.compare(currentPassword, rows[0].password_hash)) return res.status(401).json({ message: "Wrong password" });

        const newHash = await bcrypt.hash(newPassword, 10);
        await db.users.execute("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, req.user.id]);
        res.status(200).json({ message: "Password changed" });
    } catch (error) { res.status(500).json({ message: "Error" }); }
};

// --- THE NEW, FULLY FUNCTIONAL UPLOADAVATAR FUNCTION ---
exports.uploadAvatar = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No image file provided." });
    }

    // Helper function to upload the file buffer to Cloudinary
    let uploadFromBuffer = (buffer) => {
        return new Promise((resolve, reject) => {
            // Use .upload_stream to send the buffer
            let cld_upload_stream = cloudinary.uploader.upload_stream(
                {
                    // Optional: Create a folder in Cloudinary for organization
                    folder: "sj10_avatars", 
                    // Optional: Let Cloudinary auto-detect the best format (e.g., convert PNG to WEBP)
                    format: 'webp', 
                    // Optional: Resize the image to save space
                    transformation: [{ width: 250, height: 250, crop: 'limit' }]
                },
                (error, result) => {
                    if (result) {
                        resolve(result); // On success, resolve the promise with the result
                    } else {
                        reject(error); // On failure, reject the promise
                    }
                }
            );
            // Use streamifier to pipe the buffer into the Cloudinary stream
            streamifier.createReadStream(buffer).pipe(cld_upload_stream);
        });
    };

    try {
        // Call our helper function and wait for the upload to complete
        const result = await uploadFromBuffer(req.file.buffer);
        
        // The real, secure URL from Cloudinary
        const newImageUrl = result.secure_url;

        console.log(`[Cloudinary] User ${req.user.id} uploaded avatar. URL: ${newImageUrl}`);

        // Send the real URL back to the frontend
        res.status(200).json({
            message: "Image uploaded successfully",
            newImageUrl: newImageUrl 
        });

    } catch (error) {
        console.error("Cloudinary Upload Error:", error);
        res.status(500).json({ message: "Failed to upload image." });
    }
};