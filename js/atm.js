/* =========================================================
   ICASH — ATM Simulation (SECURE)

   Uses the same full cryptographic challenge-response pipeline as the
   main login page. No face authentication without server-verified challenge.
   ========================================================= */
route('atm', function() {
  if (!requireAuth()) {return;}
  navbar();
  const shell = el(`<div class="auth-shell"><div class="glass auth-card" id="atmBox" style="background:linear-gradient(160deg,#0d1b26,#080b11); border-color:var(--border-hi);"></div></div>`);
  mount(shell);
  renderAtmWelcome();
});

function renderAtmWelcome() {
  const box = document.getElementById('atmBox');
  box.innerHTML = `
    <div class="auth-head"><div class="eyebrow" style="justify-content:center;">iCASH ATM · DEMO KIOSK</div><h2 style="margin-top:8px;">Welcome to iCash</h2><p>No card needed — authenticate with your face</p></div>
    <button class="btn btn-primary btn-block" id="atmAuthBtn">${iconSvg('face')} Authenticate with Face</button>`;

  document.getElementById('atmAuthBtn').onclick = async () => {
    box.innerHTML = `
      <div class="auth-head">
        <h2>Initializing Biometrics</h2>
        <p>Connecting to secure authentication server…</p>
      </div>
      <div style="text-align:center; padding:30px;"><div class="dot" style="margin:0 auto; width:28px; height:28px; border:2px solid var(--accent); border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div></div>`;

    try {
      const targetUserId = State.user && State.user.id;
      if (!targetUserId) {
        toast('No authenticated account found. Please log in first.', 'danger');
        nav('login');
        return;
      }

      // Generate a session nonce to bind this challenge to a specific scan session
      const sessionNonce = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));

      const res = await fetch(API + '/auth/biometric/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accountId: targetUserId, sessionNonce })
      });
      const data = await res.json();

      if (!res.ok && data.error === 'NO_BIOMETRIC_ENROLLED') {
        box.innerHTML = `
          <div class="auth-head">
            <h2 style="color:var(--warn)">Face ID Not Enrolled</h2>
            <p>${data.message || 'No biometric profile enrolled for this account.'}</p>
          </div>
          <div style="padding:10px 0 20px; font-size:13.5px; color:var(--muted); line-height:1.6;">
            Enroll your Face ID from the Profile or Login page first.
          </div>
          <button class="btn btn-ghost btn-block" id="atmBackBtn">Back to ATM Menu</button>`;
        document.getElementById('atmBackBtn').onclick = renderAtmWelcome;
        return;
      }

      if (!res.ok || !data.challengeId) {
        toast(data.error || 'Could not initiate biometric challenge', 'danger');
        renderAtmWelcome();
        return;
      }

      const safeName = esc(State.user?.name ?? 'User');
      const firstName = safeName.split(' ')[0];

      // Mount the scanner with the account-bound challenge
      box.innerHTML = `
        <div class="auth-head">
          <h2>ATM Biometric Verification</h2>
          <p>Verifying identity for <b>${safeName}</b></p>
        </div>
        <div id="atmFaceHolder"></div>`;

      mountFaceScanner(document.getElementById('atmFaceHolder'), {
        challenge: data,  // ← account-bound server challenge
        sessionNonce: sessionNonce,
        onSuccess: (authData) => {
          // SECURITY: Verify server confirmed identity before showing balance
          if (!authData || authData.success !== true) {
            toast('Identity verification failed — ATM access denied', 'danger');
            renderAtmWelcome();
            return;
          }

          box.innerHTML = `
            <div class="auth-head"><h2>Welcome, ${firstName}</h2><p>Available balance</p></div>
            <div class="balance-amt" style="text-align:center; margin-bottom:20px;">${fmtINR(State.balancePaise)}</div>
            <div class="qa-grid" style="grid-template-columns:repeat(2,1fr);">
              <button class="card qa" onclick="nav('withdraw')">${iconSvg('withdraw')}<span>Withdraw</span></button>
              <button class="card qa" onclick="toast('Demo deposits aren\\'t enabled in this prototype','warn')">${iconSvg('receive')}<span>Deposit</span></button>
              <button class="card qa" onclick="nav('send')">${iconSvg('send')}<span>Send Money</span></button>
              <button class="card qa" onclick="nav('history')">${iconSvg('history')}<span>Check Balance</span></button>
            </div>
            <button class="btn btn-outline btn-block" style="margin-top:16px; color:var(--danger); border-color:rgba(255,92,122,0.35);" onclick="nav('login')">${iconSvg('alert')} Emergency Assistance</button>
          `;
        },
        onCancel: renderAtmWelcome,
        onFailure: (err) => {
          console.warn('[ATM] Biometric verification failed:', err);
        }
      });

    } catch (e) {
      console.error('[ATM] Challenge request failed:', e);
      toast(`Biometric server unreachable at ${API}. Ensure 'npm start' is running on port 3000.`, 'danger');
      renderAtmWelcome();
    }
  };
}