// scripts/populate_sheet.js
// Node 18+; uses global fetch; includes File/Blob polyfill
// Robust parser + investorgain-specific fallback + sheet updater
// ---------------- polyfill ----------------
if (typeof File === "undefined") {
  try {
    const { Blob } = require("buffer");
    class FilePoly extends Blob {
      constructor(chunks, name = "", opts = {}) {
        super(chunks, opts);
        this.name = name;
        this.lastModified = opts.lastModified || Date.now();
      }
      get [Symbol.toStringTag]() { return "File"; }
    }
    global.File = FilePoly;
    global.Blob = Blob;
  } catch (err) {
    console.warn("Polyfill warn:", err && err.message ? err.message : err);
  }
}
// ---------------- imports ----------------
const cheerio = require("cheerio");
const { google } = require("googleapis");
// ---------------- credentials ----------------
const RAW_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || ""; // NEW SECRET NAME
// API Key is read but NOT passed to Sheets API calls to avoid 403 error
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null; 

let CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || "";
let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || process.env.GMP_SOURCE_URL || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "";
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";

let RAW_SA_JSON = "";

if (RAW_B64) {
  try {
    // Decode the Base64 string into the JSON content
    RAW_SA_JSON = Buffer.from(RAW_B64, 'base64').toString('utf8');
  } catch(e) {
    console.error('Failed to decode Base64 service json:', e && e.message);
  }
} else {
    // Fallback/Original
    RAW_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
}

