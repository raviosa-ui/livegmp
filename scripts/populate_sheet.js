// scripts/populate_sheet.js
// Node 20 recommended. TEST_MODE=true -> parse & print only (no writes).
// Features:
// - Uses GOOGLE_APPLICATION_CREDENTIALS_RAW (raw JSON) for JWT auth
// - Prefers Investorgain JSON API when available
// - Can discover the Next.js JSON path from HTML if needed
// - Falls back to HTML parsing for static pages
// - Retry-friendly fetchHtml with debug output
// - TEST_MODE prevents writes (safe for debugging)

const fs = require('fs').promises;
const cheerio = require('cheerio');
const { google } = require('googleapis');

// ---------- Config / env ----------
const RAW_SA_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_RAW || "";
let CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || "";
let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || process.env.GMP_SOURCE_URL || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "";
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";

// ---------- parse raw SA JSON ----------
if (RAW_SA_JSON && !CLIENT_EMAIL) {
  try {
    const parsed = JSON.parse(RAW_SA_JSON);
    CLIENT_EMAIL = parsed.client_email || CLIENT_EMAIL;
    PRIVATE_KEY = parsed.private_key || PRIVATE_KEY;
    global.__PARSED_SA_PROJECT_ID = parsed.project_id || null;
    console.log("Service account JSON parsed from GOOGLE_APPLICATION_CREDENTIALS_RAW");
  } catch (e) {
    console.error("Failed to parse GOOGLE_APPLICATION_CREDENTIALS_RAW:", e && e.message ? e.message : e);
    process.exit(1);
  }
}
if (PRIVATE_KEY && PRIVATE_KEY.indexOf("\\n") !== -1) PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, "\n");

// ---------- debug prints ----------
console.log("DEBUG: TEST_MODE =", TEST_MODE);
console.log("DEBUG: SHEET_ID present? ", !!SHEET_ID);
console.log("DEBUG: GMP_SOURCE_URLS count =", SOURCE_LIST.length);
if (CLIENT_EMAIL) console.log("DEBUG: client_email =", CLIENT_EMAIL);
if (global.__PARSED_SA_PROJECT_ID) console.log("DEBUG: project_id =", global.__PARSED_SA_PROJECT_ID);

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
  console.warn("WARNING: client email or private key missing from env parsing. If you plan to write to Sheets, set GOOGLE_APPLICATION_CREDENTIALS_RAW.");
}

