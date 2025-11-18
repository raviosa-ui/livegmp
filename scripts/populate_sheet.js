// scripts/populate_sheet.js
// Robust single-file that accepts either:
// - GOOGLE_SERVICE_ACCOUNT_JSON (the full downloaded JSON) OR
// - GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (separate secrets)
// Uses Node18 global fetch, polyfills File/Blob for undici, scrapes pages and updates Google Sheet.

/////////////////////
// polyfill for File/Blob (prevents undici crash)
/////////////////////
if (typeof File === "undefined") {
  try {
    const { Blob } = require("buffer");
    class FilePoly extends Blob {
      constructor(chunks, name = "", opts = {}) {
        super(chunks, opts);
        this.name = name;
        this.lastModified = opts.lastModified || Date.now();
      }
      get [Symbol.toStringTag]() {
        return "File";
      }
    }
    global.File = FilePoly;
    global.Blob = Blob;
  } catch (err) {
    console.log("Polyfill load error (ignored):", err && err.message ? err.message : err);
  }
}

/////////////////////
// imports
/////////////////////
const cheerio = require("cheerio");
const { google } = require("googleapis");

/////////////////////
// read credentials (supports two methods)
/////////////////////
const SHEET_ID = process.env.GOOGLE_SHEET_ID || process.env.SHEET_ID || "";
const RAW_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
let CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || "";
let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";

// If full JSON is provided, parse it and extract client_email/private_key
if (RAW_SA_JSON && !CLIENT_EMAIL) {
  try {
    const parsed = JSON.parse(RAW_SA_JSON);
    CLIENT_EMAIL = parsed.client_email || CLIENT_EMAIL;
    PRIVATE_KEY = parsed.private_key || PRIVATE_KEY;
  } catch (e) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", e && e.message ? e.message : e);
  }
}

// Some workflows store the private key with escaped newlines — unescape
if (PRIVATE_KEY && PRIVATE_KEY.indexOf("\\n") !== -1) {
  PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, "\n");
}

// Very small required-check
if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("❌ Missing Google API secrets. Ensure GOOGLE_SERVICE_ACCOUNT_JSON (or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY) and GOOGLE_SHEET_ID are set.");
  process.exit(1);
}

/////////////////////
// config
/////////////////////
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "Mainboard";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || process.env.GMP_SOURCE_URL || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
if (SOURCE_LIST.length === 0) {
  console.error("❌ No sources provided. Set GMP_SOURCE_URLS or GMP_SOURCE_URL in GitHub secrets.");
  process.exit(1);
}

/////////////////////
// Google auth
/////////////////////
const jwtClient = new google.auth.JWT(
  CLIENT_EMAIL,
  null,
  PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth: jwtClient });

/////////////////////
// small helpers
/////////////////////
function esc(s = "") { return String(s === null || s === undefined ? "" : s).trim(); }
function normalizeHeader(h) { return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); }
function showSample(rows, n = 6) { try { console.log("Parsed rows sample:", JSON.stringify(rows.slice(0, n), null, 2)); } catch (e) {} }

/////////////////////
// fetch + parse functions
/////////////////////
async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0 (LiveGMPBot/1.0)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.text();
}

