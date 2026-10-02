const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT) || 587;
const secure = process.env.SMTP_SECURE === 'true' || port === 465;
const user = process.env.SMTP_USER || process.env.EMAIL_USER;
const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
const from = process.env.EMAIL_FROM || '"iCash Digital Banking" <noreply@icash.bank>';

function getTransporter() {
  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
    return {
      sendMail: async (options) => ({
        messageId: `test-${Date.now()}@icash.test`,
        accepted: [options.to],
        response: '250 Test Email OK',
      }),
    };
  }

  if (user && pass && !user.includes('your-') && !pass.includes('your-') && pass !== 'password') {
    const realTransport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass: pass.replace(/\s+/g, '') },
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
    });

    if (process.env.NODE_ENV === 'production') {
      return realTransport;
    }

    return {
      sendMail: async (options) => {
        try {
          return await realTransport.sendMail(options);
        } catch (smtpErr) {
          console.warn(
            `[iCash Email] SMTP dispatch failed (${smtpErr.message}). Falling back to dev logger:`
          );
          console.log(`\n============================================================`);
          console.log(`📧 [EMAIL DISPATCH] To: ${options.to}`);
          console.log(`   Subject: ${options.subject}`);
          if (options.text) console.log(`   Message: ${options.text}`);
          console.log(`============================================================\n`);
          return {
            messageId: `dev-fallback-${Date.now()}@icash.local`,
            accepted: [options.to],
            response: '250 Dev fallback email logged',
          };
        }
      },
    };
  }

  if (process.env.NODE_ENV === 'production') {
    return {
      sendMail: async () => {
        const error = new Error('Email service is not configured.');
        error.code = 'EMAIL_NOT_CONFIGURED';
        throw error;
      },
    };
  }

  // Graceful fallback for local development
  return {
    sendMail: async (options) => {
      console.log(`\n============================================================`);
      console.log(`📧 [EMAIL DISPATCH] To: ${options.to}`);
      console.log(`   Subject: ${options.subject}`);
      if (options.text) console.log(`   Message: ${options.text}`);
      console.log(`============================================================\n`);
      return {
        messageId: `mock-${Date.now()}@icash.local`,
        accepted: [options.to],
        response: '250 Mock Email Dispatched OK',
      };
    },
  };
}

const transporter = {
  sendMail: async (options) => getTransporter().sendMail(options),
};

module.exports = {
  transporter,
  from,
};
