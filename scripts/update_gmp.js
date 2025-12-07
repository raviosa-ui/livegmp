const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

// Use native fetch if available (Node 18+), otherwise fallback to node-fetch
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

// --- CONFIGURATION ---
// Prioritize Environment Variable for CI/CD, fallback to default for local dev (if valid)
const CSV_URL = process.env.GMP_SHEET_CSV_URL || "https://docs.google.com/spreadsheets/d/e/2PACX-1vT1lXkB8nKj8hF0gJ_rZfyW7x-M7Gz1t9L-uE5h/pub?output=csv";

// Resolve index.html path: checks current directory first, then parent directory
let TARGET_FILE = path.join(__dirname, 'index.html');
if (!fs.existsSync(TARGET_FILE)) {
  TARGET_FILE = path.join(__dirname, '../index.html');
}

const START_MARKER = '<!-- GMP_START -->';
const END_MARKER = '<!-- GMP_END -->';
const MAX_PER_GROUP = 50;

// --- HELPERS ---

const parseGMPValue = (val) => {
  if (!val) return -999999;
  const cleaned = val.toString().replace(/[₹,]/g, '').trim();
  if (cleaned === '–' || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

// --- ROBUST DATE PARSING ---
const MONTHS = {
  jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
  jul:6, aug:7, sep:8, oct:9, nov:10, dec:11
};

function tryParseDayMonthYear(token, defaultYear) {
  token = token.trim().replace(/\./g,'');
  const dashMatch = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (dashMatch) {
    const d = Number(dashMatch[1]);
    const m = Number(dashMatch[2]) - 1;
    const y = dashMatch[3] ? Number(dashMatch[3]) : defaultYear;
    return new Date(y, m, d);
  }
  const nameMatch = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (nameMatch) {
    const d = Number(nameMatch[1]);
    const mname = nameMatch[2].slice(0,3).toLowerCase();
    const m = MONTHS[mname];
    const y = nameMatch[3] ? Number(nameMatch[3]) : defaultYear;
    if (m !== undefined) return new Date(y, m, d);
  }
  return null;
}

function parseDateRange(text) {
  if (!text) return { start: null, end: null };
  const raw = String(text).trim();
  if (/tba|to be announced|not announced|n\/a/i.test(raw)) return { start:null, end:null };

  const norm = raw.replace(/\u2013|\u2014|–/g,'-').replace(/\s+to\s+/i,'-').replace(/\s*-\s*/,'-');
  const parts = norm.split(','); // handle "14 Nov, 2025"
  let main = parts[0].trim();
  let year = (parts[1] && /^\s*\d{4}\s*$/.test(parts[1])) ? Number(parts[1].trim()) : (new Date()).getFullYear();

  if (main.includes('-')) {
    const rangeParts = main.split('-').map(p => p.trim());
    const start = tryParseDayMonthYear(rangeParts[0], year);
    const end = tryParseDayMonthYear(rangeParts.slice(1).join('-'), year);
    return { start: start, end: end || start };
  } else {
    const single = tryParseDayMonthYear(main, year);
    return { start: single, end: single };
  }
}

const getStatus = (row) => {
  if (row.Status) {
    const s = row.Status.toLowerCase().trim();
    if (s.includes('active') || s.includes('open')) return 'active';
    if (s.includes('clos') || s.includes('list')) return 'closed';
    if (s.includes('upcom')) return 'upcoming';
  }
  const { start, end } = parseDateRange(row.Date);
  if (!start || !end) return 'upcoming';
  
  const now = new Date();
  // Normalize to midnight for fair comparison
  now.setHours(0,0,0,0);
  const s = new Date(start); s.setHours(0,0,0,0);
  const e = new Date(end); e.setHours(0,0,0,0);

  if (now < s) return 'upcoming';
  if (now >= s && now <= e) return 'active';
  if (now > e) return 'closed';
  return 'upcoming';
};

// --- HTML GENERATION ---

const generateCardHTML = (row) => {
  const name = row.IPO || 'Unknown IPO';
  const gmp = row.GMP || '₹0';
  const date = row.Date || 'TBA';
  const price = row.Kostak || '—';
  const gain = row.SubjectToSauda || '—';
  const type = row.Type || 'Mainline';
  const status = row.derivedStatus;

  const gmpVal = parseGMPValue(gmp);
  let gmpClass = 'text-neutral';
  if (gmpVal > 0) gmpClass = 'text-green';
  if (gmpVal < 0) gmpClass = 'text-red';

  return `
    <div class="ipo-card" data-status="${status}">
      <div class="card-row-header">
        <div class="ipo-info">
          <h3 class="ipo-name">${name}</h3>
          <span class="ipo-date">${date}</span>
        </div>
        <div class="ipo-stats">
          <div class="gmp-val ${gmpClass}">${gmp}</div>
          <div class="status-badge status-${status}">${status.toUpperCase()}</div>
        </div>
      </div>
      
      <!-- Hidden Details -->
      <div class="card-row-details" aria-hidden="true">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="label">IPO Price</span>
            <span class="value">${price}</span>
          </div>
          <div class="detail-item">
            <span class="label">Subject Sauda</span>
            <span class="value">${gain}</span>
          </div>
          <div class="detail-item">
            <span class="label">Type</span>
            <span class="value">${type}</span>
          </div>
        </div>
        <div class="click-hint">Click to collapse</div>
      </div>
    </div>`;
};

// --- MAIN FUNCTION ---
async function updateGMP() {
  try {
    console.log('Starting GMP Update...');
    console.log(`Using CSV Source: ${CSV_URL.startsWith('http') ? CSV_URL : 'Invalid URL'}`);
    console.log(`Target HTML File: ${TARGET_FILE}`);

    if (!CSV_URL) throw new Error('CSV_URL is not defined.');

    console.log('Fetching CSV...');
    const response = await fetch(CSV_URL);
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText} (${response.status})`);
    const csvText = await response.text();

    console.log('Parsing CSV...');
    const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    
    // Process Data
    let items = result.data.map(row => {
      // Normalize keys to handle case variations
      const normalizedRow = {
        IPO: row.IPO || row.Ipo || row.Name || '',
        GMP: row.GMP || row.Gmp || '',
        Date: row.Date || row.date || '',
        Kostak: row.Kostak || row.kostak || row['IPO Price'] || '',
        SubjectToSauda: row.SubjectToSauda || row.Sauda || '',
        Type: row.Type || row.type || '',
        Status: row.Status || row.status || ''
      };
      return { ...normalizedRow, derivedStatus: getStatus(normalizedRow) };
    });

    const sortFn = (a, b) => parseGMPValue(b.GMP) - parseGMPValue(a.GMP);

    const active = items.filter(i => i.derivedStatus === 'active').sort(sortFn);
    const upcoming = items.filter(i => i.derivedStatus === 'upcoming').sort(sortFn);
    const closed = items.filter(i => i.derivedStatus === 'closed').sort(sortFn);

    const displayItems = [...active, ...upcoming, ...closed];
    const cardsHTML = displayItems.map(generateCardHTML).join('\n');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // The Inner HTML Block
    const innerHTML = `
      <div id="gmp-wrapper">
        <div id="gmp-controls">
          <div class="filters">
            <button class="filter-btn active" data-filter="all">All</button>
            <button class="filter-btn" data-filter="active">Active</button>
            <button class="filter-btn" data-filter="upcoming">Upcoming</button>
            <button class="filter-btn" data-filter="closed">Closed</button>
          </div>
          <div class="update-timer">
             Update in: <span id="gmp-next-run">--:--</span>
          </div>
        </div>

        <div id="gmp-cards">
          ${cardsHTML}
        </div>

        <div id="load-more-wrap">
          <button id="load-more-btn">Load More</button>
        </div>
        
        <div class="last-updated-ts" style="text-align:center; font-size:12px; color:#666; margin-top:20px;">
          Last Updated: ${timestamp}
        </div>
      </div>
    `;

    console.log(`Reading index.html...`);
    let htmlContent = fs.readFileSync(TARGET_FILE, 'utf-8');
    
    // Strict replacement logic using Markers
    const regex = new RegExp(`(${START_MARKER})[\\s\\S]*?(${END_MARKER})`);
    
    if (regex.test(htmlContent)) {
      const newContent = htmlContent.replace(regex, `$1\n${innerHTML}\n$2`);
      fs.writeFileSync(TARGET_FILE, newContent, 'utf-8');
      console.log('Success! index.html updated cleanly.');
    } else {
      console.error('ERROR: Markers not found in index.html. Cannot inject content.');
      process.exit(1);
    }

  } catch (error) {
    console.error('FAILED to update GMP:', error);
    process.exit(1);
  }
}

updateGMP();
