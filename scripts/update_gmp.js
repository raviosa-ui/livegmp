// CommonJS - Node 18
const fs = require('fs').promises;
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

// Try to extract a numeric value from a string like "+20", "20", "↓15", "15%", "—"
function parseGmpNumber(raw) {
  if (raw === undefined || raw === null) return NaN;
  const s = String(raw).trim();
  // Replace comma thousands, percent signs, arrows, etc.
  const normalized = s.replace(/,/g,'').replace(/[%↑↓▲▼–——]/g,'').replace(/[^\d\.\-\+]/g,'').trim();
  if (normalized === '' || normalized === '-' || normalized === '+') return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function gmpLabelAndClass(raw) {
  const n = parseGmpNumber(raw);
  if (!isNaN(n)) {
    if (n > 0) return { label: `↑ ${n}`, cls: 'gmp-up' };
    if (n < 0) return { label: `↓ ${Math.abs(n)}`, cls: 'gmp-down' };
    return { label: `${n}`, cls: 'gmp-neutral' };
  }
  // fallback: non-numeric raw value - show as-is and neutral
  return { label: esc(raw), cls: 'gmp-neutral' };
}

async function main(){
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();

  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];

  // Normalize rows and compute numeric GMP for sorting
  const norm = rows.map(r => {
    const gmpRaw = r.GMP ?? r.Gmp ?? r.gmp ?? '';
    const gmpNum = parseGmpNumber(gmpRaw);
    return {
      IPO: r.IPO ?? '',
      GMP_raw: gmpRaw,
      GMP_num: isNaN(gmpNum) ? null : gmpNum,
      Kostak: r.Kostak ?? '',
      SubjectToSauda: r.SubjectToSauda ?? (r['SubjectToSauda'] ?? '')
    };
  });

  // Sort: numeric GMP desc first, then IPO alphabetically
  norm.sort((a,b) => {
    if (a.GMP_num === null && b.GMP_num === null) return (a.IPO||'').localeCompare(b.IPO||'');
    if (a.GMP_num === null) return 1;
    if (b.GMP_num === null) return -1;
    return b.GMP_num - a.GMP_num;
  });

  const rowsHtml = norm.map(r => {
    const g = gmpLabelAndClass(r.GMP_raw);
    return `<tr>
      <td class="col-ipo">${esc(r.IPO)}</td>
      <td class="col-gmp ${g.cls}">${esc(g.label)}</td>
      <td class="col-kostak">${esc(r.Kostak)}</td>
      <td class="col-ssa">${esc(r.SubjectToSauda)}</td>
    </tr>`;
  }).join('\n');

  const now = new Date();
  const nowIso = now.toISOString();
  const ts = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });

  const tableHtml = `
  <div id="gmp-wrapper">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
      <div style="font-size:13px;color:#555">Last updated: <strong id="gmp-last-updated">${esc(ts)}</strong></div>
      <div style="font-size:13px;color:#555">Next run: <span id="gmp-next-run">calculating...</span></div>
    </div>

    <div class="gmp-table-wrap">
      <table id="gmp-table" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f6f6f6;">
            <th data-sort="ipo" style="padding:10px;border:1px solid #e6e6e6;cursor:pointer">IPO ▴▾</th>
            <th data-sort="gmp" style="padding:10px;border:1px solid #e6e6e6;cursor:pointer">GMP ▴▾</th>
            <th data-sort="kostak" style="padding:10px;border:1px solid #e6e6e6;cursor:pointer">Kostak</th>
            <th style="padding:10px;border:1px solid #e6e6e6">Subject to Sauda</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <!-- meta for automation -->
    <div style="display:none" id="gmp-meta" data-updated="${nowIso}"></div>
  </div>
  `;

  // Option A: write partial _gmp.html and inject into index.html placeholder
  await fs.writeFile('_gmp.html', tableHtml, 'utf8');

  let html = await fs.readFile('index.html', 'utf8');
  if (html.indexOf('<!-- GMP_TABLE -->') === -1) {
    console.warn('Placeholder <!-- GMP_TABLE --> not found in index.html — appending to body end.');
    html = html.replace('</body>', `\n${tableHtml}\n</body>`);
  } else {
    html = html.replace('<!-- GMP_TABLE -->', tableHtml);
  }
  await fs.writeFile('index.html', html, 'utf8');

  console.log('Wrote _gmp.html and updated index.html (if placeholder present).');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
