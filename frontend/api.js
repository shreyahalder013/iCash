/**
 * iCash API Client
 * Handles communication with the Express.js backend.
 * Uses credentials: 'include' for secure HTTP-only cookie session handling.
 */

const API_BASE_CANDIDATES = [
  '', // Same origin if served from backend server
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:4001',
  'http://127.0.0.1:4001',
  'http://localhost:4002',
];

function getConfiguredBaseUrl() {
  if (typeof window !== 'undefined') {
    if (window.ICASH_CONFIG && typeof window.ICASH_CONFIG.API_BASE_URL === 'string' && window.ICASH_CONFIG.API_BASE_URL.trim()) {
      return window.ICASH_CONFIG.API_BASE_URL.trim().replace(/\/+$/, '');
    }
    const stored = localStorage.getItem('icash_api_url');
    if (stored && stored.trim()) {
      return stored.trim().replace(/\/+$/, '');
    }
    if (window.__API_BASE__ && typeof window.__API_BASE__ === 'string' && window.__API_BASE__.trim()) {
      return window.__API_BASE__.trim().replace(/\/+$/, '');
    }
  }
  return null;
}

let currentBase = getConfiguredBaseUrl();

// When the backend truly isn't reachable (e.g. it hasn't been started),
// every single API call — sign out, load dashboard, login, OTP, biometric
// verify — used to re-run the FULL same-origin + 6-candidate probe from
// scratch, with several of those fetches carrying no timeout at all. That
// made ordinary actions like "Sign Out" look hung/broken instead of
// failing fast with a clear message. We now: (a) bound every probe fetch
// with a short timeout, and (b) remember "nothing is reachable" for a few
// seconds so repeated clicks don't each pay the full probing cost again.
const PROBE_TIMEOUT_MS = 4000;
const NEGATIVE_CACHE_MS = 2500;
let lastProbeFailedAt = 0;