async function fetchTableRows(url) {
  console.log("Trying to fetch & parse:", url);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Try to find table mentioning gmp/kostak/sauda
  let $table = null;
  $("table").each((i, t) => {
    const txt = $(t).text().toLowerCase();
    if (txt.includes("gmp") || txt.includes("kostak") || txt.includes("sauda") || txt.includes("grey")) {
      if (!$table) $table = $(t);
    }
  });

  // fallback: heading-related table
  if (!$table) {
    const heading = $("h1,h2,h3").filter((i,el) => /gmp|grey market premium|live ipo gmp/i.test($(el).text())).first();
    if (heading && heading.length) {
      const nt = heading.nextAll("table").first();
      if (nt && nt.length) $table = nt;
      else {
        const pt = heading.parent().find("table").first();
        if (pt && pt.length) $table = pt;
      }
    }
  }

  // fallback: largest table
  if (!$table) {
    let max = 0, best = null;
    $("table").each((i, t) => {
      const rows = $(t).find("tr").length;
      if (rows > max) { max = rows; best = $(t); }
    });
    if (best && max > 1) $table = best;
  }

  // fallback: div/list
  if (!$table) {
    const cands = $("div,section").filter((i,el) => {
      const t = $(el).text().toLowerCase();
      return t.includes("gmp") || t.includes("kostak") || t.includes("sauda") || t.includes("ipo");
    });
    if (cands.length) {
      const c = cands.first();
      const rows = [];
      c.children().each((i, ch) => {
        const txt = $(ch).text().trim();
        if (!txt) return;
        const parts = txt.split("\n").map(x => x.trim()).filter(Boolean);
        if (parts.length >= 2) {
          rows.push({ ipo: parts[0] || "", gmp: parts[1] || "", kostak: parts[2] || "", subjecttosauda: parts[3] || "", date: parts[4] || "" });
        }
      });
      if (rows.length) {
        return rows.map(r => {
          const out = {};
          for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]);
          return out;
        });
      }
    }
    throw new Error("No table or list-like data found on page.");
  }

  // parse table rows
  const headers = [];
  let headerCells = $table.find("tr").first().find("th");
  if (!headerCells || headerCells.length === 0) headerCells = $table.find("tr").first().find("td");
  headerCells.each((i, cell) => headers.push(normalizeHeader(esc(cheerio(cell).text ? cheerio(cell).text() : cheerio(cell).text()))));

  const usefulKeywords = ["gmp","ipo","name","company","kostak","sauda","subject","date","status","type"];
  const hasUsefulHeader = headers.some(h => usefulKeywords.some(k => h.includes(k)));
  const usePositional = !hasUsefulHeader;

  const rows = [];
  $table.find("tr").slice(1).each((ri, tr) => {
    const $tr = $(tr);
    const cells = $tr.find("td");
    if (cells.length === 0) return;
    if (usePositional) {
      const parts = cells.map((i,td) => esc($(td).text())).get();
      const obj = { ipo: parts[0]||"", gmp: parts[1]||"", kostak: parts[2]||"", subjecttosauda: parts[3]||"", date: parts[4]||"" };
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

  if (!rows.length) throw new Error("No data rows parsed from selected table.");
  const normalized = rows.map(r => { const out = {}; for (const k of Object.keys(r)) out[normalizeHeader(k)] = esc(r[k]); return out; });
  showSample(normalized, 6);
  return normalized;
}

/////////////////////
// Exchange Type (best-effort)
/////////////////////
async function tryFetchTypeFromExchanges(ipoName) {
  try {
    if (!ipoName) return null;
    const nameLower = ipoName.toLowerCase();
    try {
      const r = await fetch("https://www.nseindia.com/market-data/all-upcoming-issues-ipo", { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) {
        const html = await r.text();
        if (html.toLowerCase().includes(nameLower)) return "Mainboard";
      }
    } catch(e) {}
    try {
      const r2 = await fetch("https://www.bseindia.com/publicissue.html", { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r2.ok) {
        const html2 = await r2.text();
        if (html2.toLowerCase().includes(nameLower)) return "Mainboard";
      }
    } catch(e) {}
    return null;
  } catch(e) { return null; }
}

/////////////////////
// Sheets read/write helpers
/////////////////////
async function readSheet() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Sheet1" });
  return res.data.values || [];
}
async function writeSheet(values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Sheet1",
    valueInputOption: "RAW",
    requestBody: { values }
  });
  console.log("Sheet updated: rows=", values.length);
}

/////////////////////
// merge logic + main
/////////////////////
function findMatchingRowIndex(sheetRows, ipoName) {
  if (!ipoName) return -1;
  ipoName = ipoName.toLowerCase();
  for (let i = 1; i < sheetRows.length; i++) {
    const cell = (sheetRows[i][0] || "").toString().toLowerCase();
    if (!cell) continue;
    if (cell === ipoName || cell.includes(ipoName) || ipoName.includes(cell)) return i;
  }
  return -1;
}

(async () => {
  try {
    // try all sources
    let scraped = [];
    for (const src of SOURCE_LIST) {
      try {
        scraped = await fetchTableRows(src);
        if (scraped && scraped.length) { console.log("Parsed from", src); break; }
      } catch (e) {
        console.warn("Source failed:", src, e && e.message ? e.message : e);
      }
    }
    if (!scraped || scraped.length === 0) throw new Error("No data parsed from any source.");

    const sheetVals = await readSheet();
    if (sheetVals.length === 0) throw new Error("Sheet is empty - ensure headers in row 1.");

    // header mapping
    const headersRow = sheetVals[0].map(h => String(h || "").trim());
    const headerMap = {};
    headersRow.forEach((h,i) => headerMap[h.toLowerCase()] = i);

    const expected = ["ipo","gmp","kostak","subjecttosauda","date","status","type"];
    for (const h of expected) {
      if (!(h in headerMap)) {
        headerMap[h] = headersRow.length;
        headersRow.push(h);
        sheetVals[0].push(h);
      }
    }

    for (const raw of scraped) {
      const keys = Object.keys(raw);
      let ipoKey = keys.find(k => k.includes("ipo") || k.includes("name") || k.includes("company")) || keys[0];
      const ipoName = (raw[ipoKey] || "").trim();
      if (!ipoName) continue;

      const normalized = {
        ipo: ipoName,
        gmp: (raw.gmp || raw.gmpvalue || raw.premium || "").toString().trim(),
        kostak: (raw.kostak || raw.kost || "").toString().trim(),
        subjecttosauda: (raw.subjecttosauda || raw.sauda || raw.subject || "").toString().trim(),
        date: (raw.date || raw.daterange || "").toString().trim()
      };

      const matchIdx = findMatchingRowIndex(sheetVals, ipoName);
      if (matchIdx >= 1) {
        const row = sheetVals[matchIdx];
        row[headerMap["gmp"]] = normalized.gmp || row[headerMap["gmp"]] || "";
        row[headerMap["kostak"]] = normalized.kostak || row[headerMap["kostak"]] || "";
        row[headerMap["subjecttosauda"]] = normalized.subjecttosauda || row[headerMap["subjecttosauda"]] || "";
        row[headerMap["date"]] = normalized.date || row[headerMap["date"]] || "";
      } else {
        const newRow = new Array(Object.keys(headerMap).length).fill("");
        newRow[headerMap["ipo"]] = normalized.ipo;
        newRow[headerMap["gmp"]] = normalized.gmp || "";
        newRow[headerMap["kostak"]] = normalized.kostak || "";
        newRow[headerMap["subjecttosauda"]] = normalized.subjecttosauda || "";
        newRow[headerMap["date"]] = normalized.date || "";
        newRow[headerMap["status"]] = "";
        newRow[headerMap["type"]] = "";
        sheetVals.push(newRow);
      }
    }

    // Fill missing Type values (NSE/BSE best-effort or default)
    if (FILL_TYPE_FROM_NSE) {
      console.log("Attempting NSE/BSE type lookup (best-effort).");
      for (let i = 1; i < sheetVals.length; i++) {
        try {
          const currType = (sheetVals[i][headerMap["type"]] || "").toString().trim();
          if (!currType) {
            const ipoName = (sheetVals[i][headerMap["ipo"]] || "").toString().trim();
            if (!ipoName) continue;
            const t = await tryFetchTypeFromExchanges(ipoName);
            if (t) sheetVals[i][headerMap["type"]] = t;
            else if (DEFAULT_TYPE) sheetVals[i][headerMap["type"]] = DEFAULT_TYPE;
          }
        } catch (e) {
          console.warn("Type lookup failed for row", i, e && e.message ? e.message : e);
          if (DEFAULT_TYPE && !sheetVals[i][headerMap["type"]]) sheetVals[i][headerMap["type"]] = DEFAULT_TYPE;
        }
      }
    } else if (DEFAULT_TYPE) {
      for (let i = 1; i < sheetVals.length; i++) {
        if (!sheetVals[i][headerMap["type"]] || sheetVals[i][headerMap["type"]].toString().trim() === "") {
          sheetVals[i][headerMap["type"]] = DEFAULT_TYPE;
        }
      }
    }

    await writeSheet(sheetVals);
    console.log("Done — sheet populated/updated from scraped source(s).");
  } catch (err) {
    console.error("ERROR:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
