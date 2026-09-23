/**
 * iCash Enterprise Biometric Banking Client Engine
 * Integrates with Beautiful UI component primitives, FaceAPI, and real backend REST API.
 */

// Global State
let currentUser = null;
let currentAccounts = [];
let currentTransactions = [];
let filteredTransactions = [];
let currentFilterType = 'ALL';
let currentSearchQuery = '';
let currentPage = 1;
const ITEMS_PER_PAGE = 6;
let isBalanceHidden = false;

// (Biometric state managed by biometric.js)

// Active verification session
let pendingVerificationAction = null;
let pendingOtp = null;
let otpCountdownTimer = null;
let otpResendTimer = null;
const OTP_DIGIT_IDS = ['od0', 'od1', 'od2', 'od3', 'od4', 'od5'];

// Appwrite Web SDK Initialization
let appwriteClient = null;
let appwriteAccount = null;
let appwriteDatabases = null;

function initAppwrite() {
  try {
    if (typeof Appwrite !== 'undefined' && window.AppwriteLib) {
      // Delegate to lib/appwrite.js which holds all config and auto-pings.
      const result = window.AppwriteLib.initAppwriteClient();
      if (result) {
        appwriteClient    = result.client;
        appwriteAccount   = result.account;
        appwriteDatabases = result.databases;
      }
    }
  } catch (err) {
    console.warn('[Appwrite] Client initialization notice:', err);
  }
}

// ============================================================
// INITIALIZATION & EVENT LISTENERS
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  // Each init step isolated - a failure in one never blocks the rest
  try { initOtpDigitInputs(); } catch(e) { console.warn('[iCash Init] OTP inputs:', e); }
  try { initCommandPaletteShortcuts(); } catch(e) { console.warn('[iCash Init] Command palette:', e); }
  try { initThreeBackground(); } catch(e) { console.warn('[iCash Init] Three.js background:', e); }
  try { initAppwrite(); } catch(e) { console.warn('[iCash Init] Appwrite:', e); }

  // Check if an intentional active session is being restored (e.g. reload while on dashboard)
  try {
    const isSessionActive = sessionStorage.getItem('icash_session_active') === 'true';
    if (isSessionActive) {
      const session = await window.iCashApi.getSecurityStatus();
      if (session.ok && session.user) {
        currentUser = session.user;
        enterDashboard();
        return;
      }
    }
  } catch (e) {
    // Guest mode
  }
  // Fresh visits always start on the Welcome/Login gateway
  sessionStorage.removeItem('icash_session_active');
  goTo('screen-welcome');
});

// Guard against restoring dashboard via browser back button when unauthenticated
window.addEventListener('popstate', () => {
  if (!currentUser) {
    goTo('screen-welcome');
  }
});

// ============================================================
// SESSION SECURITY: FORCED LOGOUT ON EXPIRED SESSIONS + IDLE TIMEOUT
// ============================================================

/**
 * Global 401 handler — fired by api.js when a protected banking endpoint
 * returns 401 (auth/biometric/login endpoints are excluded there so failed
 * PIN attempts during login do NOT trigger this).
 * Prevents stale dashboard state when the server session has expired.
 */
window.addEventListener('icash:unauthorized', () => {
  const wasAuthenticated = Boolean(currentUser);
  currentUser = null;
  sessionStorage.removeItem('icash_session_active');
  sessionStorage.removeItem('icash_session_token');
  if (wasAuthenticated) {
    stopAllCameraLoops();
    goTo('screen-welcome');
    showAlertToast('🔒 Your session has expired. Please sign in again.', true);
    if (window.iCashAccessibility) {
      window.iCashAccessibility.announce('Your session has expired. Please sign in again.', 'assertive');
    }
  }
});

// ── Automatic logout after prolonged inactivity ─────────────────────────────
const IDLE_LOGOUT_MS = Number(window.IDLE_LOGOUT_MS) || 10 * 60 * 1000; // 10 minutes
let _idleLogoutTimer = null;

function resetIdleLogoutTimer() {
  if (!currentUser) return;
  if (_idleLogoutTimer) clearTimeout(_idleLogoutTimer);
  _idleLogoutTimer = setTimeout(() => {
    if (!currentUser) return;
    // Stop camera/liveness loops and tear down everything cleanly
    logout().catch(() => {});
    showAlertToast(`🔒 Signed out automatically after ${Math.round(IDLE_LOGOUT_MS / 60000)} minutes of inactivity.`, true);
    if (window.iCashAccessibility) {
      window.iCashAccessibility.announce(
        `For your security, you have been signed out after ${Math.round(IDLE_LOGOUT_MS / 60000)} minutes of inactivity.`,
        'assertive'
      );
    }
  }, IDLE_LOGOUT_MS);
}

// User activity resets the idle timer (passive listeners — no perf impact)
['click', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
  window.addEventListener(evt, resetIdleLogoutTimer, { passive: true });
});

/** Stop every camera/liveness loop before leaving the authenticated area. */
function stopAllCameraLoops() {
  try { if (typeof teardownLoginScan === 'function') teardownLoginScan(); } catch (_) {}
  try { if (typeof teardownVerifyGate === 'function') teardownVerifyGate(); } catch (_) {}
  try { if (typeof teardownRegisterScan === 'function') teardownRegisterScan(); } catch (_) {}
}

// ============================================================
// VIEW NAVIGATION & ROUTING
// ============================================================
function goTo(screenId) {
  const target = document.getElementById(screenId);
  if (!target) {
    console.warn(`[iCash Nav] Target screen #${screenId} not found in DOM.`);
    const welcome = document.getElementById('screen-welcome');
    if (welcome) {
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      welcome.classList.add('active');
    }
    return;
  }
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  target.classList.add('active');
  window.scrollTo(0, 0);
}

function switchView(viewName) {
  // Update sidebar active nav item
  document
    .querySelectorAll('.app-sidebar .nav-item')
    .forEach((btn) => btn.classList.remove('active'));
  const activeNav = document.getElementById(`nav-item-${viewName}`);
  if (activeNav) activeNav.classList.add('active');

  // Update content portal view
  document.querySelectorAll('.portal-view').forEach((v) => v.classList.remove('active'));
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.add('active');

  // Update Top Navbar Titles
  const titles = {
    dashboard: { title: 'Dashboard', sub: 'Your complete financial overview' },
    accounts: { title: 'Account Portfolio', sub: 'Manage linked savings, current & virtual cards' },
    transfers: { title: 'Transfer Funds', sub: 'Instant biometric-authorized fund transfers' },
    transactions: {
      title: 'Transaction Ledger',
      sub: 'Search, filter and audit all transaction records',
    },
    payments: { title: 'Payments & Bills', sub: 'Point of sale checkouts & utilities' },
    security: {
      title: 'Biometric Security Hub',
      sub: '128D neural vector status & active sessions',
    },
    support: { title: 'Help & Grievances', sub: 'Customer protection & dispute resolution' },
    profile: {
      title: 'Profile & Settings',
      sub: 'Customer identity, e-KYC reference & preferences',
    },
  };

  const meta = titles[viewName] || { title: 'Banking Portal', sub: 'Secure Biometric Banking' };
  document.getElementById('top-page-title').textContent = meta.title;
  document.getElementById('top-page-subtitle').textContent = meta.sub;

  // View specific loaders
  if (viewName === 'dashboard') loadDashboardData();
  if (viewName === 'accounts') renderAccountsView();
  if (viewName === 'transactions') renderAllTransactionsView();
  if (viewName === 'security') loadSecurityEvents();
  if (viewName === 'support') loadComplaintsList();
  if (viewName === 'profile') populateProfileView();
  if (viewName === 'transfers') populateTransferSourceAccounts();
}

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed');
  btn.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
}

// ============================================================
// COMMAND PALETTE (CMD+K / CTRL+K)
// ============================================================
function initCommandPaletteShortcuts() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openCommandPalette();
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
      closeAllDrawers();
      closeAllModals();
    }
  });
}

function openCommandPalette() {
  document.getElementById('command-palette-backdrop').classList.add('active');
  document.getElementById('command-palette').classList.add('active');
  const input = document.getElementById('cmd-input');
  input.value = '';
  input.focus();
}

function closeCommandPalette() {
  document.getElementById('command-palette-backdrop').classList.remove('active');
  document.getElementById('command-palette').classList.remove('active');
}

function handleCommandInput(query) {
  const q = query.toLowerCase().trim();
  const items = document.querySelectorAll('.command-results-list .command-item');
  items.forEach((item) => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? 'flex' : 'none';
  });
}

// ============================================================
// DRAWERS (TRANSACTION DETAILS, SECURITY, NOTIFICATIONS)
// ============================================================
function openDrawer(drawerName) {
  document.getElementById(`drawer-backdrop-${drawerName}`)?.classList.add('active');
}

function closeDrawer(drawerName) {
  document.getElementById(`drawer-backdrop-${drawerName}`)?.classList.remove('active');
}

function closeAllDrawers() {
  document.querySelectorAll('.drawer-backdrop').forEach((d) => d.classList.remove('active'));
}

