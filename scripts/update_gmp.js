// scripts/update_gmp.js - BULLETPROOF HTML VERSION (No Markdown, Aggressive Cleanup)
// Debug: Logs everything. Kostak → IPO Price | Subject to Sauda → Listing Gain

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const Papa = require('papaparse');

const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('❌ Missing GMP_SHEET_CSV_URL env var - set it and re-run!');
  process.exit(2);
}

const BACKUP_DIR = 'backups';
const BACKUP_KEEP = 30;
const MAX_PER_GROUP = 10;
const SHOW_BATCH = 7;  // For lazy load

// HTML Escaper - Bulletproof
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Backup function (unchanged)
async function backupExistingGmp() {
  try {
    const current = await fs.readFile('_gmp.html', 'utf8');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const fname = path.join(BACKUP_DIR, `gmp-${ts}.html`);
    await fs.writeFile(fname, current, 'utf8');
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('gmp-') && f.endsWith('.html')).sort();
    if (backups.length > BACKUP_KEEP) {
      const remove = backups.slice(0, backups.length - BACKUP_KEEP);
      await Promise.all(remove.map(f => fs.unlink(path.join(BACKUP_DIR, f))));
    }
    console.log(`✅ Backup saved: ${fname}`);
  } catch (err) {
    console.log('ℹ️ No existing _gmp.html (first run OK)');
  }
}

// GMP Parser (unchanged)
function parseGmpNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  const normalized = s.replace(/[,₹\s]/g, '').replace(/[^\d\.\-\+]/g, '').trim();
  if (!normalized || normalized === '-' || normalized === '+') return NaN;
  return Number(normalized);
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

// Status & Date Parsers (unchanged - working)
function normalizeStatus(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toLowerCase();
  if (s.includes('upcom')) return 'upcoming';
  if (s.includes('clos') || s.includes('list')) return 'closed';
  if (s.includes('active') || s.includes('open')) return 'active';
  return '';
}

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function tryParseDayMonthYear(token, defaultYear) {
  token = token.trim().replace(/\./g, '');
  const dashMatch = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (dashMatch) {
    return new Date(Number(dashMatch[3] || defaultYear), Number(dashMatch[2]) - 1, Number(dashMatch[1]));
  }
  const nameMatch = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (nameMatch) {
    const m = MONTHS[nameMatch[2].slice(0,3).toLowerCase()];
    if (m !== undefined) return new Date(Number(nameMatch[3] || defaultYear), m, Number(nameMatch[1]));
  }
  const dayOnly = token.match(/^(\d{1,2})$/);
  if (dayOnly) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), Number(dayOnly[1]));
  }
  return null;
}

function parseDateRange(text) {
  if (!text) return { start: null, end: null };
  const raw = String(text).trim();
  if (/tba|to be announced|n\/a/i.test(raw)) return { start: null, end: null };
  const norm = raw.replace(/\u2013|\u2014|–/g, '-').replace(/\s+to\s+/i, '-').replace(/\s*-\s*/g, '-');
  const commaParts = norm.split(',');
  let main = commaParts[0].trim();
  let year = commaParts[1] && /^\s*\d{4}\s*$/.test(commaParts[1]) ? Number(commaParts[1].trim()) : new Date().getFullYear();
  if (main.includes('-')) {
    const parts = main.split('-').map(p => p.trim());
    const start = tryParseDayMonthYear(parts[0], year);
    const end = tryParseDayMonthYear(parts.slice(1).join('-'), year);
    return { start, end: end || start };
  }
  const single = tryParseDayMonthYear(main, year);
  return { start: single, end: single };
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
  return String(name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/\-+/g, '-').replace(/^\-+|-+$/g, '');
}

