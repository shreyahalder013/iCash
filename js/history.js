/* =========================================================
   ICASH — Transaction History
   ========================================================= */
route('history', function() {
  if (!requireAuth()) {return;}
  navbar();
  const shell = el(`<div class="app-shell"><div class="wrap">
    <div class="section-title"><h3>Transaction history</h3></div>
    <div class="tx-filters" role="search" aria-label="Transaction filters">
      <input id="hSearch" placeholder="Search transactions…" aria-label="Search">
      <select id="hType" aria-label="Filter by type"><option value="">All types</option><option value="in">Received</option><option value="out">Spent</option><option value="mid">Transfer</option></select>
      <input id="hDate" type="date" aria-label="Filter by date">
    </div>
    <div class="card" style="padding:8px 12px;" id="histTable"></div>
  </div></div>`);
  mount(shell);

  function refresh() {
    const q = val('hSearch').toLowerCase(), ty = document.getElementById('hType').value, dt = val('hDate');
    const rows = State.tx.filter(t => {
      if (q && !t.desc.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) {return false;}
      if (ty && t.type !== ty) {return false;}
      if (dt && t.date !== dt) {return false;}
      return true;
    });
    const holder = document.getElementById('histTable'); holder.innerHTML = '';
    if (!rows.length) { holder.innerHTML = `<div style="padding:30px; text-align:center; color:var(--muted);">No transactions match your filters.</div>`; return; }
    holder.appendChild(txTable(rows));
  }

  document.getElementById('hSearch').addEventListener('input', refresh);
  document.getElementById('hType').addEventListener('change', refresh);
  document.getElementById('hDate').addEventListener('change', refresh);
  refresh();
});