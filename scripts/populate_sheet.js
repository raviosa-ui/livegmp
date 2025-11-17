// scripts/populate_sheet.js
// Node 18+ (uses global fetch)
// Dependencies: cheerio googleapis
//
// Purpose: same as before but using global fetch (no node-fetch/undici issues)

const cheerio = require('cheerio');
const { google } = require('googleapis');

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const RAW_SOURCES = process.env.GMP_SOURCE_URLS || process.env.GMP_SOURCE_URL || '';
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || '';
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || '').toLowerCase() === 'true';

if (!SA_JSON || !SHEET_ID || SOURCE_LIST.length === 0) {
  console.error('Missing required env vars. Ensure GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID and GMP_SOURCE_URLS (or GMP_SOURCE_URL) are set.');
  process.exit(2);
}

function esc(s=''){ return String(s === null || s === undefined ? '' : s).trim(); }
function normalizeHeader(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }

function showSample(rows, n=6) {
  try { console.log('Parsed rows sample (first ' + Math.min(n, rows.length) + '):'); console.log(JSON.stringify(rows.slice(0, n), null, 2)); } catch(e){}
}

/* ---------------------
   fetchTableRows(url)
   Uses global fetch (Node 18+)
--------------------- */
async function fetchTableRows(url) {
  console.log('Fetching GMP source (tailored):', url);

  // use global fetch; add User-Agent to reduce blocking
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveGMPBot/1.0'
    },
    // timeout not standard in global fetch; rely on default action timeouts
  });
  if (!res.ok) throw new Error('Failed to fetch GMP source: ' + res.status);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Strategy: find table containing GMP/kostak/sauda, fallback to heading-next-table, largest table, or div blocks
  let $selectedTable = null;
  $('table').each((i, t) => {
    const txt = $(t).text().toLowerCase();
    if (txt.includes('gmp') || txt.includes('kostak') || txt.includes('sauda') || txt.includes('grey')) {
      if (!$selectedTable) $selectedTable = $(t);
    }
  });

  if (!$selectedTable) {
    const heading = $('h1,h2,h3').filter((i,el) => /gmp|grey market premium|live ipo gmp/i.test($(el).text())).first();
    if (heading && heading.length) {
      const nextTable = heading.nextAll('table').first();
      if (nextTable && nextTable.length) $selectedTable = nextTable;
      else {
        const parentTable = heading.parent().find('table').first();
        if (parentTable && parentTable.length) $selectedTable = parentTable;
      }
    }
  }

  if (!$selectedTable) {
    let best = null, bestRows = 0;
    $('table').each((i, t) => {
      const rows = $(t).find('tr').length;
      if (rows > bestRows) { bestRows = rows; best = $(t); }
    });
    if (best && bestRows > 1) $selectedTable = best;
  }

  if (!$selectedTable) {
    const candidates = $('div,section').filter((i, el) => {
      const text = $(el).text().toLowerCase();
      return text.includes('gmp') || text.includes('kostak') || text.includes('sauda') || text.includes('ipo');
    });
    if (candidates.length) {
      const c = candidates.first();
      const rows = [];
      c.children().each((i, ch) => {
        const txt = $(ch).text().trim();
        if (!txt) return;
        const parts = txt.split('\n').map(x => x.trim()).filter(Boolean);
        if (parts.length >= 2) {
          rows.push({
            ipo: parts[0] || '',
            gmp: parts[1] || '',
            kostak: parts[2] || '',
            subjecttosauda: parts[3] || '',
            date: parts[4] || ''
          });
        }
      });
      if (rows.length) {
        console.log('Parsed rows using div fallback, count:', rows.length);
        return rows.map(r => {
          const out = {};
          for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]);
          return out;
        });
      }
    }
    throw new Error('No table or list-like data found on GMP source page.');
  }

  // Parse selected table
  const $table = $selectedTable;
  let headerCells = $table.find('tr').first().find('th');
  if (!headerCells || headerCells.length === 0) headerCells = $table.find('tr').first().find('td');
  const headers = [];
  headerCells.each((i, cell) => headers.push(normalizeHeader(esc(cheerio(cell).text ? cheerio(cell).text() : cheerio(cell).text())))); // defensive

  const usefulKeywords = ['gmp','ipo','name','company','kostak','sauda','subject','date','status','type'];
  let hasUsefulHeader = headers.some(h => usefulKeywords.some(k => h.includes(k)));
  let usePositional = false;
  if (!hasUsefulHeader) {
    usePositional = true;
    console.log('Header row not recognized; using positional mapping: IPO,GMP,Kostak,SubjectToSauda,Date.');
  }

  const rows = [];
  $table.find('tr').slice(1).each((ri, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('td');
    if (cells.length === 0) return;
    if (usePositional) {
      const parts = cells.map((i, td) => esc($(td).text())).get();
      const obj = { ipo: parts[0] || '', gmp: parts[1] || '', kostak: parts[2] || '', subjecttosauda: parts[3] || '', date: parts[4] || '' };
      rows.push(obj);
    } else {
      const obj = {};
      cells.each((ci, td) => {
        const header = headers[ci] || `col${ci}`;
        obj[header] = esc($(td).text());
      });
      rows.push(obj);
    }
  });

  if (!rows.length) throw new Error('No data rows parsed from selected table.');

  const normalizedRows = rows.map(r => {
    const out = {};
    for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]);
    return out;
  });

  showSample(normalizedRows, 6);
  return normalizedRows;
}

