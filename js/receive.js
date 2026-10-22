/* =========================================================
   ICASH — Receive Money
   ========================================================= */
route('receive', function() {
  if (!requireAuth()) {return;}
  navbar();
  const icashId = (State.user.name || 'user').toLowerCase().replace(/[^a-z]/g, '') + '@icash';
  const safeName = esc(State.user?.name ?? 'User');
  const safeIcashId = esc(icashId);
  const shell = el(`<div class="auth-shell"><div class="glass auth-card" id="rcBox">
    <div class="auth-head"><h2>Receive money</h2><p>Share your iCash ID or QR code</p></div>
    <div class="qr-box"><canvas id="qrCanvas" width="200" height="200" aria-label="QR code for ${safeIcashId}"></canvas><div class="demo-tag">DEMO QR — not a real QR code</div></div>
    <div style="text-align:center; margin-bottom:18px;">
      <div style="font-family:var(--font-d); font-size:16px;">${safeName}</div>
      <div style="color:var(--accent); font-size:13.5px;">${safeIcashId}</div>
    </div>
    <div class="field"><label>Request amount (optional)</label><input id="rcAmt" type="number" placeholder="₹0" min="1"></div>
    <button class="btn btn-primary btn-block" id="rcShare">Share payment request</button>
  </div></div>`);
  mount(shell);
  drawFakeQR(document.getElementById('qrCanvas'), icashId);
  const shareBtn = document.getElementById('rcShare');
  shareBtn.onclick = () => {
    const amt = val('rcAmt');
    shareBtn.disabled = true;
    shareBtn.textContent = 'Preparing...';
    setTimeout(() => {
      toast(amt ? `Payment request for ${fmtINR(amt)} ready to share` : 'Your iCash ID is ready to share', 'ok');
      shareBtn.disabled = false;
      shareBtn.textContent = 'Share payment request';
    }, 300);
  };
});

function drawFakeQR(canvas, seed) {
  const ctx = canvas.getContext('2d');
  const size = 21; const cell = canvas.width / size;
  let h = 0; for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  function rnd() { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; }
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0a0e16';
  for (let y = 0; y < size; y++) {for (let x = 0; x < size; x++) {
    const inFinder = (x < 7 && y < 7) || (x > size - 8 && y < 7) || (x < 7 && y > size - 8);
    if (inFinder) {continue;}
    if (rnd() > 0.55) {ctx.fillRect(x * cell, y * cell, cell, cell);}
  }}
  [[0, 0], [size - 7, 0], [0, size - 7]].forEach(([fx, fy]) => {
    ctx.fillStyle = '#0a0e16'; ctx.fillRect(fx * cell, fy * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#fff'; ctx.fillRect((fx + 1) * cell, (fy + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#0a0e16'; ctx.fillRect((fx + 2) * cell, (fy + 2) * cell, 3 * cell, 3 * cell);
  });
}