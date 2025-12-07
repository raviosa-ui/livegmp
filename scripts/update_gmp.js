// scripts/update_gmp.js
// Node (CommonJS). Requires node-fetch@2 and papaparse installed.
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
const MAX_PER_GROUP = 10; // <= 10 items per Active/Upcoming/Closed

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
  const normalized = s.replace(/[,₹\s]/g,'').replace(/[^\d\.\-\+]/g,'').trim();
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
  if (!raw) return '';
  const s = String(raw).trim().toLowerCase();
  if (s.includes('upcom')) return 'upcoming';
  if (s.includes('clos') || s.includes('list')) return 'closed';
  if (s.includes('active') || s.includes('open')) return 'active';
  return '';
}

// --- DATE PARSING HELPERS (to compute status from Date text) ---

const MONTHS = {
  jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
  jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
};

function tryParseDayMonthYear(token, defaultYear) {
  // Accept formats: DD, DD-MM, DD-MM-YYYY, DD MMM, DD MMM YYYY, DD-MMM, DD-MMM-YYYY
  token = token.trim().replace(/\./g,'');
  // numeric dash format
  const dashMatch = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (dashMatch) {
    const d = Number(dashMatch[1]);
    const m = Number(dashMatch[2]) - 1;
    const y = dashMatch[3] ? Number(dashMatch[3]) : defaultYear;
    return new Date(y, m, d);
  }
  // space month name
  const nameMatch = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (nameMatch) {
    const d = Number(nameMatch[1]);
    const mname = nameMatch[2].slice(0,3).toLowerCase();
    const m = MONTHS[mname];
    const y = nameMatch[3] ? Number(nameMatch[3]) : defaultYear;
    if (m !== undefined) return new Date(y, m, d);
  }
  // single day only (assume default month/year)
  const dayOnly = token.match(/^(\d{1,2})$/);
  if (dayOnly) {
    const d = Number(dayOnly[1]);
    // default to current month/year
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), d);
  }
  return null;
}

function parseDateRange(text) {
  // returns { start: Date|null, end: Date|null }
  if (!text) return { start: null, end: null };
  const raw = String(text).trim();
  if (/tba|to be announced|not announced|n\/a/i.test(raw)) return { start:null, end:null };

  // Replace various separators with a common dash
  const norm = raw.replace(/\u2013|\u2014|–/g,'-').replace(/\s+to\s+/i,'-').replace(/\s*-\s*/,'-');

  // if it contains slash separated month ranges like "14-18 Nov"
  // split on comma first (e.g. "14-18 Nov, 2025")
  const commaParts = norm.split(',');
  let main = commaParts[0].trim();
  let year = (commaParts[1] && /^\s*\d{4}\s*$/.test(commaParts[1])) ? Number(commaParts[1].trim()) : (new Date()).getFullYear();

  // if single '-' means range
  if (main.includes('-')) {
    const parts = main.split('-').map(p => p.trim());
    // possible forms:
    // 1) "14-18 Nov" -> ['14','18 Nov']
    // 2) "14 Nov-18 Nov" -> ['14 Nov','18 Nov']
    // 3) "14 Nov - 18 Nov 2025" etc.
    const first = parts[0];
    const second = parts.slice(1).join('-');
    const now = new Date();
    const defaultYear = year || now.getFullYear();

    const start = tryParseDayMonthYear(first, defaultYear);
    const end = tryParseDayMonthYear(second, defaultYear);

    return { start: start, end: end || start };
  } else {
    // single date like "22 Nov", "22 Nov 2025", "2025", "TBA"
    const single = tryParseDayMonthYear(main, year || (new Date()).getFullYear());
    return { start: single, end: single };
  }
}

function computeStatusFromDateText(dateText) {
  // returns 'upcoming'|'active'|'closed'|'upcoming' (default)
  const { start, end } = parseDateRange(dateText);
  const now = new Date();
  // compute using local India/Kolkata time offset by converting times to ISO-ish
  // We'll compare by date values (midnight local).
  if (!start && !end) {
    // no dates -> treat as upcoming (date not announced)
    return 'upcoming';
  }
  if (start && end) {
    // normalize time by using midnight of each date (local)
    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0,0,0);
    const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23,59,59);
    if (now < s) return 'upcoming';
    if (now >= s && now <= e) return 'active';
    if (now > e) return 'closed';
  }
  // fallback
  return 'upcoming';
}

