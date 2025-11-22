// scripts/update_gmp.js
// Updated: Adds date-range parsing, status logic (Asia/Kolkata), pre-hide >7 cards
// Dependencies: node-fetch@2 papaparse (your workflow already installs them)

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
const SHOW_BATCH = 7; // how many cards visible on first load, rest hidden by lazy

function esc(s='') {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
async function ensureDir(dir) {
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
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('gmp-') && f.endsWith('.html')).sort();
    if (backups.length > BACKUP_KEEP) {
      const remove = backups.slice(0, backups.length - BACKUP_KEEP);
      await Promise.all(remove.map(f => fs.unlink(path.join(BACKUP_DIR, f))));
    }
    console.log('Backup saved to', fname);
  } catch (err) {
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

/* ---------- DATE RANGE PARSING & STATUS ---------- */

/*
parseDateRange(rangeStr)
 - supports examples:
   "14-18 Nov", "14-18 Nov 2025", "21 Nov 2025", "21 Nov", "TBA", "2025"
 - returns { start: Date|null, end: Date|null }
 - uses current year if year not provided
*/
function parseDateRange(rangeStr) {
  if (!rangeStr) return { start: null, end: null };
  const s = String(rangeStr).trim();
  if (!s || /tba|to be announced|coming soon/i.test(s)) return { start: null, end: null };

  // normalize separators
  const norm = s.replace(/\u2013|\u2014/g,'-').replace(/\s*-\s*/g,'-').replace(/\s+to\s+/i, '-');
  // months map
  const months = {
    jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
    jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11
  };

  // try: "14-18 Nov 2025" or "14-18 Nov"
  const parts = norm.split(/\s+/);
  // find words that are month-like
  let monthIndex = -1;
  let year = null;
  for (let i = parts.length-1; i>=0; i--) {
    const p = parts[i].replace(/[^A-Za-z0-9]/g,'');
    if (/^\d{4}$/.test(p)) { year = parseInt(p,10); continue; }
    const m = p.substring(0,3).toLowerCase();
    if (m in months) { monthIndex = months[m]; break; }
  }

  // separate numeric range portion (like "14-18")
  const numericPart = parts[0]; // may contain dash
  // if string contains a dash like "14-18 Nov"
  const dashMatch = norm.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (dashMatch) {
    const startDay = parseInt(dashMatch[1],10);
    const endDay = parseInt(dashMatch[2],10);
    const y = year || (new Date()).getFullYear();
    if (monthIndex >= 0) {
      const start = new Date(Date.UTC(y, monthIndex, startDay));
      const end = new Date(Date.UTC(y, monthIndex, endDay, 23,59,59));
      return { start, end };
    } else {
      // maybe month present after range like "14-18 Nov"
      const mMatch = norm.match(/(\d{1,2})\s*-\s*(\d{1,2})\s*([A-Za-z]+)/);
      if (mMatch) {
        const m = mMatch[3].substring(0,3).toLowerCase();
        if (m in months) {
          const y2 = year || (new Date()).getFullYear();
          const start = new Date(Date.UTC(y2, months[m], startDay));
          const end = new Date(Date.UTC(y2, months[m], endDay, 23,59,59));
          return { start, end };
        }
      }
    }
  }

  // try single date: "21 Nov 2025" or "21 Nov"
  const singleMatch = norm.match(/(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{4})?/);
  if (singleMatch) {
    const day = parseInt(singleMatch[1],10);
    const m = singleMatch[2].substring(0,3).toLowerCase();
    if (m in months) {
      const y = singleMatch[3] ? parseInt(singleMatch[3],10) : (new Date()).getFullYear();
      const start = new Date(Date.UTC(y, months[m], day));
      const end = new Date(Date.UTC(y, months[m], day, 23,59,59));
      return { start, end };
    }
  }

  // try year-only "2025"
  const yearOnly = norm.match(/^\d{4}$/);
  if (yearOnly) {
    const y = parseInt(norm,10);
    const start = new Date(Date.UTC(y,0,1));
    const end = new Date(Date.UTC(y,11,31,23,59,59));
    return { start, end };
  }

  return { start: null, end: null };
}

/*
determineStatus(rangeStr)
 - returns 'upcoming' | 'active' | 'closed'
 - uses Asia/Kolkata (IST) current date
*/
function determineStatus(rangeStr) {
  const { start, end } = parseDateRange(rangeStr);
  // now in India timezone: compute today's date boundary by converting current date to UTC date representing IST date
  const now = new Date();
  // convert now to IST offset string won't be necessary: compare using UTC times but offset by IST (UTC+5:30)
  // We will make "today" be the IST local date at time 00:00:00 UTC-equivalent
  const istOffsetMinutes = 5 * 60 + 30;
  const nowUtcMs = Date.now();
  const nowIstMs = nowUtcMs + istOffsetMinutes * 60000;
  const todayIst = new Date(nowIstMs);
  // normalize to midnight IST
  const istYear = todayIst.getUTCFullYear();
  const istMonth = todayIst.getUTCMonth();
  const istDate = todayIst.getUTCDate();
  const todayIstStart = Date.UTC(istYear, istMonth, istDate); // this is in ms UTC representing IST midnight

  if (!start || !end) {
    // If no dates, treat as upcoming
    return 'upcoming';
  }

  // convert parsed start/end (which are built as UTC midnight) to ms
  const startMs = start.getTime();
  const endMs = end.getTime();

  if (todayIstStart < startMs) return 'upcoming';
  if (todayIstStart >= startMs && todayIstStart <= endMs) return 'active';
  if (todayIstStart > endMs) return 'closed';
  return 'upcoming';
}

/* ---------- HTML BUILD ---------- */

function buildCardsHtml(rows) {
  // We'll pre-hide cards after SHOW_BATCH overall items (not per-group).
  let count = 0;
  return rows.map(r => {
    const g = gmpLabelAndClass(r.GMP_raw);
    const dateText = esc(r.Date);
    const kostak = esc(r.Kostak);
    const subj = esc(r.SubjectToSauda);
    const type = esc(r.Type || r.type || '');
    const status = r.status || 'active';
    const ipoSlug = slugify(r.IPO);
    const ipoUrl = `/ipo/${ipoSlug}`;

    const hiddenClass = (count >= SHOW_BATCH) ? ' hidden-by-lazy' : '';
    count++;

    return ` 
  <div class="ipo-card${hiddenClass}" data-status="${status}">
    <div class="card-grid">
      <div class="col col-name">
        <div class="ipo-title">${esc(r.IPO)}</div>
        <div class="gmp-row">
          <span class="gmp-label meta-label">GMP</span>
          <span class="meta-value gmp-value ${g.cls}">${esc(g.label)}</span>
        </div>
      </div>

      <div class="col col-status">
        <span class="badge ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>

      <div class="col col-meta">
        <div class="meta-item-inline">
          <span class="meta-label">Date</span>
          <span class="meta-value">${dateText ? dateText : '—'}</span>
        </div>
      </div>

      <div class="col col-link">
        <a class="ipo-link" href="${ipoUrl}" rel="noopener" title="Open ${esc(r.IPO)} page">View</a>
      </div>
    </div>

    <div class="card-row-details" aria-hidden="true">
      <div><strong>Kostak:</strong> ${kostak ? kostak : '—'}</div>
      <div style="margin-top:6px;"><strong>Subject to Sauda:</strong> ${subj || '—'}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${type || '—'}</div>
    </div>
  </div>`;
  }).join('\n');
}

/* ---------- main ---------- */
async function main() {
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];

  // normalize rows
  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const dateRaw = r.Date ?? r.date ?? r['Listing Date'] ?? r['Date'] ?? '';
    const statusRaw = r.Status ?? r.status ?? r.Stage ?? '';
    const statusFromSheet = normalizeStatus(statusRaw);
    const typeRaw = r.Type ?? r.type ?? '';
    const entry = {
      IPO: r.IPO ?? r.Ipo ?? r['IPO Name'] ?? '',
      GMP_raw: gmpRaw,
      Kostak: r.Kostak ?? r.kostak ?? r['IPO Price'] ?? '',
      Date: dateRaw,
      SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? '',
      Type: typeRaw,
      status: statusFromSheet
    };
    // compute status from Date if sheet status empty or if you prefer date overrides:
    const computed = determineStatus(entry.Date);
    // Use computed status unless sheet explicitly had a status different than empty? 
    // Here we prefer computed status (so date drives status). If you want sheet override, change this.
    entry.status = computed;
    return entry;
  });

  // optional: you can dedupe or sort - here we'll keep order and then sort by status groups
  const groups = { active: [], upcoming: [], closed: [] };
  for (const item of norm) {
    if (item.status === 'active') groups.active.push(item);
    else if (item.status === 'upcoming') groups.upcoming.push(item);
    else groups.closed.push(item);
  }

  // simple sorting by GMP numeric desc for active
  const sortFn = (a,b) => {
    const na = parseGmpNumber(a.GMP_raw);
    const nb = parseGmpNumber(b.GMP_raw);
    if (isNaN(na) && isNaN(nb)) return (a.IPO||'').localeCompare(b.IPO||'');
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return nb - na;
  };
  groups.active.sort(sortFn);
  groups.upcoming.sort(sortFn);
  groups.closed.sort(sortFn);

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

  await backupExistingGmp();
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

  // inject into index.html safely
  let html = await fs.readFile('index.html', 'utf8');
  html = html.replace(/<div id="gmp-wrapper">[\s\S]*?<\/div>\s*/g, '');
  if (html.indexOf('<!-- GMP_TABLE -->') === -1) {
    console.warn('Placeholder <!-- GMP_TABLE --> not found — appending wrapper before </body>.');
    html = html.replace('</body>', `\n${wrapperHtml}\n</body>`);
  } else {
    html = html.replace('<!-- GMP_TABLE -->', wrapperHtml);
  }
  await fs.writeFile('index.html', html, 'utf8');
  console.log('Generated _gmp.html and injected into index.html');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
