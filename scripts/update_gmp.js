// scripts/update_gmp.js (CommonJS version)
const fs = require('fs').promises;
const fetch = require('node-fetch');
const parse = require('csv-parse/lib/sync');

const CSV_URL = process.env.GMP_SHEET_CSV_URL;
if (!CSV_URL) {
  console.error('Missing GMP_SHEET_CSV_URL env var');
  process.exit(2);
}

function esc(s='') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function main(){
  console.log('Fetching CSV:', CSV_URL);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('Failed to fetch CSV: ' + res.status);
  const csv = await res.text();

  const rows = parse(csv, { columns: true, skip_empty_lines: true });

  // Build table HTML
  const rowsHtml = rows.map(function(r) {
    const ipo = esc(r['IPO'] || r['ipo'] || '');
    const gmp = esc(r['GMP'] || r['gmp'] || '');
    const kostak = esc(r['Kostak'] || r['kostak'] || '');
    const sauda = esc(r['SubjectToSauda'] || r['Subject to Sauda'] || r['subject'] || '');
    return '<tr>' +
      '<td>' + ipo + '</td>' +
      '<td>' + gmp + '</td>' +
      '<td>' + kostak + '</td>' +
      '<td>' + sauda + '</td>' +
    '</tr>';
  }).join('\n');

  const tableHtml = [
    '<table style="width:100%;border-collapse:collapse;">',
    '<thead><tr style="background:#efefef;"><th style="padding:10px;border:1px solid #ddd">IPO</th><th style="padding:10px;border:1px solid #ddd">GMP</th><th style="padding:10px;border:1px solid #ddd">Kostak</th><th style="padding:10px;border:1px solid #ddd">Subject to Sauda</th></tr></thead>',
    '<tbody>',
    rowsHtml,
    '</tbody>',
    '</table>'
  ].join('\n');

  // Read index.html and replace placeholder
  const indexPath = 'index.html';
  let html = await fs.readFile(indexPath, 'utf8');

  if (html.indexOf('<!-- GMP_TABLE -->') === -1) {
    console.warn('Placeholder <!-- GMP_TABLE --> not found — appending table before footer.');
    html = html.replace('</div>\n\n<div class="footer">', '\n\n<div class="gmp-table">' + tableHtml + '</div>\n\n<div class="footer">');
  } else {
    html = html.replace('<!-- GMP_TABLE -->', tableHtml);
  }

  await fs.writeFile(indexPath, html, 'utf8');
  console.log('Updated index.html with', rows.length, 'rows');
}

main().catch(function(err){
  console.error(err);
  process.exit(1);
});