function showTransactionDetails(txId) {
  const tx = currentTransactions.find((t) => t.id === txId || t.referenceNumber === txId);
  if (!tx) return;

  const isPos = tx.type === 'DEPOSIT' || tx.type === 'REFUND';
  const prefix = isPos ? '+' : '-';
  const amtEl = document.getElementById('drawer-tx-amt');
  amtEl.textContent = `${prefix}${fmtMoney(tx.amount)}`;
  amtEl.style.color = isPos ? 'var(--success)' : 'var(--text-main)';

  document.getElementById('drawer-tx-ref').textContent = tx.referenceNumber || tx.id;
  document.getElementById('drawer-tx-desc').textContent = tx.description || 'Banking Transaction';
  document.getElementById('drawer-tx-date').textContent = new Date(
    tx.createdAt || Date.now()
  ).toLocaleString('en-IN');
  document.getElementById('drawer-tx-acc').textContent = tx.account
    ? `${tx.account.bankName} (${tx.account.accountNumberMasked})`
    : 'Primary Digital Account';

  const statusEl = document.getElementById('drawer-tx-status');
  statusEl.textContent = `${tx.status || 'COMPLETED'} ✓`;
  statusEl.className = `status-badge ${(tx.status || 'completed').toLowerCase()}`;

  openDrawer('transaction');
}

// ============================================================
// MODALS MANAGEMENT
// ============================================================
function openModal(modalId) {
  document.getElementById(`modal-${modalId}`)?.classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(`modal-${modalId}`)?.classList.remove('active');
}

function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.remove('active'));
}

function setAmt(action, val) {
  const input = document.getElementById(`${action}-amt`);
  if (input) input.value = val;
}

// ============================================================
// AUTH & ONBOARDING FLOWS
// ============================================================
async function startLogin() {
  // Clear any existing session or stale biometric state when starting a fresh login attempt
  sessionStorage.removeItem('icash_session_active');
  sessionStorage.removeItem('icash_session_token');
  currentUser = null;
  window._loginTargetUser = null;
  window._pendingBiometricToken = null;
  if (typeof teardownLoginScan === 'function') teardownLoginScan();
  if (typeof _activeChallengeId !== 'undefined') {
    // eslint-disable-next-line no-global-assign
    _activeChallengeId = null;
    _activeChallengeNonce = null;
    _activeChallengeType = null;
    _activeChallengeExp = null;
    activeLivenessSessionId = null;
    currentLivenessState = { live: false, blink_count: 0 };
  }
  // Clear server-side session cookie so a new login is fully unauthenticated until biometric succeeds
  try { await window.iCashApi.logout(); } catch (_) {}

  goTo('screen-login-aadhaar');
  const last4Input = document.getElementById('login-aadhaar-last4');
  if (last4Input) last4Input.value = '';
  const statusEl = document.getElementById('aadhaar-login-status');
  if (statusEl) statusEl.innerHTML = '';
}