/* ====================
   Google Sheets helpers
   ==================== */
function authGoogleSheets() {
  const json = JSON.parse(SA_JSON);
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(json.client_email, null, json.private_key, scopes);
  return google.sheets({ version: 'v4', auth: jwt });
}

async function readSheet(sheets) {
  const range = 'Sheet1';
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const values = res.data.values || [];
  return values;
}
async function writeSheet(sheets, values) {
  const range = 'Sheet1';
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log('Sheet updated: rows=', values.length);
}

/* ====================
   Exchange Type lookup (best-effort)
   ==================== */
async function tryFetchTypeFromExchanges(ipoName) {
  try {
    if (!ipoName) return null;
    const nameLower = ipoName.toLowerCase();

    try {
      const nseUrl = 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo';
      const r = await fetch(nseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (LiveGMPBot/1.0)' } });
      if (r.ok) {
        const html = await r.text();
        if (html.toLowerCase().includes(nameLower)) return 'Mainboard';
      }
    } catch(e) {}

    try {
      const bseUrl = 'https://www.bseindia.com/publicissue.html';
      const r2 = await fetch(bseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (LiveGMPBot/1.0)' } });
      if (r2.ok) {
        const html2 = await r2.text();
        if (html2.toLowerCase().includes(nameLower)) return 'Mainboard';
      }
    } catch(e) {}

    return null;
  } catch(e) { return null; }
}

/* ====================
   Matching & merging
   ==================== */
function findMatchingRowIndex(sheetRows, ipoName) {
  if (!ipoName) return -1;
  ipoName = ipoName.toLowerCase();
  for (let i = 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    const cell = (row[0] || '').toString().toLowerCase();
    if (!cell) continue;
    if (cell === ipoName || cell.includes(ipoName) || ipoName.includes(cell)) return i;
  }
  return -1;
}

/* ====================
   MAIN RUN
   ==================== */
(async () => {
  try {
    let scraped = [];
    for (const src of SOURCE_LIST) {
      try {
        console.log('Trying source:', src);
        scraped = await fetchTableRows(src);
        if (scraped && scraped.length) { console.log('Succeeded parsing with', src); break; }
      } catch (e) {
        console.warn('Source failed:', src, e.message || e);
      }
    }
    if (!scraped || scraped.length === 0) throw new Error('No data parsed from any source.');

    const sheets = authGoogleSheets();
    const sheetVals = await readSheet(sheets);
    if (sheetVals.length === 0) throw new Error('Sheet is empty. Ensure headers exist in row 1.');

    const headersRow = sheetVals[0].map(h => String(h || '').trim());
    const headerMap = {};
    headersRow.forEach((h,i) => headerMap[h.toLowerCase()] = i);

    const expected = ['ipo','gmp','kostak','subjecttosauda','date','status','type'];
    for (const h of expected) {
      if (!(h in headerMap)) {
        headerMap[h] = headersRow.length;
        headersRow.push(h);
        sheetVals[0].push(h);
      }
    }

    for (const raw of scraped) {
      const keys = Object.keys(raw);
      let ipoKey = keys.find(k => k.includes('ipo') || k.includes('name') || k.includes('company')) || keys[0];
      const ipoName = (raw[ipoKey] || '').trim();
      if (!ipoName) continue;

      const normalized = {
        ipo: ipoName,
        gmp: (raw.gmp || raw.gmpvalue || raw.premium || '') .toString().trim(),
        kostak: (raw.kostak || raw.kost || '') .toString().trim(),
        subjecttosauda: (raw.subjecttosauda || raw.sauda || raw.subject || '') .toString().trim(),
        date: (raw.date || raw.daterange || '') .toString().trim()
      };

      const matchIdx = findMatchingRowIndex(sheetVals, ipoName);
      if (matchIdx >= 1) {
        const row = sheetVals[matchIdx];
        row[headerMap['gmp']] = normalized.gmp || row[headerMap['gmp']] || '';
        row[headerMap['kostak']] = normalized.kostak || row[headerMap['kostak']] || '';
        row[headerMap['subjecttosauda']] = normalized.subjecttosauda || row[headerMap['subjecttosauda']] || '';
        row[headerMap['date']] = normalized.date || row[headerMap['date']] || '';
      } else {
        const newRow = new Array(Object.keys(headerMap).length).fill('');
        newRow[headerMap['ipo']] = normalized.ipo;
        newRow[headerMap['gmp']] = normalized.gmp || '';
        newRow[headerMap['kostak']] = normalized.kostak || '';
        newRow[headerMap['subjecttosauda']] = normalized.subjecttosauda || '';
        newRow[headerMap['date']] = normalized.date || '';
        newRow[headerMap['status']] = '';
        newRow[headerMap['type']] = '';
        sheetVals.push(newRow);
      }
    }

    if (FILL_TYPE_FROM_NSE) {
      console.log('Attempting NSE/BSE type lookup (best-effort).');
      for (let i = 1; i < sheetVals.length; i++) {
        try {
          const currType = (sheetVals[i][headerMap['type']] || '').toString().trim();
          if (!currType) {
            const ipoName = (sheetVals[i][headerMap['ipo']] || '').toString().trim();
            if (!ipoName) continue;
            const t = await tryFetchTypeFromExchanges(ipoName);
            if (t) sheetVals[i][headerMap['type']] = t;
            else if (DEFAULT_TYPE) sheetVals[i][headerMap['type']] = DEFAULT_TYPE;
          }
        } catch (e) {
          console.warn('Type lookup failed for row', i, e.message || e);
          if (DEFAULT_TYPE && !sheetVals[i][headerMap['type']]) sheetVals[i][headerMap['type']] = DEFAULT_TYPE;
        }
      }
    } else if (DEFAULT_TYPE) {
      for (let i = 1; i < sheetVals.length; i++) {
        if (!sheetVals[i][headerMap['type']] || sheetVals[i][headerMap['type']].toString().trim() === '') {
          sheetVals[i][headerMap['type']] = DEFAULT_TYPE;
        }
      }
    }

    await writeSheet(sheets, sheetVals);
    console.log('Done — sheet populated/updated from scraped source(s).');
  } catch (err) {
    console.error('Error:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
