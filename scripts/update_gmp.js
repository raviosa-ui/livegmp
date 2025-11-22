// scripts/update_gmp.js
// Updated: stable injection, remove old blocks, limit 10 per section, date-based status

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const Papa = require('papaparse');

// Read CSV url from env
const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('Missing GMP_SHEET_CSV_URL env var');
  process.exit(2);
}

const BACKUP_DIR = 'backups';
const BACKUP_KEEP = 30;
const MAX_PER_SECTION = 10; // cap per active/upcoming/closed

function esc(s='') {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch(e){ }
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

// Try best-effort parse of date-range strings like:
// "14-18 Nov", "21 Nov 2025", "TBA", "2025"
// Returns 'upcoming' | 'active' | 'closed' based on now
function statusFromDateString(dateStr) {
  if (!dateStr) return 'upcoming';
  const s = String(dateStr).trim();
  if (!s) return 'upcoming';
  const L = s.toLowerCase();
  const now = new Date();
  // common TBA or unknown
  if (L.includes('tba') || L.includes('to be announced') || L.includes('not announced')) return 'upcoming';

  // If it's just a year (e.g., "2025"), treat as active (you can tweak)
  if (/^\d{4}$/.test(L)) {
    // if year same as now and no other info, active
    return (parseInt(L,10) >= now.getFullYear()) ? 'active' : 'closed';
  }

  // pattern: 14-18 Nov [2025?] or 14 Nov - 18 Nov 2025 or 14 Nov 2025
  // We'll try several regexes
  const monthNames = {
    jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11
  };

  // Normalize separators
  const cleaned = s.replace(/\u2013|\u2014/g,'-').replace(/\s+to\s+/i,'-').replace(/\s*-\s*/g,'-');

  // try "DD-MMM-YYYY" or "DD-MMM" or "DD-MMM-YYYY"
  // examples: 14-Nov-2025 or 14-Nov
  // also "14-18 Nov" => start=14 Nov, end=18 Nov
  const rangeMatch = cleaned.match(/^(\d{1,2})(?:\s*(?:[^\d\s]+)?)-(\d{1,2})\s*([A-Za-z]{3,9})(?:\s+(\d{4}))?$/);
  if (rangeMatch) {
    const sDay = parseInt(rangeMatch[1],10);
    const eDay = parseInt(rangeMatch[2],10);
    const mon = rangeMatch[3].slice(0,3).toLowerCase();
    const year = rangeMatch[4] ? parseInt(rangeMatch[4],10) : now.getFullYear();
    const mIdx = monthNames[mon] ?? now.getMonth();
    const start = new Date(year, mIdx, sDay, 0,0,0);
    const end = new Date(year, mIdx, eDay, 23,59,59);
    if (now < start) return 'upcoming';
    if (now >= start && now <= end) return 'active';
    return 'closed';
  }

  // try "DD MMM YYYY" or "DD MMM" or "14 Nov 2025"
  const singleMatch = cleaned.match(/^(\d{1,2})\s*([A-Za-z]{3,9})(?:\s+(\d{4}))?$/);
  if (singleMatch) {
    const day = parseInt(singleMatch[1],10);
    const mon = singleMatch[2].slice(0,3).toLowerCase();
    const year = singleMatch[3] ? parseInt(singleMatch[3],10) : now.getFullYear();
    const mIdx = monthNames[mon] ?? now.getMonth();
    const start = new Date(year, mIdx, day, 0,0,0);
    const end = new Date(year, mIdx, day, 23,59,59);
    if (now < start) return 'upcoming';
    if (now >= start && now <= end) return 'active';
    return 'closed';
  }

  // try "DD-DD MMM" e.g., 14-18 Nov (case where month after second)
  const range2 = cleaned.match(/^(\d{1,2})-(\d{1,2})\s*([A-Za-z]{3,9})(?:\s+(\d{4}))?$/);
  if (range2) {
    const sd = parseInt(range2[1],10);
    const ed = parseInt(range2[2],10);
    const mon = range2[3].slice(0,3).toLowerCase();
    const year = range2[4] ? parseInt(range2[4],10) : now.getFullYear();
    const mIdx = monthNames[mon] ?? now.getMonth();
    const start = new Date(year, mIdx, sd, 0,0,0);
    const end = new Date(year, mIdx, ed, 23,59,59);
    if (now < start) return 'upcoming';
    if (now >= start && now <= end) return 'active';
    return 'closed';
  }

  // fallback: if contains month name and year, try parse
  try {
    const p = Date.parse(s);
    if (!isNaN(p)) {
      const target = new Date(p);
      if (now < target) return 'upcoming';
      if (now.toDateString() === target.toDateString()) return 'active';
      return (now > target) ? 'closed' : 'upcoming';
    }
  } catch(e) { }

  // if nothing parseable, treat as upcoming
  return 'upcoming';
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

    return `  <div class="ipo-card" data-status="${status}">
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
          <span class="meta-label">DATE</span>
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
  </div>`;
  }).join('\n');
}