if (RAW_SA_JSON && !CLIENT_EMAIL) {
  try {
    const parsed = JSON.parse(RAW_SA_JSON);
    CLIENT_EMAIL = parsed.client_email || CLIENT_EMAIL;
    PRIVATE_KEY = parsed.private_key || PRIVATE_KEY;
  } catch (e) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", e && e.message ? e.message : e);
  }
}

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("❌ Missing Google API secrets. Ensure GOOGLE_SERVICE_ACCOUNT_JSON_B64 (or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY) and GOOGLE_SHEET_ID are set.");
  process.exit(1);
}
// ---------------- google auth ----------------
const jwt = new google.auth.JWT(CLIENT_EMAIL, null, PRIVATE_KEY, ["https://www.googleapis.com/auth/spreadsheets"]);
const sheets = google.sheets({ version: "v4", auth: jwt });
// ---------------- helpers ----------------
function esc(s='') { return String(s === null || s === undefined ? '' : s).trim(); }
function normalizeHeader(h='') { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
function showSample(rows, n=6) { try { console.log('Parsed rows sample (first ' + Math.min(n, rows.length) + '):'); console.log(JSON.stringify(rows.slice(0,n), null, 2)); } catch(e){} }
// ---------------- fetch HTML ----------------
async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (LiveGMPBot/1.0)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new Error(`Failed to fetch ${url}: ${err && err.message ? err.message : err}`);
  }
}
// ---------------- investorgain-specific parser ----------------
function parseInvestorgain(html) {
  const $ = cheerio.load(html);
  const rows = [];
  let $table = null;
  $('table').each((i, t) => {
    const txt = $(t).text().toLowerCase();
    if (txt.includes('gmp') && (txt.includes('kostak') || txt.includes('sauda') || txt.includes('subject'))) {
      if (!$table) $table = $(t);
    }
  });
  if (!$table) return rows;

  $table.find('tr').each((i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const ipo = esc($(tds[0]).text());
    const gmp = esc($(tds[1]).text());
    const kostak = esc(tds[2] ? $(tds[2]).text() : '');
    const sauda = esc(tds[3] ? $(tds[3]).text() : '');
    if (!ipo) return;
    rows.push({ ipo, gmp, kostak, subjecttosauda: sauda, date: '' });
  });
  return rows;
}
// ---------------- generic table parser ----------------
function parseTableGeneric(html) {
  const $ = cheerio.load(html);
  let $table = null;
  $('table').each((i, t) => {
    const txt = $(t).text().toLowerCase();
    if (txt.includes('gmp') || txt.includes('kostak') || txt.includes('sauda') || txt.includes('grey')) {
      if (!$table) $table = $(t);
    }
  });
  if (!$table) {
    const heading = $('h1,h2,h3').filter((i,el) => /gmp|grey market premium|live ipo gmp/i.test($(el).text())).first();
    if (heading && heading.length) {
      const nextTable = heading.nextAll('table').first();
      if (nextTable && nextTable.length) $table = nextTable;
    }
  }
  if (!$table) {
    let best = null, max = 0;
    $('table').each((i, t) => {
      const r = $(t).find('tr').length;
      if (r > max) { max = r; best = $(t); }
    });
    if (best && max > 1) $table = best;
  }
  if (!$table) return [];

  let headerCells = $table.find('tr').first().find('th');
  if (!headerCells || headerCells.length === 0) headerCells = $table.find('tr').first().find('td');
  const headers = [];
  headerCells.each((i, cell) => headers.push(normalizeHeader(esc($(cell).text()))));

  const useful = ['gmp','ipo','name','company','kostak','sauda','subject','date','status','type'];
  const hasUsefulHeader = headers.some(h => useful.some(k => h.includes(k)));
  const usePositional = !hasUsefulHeader;

  const rows = [];
  $table.find('tr').slice(1).each((i, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    if (usePositional) {
      const parts = cells.map((i, td) => esc($(td).text())).get();
      rows.push({ ipo: parts[0]||'', gmp: parts[1]||'', kostak: parts[2]||'', subjecttosauda: parts[3]||'', date: parts[4]||'' });
    } else {
      const obj = {};
      cells.each((ci, td) => {
        const header = headers[ci] || `col${ci}`;
        obj[header] = esc($(td).text()); // <--- SYNTAX ERROR CORRECTED HERE
      });
      rows.push(obj);
    }
  });
  return rows.map(r => { const out = {}; for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]); return out; });
}
// ---------------- fallback list/div parser ----------------
function parseBlocks(html) {
  const $ = cheerio.load(html);
  const cands = $('div,section').filter((i, el) => {
    const t = $(el).text().toLowerCase();
    return t.includes('gmp') || t.includes('kostak') || t.includes('sauda') || t.includes('ipo');
  });
  if (!cands.length) return [];
  const c = cands.first();
  const rows = [];
  c.children().each((i,ch) => {
    const txt = $(ch).text().trim();
    if (!txt) return;
    const parts = txt.split('\n').map(x=>x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      rows.push({ ipo: parts[0]||'', gmp: parts[1]||'', kostak: parts[2]||'', subjecttosauda: parts[3]||'', date: parts[4]||'' });
    }
  });
  return rows.map(r => { const out = {}; for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]); return out; });
}
// ---------------- fetch+parse orchestration ----------------
async function fetchTableRows(url) {
  try {
    const html = await fetchHtml(url);

    const igRows = parseInvestorgain(html);
    if (igRows && igRows.length) {
      console.log("Parsed with investorgain parser:", igRows.length, "rows");
      return igRows;
    }

    const generic = parseTableGeneric(html);
    if (generic && generic.length) {
      console.log("Parsed with generic table parser:", generic.length, "rows");
      return generic;
    }

    const blocks = parseBlocks(html);
    if (blocks && blocks.length) {
      console.log("Parsed with block parser:", blocks.length, "rows");
      return blocks;
    }

    throw new Error("No table or list-like data found on page.");
  } catch (err) {
    throw err;
  }
}
// ---------------- exchange type best-effort ----------------
async function tryFetchTypeFromExchanges(ipoName) {
  if (!ipoName) return null;
  try {
    const nse = await fetch("https://www.nseindia.com/market-data/all-upcoming-issues-ipo", { headers: {'User-Agent':'Mozilla/5.0'} });
    if (nse.ok) {
      const h = await nse.text();
      if (h.toLowerCase().includes(ipoName.toLowerCase())) return 'Mainboard';
    }
  } catch(e){}
  try {
    const bse = await fetch("https://www.bseindia.com/publicissue.html", { headers: {'User-Agent':'Mozilla/5.0'} });
    if (bse.ok) {
      const h2 = await bse.text();
      if (h2.toLowerCase().includes(ipoName.toLowerCase())) return 'Mainboard';
    }
  } catch(e){}
  return null;
}
// ---------------- sheets helpers ----------------
async function readSheet() {
  // Relying solely on JWT auth, no API key needed
  const res = await sheets.spreadsheets.values.get({ 
    spreadsheetId: SHEET_ID, 
    range: 'Sheet1'
  });
  return res.data.values || [];
}
async function writeSheet(values) {
  // Relying solely on JWT auth, no API key needed
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log("Sheet updated: rows=", values.length);
}
// ---------------- merge helper ----------------
function findMatchingRowIndex(sheetRows, ipoName) {
  if (!ipoName) return -1;
  const n = ipoName.toString().toLowerCase();
  for (let i=1;i<sheetRows.length;i++) {
    const cell = (sheetRows[i][0]||'').toString().toLowerCase();
    if (!cell) continue;
    if (cell === n || cell.includes(n) || n.includes(cell)) return i;
  }
  return -1;
}
// ---------------- main ----------------
(async () => {
  try {
    let scraped = [];
    for (const src of SOURCE_LIST) {
      try {
        console.log("Trying to fetch & parse:", src);
        const rows = await fetchTableRows(src);
        if (rows && rows.length) { scraped = rows; console.log("Succeeded with", src); break; }
      } catch (e) {
        console.warn("Source failed:", src, e && e.message ? e.message : e);
      }
    }

    if (!scraped.length) throw new Error("No data parsed from any source.");

    const sheetVals = await readSheet();
    if (sheetVals.length === 0) throw new Error("Sheet is empty. Ensure headers exist in first row.");

    // headers mapping
    const headersRow = sheetVals[0].map(h => String(h||'').trim());
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

    // merge scraped into sheet
    for (const raw of scraped) {
      const keys = Object.keys(raw);
      let ipoKey = keys.find(k=>k.includes('ipo')||k.includes('name')||k.includes('company')) || keys[0];
      const ipoName = (raw[ipoKey]||'').toString().trim();
      if (!ipoName) continue;

      const normalized = {
        ipo: ipoName,
        gmp: (raw.gmp || raw.gmpvalue || raw.premium || '').toString().trim(),
        kostak: (raw.kostak || raw.kost || '').toString().trim(),
        subjecttosauda: (raw.subjecttosauda || raw.sauda || raw.subject || '').toString().trim(),
        date: (raw.date || raw.daterange || '').toString().trim()
      };

      const idx = findMatchingRowIndex(sheetVals, ipoName);
      if (idx>=1) {
        const row = sheetVals[idx];
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

    // optional Type fill
    if (FILL_TYPE_FROM_NSE) {
      for (let i=1;i<sheetVals.length;i++){
        try {
          const curr = (sheetVals[i][headerMap['type']]||'').toString().trim();
          if (!curr) {
            const name = (sheetVals[i][headerMap['ipo']]||'').toString().trim();
            if (!name) continue;
            const t = await tryFetchTypeFromExchanges(name);
            sheetVals[i][headerMap['type']] = t || DEFAULT_TYPE;
          }
        } catch(e){}
      }
    } else if (DEFAULT_TYPE) {
      for (let i=1;i<sheetVals.length;i++){
        if (!sheetVals[i][headerMap['type']] || sheetVals[i][headerMap['type']].toString().trim()==='') sheetVals[i][headerMap['type']] = DEFAULT_TYPE;
      }
    }

    await writeSheet(sheetVals);
    console.log("Done — sheet populated/updated.");
  } catch (err) {
    console.error("ERROR:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
