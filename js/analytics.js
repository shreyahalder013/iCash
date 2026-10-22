/* =========================================================
   ICASH — Analytics
   ========================================================= */
route('analytics', function() {
  if (!requireAuth()) {return;}
  navbar();
  const spendTx = State.tx.filter(t => t.type === 'out');
  const byCat = {};
  spendTx.forEach(t => { const c = t.cat || 'Other'; byCat[c] = (byCat[c] || 0) + (t.amountPaise ?? rupeesToPaise(t.amount)); });
  const totalPaise = Object.values(byCat).reduce((a, b) => a + b, 0) || 1;
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const budgetPaise = rupeesToPaise(15000);
  const topCatName = esc(topCat ? topCat[0] : '—');
  const topCatAmount = fmtINR(topCat ? topCat[1] : 0);

  const shell = el(`<div class="app-shell"><div class="wrap">
    <div class="section-title"><h3>Expense analytics</h3></div>
    <div class="dash-grid">
      <div class="card"><canvas id="donutChart" height="230" aria-label="Spending by category donut chart"></canvas></div>
      <div class="card"><canvas id="barChart" height="230" aria-label="Spending by category bar chart"></canvas></div>
    </div>
    <div class="mini-stats" style="margin:18px 0;">
      <div class="card mini-stat"><div class="l">Total monthly expense</div><div class="v down">${fmtINR(totalPaise)}</div></div>
      <div class="card mini-stat"><div class="l">Remaining budget</div><div class="v up">${fmtINR(Math.max(0, budgetPaise - totalPaise))}</div></div>
    </div>
    <div class="glass" style="padding:18px;">${iconSvg('shield')} <b>Insight:</b> Your highest spending category this month is <b>${topCatName}</b>, at ${topCatAmount}.</div>
  </div></div>`);
  mount(shell);

  if (typeof Chart === 'undefined') {return;}
  const labels = Object.keys(byCat), data = Object.values(byCat);
  const colors = ['#4fd1ff', '#38e6c4', '#f2b84b', '#ff5c7a', '#9d7bff', '#5f7590'];
  new Chart(document.getElementById('donutChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { color: '#8ea3bd', font: { family: 'Inter' } } } }, cutout: '68%' }
  });
  new Chart(document.getElementById('barChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Spend', data, backgroundColor: '#4fd1ff88', borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8ea3bd' }, grid: { display: false } }, y: { ticks: { color: '#8ea3bd' }, grid: { color: 'rgba(255,255,255,0.05)' } } } }
  });
});