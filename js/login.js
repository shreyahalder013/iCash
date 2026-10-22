/* =========================================================
   ICASH — Secure Login + Biometric Verification
   ========================================================= */
window.selectedLoginUser = null;

route('login', function() {
  navbar();
  const shell = el(`<div class="auth-shell"><div class="glass auth-card" id="loginBox"></div></div>`);
  mount(shell);
  renderLoginHome();
});

async function renderLoginHome() {
  const box = document.getElementById('loginBox');

  // If a user was selected via "Switch account", show their name
  // Otherwise show a generic welcome and ask for phone number
  if (window.selectedLoginUser) {
    const name = esc(window.selectedLoginUser.name);
    const phone = esc(window.selectedLoginUser.phone);
    box.innerHTML = `
      <div class="auth-head">
        <h2>Welcome back</h2>
        <p>Sign in to <b>${name}</b> (${phone})</p>
      </div>
      <button class="btn btn-primary btn-block" id="faceLoginBtn" style="margin-bottom:10px;" aria-label="Sign in using face authentication" onclick="setupLoginButtons.faceLogin()">${iconSvg('face')} Secure Face Login</button>
      <button class="btn btn-ghost btn-block" id="pinLoginBtn" style="margin-bottom:12px;" aria-label="Sign in using your PIN" onclick="setupLoginButtons.pinLogin()">Use PIN instead</button>
      <button class="btn btn-outline btn-block btn-sm" id="switchAccBtn" style="margin-bottom:18px;" aria-label="Switch to a different account or phone number" onclick="setupLoginButtons.switchAccount()">Switch account / phone</button>
      <div style="text-align:center; border-top:1px solid var(--border); padding-top:14px;">
        <button class="btn btn-outline btn-sm" id="emgBtn" style="color:var(--danger); border-color:rgba(255,92,122,0.35);" aria-label="Enter emergency PIN to activate emergency protocol (demo)" onclick="setupLoginButtons.emergencyPin()">${iconSvg('alert')} Emergency PIN</button>
      </div>
      <p style="text-align:center; color:var(--muted2); font-size:12.5px; margin-top:16px;">No account? <a href="#register" style="color:var(--accent)">Create one</a></p>`;
    setupLoginButtons(window.selectedLoginUser);
  } else {
    // No user selected yet - ask for phone number first
    box.innerHTML = `
      <div class="auth-head">
        <h2>Welcome back</h2>
        <p>Enter your registered phone number to continue</p>
      </div>
      <div class="field">
        <label>Phone Number</label>
        <input id="loginPhone" type="tel" placeholder="+91 XXXXX XXXXX" autocomplete="tel" aria-label="Enter your registered phone number">
      </div>
      <button class="btn btn-primary btn-block" id="findAccountBtn" aria-label="Find your account using the phone number" onclick="setupLoginButtons.findAccount()">Find Account</button>
      <p style="text-align:center; color:var(--muted2); font-size:12.5px; margin-top:16px;">No account? <a href="#register" style="color:var(--accent)">Create one</a></p>`;

    document.getElementById('findAccountBtn').onclick = async () => {
      const phone = normalizePhone(val('loginPhone').trim());
      if (!phone) { toast('Enter your phone number', 'warn'); return; }

      // Look up user by phone number via API
      try {
        const res = await fetch(API + '/user/by-phone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ phone })
        });

        if (!res.ok) {
          const err = await res.json();
          toast(err.error || 'Account not found', 'danger');
          return;
        }

        const userData = await res.json();
        window.selectedLoginUser = {
          id: userData.id,
          name: userData.name,
          phone: userData.phone
        };
        renderLoginHome();
      } catch (_err) {
        toast('Failed to look up account. Please try again.', 'danger');
      }
    };
  }
}

