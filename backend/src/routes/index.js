/**
 * Centralized API Route Registry
 * Maps and mounts all REST API endpoints for v1 and v2 services.
 */
const express = require('express');

let betterAuthHandler = null;
try {
  const { toNodeHandler } = require('better-auth/node');
  const { auth } = require('../auth');
  if (auth) {
    betterAuthHandler = toNodeHandler(auth);
  }
} catch (e) {
  console.warn('[BetterAuth] Initialization note:', e.message);
}

const authRoutes = require('./authRoutes');
const otpRoutes = require('./otpRoutes');
const biometricRoutes = require('./biometricRoutes');
const accountRoutes = require('./accountRoutes');
const transactionRoutes = require('./transactionRoutes');
const securityRoutes = require('./securityRoutes');
const complaintRoutes = require('./complaintRoutes');
const adminRoutes = require('./adminRoutes');
const merchantRoutes = require('./merchantRoutes');
const aiRoutes = require('./aiRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const healthRoutes = require('./healthRoutes');
const notificationRoutes = require('./notificationRoutes');
const splitRoutes = require('./splitRoutes');
const fraudRoutes = require('./fraudRoutes');
const receiptRoutes = require('./receiptRoutes');
const savingsRoutes = require('./savingsRoutes');
const merchantAnalyticsRoutes = require('./merchantAnalyticsRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const assistantRoutes = require('./assistantRoutes');

/**
 * Registers all API routes onto the given Express application.
 * @param {import('express').Application} app
 */
function registerRoutes(app) {
  // Compatibility base route for zahid-afridi/EmailVerfication
  app.use('/auth', authRoutes);

  // Core V1 Banking & Auth APIs (login, register, biometric, pin, etc.)
  app.use('/api/auth', authRoutes);

  // Mount Better Auth node handler for dash plugin verification & sessions
  if (betterAuthHandler) {
    app.all('/api/auth/*', (req, res, next) => {
      betterAuthHandler(req, res, next);
    });
  }
  app.use('/api/otp', otpRoutes);
  app.use('/api/biometric', biometricRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/security', securityRoutes);
  app.use('/api/complaints', complaintRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/merchant', merchantRoutes);
  app.use('/api/assistants', assistantRoutes);

  // V2 Advanced Services & Intelligence APIs
  app.use('/api/v2/transactions', transactionRoutes);
  app.use('/api/v2/fraud', fraudRoutes);
  app.use('/api/v2/ai', aiRoutes);
  app.use('/api/v2/analytics', analyticsRoutes);
  app.use('/api/v2/health', healthRoutes);
  app.use('/api/v2/notifications', notificationRoutes);
  app.use('/api/v2/splits', splitRoutes);
  app.use('/api/v2/receipt', receiptRoutes);
  app.use('/api/v2/savings', savingsRoutes);
  app.use('/api/v2/merchant', merchantAnalyticsRoutes);
  app.use('/api/v2/subscriptions', subscriptionRoutes);
}

module.exports = {
  registerRoutes,
  authRoutes,
  otpRoutes,
  biometricRoutes,
  accountRoutes,
  transactionRoutes,
  securityRoutes,
  complaintRoutes,
  adminRoutes,
  merchantRoutes,
  aiRoutes,
  analyticsRoutes,
  healthRoutes,
  notificationRoutes,
  splitRoutes,
  fraudRoutes,
  receiptRoutes,
  savingsRoutes,
  merchantAnalyticsRoutes,
  subscriptionRoutes,
  assistantRoutes,
};
