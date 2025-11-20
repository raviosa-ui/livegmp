/**
 * populate_sheet.js
 * --------------------------------------
 * FIXED VERSION — WORKS WITH NODE 20
 * CHEERIO CORRECTLY IMPORTED
 * HTML & JSON PARSING WORK
 * AUTO-DETECTS _next/data/*.json
 * RETRY LOGIC INCLUDED
 * TEST_MODE SUPPORTED
 * --------------------------------------
 */

const fs = require("fs").promises;
const { load } = require("cheerio"); // ✅ Correct Cheerio import
const { google } = require("googleapis");

// -------------------- ENV -----------------------
const RAW_SA_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_RAW || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "";
const FILL_TYPE_FROM_NSE = (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";

let CLIENT_EMAIL = "";
let PRIVATE_KEY = "";

// -------------------- PARSE KEY ------------------
try {
    const parsed = JSON.parse(RAW_SA_JSON);
    CLIENT_EMAIL = parsed.client_email;
    PRIVATE_KEY = parsed.private_key.replace(/\\n/g, "\n");
    console.log("Service Account JSON loaded.");
} catch (e) {
    console.error("❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_RAW");
    process.exit(1);
}

// -------------------- AUTH -----------------------
let sheets = null;

try {
    const auth = new google.auth.JWT(
        CLIENT_EMAIL,
        null,
        PRIVATE_KEY,
        ["https://www.googleapis.com/auth/spreadsheets"]
    );
    sheets = google.sheets({ version: "v4", auth });
} catch (e) {
    console.error("❌ Failed to initialize Google Sheets auth");
    process.exit(1);
}

// -------------------- HELPERS --------------------
function esc(s) {
    return String(s === undefined || s === null ? "" : s).trim();
}

async function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// -------------------- FETCH HTML or JSON --------------------
async function fetchHtmlOrJson(url, attempts = 3) {
    // Allow local file
    if (url.startsWith("/") && !url.startsWith("http")) {
        const t = await fs.readFile(url, "utf8");
        return { text: t, contentType: "text/html" };
    }

    for (let i = 1; i <= attempts; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 LiveGMPBot",
                    "Accept": "*/*"
                }
            });

            const text = await res.text();
            const contentType = res.headers.get("content-type") || "";

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            return { text, contentType };
        } catch (e) {
            console.log(`fetchHtml attempt ${i} failed: ${e.message}`);
            await wait(800);
        }
    }
    throw new Error(`Failed to fetch ${url}`);
}

// ---------------- JSON PARSER (Investorgain) ----------------
async function parseInvestorgainJSON(url) {
    const r = await fetchHtmlOrJson(url);
    let j;

    try {
        j = JSON.parse(r.text);
    } catch {
        throw new Error("Invalid JSON");
    }

    // Try known paths
    const rows =
        j?.pageProps?.reportdata?.tabledata ||
        j?.props?.pageProps?.reportdata?.tabledata ||
        null;

    if (!Array.isArray(rows)) {
        throw new Error("JSON structure not recognized");
    }

    return rows.map(r => ({
        ipo: esc(r.companyname),
        gmp: esc(r.gmp),
        kostak: esc(r.kostak),
        subjecttosauda: esc(r.subjecttosauda),
        date: esc(r.daterange)
    }));
}