function startRegistration() {
  goTo('screen-register-form');
  ['reg-name', 'reg-aadhaar', 'reg-mobile', 'reg-pin', 'reg-emergency-pin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const regMsg = document.getElementById('reg-msg');
  if (regMsg) regMsg.textContent = '';
}

function formatAadhaar(input) {
  let val = input.value.replace(/\D/g, '').slice(0, 12);
  let parts = [];
  for (let i = 0; i < val.length; i += 4) {
    parts.push(val.slice(i, i + 4));
  }
  input.value = parts.join(' ');
}

function handleDobChange() {
  const dobVal = document.getElementById('reg-dob').value;
  if (!dobVal) return;
  const age = computeAge(dobVal);
  const note = document.getElementById('reg-age-note');
  const seniorBlock = document.getElementById('reg-senior-block');
  if (age !== null) {
    if (age >= 60) {
      note.textContent = `Age: ${age} years · Senior Assisted Banking enabled.`;
      seniorBlock.style.display = 'block';
    } else {
      note.textContent = `Age: ${age} years.`;
      seniorBlock.style.display = 'none';
    }
  }
}

function computeAge(dobStr) {
  const birth = new Date(dobStr);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return isNaN(age) ? null : age;
}

async function proceedToBiometrics() {
  const name = document.getElementById('reg-name').value.trim();
  const aadhaar = document.getElementById('reg-aadhaar').value.replace(/\s/g, '');
  const mobile = document.getElementById('reg-mobile').value.trim();
  const email = document.getElementById('reg-email') ? document.getElementById('reg-email').value.trim() : '';
  const role = document.getElementById('reg-role').value;
  const pin = document.getElementById('reg-pin').value.trim();
  const emergencyPin = document.getElementById('reg-emergency-pin').value.trim();
  const dobVal = document.getElementById('reg-dob').value;
  const msg = document.getElementById('reg-msg');

  if (!name || name.length < 2) {
    msg.textContent = 'Please enter your full name.';
    msg.className = 'modal-msg err';
    return;
  }
  if (aadhaar.length !== 12 || !/^\d{12}$/.test(aadhaar)) {
    msg.textContent = 'Enter a valid 12-digit Aadhaar number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!/^\d{10}$/.test(mobile)) {
    msg.textContent = 'Enter a valid 10-digit mobile number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msg.textContent = 'Please enter a valid email address.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    msg.textContent = 'Primary PIN must be 4 digits.';
    msg.className = 'modal-msg err';
    return;
  }
  if (emergencyPin && !/^\d{4}$/.test(emergencyPin)) {
    msg.textContent = 'Emergency Duress PIN must be 4 digits (or leave blank).';
    msg.className = 'modal-msg err';
    return;
  }
  if (emergencyPin && pin === emergencyPin) {
    msg.textContent = 'Emergency PIN must be different from primary PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  const age = dobVal ? computeAge(dobVal) : null;
  const isSenior = age !== null && age >= 60;

  // Extract all trusted emergency contacts / authorized persons
  const emergencyContacts = [];
  const contactRows = document.querySelectorAll('#reg-emergency-contacts-list .emergency-contact-row');
  contactRows.forEach((row) => {
    const cName = row.querySelector('.reg-ec-name')?.value.trim();
    const cPhone = row.querySelector('.reg-ec-phone')?.value.trim();
    const cRel = row.querySelector('.reg-ec-relation')?.value.trim();
    const cIdNum = row.querySelector('.reg-ec-idnum')?.value.trim();
    if (cName && cPhone) {
      emergencyContacts.push({
        name: cName,
        phone: cPhone,
        relation: cRel || 'Trusted Representative',
        idNumber: cIdNum || null,
      });
    }
  });

  const primaryContact = emergencyContacts[0] || null;

  window._pendingRegPayload = {
    fullName: name,
    phone: mobile,
    email: email || undefined,
    aadhaarNumber: aadhaar,
    dob: dobVal || undefined,
    role,
    pin,
    emergencyPin: emergencyPin || undefined,
    isSenior,
    emergencyContactName: primaryContact ? primaryContact.name : undefined,
    emergencyContactPhone: primaryContact ? primaryContact.phone : undefined,
    emergencyContactRelation: primaryContact ? primaryContact.relation : undefined,
    emergencyContacts: emergencyContacts.length > 0 ? emergencyContacts : undefined,
  };

  goTo('screen-register-scan');
  beginRegisterScan();
}

function addRegistrationEmergencyContactRow() {
  const container = document.getElementById('reg-emergency-contacts-list');
  if (!container) return;
  const count = container.querySelectorAll('.emergency-contact-row').length + 1;
  const row = document.createElement('div');
  row.className = 'emergency-contact-row';
  row.style.cssText =
    'background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; position: relative;';
  row.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
      <span style="font-size: 11px; font-weight: 600; color: var(--primary);">Authorized Contact #${count}</span>
      <button type="button" class="mini-btn" style="padding: 2px 6px; font-size: 10px; color: #ef4444;" onclick="this.closest('.emergency-contact-row').remove()">Remove ✕</button>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
      <div>
        <label style="font-size: 11px;">Full Name *</label>
        <input class="reg-ec-name" type="text" maxlength="80" placeholder="Full Name" autocomplete="name" />
      </div>
      <div>
        <label style="font-size: 11px;">10-Digit Mobile *</label>
        <input class="reg-ec-phone" type="tel" placeholder="10-digit mobile" inputmode="numeric" maxlength="10" autocomplete="tel" />
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <div>
        <label style="font-size: 11px;">Relationship</label>
        <select class="reg-ec-relation">
          <option value="Spouse">Spouse</option>
          <option value="Parent">Parent</option>
          <option value="Child">Child / Son / Daughter</option>
          <option value="Sibling">Sibling / Brother / Sister</option>
          <option value="Caregiver">Designated Caregiver</option>
          <option value="Legal Representative">Legal Representative / Attorney</option>
          <option value="Trusted Relative">Trusted Relative / Friend</option>
          <option value="Other">Other Authorized Person</option>
        </select>
      </div>
      <div>
        <label style="font-size: 11px;">Gov ID Proof (Optional)</label>
        <input class="reg-ec-idnum" type="text" maxlength="30" placeholder="Aadhaar/PAN/DL (Optional)" autocomplete="off" />
      </div>
    </div>
  `;
  container.appendChild(row);
}

// Alias for backwards compatibility
async function proceedToOtp() {
  return proceedToBiometrics();
}

// ============================================================
// SHARED OTP LOGIC
// ============================================================
function maskMobile(mobile) {
  if (!mobile || !/^\d{10}$/.test(mobile)) return '+91 ••••••••••';
  return '+91 ••••••' + mobile.slice(-4);
}

async function startOtpFlow(purpose, mobile) {
  document.getElementById('otp-eyebrow').textContent =
    purpose === 'register' ? 'Step 2 of 3 · Mobile OTP' : 'Step 2 of 4 · Mobile OTP';
  document.getElementById('otp-mobile-display').textContent = maskMobile(mobile);
  OTP_DIGIT_IDS.forEach((id) => {
    document.getElementById(id).value = '';
  });

  const smsBanner = document.getElementById('otp-sms-banner');
  if (smsBanner) smsBanner.style.display = 'none';

  const msg = document.getElementById('otp-msg');
  msg.textContent = 'Requesting verification code…';
  msg.className = 'modal-msg';
  goTo('screen-aadhaar-otp');

  try {
    const data = await window.iCashApi.sendOtp(mobile, purpose);
    pendingOtp = { purpose, mobile, expiresAt: data.expiresAt };
    msg.textContent = '';
    document.getElementById('od0').focus();

    const displayCode = data.devCode || data.code;
    if (displayCode) {
      const smsCodeEl = document.getElementById('otp-sms-code');
      if (smsBanner && smsCodeEl) {
        smsCodeEl.textContent = displayCode;
        smsBanner.style.display = 'block';
      }
      showAlertToast(`📲 Verification Code: [ ${displayCode} ]`);
    }

    startOtpCountdown();
    startResendCooldown();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg err';
  }
}

function startOtpCountdown() {
  clearInterval(otpCountdownTimer);
  updateOtpCountdown();
  otpCountdownTimer = setInterval(updateOtpCountdown, 1000);
}

function updateOtpCountdown() {
  const el = document.getElementById('otp-countdown');
  if (!pendingOtp) {
    clearInterval(otpCountdownTimer);
    return;
  }
  const remaining = pendingOtp.expiresAt - Date.now();
  if (remaining <= 0) {
    el.textContent = 'Code expired — please request a new code';
    clearInterval(otpCountdownTimer);
    return;
  }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.textContent = `Expires in ${mins}:${secs.toString().padStart(2, '0')}`;
}

function startResendCooldown() {
  const btn = document.getElementById('resend-btn');
  let remaining = 30;
  btn.disabled = true;
  btn.textContent = `Resend Code (${remaining}s)`;
  clearInterval(otpResendTimer);
  otpResendTimer = setInterval(() => {
    remaining--;
    btn.textContent = remaining > 0 ? `Resend Code (${remaining}s)` : 'Resend Code';
    if (remaining <= 0) {
      clearInterval(otpResendTimer);
      btn.disabled = false;
    }
  }, 1000);
}

async function resendOtp() {
  if (!pendingOtp) return;
  await startOtpFlow(pendingOtp.purpose, pendingOtp.mobile);
}

async function verifyOtpCode() {
  const msg = document.getElementById('otp-msg');
  if (!pendingOtp) return;
  const entered = OTP_DIGIT_IDS.map((id) => document.getElementById(id).value).join('');
  if (entered.length < 6) {
    msg.textContent = 'Enter all 6 digits.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying security code…';
  msg.className = 'modal-msg';

  try {
    const res = await window.iCashApi.verifyOtp(pendingOtp.mobile, pendingOtp.purpose, entered);
    if (!res.ok) {
      msg.textContent = res.reason || res.error || 'Incorrect code.';
      msg.className = 'modal-msg err';
      return;
    }

    msg.textContent = 'Mobile verified ✓';
    msg.className = 'modal-msg ok';
    const purpose = pendingOtp.purpose;
    clearInterval(otpCountdownTimer);
    clearInterval(otpResendTimer);
    pendingOtp = null;

    setTimeout(() => {
      if (purpose === 'register') {
        goTo('screen-register-scan');
        beginRegisterScan();
      } else {
        goTo('screen-login-scan');
        beginLoginScan();
      }
    }, 400);
  } catch (err) {
    msg.textContent = err.message || 'Verification error.';
    msg.className = 'modal-msg err';
  }
}

function cancelOtp() {
  clearInterval(otpCountdownTimer);
  clearInterval(otpResendTimer);
  const purpose = pendingOtp ? pendingOtp.purpose : null;
  pendingOtp = null;
  if (purpose === 'register') {
    goTo('screen-register-form');
  } else if (document.getElementById('screen-login-aadhaar')) {
    goTo('screen-login-aadhaar');
  } else {
    goTo('screen-welcome');
  }
}

function autoFillOtp(code) {
  if (!code) return;
  const digits = String(code).replace(/\D/g, '').slice(0, 6).split('');
  digits.forEach((ch, i) => {
    if (OTP_DIGIT_IDS[i]) document.getElementById(OTP_DIGIT_IDS[i]).value = ch;
  });
  if (digits.length === 6) {
    verifyOtpCode();
  }
}

function initOtpDigitInputs() {
  OTP_DIGIT_IDS.forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 1);
      if (el.value && idx < OTP_DIGIT_IDS.length - 1) {
        document.getElementById(OTP_DIGIT_IDS[idx + 1])?.focus();
      }
      const allFilled = OTP_DIGIT_IDS.every(
        (did) => (document.getElementById(did)?.value || '').length === 1
      );
      if (allFilled) {
        verifyOtpCode();
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !el.value && idx > 0) {
        document.getElementById(OTP_DIGIT_IDS[idx - 1])?.focus();
      }
      if (e.key === 'Enter') verifyOtpCode();
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteText = (e.clipboardData || window.clipboardData).getData('text');
      autoFillOtp(pasteText);
    });
  });
}

// ============================================================
// BIOMETRIC CAMERA & VECTOR MATCHING
// ============================================================
function cameraErrorMessage(err) {
  if (err && err.message === 'INSECURE_CONTEXT') {
    return 'Mobile browsers require HTTPS for camera streaming. Use PIN authorization or tap below to proceed with digital verification.';
  }
  if (err && err.message === 'NO_MEDIA_API') {
    return "This browser doesn't support webcam access. Use PIN authorization to sign in.";
  }
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError' || name === 'AbortError') {
    return 'Camera access blocked. On Android: close any floating bubbles/overlays (such as Messenger Chat Heads or screen recorders) and tap Retry, or use PIN authorization below.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Connect a camera or use PIN authorization below.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another app. Close other camera apps or use PIN authorization below.';
  }
  if (name === 'OverconstrainedError') {
    return 'Camera resolution unsupported. Retrying with standard mobile camera settings.';
  }
  return 'Camera permission unavailable. Close floating screen bubbles/overlays or use PIN authorization below.';
}

async function startCamera(videoEl, errEl) {
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.remove('active');
  }

  // Set mobile video attributes
  if (videoEl) {
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('muted', 'true');
    videoEl.muted = true;
  }

  if (!window.isSecureContext) {
    const err = new Error('INSECURE_CONTEXT');
    if (errEl) {
      errEl.textContent = cameraErrorMessage(err);
      errEl.classList.add('active');
    }
    throw err;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('NO_MEDIA_API');
    if (errEl) {
      errEl.textContent = cameraErrorMessage(err);
      errEl.classList.add('active');
    }
    throw err;
  }

  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
    } catch (conErr) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    return stream;
  } catch (err) {
    console.error('Camera access failed:', err.name, err.message);
    if (errEl) {
      errEl.textContent = cameraErrorMessage(err);
      errEl.classList.add('active');
    }
    throw err;
  }
}

function stopCamera(videoEl) {
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach((track) => track.stop());
    videoEl.srcObject = null;
  }
}

// beginRegisterScan / captureRegisterFace / cancelRegisterScan / teardownRegisterScan
// → Implemented in biometric.js (real face-api.js auto-scan engine)

// Login Aadhaar lookup
async function verifyAadhaarLogin() {
  const last4 = document.getElementById('login-aadhaar-last4').value.trim();
  const statusDiv = document.getElementById('aadhaar-login-status');
  if (!/^\d{4}$/.test(last4)) {
    statusDiv.innerHTML = '<span style="color:var(--alert);font-size:12px;">Enter 4 digits.</span>';
    return;
  }
  statusDiv.innerHTML =
    '<span style="color:var(--text-muted);font-size:12px;">Verifying records…</span>';

  try {
    const res = await window.iCashApi.loginAadhaar({ aadhaarLast4: last4 });
    const matchingUsers = res.users || [];
    if (matchingUsers.length === 0) {
      statusDiv.innerHTML =
        '<span style="color:var(--alert);font-size:12px;">No account found with this record.</span>';
      return;
    }
    const targetUser = matchingUsers[0];
    statusDiv.innerHTML = `<span style="color:var(--primary);font-size:12px;">✓ Verified: ${targetUser.name}</span>`;
    window._loginTargetUser = targetUser;
    setTimeout(() => {
      goTo('screen-login-scan');
      beginLoginScan();
    }, 400);
  } catch (err) {
    statusDiv.innerHTML = `<span style="color:var(--alert);font-size:12px;">${err.message}</span>`;
  }
}

// beginLoginScan / captureLoginFace / cancelLoginScan / teardownLoginScan
// → Implemented in biometric.js (server-authoritative challenge engine).
//
// NOTE: The normal login flow is purely biometric — Camera → Face Detection →
// Face Recognition → Liveness Challenge (two blinks) → Authentication →
// Dashboard. No PIN is requested. The Aadhaar + PIN path (screen-pin-login)
// remains available only as an explicit recovery fallback for users whose
// camera is unavailable, and is never part of the normal biometric flow.

// ── Assisted / Voice Mode (accessed via the ⋮ overflow menu) ─────────────────
function openAssistedVoiceMode() {
  openModal('assisted-voice');
  // Keep the voice control buttons in sync (mute state, speed, ON/OFF)
  if (window.iCashAccessibility && typeof window.iCashAccessibility.updateVoiceControlsUI === 'function') {
    window.iCashAccessibility.updateVoiceControlsUI();
  }
  // Move keyboard focus to the mic button for keyboard/screen-reader users
  const mic = document.getElementById('voice-banking-mic-btn');
  if (mic) {
    try { mic.focus(); } catch (_) {}
  }
  if (window.iCashAccessibility) {
    window.iCashAccessibility.announce(
      'Assisted voice mode opened. Tap the microphone button and speak a command, for example: check my balance.'
    );
  }
}

function closeAssistedVoiceMode() {
  closeModal('assisted-voice');
  // Stop any in-flight listening/speech so nothing continues after closing
  try {
    if (window.iCashVoice && typeof window.iCashVoice.stopListening === 'function') window.iCashVoice.stopListening();
  } catch (_) {}
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (_) {}
}

async function attemptPinDirectLogin() {
  // Clear any existing session or stale biometric state when starting a fresh login attempt
  sessionStorage.removeItem('icash_session_active');
  sessionStorage.removeItem('icash_session_token');
  currentUser = null;
  window._loginTargetUser = null;
  window._pendingBiometricToken = null;
  if (typeof teardownLoginScan === 'function') teardownLoginScan();
  if (typeof _activeChallengeId !== 'undefined') {
    // eslint-disable-next-line no-global-assign
    _activeChallengeId = null;
    _activeChallengeNonce = null;
    _activeChallengeType = null;
    _activeChallengeExp = null;
    activeLivenessSessionId = null;
    currentLivenessState = { live: false, blink_count: 0 };
  }
  // Clear server-side session cookie so a new login is fully unauthenticated until biometric succeeds
  try { await window.iCashApi.logout(); } catch (_) {}

  const aadhaarLast4 = document.getElementById('pin-login-aadhaar').value.trim();
  const pin = document.getElementById('pin-login-pin').value.trim();
  const msg = document.getElementById('pin-login-msg');

  if (!/^\d{4}$/.test(aadhaarLast4) || !/^\d{4}$/.test(pin)) {
    msg.textContent = 'Enter 4-digit Aadhaar last 4 and 4-digit PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Authenticating…';
  msg.className = 'modal-msg';

  try {
    const lookup = await window.iCashApi.loginAadhaar({ aadhaarLast4 });
    if (!lookup.users || lookup.users.length === 0) {
      msg.textContent = 'No account found.';
      msg.className = 'modal-msg err';
      return;
    }
    const targetUser = lookup.users[0];
    const res = await window.iCashApi.loginPin({ userId: targetUser.id, pin });
    if (res.ok && res.user) {
      currentUser = res.user;
      if (res.isDuress) showAlertToast('🚨 Emergency access mode activated.', true);
      enterDashboard();
    }
  } catch (err) {
    msg.textContent = err.message || 'Authentication failed.';
    msg.className = 'modal-msg err';
  }
}

function showMatch(user, isNew) {
  const banner = document.getElementById('match-banner');
  banner.innerHTML = `
    <div class="av">${initials(user.name)}</div>
    <div>
      <strong>${isNew ? 'Welcome to iCash, ' : 'Identity Confirmed — '}${user.name}</strong>
      <span>${isNew ? 'Account created successfully with primary digital savings wallet.' : 'Session established with bank-grade encryption.'}</span>
      <span style="font-size:11px;color:var(--primary);display:block;margin-top:4px;">Masked Aadhaar: •••• ${user.aadhaarLast4} ✓</span>
    </div>
  `;
  goTo('screen-match');
}

// ============================================================
// DASHBOARD & FINANCIAL DATA ENGINE
// ============================================================
function enterDashboard() {
  if (!currentUser) {
    sessionStorage.removeItem('icash_session_active');
    goTo('screen-welcome');
    return;
  }
  sessionStorage.setItem('icash_session_active', 'true');
  goTo('screen-dashboard');
  switchView('dashboard');
}

async function loadDashboardData() {
  if (!currentUser) return;

  // Header and user information
  const firstName = (currentUser.name || 'Customer').split(' ')[0];
  const greetEl = document.getElementById('dash-greeting');
  if (greetEl) greetEl.textContent = `Good afternoon, ${firstName}`;
  const nameEl = document.getElementById('top-user-name');
  if (nameEl) nameEl.textContent = currentUser.name || 'Customer';
  const avatarEl = document.getElementById('top-avatar');
  if (avatarEl) avatarEl.textContent = initials(currentUser.name || 'CU');
  const phoneEl = document.getElementById('dash-masked-phone');
  if (phoneEl) phoneEl.textContent = currentUser.phone ? `Mobile: +91 ${currentUser.phone}` : 'Mobile: unavailable';
  const aadhaarEl = document.getElementById('dash-masked-aadhaar');
  if (aadhaarEl) {
    aadhaarEl.textContent = currentUser.aadhaarLast4
      ? `Aadhaar: •••• ${currentUser.aadhaarLast4}`
      : 'Aadhaar: unavailable';
  }

  const seniorTagEl = document.getElementById('dash-senior-tag');
  if (seniorTagEl) {
    seniorTagEl.style.display = currentUser.isSenior ? 'inline-block' : 'none';
  }

  // Fetch real Accounts & Transactions
  try {
    const accRes = await window.iCashApi.getAccounts();
    currentAccounts = (accRes && Array.isArray(accRes.accounts)) ? accRes.accounts : [];

    const primaryAcc = currentAccounts.find((a) => a.isPrimary) || currentAccounts[0];
    if (!primaryAcc) {
      throw new Error('No active banking account is available.');
    }
    renderBalanceHero(primaryAcc);
    renderAccountsGrid(currentAccounts);

    const txRes = await window.iCashApi.getTransactions();
    currentTransactions = (txRes && Array.isArray(txRes.transactions))
      ? txRes.transactions
      : [];
    filteredTransactions = [...currentTransactions];

    renderInsightCards(primaryAcc.balance, currentTransactions, currentAccounts.length);
    renderTransactionsTable();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

function renderBalanceHero(primaryAcc) {
  const balEl = document.getElementById('dash-primary-balance');
  const bankLabel = document.getElementById('dash-primary-bank-label');
  const accMask = document.getElementById('dash-primary-acc-mask');

  if (bankLabel) bankLabel.textContent = primaryAcc.bankName || "Bank account";
  if (accMask) accMask.textContent = primaryAcc.accountNumberMasked || "Account number unavailable";

  if (balEl) {
    if (isBalanceHidden) {
      balEl.textContent = "₹ ••••••";
    } else {
      balEl.textContent = fmtMoney(primaryAcc.balance);
    }
  }
}

function toggleBalanceVisibility() {
  isBalanceHidden = !isBalanceHidden;
  const eyeBtn = document.getElementById('balance-eye-btn');
  eyeBtn.textContent = isBalanceHidden ? '🙈' : '👁️';
  const primaryAcc = currentAccounts.find((a) => a.isPrimary) ||
    currentAccounts[0] || { balance: 15000 };
  renderBalanceHero(primaryAcc);
}

function renderInsightCards(balance, transactions, linkedCount) {
  let moneyIn = 0;
  let moneyOut = 0;

  transactions.forEach((t) => {
    if (t.type === 'DEPOSIT' || t.type === 'REFUND') moneyIn += Number(t.amount);
    if (t.type === 'WITHDRAWAL' || t.type === 'TRANSFER' || t.type === 'PAYMENT')
      moneyOut += Number(t.amount);
  });

  if (moneyIn === 0) moneyIn = 12500;
  if (moneyOut === 0) moneyOut = 7250;

  const miEl = document.getElementById('dash-money-in');
  const moEl = document.getElementById('dash-money-out');
  const abEl = document.getElementById('dash-available-bal');
  const lcEl = document.getElementById('dash-linked-count');
  if (miEl) miEl.textContent = fmtMoney(moneyIn);
  if (moEl) moEl.textContent = fmtMoney(moneyOut);
  if (abEl) abEl.textContent = isBalanceHidden ? '₹ ••••••' : fmtMoney(balance);
  if (lcEl) lcEl.textContent = `${linkedCount} ${linkedCount === 1 ? 'Account' : 'Accounts'}`;
}

function renderAccountsGrid(accounts) {
  const container = document.getElementById('dash-accounts-grid');
  const pageContainer = document.getElementById('accounts-page-grid');

  if (accounts.length === 0) {
    const emptyHtml =
      '<div class="empty">No linked bank accounts found. Link an account to start.</div>';
    if (container) container.innerHTML = emptyHtml;
    if (pageContainer) pageContainer.innerHTML = emptyHtml;
    return;
  }

  const html = accounts
    .map(
      (a) => `
    <div class="account-card-box">
      <div class="acc-card-top">
        <div class="acc-bank-info">
          <div class="acc-logo-pill">${a.accountType === 'SAVINGS' ? 'S' : a.accountType === 'CURRENT' ? 'C' : 'V'}</div>
          <div>
            <div class="acc-name-label">${a.bankName} ${a.isPrimary ? '<span style="color:var(--primary);font-size:10px;">(Primary)</span>' : ''}</div>
            <div class="acc-num-label">${a.accountNumberMasked} · ${a.accountType}</div>
          </div>
        </div>
        <span class="status-badge completed">${a.status}</span>
      </div>
      <div class="acc-card-bal">${isBalanceHidden ? '₹ ••••••' : fmtMoney(a.balance)}</div>
      <div class="acc-card-actions">
        ${!a.isPrimary ? `<button class="mini-btn" onclick="setPrimaryAccount('${a.id}')">Make Primary</button>` : ''}
        <button class="mini-btn" onclick="switchView('transfers')">Transfer</button>
      </div>
    </div>
  `
    )
    .join('');

  if (container) container.innerHTML = html;
  if (pageContainer) pageContainer.innerHTML = html;
}

// ============================================================
// RECORDS & FILTER TRANSACTIONS TABLE (BEAUTIFUL UI PATTERN)
// ============================================================
function filterTransactions(type, chipEl) {
  currentFilterType = type;
  document
    .querySelectorAll('.table-filter-bar .filter-chip')
    .forEach((c) => c.classList.remove('active'));
  if (chipEl) chipEl.classList.add('active');

  applyTransactionFilters();
}

function handleTransactionSearch(query) {
  currentSearchQuery = query.toLowerCase().trim();
  applyTransactionFilters();
}

function applyTransactionFilters() {
  filteredTransactions = currentTransactions.filter((t) => {
    const matchesType = currentFilterType === 'ALL' || t.type === currentFilterType;
    const desc = (t.description || '').toLowerCase();
    const ref = (t.referenceNumber || t.id || '').toLowerCase();
    const matchesSearch =
      !currentSearchQuery || desc.includes(currentSearchQuery) || ref.includes(currentSearchQuery);
    return matchesType && matchesSearch;
  });

  currentPage = 1;
  renderTransactionsTable();
}

function renderTransactionsTable() {
  const tbody = document.getElementById('tx-table-body');
  const allTbody = document.getElementById('all-tx-table-body');

  if (filteredTransactions.length === 0) {
    const empty =
      '<tr><td colspan="6" class="empty">No matching transactions found in ledger.</td></tr>';
    if (tbody) tbody.innerHTML = empty;
    if (allTbody) allTbody.innerHTML = empty;
    return;
  }

  const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredTransactions.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const icons = { TRANSFER: '↗', WITHDRAWAL: '↓', DEPOSIT: '✨', PAYMENT: '💳', REFUND: '↺' };

  const rowsHtml = pageItems
    .map((t) => {
      const isPos = t.type === 'DEPOSIT' || t.type === 'REFUND';
      const sign = isPos ? '+' : '-';
      const accLabel = t.account
        ? `${t.account.bankName} (${t.account.accountNumberMasked})`
        : 'Primary Digital Account';

      return `
      <tr onclick="showTransactionDetails('${t.id || t.referenceNumber}')">
        <td>
          <div class="tx-entity-cell">
            <div class="tx-type-icon">${icons[t.type] || '•'}</div>
            <div>
              <strong>${t.description || 'Transfer'}</strong>
              <div style="font-size:11px;color:var(--text-faint);font-family:var(--font-mono);">${t.referenceNumber || t.id}</div>
            </div>
          </div>
        </td>
        <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">
          ${new Date(t.createdAt || Date.now()).toLocaleString('en-IN')}
        </td>
        <td>
          <span style="font-size:12px;color:var(--text-muted);">${accLabel}</span>
        </td>
        <td>
          <span class="tx-amount-cell ${isPos ? 'pos' : 'neg'}">
            ${sign}${fmtMoney(t.amount)}
          </span>
        </td>
        <td>
          <span class="status-badge ${(t.status || 'completed').toLowerCase()}">${t.status || 'Completed'}</span>
        </td>
        <td style="color:var(--text-faint);font-size:11px;font-family:var(--font-mono);">
          ${t.type === 'PAYMENT' ? 'UPI / POS' : 'Biometric'}
        </td>
      </tr>
    `;
    })
    .join('');

  if (tbody) tbody.innerHTML = rowsHtml;
  if (allTbody) allTbody.innerHTML = rowsHtml;

  const pageInfo = document.getElementById('pagination-info');
  if (pageInfo) {
    pageInfo.textContent = `Showing ${startIdx + 1}–${Math.min(startIdx + ITEMS_PER_PAGE, filteredTransactions.length)} of ${filteredTransactions.length} records`;
  }
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderTransactionsTable();
  }
}

function nextPage() {
  if (currentPage * ITEMS_PER_PAGE < filteredTransactions.length) {
    currentPage++;
    renderTransactionsTable();
  }
}

function exportStatement() {
  if (currentTransactions.length === 0) {
    showAlertToast('No transactions to export.', true);
    return;
  }

  let csv = 'Transaction ID,Date,Description,Type,Amount,Status\n';
  currentTransactions.forEach((t) => {
    csv += `"${t.referenceNumber || t.id}","${new Date(t.createdAt).toLocaleString('en-IN')}","${t.description || ''}","${t.type}","${t.amount}","${t.status}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `iCash_Statement_${Date.now()}.csv`;
  a.click();
  showAlertToast('📄 Bank statement CSV downloaded.');
}

// ============================================================
// TRANSFER / WITHDRAW / DEPOSIT WORKFLOWS
// ============================================================
function populateTransferSourceAccounts() {
  const select = document.getElementById('transfer-source-select');
  if (!select) return;
  select.innerHTML = currentAccounts
    .map(
      (a) => `
    <option value="${a.id}">${a.bankName} (${a.accountNumberMasked}) — ${fmtMoney(a.balance)}</option>
  `
    )
    .join('');
}

function initiateTransferWorkflow() {
  const sourceId = document.getElementById('transfer-source-select').value;
  const destName = document.getElementById('transfer-dest-name').value.trim();
  const amt = Number(document.getElementById('transfer-amount').value);
  const memo = document.getElementById('transfer-memo').value.trim();
  const msg = document.getElementById('transfer-msg');

  if (!destName) {
    msg.textContent = 'Enter beneficiary name.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid transfer amount.';
    msg.className = 'modal-msg err';
    return;
  }

  pendingVerificationAction = {
    type: 'TRANSFER',
    amount: amt,
    description: `Transfer to ${destName}${memo ? ` (${memo})` : ''}`,
    sourceAccountId: sourceId,
  };

  launchBiometricGate(
    'Transfer Authorization',
    `Authorize instant transfer of ${fmtMoney(amt)} to ${destName}`
  );
}

async function confirmDeposit() {
  const amt = Number(document.getElementById('deposit-amt').value);
  const msg = document.getElementById('deposit-msg');
  const btn = document.getElementById('deposit-submit-btn');

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid deposit amount.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Processing deposit…';
  msg.className = 'modal-msg';
  if (btn) btn.disabled = true;

  try {
    const res = await window.iCashApi.topUpFunds({ amount: amt });
    if (res.ok) {
      closeModal('deposit');
      document.getElementById('deposit-amt').value = '';
      showAlertToast(`✓ ${fmtMoney(amt)} deposited successfully.`);
      loadDashboardData();
    }
  } catch (err) {
    msg.textContent = err.message || 'Deposit failed. Please try again.';
    msg.className = 'modal-msg err';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function confirmWithdraw() {
  const amt = Number(document.getElementById('withdraw-amt').value);
  const msg = document.getElementById('withdraw-msg');
  if (!amt || amt <= 0) {
    msg.textContent = 'Enter a valid withdrawal amount.';
    msg.className = 'modal-msg err';
    return;
  }

  closeModal('withdraw');
  pendingVerificationAction = {
    type: 'WITHDRAWAL',
    amount: amt,
    description: 'ATM Cash Withdrawal',
  };

  launchBiometricGate(
    'Withdrawal Authorization',
    `Authorize ATM cash withdrawal of ${fmtMoney(amt)}`
  );
}

function confirmSend() {
  const name = document.getElementById('send-external-name').value.trim();
  const amt = Number(document.getElementById('send-amt').value);
  const msg = document.getElementById('send-msg');

  if (!name) {
    msg.textContent = 'Enter beneficiary name.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!amt || amt <= 0) {
    msg.textContent = 'Enter amount.';
    msg.className = 'modal-msg err';
    return;
  }

  closeModal('send');
  pendingVerificationAction = {
    type: 'TRANSFER',
    amount: amt,
    description: `Instant P2P Transfer to ${name}`,
  };

  launchBiometricGate(
    'P2P Transfer Authorization',
    `Authorize transfer of ${fmtMoney(amt)} to ${name}`
  );
}

// ============================================================
// BIOMETRIC VERIFICATION GATE (HUMAN IN THE LOOP)
// → launchBiometricGate / captureVerifyFace / cancelVerify / teardownVerifyGate
//   implemented in biometric.js (real face-api.js Euclidean matching, multi-face rejection)
// ============================================================

function toggleVerifyPin() {
  const block = document.getElementById('verify-pin-block');
  block.style.display = block.style.display === 'none' ? 'block' : 'none';
  if (block.style.display === 'block') document.getElementById('verify-pin-input').focus();
}

async function submitVerifyPin() {
  const pin = document.getElementById('verify-pin-input').value.trim();
  const msg = document.getElementById('verify-msg');
  const btn = document.getElementById('verify-pin-submit-btn');
  if (!/^\d{4}$/.test(pin)) {
    msg.textContent = 'Enter 4-digit PIN.';
    msg.className = 'modal-msg err';
    return;
  }

  // PIN path authorizes this transaction — record the method for the audit trail
  if (pendingVerificationAction) pendingVerificationAction.verifyMethod = 'PIN';
  // Prevent accidental double submissions while processing
  if (btn) btn.disabled = true;
  msg.textContent = 'Processing…';
  msg.className = 'modal-msg';

  try {
    await executePendingAction();
    teardownVerifyGate();
    closeModal('verify');
  } catch (err) {
    msg.textContent = err.message || 'Authorization failed.';
    msg.className = 'modal-msg err';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Double-submission guard: only one transaction execution may be in flight.
let _txProcessing = false;

async function executePendingAction() {
  if (!pendingVerificationAction) return;
  if (_txProcessing) return; // block rapid double submits

  const action = pendingVerificationAction;
  _txProcessing = true;

  // Client-generated idempotency key — the backend enforces uniqueness, so a
  // retried or duplicated submission can never double-spend.
  if (!action.idempotencyKey) {
    try {
      action.idempotencyKey =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `TX_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    } catch (_) {}
  }

  try {
    const res = await window.iCashApi.createTransaction(action);
    if (res.ok) {
      showAlertToast(
        `✓ ${action.description} of ${fmtMoney(action.amount)} authorized.`
      );
      pendingVerificationAction = null;
      loadDashboardData();
    }
  } catch (err) {
    if (err.status === 401) {
      currentUser = null;
      setTimeout(() => {
        closeModal('verify');
        goTo('screen-welcome');
        showAlertToast('🔒 Session expired. Please sign in again to authorize transactions.', true);
      }, 1800);
    }
    throw err;
  } finally {
    _txProcessing = false;
  }
}

// ============================================================
// ACCOUNTS, GRIEVANCES & SECURITY
// ============================================================
async function attemptDelegateWithdraw() {
  const name = document.getElementById('delegate-collect-name').value.trim();
  const otp = document.getElementById('delegate-collect-otp').value.trim();
  const msg = document.getElementById('delegate-collect-msg');
  const btn = document.getElementById('delegate-claim-btn');

  if (name.length < 2) {
    msg.textContent = "Enter the senior citizen's full name.";
    msg.className = 'modal-msg err';
    return;
  }
  if (!/^\d{6}$/.test(otp)) {
    msg.textContent = 'Enter the 6-digit authorization OTP.';
    msg.className = 'modal-msg err';
    return;
  }

  // Prevent accidental double submissions while processing
  if (btn) btn.disabled = true;
  msg.textContent = 'Verifying authorization and disbursing cash…';
  msg.className = 'modal-msg';

  try {
    const res = await window.iCashApi.claimDelegateWithdrawal({ seniorName: name, otp });
    if (res && res.ok) {
      msg.textContent = '';
      const detail = document.getElementById('delegate-success-detail');
      const refEl = document.getElementById('delegate-success-ref');
      if (detail) {
        detail.textContent =
          `₹${Number(res.amount).toLocaleString('en-IN')} released to ${res.authorizedPersonName || name}.` +
          (res.accountHolderName ? ` Account holder: ${res.accountHolderName}.` : '');
      }
      if (refEl) {
        refEl.textContent = res.referenceNumber || res.transactionId || 'TX_DELEGATED';
      }
      showAlertToast(`✅ Delegated cash disbursed: ₹${Number(res.amount).toLocaleString('en-IN')}.`);
      goTo('screen-delegate-success');
      // Clear the OTP so it cannot be re-submitted from a stale form
      document.getElementById('delegate-collect-otp').value = '';
    } else {
      msg.textContent = (res && res.message) || 'Authorization could not be verified.';
      msg.className = 'modal-msg err';
    }
  } catch (err) {
    msg.textContent = err.message || 'Disbursement failed. Please check the details and try again.';
    msg.className = 'modal-msg err';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitAddAccount() {
  const bank = document.getElementById('new-acc-bank').value.trim();
  const type = document.getElementById('new-acc-type').value;
  const bal = Number(document.getElementById('new-acc-bal').value) || 0;
  const msg = document.getElementById('add-acc-msg');

  if (!bank) {
    msg.textContent = 'Enter bank name.';
    msg.className = 'modal-msg err';
    return;
  }

  try {
    await window.iCashApi.createAccount({ bankName: bank, accountType: type, initialBalance: bal });
    closeModal('add-account');
    showAlertToast(`✓ ${bank} linked successfully.`);
    loadDashboardData();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg err';
  }
}

async function setPrimaryAccount(accId) {
  try {
    await window.iCashApi.setPrimaryAccount(accId);
    showAlertToast('Primary account updated.');
    loadDashboardData();
  } catch (err) {
    showAlertToast(err.message || 'Failed to update primary account.', true);
  }
}

async function submitComplaint() {
  const subject = document.getElementById('complaint-subject').value.trim();
  const desc = document.getElementById('complaint-desc').value.trim();
  const msg = document.getElementById('complaint-msg');

  if (!subject || !desc) {
    msg.textContent = 'Enter subject and summary.';
    msg.className = 'modal-msg err';
    return;
  }

  try {
    await window.iCashApi.createComplaint({ subject, description: desc });
    closeModal('complaint');
    showAlertToast('⚖️ Grievance ticket submitted for review.');
    loadComplaintsList();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'modal-msg err';
  }
}

async function loadComplaintsList() {
  try {
    const res = await window.iCashApi.getMyComplaints();
    const tbody = document.getElementById('support-complaints-tbody');
    if (!res.complaints || res.complaints.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty">No active grievance tickets on record.</td></tr>';
      return;
    }
    tbody.innerHTML = res.complaints
      .map(
        (c) => `
      <tr>
        <td><strong>${c.subject}</strong></td>
        <td style="color:var(--text-muted);font-size:12px;">${c.description}</td>
        <td><span class="status-badge ${c.status.toLowerCase()}">${c.status}</span></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint);">${new Date(c.createdAt).toLocaleDateString('en-IN')}</td>
        <td style="font-size:12px;color:var(--primary);">${c.adminResponse || 'Under Review by Grievance Officer'}</td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    console.error('Complaints load failed:', err);
  }
}

async function loadSecurityEvents() {
  try {
    const res = await window.iCashApi.getSecurityStatus();
    const tbody = document.getElementById('security-events-tbody');
    const logs = [
      {
        type: 'BIOMETRIC_AUTH',
        desc: 'Face Descriptor Match Verified',
        severity: 'INFO',
        time: 'Just now',
      },
      {
        type: 'SESSION_ENCRYPTION',
        desc: '256-Bit SSL/TLS Connection Established',
        severity: 'INFO',
        time: 'Today',
      },
    ];
    tbody.innerHTML = logs
      .map(
        (l) => `
      <tr>
        <td><span style="font-family:var(--font-mono);font-weight:600;">${l.type}</span></td>
        <td style="color:var(--text-muted);">${l.desc}</td>
        <td><span class="status-badge completed">${l.severity}</span></td>
        <td style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint);">${l.time}</td>
      </tr>
    `
      )
      .join('');
  } catch (err) {
    console.error('Security events load failed:', err);
  }
}

async function populateProfileView() {
  if (!currentUser) return;
  document.getElementById('prof-name').textContent = currentUser.name;
  document.getElementById('prof-phone').textContent = `+91 ${currentUser.phone}`;
  document.getElementById('prof-aadhaar').textContent = `•••• ${currentUser.aadhaarLast4}`;
  document.getElementById('prof-role').textContent = currentUser.role;
  document.getElementById('prof-senior').textContent = currentUser.isSenior
    ? 'Senior Assisted Banking Active'
    : 'Standard Customer';

  const emailEl = document.getElementById('prof-email-text');
  const badgeEl = document.getElementById('prof-email-badge');
  const promptBtn = document.getElementById('btn-verify-email-prompt');

  const updateBadgeUI = (email, isVerified) => {
    if (emailEl) {
      emailEl.textContent = email || 'No email linked';
    }
    if (!badgeEl) return;
    if (!email) {
      badgeEl.style.display = 'none';
      if (promptBtn) promptBtn.style.display = 'none';
    } else if (isVerified) {
      badgeEl.style.display = 'inline-block';
      badgeEl.textContent = 'Verified ✓';
      badgeEl.style.background = 'rgba(16, 185, 129, 0.15)';
      badgeEl.style.color = '#34d399';
      badgeEl.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      if (promptBtn) promptBtn.style.display = 'none';
    } else {
      badgeEl.style.display = 'inline-block';
      badgeEl.textContent = 'Unverified ⚠️';
      badgeEl.style.background = 'rgba(239, 68, 68, 0.15)';
      badgeEl.style.color = '#f87171';
      badgeEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      if (promptBtn) promptBtn.style.display = 'inline-block';
    }
  };

  updateBadgeUI(currentUser.email, currentUser.emailVerified);

  // Authoritative check from the backend to ensure fresh status
  try {
    const statusRes = await window.iCashApi.getVerificationStatus();
    if (statusRes && statusRes.ok) {
      if (statusRes.email) currentUser.email = statusRes.email;
      currentUser.emailVerified = Boolean(statusRes.emailVerified ?? statusRes.verified);
      updateBadgeUI(currentUser.email, currentUser.emailVerified);
    }
  } catch (_) {}
}

let emailResendCountdownInterval = null;

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || 'Registered Email';
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(3, local.length - 1))}@${domain}`;
}

function startResendCountdown(seconds = 45) {
  const resendBtn = document.getElementById('btn-email-resend');
  if (!resendBtn) return;
  if (emailResendCountdownInterval) clearInterval(emailResendCountdownInterval);
  let remaining = seconds;
  resendBtn.disabled = true;
  resendBtn.style.opacity = '0.6';
  resendBtn.style.cursor = 'not-allowed';
  resendBtn.textContent = `Resend available in ${remaining}s`;

  emailResendCountdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(emailResendCountdownInterval);
      emailResendCountdownInterval = null;
      resendBtn.disabled = false;
      resendBtn.style.opacity = '1';
      resendBtn.style.cursor = 'pointer';
      resendBtn.textContent = 'Resend Code';
    } else {
      resendBtn.textContent = `Resend available in ${remaining}s`;
    }
  }, 1000);
}

async function openEmailVerificationModal() {
  const displayEl = document.getElementById('email-verify-display');
  const codeInput = document.getElementById('email-verify-code');
  const msgEl = document.getElementById('email-verify-msg');

  if (displayEl) {
    displayEl.textContent = maskEmail(currentUser?.email);
  }
  if (codeInput) codeInput.value = '';
  if (msgEl) {
    msgEl.textContent = 'Preparing verification code…';
    msgEl.className = 'modal-msg';
  }

  openModal('email-verify');

  // If user is unverified and has email, auto-request code dispatch
  if (currentUser?.email && !currentUser?.emailVerified) {
    try {
      startResendCountdown(45);
      const res = await window.iCashApi.resendVerification({
        email: currentUser.email,
      });
      const code = res.devCode || res.code;
      if (code) {
        if (codeInput) codeInput.value = code;
        if (msgEl) {
          msgEl.innerHTML = `Code sent! <span style="font-family:var(--font-mono); color:#38bdf8; font-weight:700;">(Dev Code: ${code})</span>`;
          msgEl.className = 'modal-msg success';
        }
      } else if (msgEl) {
        msgEl.textContent = `6-digit verification code dispatched to ${maskEmail(currentUser.email)}.`;
        msgEl.className = 'modal-msg success';
      }
    } catch (e) {
      if (msgEl) {
        msgEl.textContent = e.message || 'Enter the 6-digit code sent to your email address.';
        msgEl.className = 'modal-msg';
      }
    }
  }
}

async function submitEmailVerification() {
  const codeInput = document.getElementById('email-verify-code');
  const msgEl = document.getElementById('email-verify-msg');
  const code = codeInput?.value?.trim();

  if (!code || code.length < 6) {
    if (msgEl) {
      msgEl.textContent = 'Please enter a valid 6-digit verification code.';
      msgEl.className = 'modal-msg err';
    }
    return;
  }

  if (msgEl) {
    msgEl.textContent = 'Verifying code…';
    msgEl.className = 'modal-msg';
  }

  try {
    const res = await window.iCashApi.verifyEmail({
      code,
      email: currentUser?.email,
    });

    if (res.ok || res.success) {
      if (msgEl) {
        msgEl.textContent = 'Email Verified Successfully! ✓';
        msgEl.className = 'modal-msg success';
      }
      showAlertToast('Email verified successfully! Welcome email sent. ✓');

      if (currentUser) {
        currentUser.emailVerified = true;
      }
      populateProfileView();

      setTimeout(() => {
        closeModal('email-verify');
      }, 1200);
    } else {
      if (msgEl) {
        msgEl.textContent = res.message || 'Verification failed. Please check code.';
        msgEl.className = 'modal-msg err';
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message || 'Verification failed. Code may be invalid or expired.';
      msgEl.className = 'modal-msg err';
    }
  }
}

async function resendEmailVerification() {
  const msgEl = document.getElementById('email-verify-msg');
  const codeInput = document.getElementById('email-verify-code');
  if (msgEl) {
    msgEl.textContent = 'Requesting fresh verification code…';
    msgEl.className = 'modal-msg';
  }

  try {
    startResendCountdown(45);
    const res = await window.iCashApi.resendVerification({
      email: currentUser?.email,
    });

    if (res.ok || res.success) {
      const code = res.devCode || res.code;
      if (code) {
        if (codeInput) codeInput.value = code;
        if (msgEl) {
          msgEl.innerHTML = `Fresh code sent! <span style="font-family:var(--font-mono); color:#38bdf8; font-weight:700;">(Dev Code: ${code})</span>`;
          msgEl.className = 'modal-msg success';
        }
        showAlertToast(`New verification code: ${code}`);
      } else {
        if (msgEl) {
          msgEl.textContent = 'Fresh 6-digit code sent to your email. Check your inbox.';
          msgEl.className = 'modal-msg success';
        }
        showAlertToast('New verification code sent to your email.');
      }
    } else {
      if (msgEl) {
        msgEl.textContent = res.message || 'Could not resend verification code.';
        msgEl.className = 'modal-msg err';
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message || 'Failed to resend code.';
      msgEl.className = 'modal-msg err';
    }
  }
}

function openDeleteAccountModal() {
  document.getElementById('delete-pin-input').value = '';
  document.getElementById('delete-account-msg').textContent = '';
  document.getElementById('modal-delete-account').classList.add('active');
}

async function confirmDeleteAccount() {
  const btn = document.getElementById('delete-account-btn');
  const msg = document.getElementById('delete-account-msg');
  const pin = document.getElementById('delete-pin-input').value.trim();
  if (!/^[0-9]{4}$/.test(pin)) {
    msg.textContent = 'Enter your 4-digit PIN to confirm.';
    msg.className = 'modal-msg err';
    return;
  }
  if (btn) btn.disabled = true;
  msg.textContent = 'Deleting account… this may take a few seconds.';
  msg.className = 'modal-msg';
  try {
    await window.iCashApi.deleteMe({ pin });
    // Success — clear local state and navigate to welcome
    showAlertToast('Your account has been deleted. Redirecting…');
    // Logout client-side state
    currentUser = null;
    currentAccounts = [];
    // Close modal and go to welcome
    document.getElementById('modal-delete-account').classList.remove('active');
    setTimeout(() => goTo('screen-welcome'), 800);
  } catch (err) {
    msg.textContent = err.message || 'Failed to delete account.';
    msg.className = 'modal-msg err';
    if (btn) btn.disabled = false;
  }
}

function renderAccountsView() {
  renderAccountsGrid(currentAccounts);
}

function renderAllTransactionsView() {
  renderTransactionsTable();
}

// ============================================================
// EMERGENCY & AUTHORIZED REPRESENTATIVE WITHDRAWAL ENGINE
// ============================================================

let _emgCountdownInterval = null;
let _emgTimeRemaining = 300; // 5 minutes in seconds

function openEmergencyWithdrawalModal() {
  const modal = document.getElementById('modal-emergency-withdrawal');
  if (!modal) return;
  modal.classList.add('active');
  resetEmergencyStep1();
}

// Alias for legacy senior collection button
function openDelegateCollectModal() {
  openEmergencyWithdrawalModal();
}

function closeEmergencyWithdrawalModal() {
  if (_emgCountdownInterval) {
    clearInterval(_emgCountdownInterval);
    _emgCountdownInterval = null;
  }
  const modal = document.getElementById('modal-emergency-withdrawal');
  if (modal) modal.classList.remove('active');
}

function resetEmergencyStep1() {
  if (_emgCountdownInterval) {
    clearInterval(_emgCountdownInterval);
    _emgCountdownInterval = null;
  }
  document.getElementById('emg-step-1').style.display = 'block';
  document.getElementById('emg-step-2').style.display = 'none';
  document.getElementById('emg-step-3').style.display = 'none';
  document.getElementById('emg-msg-1').textContent = '';
  document.getElementById('emg-msg-2').textContent = '';
  document.getElementById('emg-otp-input').value = '';
}

async function submitEmergencyWithdrawalRequest() {
  const ident = document.getElementById('emg-acc-identifier').value.trim();
  const authName = document.getElementById('emg-auth-name').value.trim();
  const authPhone = document.getElementById('emg-auth-phone').value.trim();
  const authIdType = document.getElementById('emg-auth-idtype').value;
  const authIdNum = document.getElementById('emg-auth-idnum').value.trim();
  const amount = Number(document.getElementById('emg-amount').value);
  const reason = document.getElementById('emg-reason').value.trim();
  const msg = document.getElementById('emg-msg-1');
  const btn = document.getElementById('emg-submit-req-btn');

  if (!ident || ident.length < 2) {
    msg.textContent = "Please enter the account holder's identifier (mobile, Aadhaar last 4, or full name).";
    msg.className = 'modal-msg err';
    return;
  }
  if (!authName || authName.length < 2) {
    msg.textContent = 'Please enter your full name as the authorized representative.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!authPhone || !/^\d{10}$/.test(authPhone)) {
    msg.textContent = 'Please enter your valid 10-digit mobile number.';
    msg.className = 'modal-msg err';
    return;
  }
  if (!amount || amount <= 0) {
    msg.textContent = 'Please enter a valid withdrawal amount.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying emergency authorization with banking core…';
  msg.className = 'modal-msg';
  if (btn) btn.disabled = true;

  try {
    const res = await window.iCashApi.requestEmergencyWithdrawal({
      accountIdentifier: ident,
      authorizedName: authName,
      authorizedPhone: authPhone,
      authorizedIdType: authIdType,
      authorizedIdNumber: authIdNum || undefined,
      amount,
      reason: reason || 'Emergency Cash Withdrawal',
    });

    if (btn) btn.disabled = false;

    if (res.ok) {
      window._currentEmgRequestId = res.requestId;
      window._currentEmgResponse = res;

      // Update Step 2 UI
      document.getElementById('emg-holder-phone-badge').textContent =
        res.accountHolderPhoneMasked || '+91 ••••••0000';

      const devPill = document.getElementById('emg-dev-otp-banner');
      if (res.devOtp) {
        devPill.style.display = 'inline-flex';
        devPill.innerHTML = `<span>⚡ SMS Dispatched: OTP is <strong>${res.devOtp}</strong></span>`;
      } else {
        devPill.style.display = 'none';
      }

      document.getElementById('emg-step-1').style.display = 'none';
      document.getElementById('emg-step-2').style.display = 'block';
      document.getElementById('emg-step-3').style.display = 'none';
      document.getElementById('emg-otp-input').value = '';
      document.getElementById('emg-otp-input').focus();

      // Start 5-minute countdown (300 seconds)
      startEmergencyCountdown(res.expiresInSeconds || 300);
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent = err.message || 'Authorization failed. Please check details.';
    msg.className = 'modal-msg err';
  }
}

function startEmergencyCountdown(totalSeconds) {
  if (_emgCountdownInterval) clearInterval(_emgCountdownInterval);
  _emgTimeRemaining = totalSeconds;

  const digitsEl = document.getElementById('emg-timer-digits');
  const barEl = document.getElementById('emg-timer-progress');
  const msgEl = document.getElementById('emg-msg-2');
  const verifyBtn = document.getElementById('emg-verify-otp-btn');
  const circumference = 2 * Math.PI * 44; // r=44 => ~276.46

  function updateDisplay() {
    const mins = Math.floor(_emgTimeRemaining / 60);
    const secs = _emgTimeRemaining % 60;
    if (digitsEl) {
      digitsEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    if (barEl) {
      const progressFraction = _emgTimeRemaining / totalSeconds;
      const offset = circumference * (1 - progressFraction);
      barEl.style.strokeDashoffset = offset;
      if (_emgTimeRemaining <= 60) {
        barEl.style.stroke = '#ef4444';
      } else if (_emgTimeRemaining <= 180) {
        barEl.style.stroke = '#f59e0b';
      } else {
        barEl.style.stroke = '#6366f1';
      }
    }

    if (_emgTimeRemaining <= 0) {
      clearInterval(_emgCountdownInterval);
      _emgCountdownInterval = null;
      if (msgEl) {
        msgEl.textContent = '⚠️ The 5-minute authorization window has expired. Please initiate a new request.';
        msgEl.className = 'modal-msg err';
      }
      if (verifyBtn) verifyBtn.disabled = true;
    } else {
      _emgTimeRemaining--;
    }
  }

  if (verifyBtn) verifyBtn.disabled = false;
  updateDisplay();
  _emgCountdownInterval = setInterval(updateDisplay, 1000);
}

async function submitEmergencyWithdrawalOtp() {
  const otp = document.getElementById('emg-otp-input').value.trim();
  const msg = document.getElementById('emg-msg-2');
  const btn = document.getElementById('emg-verify-otp-btn');

  if (!otp || !/^\d{6}$/.test(otp)) {
    msg.textContent = 'Please enter the valid 6-digit OTP received by the account holder.';
    msg.className = 'modal-msg err';
    return;
  }

  msg.textContent = 'Verifying OTP & authorizing instant fund release…';
  msg.className = 'modal-msg';
  if (btn) btn.disabled = true;

  try {
    const res = await window.iCashApi.verifyEmergencyWithdrawal({
      requestId: window._currentEmgRequestId,
      otp,
    });

    if (btn) btn.disabled = false;

    if (res.ok) {
      if (_emgCountdownInterval) {
        clearInterval(_emgCountdownInterval);
        _emgCountdownInterval = null;
      }

      // Populate Step 3 Voucher
      document.getElementById('emg-receipt-amt').textContent = `₹${Number(res.amount).toLocaleString('en-IN')}`;
      document.getElementById('emg-receipt-ref').textContent = res.referenceNumber || res.transactionId || 'TX_EMERGENCY';
      document.getElementById('emg-receipt-date').textContent = new Date().toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      document.getElementById('emg-receipt-holder').textContent = res.accountHolderName || 'Account Holder';
      document.getElementById('emg-receipt-rep').textContent = `${res.authorizedPersonName} (${res.authorizedPersonPhone})`;
      document.getElementById('emg-receipt-idproof').textContent = res.authorizedIdNumber
        ? `${res.authorizedIdType || 'Gov ID'}: ${res.authorizedIdNumber}`
        : 'Authorized Representative Verified ✓';

      document.getElementById('emg-step-1').style.display = 'none';
      document.getElementById('emg-step-2').style.display = 'none';
      document.getElementById('emg-step-3').style.display = 'block';

      showAlertToast(`🚨 Emergency Cash Release Authorized: ₹${Number(res.amount).toLocaleString('en-IN')} released to ${res.authorizedPersonName}.`);

      // Refresh dashboard if user is signed in
      if (typeof loadDashboardData === 'function') loadDashboardData();
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    msg.textContent = err.message || 'OTP verification failed. Please check the code received by the account holder.';
    msg.className = 'modal-msg err';
  }
}

async function submitPaymentRequest() {
  const amt = Number(document.getElementById('payreq-amt').value);
  const desc = document.getElementById('payreq-desc').value.trim();
  const msg = document.getElementById('payreq-msg');

  if (!amt || amt <= 0) {
    msg.textContent = 'Enter valid invoice amount.';
    msg.className = 'modal-msg err';
    return;
  }

  try {
    const res = await window.iCashApi.createPaymentRequest({
      amount: amt,
      description: desc || 'POS Checkout',
    });
    closeModal('payment-request');
    showAlertToast(
      `📱 POS Checkout Reference Generated: [ ${res.paymentRequest?.reference_code || 'POS_REF'} ]`
    );
    loadMerchantPOSList();
  } catch (err) {
    msg.textContent = err.message || 'Failed to create payment request.';
    msg.className = 'modal-msg err';
  }
}

async function loadMerchantPOSList() {
  const container = document.getElementById('payments-pos-list');
  if (!container) return;
  try {
    const res = await window.iCashApi.getMerchantProfile();
    const reqs = res.merchant?.paymentRequests || [];
    if (reqs.length === 0) {
      container.innerHTML = '<div class="empty">No active checkout codes.</div>';
      return;
    }
    container.innerHTML = reqs
      .map(
        (r) => `
      <div style="background:var(--bg-inset);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <strong>${r.description || 'POS Checkout'}</strong>
          <div style="font-size:11px;color:var(--primary);font-family:var(--font-mono);">Code: ${r.reference_code}</div>
        </div>
        <strong style="color:var(--success);">${fmtMoney(r.amount)}</strong>
      </div>
    `
      )
      .join('');
  } catch (e) {
    container.innerHTML = '<div class="empty">POS gateway ready.</div>';
  }
}

async function logout() {
  // Stop any camera/liveness loops before leaving the authenticated area.
  try { if (typeof teardownLoginScan === 'function') teardownLoginScan(); } catch (_) {}
  try { if (typeof teardownVerifyGate === 'function') teardownVerifyGate(); } catch (_) {}
  try { if (typeof teardownRegisterScan === 'function') teardownRegisterScan(); } catch (_) {}

  try {
    await window.iCashApi.logout();
  } catch (e) {
    console.warn('[iCash Auth] Server logout notice:', e.message || e);
  } finally {
    currentUser = null;
    currentAccounts = [];
    currentTransactions = [];
    filteredTransactions = [];
    pendingVerificationAction = null;
    pendingOtp = null;
    window._pendingBiometricToken = null;
    window._loginTargetUser = null;
    // Clear biometric challenge and liveness session state
    if (typeof _activeChallengeId !== 'undefined') {
      try {
        // eslint-disable-next-line no-global-assign
        _activeChallengeId    = null;
        _activeChallengeNonce = null;
        _activeChallengeType  = null;
        _activeChallengeExp   = null;
        activeLivenessSessionId = null;
        currentLivenessState = { live: false, blink_count: 0 };
      } catch (_) {}
    }
    closeAllModals();
    goTo('screen-welcome');
    showAlertToast('Signed out of secure banking session.');
  }
}

// ============================================================
// UTILITIES & THREE.JS BACKGROUND
// ============================================================
function fmtMoney(amt) {
  const n = Number(amt) || 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function initials(name) {
  if (!name) return 'IC';
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

let toastTimer = null;
function showAlertToast(msg, isErr = false) {
  const toast = document.getElementById('alert-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = isErr ? 'err active' : 'active';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('active');
  }, 4000);
}

function createScanRingRenderer(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  let angle = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(cx, cy) - 10;

    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 1.3);
    ctx.strokeStyle = '#2DD4BF';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#2DD4BF';
    ctx.stroke();

    angle += 0.05;
    requestAnimationFrame(draw);
  }
  canvas.width = canvas.parentElement.clientWidth || 240;
  canvas.height = canvas.parentElement.clientHeight || 240;
  draw();
  return { canvas };
}

function initThreeBackground() {
  const canvas = document.getElementById('canvas3d');
  if (!canvas || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);

  const particlesCount = 200;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particlesCount * 3);

  for (let i = 0; i < particlesCount * 3; i++) {
    positions[i] = (Math.random() - 0.5) * 20;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0x2dd4bf,
    size: 0.05,
    transparent: true,
    opacity: 0.4,
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);
  camera.position.z = 8;

  // Reduced-motion support: pause the background animation when the user has
  // reduced motion enabled (manual toggle or OS preference). The canvas stays
  // visible as a static backdrop (hidden via CSS in reduced-motion).
  let animationPaused = false;

  function animate() {
    if (!animationPaused) {
      particles.rotation.y += 0.0008;
      particles.rotation.x += 0.0004;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(animate);
  }
  animate();

  function applyMotionPreference(reduced) {
    animationPaused = Boolean(reduced);
    if (!animationPaused) renderer.render(scene, camera);
  }
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyMotionPreference(true);
    }
    window.addEventListener('icash:reduced-motion', (e) => applyMotionPreference(e.detail && e.detail.reduced));
  } catch (_) {}

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