// BULLETPROOF HTML BUILDER - Concatenates strings, no templates
function buildCardsHtml(rows) {
  let html = '';
  for (const r of rows) {
    const g = gmpLabelAndClass(r.GMP_raw);
    const dateText = esc(r.Date || '');
    const ipoPrice = esc(r.Kostak || '');
    const listingGain = esc(r.SubjectToSauda || '');
    const type = esc(r.Type || '');
    const status = r.status;
    const ipoSlug = slugify(r.IPO);
    const ipoUrl = '/ipo/' + ipoSlug;
    const ipoTitle = esc(r.IPO);

    html += '<div class="ipo-card" data-status="' + status + '">\n';
    html += '  <div class="card-grid">\n';
    html += '    <div class="col col-name">\n';
    html += '      <div class="ipo-title">' + ipoTitle + '</div>\n';
    html += '      <div class="gmp-row">\n';
    html += '        <span class="gmp-label meta-label">GMP</span>\n';
    html += '        <span class="meta-value gmp-value ' + g.cls + '">' + g.label + '</span>\n';
    html += '      </div>\n';
    html += '    </div>\n';
    html += '    <div class="col col-status">\n';
    html += '      <span class="badge ' + status + '">' + status.charAt(0).toUpperCase() + status.slice(1) + '</span>\n';
    html += '    </div>\n';
    html += '    <div class="col col-meta">\n';
    html += '      <div class="meta-item-inline">\n';
    html += '        <span class="meta-label">Date</span>\n';
    html += '        <span class="meta-value">' + (dateText || '—') + '</span>\n';
    html += '      </div>\n';
    html += '    </div>\n';
    html += '    <div class="col col-link">\n';
    html += '      <a class="ipo-link" href="' + ipoUrl + '" rel="noopener" title="Open ' + ipoTitle + ' page">View</a>\n';
    html += '    </div>\n';
    html += '  </div>\n';
    html += '  <div class="card-row-details" aria-hidden="true">\n';
    html += '    <div><strong>IPO Price:</strong> ' + (ipoPrice ? (ipoPrice.startsWith('₹') ? ipoPrice : '₹' + ipoPrice) : '—') + '</div>\n';
    html += '    <div style="margin-top:6px;"><strong>Listing Gain:</strong> ' + (listingGain ? listingGain + '%' : '—') + '</div>\n';
    html += '    <div style="margin-top:6px;"><strong>Type:</strong> ' + (type || '—') + '</div>\n';
    html += '  </div>\n';
    html += '</div>\n';
  }
  return html;
}

