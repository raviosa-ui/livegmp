// scripts/populate_sheet.js
// Node 18+
// Dependencies: node-fetch@2 cheerio googleapis

const fetch = require('node-fetch'); 
const cheerio = require('cheerio');
const { google } = require('googleapis');

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const RAW_SOURCES = process.env.GMP_SOURCE_URLS || process.env.GMP_SOURCE_URL || '';
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || '';
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || '').toLowerCase() === 'true';

if (!SA_JSON || !SHEET_ID || SOURCE_LIST.length === 0) {
  console.error('Missing required env vars.');
  process.exit(2);
}

function esc(s=''){ return String(s || '').trim(); }
function normalizeHeader(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }

function showSample(rows, n=6) {
  console.log('Parsed rows sample:', JSON.stringify(rows.slice(0,n), null, 2));
}

/* ---------------------
   fetchTableRows(url)
--------------------- */
async function fetchTableRows(url) {
  console.log('Fetching:', url);
  const res = await fetch(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (LiveGMPBot/1.0)'
    }
  });
  if (!res.ok) throw new Error('Failed: ' + res.status);

  const html = await res.text();
  const $ = cheerio.load(html);

  let $table = null;

  // Try to find table mentioning GMP
  $('table').each((i, t) => {
    const txt = $(t).text().toLowerCase();
    if (txt.includes('gmp') || txt.includes('grey') || txt.includes('kostak') || txt.includes('sauda')) {
      if (!$table) $table = $(t);
    }
  });

  // Fallback: largest table
  if (!$table) {
    let max = 0, best = null;
    $('table').each((i, t) => {
      const rows = $(t).find('tr').length;
      if (rows > max) { max = rows; best = $(t); }
    });
    if (best && max > 1) $table = best;
  }

  if (!$table) throw new Error('No GMP table found');

  const headers = [];
  let headerCells = $table.find('tr').first().find('th');
  if (!headerCells.length) headerCells = $table.find('tr').first().find('td');

  headerCells.each((i,cell)=>headers.push(normalizeHeader($(cell).text())));

  const rows = [];
  $table.find('tr').slice(1).each((i,tr)=>{
    const tds = $(tr).find('td');
    if (!tds.length) return;

    const obj = {};
    tds.each((ci,td)=>{
      obj[headers[ci] || `col${ci}`] = esc($(td).text());
    });

    rows.push(obj);
  });

  const normalized = rows.map(r=>{
    const out={};
    for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]);
    return out;
  });

  showSample(normalized);
  return normalized;
}

/* -------------------------
   Google Sheets helpers
------------------------- */
function authGoogleSheets() {
  const json = JSON.parse(SA_JSON);
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(json.client_email, null, json.private_key, scopes);
  return google.sheets({ version: 'v4', auth: jwt });
}

async function readSheet(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: 'Sheet1'
  });
  return res.data.values || [];
}

async function writeSheet(sheets, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log('Sheet updated:', values.length, 'rows');
}

/* -------------------------
   Simple NSE/BSE type lookup
------------------------- */
async function tryFetchTypeFromExchanges(ipoName) {
  ipoName = ipoName.toLowerCase();

  const tryURL = async (url) => {
    try {
      const r = await fetch(url, { headers: {'User-Agent':'Mozilla/5.0'}, timeout:15000 });
      if (!r.ok) return false;
      const html = await r.text();
      return html.toLowerCase().includes(ipoName);
    } catch { return false; }
  };

  if (await tryURL('https://www.nseindia.com/market-data/all-upcoming-issues-ipo')) return 'Mainboard';
  if (await tryURL('https://www.bseindia.com/publicissue.html')) return 'Mainboard';

  return null;
}

/* -------------------------
   match helper
------------------------- */
function findRow(sheet, name) {
  name = name.toLowerCase();
  for (let i=1;i<sheet.length;i++){
    const val = (sheet[i][0]||'').toString().toLowerCase();
    if (val && (val===name || val.includes(name) || name.includes(val))) return i;
  }
  return -1;
}

/* -------------------------
   MAIN
------------------------- */
(async()=>{
  try {
    let scraped = [];
    for (const src of SOURCE_LIST) {
      try {
        const data = await fetchTableRows(src);
        if (data.length) { scraped = data; break; }
      } catch (e) {
        console.log('Source failed:', src, e.message);
      }
    }

    if (!scraped.length) throw new Error('No data from any source');

    const sheets = authGoogleSheets();
    const sheet = await readSheet(sheets);

    if (!sheet.length) throw new Error('Sheet empty. Add headers in first row.');

    const headers = sheet[0];
    const headerMap = {};
    headers.forEach((h,i)=>headerMap[h.toLowerCase()] = i);

    const needed = ['ipo','gmp','kostak','subjecttosauda','date','status','type'];
    for (const h of needed) {
      if (!(h in headerMap)) {
        headerMap[h] = headers.length;
        headers.push(h);
        sheet[0].push(h);
      }
    }

    for (const r of scraped) {
      const keys = Object.keys(r);
      let ipoKey = keys.find(k=>k.includes('ipo')||k.includes('name')||k.includes('company')) || keys[0];
      const ipo = (r[ipoKey]||'').trim();
      if (!ipo) continue;

      const gmp = r.gmp || '';
      const kostak = r.kostak || '';
      const sauda = r.subjecttosauda || r.sauda || '';
      const date = r.date || '';

      const rowIdx = findRow(sheet, ipo);

      if (rowIdx>=1) {
        const row = sheet[rowIdx];
        row[headerMap['gmp']] = gmp;
        row[headerMap['kostak']] = kostak;
        row[headerMap['subjecttosauda']] = sauda;
        row[headerMap['date']] = date;
      } else {
        const newRow = Array(headers.length).fill('');
        newRow[headerMap['ipo']] = ipo;
        newRow[headerMap['gmp']] = gmp;
        newRow[headerMap['kostak']] = kostak;
        newRow[headerMap['subjecttosauda']] = sauda;
        newRow[headerMap['date']] = date;
        sheet.push(newRow);
      }
    }

    // Fill missing Type
    if (FILL_TYPE_FROM_NSE) {
      for (let i=1;i<sheet.length;i++){
        const ipo = (sheet[i][headerMap['ipo']]||'').trim();
        let type = sheet[i][headerMap['type']]||'';
        if (!type) {
          const found = await tryFetchTypeFromExchanges(ipo);
          sheet[i][headerMap['type']] = found || DEFAULT_TYPE;
        }
      }
    }

    await writeSheet(sheets, sheet);
    console.log('Done.');

  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