// --- END DATE HELPERS ---

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
    const ipoPrice = esc(r.Kostak);
    const listingGain = esc(r.SubjectToSauda);
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

    <!-- Hidden details shown on expand (IPO Price/Listing Gain/Type only) -->
    <div class="card-row-details" aria-hidden="true">
      <div><strong>IPO Price:</strong> ${ipoPrice ? (ipoPrice.match(/^₹/) ? ipoPrice : '₹' + ipoPrice) : '—'}</div>
      <div style="margin-top:6px;"><strong>Listing Gain:</strong> ${listingGain || '—'}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${type || '—'}</div>
    </div>
  </div>
`;
  }).join('\n');
}

async function main() {
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];

  // normalize incoming rows
  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? r['GMP_raw'] ?? '';
    const dateRaw = r.Date ?? r.date ?? r['Listing Date'] ?? r['Date'] ?? '';
    const typeRaw = r.Type ?? r.type ?? '';
    const kostakRaw = r.Kostak ?? r.kostak ?? r['IPO Price'] ?? '';
    const subjRaw = r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? r['Listing Gain'] ?? '';

    // compute status: prefer explicit Status column if it's set, otherwise compute from Date text
    let statusFromCsv = normalizeStatus(r.Status ?? r.status ?? r.Stage ?? '');
    let computedStatus = computeStatusFromDateText(String(dateRaw || '').trim());
    const status = statusFromCsv || computedStatus || 'upcoming';

    const gmpNum = parseGmpNumber(gmpRaw);

    return {
      IPO: r.IPO ?? r.Ipo ?? r['IPO Name'] ?? r['Name'] ?? '',
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: kostakRaw ?? '',
      Date: String(dateRaw ?? ''),
      SubjectToSauda: String(subjRaw ?? ''),
      Type: String(typeRaw ?? ''),
      status
    };
  });

  // group
  const groups = { active: [], upcoming: [], closed: [] };
  for (const item of norm) {
    if (!item.IPO || !String(item.IPO).trim()) continue; // skip empty rows
    groups[item.status] = groups[item.status] || [];
    groups[item.status].push(item);
  }

  // sorting function: by GMP_num desc, fallback to IPO name
  const sortFn = (a,b) => {
    if (a.GMP_num === null && b.GMP_num === null) return (a.IPO||'').localeCompare(b.IPO||'');
    if (a.GMP_num === null) return 1;
    if (b.GMP_num === null) return -1;
    return b.GMP_num - a.GMP_num;
  };

  groups.active.sort(sortFn);
  groups.upcoming.sort(sortFn);
  groups.closed.sort(sortFn);

  // enforce limits per group
  groups.active = groups.active.slice(0, MAX_PER_GROUP);
  groups.upcoming = groups.upcoming.slice(0, MAX_PER_GROUP);
  groups.closed = groups.closed.slice(0, MAX_PER_GROUP);

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

  // backup existing
  await backupExistingGmp();

  // write partial
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

  // inject into index.html safely:
  let html = await fs.readFile('index.html', 'utf8');

  // Clean up any old remnants (for migration/safety)
  html = html.replace(/<div id="gmp-wrapper">[\s\S]*?<\/div>\s*/g, '');
  html = html.replace(/<!--\s*GMP_TABLE_START\s*-->[\s\S]*?<!--\s*GMP_TABLE_END\s*-->/g, '');
  html = html.replace(/<!-- GMP_TABLE -->/g, ''); // Remove old placeholder if present

  // Replace between GMP_START and GMP_END
  let newHtml = html.replace(/<!--\s*GMP_START\s*-->[\s\S]*?<!--\s*GMP_END\s*-->/, `<!-- GMP_START -->\n${wrapperHtml}\n<!-- GMP_END -->`);

  // If no change (markers not found), append with markers
  if (newHtml === html) {
    console.warn('GMP_START/END markers not found — appending wrapper with markers before </body>.');
    newHtml = html.replace('</body>', `\n<!-- GMP_START -->\n${wrapperHtml}\n<!-- GMP_END -->\n</body>`);
  }

  await fs.writeFile('index.html', newHtml, 'utf8');
  console.log('Generated _gmp.html and injected into index.html');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
