// scripts/update_gmp.js
// Updated: Kostak → IPO Price | Subject to Sauda → Listing Gain

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
const MAX_PER_GROUP = 10;

function esc(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true }).catch(() => {});
}

async function backupExistingGmp() {
  try {
    const current = await fs.readFile('_gmp.html', 'utf8');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    await ensureDir(BACKUP_DIR);
    const fname = path.join(BACKUP_DIR, `gmp-${ts}.html`);
    await fs.writeFile(fname, current, 'utf8');
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('gmp-') && f.endsWith('.html')).sort();
    if (backups.length > BACKUP_KEEP) {
      const remove = backups.slice(0, backups.length - BACKUP_KEEP);
      await Promise.all(remove.map(f => fs.unlink(path.join(BACKUP_DIR, f))));
    }
    console.log('Backup saved to', fname);
  } catch (err) {
    console.log('No existing _gmp.html (first run?)');
  }
}

function parseGmpNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  const normalized = s.replace(/[,₹\s]/g, '').replace(/[^\d\.\-\+]/g, '').trim();
  if (!normalized || normalized === '-' || normalized === '+') return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function gmpLabelAndClass(raw) {
  const n = parseGmpNumber(raw);
  if (!isNaN(n)) {
    if (n > 0) return { label: `+ ${n}`, cls: 'gmp-up' };
    if (n < 0) return { label: `- ${Math.abs(n)}`, cls: 'gmp-down' };
    return { label: `${n}`, cls: 'gmp-neutral' };
  }
  return { label: esc(raw), cls: 'gmp-neutral' };
}

function normalizeStatus(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toLowerCase();
  if (s.includes('upcom')) return 'upcoming';
  if (s.includes('clos') || s.includes('list')) return 'closed';
  if (s.includes('active') || s.includes('open')) return 'active';
  return '';
}

// Date parsing helpers (unchanged - working perfectly)
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function tryParseDayMonthYear(token, defaultYear) {
  token = token.trim().replace(/\./g,'');
  const dashMatch = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (dashMatch) {
    const d = Number(dashMatch[1]);
    const m = Number(dashMatch[2]) - 1;
    const y = dashMatch[3] ? Number(dashMatch[3]) : defaultYear;
    return new Date(y, m, d);
  }
  const nameMatch = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (nameMatch) {
    const d = Number(nameMatch[1]);
    const mname = nameMatch[2].slice(0,3).toLowerCase();
    const m = MONTHS[mname];
    const y = nameMatch[3] ? Number(nameMatch[3]) : defaultYear;
    if (m !== undefined) return new Date(y, m, d);
  }
  return null;
}

function parseDateRange(text) {
  if (!text) return { start: null, end: null };
  const raw = String(text).trim();
  if (/tba|to be announced|n\/a/i.test(raw)) return { start:null, end:null };
  const norm = raw.replace(/\u2013|\u2014|–/g,'-').replace(/\s+to\s+/i,'-').replace(/\s*-\s*/,'-');
  const commaParts = norm.split(',');
  let main = commaParts[0].trim();
  let year = (commaParts[1] && /^\s*\d{4}\s*$/.test(commaParts[1])) ? Number(commaParts[1].trim()) : new Date().getFullYear();

  if (main.includes('-')) {
    const parts = main.split('-').map(p => p.trim());
    const start = tryParseDayMonthYear(parts[0], year);
    const end = tryParseDayMonthYear(parts.slice(1).join('-'), year);
    return { start, end: end || start };
  } else {
    const single = tryParseDayMonthYear(main, year);
    return { start: single, end: single };
  }
}

function computeStatusFromDateText(dateText) {
  const { start, end } = parseDateRange(dateText);
  const now = new Date();
  if (!start || !end) return 'upcoming';
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);
  if (now < s) return 'upcoming';
  if (now >= s && now <= e) return 'active';
  return 'closed';
}

function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/\-+/g, '-')
    .trim('-');
}

