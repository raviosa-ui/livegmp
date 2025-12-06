// scripts/update_gmp.js - 100% HTML-ONLY VERSION (No templates, no Markdown risk)
// Kostak → IPO Price | Subject to Sauda → Listing Gain | Debug logs

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const Papa = require('papaparse');

const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('❌ Missing GMP_SHEET_CSV_URL - set it (e.g., export GMP_SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/YOUR_ID/export?format=csv")');
  process.exit(2);
}

const BACKUP_DIR = 'backups';
const BACKUP_KEEP = 30;
const MAX_PER_GROUP = 10;

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function backupExistingGmp() {
  try {
    const current = await fs.readFile('_gmp.html', 'utf8');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-');
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const fname = path.join(BACKUP_DIR, `gmp-${ts}.html`);
    await fs.writeFile(fname, current, 'utf8');
    console.log('✅ Backup: ' + fname);
  } catch (err) {
    console.log('ℹ️ First run - no backup needed');
  }
}

function parseGmpNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim().replace(/[,₹\s]/g, '').replace(/[^\d\.\-\+]/g, '').trim();
  if (!s || s === '-' || s === '+') return NaN;
  return Number(s);
}

function gmpLabelAndClass(raw) {
  const n = parseGmpNumber(raw);
  if (!isNaN(n)) {
    if (n > 0) return { label: '▲ ' + n, cls: 'gmp-up' };
    if (n < 0) return { label: '▼ ' + Math.abs(n), cls: 'gmp-down' };
    return { label: '' + n, cls: 'gmp-neutral' };
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

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function tryParseDayMonthYear(token, defaultYear) {
  token = token.trim().replace(/\./g, '');
  const dashMatch = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (dashMatch) return new Date(Number(dashMatch[3] || defaultYear), Number(dashMatch[2]) - 1, Number(dashMatch[1]));
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

function buildCardsHtml(rows) {
  let html = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const g = gmpLabelAndClass(r.GMP_raw);
    const dateText = esc(r.Date || '');
    const ipoPrice = esc(r.Kostak || '');
    const listingGain = esc(r.SubjectToSauda || '');
    const type = esc(r.Type || '');
    const status = r.status;
    const ipoSlug = slugify(r.IPO);
    const ipoUrl = '/ipo/' + ipoSlug;
    const ipoTitle = esc(r.IPO);
    const statusCap = status.charAt(0).toUpperCase() + status.slice(1);

    html += '<div class="ipo-card" data-status="' + status + '">';
    html += '  <div class="card-grid">';
    html += '    <div class="col col-name">';
    html += '      <div class="ipo-title">' + ipoTitle + '</div>';
    html += '      <div class="gmp-row">';
    html += '        <span class="gmp-label meta-label">GMP</span>';
    html += '        <span class="meta-value gmp-value ' + g.cls + '">' + g.label + '</span>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="col col-status">';
    html += '      <span class="badge ' + status + '">' + statusCap + '</span>';
    html += '    </div>';
    html += '    <div class="col col-meta">';
    html += '      <div class="meta-item-inline">';
    html += '        <span class="meta-label">Date</span>';
    html += '        <span class="meta-value">' + (dateText || '—') + '</span>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="col col-link">';
    html += '      <a class="ipo-link" href="' + ipoUrl + '" rel="noopener" title="Open ' + ipoTitle + ' page">View</a>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="card-row-details" aria-hidden="true">';
    html += '    <div><strong>IPO Price:</strong> ' + (ipoPrice ? (ipoPrice.startsWith('₹') ? ipoPrice : '₹' + ipoPrice) : '—') + '</div>';
    html += '    <div style="margin-top:6px;"><strong>Listing Gain:</strong> ' + (listingGain ? listingGain + '%' : '—') + '</div>';
    html += '    <div style="margin-top:6px;"><strong>Type:</strong> ' + (type || '—') + '</div>';
    html += '  </div>';
    html += '</div>\n';
  }
  return html;
}

async function main() {
  console.log('🚀 Starting GMP update...');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('❌ CSV fetch failed (' + res.status + ') - Verify your Google Sheet export URL');
  const csv = await res.text();
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rowsRaw = parsed.data || [];
  console.log('📊 Fetched ' + rowsRaw.length + ' rows from sheet');

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
  }).filter(r => r.IPO);

  console.log('✅ Processed ' + norm.length + ' IPOs');

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

  console.log('📂 Groups - Active: ' + groups.active.length + ', Upcoming: ' + groups.upcoming.length + ', Closed: ' + groups.closed.length);

  const now = new Date();
  const tsLocal = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

  let content = '<div id="gmp-controls" class="sticky-filters">';
  content += '  <button class="filter-btn active" data-filter="all">All</button>';
  content += '  <button class="filter-btn" data-filter="active">Active</button>';
  content += '  <button class="filter-btn" data-filter="upcoming">Upcoming</button>';
  content += '  <button class="filter-btn" data-filter="closed">Closed</button>';
  content += '</div>';
  content += '<div class="gmp-meta-line">';
  content += '  <div class="updated">Last updated: <strong id="gmp-last-updated">' + esc(tsLocal) + '</strong></div>';
  content += '  <div class="next-run">Next run: <span id="gmp-next-run">calculating...</span></div>';
  content += '</div>';
  content += '<div id="gmp-cards">';

  if (groups.active.length > 0) {
    content += '  <h3 class="section-heading">Active IPOs</h3>' + buildCardsHtml(groups.active);
  }
  if (groups.upcoming.length > 0) {
    content += '  <h3 class="section-heading">Upcoming IPOs</h3>' + buildCardsHtml(groups.upcoming);
  }
  if (groups.closed.length > 0) {
    content += '  <h3 class="section-heading">Closed / Listed</h3>' + buildCardsHtml(groups.closed);
  }

  content += '</div>';
  content += '<div id="load-more-wrap" style="text-align:center;margin-top:12px;"><button id="load-more-btn" class="load-more-btn">Load more</button></div>';

  const wrapperHtml = '<div id="gmp-wrapper">' + content + '<div style="display:none" id="gmp-meta" data-updated="' + now.toISOString() + '"></div></div>';

  await backupExistingGmp();
  await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');
  console.log('💾 _gmp.html saved - Open it to verify HTML (search for "ipo-card")');

  let html = await fs.readFile('index.html', 'utf8');

  // Ultra-aggressive cleanup
  const placeholder = '<!-- === DO NOT REMOVE === -->';
  html = html.replace(new RegExp(placeholder + '[\\s\\S]*?(?=' + placeholder + '|$)', 'g'), placeholder);
  html = html.replace(/<div id="gmp-wrapper">[\s\S]*?<\/div>/gi, '');
  html = html.replace(/###[\s\S]*?(?=###|$)/gi, '');  // Markdown headers
  html = html.replace(/\*\*[\s\S]*?\*\*/gi, '');  // Bold Markdown

  console.log('🧹 Old content nuked');

  if (html.includes(placeholder)) {
    html = html.replace(placeholder, placeholder + '\n' + wrapperHtml);
    console.log('✅ Injected at placeholder');
  } else {
    html = html.replace('</body>', wrapperHtml + '\n</body>');
    console.log('⚠️ Placeholder missing - appended to body');
  }

  await fs.writeFile('index.html', html, 'utf8');
  console.log('🎉 Done! Upload index.html, hard refresh site. Check browser console for "GMP JS initialized".');
}

main().catch(err => {
  console.error('💥 Error: ' + err.message);
  process.exit(1);
});
