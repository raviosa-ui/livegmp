/**
 * populate_sheet.js — FINAL (ipowatch mapping + type)
 *
 * - Correct Cheerio import
 * - Auto-detect _next/data JSON
 * - Smart HTML table selection
 * - Extracts 6 columns: ipo, gmp, kostak(IPO Price), subjecttosauda(Listing Gain), date, type
 * - Retry logic, TEST_MODE support
 * - Google Sheets write when TEST_MODE=false
 */

const fs = require("fs").promises;
const { load } = require("cheerio");
const { google } = require("googleapis");
const path = require("path");

// --------- ENV ----------
const RAW_SA_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_RAW || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "";
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const TEST_MODE = (process.env.TEST_MODE || "true").toLowerCase() === "true";

// --------- parse service account ----------
let CLIENT_EMAIL = "";
let PRIVATE_KEY = "";
try {
  const parsed = JSON.parse(RAW_SA_JSON);
  CLIENT_EMAIL = parsed.client_email;
  PRIVATE_KEY = parsed.private_key.replace(/\\n/g, "\n");
  console.log("Service Account JSON loaded.");
} catch (e) {
  console.error("❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_RAW — make sure the full JSON is pasted in the secret.");
  process.exit(1);
}

// --------- google sheets auth ----------
let sheets;
try {
  const auth = new google.auth.JWT(
    CLIENT_EMAIL,
    null,
    PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  sheets = google.sheets({ version: "v4", auth });
} catch (e) {
  console.error("❌ Failed to init Google Sheets auth:", e && e.message);
  process.exit(1);
}

// --------- small helpers ----------
function esc(s) { return String(s === undefined || s === null ? "" : s).trim(); }
async function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// --------- fetch with retries (supports local file path) ----------
async function fetchHtmlOrJson(url, attempts = 3) {
  // local file support (absolute path)
  if (url && (url.startsWith("/") || url.startsWith("./"))) {
    // try to read file relative to workspace if path not absolute
    const p = path.isAbsolute(url) ? url : path.join(process.env.GITHUB_WORKSPACE || process.cwd(), url);
    try {
      const t = await fs.readFile(p, "utf8");
      return { text: t, contentType: "text/html" };
    } catch (e) {
      throw new Error(`Local file not found: ${p}`);
    }
  }

  for (let i=1;i<=attempts;i++){
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 LiveGMPBot", "Accept": "*/*" }
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text, contentType: res.headers.get("content-type") || "" };
    } catch (e) {
      console.log(`fetch attempt ${i} failed for ${url}: ${e.message}`);
      await wait(700);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${attempts} attempts`);
}

// --------- investorgain JSON parser (if using next data JSON) ----------
async function parseInvestorgainJSON(url) {
  const r = await fetchHtmlOrJson(url);
  let j;
  try { j = JSON.parse(r.text); } catch(e){ throw new Error("Invalid JSON"); }

  const rows = j?.pageProps?.reportdata?.tabledata || j?.props?.pageProps?.reportdata?.tabledata || null;
  if (!Array.isArray(rows)) throw new Error("JSON structure not recognized");

  return rows.map(r => ({
    ipo: esc(r.companyname),
    gmp: esc(r.gmp),
    kostak: esc(r.kostak),           // IPO Price
    subjecttosauda: esc(r.subjecttosauda), // Listing Gain
    date: esc(r.daterange),
    type: esc(r.type || "")
  }));
}

// --------- discover _next/data JSON inside HTML ----------
function discoverNextJSON(html, baseUrl) {
  const regex = /\/_next\/data\/[^"']+?\/report\/live-ipo-gmp\/331\/ipo\.json/;
  const m = html.match(regex);
  if (m) {
    try {
      const base = new URL(baseUrl);
      return base.origin + m[0];
    } catch(e) {
      return m[0]; // fallback relative path
    }
  }
  return null;
}

// --------- smart HTML table parser (prefers semantic headers) ----------
function parseHTMLTable(html) {
  const $ = load(html);
  const useful = ['gmp','ipo','company','name','premium','kostak','sauda','subject','date','status','type'];

  const tables = [];
  $('table').each((i, t) => {
    const $t = $(t);
    const firstRow = $t.find('tr').first();
    const headerTexts = [];
    const ths = firstRow.find('th');
    if (ths.length) {
      ths.each((j,th) => headerTexts.push(esc($(th).text()).toLowerCase()));
    } else {
      firstRow.find('td').each((j,td) => headerTexts.push(esc($(td).text()).toLowerCase()));
    }
    let score = 0;
    for (const h of headerTexts) for (const u of useful) if (h.includes(u)) score++;
    tables.push({ $t, rows: $t.find('tr').length, score });
  });

  // prefer semantic match
  const semantic = tables.filter(x => x.score>0);
  if (semantic.length) {
    semantic.sort((a,b) => b.score - a.score || b.rows - a.rows);
    return extractRowsFromTable(semantic[0].$t);
  }

  // fallback largest table
  tables.sort((a,b) => b.rows - a.rows);
  if (tables.length && tables[0].rows > 1) return extractRowsFromTable(tables[0].$t);
  return [];
}

// --------- extract rows (now supports 6 columns: last is type) ----------
function extractRowsFromTable($table) {
  const rows = [];
  const $ = load('');
  // iterate tr from second row
  $table.find('tr').slice(1).each((i, tr) => {
    const $tr = $table.find('tr').eq(i+1);
    const tds = $tr.find('td');
    if (!tds.length) return;

    const parts = [];
    tds.each((ci, td) => parts.push(esc(load(td).text())));

    // Map columns carefully:
    // 0: IPO, 1: GMP, 2: IPO Price (we store in kostak), 3: Listing Gain (we store in subjecttosauda), 4: Date, 5: Type
    rows.push({
      ipo: parts[0] || "",
      gmp: parts[1] || "",
      kostak: parts[2] || "",           // IPO Price (mapped to kostak column)
      subjecttosauda: parts[3] || "",   // Listing Gain % (mapped to subjecttosauda)
      date: parts[4] || "",
      type: parts[5] || ""
    });
  });
  return rows;
}

// --------- master parse function ----------
async function parseSource(url) {
  if (!url) return [];

  // direct JSON
  if (url.endsWith('.json')) {
    try { return await parseInvestorgainJSON(url); } catch(e){ console.log("JSON parse failed:", e.message); }
  }

  const r = await fetchHtmlOrJson(url);
  const html = r.text;
  console.log(`--- HTML fetched, length: ${html.length} ---`);
  console.log(html.substring(0,300));
  console.log('--- END PREVIEW ---');

  // try to discover internal _next JSON
  const discovered = discoverNextJSON(html, url);
  if (discovered) {
    console.log("Discovered JSON API:", discovered);
    try { return await parseInvestorgainJSON(discovered); } catch(e){ console.log("Discovered JSON parse failed:", e.message); }
  }

  // fallback to HTML table parsing
  const tableRows = parseHTMLTable(html);
  if (tableRows.length) {
    console.log("Parsed HTML table:", tableRows.length, "rows");
    return tableRows;
  }

  throw new Error("No data parsed from HTML or JSON");
}

// --------- sheet helpers ----------
async function readSheet() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    key: GOOGLE_API_KEY || undefined
  });
  return res.data.values || [];
}

async function writeSheet(values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log("Sheet updated: rows=", values.length);
}

// --------- main ----------
(async () => {
  try {
    if (!SOURCE_LIST.length) throw new Error("No sources in GMP_SOURCE_URLS");
    let finalRows = [];
    for (const src of SOURCE_LIST) {
      try {
        console.log("Trying:", src);
        const rows = await parseSource(src);
        if (rows && rows.length) { finalRows = rows; break; }
      } catch (e) {
        console.log("Source failed:", src, e.message);
      }
    }

    if (!finalRows.length) throw new Error("No data parsed from any source.");

    console.log("=== SCRAPED ROWS PREVIEW ===");
    console.log(JSON.stringify(finalRows.slice(0,20), null, 2));

    if (TEST_MODE) {
      console.log("TEST_MODE true -> stopping before sheet write.");
      return;
    }

    // read existing sheet
    const sheetVals = await readSheet();
    if (!sheetVals.length) throw new Error("Sheet1 is empty.");

    // header map (lowercased)
    const headersRow = sheetVals[0].map(h => String(h||'').trim());
    const headerMap = {};
    headersRow.forEach((h,i) => headerMap[h.toLowerCase()] = i);

    // ensure necessary columns exist
    const expected = ['ipo','gmp','kostak','subjecttosauda','date','status','type'];
    for (const h of expected) {
      if (!(h in headerMap)) {
        headerMap[h] = headersRow.length;
        headersRow.push(h);
        sheetVals[0].push(h);
      }
    }

    function findMatchingRowIndex(sheetRows, ipoName) {
      if (!ipoName) return -1;
      const n = ipoName.toString().toLowerCase();
      for (let i=1;i<sheetRows.length;i++) {
        const cell = (sheetRows[i][headerMap['ipo']]||'').toString().toLowerCase();
        if (!cell) continue;
        if (cell === n || cell.includes(n) || n.includes(cell)) return i;
      }
      return -1;
    }

    // merge each scraped row into sheet
    for (const raw of finalRows) {
      const ipoName = raw.ipo || raw.name || "";
      if (!ipoName) continue;
      const idx = findMatchingRowIndex(sheetVals, ipoName);
      if (idx >= 1) {
        const row = sheetVals[idx];
        // overwrite kostak and subjecttosauda with new meanings (IPO Price & Listing Gain)
        row[headerMap['gmp']] = raw.gmp || row[headerMap['gmp']] || '';
        row[headerMap['kostak']] = raw.kostak || row[headerMap['kostak']] || ''; // IPO Price
        row[headerMap['subjecttosauda']] = raw.subjecttosauda || row[headerMap['subjecttosauda']] || ''; // Listing Gain
        row[headerMap['date']] = raw.date || row[headerMap['date']] || '';
        row[headerMap['type']] = raw.type || row[headerMap['type']] || DEFAULT_TYPE || '';
      } else {
        const newRow = new Array(Object.keys(headerMap).length).fill('');
        newRow[headerMap['ipo']] = raw.ipo;
        newRow[headerMap['gmp']] = raw.gmp || '';
        newRow[headerMap['kostak']] = raw.kostak || '';
        newRow[headerMap['subjecttosauda']] = raw.subjecttosauda || '';
        newRow[headerMap['date']] = raw.date || '';
        newRow[headerMap['status']] = '';
        newRow[headerMap['type']] = raw.type || DEFAULT_TYPE || '';
        sheetVals.push(newRow);
      }
    }

    await writeSheet(sheetVals);
    console.log("Done — sheet updated.");
  } catch (err) {
    console.error("ERROR:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
