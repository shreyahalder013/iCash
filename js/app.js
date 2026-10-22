/* =========================================================
   ICASH — Core Application Module
   State management, router, helpers, navbar, modal, toast
   ========================================================= */

// ============================================================
// API BASE URL RESOLUTION
// ============================================================
const API = (function() {
  if (typeof window !== 'undefined') {
    const custom = localStorage.getItem('icash_api_url');
    if (custom) {return custom;}

    // If opened directly from file://, fallback to default dev port
    if (window.location.protocol === 'file:') {
      return 'http://localhost:4000/api';
    }

    // When served by Express (same origin), use relative path
    // This works for any port Express runs on (3000, 4000, etc.)
    return '/api';
  }
  return '/api';
})();

// ============================================================
// DEFAULT TRANSACTIONS (for seeding/demo)
// ============================================================
const DEFAULT_TX = [
  {id:'TXN-9F21A', date:'2026-09-20', desc:'Salary Credit', type:'in', amount:5000, status:'Completed'},
  {id:'TXN-8C10B', date:'2026-09-19', desc:'Grocery Store', type:'out', cat:'Food', amount:1200, status:'Completed'},
  {id:'TXN-7A02D', date:'2026-09-18', desc:'ATM Withdrawal', type:'out', cat:'Cash', amount:2000, status:'Completed'},
  {id:'TXN-6E88F', date:'2026-09-16', desc:'Electricity Bill', type:'out', cat:'Bills', amount:500, status:'Completed'},
  {id:'TXN-5D77C', date:'2026-09-14', desc:'Cab Ride', type:'out', cat:'Transport', amount:750, status:'Completed'},
];

// ============================================================
// MONETARY UTILITIES (Integer Paise)
// ============================================================
function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

function paiseToRupees(paise) {
  return Number(paise) / 100;
}

function fmtINR(paise) {
  // Strict: accepts only integer paise (₹1 = 100 paise)
  const rupees = Number(paise) / 100;
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================
// PHONE NORMALIZATION
// ============================================================
/**
 * Normalize phone number to E.164-like format (+919876543210).
 * - Strips spaces, dashes, parentheses, dots
 * - Defaults to +91 (India) if no country code provided
 */
function normalizePhone(phone) {
  if (!phone) {return '';}
  let cleaned = phone.trim().replace(/[^\d+]/g, '');
  if (cleaned.startsWith('0')) {cleaned = cleaned.slice(1);}
  if (cleaned.startsWith('91') && !cleaned.startsWith('+91')) {cleaned = '+' + cleaned;}
  if (!cleaned.startsWith('+')) {cleaned = '+91' + cleaned;}
  return cleaned;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================
const State = {
  user: null,
  tx: [],
  balance: 48750,      // rupees (for display)
  balancePaise: 4875000, // paise (for calculations)
  session: null,
  events: [],

  async load() {
    try {
      const res = await fetch(API + '/user', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        this.user = data.user;
        this.tx = data.transactions || [];
        this.balancePaise = data.balancePaise ?? rupeesToPaise(data.balance ?? 48750);
        this.balance = paiseToRupees(this.balancePaise);
        this.session = data.session;
        this.events = data.events || [];
      } else {
        // No session — load defaults for landing page
        this.user = null;
        this.session = null;
        this._loadLocal();
      }
    } catch (_e) {
      console.warn('API unavailable, using localStorage fallback:', _e.message);
      this._loadLocal();
    }
  },

  _loadLocal() {
    this.user = JSON.parse(localStorage.getItem('icash_user') || 'null');
    this.tx = JSON.parse(localStorage.getItem('icash_tx') || 'null') || DEFAULT_TX.slice();
    this.balancePaise = parseInt(localStorage.getItem('icash_balance_paise') || '4875000', 10);
    this.balance = paiseToRupees(this.balancePaise);
    this.events = JSON.parse(localStorage.getItem('icash_events') || '[]');
    // SECURITY FIX: Never restore session.active=true from localStorage.
    // Session validity must ALWAYS be verified server-side via /api/user.
    this.session = null;
    // Do NOT create a fake demo user. Leave user as null if not registered.
    // The landing page will show a generic welcome, and login will require a real registered phone number.
  },

  calcAge(dob) {
    const d = new Date(dob); const t = new Date();
    let age = t.getFullYear() - d.getFullYear();
    const m = t.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < d.getDate())) {age--;}
    return age;
  },

  async save() {
    // Save to API
    try {
      await fetch(API + '/user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          user: this.user,
          transactions: this.tx,
          balance: this.balance,
          session: this.session,
          events: this.events
        })
      });
    } catch (_e) {
      // Fallback to localStorage
    }
    this._saveLocal();
  },

  _saveLocal() {
    localStorage.setItem('icash_user', JSON.stringify(this.user));
    localStorage.setItem('icash_tx', JSON.stringify(this.tx));
    localStorage.setItem('icash_balance_paise', String(this.balancePaise));
    localStorage.setItem('icash_session', JSON.stringify(this.session));
    localStorage.setItem('icash_events', JSON.stringify(this.events));
  },

  async logEvent(type, desc) {
    this.events.unshift({
      type, desc,
      time: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    });
    this.events = this.events.slice(0, 12);

    // Log to API
    try {
      await fetch(API + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type, desc })
      });
    } catch (_e) { /* fallback already saved locally */ }

    this._saveLocal();
  }
};