function fetchWithTimeout(url, options = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

async function detectApiBase() {
  if (currentBase === null && Date.now() - lastProbeFailedAt < NEGATIVE_CACHE_MS) {
    throw new Error('NO_BACKEND_REACHABLE');
  }

  if (currentBase !== null && currentBase !== '') {
    // Check if the configured remote server is healthy
    try {
      const res = await fetchWithTimeout(`${currentBase}/api/health`, { cache: 'no-store' }, PROBE_TIMEOUT_MS);
      if (res.ok) {
        lastProbeFailedAt = 0;
        return currentBase;
      }
    } catch (e) {
      console.warn(`[iCash API] Configured remote server (${currentBase}) health check failed, checking alternatives...`);
    }
  }

  // 1. If served over HTTP/HTTPS, same-origin relative URLs are best (unified backend server)
  if (
    typeof window !== 'undefined' &&
    window.location &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  ) {
    try {
      const res = await fetchWithTimeout('/api/health', { cache: 'no-store' }, PROBE_TIMEOUT_MS);
      if (res.ok) {
        currentBase = '';
        lastProbeFailedAt = 0;
        return currentBase;
      }
    } catch (e) {
      // If same-origin health failed, try candidates
    }
  }

  // 2. Try candidate URLs (for file:// protocol or standalone development)
  for (const base of API_BASE_CANDIDATES) {
    if (!base) continue;
    try {
      const res = await fetchWithTimeout(`${base}/api/health`, { cache: 'no-store' }, PROBE_TIMEOUT_MS);
      if (res.ok) {
        currentBase = base;
        lastProbeFailedAt = 0;
        return currentBase;
      }
    } catch (e) {
      // Try next
    }
  }

  // Nothing reachable at all
  lastProbeFailedAt = Date.now();
  return currentBase || '';
}

async function request(endpoint, options = {}) {
  let base;
  try {
    base = await detectApiBase();
  } catch (e) {
    // Our own short-lived "nothing reachable" cache throws NO_BACKEND_REACHABLE
    // instead of re-probing; fall through to the same friendly error the
    // network-failure path below produces.
    base = null;
  }
  if (base === null) {
    throw new Error(
      'Unable to connect to banking backend (http://localhost:4000). Please ensure the backend server is running and accessible.'
    );
  }
  const url = `${base}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const activeToken = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('icash_session_token') : null;
  const isFormData = configBodyIsFormData(options.body);
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(activeToken ? { Authorization: `Bearer ${activeToken}` } : {}),
    ...(options.headers || {}),
  };

  const config = {
    ...options,
    headers,
    credentials: 'include', // Both HTTP-only cookie and Authorization header supported
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  function configBodyIsFormData(body) {
    return typeof FormData !== 'undefined' && body instanceof FormData;
  }

  let response;
  try {
    response = await fetch(url, config);
  } catch (netErr) {
    const attemptedTarget = base ? base : (typeof window !== 'undefined' ? window.location.origin : 'server');
    throw new Error(
      `Unable to connect to banking backend (${attemptedTarget}). Please ensure the backend server is running and accessible.`
    );
  }

  let data;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch (e) {
      data = {};
    }
  } else {
    // No JSON API answered this request — most likely the static host's
    // SPA/404 fallback served back index.html (or some other HTML/plain
    // page) instead of a real API response. Never surface that raw body
    // to the UI: log it for debugging and treat the request as failed.
    const rawText = await response.text();
    console.error(
      `[iCash API] Expected JSON from ${url} but got "${contentType || 'unknown content-type'}". ` +
        `This usually means no backend is reachable at this origin. First 300 chars of response:`,
      rawText.slice(0, 300)
    );
    const error = new Error(
      'Unable to reach banking services right now. Please try again shortly, or contact support if this continues.'
    );
    error.status = response.status;
    error.nonJson = true;
    throw error;
  }

  // Persist session token in sessionStorage to guarantee seamless cross-origin and cross-port authentication
  if (data && data.token && typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('icash_session_token', data.token);
  }

  if (!response.ok) {
    if (response.status === 401) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('icash_session_token');
        sessionStorage.removeItem('icash_session_active');
      }
    }
    const errorMsg =
      data.message ||
      data.error ||
      (data.errors && data.errors[0]?.message) ||
      `Request failed with status ${response.status}`;
    const error = new Error(errorMsg);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

const api = {
  // Auth
  register: (userData) => request('/api/auth/register', { method: 'POST', body: userData }),
  loginAadhaar: (data) => request('/api/auth/login-aadhaar', { method: 'POST', body: data }),
  loginPin: (data) => request('/api/auth/login-pin', { method: 'POST', body: data }),
  loginBiometric: (biometricToken) =>
    request('/api/auth/login-biometric', { method: 'POST', body: { biometricToken } }),
  loginEmergencyPin: (data) =>
    request('/api/auth/login-emergency-pin', { method: 'POST', body: data }),
  logout: () => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('icash_session_token');
      sessionStorage.removeItem('icash_session_active');
    }
    return request('/api/auth/logout', { method: 'POST' });
  },
  getMe: () => request('/api/auth/me', { method: 'GET' }),
  refreshToken: () => request('/api/auth/refresh', { method: 'POST' }),
  // Delete own account (requires PIN confirmation)
  deleteMe: (data) => request('/api/auth/me', { method: 'DELETE', body: data }),

  // Email Verification (zahid-afridi/EmailVerfication)
  verifyEmail: (data) => request('/api/auth/verify-email', { method: 'POST', body: data }),
  resendVerification: (data) => request('/api/auth/resend-verification', { method: 'POST', body: data }),
  getVerificationStatus: () => request('/api/auth/verification-status', { method: 'GET' }),

  // OTP
  sendOtp: (mobile, purpose) =>
    request('/api/otp/send', { method: 'POST', body: { mobile, purpose } }),
  verifyOtp: (mobile, purpose, code) =>
    request('/api/otp/verify', { method: 'POST', body: { mobile, purpose, code } }),

  // Biometric — Secure challenge-based flow (v2)
  //
  // SECURITY DESIGN:
  //   issueChallenge  → GET a server-randomized challenge (nonce, type, expiry)
  //   verifyChallenge → POST completed proof; server validates liveness + face match server-side
  //                     Returns biometricToken on success. NO descriptor returned to browser.
  //   enrollmentStatus → GET enrollment status ONLY (no face vectors returned)
  //
  // Legacy:
  //   enrollBiometric  → POST descriptors + biometricToken (requires liveness proof)
  //   verifyBiometric  → disabled legacy endpoint; face matching alone never authorizes
  //   getBiometricProfile → REMOVED; use enrollmentStatus (descriptors never leave server)

  issueChallenge: (data = {}) =>
    request('/api/biometric/challenge', { method: 'POST', body: data }),

  sendBiometricFrame: (data) =>
    request('/api/biometric/frame', { method: 'POST', body: data }),

  verifyChallenge: (data) =>
    request('/api/biometric/verify-challenge', { method: 'POST', body: data }),

  verifyBiometric: (data) =>
    request('/api/biometric/verify', { method: 'POST', body: data }),

  enrollBiometric: (data) =>
    request('/api/biometric/enroll', { method: 'POST', body: data }),

  // Returns { ok, enrolled, provider } — NEVER returns face_descriptors
  enrollmentStatus: (userId) =>
    request(`/api/biometric/profile/${userId}`, { method: 'GET' }),

  // Alias kept for code that referenced getBiometricProfile — returns status only, NOT descriptors
  getBiometricProfile: (userId) =>
    request(`/api/biometric/profile/${userId}`, { method: 'GET' }),


  // Accounts
  getAccounts: () => request('/api/accounts', { method: 'GET' }),
  createAccount: (data) => request('/api/accounts', { method: 'POST', body: data }),
  updateAccount: (id, data) => request(`/api/accounts/${id}`, { method: 'PATCH', body: data }),
  setPrimaryAccount: (id) =>
    request(`/api/accounts/${id}`, { method: 'PATCH', body: { isPrimary: true } }),
  deleteAccount: (id) => request(`/api/accounts/${id}`, { method: 'DELETE' }),

  // Transactions
  getTransactions: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/api/transactions${query ? '?' + query : ''}`, { method: 'GET' });
  },
  getTransactionById: (id) => request(`/api/transactions/${id}`, { method: 'GET' }),
  depositMoney: (data) => request('/api/transactions/deposit', { method: 'POST', body: data }),
  createTransaction: (data) => {
    const payload = {
      ...data,
      transactionType: data.transactionType || data.type,
    };
    return request('/api/transactions', { method: 'POST', body: payload });
  },
  // Instant demo funds top-up (adds money to an account). Backend route:
  // POST /api/transactions/topup — gated by ALLOW_DEMO_TOPUP in production.
  topUpFunds: (data) => request('/api/transactions/topup', { method: 'POST', body: data }),
  // Emergency Contact & Authorized Representative Cash Withdrawal
  requestEmergencyWithdrawal: (data) =>
    request('/api/transactions/emergency-withdrawal/request', { method: 'POST', body: data }),
  verifyEmergencyWithdrawal: (data) =>
    request('/api/transactions/emergency-withdrawal/verify', { method: 'POST', body: data }),
  getEmergencyContacts: () => request('/api/transactions/emergency-contacts', { method: 'GET' }),
  updateEmergencyContacts: (contacts) =>
    request('/api/transactions/emergency-contacts', { method: 'POST', body: { contacts } }),

  // Legacy Delegated Senior Citizen Withdrawal (mapped to emergency endpoints)
  generateDelegateOtp: (data) =>
    request('/api/transactions/delegate/generate', { method: 'POST', body: data }),
  claimDelegateWithdrawal: (data) =>
    request('/api/transactions/delegate/claim', { method: 'POST', body: data }),

  // Security
  getSecurityStatus: () => request('/api/security/status', { method: 'GET' }),
  getSecurityEvents: () => request('/api/security/events', { method: 'GET' }),
  reportSecurityEvent: (data) => request('/api/security/events', { method: 'POST', body: data }),

  // Complaints
  getComplaints: () => request('/api/complaints', { method: 'GET' }),
  getMyComplaints: () => request('/api/complaints', { method: 'GET' }),
  createComplaint: (data) => request('/api/complaints', { method: 'POST', body: data }),

  // Admin
  getAdminUsers: () => request('/api/admin/users', { method: 'GET' }),
  getAdminUserById: (id) => request(`/api/admin/users/${id}`, { method: 'GET' }),
  updateUserStatus: (id, status) =>
    request(`/api/admin/users/${id}/status`, { method: 'PATCH', body: { status } }),
  getAdminTransactions: () => request('/api/admin/transactions', { method: 'GET' }),
  getAdminSecurityEvents: () => request('/api/admin/security-events', { method: 'GET' }),
  getAdminComplaints: () => request('/api/admin/complaints', { method: 'GET' }),
  resolveComplaint: (id, data) =>
    request(`/api/admin/complaints/${id}`, { method: 'PATCH', body: data }),

  // Merchant
  getMerchantProfile: () => request('/api/merchant/profile', { method: 'GET' }),
  createPaymentRequest: (data) =>
    request('/api/merchant/payment-requests', { method: 'POST', body: data }),
  getMerchantTransactions: () => request('/api/merchant/transactions', { method: 'GET' }),
  getMerchantSettlements: () => request('/api/merchant/settlements', { method: 'GET' }),
  processRefund: (data) => request('/api/merchant/refunds', { method: 'POST', body: data }),
  getMerchantDashboard: () => request('/api/v2/merchant/dashboard', { method: 'GET' }),
  getMerchantAnalytics: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/api/v2/merchant/analytics${query ? `?${query}` : ''}`, { method: 'GET' });
  },

  // AI-powered finance features (v2)
  scanReceipt: (formData) => request('/api/v2/receipt/scan', { method: 'POST', body: formData }),
  updateTransactionCategory: (id, category) =>
    request(`/api/v2/transactions/${id}/category`, { method: 'PATCH', body: { category } }),
  getFraudAnalysis: (id) => request(`/api/v2/fraud/${id}`, { method: 'GET' }),
  getForecast: () => request('/api/v2/analytics/forecast', { method: 'GET' }),
  getHealthScore: () => request('/api/v2/health/score', { method: 'GET' }),
  createExpenseGroup: (data) => request('/api/v2/splits/groups', { method: 'POST', body: data }),
  addSplitExpense: (data) => request('/api/v2/splits/expenses', { method: 'POST', body: data }),
  getOutstandingBalances: (groupId) =>
    request(`/api/v2/splits/groups/${groupId}/balances`, { method: 'GET' }),
  settleSplitDebt: (paymentId) =>
    request(`/api/v2/splits/payments/${paymentId}/pay`, { method: 'POST', body: {} }),
  getNotifications: () => request('/api/v2/notifications', { method: 'GET' }),
  markNotificationRead: (id) =>
    request(`/api/v2/notifications/${id}/read`, { method: 'PATCH', body: {} }),
  getSavingChallenges: () => request('/api/v2/savings/challenges', { method: 'GET' }),
  joinSavingChallenge: (id) =>
    request(`/api/v2/savings/challenges/${id}/join`, { method: 'POST', body: {} }),
  getSavingProgress: () => request('/api/v2/savings/progress', { method: 'GET' }),
  claimSavingReward: (progressId) =>
    request(`/api/v2/savings/progress/${progressId}/claim`, { method: 'POST', body: {} }),

  // Trusted Assistants & Emergency Assistance (Phase 17 & 19)
  listAssistants: () => request('/api/assistants', { method: 'GET' }),
  registerAssistant: (data) => request('/api/assistants/register', { method: 'POST', body: data }),
  getAssistantPermissions: (role) =>
    request(`/api/assistants/permissions?role=${encodeURIComponent(role || 'TRUSTED_HELPER')}`, { method: 'GET' }),
  createAssistantDraftTransfer: (data) =>
    request('/api/assistants/draft-transfer', { method: 'POST', body: data }),
  requestEmergencyAssistance: (data = {}) =>
    request('/api/assistants/emergency-assistance', { method: 'POST', body: data }),

  // Real-Time Liveness Server (Flask + OpenCV + dlib)
  liveness: {
    // URL is configurable via window.ICASH_CONFIG.LIVENESS_URL or falls back to localhost in dev.
    get baseUrl() {
      if (typeof window !== 'undefined' && window.ICASH_CONFIG?.LIVENESS_URL) {
        return window.ICASH_CONFIG.LIVENESS_URL.replace(/\/+$/, '');
      }
      if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        return 'http://127.0.0.1:5001';
      }
      return '';
    },

    start: async function(challengeType) {
      try {
        const res = await fetch(`${this.baseUrl}/liveness/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge_type: challengeType || 'BLINK_TWICE' }),
        });
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    sendFrame: async function(sessionId, base64Image, telemetry = {}) {
      try {
        const body = {
          session_id: sessionId,
          image: base64Image,
        };
        if (telemetry && telemetry.ear !== undefined) body.client_ear = telemetry.ear;
        if (telemetry && telemetry.leftEar !== undefined) body.left_ear = telemetry.leftEar;
        if (telemetry && telemetry.rightEar !== undefined) body.right_ear = telemetry.rightEar;
        if (telemetry && telemetry.isClosed !== undefined) body.is_closed = Boolean(telemetry.isClosed);
        if (telemetry && telemetry.blinkCount !== undefined) body.blink_count = telemetry.blinkCount;

        const res = await fetch(`${this.baseUrl}/liveness/frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    status: async function(sessionId) {
      try {
        const res = await fetch(
          `${this.baseUrl}/liveness/status?session_id=${encodeURIComponent(sessionId)}`
        );
        return await res.json();
      } catch (e) {
        return null;
      }
    },
    reset: async function(sessionId) {
      try {
        await fetch(`${this.baseUrl}/liveness/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        });
      } catch {
        // Reset call failed or server offline — safe to ignore
      }
    },
  },

  // AI Financial Copilot (v2)
  ai: {
    chat: (message) => request('/api/v2/ai/chat', { method: 'POST', body: { message } }),
    history: ({ limit, offset } = {}) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', limit);
      if (offset !== undefined) params.set('offset', offset);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return request(`/api/v2/ai/history${suffix}`, { method: 'GET' });
    },
  },

  // Server Configuration Helpers
  setServerUrl: (url) => {
    if (typeof localStorage !== 'undefined') {
      if (url && url.trim()) {
        localStorage.setItem('icash_api_url', url.trim().replace(/\/+$/, ''));
      } else {
        localStorage.removeItem('icash_api_url');
      }
    }
    currentBase = getConfiguredBaseUrl();
  },
  getServerUrl: () => {
    return currentBase || getConfiguredBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
  },
};

if (typeof window !== 'undefined') {
  window.iCashApi = api;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}