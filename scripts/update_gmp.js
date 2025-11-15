// scripts/update_gmp.js
// Node 18 - CommonJS
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const Papa = require('papaparse');

const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('Missing GMP_SHEET_CSV_URL env var');
  process.exit(2);
}

function esc(s='') {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function parseGmpNumber(raw) {
  if (raw === undefined || raw === null) return NaN;
  const s = String(raw).trim();
  const normalized = s.replace(/,/g,'').replace(/[%↑↓▲▼–——]/g,'').replace(/[^\d\.\-\+]/g,'').trim();
  if (normalized === '' || normalized === '-' || normalized === '+') return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function gmpLabelAndClass(raw) {
  const n = parseGmpNumber(raw);
  if (!isNaN(n)) {
    if (n > 0) return { label: `▲ ${n}`, cls: 'gmp-up' };
    if (n < 0) return { label: `▼ ${Math.abs(n)}`, cls: 'gmp-down' };
    return { label: `${n}`, cls: 'gmp-neutral' };
  }
  return { label: esc(raw), cls: 'gmp-neutral' };
}

function normalizeStatus(raw) {
  if (!raw) return 'active';
  const s = String(raw).trim().toLowerCase();
  if (s.includes('upcom') || s.includes('not open') || s.includes('upcoming')) return 'upcoming';
  if (s.includes('clos') || s.includes('allot') || s.includes('closed') || s.includes('listed')) return 'closed';
  if (s.includes('active') || s.includes('live') || s.includes('open')) return 'active';
  return 'active';
}

async function main(){
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];

  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const gmpNum = parseGmpNumber(gmpRaw);
    const statusRaw = r.Status ?? r.status ?? r.Stage ?? r.state ?? '';
    const status = normalizeStatus(statusRaw);
    return {
      IPO: r.IPO ?? r.Ipo ?? r['IPO Name'] ?? '',
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: r.Kostak ?? '',
      Date: r.Date ?? r.date ?? r['Listing Date'] ?? '',
      SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? '',
      status
    };
  });

  // Group and order: Active -> Upcoming -> Closed
  const groups = { active: [], upcoming: [], closed: [] };
  for (const item of norm) groups[item.status].push(item);

  const sortFn = (a,b) => {
    if (a.GMP_num === null && b.GMP_num === null) return (a.IPO||'').localeCompare(b.IPO||'');
    if (a.GMP_num === null) return 1;
    if (b.GMP_num === null) return -1;
    return b.GMP_num - a.GMP_num;
  };

  groups.active.sort(sortFn);
  groups.upcoming.sort(sortFn);
  groups.closed.sort(sortFn);

  // Build card HTML for a list (returns HTML string)
  function buildCards(rows) {
    return rows.map(r => {
      const g = gmpLabelAndClass(r.GMP_raw);
      const dateText = esc(r.Date);
      const kostak = esc(r.Kostak);
      const statusBadge = `<span class="badge ${r.status}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span>`;
      return `
<div class="ipo-card" data-status="${r.status}">
  <div class="card-row card-row-top">
    <div class="ipo-title">${esc(r.IPO)}</div>
    ${statusBadge}
  </div>

  <div class="card-row card-row-meta">
    <div class="meta-left">
      <span class="meta-gmp ${g.cls}">${esc(g.label)}</span>
    </div>
    <div class="meta-right">
      <span class="meta-kostak">${kostak ? '₹' + kostak.replace(/^₹/, '') : '&#8212;'}</span>
      <span class="meta-date">${dateText ? dateText : ''}</span>
    </div>
  </div>

  <div class="card-row card-row-details" aria-hidden="true">
    <div><strong>Subject to Sauda:</strong> ${esc(r.SubjectToSauda)}</div>
    <div style="margin-top:6px;"><strong>Kostak:</strong> ${kostak ? '₹' + kostak.replace(/^₹/, '') : '—'}</div>
  </div>
</div>
`;
    }).join('\n');
  }

  const now = new Date();
  const ts = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  let content = `
<div id="gmp-controls" class="sticky-filters">
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="active">Active</button>
  <button class="filter-btn" data-filter="upcoming">Upcoming</button>
  <button class="filter-btn" data-filter="closed">Closed</button>
</div>

<div class="gmp-meta-line">
  <div class="updated">Last updated: <strong id="gmp-last-updated">${esc(ts)}</strong></div>
  <div class="next-run">Next run: <span id="gmp-next-run">calculating...</span></div>
</div>

<div id="gmp-cards">
  <!-- active -->
  ${groups.active.length ? `<h3 class="section-heading">Active IPOs</h3>\n${buildCards(groups.active)}` : ''}
  ${groups.upcoming.length ? `<h3 class="section-heading">Upcoming IPOs</h3>\n${buildCards(groups.upcoming)}` : ''}
  ${groups.closed.length ? `<h3 class="section-heading">Closed / Listed</h3>\n${buildCards(groups.closed)}` : ''}
</div>

<div id="load-more-wrap" style="text-align:center;margin-top:12px;">
  <button id="load-more-btn" class="load-more-btn">Load more</button>
</div>
`;

  const wrapperHtml = `
  <div id="gmp-wrapper">
    ${content}
    <div style="display:none" id="gmp-meta" data-updated="${now.toISOString()}"></div>
  </div>
  `;

  // Write partial and inject into index.html
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

  let html = await fs.readFile('index.html', 'utf8');
  if (html.indexOf('<!-- GMP_TABLE -->') === -1) {
    console.warn('Placeholder <!-- GMP_TABLE --> not found — appending to body end.');
    html = html.replace('</body>', `\n${wrapperHtml}\n</body>`);
  } else {
    html = html.replace('<!-- GMP_TABLE -->', wrapperHtml);
  }
  await fs.writeFile('index.html', html, 'utf8');

  console.log('Generated _gmp.html and updated index.html with cards.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
