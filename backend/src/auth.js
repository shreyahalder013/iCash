const { betterAuth } = require('better-auth');
const { prismaAdapter } = require('better-auth/adapters/prisma');
const { dash } = require('@better-auth/infra');
const prisma = require('./prisma');

// Normalize baseURL so it is the root URL without trailing slash or /api/auth
const rawUrl =
  process.env.BETTER_AUTH_URL || process.env.RENDER_EXTERNAL_URL || 'https://icash.onrender.com';

const baseURL = rawUrl
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/api\/auth$/, '');

const auth = betterAuth({
  baseURL,
  basePath: '/api/auth',
  secret:
    process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_API_KEY ||
    process.env.JWT_SECRET ||
    'default-secret-better-auth-key-change-in-production',
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  advanced: {
    database: {
      validateSchema: false,
    },
  },
  user: {
    fields: {
      name: 'full_name',
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  plugins: [
    dash({
      apiKey: process.env.BETTER_AUTH_API_KEY,
    }),
  ],
});

module.exports = { auth };
