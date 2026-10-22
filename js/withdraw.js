/* =========================================================
   ICASH — Withdraw
   ========================================================= */
route('withdraw', function() {
  if (!requireAuth()) {return;}
  navbar();
  const shell = el(`<div class="auth-shell"><div class="glass auth-card" id="wdBox"></div></div>`);
  mount(shell); renderWithdraw();
});

function renderWithdraw(amount) {
  const box = document.getElementById('wdBox');
  const safeBalance = fmtINR(State.balancePaise);
  box.innerHTML = `
    <div class="auth-head"><h2>Withdraw money</h2><p>Available balance: ${safeBalance}</p></div>
    <div class="chip-row" id="chipRow">
      ${[500, 1000, 2000, 5000].map(a => `<button class="chip" data-a="${a}">₹${a}</button>`).join('')}
      <button class="chip" data-a="custom">Custom</button>
    </div>
    <div class="big-amt-wrap"><span class="cur">₹</span><input class="big-amt-input" id="wdAmt" type="number" placeholder="0" value="${amount || ''}" min="1" max="${State.balance}"></div>
    <button class="btn btn-primary btn-block" id="wdNext" style="margin-top:14px;">Continue</button>`;

  box.querySelectorAll('.chip').forEach(c => {
    c.onclick = () => {
      box.querySelectorAll('.chip').forEach(x => x.classList.remove('active')); c.classList.add('active');
      if (c.dataset.a !== 'custom') {document.getElementById('wdAmt').value = c.dataset.a;}
      else {document.getElementById('wdAmt').focus();}
    };
  });

  document.getElementById('wdNext').onclick = () => {
    const amt = parseFloat(document.getElementById('wdAmt').value);
    if (!amt || amt <= 0) { toast('Enter a withdrawal amount', 'warn'); return; }
    if (amt > State.balance) { toast('Insufficient balance.', 'danger'); return; }
    const safeAmt = fmtINR(amt);
    box.innerHTML = `<div class="auth-head"><h2>Verify it's you</h2><p>Face verification required to withdraw ${safeAmt}</p></div><div id="wdFaceHolder"></div>`;
    mountFaceScanner(document.getElementById('wdFaceHolder'), {
      accountId: State.user?.id,
      onSuccess: () => {
        box.innerHTML = `
          <div class="auth-head"><h2>Confirm with PIN</h2><p>Enter your normal PIN to finish</p></div>
          <div class="field">
            <div class="pin-wrap">
              <input type="password" id="wdPin" maxlength="6" placeholder="••••" autocomplete="off" autofocus>
              <button type="button" class="pin-toggle" id="wdPinToggle">Show</button>
            </div>
          </div>
          <button class="btn btn-primary btn-block" id="wdPinSubmit">Confirm withdrawal</button>`;
        const pinBtn = document.getElementById('wdPinSubmit');
        const toggleBtn = document.getElementById('wdPinToggle');
        if (toggleBtn) {
          toggleBtn.onclick = () => {
            const inp = document.getElementById('wdPin');
            if (!inp) {return;}
            if (inp.type === 'password') {
              inp.type = 'text';
              toggleBtn.textContent = 'Hide';
            } else {
              inp.type = 'password';
              toggleBtn.textContent = 'Show';
            }
          };
        }
        const pinInp = document.getElementById('wdPin');
        if (pinInp) {
          pinInp.onkeydown = (e) => {
            if (e.key === 'Enter') {pinBtn.click();}
          };
        }
        pinBtn.onclick = async () => {
          const pin = val('wdPin');
          if (!pin) { toast('Enter your PIN', 'warn'); return; }
          
          pinBtn.disabled = true;
          pinBtn.textContent = 'Verifying...';
          
          try {
            // Step 1: Verify PIN server-side using step-up endpoint (no session creation)
            const pinRes = await fetch(API + '/auth/verify-pin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ pin, accountId: State.user?.id })
            });
            const pinData = await pinRes.json().catch(() => ({}));
            if (!pinRes.ok) {throw new Error(pinData.error || 'Incorrect PIN');}

            // Step 2: Get step-up authorization token
            pinBtn.textContent = 'Authorizing...';
            const stepUpRes = await fetch(API + '/auth/step-up', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                method: 'pin',
                pin,
                amount: amt,
                type: 'withdraw'
              })
            });
            const stepUpData = await stepUpRes.json().catch(() => ({}));
            if (!stepUpRes.ok) {throw new Error(stepUpData.error || 'Step-up authorization failed');}

            const stepUpToken = stepUpData.stepUpToken;
            if (!stepUpToken) {throw new Error('No step-up token received');}

            const id = genTxId();
            const idempotencyKey = `withdraw-${id}`;
            const _amountPaise = rupeesToPaise(amt);

            pinBtn.textContent = 'Processing...';

            // Step 3: Atomic balance adjustment with step-up token
            const adjRes = await fetch(API + '/transactions', {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json', 
                'Idempotency-Key': idempotencyKey,
                'x-step-up-token': stepUpToken
              },
              credentials: 'include',
              body: JSON.stringify({
                id, date: new Date().toISOString().slice(0,10),
                desc: 'ATM Withdrawal', type: 'out', cat: 'Cash',
                amount: amt, status: 'Completed'
              })
            });
            if (!adjRes.ok) {
              const adjErr = await adjRes.json().catch(() => ({}));
              throw new Error(adjErr.error || 'Withdrawal failed');
            }

            await State.load();
            const safeId = esc(id);
            const safeRemaining = fmtINR(State.balancePaise);
            box.innerHTML = `
              <div class="success-anim">
                <div class="check-circle">${iconSvg('check')}</div>
                <h2 style="font-family:var(--font-d); margin-bottom:6px;">Withdrawal Successful</h2>
                <p style="color:var(--muted); margin-bottom:16px;">${safeAmt} withdrawn</p>
                <div class="review-row"><span>Transaction ID</span><span>${safeId}</span></div>
                <div class="review-row"><span>Remaining balance</span><span>${safeRemaining}</span></div>
                <button class="btn btn-primary btn-block" style="margin-top:20px;" onclick="nav('dashboard')">Back to Dashboard</button>
              </div>`;
          } catch (err) {
            toast(err.message || 'Withdrawal failed', 'danger');
          } finally {
            pinBtn.disabled = false;
            pinBtn.textContent = 'Confirm withdrawal';
          }
        };
      },
      onCancel: renderWithdraw
    });
  };
}