// MAIN HTML CARD BUILDER (With your requested label changes)
function buildCardsHtml(rows) {
  return rows.map(r => {
    const g = gmpLabelAndClass(r.GMP_raw);
    const dateText = esc(r.Date);
    const kostak = esc(r.Kostak);           // ← This is now "IPO Price"
    const listingGain = esc(r.SubjectToSauda); // ← This is now "Listing Gain"
    const type = esc(r.Type || '');
    const status = r.status;
    const ipoSlug = slugify(r.IPO);
    const ipoUrl = `/ipo/${ipoSlug}`;

    return `
  <div class="ipo-card" data-status="${status}">
    <div class="card-grid">
      <div class="col col-name">
        <div class="ipo-title">${esc(r.IPO)}</div>
        <div class="gmp-row">
          <span class="gmp-label meta-label">GMP</span>
          <span class="meta-value gmp-value ${g.cls}">${g.label}</span>
        </div>
      </div>
      <div class="col col-status">
        <span class="badge ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>
      <div class="col col-meta">
        <div class="meta-item-inline">
          <span class="meta-label">Date</span>
          <span class="meta-value">${dateText || '—'}</span>
        </div>
      </div>
      <div class="col col-link">
        <a class="ipo-link" href="${ipoUrl}" rel="noopener" title="Open ${esc(r.IPO)} page">View</a>
      </div>
    </div>

    <div class="card-row-details" aria-hidden="true">
      <div><strong>IPO Price:</strong> ${kostak ? (kostak.startsWith('₹') ? kostak : '₹' + kostak) : '—'}</div>
      <div style="margin-top:6px;"><strong>Listing Gain:</strong> ${listingGain ? listingGain + '%' : '—'}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${type || '—'}</div>
    </div>
  </div>`;
  }).join('\n');
}

async function main() {
  console.log('Fetching latest GMP data...');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('CSV fetch failed: ' + res.status);
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data;

  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const dateRaw = r.Date ?? r.date ?? '';
    const kostakRaw = r.Kostak ?? '';
    const saudaRaw = r.SubjectToSauda ?? r.Sauda ?? '';
    const typeRaw = r.Type ?? '';

    const status = normalizeStatus(r.Status ?? r.status ?? '') || computeStatusFromDateText(dateRaw);
    const gmpNum = parseGmpNumber(gmpRaw);

    return {
      IPO: (r.IPO ?? r.Ipo ?? '').trim(),
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: kostakRaw,
      SubjectToSauda: saudaRaw,
      Date: dateRaw,
      Type: typeRaw,
      status
    };
  }).filter(r => r.IPO);

  const groups = { active: [], upcoming: [], closed: [] };
  norm.forEach(item => groups[item.status].push(item));

  const sortByGmp = (a, b) => (b.GMP_num ?? -Infinity) - (a.GMP_num ?? -Infinity);
  ['active', 'upcoming', 'closed'].forEach(key => {
    groups[key].sort(sortByGmp);
    groups[key] = groups[key].slice(0, MAX_PER_GROUP);
  });

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
  <div class="updated">Last updated: <strong id="gmp-last-updated">${tsLocal}</strong></div>
  <div class="next-run">Next run: <span id="gmp-next-run">calculating...</span></div>
</div>

<div id="gmp-cards">
`;

  if (groups.active.length) content += `<h3 class="section-heading">Active IPOs</h3>\n${buildCardsHtml(groups.active)}`;
  if (groups.upcoming.length) content += `<h3 class="section-heading">Upcoming IPOs</h3>\n${buildCardsHtml(groups.upcoming)}`;
  if (groups.closed.length) content += `<h3 class="section-heading">Closed / Listed</h3>\n${buildCardsHtml(groups.closed)}`;

  content += `</div>
<div id="load-more-wrap" style="text-align:center;margin-top:12px;">
  <button id="load-more-btn" class="load-more-btn">Load more</button>
</div>`;

  const wrapperHtml = `<div id="gmp-wrapper">
  ${content}
  <div style="display:none" id="gmp-meta" data-updated="${now.toISOString()}"></div>
</div>`;

  await backupExistingGmp();
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

  let html = await fs.readFile('index.html', 'utf8');
  html = html.replace(/<!-- === DO NOT REMOVE === -->[\s\S]*?(?=<div id="gmp-wrapper">|$)/, ''); // clean old
  html = html.replace('<!-- === DO NOT REMOVE === -->', wrapperHtml);

  await fs.writeFile('index.html', html, 'utf8');
  console.log('LiveGMP updated successfully! Kostak → IPO Price | Subject to Sauda → Listing Gain');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