// Initial load (synchronous fallback for immediate render)
State._loadLocal();

// ============================================================
// ROUTER
// ============================================================
const routes = {};
function route(name, fn) { routes[name] = fn; }
function nav(name) { 
  console.log('[nav] Navigating to:', name);
  location.hash = '#' + name; 
}
function currentRoute() { return (location.hash || '#landing').slice(1).split('?')[0]; }
window.addEventListener('hashchange', render);

// Ensure nav is immediately available on window for onclick handlers
window.nav = nav;

// Global logout function for onclick handlers
async function logout() {
  try {
    await fetch(API + '/logout', { method: 'POST', credentials: 'include' });
  } catch (_e) {
    console.warn('[Logout] Server logout request failed:', _e.message);
  }
  State.session = null;
  State.user = null;
  localStorage.removeItem('icash_session');
  // Clear selected login user to prevent session leakage
  if (typeof window.selectedLoginUser !== 'undefined') {window.selectedLoginUser = null;}
  toast('Logged out securely');
  nav('landing');
}

// SECURITY FIX: requireAuth() must NOT trust localStorage for session validity.
// We check State.session which is only populated by a successful server response.
function requireAuth() {
  if (!State.session || !State.session.active) { nav('login'); return false; }
  return true;
}

function render() {
  const r = currentRoute();
  const fn = routes[r] || routes['landing'];
  if (!routes[r]) {
    console.warn('[render] Route not found:', r, 'Available routes:', Object.keys(routes));
  }
  document.getElementById('app').innerHTML = '';
  document.body.setAttribute('data-senior', State.user && State.user.seniorMode ? '1' : '0');
  fn();
  window.scrollTo(0, 0);
}

// ============================================================
// HELPERS
// ============================================================
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function mount(node) { document.getElementById('app').appendChild(node); }
function val(id) { return (document.getElementById(id)?.value || '').trim(); }
function genTxId() { return 'TXN-' + Math.random().toString(16).slice(2, 7).toUpperCase(); }
function maskAadhaar(a) { return a ? 'XXXX XXXX ' + a.slice(-4) : ''; }

/**
 * Escape HTML special characters to prevent XSS.
 * Apply to ALL user-controlled strings before inserting into innerHTML.
 */
function esc(str) {
  if (str === null || str === undefined) {return '';}
  return String(str)
    .replaceAll('&', '&')
    .replaceAll('<', '<')
    .replaceAll('>', '>')
    .replaceAll('"', '"')
    .replaceAll("'", "'");
}

