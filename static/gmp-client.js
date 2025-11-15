// Client-side helper for table sorting and a next-run timer.
// Include this file in index.html after the table placeholder.

(function () {
  function qs(sel, el=document) { return el.querySelector(sel); }
  function qsa(sel, el=document) { return Array.from(el.querySelectorAll(sel)); }

  // Sorting
  const table = qs('#gmp-table');
  if (table) {
    const tbody = table.tBodies[0];
    const getCellText = (row, idx) => (row.cells[idx] && row.cells[idx].textContent || '').trim();

    const headers = qsa('#gmp-table thead th');
    headers.forEach((th, idx) => {
      if (!th.dataset.sort) return;
      th.style.userSelect = 'none';
      let asc = false;
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const rows = Array.from(tbody.rows);

        const colIndex = idx;
        rows.sort((a,b) => {
          const aText = getCellText(a, colIndex);
          const bText = getCellText(b, colIndex);

          // If sorting by gmp, parse numeric from cell text
          if (key === 'gmp') {
            const an = parseFloat(aText.replace(/[^\d\.\-]/g,'')) || 0;
            const bn = parseFloat(bText.replace(/[^\d\.\-]/g,'')) || 0;
            return asc ? an - bn : bn - an;
          }

          // fallback string compare
          return asc ? aText.localeCompare(bText) : bText.localeCompare(aText);
        });

        // reattach
        rows.forEach(r => tbody.appendChild(r));
        asc = !asc;
        // small visual indicator:
        headers.forEach(h => h.classList.remove('sorted-asc','sorted-desc'));
        th.classList.add(asc ? 'sorted-asc':'sorted-desc');
      });
    });
  }

  // Next-run timer: assumes next run at top of each hour (cron "0 * * * *")
  const nextRunEl = qs('#gmp-next-run');
  const lastUpdatedEl = qs('#gmp-last-updated');
  function updateNextRun() {
    if (!nextRunEl) return;
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0,0,0);
    if (next <= now) next.setHours(next.getHours() + 1);
    const diff = next - now;
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    nextRunEl.textContent = `${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s (at ${next.toLocaleTimeString()})`;
  }
  updateNextRun();
  setInterval(updateNextRun, 1000);

  // small zebra & hover (fallback if CSS not present)
  const style = document.createElement('style');
  style.textContent = `
    #gmp-table tbody tr:nth-child(odd){ background: #fff; }
    #gmp-table tbody tr:nth-child(even){ background: #fafafa; }
    #gmp-table tbody tr:hover{ background:#fffecf; }
    .gmp-up{ color: #0a8a3f; font-weight:600; }
    .gmp-down{ color: #c0392b; font-weight:600; }
    .gmp-neutral{ color:#333; }
    th.sorted-asc{ text-decoration: underline; }
    th.sorted-desc{ text-decoration: underline; opacity: .8; }
  `;
  document.head.appendChild(style);

})();