// ---------------- FIND _next/data JSON URL -----------------
function discoverNextJSON(html, base) {
    const m = html.match(/\/_next\/data\/[^"']+?\/report\/live-ipo-gmp\/331\/ipo\.json/);
    if (m) {
        const baseURL = new URL(base);
        return baseURL.origin + m[0];
    }
    return null;
}

// ---------------- GENERIC TABLE PARSER ----------------------
function parseHTMLTable(html) {
    const $ = load(html);

    let largest = null;
    let maxRows = 0;

    $("table").each((i, t) => {
        const rows = $(t).find("tr").length;
        if (rows > maxRows) {
            maxRows = rows;
            largest = $(t);
        }
    });

    if (!largest) return [];

    const rows = [];
    largest.find("tr").slice(1).each((i, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2) return;

        rows.push({
            ipo: esc($(cells[0]).text()),
            gmp: esc($(cells[1]).text()),
            kostak: esc($(cells[2]).text()),
            subjecttosauda: esc($(cells[3]).text()),
            date: ""
        });
    });

    return rows;
}

// ---------------- MASTER PARSER ----------------------------
async function parseSource(url) {
    // Direct JSON
    if (url.endsWith(".json")) {
        console.log("Trying direct JSON:", url);
        return await parseInvestorgainJSON(url);
    }

    // HTML fallback
    const r = await fetchHtmlOrJson(url);
    const html = r.text;

    console.log(`--- HTML fetched from ${url}, length: ${html.length} ---`);
    console.log(html.substring(0, 400));
    console.log("--- END PREVIEW ---");

    // Auto-discover JSON inside HTML
    const discovered = discoverNextJSON(html, url);
    if (discovered) {
        console.log("Discovered JSON API →", discovered);
        try {
            return await parseInvestorgainJSON(discovered);
        } catch {}
    }

    // HTML table parser (works for W3Schools)
    const table = parseHTMLTable(html);
    if (table.length) {
        console.log("Parsed HTML table:", table.length, "rows");
        return table;
    }

    throw new Error("No data parsed");
}

// ---------------- READ SHEET -------------------------------
async function readSheet() {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "Sheet1",
        key: GOOGLE_API_KEY || undefined
    });
    return res.data.values || [];
}

// ---------------- WRITE SHEET ------------------------------
async function writeSheet(values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1",
        valueInputOption: "RAW",
        requestBody: { values }
    });
    console.log("Sheet updated:", values.length, "rows");
}

// ---------------- MAIN LOGIC -------------------------------
(async () => {
    try {
        if (!SOURCE_LIST.length) throw new Error("No sources in GMP_SOURCE_URLS");

        let scraped = null;

        for (const url of SOURCE_LIST) {
            try {
                console.log("Trying:", url);
                scraped = await parseSource(url);
                if (scraped.length) break;
            } catch (e) {
                console.log("Failed:", e.message);
            }
        }

        if (!scraped || !scraped.length) throw new Error("No rows parsed");

        console.log("=== SCRAPED ROWS PREVIEW ===");
        console.log(JSON.stringify(scraped.slice(0, 10), null, 2));

        if (TEST_MODE) {
            console.log("TEST_MODE true → stopping before sheet write.");
            return;
        }

        const sheet = await readSheet();
        if (!sheet.length) throw new Error("Sheet1 is empty");

        // Header logic
        const headers = sheet[0];
        const colMap = {};
        headers.forEach((h, i) => colMap[h.toLowerCase()] = i);

        const ensure = name => {
            if (colMap[name] === undefined) {
                colMap[name] = headers.length;
                headers.push(name);
                sheet[0].push(name);
            }
        };

        ensure("ipo");
        ensure("gmp");
        ensure("kostak");
        ensure("subjecttosauda");
        ensure("date");
        ensure("status");
        ensure("type");

        // Merge rows
        for (const row of scraped) {
            const ipoName = row.ipo.toLowerCase();
            let idx = sheet.findIndex(r => (r[0] || "").toLowerCase() === ipoName);

            if (idx === -1) {
                const newRow = new Array(headers.length).fill("");
                newRow[colMap["ipo"]] = row.ipo;
                newRow[colMap["gmp"]] = row.gmp;
                newRow[colMap["kostak"]] = row.kostak;
                newRow[colMap["subjecttosauda"]] = row.subjecttosauda;
                newRow[colMap["date"]] = row.date;
                newRow[colMap["status"]] = "";
                newRow[colMap["type"]] = DEFAULT_TYPE || "";
                sheet.push(newRow);
            } else {
                const r = sheet[idx];
                r[colMap["gmp"]] = row.gmp;
                r[colMap["kostak"]] = row.kostak;
                r[colMap["subjecttosauda"]] = row.subjecttosauda;
                r[colMap["date"]] = row.date;
            }
        }

        await writeSheet(sheet);
    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
})();
