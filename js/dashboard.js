/* =========================================================
   ICASH — Dashboard
   ========================================================= */
route('dashboard', function() {
  if (!requireAuth()) {return;}
  navbar();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const spentPaise = State.tx.filter(t => t.type === 'out').reduce((s, t) => s + (t.amountPaise ?? rupeesToPaise(t.amount)), 0);
  const receivedPaise = State.tx.filter(t => t.type === 'in').reduce((s, t) => s + (t.amountPaise ?? rupeesToPaise(t.amount)), 0);
  const sentPaise = State.tx.filter(t => t.type === 'out' && (t.desc.includes('Send') || t.cat === 'Transfer')).reduce((s, t) => s + (t.amountPaise ?? rupeesToPaise(t.amount)), 0);
  
  // Monthly expenses: only this month's 'out' transactions
  const monthlySpentPaise = State.tx
    .filter(t => t.type === 'out' && new Date(t.date) >= monthStart)
    .reduce((s, t) => s + (t.amountPaise ?? rupeesToPaise(t.amount)), 0);
  
  const userName = esc(State.user?.name ?? 'User');
  const userAge = esc(State.user?.age ?? '—');
  const userSenior = State.user?.senior ? 'Senior' : 'Standard';

  const shell = el(`<div class="app-shell"><div class="wrap">
    ${State.user.seniorMode ? `<div class="senior-banner" role="status">${iconSvg('contact')} Senior Citizen Mode enabled — larger text, simplified navigation, extra confirmations.</div>` : ''}
    <div class="dash-grid">
      <div class="card balance-card">
        <div class="balance-label">Available Balance <span class="pill" style="margin-left:8px;">DEMO ACCOUNT</span></div>
        <div class="balance-amt">${fmtINR(State.balancePaise)}</div>
        <div class="balance-sub">
          <div><b>${userName}</b>Account holder</div>
          <div><b>${userAge} · ${userSenior}</b>User type</div>
          <div><b>Face + PIN</b>Auth methods</div>
        </div>
      </div>
      <div class="mini-stats">
        <div class="card mini-stat"><div class="l">Total Spent</div><div class="v down">${fmtINR(spentPaise)}</div></div>
        <div class="card mini-stat"><div class="l">Money Received</div><div class="v up">${fmtINR(receivedPaise)}</div></div>
        <div class="card mini-stat"><div class="l">Money Sent</div><div class="v">${fmtINR(sentPaise)}</div></div>
        <div class="card mini-stat"><div class="l">This Month</div><div class="v down">${fmtINR(monthlySpentPaise)}</div></div>
      </div>
    </div>
    <div class="section-title"><h3>Quick actions</h3></div>
    <div class="qa-grid" role="list">
      <button class="card qa" onclick="nav('withdraw')" role="listitem"><div class="ic">${iconSvg('withdraw')}</div><span>Withdraw</span></button>
      <button class="card qa" onclick="nav('send')" role="listitem"><div class="ic">${iconSvg('send')}</div><span>Send Money</span></button>
      <button class="card qa" onclick="nav('receive')" role="listitem"><div class="ic">${iconSvg('receive')}</div><span>Receive</span></button>
      <button class="card qa" onclick="nav('history')" role="listitem"><div class="ic">${iconSvg('history')}</div><span>History</span></button>
      <button class="card qa" onclick="nav('profile')" role="listitem"><div class="ic">${iconSvg('contact')}</div><span>Emergency Contact</span></button>
      <button class="card qa" onclick="nav('security')" role="listitem"><div class="ic">${iconSvg('shield')}</div><span>Face Security</span></button>
    </div>
    <div class="section-title"><h3>Recent transactions</h3><a href="#history" style="color:var(--accent); font-size:13px;">View all →</a></div>
    <div class="card" style="padding:8px 12px;" id="recentTxHolder"></div>
  </div></div>`);
  mount(shell);
  document.getElementById('recentTxHolder').appendChild(txTable(State.tx.slice(0, 5)));
});