async function main() {
  console.log('🚀 Fetching GMP data from Google Sheet...');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('❌ CSV fetch failed: ' + res.status + ' - Check your SHEET URL env var!');
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];
  console.log(`📊 Raw rows from sheet: ${rowsRaw.length}`);

  const norm = rowsRaw.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? r['GMP_raw'] ?? '';
    const dateRaw = r.Date ?? r.date ?? r['Listing Date'] ?? '';
    const ipoPriceRaw = r.Kostak ?? r.kostak ?? r['IPO Price'] ?? '';
    const gainRaw = r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? r['Listing Gain'] ?? '';
    const typeRaw = r.Type ?? r.type ?? '';

    let statusFromCsv = normalizeStatus(r.Status ?? r.status ?? r.Stage ?? '');
    let computedStatus = computeStatusFromDateText(String(dateRaw).trim());
    const status = statusFromCsv || computedStatus || 'upcoming';

    const gmpNum = parseGmpNumber(gmpRaw);

    return {
      IPO: (r.IPO ?? r.Ipo ?? r['IPO Name'] ?? r['Name'] ?? '').trim(),
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: ipoPriceRaw,
      SubjectToSauda: gainRaw,
      Date: String(dateRaw),
      Type: String(typeRaw),
      status
    };
  }).filter(r => r.IPO);  // Skip empties

  console.log(`✅ Processed ${norm.length} valid IPO rows`);

  // Group & Sort
  const groups = { active: [], upcoming: [], closed: [] };
  norm.forEach(item => groups[item.status].push(item));

  const sortByGmp = (a, b) => {
    const ga = a.GMP_num ?? -Infinity;
    const gb = b.GMP_num ?? -Infinity;
    return gb - ga || a.IPO.localeCompare(b.IPO);
  };
  ['active', 'upcoming', 'closed'].forEach(key => {
    groups[key].sort(sortByGmp);
    groups[key] = groups[key].slice(0, MAX_PER_GROUP);
  });

  console.log(`📂 Groups: Active=${groups.active.length}, Upcoming=${groups.upcoming.length}, Closed=${groups.closed.length}`);

  const now = new Date();
  const tsLocal = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

  // Build Content - PURE HTML STRING CONCAT
  let content = '<div id="gmp-controls" class="sticky-filters">\n';
  content += '  <button class="filter-btn active" data-filter="all">All</button>\n';
  content += '  <button class="filter-btn" data-filter="active">Active</button>\n';
  content += '  <button class="filter-btn" data-filter="upcoming">Upcoming</button>\n';
  content += '  <button class="filter-btn" data-filter="closed">Closed</button>\n';
  content += '</div>\n\n';

  content += '<div class="gmp-meta-line">\n';
  content += '  <div class="updated">Last updated: <strong id="gmp-last-updated">' + esc(tsLocal) + '</strong></div>\n';
  content += '  <div class="next-run">Next run: <span id="gmp-next-run">calculating...</span></div>\n';
  content += '</div>\n\n';

  content += '<div id="gmp-cards">\n';

  if (groups.active.length > 0) {
    content += '  <h3 class="section-heading">Active IPOs</h3>\n';
    content += buildCardsHtml(groups.active) + '\n';
  }
  if (groups.upcoming.length > 0) {
    content += '  <h3 class="section-heading">Upcoming IPOs</h3>\n';
    content += buildCardsHtml(groups.upcoming) + '\n';
  }
  if (groups.closed.length > 0) {
    content += '  <h3 class="section-heading">Closed / Listed</h3>\n';
    content += buildCardsHtml(groups.closed) + '\n';
  }

  content += '</div>\n';
  content += '<div id="load-more-wrap" style="text-align:center;margin-top:12px;"><button id="load-more-btn" class="load-more-btn">Load more</button></div>\n';

  const wrapperHtml = '<div id="gmp-wrapper">\n' + content + '\n  <div style="display:none" id="gmp-meta" data-updated="' + now.toISOString() + '"></div>\n</div>';

  // Save Partial (DEBUG: Open this file to verify HTML!)
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');
  console.log('💾 Partial saved to _gmp.html - OPEN IT NOW to check for <div class="ipo-card"> (not ### or **)!');

  // Backup
  await backupExistingGmp();

  // Read & Clean index.html AGGRESSIVELY
  let html = await fs.readFile('index.html', 'utf8');

  // Nuke ALL old GMP junk (Markdown OR HTML)
  html = html.replace(/<!-- === DO NOT REMOVE === -->[\s\S]*?(?=<!-- === DO NOT REMOVE === -->|$)/g, '<!-- === DO NOT REMOVE === -->');
  html = html.replace(/<div id="gmp-wrapper">[\s\S]*?<\/div>/gi, '');
  html = html.replace(/###[\s\S]*?Active IPOs|Upcoming IPOs|Closed[\s\S]*?(?=\n\n\n|$)/gi, '');  // Markdown cleanup

  console.log('🧹 Cleaned old content from index.html');

  // Inject
  const placeholder = '<!-- === DO NOT REMOVE === -->';
  if (html.includes(placeholder)) {
    html = html.replace(placeholder, placeholder + '\n' + wrapperHtml);
    console.log('✅ Injected into placeholder');
  } else {
    console.error('❌ Placeholder NOT FOUND - Check your index.html has <!-- === DO NOT REMOVE === -->');
    html = html.replace('</body>', wrapperHtml + '\n</body>');
  }

  await fs.writeFile('index.html', html, 'utf8');
  console.log('🎉 index.html updated! UPLOAD TO SERVER, hard refresh (Ctrl+Shift+R), open console for "GMP JS initialized". Reply with terminal logs if issues.');
}

main().catch(err => {
  console.error('💥 FATAL ERROR:', err.message);
  process.exit(1);
});