function iconSvg(name) {
  const icons = {
    withdraw: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    send: '<path d="M4 12l16-8-6 16-3-6-7-2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
    receive: '<path d="M12 21V9m0 12l-4-4m4 4l4-4M5 5h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    contact: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 5-6 8-6s6.5 2 8 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    shield: '<path d="M12 3l7 3v6c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6l7-3z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
    face: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M9 15c1 1 5 1 6 0" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
    check: '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    alert: '<path d="M12 3l10 18H2L12 3zm0 7v4m0 3h.01" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20">${icons[name] || ''}</svg>`;
}

function toast(msg, kind = 'ok') {
  const colors = { ok: 'rgba(56,230,168,0.12)', warn: 'rgba(242,184,75,0.14)', danger: 'rgba(255,92,122,0.14)' };
  const borders = { ok: 'rgba(56,230,168,0.4)', warn: 'rgba(242,184,75,0.4)', danger: 'rgba(255,92,122,0.4)' };
  const t = el(`<div class="toast glass" style="background:${colors[kind]}; border-color:${borders[kind]}" role="alert" aria-live="polite">${esc(msg)}</div>`);
  document.getElementById('toastWrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}

// ============================================================
// NAV BAR
// ============================================================
function navbar() {
  const loggedIn = State.session && State.session.active;
  const active = currentRoute();
  const links = loggedIn
    ? [['dashboard', 'Dashboard'], ['withdraw', 'Withdraw'], ['send', 'Send Money'], ['history', 'Transactions'], ['analytics', 'Analytics'], ['security', 'Security'], ['profile', 'Profile']]
    : [['landing', 'Home'], ['landing-features', 'Features'], ['landing-security', 'Security'], ['login', 'Login'], ['register', 'Register']];
  const linkHtml = links.map(([r, label]) => {
    if (r.startsWith('landing-')) {return `<a href="#landing" onclick="setTimeout(()=>document.getElementById('${r.split('-')[1]}')?.scrollIntoView({behavior:'smooth'}),50)">${label}</a>`;}
    return `<a href="#${r}" class="${active === r ? 'active' : ''}">${label}</a>`;
  }).join('');
  const bar = el(`
  <div class="topnav" role="navigation" aria-label="Main navigation">
    <div class="wrap row">
      <a href="#${loggedIn ? 'dashboard' : 'landing'}" class="brand" aria-label="iCash Home"><span class="mark" aria-hidden="true"></span>iCash</a>
      <div class="navlinks">${linkHtml}</div>
      <div class="navcta">
        ${loggedIn
          ? `<button class="btn btn-ghost btn-sm" id="atmBtn" aria-label="ATM Locator" onclick="nav('atm')">ATM</button><button class="btn btn-outline btn-sm" id="logoutBtn" aria-label="Log out of your account" onclick="logout()">Logout</button>`
          : `<button class="btn btn-ghost btn-sm" id="navLoginBtn" aria-label="Log in to your iCash account" onclick="nav('login')">Login</button><button class="btn btn-primary btn-sm" id="navRegisterBtn" aria-label="Create a new iCash account" onclick="nav('register')">Get Started</button>`}
      </div>
      <button class="hamb" id="hambBtn" aria-label="Menu" aria-expanded="false">☰</button>
    </div>
  </div>`);
  mount(bar);
  if (loggedIn) {
    bar.querySelector('#logoutBtn').onclick = logout;
    bar.querySelector('#atmBtn').onclick = () => nav('atm');
  } else {
    const loginBtn = bar.querySelector('#navLoginBtn');
    const registerBtn = bar.querySelector('#navRegisterBtn');
    if (loginBtn) {loginBtn.addEventListener('click', () => nav('login'));}
    if (registerBtn) {registerBtn.addEventListener('click', () => nav('register'));}
    // Fallback: also add onclick attributes for robustness
    if (loginBtn) {loginBtn.onclick = () => nav('login');}
    if (registerBtn) {registerBtn.onclick = () => nav('register');}
  }
  const hambBtn = bar.querySelector('#hambBtn');
  hambBtn.onclick = () => {
    const isExpanded = hambBtn.getAttribute('aria-expanded') === 'true';
    hambBtn.setAttribute('aria-expanded', !isExpanded);
    if (!isExpanded) {
      // Build menu with keyboard-navigable links that close modal on click
      const existing = links.map(([r, label]) => {
        const routeName = r.startsWith('landing-') ? 'landing' : r;
        return `<button class="modal-nav-btn" tabindex="0" onclick="nav('${routeName}'); closeModal();" style="display:block;width:100%;text-align:left;padding:12px 0;border:none;background:none;color:inherit;font:inherit;border-bottom:1px solid var(--border)">${label}</button>`;
      }).join('');
      openModal(`<div class="auth-head"><h2>Menu</h2></div>${existing}`);
    } else {
      closeModal();
    }
  };
  
  // Close hamburger menu on Escape key (modal handles closeModal, we just reset state)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hambBtn.getAttribute('aria-expanded') === 'true') {
      hambBtn.setAttribute('aria-expanded', 'false');
      hambBtn.focus();
    }
  });
}

