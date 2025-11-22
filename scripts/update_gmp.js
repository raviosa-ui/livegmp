// scripts/update_gmp.js
// Node.js (CommonJS). Requires node-fetch@2 and papaparse
// Purpose: read CSV (from sheet), build GMP HTML block, overwrite injected block
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
const MAX_PER_SECTION = 10; // <= 10 entries per Active/Upcoming/Closed

function esc(s = '') {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch(e){ /* ignore */ }
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
  const normalized = s.replace(/,/g, '').replace(/[^\d\.\-\+]/g, '').trim();
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
  return { label: esc(raw || ''), cls: 'gmp-neutral' };
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

function buildCardHtml(r) {
  const g = gmpLabelAndClass(r.GMP_raw);
  const dateText = esc(r.Date || '');
  const kostak = esc(r.Kostak || '');
  const subj = esc(r.SubjectToSauda || '');
  const type = esc(r.Type || '');
  const status = r.status || 'active';
  const ipoSlug = slugify(r.IPO || '');
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
}

function buildSectionHtml(title, rows) {
  if (!rows || rows.length === 0) return '';
  const limited = rows.slice(0, MAX_PER_SECTION);
  return `
  <h3 class="section-heading">${esc(title)}</h3>
  ${limited.map(r => buildCardHtml(r)).join('\n')}
  `;
}

async function main() {
  try {
    console.log('Fetching CSV:', CSV_URL);
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
    const csv = await res.text();
    const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const rowsRaw = parsed.data || [];

    // normalize rows
    const norm = rowsRaw.map(r => {
      const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
      const statusRaw = r.Status ?? r.status ?? r.Stage ?? r.StageName ?? '';
      const status = normalizeStatus(statusRaw);
      return {
        IPO: (r.IPO ?? r.Ipo ?? r['IPO Name'] ?? r['Name'] ?? '').toString().trim(),
        GMP_raw: gmpRaw,
        Kostak: r.Kostak ?? r.kostak ?? r['IPO Price'] ?? r.Price ?? '',
        Date: r.Date ?? r.date ?? r['Listing Date'] ?? r['Date'] ?? '',
        SubjectToSauda: r.SubjectToSauda ?? r['SubjectToSauda'] ?? r.Sauda ?? r['Listing Gain'] ?? '',
        Type: r.Type ?? r.type ?? '',
        status
      };
    }).filter(x => x.IPO && x.IPO.trim().length > 0);

    // group by status
    const groups = { active: [], upcoming: [], closed: [] };
    for (const item of norm) {
      groups[item.status] = groups[item.status] || [];
      groups[item.status].push(item);
    }

    // Sort active by numeric GMP desc (fallback alphabetical)
    function sortFn(a,b) {
      const an = parseGmpNumber(a.GMP_raw);
      const bn = parseGmpNumber(b.GMP_raw);
      if (isNaN(an) && isNaN(bn)) return (a.IPO||'').localeCompare(b.IPO||'');
      if (isNaN(an)) return 1;
      if (isNaN(bn)) return -1;
      return bn - an;
    }
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

    content += buildSectionHtml('Active IPOs', groups.active);
    content += buildSectionHtml('Upcoming IPOs', groups.upcoming);
    content += buildSectionHtml('Closed / Listed', groups.closed);

    content += `</div>\n<div id="load-more-wrap" style="text-align:center;margin-top:12px;"><button id="load-more-btn" class="load-more-btn">Load more</button></div>`;

    const wrapperHtml = `
<!-- GMP_TABLE_START -->
<div id="gmp-wrapper">
  ${content}
  <div style="display:none" id="gmp-meta" data-updated="${now.toISOString()}"></div>
</div>
<!-- GMP_TABLE_END -->
`;

    // backup
    await backupExistingGmp();

    // write partial
    await fs.writeFile('_gmp.html', wrapperHtml, 'utf8');

    // read index.html
    let html = await fs.readFile('index.html', 'utf8');

    // remove prior injected blocks that match our markers (global)
    html = html.replace(/<!-- GMP_TABLE_START -->[\s\S]*?<!-- GMP_TABLE_END -->/g, '');

    // Insert new block at placeholder or before </body>
    if (html.indexOf('<!-- GMP_TABLE -->') !== -1) {
      html = html.replace('<!-- GMP_TABLE -->', wrapperHtml);
    } else {
      // try to avoid duplicating by placing before body close
      if (html.includes('</body>')) {
        html = html.replace('</body>', wrapperHtml + '\n</body>');
      } else {
        html += '\n' + wrapperHtml;
      }
    }

    // Normalize: remove excessive blank lines
    html = html.replace(/\n{3,}/g, '\n\n');

    // Write updated index.html
    await fs.writeFile('index.html', html, 'utf8');

    console.log('Generated _gmp.html and injected into index.html');
  } catch (err) {
    console.error('ERROR in update_gmp.js:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
