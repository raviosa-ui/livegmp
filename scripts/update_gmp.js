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

// Config
const BACKUP_DIR = 'backups';
const BACKUP_KEEP = 30; // keep last N backups

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

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true }).catch(()=>{});
}

async function rotateBackups() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('gmp-') && f.endsWith('.html'));
    if (backups.length <= BACKUP_KEEP) return;
    backups.sort(); // oldest first by timestamp in name
    const toRemove = backups.slice(0, backups.length - BACKUP_KEEP);
    await Promise.all(toRemove.map(f => fs.unlink(path.join(BACKUP_DIR, f))));
  } catch (e) { /* ignore */ }
}

async function backupExistingGmp() {
  try {
    const existing = await fs.readFile('_gmp.html', 'utf8');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g,'-');
    await ensureDir(BACKUP_DIR);
    const fname = path.join(BACKUP_DIR, `gmp-${ts}.html`);
    await fs.writeFile(fname, existing, 'utf8');
    await rotateBackups();
    console.log('Backed up previous _gmp.html to', fname);
  } catch (err) {
    // first run - no file
    console.log('No existing _gmp.html to backup (first run?).');
  }
}

function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/\s+/g,'-')
    .replace(/[^a-z0-9\-]/g,'')
    .replace(/\-+/g,'-')
    .replace(/^\-|\-$/g,'');
}

function buildCardsHtml(rows) {
  // rows already normalized (IPO, GMP_raw, Kostak, Date, SubjectToSauda, status, Type maybe)
  return rows.map(r => {
    const g = gmpLabelAndClass(r.GMP_raw);
    const dateText = esc(r.Date);
    const kostak = esc(r.Kostak);
    const subj = esc(r.SubjectToSauda);
    const type = esc(r.Type || r.type || '');
    const status = r.status;
    const ipoSlug = slugify(r.IPO);
    const ipoUrl = `/ipo/${ipoSlug}`;

    return `
  <div class="ipo-card" data-status="${status}">
    <div class="card-grid">
      <!-- Column 1: Name + GMP -->
      <div class="col col-name">
        <div class="ipo-title">${esc(r.IPO)}</div>
        <div class="gmp-row">
          <span class="gmp-label meta-label">GMP</span>
          <span class="meta-value gmp-value ${g.cls}">${esc(g.label)}</span>
        </div>
      </div>

      <!-- Column 2: Status badge -->
      <div class="col col-status">
        <span class="badge ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>

      <!-- Column 3: Date only -->
      <div class="col col-meta">
        <div class="meta-item-inline">
          <span class="meta-label">Date</span>
          <span class="meta-value">${dateText ? dateText : '—'}</span>
        </div>
      </div>

      <!-- Column 4: Link -->
      <div class="col col-link">
        <a class="ipo-link" href="${ipoUrl}" rel="noopener" title="Open ${esc(r.IPO)} page">Open</a>
      </div>
    </div>

    <!-- Hidden details shown on expand -->
    <div class="card-row-details" aria-hidden="true">
      <div><strong>Kostak:</strong> ${kostak ? '₹' + kostak.replace(/^₹/, '') : '—'}</div>
      <div style="margin-top:6px;"><strong>Subject to Sauda:</strong> ${subj || '—'}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${type || '—'}</div>
    </div>
  </div>
`;
  }).join('\n');
}

async function main(){
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];

  // Normalize and attach status/GMP_num
  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const gmpNum = parseGmpNumber(gmpRaw);
    const statusRaw = r.Status ?? r.status ?? r.Stage ?? r.state ?? '';
    const status = normalizeStatus(statusRaw);
    return {
      IPO: r.IPO ?? r.Ipo ?? r['IPO Name'] ?? '',
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: r.Kostak ?? r.kostak ?? '',
      Date: r.Date ?? r.date ?? r['Listing Date'] ?? '',
      SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? '',
      Type: r.Type ?? r.type ?? '',
      status
    };
  });

  // Group
  const groups = { active: [], upcoming: [], closed: [] };
  for (const item of norm) groups[item.status].push(item);

  // sort within groups: GMP desc then name
  const sortFn = (a,b) => {
    if (a.GMP_num === null && b.GMP_num === null) return (a.IPO||'').localeCompare(b.IPO||'');
    if (a.GMP_num === null) return 1;
    if (b.GMP_num === null) return -1;
    return b.GMP_num - a.GMP_num;
  };
  groups.active.sort(sortFn);
  groups.upcoming.sort(sortFn);
  groups.closed.sort(sortFn);

  // Build content (Active -> Upcoming -> Closed)
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
`;

  if (groups.active.length) {
    content += `<h3 class="section-heading">Active IPOs</h3>\n`;
    content += buildCardsHtml(groups.active);
  }
  if (groups.upcoming.length) {
    content += `<h3 class="section-heading">Upcoming IPOs</h3>\n`;
    content += buildCardsHtml(groups.upcoming);
  }
  if (groups.closed.length) {
    content += `<h3 class="section-heading">Closed / Listed</h3>\n`;
    content += buildCardsHtml(groups.closed);
  }

  content += `</div>\n<div id="load-more-wrap" style="text-align:center;margin-top:12px;"><button id="load-more-btn" class="load-more-btn">Load more</button></div>`;

  const wrapperHtml = `
  <div id="gmp-wrapper">
    ${content}
    <div style="display:none" id="gmp-meta" data-updated="${now.toISOString()}"></div>
  </div>
  `;

  // Backup previous
  await backupExistingGmp();

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
