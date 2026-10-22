/* =========================================================
   ICASH — Security Center
   ========================================================= */
route('security', function() {
  if (!requireAuth()) {return;}
  navbar();
  const ecName = esc(State.user?.emergencyContact?.name ?? '—');
  const lastLogin = esc(State.user?.lastLogin ?? '—');
  const eventsHtml = State.events.map(e => 
    `<div class="kv"><span>${esc(e.type)} — ${esc(e.desc)}</span><span>${esc(e.time)}</span></div>`
  ).join('');

  const shell = el(`<div class="app-shell"><div class="wrap">
    <div class="section-title"><h3>Security Center</h3></div>
    <div class="dash-grid">
      <div class="card">
        <div class="sec-list">
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('face')}</div>Face Authentication</div><span class="pill ok">Active</span></div>
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('shield')}</div>Liveness Detection</div><span class="pill ok">Enabled</span></div>
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('alert')}</div>Emergency PIN</div><span class="pill ok">Configured</span></div>
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('contact')}</div>Emergency Contact</div><span class="pill ok">Verified — ${ecName}</span></div>
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('history')}</div>Last Login</div><span class="pill">${lastLogin}</span></div>
          <div class="sec-row"><div class="l"><div class="sec-ic">${iconSvg('shield')}</div>Security Events</div><span class="pill warn">${State.events.length} recent</span></div>
        </div>
      </div>
      <div class="card" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;">
        <div style="width:100px;height:100px;border-radius:50%;background:radial-gradient(circle,rgba(79,209,255,.18),transparent 70%); display:grid; place-items:center; color:var(--accent);">${iconSvg('shield').replace('width="20" height="20"', 'width="46" height="46"')}</div>
        <div style="font-family:var(--font-d); font-size:15px;">Protected by iCash Security</div>
        <div style="color:var(--muted); font-size:12.5px; text-align:center;">Single-face detection · liveness check · biometric auth · emergency controls</div>
      </div>
    </div>
    <div class="section-title"><h3>Recent security events</h3></div>
    <div class="card" id="secEvents"></div>
  </div></div>`);
  mount(shell);
  const evHolder = document.getElementById('secEvents');
  if (!State.events.length) { evHolder.innerHTML = `<div style="padding:20px; color:var(--muted); text-align:center;">No security events yet.</div>`; }
  else {evHolder.innerHTML = eventsHtml;}
});