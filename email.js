// email.js - Sends transactional email (currently just password reset).
//
// Reads SMTP credentials from environment variables. If they're not set, every
// "send" just logs the content (including the reset link) to the server console
// instead of failing - so the reset flow is fully testable before you've set up
// a real email provider, and starts actually delivering the moment you add
// credentials, with no code changes needed.
//
// Required env vars for real sending:
//   SMTP_HOST      e.g. smtp.gmail.com
//   SMTP_PORT      e.g. 587 (or 465 for implicit TLS - set SMTP_SECURE=true if so)
//   SMTP_USER      the account to authenticate as
//   SMTP_PASS      an app password (NOT your regular account password on most providers)
//   EMAIL_FROM     the "from" address shown to recipients, e.g. "Coup <noreply@yourgame.com>"
// Optional:
//   SMTP_SECURE    "true" to use implicit TLS (typically paired with port 465)
//   APP_BASE_URL   the public URL of your site, e.g. https://yourgame.com
//                  (falls back to http://localhost:3001 for local dev)
//
// Any SMTP-compatible provider works here - a Gmail account with an app password
// is the fastest zero-cost way to get started; transactional services like Resend,
// SendGrid, Mailgun, or Postmark all also offer SMTP endpoints with free tiers
// suited to a small project, and are generally more reliable for higher volume.

const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getBaseUrl() {
  return process.env.APP_BASE_URL || 'http://localhost:3001';
}

let transporter = null;
function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
}

/**
 * Sends a password reset email containing a one-time link. If SMTP isn't
 * configured, logs the link to the console instead of sending anything.
 * Never throws - a failed/unconfigured send should not break the API response,
 * since forgot-password always returns the same generic message either way.
 */
async function sendPasswordResetEmail(toEmail, resetToken) {
  const resetLink = `${getBaseUrl()}/reset-password.html?token=${resetToken}`;

  if (!isEmailConfigured()) {
    console.log('');
    console.log('=== EMAIL NOT CONFIGURED - password reset link (would have been emailed) ===');
    console.log(`To: ${toEmail}`);
    console.log(`Link: ${resetLink}`);
    console.log('Set SMTP_HOST / SMTP_USER / SMTP_PASS / EMAIL_FROM env vars to send this for real.');
    console.log('===============================================================================');
    console.log('');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const transport = getTransporter();
    await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: toEmail,
      subject: 'Reset your Coup password',
      text: `Someone (hopefully you) requested a password reset for your Coup account.\n\n` +
            `Reset your password here: ${resetLink}\n\n` +
            `This link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #dc2626;">Reset your Coup password</h2>
          <p>Someone (hopefully you) requested a password reset for your Coup account.</p>
          <p>
            <a href="${resetLink}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">
              Reset Password
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">Or copy this link: ${resetLink}</p>
          <p style="color: #666; font-size: 14px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        </div>
      `
    });
    return { sent: true };
  } catch (error) {
    console.error('Failed to send password reset email:', error.message);
    // Also log the link as a fallback so the request isn't a total dead end
    console.log(`(Fallback) Reset link for ${toEmail}: ${resetLink}`);
    return { sent: false, reason: 'send_error' };
  }
}

module.exports = {
  isEmailConfigured,
  sendPasswordResetEmail
};
