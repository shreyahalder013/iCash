/* =========================================================
   ICASH — Registration Wizard
   ========================================================= */
const RegState = {};

function resetRegState() {
  RegState.step = 1;
  RegState.name = '';
  RegState.phone = '';
  RegState.dob = '';
  RegState.aadhaar = '';
  RegState.email = '';
  RegState.age = 0;
  RegState.senior = false;
  RegState.pin = '';
  RegState.epin = '';
  RegState.ec = null;
}

route('register', function() {
  navbar();
  resetRegState();
  const shell = el(`<div class="auth-shell"><div class="glass auth-card wide" id="wizBox"></div></div>`);
  mount(shell);
  renderWizardStep();
});

function wizProgressHtml(step) {
  let h = '<div class="wizard-progress">';
  for (let i = 1; i <= 4; i++) {h += `<i class="${i < step ? 'done' : i === step ? 'active' : ''}"></i>`;}
  return h + '</div>';
}

function renderWizardStep() {
  const box = document.getElementById('wizBox');
  if (!box) {return;}
  const step = RegState.step;

  if (step === 1) {box.innerHTML = `
    <div class="auth-head"><h2>Create your iCash ID</h2><p>Step 1 of 4 — Personal information</p></div>
    ${wizProgressHtml(1)}
    <div class="field"><label>Full name</label><input id="rFullName" placeholder="Your full name" value="${RegState.name || ''}" required aria-label="Enter your full name"><div class="err" id="errName"></div></div>
    <div class="row2">
      <div class="field"><label>Phone number</label><input id="rPhone" placeholder="+91 XXXXX XXXXX" value="${RegState.phone || ''}" required aria-label="Enter your phone number"><div class="err" id="errPhone"></div></div>
      <div class="field"><label>Date of birth</label><input type="date" id="rDob" value="${RegState.dob || ''}" required aria-label="Enter your date of birth"><div class="err" id="errDob"></div></div>
    </div>
    <div class="field"><label>Aadhaar number <span class="pill" style="margin-left:6px;">Demo only</span></label><input id="rAadhaar" placeholder="12-digit demo Aadhaar" maxlength="12" value="${RegState.aadhaar || ''}" required aria-label="Enter your 12-digit demo Aadhaar number"><div class="err" id="errAadhaar"></div></div>
    <div class="field"><label>Email address</label><input type="email" id="rEmail" placeholder="you@email.com" value="${RegState.email || ''}" aria-label="Enter your email address"><div class="err" id="errEmail"></div></div>
    <div id="ageBadge"></div>
    <div class="wizard-footer"><span></span><button class="btn btn-primary" id="next1" aria-label="Continue to PIN setup step" onclick="renderWizardStep.next1()">Continue</button></div>`;}

  if (step === 1) {
    document.getElementById('rDob').addEventListener('change', e => {
      const age = State.calcAge(e.target.value);
      document.getElementById('ageBadge').innerHTML = e.target.value ? `<div class="classify-badge">${iconSvg('contact')} Classified as <b>${age >= 60 ? 'Senior Citizen / Elderly User' : 'Standard User'}</b> (age ${age})</div>` : '';
    });
    
    const next1Handler = async () => {
      const btn = document.getElementById('next1');
      if (btn) { btn.disabled = true; btn.textContent = 'Validating...'; }

      const name = val('rFullName').trim();
      const phone = normalizePhone(val('rPhone').trim());
      const dob = val('rDob');
      const aadhaar = val('rAadhaar').trim();
      const email = val('rEmail').trim();

      let hasError = false;
      // Clear previous errors
      ['Name', 'Phone', 'Dob', 'Aadhaar', 'Email'].forEach(f => {
        const el = document.getElementById('err' + f);
        if (el) { el.textContent = ''; el.style.display = 'none'; }
      });

      if (!name) { setFieldError('errName', 'Full name is required'); hasError = true; }
      if (!phone || !/^\+91\d{10}$/.test(phone)) { setFieldError('errPhone', 'Enter a valid Indian phone number'); hasError = true; }
      if (!dob) { setFieldError('errDob', 'Date of birth is required'); hasError = true; }
      if (aadhaar.length !== 12 || !/^\d+$/.test(aadhaar)) { setFieldError('errAadhaar', 'Enter a 12-digit demo Aadhaar number'); hasError = true; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFieldError('errEmail', 'Enter a valid email address'); hasError = true; }

      if (hasError) { if (btn) { btn.disabled = false; btn.textContent = 'Continue'; } return; }

      RegState.name = name; RegState.phone = phone; RegState.dob = dob; RegState.aadhaar = aadhaar; RegState.email = email;
      RegState.age = State.calcAge(dob); RegState.senior = RegState.age >= 60;
      RegState.step = 2; renderWizardStep();
    };
    
    renderWizardStep.next1 = next1Handler;
    const next1Btn = document.getElementById('next1');
    if (next1Btn) {next1Btn.onclick = next1Handler;}
  }

  function setFieldError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = 'block'; }
    const input = el?.previousElementSibling;
    if (input) {input.classList.add('invalid');}
  }

  if (step === 2) {box.innerHTML = `
    <div class="auth-head"><h2>Secure your account</h2><p>Step 2 of 4 — PIN setup</p></div>
    ${wizProgressHtml(2)}
    <div class="field"><label>Normal PIN (4–6 digits)</label><div class="pin-wrap"><input type="password" id="rPin" maxlength="6" placeholder="••••" autocomplete="new-password" aria-label="Enter your normal PIN (4-6 digits)"><button type="button" class="pin-toggle" data-t="rPin" aria-label="Toggle PIN visibility">Show</button></div><div class="strength"><i id="pinStrength"></i></div><div class="err" id="errPin"></div></div>
    <div class="field"><label>Confirm normal PIN</label><div class="pin-wrap"><input type="password" id="rPin2" maxlength="6" placeholder="••••" autocomplete="new-password" aria-label="Confirm your normal PIN"><button type="button" class="pin-toggle" data-t="rPin2" aria-label="Toggle PIN visibility">Show</button></div><div class="err" id="errPin2">PINs don't match</div></div>
    <div class="field"><label>Emergency PIN (different from normal PIN)</label><div class="pin-wrap"><input type="password" id="rEPin" maxlength="6" placeholder="••••" autocomplete="new-password" aria-label="Enter your emergency PIN (4-6 digits)"><button type="button" class="pin-toggle" data-t="rEPin" aria-label="Toggle PIN visibility">Show</button></div><div class="err" id="errEPin"></div>
      <div class="hint">Your Emergency PIN activates the emergency assistance protocol (DEMO).</div></div>
    <div class="wizard-footer"><button class="btn btn-ghost" id="back2" aria-label="Go back to personal information step" onclick="renderWizardStep.back2()">Back</button><button class="btn btn-primary" id="next2" aria-label="Continue to emergency contact step" onclick="renderWizardStep.next2()">Continue</button></div>`;}

  box.querySelectorAll?.('.pin-toggle')?.forEach?.(b => {
    b.onclick = () => { const i = document.getElementById(b.dataset.t); if (i.type === 'password') { i.type = 'text'; b.textContent = 'Hide'; } else { i.type = 'password'; b.textContent = 'Show'; } };
  });
  const pinInput = document.getElementById('rPin');
  if (pinInput) {pinInput.addEventListener('input', e => {
    const v = e.target.value; const bar = document.getElementById('pinStrength');
    const pct = Math.min(100, v.length * 20); const color = v.length < 4 ? '#ff5c7a' : v.length < 6 ? '#f2b84b' : '#38e6a8';
    bar.style.width = pct + '%'; bar.style.background = color;
  });}
  if (step === 2) {
    const back2Handler = () => { RegState.step = 1; renderWizardStep(); };
    const next2Handler = async () => {
      const btn = document.getElementById('next2');
      if (btn) { btn.disabled = true; btn.textContent = 'Validating...'; }

      const p = val('rPin'), p2 = val('rPin2'), ep = val('rEPin');

      // Clear previous errors
      ['Pin', 'Pin2', 'EPin'].forEach(f => {
        const el = document.getElementById('err' + f);
        if (el) { el.textContent = ''; el.style.display = 'none'; }
        const input = document.getElementById('r' + f);
        if (input) {input.classList.remove('invalid');}
      });

      let hasError = false;
      if (p.length < 4 || p.length > 6 || !/^\d+$/.test(p)) { setFieldError('errPin', 'Normal PIN must be 4–6 digits'); hasError = true; }
      if (p !== p2) { setFieldError('errPin2', 'PINs do not match'); hasError = true; }
      if (!ep || ep.length < 4 || ep.length > 6 || !/^\d+$/.test(ep)) { setFieldError('errEPin', 'Emergency PIN must be 4–6 digits'); hasError = true; }
      if (ep === p) { setFieldError('errEPin', 'Emergency PIN must differ from your normal PIN'); hasError = true; }

      if (hasError) { if (btn) { btn.disabled = false; btn.textContent = 'Continue'; } return; }

      RegState.pin = p; RegState.epin = ep; RegState.step = 3; renderWizardStep();
    };
    
    renderWizardStep.back2 = back2Handler;
    renderWizardStep.next2 = next2Handler;
    
    const back2Btn = document.getElementById('back2');
    const next2Btn = document.getElementById('next2');
    if (back2Btn) {back2Btn.onclick = back2Handler;}
    if (next2Btn) {next2Btn.onclick = next2Handler;}
  }

  if (step === 3) {box.innerHTML = `
    <div class="auth-head"><h2>Emergency contact</h2><p>Step 3 of 4 — who can assist you</p></div>
    ${wizProgressHtml(3)}
    <p style="color:var(--muted); font-size:13px; margin-bottom:16px;">Your emergency contact can be authorized to assist with transactions when you are unable to access your account.</p>
    <div class="field"><label>Contact name</label><input id="rEcName" placeholder="Full name" value="${RegState.ec?.name || ''}" aria-label="Enter emergency contact name"></div>
    <div class="row2">
      <div class="field"><label>Phone number</label><input id="rEcPhone" placeholder="+91 XXXXX XXXXX" value="${RegState.ec?.phone || ''}" aria-label="Enter emergency contact phone number"></div>
      <div class="field"><label>Relationship</label>
        <select id="rEcRel" aria-label="Select relationship to emergency contact">
          ${['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Guardian', 'Other'].map(r => `<option ${RegState.ec?.relation === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="wizard-footer"><button class="btn btn-ghost" id="back3" aria-label="Go back to PIN setup step" onclick="renderWizardStep.back3()">Back</button><button class="btn btn-primary" id="next3" aria-label="Continue to face registration step" onclick="renderWizardStep.next3()">Continue</button></div>`;}

  if (step === 3) {
    const back3Handler = () => { RegState.step = 2; renderWizardStep(); };
    const next3Handler = () => {
      const btn = document.getElementById('next3');
      if (btn) { btn.disabled = true; btn.textContent = 'Continuing...'; }
      
      const n = val('rEcName'), p = normalizePhone(val('rEcPhone')), r = val('rEcRel');
      if (!n || !p) { toast('Add your emergency contact details', 'warn'); if (btn) { btn.disabled = false; btn.textContent = 'Continue'; } return; }
      if (!/^\+91\d{10}$/.test(p)) { toast('Enter a valid Indian phone number for emergency contact', 'warn'); if (btn) { btn.disabled = false; btn.textContent = 'Continue'; } return; }
      RegState.ec = { name: n, phone: p, relation: r };
      RegState.step = 4; renderWizardStep();
    };
    
    renderWizardStep.back3 = back3Handler;
    renderWizardStep.next3 = next3Handler;
    
    const back3Btn = document.getElementById('back3');
    const next3Btn = document.getElementById('next3');
    if (back3Btn) {back3Btn.onclick = back3Handler;}
    if (next3Btn) {next3Btn.onclick = next3Handler;}
  }

  if (step === 4) {box.innerHTML = `
    <div class="auth-head"><h2>Secure face registration</h2><p>Step 4 of 4 — liveness verification</p></div>
    ${wizProgressHtml(4)}
    <div id="faceRegHolder"></div>
    <div class="demo-tag">DEMO / SIMULATED biometric capture — face data is processed locally and sent encrypted to our server</div>
    <div class="wizard-footer"><button class="btn btn-ghost" id="back4" aria-label="Go back to emergency contact step" onclick="renderWizardStep.back4()">Back</button><span></span></div>`;}

  if (step === 4) {
    const back4Handler = () => { RegState.step = 3; renderWizardStep(); };
    renderWizardStep.back4 = back4Handler;
    const back4Btn = document.getElementById('back4');
    if (back4Btn) {back4Btn.onclick = back4Handler;}
    
    // Disable back button during face scanning
    const faceRegHolder = document.getElementById('faceRegHolder');
    if (faceRegHolder) {
      const observer = new MutationObserver(() => {
        const scanner = faceRegHolder.querySelector('.scanner');
        if (scanner && back4Btn) {back4Btn.disabled = true;}
      });
      observer.observe(faceRegHolder, { childList: true, subtree: true });
    }
    
    mountFaceScanner(document.getElementById('faceRegHolder'), {
      mode: 'register', senior: RegState.senior,
      onSuccess: async (result) => {
        // SECURITY FIX: Validate that we actually captured a real 128-d template
        if (!result || !result.biometricTemplate || !Array.isArray(result.biometricTemplate) || result.biometricTemplate.length !== 128) {
          toast('Biometric capture failed — no valid face template produced. Please retry.', 'danger');
          return;
        }

        // Build registration user object with PINs and verification details
        const userData = {
          name: RegState.name,
          phone: RegState.phone,
          email: RegState.email ? RegState.email : undefined,
          dob: RegState.dob || undefined,
          aadhaar: RegState.aadhaar || undefined,
          normalPin: RegState.pin,
          emergencyPin: RegState.epin,
          age: RegState.age,
          senior: RegState.senior,
          emergencyContact: RegState.ec,
          faceRegistered: true,
          lastLogin: 'Just now',
          seniorMode: RegState.senior
        };

        const txData = DEFAULT_TX.slice();
        const _balancePaise = 4875000;

        // Disable back button during registration
        const backBtn = document.getElementById('back4');
        if (backBtn) {backBtn.disabled = true;}

        // Register via API — MUST include biometricTemplate or face login will never work
        try {
          const res = await fetch(API + '/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              user: userData,
              transactions: txData,
              balance: 48750,
              biometricTemplate: result.biometricTemplate
            })
          });
          const d = await res.json();
          if (!res.ok) {
            toast(d.error || 'Registration failed — please try again.', 'danger');
            if (backBtn) {backBtn.disabled = false;}
            return;
          }
          // Load authenticated session from server response
          await State.load();
        } catch (e) {
          console.error('[Register] API error:', e);
          toast('Registration failed — server unavailable. Please try again.', 'danger');
          if (backBtn) {backBtn.disabled = false;}
          return;
        }

        State.logEvent('Registration', 'iCash ID created — face identity enrolled');
        State.save();
        toast('Face identity registered ✓', 'ok');
        resetRegState();
        setTimeout(() => nav('dashboard'), 900);
      }
    });
  }
}