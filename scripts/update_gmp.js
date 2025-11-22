// scripts/update_gmp.js
// Updated: removes stale rows from index.html and limits each section to 10 items.
// Requires: node-fetch@2 (or native fetch polyfill) and papaparse

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const Papa = require('papaparse');

const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('Missing GMP_SHEET_CSV_URL env var');
  process.exit(2);
}

const BACKUP_DIR = 'backups';
const BACKUP_KEEP = 30;
const MAX_PER_SECTION = 10; // <-- limit per Active/Upcoming/Closed

function esc(s='') {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true }).catch(()=>{});
}

async function backupExistingGmp() {
  try {
    const current = await fs.readFile('_gmp.html', 'utf8');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g,'-');
    await ensureDir(BACKUP_DIR);
    const fname = path.join(BACKUP_DIR, `gmp-${ts}.html`);
    await fs.writeFile(fname, current, 'utf8');
    // rotate
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('gmp-') && f.endsWith('.html')).sort();
    if (backups.length > BACKUP_KEEP) {
      const remove = backups.slice(0, backups.length - BACKUP_KEEP);
      await Promise.all(remove.map(f => fs.unlink(path.join(BACKUP_DIR, f))));
    }
    console.log('Backup saved to', fname);
  } catch (err) {
    // ignore - first run
    console.log('No existing _gmp.html found (first run?)');
  }
}

function parseGmpNumber(raw) {
  if (raw === undefined || raw === null) return NaN;
  const s = String(raw).trim();
  const normalized = s.replace(/,/g,'').replace(/[^\d\.\-\+]/g,'').trim();
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
  if (s.includes('upcom')) return 'upcoming';
  if (s.includes('clos') || s.includes('list')) return 'closed';
  if (s.includes('active') || s.includes('open')) return 'active';
  return 'active';
}

function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/\s+/g,'-')
    .replace(/[^a-z0-9\-]/g,'')
    .replace(/\-+/g,'-')
    .replace(/^\-|\-$/g,'');
}

function buildCardsHtml(rows) {
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

      <!-- Column 4: View link -->
      <div class="col col-link">
        <a class="ipo-link" href="${ipoUrl}" rel="noopener" title="Open ${esc(r.IPO)} page">View</a>
      </div>
    </div>

    <!-- Hidden details shown on expand (Kostak/Subject/Type only) -->
    <div class="card-row-details" aria-hidden="true">
      <div><strong>Kostak:</strong> ${kostak ? kostak : '—'}</div>
      <div style="margin-top:6px;"><strong>Subject to Sauda:</strong> ${subj || '—'}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${type || '—'}</div>
    </div>
  </div>
`;
  }).join('\n');
}

async function readPreviousIpoList() {
  try {
    const prevHtml = await fs.readFile('_gmp.html', 'utf8');
    const matches = [...prevHtml.matchAll(/<div[^>]*class="ipo-title"[^>]*>([\s\S]*?)<\/div>/gi)];
    const names = matches.map(m => m[1].replace(/\s+/g,' ').trim()).filter(Boolean);
    return names;
  } catch(e){
    return [];
  }
}

async function main() {
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  let rowsRaw = parsed.data || [];

  // Normalize keys and pick only useful rows. Dedupe by IPO name.
  const seen = new Set();
  const norm = [];
  for (const r of rowsRaw) {
    const ipoName = (r.IPO ?? r.Ipo ?? r['IPO Name'] ?? r['Name'] ?? r['Company'] ?? '').toString().trim();
    if (!ipoName) continue;
    const nKey = ipoName.toLowerCase();
    if (seen.has(nKey)) continue;
    seen.add(nKey);
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const statusRaw = r.Status ?? r.status ?? r.Stage ?? '';
    const status = normalizeStatus(statusRaw);
    norm.push({
      IPO: ipoName,
      GMP_raw: gmpRaw,
      GMP_num: (() => { const n = parseGmpNumber(gmpRaw); return Number.isFinite(n) ? n : null; })(),
      Kostak: r.Kostak ?? r.kostak ?? r['Price'] ?? '',
      Date: r.Date ?? r.date ?? r['Listing Date'] ?? r['Date Range'] ?? '',
      SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? r['Listing Gain'] ?? '',
      Type: r.Type ?? r.type ?? '',
      status
    });
  }

  // group and sort
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

  // limit each section to MAX_PER_SECTION
  groups.active = groups.active.slice(0, MAX_PER_SECTION);
  groups.upcoming = groups.upcoming.slice(0, MAX_PER_SECTION);
  groups.closed = groups.closed.slice(0, MAX_PER_SECTION);

  // prepare HTML
  const now = new Date();
  const tsLocal = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

  let content = `
<div id="gmp-controls" class="sticky-filters">
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="active">Active</button>
  <button class="filter-btn" data-filter="upcoming">Upcoming</button>
  <button class="filter-btn" data-filter="closed">Closed</button>
</div>

<div class="gmp-meta-line">
  <div class="updated">Last updated: <strong id="gmp-last-updated">${esc(tsLocal)}</strong></div>
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

  // read previous IPOs for diff logging
  const prevIpos = await readPreviousIpoList();
  const newIpos = [...groups.active, ...groups.upcoming, ...groups.closed].map(x => x.IPO);

  const removed = prevIpos.filter(p => !newIpos.includes(p));
  const added = newIpos.filter(n => !prevIpos.includes(n));

  console.log('Summary: total rows on sheet (after dedupe):', norm.length);
  console.log('New page counts -> Active:', groups.active.length, 'Upcoming:', groups.upcoming.length, 'Closed:', groups.closed.length);
  console.log('Added IPOs (new):', added);
  console.log('Removed IPOs (deleted upstream):', removed);

  // backup existing
  await backupExistingGmp();

  // write partial
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

  // inject into index.html safely: remove any existing gmp-wrapper chunks then insert at placeholder
  let html = await fs.readFile('index.html', 'utf8');

  // remove ALL prior injected blocks (global)
  html = html.replace(/<div id="gmp-wrapper">[\s\S]*?<\/div>\s*/g, '');

  if (html.indexOf('<!-- GMP_TABLE -->') === -1) {
    console.warn('Placeholder <!-- GMP_TABLE --> not found — appending wrapper before </body>.');
    html = html.replace('</body>', `\n${wrapperHtml}\n</body>`);
  } else {
    html = html.replace('<!-- GMP_TABLE -->', wrapperHtml);
  }

  await fs.writeFile('index.html', html, 'utf8');
  console.log('Generated _gmp.html and injected into index.html — done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
