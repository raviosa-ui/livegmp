/**
 * FINAL — FULLY FIXED populate_sheet.js
 * --------------------------------------
 * Node 20 compatible
 * Cheerio fixed
 * JSON auto-discovery for Investorgain
 * Strong HTML table detection
 * Retry logic
 * Local file support
 * TEST_MODE (no write)
 * Google Sheets integration
 * --------------------------------------
 */

const fs = require("fs").promises;
const { load } = require("cheerio");                   // ✔ Correct Cheerio import
const { google } = require("googleapis");

// ========== ENVIRONMENT ====================================================

const RAW_SA_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_RAW || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const RAW_SOURCES = (process.env.GMP_SOURCE_URLS || "").trim();
const SOURCE_LIST = RAW_SOURCES.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "";
const FILL_TYPE_FROM_NSE =
    (process.env.FILL_TYPE_FROM_NSE || "false").toLowerCase() === "true";
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
const TEST_MODE =
    (process.env.TEST_MODE || "false").toLowerCase() === "true";

// ========== LOAD SERVICE ACCOUNT ===========================================

let CLIENT_EMAIL = "";
let PRIVATE_KEY = "";

try {
    const parsed = JSON.parse(RAW_SA_JSON);
    CLIENT_EMAIL = parsed.client_email;
    PRIVATE_KEY = parsed.private_key.replace(/\\n/g, "\n");
    console.log("Service Account JSON loaded.");
} catch (e) {
    console.error("❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_RAW");
    process.exit(1);
}

// ========== GOOGLE SHEETS AUTH =============================================

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
    console.error("❌ Failed to initialize Google Sheets auth", e.message);
    process.exit(1);
}

// ========== HELPERS ========================================================

function esc(s) {
    return String(s === undefined || s === null ? "" : s).trim();
}

async function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ========== FETCH (HTML/JSON) WITH RETRIES =================================

async function fetchHtmlOrJson(url, attempts = 3) {
    // Local file support
    if (url.startsWith("/") && !url.startsWith("http")) {
        const text = await fs.readFile(url, "utf8");
        return { text, contentType: "text/html" };
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
            console.log(`fetchHtml attempt ${i} failed for ${url}: ${e.message}`);
            await wait(800);
        }
    }

    throw new Error(`Failed to fetch ${url}`);
}

// ========== INVESTORGAIN JSON PARSER =======================================

async function parseInvestorgainJSON(url) {
    const r = await fetchHtmlOrJson(url);
    let j;

    try {
        j = JSON.parse(r.text);
    } catch {
        throw new Error("Invalid JSON");
    }

    const rows =
        j?.pageProps?.reportdata?.tabledata ||
        j?.props?.pageProps?.reportdata?.tabledata ||
        null;

    if (!Array.isArray(rows)) {
        throw new Error("Unrecognized JSON structure");
    }

    return rows.map(r => ({
        ipo: esc(r.companyname),
        gmp: esc(r.gmp),
        kostak: esc(r.kostak),
        subjecttosauda: esc(r.subjecttosauda),
        date: esc(r.daterange)
    }));
}

// ========== AUTO-DISCOVER _next/data URL ===================================