// ---------- google auth (if creds present) ----------
let sheets = null;
if (CLIENT_EMAIL && PRIVATE_KEY) {
  try {
    const auth = new google.auth.JWT(
      CLIENT_EMAIL,
      null,
      PRIVATE_KEY,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    sheets = google.sheets({ version: "v4", auth });
  } catch (e) {
    console.error("Failed to create google JWT auth:", e && e.message ? e.message : e);
  }
}

// ---------- helpers ----------
function esc(s='') { return String(s === null || s === undefined ? '' : s).trim(); }
function normalizeHeader(h='') { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
function showSample(rows, n=6) { try { console.log('Parsed rows sample (first ' + Math.min(n, rows.length) + '):'); console.log(JSON.stringify(rows.slice(0,n), null, 2)); } catch(e){} }

// ---------- reliable fetch with retries, supports local files ----------
async function fetchHtmlOrJson(url, attempts = 3, delayMs = 1200) {
  // local absolute path or file://
  try {
    if (typeof url === 'string' && (url.startsWith('/') || url.startsWith('file://'))) {
      const path = url.startsWith('file://') ? url.replace('file://', '') : url;
      const buf = await fs.readFile(path, 'utf8');
      return { ok: true, text: String(buf), contentType: 'text/html' };
    }
  } catch (err) {
    // continue to HTTP fetch
    console.warn(`Local file read failed for ${url}: ${err.message}`);
  }

  for (let i=0;i<attempts;i++){
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LiveGMPBot/1.0',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://livegmp.in/'
        },
        redirect: 'follow'
      });
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (!res.ok) {
        console.warn(`fetch ${url} returned ${res.status} (${res.statusText}) — body preview:`, text.slice(0,800));
        throw new Error(`HTTP ${res.status}`);
      }
      return { ok: true, text, contentType: ct };
    } catch (err) {
      console.warn(`fetchHtml attempt ${i+1} failed for ${url}: ${err.message}`);
      if (i < attempts-1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${attempts} attempts`);
}

// ---------- Investorgain JSON parser ----------
async function fetchInvestorgainJSON(url) {
  const r = await fetchHtmlOrJson(url);
  if (!r || !r.ok) throw new Error('Failed to fetch JSON endpoint');
  if (!r.text || r.text.trim().length === 0) throw new Error('Empty JSON response');
  let json;
  try { json = JSON.parse(r.text); } catch(e) { throw new Error('Failed to parse JSON from investorgain API'); }

  // Inspect common JSON layout for next/data usage
  // try likely path
  const rowsRaw = json?.pageProps?.reportdata?.tabledata || json?.props?.pageProps?.reportdata?.tabledata || null;
  if (!rowsRaw || !Array.isArray(rowsRaw)) {
    // sometimes structure differs; try to locate any nested array objects
    // fallback: scan JSON for objects having companyname/gmp fields
    const candidates = [];
    (function scan(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) scan(item);
        return;
      }
      // if object has companyname or gmp, assume it's row
      if ('companyname' in obj || 'gmp' in obj) {
        candidates.push(obj);
      } else {
        for (const k of Object.keys(obj)) scan(obj[k]);
      }
    })(json);
    if (candidates.length) {
      return candidates.map(r => ({
        ipo: esc(r.companyname || r.name || r.title || ''),
        gmp: esc(r.gmp || r.premium || ''),
        kostak: esc(r.kostak || r.kost || ''),
        subjecttosauda: esc(r.sauda || r.subject || ''),
        date: esc(r.daterange || r.date || '')
      }));
    }
    throw new Error('Investorgain JSON structure not as expected');
  }

  const rows = rowsRaw.map(r => ({
    ipo: esc(r.companyname || r.name || r.title || ''),
    gmp: esc(r.gmp || r.premium || ''),
    kostak: esc(r.kostak || r.kost || ''),
    subjecttosauda: esc(r.subjecttosauda || r.sauda || r.subject || ''),
    date: esc(r.daterange || r.date || '')
  }));
  return rows;
}

// ---------- attempt to discover Next.js data json path from HTML ----------
function discoverNextDataJson(html, baseUrl) {
  // search for /_next/data/.../*.json occurrences that include the path segment 'report' and 'ipo'
  const m = html.match(/(["'])(\/_next\/data\/[^"']+?\/report\/[^"']+?\/ipo\.json)\1/);
  if (m && m[2]) {
    // if baseUrl provided, build absolute
    if (baseUrl && m[2].startsWith('/')) {
      const u = new URL(baseUrl);
      return u.origin + m[2];
    }
    return m[2];
  }
  // try slightly different regexes
  const m2 = html.match(/\/_next\/data\/[^"'\s>]+?\/report\/[^"'\s>]+?\/ipo\.json/);
  if (m2 && m2[0]) {
    if (baseUrl && m2[0].startsWith('/')) {
      const u = new URL(baseUrl);
      return u.origin + m2[0];
    }
    return m2[0];
  }
  return null;
}

// ---------- generic HTML table parser (fallback) ----------
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
    // choose biggest table as fallback
    let best=null, max=0;
    $('table').each((i,t) => {
      const r = $(t).find('tr').length;
      if (r > max) { max = r; best = $(t); }
    });
    if (best && max>1) $table = best;
  }
  if (!$table) return [];

  let headerCells = $table.find('tr').first().find('th');
  if (!headerCells || headerCells.length === 0) headerCells = $table.find('tr').first().find('td');
  const headers = [];
  headerCells.each((i, cell) => headers.push(normalizeHeader(esc(cheerio(cell).text ? cheerio(cell).text() : ''))));

  const rows = [];
  $table.find('tr').slice(1).each((i, tr) => {
    const cells = cheerio(tr).find('td');
    if (!cells.length) return;
    const parts = cells.map((i, td) => esc(cheerio(td).text())).get();
    rows.push({ ipo: parts[0]||'', gmp: parts[1]||'', kostak: parts[2]||'', subjecttosauda: parts[3]||'', date: parts[4]||'' });
  });
  return rows;
}

// ---------- high level fetch+parse orchestration ----------
async function fetchTableRows(url) {
  // If url looks like JSON endpoint, fetch JSON
  try {
    // try straight JSON fetch if URL ends with .json
    if (url.endsWith('.json')) {
      console.log("Attempting JSON fetch for:", url);
      return await fetchInvestorgainJSON(url);
    }

    // attempt to fetch HTML first
    const r = await fetchHtmlOrJson(url);
    const html = r.text || "";

    // try to discover Next.js JSON path in page
    const discovered = discoverNextDataJson(html, url);
    if (discovered) {
      console.log("Discovered Next.js JSON API:", discovered);
      try {
        return await fetchInvestorgainJSON(discovered);
      } catch (e) {
        console.warn("Discovered JSON parse failed:", e.message || e);
      }
    }

    // if content-type hints JSON, try parse it
    if (r.contentType && r.contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(html);
        // if it looks like investorgain JSON, parse
        return await (async () => {
          try { return await fetchInvestorgainJSON(url); } catch(e){ /* fallthrough */ }
          // fallback: scan parsed object for companyname/gmp objects
          const rows = [];
          (function scan(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
              for (const it of obj) scan(it);
              return;
            }
            if ('companyname' in obj || 'gmp' in obj) rows.push(obj);
            else for (const k of Object.keys(obj)) scan(obj[k]);
          })(parsed);
          if (rows.length) return rows.map(r => ({
            ipo: esc(r.companyname || r.name || ''),
            gmp: esc(r.gmp || ''),
            kostak: esc(r.kostak || ''),
            subjecttosauda: esc(r.subjecttosauda || r.sauda || ''),
            date: esc(r.daterange || r.date || '')
          }));
          throw new Error('No JSON rows found');
        })();
      } catch (e) {
        // not JSON or not the right structure
      }
    }

    // fallback: HTML table parser
    const htmlSample = (html || "").substring(0, 600);
    console.log(`--- RAW HTML FETCHED for ${url} (length: ${ (html||'').length }) ---`);
    console.log(htmlSample);
    console.log('--- END SAMPLE ---');

    const generic = parseTableGeneric(html);
    if (generic && generic.length) {
      console.log("Parsed with generic table parser:", generic.length, "rows");
      return generic;
    }

    // try a block parser rudimentary (minimal)
    const $ = cheerio.load(html);
    const blocks = [];
    $('div,section,li').each((i, el) => {
      const t = $(el).text().trim();
      if (!t) return;
      const lines = t.split('\n').map(x=>x.trim()).filter(Boolean);
      if (lines.length >= 2 && (lines[0].length < 100 && lines[1].length < 60)) {
        blocks.push({ ipo: lines[0], gmp: lines[1], kostak: lines[2]||'', subjecttosauda: lines[3]||'', date: lines[4]||'' });
      }
    });
    if (blocks.length) {
      console.log("Parsed with block parser:", blocks.length, "rows");
      return blocks;
    }

    throw new Error("No table or list-like data found on page.");
  } catch (err) {
    throw err;
  }
}

// ---------- sheet read/write helpers ----------
async function readSheet() {
  if (!sheets) throw new Error("Sheets client not initialized (missing auth).");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    key: GOOGLE_API_KEY || undefined
  });
  return res.data.values || [];
}
async function writeSheet(values) {
  if (!sheets) throw new Error("Sheets client not initialized (missing auth).");
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  console.log("Sheet updated: rows=", values.length);
}

// ---------- utility to match IPO in sheet ----------
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

// ---------- MAIN ----------
(async () => {
  try {
    if (SOURCE_LIST.length === 0) {
      throw new Error("No source URLs provided. Set GMP_SOURCE_URLS secret with newline-separated URLs.");
    }

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

    // Print what we found — TEST_MODE will exit before writes
    console.log("=== SCRAPED ROWS PREVIEW ===");
    showSample(scraped, 20);
    console.log("Total scraped rows:", scraped.length);

    if (TEST_MODE) {
      console.log("TEST_MODE is true. Exiting before any sheet read/write.");
      process.exit(0);
    }

    // --- will run only if TEST_MODE is false ---
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

    // optional Type fill from NSE/BSE
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

// ---------- helper used in Type fetch ----------
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
