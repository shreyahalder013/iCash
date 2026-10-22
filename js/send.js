/* =========================================================
   ICASH — Send Money
   ========================================================= */
route('send', function() {
  if (!requireAuth()) {return;}
  navbar();
  const shell = el(`<div class="auth-shell"><div class="glass auth-card" id="sendBox"></div></div>`);
  mount(shell);
  document.getElementById('sendBox').innerHTML = `
    <div class="auth-head"><h2>Send money</h2><p>Transfer to another iCash user</p></div>
    <div class="field"><label>Recipient phone / iCash ID</label><input id="snAcc" placeholder="+91 XXXXX XXXXX or name@icash" autocomplete="tel"></div>
    <div class="field"><label>Amount</label><input id="snAmt" type="number" placeholder="₹0" min="1" max="100000" step="1"></div>
    <div class="field"><label>Note (optional)</label><input id="snNote" placeholder="What's this for?" maxlength="200"></div>
    <button class="btn btn-primary btn-block" id="snReview">Review transaction</button>`;

  const btn = document.getElementById('snReview');
  btn.onclick = async () => {
    const acc = val('snAcc'), amt = parseFloat(val('snAmt')) || 0, note = val('snNote');
    if (!acc || !amt) { toast('Fill in recipient and amount', 'warn'); return; }
    if (amt > State.balance) { toast('Insufficient balance.', 'danger'); return; }
    
    btn.disabled = true;
    btn.textContent = 'Calculating fee...';
    
    try {
      // Fetch fee from server
      const feeRes = await fetch(API + '/transfer/fee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount: amt })
      });
      const feeData = await feeRes.json();
      if (!feeRes.ok) {throw new Error(feeData.error || 'Failed to calculate fee');}
      
      renderSendReview({ acc, amt, note, fee: feeData.fee, feePaise: feeData.feePaise });
    } catch (err) {
      toast(err.message || 'Failed to calculate fee', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Review transaction';
    }
  };
});

function renderSendReview(d) {
  const box = document.getElementById('sendBox');
  // Normalize recipient phone for display and API
  const normalizedAcc = normalizePhone(d.acc);
  const safeAcc = esc(normalizedAcc);
  const safeNote = esc(d.note ?? '');
  const feeDisplay = fmtINR(d.feePaise);
  const totalDisplay = fmtINR(rupeesToPaise(d.amt) + d.feePaise);
  box.innerHTML = `
    <div class="auth-head"><h2>Review transaction</h2></div>
    <div class="review-row"><span>Recipient</span><span>${safeAcc}</span></div>
    <div class="review-row"><span>Amount</span><span>${fmtINR(rupeesToPaise(d.amt))}</span></div>
    <div class="review-row"><span>Transaction fee</span><span>${feeDisplay}</span></div>
    <div class="review-row"><span>Total</span><span>${totalDisplay}</span></div>
    <button class="btn btn-primary btn-block" style="margin-top:18px;" id="snAuth">Authenticate & send</button>
    <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="snBack">Back</button>`;
  document.getElementById('snBack').onclick = () => routes['send']?.();
  document.getElementById('snAuth').onclick = () => {
    box.innerHTML = `<div class="auth-head"><h2>Face authentication</h2><p>Confirm it's you to send ${fmtINR(rupeesToPaise(d.amt))}</p></div><div id="snFaceHolder"></div>`;
    mountFaceScanner(document.getElementById('snFaceHolder'), {
      accountId: State.user?.id,
      onSuccess: async () => {
        // Senior Mode: Extra confirmation after face auth
        if (State.user?.seniorMode) {
          box.innerHTML = `
            <div class="auth-head"><h2>Final confirmation</h2><p>Please confirm you want to send <b>${fmtINR(rupeesToPaise(d.amt))}</b> to <b>${safeAcc}</b></p></div>
            <div class="review-row"><span>Total with fee</span><span>${fmtINR(rupeesToPaise(d.amt) + d.feePaise)}</span></div>
            <button class="btn btn-primary btn-block" style="margin-top:18px;" id="snFinalConfirm">Yes, send now</button>
            <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="snCancel">Cancel</button>`;
          document.getElementById('snCancel').onclick = () => routes['send']?.();
          document.getElementById('snFinalConfirm').onclick = () => executeTransfer();
          return;
        }
        executeTransfer();
        
        async function executeTransfer() {
        const _totalPaise = rupeesToPaise(d.amt) + d.feePaise;
        const id = genTxId();
        const idempotencyKey = `send-${id}`;

        try {
          // Step 1: Get step-up authorization token (requires session, so uses current auth)
          const stepUpRes = await fetch(API + '/auth/step-up', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              method: 'pin', // Face auth already done via mountFaceScanner
              amount: d.amt,
              type: 'transfer',
              recipientPhone: normalizedAcc
            })
          });
          const stepUpData = await stepUpRes.json().catch(() => ({}));
          if (!stepUpRes.ok) {throw new Error(stepUpData.error || 'Step-up authorization failed');}

          const stepUpToken = stepUpData.stepUpToken;
          if (!stepUpToken) {throw new Error('No step-up token received');}

          // Step 2: Use the atomic transfer endpoint with step-up token
          const res = await fetch(API + '/transfer', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json', 
              'Idempotency-Key': idempotencyKey,
              'x-step-up-token': stepUpToken
            },
            credentials: 'include',
            body: JSON.stringify({
              recipientPhone: normalizedAcc,
              amount: d.amt,
              description: 'Sent to ' + normalizedAcc + (safeNote ? ': ' + safeNote : '')
            })
          });
          const data = await res.json();
          if (!res.ok) {throw new Error(data.error || 'Transfer failed');}

          // Refresh state from server
          await State.load();
          toast('Transfer successful ✓', 'ok');
          nav('dashboard');
        } catch (err) {
          console.error('[Send] Transfer error:', err);
          toast(err.message || 'Transfer failed', 'danger');
        }
      }
      },
      onCancel: () => routes['send']?.()
    });
  };
}