function discoverNextJSON(html, baseUrl) {
    const regex = /\/_next\/data\/[^"']+?\/report\/live-ipo-gmp\/331\/ipo\.json/;
    const match = html.match(regex);
    if (match) {
        const base = new URL(baseUrl);
        return base.origin + match[0];
    }
    return null;
}

// ========== SMART HTML TABLE PARSER ========================================

function parseHTMLTable(html) {
    const $ = load(html);

    const useful = [
        "gmp", "ipo", "company", "name",
        "premium", "kostak", "sauda",
        "subject", "date", "status", "type"
    ];

    const tables = [];

    $("table").each((i, table) => {
        const $table = $(table);
        const firstRow = $table.find("tr").first();

        const headerTexts = [];

        const ths = firstRow.find("th");
        if (ths.length) {
            ths.each((j, th) => headerTexts.push(esc($(th).text()).toLowerCase()));
        } else {
            firstRow.find("td").each((j, td) =>
                headerTexts.push(esc($(td).text()).toLowerCase())
            );
        }

        let score = 0;
        for (const h of headerTexts) {
            for (const u of useful) {
                if (h.includes(u)) score += 1;
            }
        }

        tables.push({
            score,
            rows: $table.find("tr").length,
            $table
        });
    });

    // Prefer semantic matches
    const semantic = tables.filter(t => t.score > 0);
    if (semantic.length) {
        semantic.sort((a, b) => b.score - a.score || b.rows - a.rows);
        return extractTableRows(semantic[0].$table);
    }

    // Fallback: largest table
    tables.sort((a, b) => b.rows - a.rows);
    if (tables.length && tables[0].rows > 1) {
        return extractTableRows(tables[0].$table);
    }

    return [];
}

function extractTableRows($table) {
    const $ = load(""); // dummy cheerio context
    const rows = [];

    $table.find("tr").slice(1).each((i, tr) => {
        const cells = $table.find("tr").eq(i + 1).find("td");
        if (!cells.length) return;

        const parts = [];
        cells.each((idx, td) => parts.push(esc(load(td).text())));

        rows.push({
            ipo: parts[0] || "",
            gmp: parts[1] || "",
            kostak: parts[2] || "",
            subjecttosauda: parts[3] || "",
            date: parts[4] || ""
        });
    });

    return rows;
}

// ========== MASTER PARSER ==================================================

async function parseSource(url) {
    if (!url) return [];

    // direct JSON
    if (url.endsWith(".json")) {
        console.log("Trying direct JSON:", url);
        try {
            return await parseInvestorgainJSON(url);
        } catch (e) {
            console.log("JSON failed:", e.message);
        }
    }

    // HTML
    const r = await fetchHtmlOrJson(url);
    const html = r.text;

    console.log(`--- HTML fetched, length: ${html.length} ---`);
    console.log(html.substring(0, 400));
    console.log("--- END PREVIEW ---");

    // discover JSON inside HTML
    const discovered = discoverNextJSON(html, url);
    if (discovered) {
        console.log("Found JSON API:", discovered);
        try {
            return await parseInvestorgainJSON(discovered);
        } catch (e) {
            console.log("Discovered JSON failed:", e.message);
        }
    }

    // HTML table fallback
    const tableRows = parseHTMLTable(html);
    if (tableRows.length) {
        console.log("Parsed HTML table:", tableRows.length, "rows");
        return tableRows;
    }

    throw new Error("No data parsed from HTML or JSON");
}

// ========== SHEET READ/WRITE ===============================================

async function readSheet() {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: "Sheet1",
        key: GOOGLE_API_KEY || undefined
    });
    return res.data.values || [];
}

async function writeSheet(values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sheet1",
        valueInputOption: "RAW",
        requestBody: { values }
    });
    console.log("Sheet updated.", values.length, "rows");
}

// ========== MAIN ===========================================================

(async () => {
    try {
        if (!SOURCE_LIST.length) throw new Error("No source URLs in GMP_SOURCE_URLS");

        let scraped = [];

        for (const url of SOURCE_LIST) {
            try {
                console.log("Trying:", url);
                scraped = await parseSource(url);
                if (scraped.length) break;
            } catch (e) {
                console.log("Failed:", url, e.message);
            }
        }

        if (!scraped.length) throw new Error("Nothing parsed.");

        console.log("=== SCRAPED ROWS PREVIEW ===");
        console.log(JSON.stringify(scraped.slice(0, 20), null, 2));

        if (TEST_MODE) {
            console.log("TEST_MODE true → stopping before Sheet write.");
            return;
        }

        // ========== MERGE INTO SHEET ==========
        const sheet = await readSheet();
        if (!sheet.length) throw new Error("Sheet1 is empty.");

        const headers = sheet[0];
        const colMap = {};

        headers.forEach((h, i) => {
            colMap[h.toLowerCase()] = i;
        });

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

        for (const row of scraped) {
            const ipo = row.ipo.toLowerCase();
            let idx = sheet.findIndex(r => (r[0] || "").toLowerCase() === ipo);

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
                const existing = sheet[idx];
                existing[colMap["gmp"]] = row.gmp;
                existing[colMap["kostak"]] = row.kostak;
                existing[colMap["subjecttosauda"]] = row.subjecttosauda;
                existing[colMap["date"]] = row.date;
            }
        }

        await writeSheet(sheet);

    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    }
})();