// ============================================================
// MODAL
// ============================================================
let lastFocusedElement = null;

function openModal(innerHtml) {
  closeModal();
  lastFocusedElement = document.activeElement;
  const bg = el(`<div class="modal-bg" id="modalBg" role="dialog" aria-modal="true"><div class="glass modal">${innerHtml}</div></div>`);
  bg.addEventListener('click', e => { if (e.target.id === 'modalBg') {closeModal();} });
  document.getElementById('app').appendChild(bg);
  
  // Focus trap
  const focusableElements = bg.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])');
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];
  
  bg.addEventListener('keydown', trapFocus);
  
  function trapFocus(e) {
    if (e.key === 'Escape') {
      closeModal();
      return;
    }
    if (e.key !== 'Tab') {return;}
    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable?.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable?.focus();
      }
    }
  }
  
  // Focus first focusable element
  setTimeout(() => {
    firstFocusable?.focus();
  }, 50);
}
function closeModal() { 
  const bg = document.getElementById('modalBg');
  if (bg) {
    bg.removeEventListener('keydown', trapFocus);
  }
  document.getElementById('modalBg')?.remove();
  // Restore focus to trigger element
  lastFocusedElement?.focus();
  lastFocusedElement = null;
}

// ============================================================
// TRANSACTION TABLE HELPER (Shared)
// ============================================================
function txTable(rows) {
  const catIcon = { Food: '🍔', Cash: '🏧', Bills: '💡', Transport: '🚗', Healthcare: '🩺', Shopping: '🛍️', Other: '💳', Transfer: '↔️' };
  const table = el(`<table class="tx" role="table"><thead><tr><th>Description</th><th>Date</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead><tbody></tbody></table>`);
  const tb = table.querySelector('tbody');
  rows.forEach(t => {
    const amtClass = t.type === 'in' ? 'amt-in' : t.type === 'mid' ? 'amt-mid' : 'amt-out';
    const sign = t.type === 'in' ? '+' : t.type === 'mid' ? '' : '−';
    const amountPaise = t.amountPaise ?? rupeesToPaise(t.amount);
    const desc = esc(t.desc ?? '');
    const id = esc(t.id ?? '');
    const date = esc(t.date ?? '');
    const status = esc(t.status ?? '');
    tb.appendChild(el(`<tr>
      <td><div class="tx-desc"><div class="tx-ic">${catIcon[t.cat] || (t.type === 'in' ? '⬇️' : '⬆️')}</div><div><div>${desc}</div><div style="color:var(--muted2); font-size:11.5px;">${id}</div></div></div></td>
      <td style="color:var(--muted)">${date}</td>
      <td style="color:var(--muted)">${t.type === 'in' ? 'Received' : t.type === 'mid' ? 'Transfer' : 'Spent'}</td>
      <td class="${amtClass}">${sign}${fmtINR(amountPaise)}</td>
      <td><span class="pill ok">${status}</span></td>
    </tr>`));
  });
  return table;
}

// ============================================================
// BOOT: Load state from server, then render
// ============================================================
function showLoading() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="loading-screen" role="status" aria-label="Loading iCash">
      <div class="loading-spinner"></div>
      <p>Loading iCash…</p>
    </div>
  `;
}

function hideLoading() {
  const loading = document.querySelector('.loading-screen');
  if (loading) {loading.remove();}
}

// Expose globals for other modules (browser global scope)
window.normalizePhone = normalizePhone;
window.route = route;
window.requireAuth = requireAuth;
window.el = el;
window.mount = mount;
window.val = val;
window.genTxId = genTxId;
window.maskAadhaar = maskAadhaar;
window.iconSvg = iconSvg;
window.toast = toast;
window.navbar = navbar;
window.openModal = openModal;
window.closeModal = closeModal;
window.txTable = txTable;
window.State = State;
window.API = API;
window.rupeesToPaise = rupeesToPaise;
window.paiseToRupees = paiseToRupees;
window.fmtINR = fmtINR;
window.logout = logout;
window.nav = nav;
window.currentRoute = currentRoute;

(async function boot() {
  showLoading();
  try {
    await State.load();
  } finally {
    hideLoading();
  }
  if (!location.hash) {location.hash = '#landing';}
  render();
})();