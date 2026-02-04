// utils/emailService.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

exports.sendEmail = async ({ to, subject, html }) => {
    try {
        await transporter.sendMail({
            from: '"SJ10 Support" <no-reply@sj10.com>', // Verify this sender in Brevo
            to,
            subject,
            html,
        });
        console.log(`📧 Email sent to ${to}`);
    } catch (error) {
        console.error("Email Error:", error);
    }
};