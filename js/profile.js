/* =========================================================
   ICASH — Profile
   ========================================================= */
route('profile', function() {
  if (!requireAuth()) {return;}
  navbar();
  const u = State.user;
  const shell = el(`<div class="app-shell"><div class="wrap">
    <div class="section-title"><h3>Profile</h3></div>
    <div class="dash-grid">
      <div class="card">
        <div class="kv-list">
          <div class="kv"><span>Name</span><span>${u.name}</span></div>
          <div class="kv"><span>Phone</span><span>${u.phone}</span></div>
          <div class="kv"><span>Email</span><span>${u.email}</span></div>
          <div class="kv"><span>Date of birth</span><span>${u.dob}</span></div>
          <div class="kv"><span>Age</span><span>${u.age}</span></div>
          <div class="kv"><span>User type</span><span>${u.senior ? 'Senior Citizen / Elderly' : 'Standard'}</span></div>
          <div class="kv"><span>Aadhaar</span><span>${maskAadhaar(u.aadhaar)}</span></div>
          <div class="kv"><span>Face authentication</span><span class="pill ok">Registered</span></div>
        </div>
      </div>
      <div class="card">
        <h4 style="font-family:var(--font-d); margin-bottom:14px;">Emergency contact</h4>
        <div class="kv-list">
          <div class="kv"><span>Name</span><span>${u.emergencyContact?.name || '—'}</span></div>
          <div class="kv"><span>Phone</span><span>${u.emergencyContact?.phone || '—'}</span></div>
          <div class="kv"><span>Relationship</span><span>${u.emergencyContact?.relation || '—'}</span></div>
        </div>
        <h4 style="font-family:var(--font-d); margin:20px 0 10px;">Accessibility</h4>
        <div class="sec-row" style="padding:0;"><div class="l">Senior Citizen Mode</div>
          <label style="position:relative; display:inline-flex; align-items:center; cursor:pointer;">
            <input type="checkbox" id="seniorToggle" ${u.seniorMode ? 'checked' : ''} style="width:38px; height:20px; accent-color:var(--accent); cursor:pointer;" role="switch" aria-checked="${u.seniorMode ? 'true' : 'false'}">
          </label>
        </div>
        <p style="color:var(--muted2); font-size:12px; margin-top:8px;">Larger text, simplified layout, and extra transaction confirmations. This is an accessibility setting, not a medical classification.</p>
      </div>
    </div>
  </div></div>`);
  mount(shell);
  document.getElementById('seniorToggle').onchange = e => {
    State.user.seniorMode = e.target.checked;
    State.save();
    toast(e.target.checked ? 'Senior Citizen Mode enabled' : 'Senior Citizen Mode disabled', 'ok');
    render();
  };
});