function setupLoginButtons(targetUser) {
  // Define handlers as named functions so they can be referenced from onclick attributes
  const faceLogin = async () => {
    const box = document.getElementById('loginBox');
    const btn = document.getElementById('faceLoginBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${iconSvg('face')} Initializing...`; }
    box.innerHTML = `
      <div class="auth-head">
        <h2>Initializing Biometrics</h2>
        <p>Connecting to secure authentication server…</p>
      </div>
      <div style="text-align:center; padding:30px;"><div class="dot" style="margin:0 auto; width:28px; height:28px; border:2px solid var(--accent); border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div></div>`;

    try {
      const sessionNonce = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));

      const res = await fetch(API + '/auth/biometric/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ accountId: targetUser.id, phone: targetUser.phone, sessionNonce })
      });
      const data = await res.json();

      if (!res.ok && data.error === 'NO_BIOMETRIC_ENROLLED') {
        box.innerHTML = `
          <div class="auth-head">
            <h2 style="color:var(--warn)">Face ID Not Enrolled</h2>
            <p>${data.message || 'No biometric profile is enrolled for this account.'}</p>
          </div>
          <div style="padding:10px 0 20px; font-size:13.5px; color:var(--muted); line-height:1.6;">
            To authenticate with your face, you must first enroll your Face ID.
          </div>
          <button class="btn btn-primary btn-block" id="enrollFaceNowBtn" style="margin-bottom:10px;" onclick="setupLoginButtons.enrollFaceNow()">${iconSvg('face')} Enroll Face ID Now</button>
          <button class="btn btn-ghost btn-block" id="enrollFallbackPinBtn" onclick="renderLoginHome()">Sign In With PIN Instead</button>`;

        setupLoginButtons.enrollFaceNow = () => renderEnrollFaceFlow(targetUser);
        if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('face')} Secure Face Login`; }
        return;
      }

      if (!res.ok || !data.challengeId) {
        toast(data.error || 'Could not initiate biometric challenge', 'danger');
        renderLoginHome();
        if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('face')} Secure Face Login`; }
        return;
      }

      box.innerHTML = `
        <div class="auth-head">
          <h2>Biometric Verification</h2>
          <p>Verifying identity for <b>${targetUser.name}</b></p>
        </div>
        <div id="loginFaceHolder"></div>`;

      mountFaceScanner(document.getElementById('loginFaceHolder'), {
        challenge: data,
        sessionNonce: sessionNonce,
        onSuccess: async (authData) => {
          if (!authData || authData.success !== true) {
            toast('Authentication rejected — identity verification failed', 'danger');
            renderLoginHome();
            return;
          }

          await State.load();

          if (!State.session || !State.session.active) {
            toast('Session could not be established — please try again', 'danger');
            renderLoginHome();
            return;
          }

          toast('Identity verified — access granted ✓', 'ok');
          setTimeout(() => nav('dashboard'), 500);
        },
        onCancel: () => {
          renderLoginHome();
          if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('face')} Secure Face Login`; }
        },
        onFailure: (err) => {
          console.warn('[Face Login] Verification failed:', err);
        }
      });

    } catch (_e) {
      console.error('Challenge error:', e);
      toast(`Biometric server unreachable at ${API}. Ensure 'npm start' is running on port 3000.`, 'danger');
      renderLoginHome();
      if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('face')} Secure Face Login`; }
    }
  };

  const pinLogin = () => {
    const box = document.getElementById('loginBox');
    const btn = document.getElementById('pinLoginBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
    box.innerHTML = `
      <div class="auth-head">
        <h2>Enter your PIN</h2>
        <p>Sign in to <b>${targetUser.name}</b></p>
      </div>
      <div class="field">
        <div class="pin-wrap">
          <input type="password" id="loginPin" maxlength="6" placeholder="••••" autofocus autocomplete="off" aria-label="Enter your 4-6 digit PIN">
          <button type="button" class="pin-toggle" id="lpToggle" aria-label="Toggle PIN visibility">Show</button>
        </div>
        <div class="err" id="lpErr">Incorrect PIN.</div>
      </div>
      <button class="btn btn-primary btn-block" id="lpSubmit" aria-label="Submit PIN to sign in">Sign in</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="lpBack" aria-label="Go back to login options">Back</button>`;

    document.getElementById('lpToggle').onclick = () => {
      const i = document.getElementById('loginPin');
      i.type = i.type === 'password' ? 'text' : 'password';
    };
    document.getElementById('lpBack').onclick = () => {
      renderLoginHome();
      if (btn) { btn.disabled = false; btn.textContent = 'Use PIN instead'; }
    };

    document.getElementById('lpSubmit').onclick = async () => {
      const submitBtn = document.getElementById('lpSubmit');
      const p = val('loginPin');
      if (!p) { toast('Please enter your PIN', 'warn'); return; }
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in...'; }

      try {
        const res = await fetch(API + '/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ method: 'pin', pin: p, accountId: targetUser.id })
        });
        const d = await res.json();

        if (d.emergency) {
          triggerEmergencyMode(targetUser);
          return;
        }

        if (!res.ok) {
          document.getElementById('lpErr').style.display = 'block';
          toast(d.error || 'Incorrect PIN', 'danger');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign in'; }
          return;
        }

        await State.load();
        toast('Welcome back', 'ok');
        nav('dashboard');
      } catch (_err) {
        toast('Login request failed', 'danger');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign in'; }
      }
    };
    
    if (btn) { btn.disabled = false; btn.textContent = 'Use PIN instead'; }
  };

  const switchAccount = () => {
    window.selectedLoginUser = null;
    renderLoginHome();
  };

  const emergencyPin = () => {
    const box = document.getElementById('loginBox');
    const btn = document.getElementById('emgBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `${iconSvg('alert')} Loading...`; }
    box.innerHTML = `
      <div class="auth-head">
        <h2 style="color:var(--danger)">Emergency PIN</h2>
        <p>Entering this PIN activates the covert emergency protocol (DEMO)</p>
      </div>
      <div class="field">
        <div class="pin-wrap">
          <input type="password" id="emgPin" maxlength="6" placeholder="••••" aria-label="Enter your emergency PIN">
        </div>
      </div>
      <button class="btn btn-danger btn-block" id="emgSubmit" aria-label="Confirm emergency PIN">Confirm</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="emgBack" aria-label="Go back to login options">Back</button>`;

    document.getElementById('emgBack').onclick = () => {
      renderLoginHome();
      if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('alert')} Emergency PIN`; }
    };
    document.getElementById('emgSubmit').onclick = async () => {
      const submitBtn = document.getElementById('emgSubmit');
      const ep = val('emgPin');
      if (!ep) {return;}
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Confirming...'; }

      try {
        const res = await fetch(API + '/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ method: 'emergency', pin: ep, accountId: targetUser.id })
        });
        const d = await res.json();
        if (d.emergency || res.ok) {
          triggerEmergencyMode(targetUser);
        } else {
          toast('Incorrect PIN', 'danger');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirm'; }
        }
      } catch (_err) {
        toast('Connection error', 'danger');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirm'; }
      }
    };
    
    if (btn) { btn.disabled = false; btn.innerHTML = `${iconSvg('alert')} Emergency PIN`; }
  };

  const findAccount = async () => {
    const btn = document.getElementById('findAccountBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Finding...'; }
    const phone = normalizePhone(val('loginPhone').trim());
    if (!phone) { toast('Enter your phone number', 'warn'); if (btn) { btn.disabled = false; btn.textContent = 'Find Account'; } return; }

    // Look up user by phone number via API
    try {
      const res = await fetch(API + '/user/by-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone })
      });

      if (!res.ok) {
        const err = await res.json();
        toast(err.error || 'Account not found', 'danger');
        if (btn) { btn.disabled = false; btn.textContent = 'Find Account'; }
        return;
      }

      const userData = await res.json();
      window.selectedLoginUser = {
        id: userData.id,
        name: userData.name,
        phone: userData.phone
      };
      renderLoginHome();
    } catch (_err) {
      toast('Failed to look up account. Please try again.', 'danger');
      if (btn) { btn.disabled = false; btn.textContent = 'Find Account'; }
    }
  };

  const enrollFaceNow = () => renderEnrollFaceFlow(targetUser);

  // Expose handlers as properties for onclick attributes
  setupLoginButtons.faceLogin = faceLogin;
  setupLoginButtons.pinLogin = pinLogin;
  setupLoginButtons.switchAccount = switchAccount;
  setupLoginButtons.emergencyPin = emergencyPin;
  setupLoginButtons.findAccount = findAccount;
  setupLoginButtons.enrollFaceNow = enrollFaceNow;

  // Also attach directly to buttons for robustness
  const faceBtn = document.getElementById('faceLoginBtn');
  const pinBtn = document.getElementById('pinLoginBtn');
  const switchBtn = document.getElementById('switchAccBtn');
  const emgBtn = document.getElementById('emgBtn');
  const findBtn = document.getElementById('findAccountBtn');
  
  if (faceBtn) {faceBtn.onclick = faceLogin;}
  if (pinBtn) {pinBtn.onclick = pinLogin;}
  if (switchBtn) {switchBtn.onclick = switchAccount;}
  if (emgBtn) {emgBtn.onclick = emergencyPin;}
  if (findBtn) {findBtn.onclick = findAccount;}
}

/* =========================================================
   ENROLL FACE ID FLOW
   ========================================================= */
function renderEnrollFaceFlow(user) {
  const box = document.getElementById('loginBox');
  box.innerHTML = `
    <div class="auth-head">
      <h2>Enroll Face ID</h2>
      <p>Verify normal PIN to enroll biometrics for <b>${user.name}</b></p>
    </div>
    <div class="field">
      <label>Normal Account PIN</label>
      <div class="pin-wrap">
        <input type="password" id="enrollPin" maxlength="6" placeholder="••••" autocomplete="off">
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="enrollPinSubmit">Continue to Face Scan</button>
    <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="enrollPinBack">Cancel</button>`;

  document.getElementById('enrollPinBack').onclick = renderLoginHome;
  document.getElementById('enrollPinSubmit').onclick = () => {
    const pin = val('enrollPin');
    if (!pin) { toast('Enter your normal PIN to authorize enrollment', 'warn'); return; }

    box.innerHTML = `
      <div class="auth-head">
        <h2>Enroll Face Identity</h2>
        <p>Position your face and complete the liveness check</p>
      </div>
      <div id="enrollFaceHolder"></div>`;

    mountFaceScanner(document.getElementById('enrollFaceHolder'), {
      mode: 'enroll',
      onSuccess: async (result) => {
        try {
          const res = await fetch(API + '/auth/biometric/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              accountId: user.id,
              normalPin: pin,
              biometricTemplate: result.biometricTemplate
            })
          });
          const d = await res.json();
          if (!res.ok) {
            toast(d.error || 'Failed to enroll Face ID', 'danger');
            renderLoginHome();
            return;
          }
          toast('Face ID enrolled successfully ✓', 'ok');
          setTimeout(renderLoginHome, 1000);
        } catch (_err) {
          toast('Enrollment failed: network error', 'danger');
          renderLoginHome();
        }
      },
      onCancel: renderLoginHome
    });
  };
}

/* =========================================================
   EMERGENCY MODE
   ========================================================= */
function triggerEmergencyMode(targetUser) {
  const user = targetUser || State.user || { name: 'Account Holder' };
  const eventId = 'SOS-ICASH-2026-' + Math.floor(10000 + Math.random() * 89999);
  State.logEvent('Emergency', 'Emergency PIN detected — SOS protocol simulated (' + eventId + ')');
  const scr = el(`
  <div class="emergency-screen" role="dialog" aria-modal="true" aria-labelledby="emgTitle">
    <div class="glass emg-card">
      <div class="emg-title" id="emgTitle">${iconSvg('alert')} EMERGENCY MODE ACTIVATED</div>
      <div class="emg-sub">SOS SIGNAL INITIATED — DEMO / SIMULATED</div>
      <div class="emg-row"><span>User</span><b>${user.name}</b></div>
      <div class="emg-row"><span>Status</span><b style="color:var(--danger)">Emergency PIN detected</b></div>
      <div class="emg-row"><span>Location</span><b>Demo ATM Location</b></div>
      <div class="emg-row"><span>Time</span><b>${new Date().toLocaleString('en-IN')}</b></div>
      <div class="emg-row"><span>Event ID</span><b>${eventId}</b></div>
      <div class="emg-actions" id="emgActions">
        <div class="emg-action"><span>Bank Security Notified</span><span id="a1">…</span></div>
        <div class="emg-action"><span>Emergency Contact Notified</span><span id="a2">…</span></div>
        <div class="emg-action"><span>Police Alert Simulated</span><span id="a3">…</span></div>
        <div class="emg-action"><span>Transaction Access Locked</span><span id="a4">…</span></div>
      </div>
      <p style="font-size:11.5px; color:var(--muted2); text-align:center; margin-bottom:18px;">This is a simulated demo. No real bank, police, or emergency service has been contacted.</p>
      <button class="btn btn-outline btn-block" id="safeBtn">Return to Safe Mode</button>
    </div>
  </div>`);
  document.body.appendChild(scr);
  ['a1', 'a2', 'a3', 'a4'].forEach((id, i) => setTimeout(() => { scr.querySelector('#' + id).innerHTML = '<span style="color:var(--success)">✓</span>'; }, 500 + i * 450));
  scr.querySelector('#safeBtn').onclick = () => {
    openModal(`
      <div class="auth-head"><h2>Confirm return to safe mode</h2><p>Re-enter your normal PIN to exit emergency mode</p></div>
      <div class="field"><input type="password" id="safePin" maxlength="6" placeholder="Normal PIN" autocomplete="off"></div>
      <button class="btn btn-primary btn-block" id="safeConfirm">Confirm</button>
      <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="safeCancel">Cancel</button>`);
    document.getElementById('safeCancel').onclick = closeModal;
    document.getElementById('safeConfirm').onclick = async () => {
      const sp = val('safePin');
      try {
        const res = await fetch(API + '/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ method: 'pin', pin: sp, accountId: user.id })
        });
        if (!res.ok) { toast('Incorrect PIN', 'danger'); return; }
        closeModal(); scr.remove();
        await State.load();
        nav('dashboard');
      } catch (_e) {
        toast('Verification error', 'danger');
      }
    };
  };
}