async function main() {
  try {
    console.log('Fetching CSV:', CSV_URL);
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
    const csv = await res.text();
    const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const rowsRaw = parsed.data || [];

    // normalize fields and apply status derived from Date column when missing
    const norm = rowsRaw.map(r => {
      const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
      const dateRaw = (r.Date ?? r.date ?? r['Listing Date'] ?? '').toString().trim();
      const inferredStatus = statusFromDateString(dateRaw);
      const statusRaw = r.Status ?? r.status ?? r.Stage ?? '';
      const status = (statusRaw && statusRaw.toString().trim() !== '') ? normalizeStatus(statusRaw) : inferredStatus;
      return {
        IPO: r.IPO ?? r.Ipo ?? r['IPO Name'] ?? '',
        GMP_raw: gmpRaw,
        Kostak: r.Kostak ?? r.kostak ?? '',
        Date: dateRaw,
        SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? '',
        Type: r.Type ?? r.type ?? '',
        status
      };
    });

    // Group items
    const groups = { active: [], upcoming: [], closed: [] };
    for (const item of norm) {
      if (!item.IPO || item.IPO.toString().trim() === '') continue;
      groups[item.status || 'active'].push(item);
    }

    // sort each group: numeric GMP desc (present), otherwise alphabetic
    function sortFn(a,b){
      const an = parseGmpNumber(a.GMP_raw);
      const bn = parseGmpNumber(b.GMP_raw);
      if (!isNaN(an) && !isNaN(bn)) return bn - an;
      if (!isNaN(an) && isNaN(bn)) return -1;
      if (isNaN(an) && !isNaN(bn)) return 1;
      return (a.IPO||'').localeCompare(b.IPO||'');
    }

    groups.active.sort(sortFn);
    groups.upcoming.sort(sortFn);
    groups.closed.sort(sortFn);

    // limit to top N per group
    groups.active = groups.active.slice(0, MAX_PER_SECTION);
    groups.upcoming = groups.upcoming.slice(0, MAX_PER_SECTION);
    groups.closed = groups.closed.slice(0, MAX_PER_SECTION);

    // render HTML
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

    // wrap with START/END markers so replacement is reliable
    const wrapperHtml = `
<!-- GMP_TABLE_START -->
<div id="gmp-wrapper">
${content}
  <div style="display:none" id="gmp-meta" data-updated="${now.toISOString()}"></div>
</div>
<!-- GMP_TABLE_END -->
`;

    // backup and write
    await backupExistingGmp();
    await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

    // inject into index.html safely:
    let html = await fs.readFile('index.html', 'utf8');

    // Remove any previous GMP blocks between markers (global)
    html = html.replace(/<!--\s*GMP_TABLE_START\s*-->[\s\S]*?<!--\s*GMP_TABLE_END\s*-->/g, '');

    // If placeholder exists, replace it; otherwise append before </body>
    if (html.indexOf('<!-- GMP_TABLE -->') !== -1) {
      html = html.replace('<!-- GMP_TABLE -->', wrapperHtml);
    } else {
      // append before </body> if present, otherwise append at end
      if (html.indexOf('</body>') !== -1) {
        html = html.replace('</body>', `\n${wrapperHtml}\n</body>`);
      } else {
        html = html + '\n' + wrapperHtml;
      }
    }

    await fs.writeFile('index.html', html, 'utf8');
    console.log('Generated _gmp.html and injected into index.html — Done.');
  } catch (err) {
    console.error('ERROR:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
