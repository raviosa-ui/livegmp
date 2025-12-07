const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

// Use native fetch if available (Node 18+), otherwise fallback to node-fetch
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)));

// --- CONFIGURATION ---
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT1lXkB8nKj8hF0gJ_rZfyW7x-M7Gz1t9L-uE5h/pub?output=csv"; 
const TARGET_FILE = path.join(__dirname, 'index.html');
const MAX_PER_GROUP = 10;

// --- HELPERS ---

// Parse GMP value (e.g. "₹90") to number for sorting
const parseGMPValue = (val) => {
  if (!val) return -999999;
  const cleaned = val.toString().replace(/[₹,]/g, '').trim();
  if (cleaned === '–' || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

// Parse dates like "12-14 Feb", "28 Feb"
// Returns { start: Date|null, end: Date|null }
const parseDateRange = (dateStr) => {
  if (!dateStr) return { start: null, end: null };
  const str = dateStr.toLowerCase();
  
  // Non-date strings
  if (str.includes('coming') || str.includes('soon') || str.includes('tba')) {
    return { start: null, end: null };
  }

  try {
    const currentYear = new Date().getFullYear();
    // Remove year if exists to avoid double year issues
    let clean = dateStr.replace(new RegExp(currentYear, 'g'), '').trim();
    // Split by "-"
    const parts = clean.split('-').map(s => s.trim());
    
    // Regex to capture Day and Month (e.g. "14" and "Feb")
    const dateRegex = /([0-9]+)[\s-]*([a-zA-Z]+)/;

    if (parts.length === 2) {
      // Range: "12" - "14 Feb"
      const startText = parts[0];
      const endText = parts[1];
      
      const endMatch = endText.match(dateRegex);
      if (endMatch) {
        const day = endMatch[1];
        const month = endMatch[2];
        const end = new Date(`${day} ${month} ${currentYear}`);
        
        // Try to find month in start, else use end month
        const startMatch = startText.match(dateRegex);
        let start;
        if (startMatch && startMatch[2]) {
           start = new Date(`${startText} ${currentYear}`);
        } else {
           // Just day number in start
           start = new Date(`${startText} ${month} ${currentYear}`);
        }
        return { start, end };
      }
    } else if (parts.length === 1) {
      // Single date: "28 Feb"
      const match = parts[0].match(dateRegex);
      if (match) {
        const d = new Date(`${match[1]} ${match[2]} ${currentYear}`);
        return { start: d, end: d };
      }
    }
  } catch (e) {
    // console.log('Date parse error', e);
  }
  return { start: null, end: null };
};

// Determine status based on parsed dates
const getStatus = (row) => {
  // 1. Trust explicit Status column if present and valid
  if (row.Status) {
    const s = row.Status.toLowerCase().trim();
    if (['active', 'upcoming', 'closed'].includes(s)) return s;
  }

  // 2. Parse Date
  const { start, end } = parseDateRange(row.Date);
  
  // If no date parseable, assume upcoming
  if (!start || !end) return 'upcoming';

  // 3. Compare with Today
  const now = new Date();
  now.setHours(0,0,0,0);
  start.setHours(0,0,0,0);
  end.setHours(0,0,0,0);

  if (end < now) return 'closed'; // Date passed
  if (start <= now && end >= now) return 'active'; // Currently in range
  if (start > now) return 'upcoming'; // Future
  
  return 'upcoming';
};

const generateCardHTML = (row) => {
  const name = row.IPO || 'Unknown IPO';
  const gmp = row.GMP || '₹0';
  const date = row.Date || 'TBA';
  const price = row.Kostak || 'N/A'; // "IPO Price"
  const gain = row.SubjectToSauda || 'N/A'; // "Listing Gain"
  const type = row.Type || 'Mainline';
  const status = row.derivedStatus; // calculated previously

  const gmpVal = parseGMPValue(gmp);
  const trendClass = gmpVal > 0 ? 'text-green' : (gmpVal < 0 ? 'text-red' : 'text-neutral');

  return `
    <div class="ipo-card" data-status="${status}">
      <div class="card-row-header">
        <div class="ipo-info">
          <h3 class="ipo-name">${name}</h3>
          <span class="ipo-date">${date}</span>
        </div>
        <div class="ipo-stats">
          <div class="gmp-val ${trendClass}">${gmp}</div>
          <div class="status-badge status-${status}">${status.toUpperCase()}</div>
        </div>
      </div>
      <div class="card-row-details" aria-hidden="true">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="label">IPO Price</span>
            <span class="value">${price}</span>
          </div>
          <div class="detail-item">
            <span class="label">Listing Gain</span>
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

// --- MAIN ---
async function updateGMP() {
  try {
    console.log('Fetching CSV from Google Sheets...');
    const response = await fetch(CSV_URL);
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const csvText = await response.text();

    console.log('Parsing CSV...');
    const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    
    // Process Data
    let items = result.data.map(row => {
      // Map legacy columns if needed, already standard in user provided sheet
      return { ...row, derivedStatus: getStatus(row) };
    });

    // Sort function (High to Low GMP)
    const sortFn = (a, b) => parseGMPValue(b.GMP) - parseGMPValue(a.GMP);

    // Group and Limit
    const active = items.filter(i => i.derivedStatus === 'active').sort(sortFn).slice(0, MAX_PER_GROUP);
    const upcoming = items.filter(i => i.derivedStatus === 'upcoming').sort(sortFn).slice(0, MAX_PER_GROUP);
    const closed = items.filter(i => i.derivedStatus === 'closed').sort(sortFn).slice(0, MAX_PER_GROUP);

    console.log(`Counts -> Active: ${active.length}, Upcoming: ${upcoming.length}, Closed: ${closed.length}`);

    // Combine for display (Active first, then Upcoming, then Closed)
    // Note: User can filter via UI buttons. Initial view is limited "All".
    const displayItems = [...active, ...upcoming, ...closed];

    const cardsHTML = displayItems.map(generateCardHTML).join('\n');

    // Build Wrapper
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const finalHTML = `
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
          <button id="load-more-btn">Load More IPOs</button>
        </div>
        
        <div class="last-updated-ts" style="text-align:center; font-size:12px; color:#666; margin-top:15px; opacity:0.7;">
          Last Updated: ${timestamp}
        </div>
      </div>
    `;

    // Inject into index.html
    console.log(`Writing to ${TARGET_FILE}...`);
    const htmlContent = fs.readFileSync(TARGET_FILE, 'utf-8');
    
    const startMarker = '<!-- === DO NOT REMOVE === -->';
    const endMarker = '<!-- === DO NOT REMOVE === -->';
    
    // Use callback in replace to avoid issues if finalHTML contains '$' characters
    // Regex matches the markers and everything in between
    const regex = new RegExp(`(${startMarker})([\\s\\S]*?)(${endMarker})`);
    
    if (!regex.test(htmlContent)) {
      throw new Error('Markers not found in index.html');
    }

    const newContent = htmlContent.replace(regex, (match, p1, p2, p3) => {
      return `${p1}\n${finalHTML}\n${p3}`;
    });

    fs.writeFileSync(TARGET_FILE, newContent, 'utf-8');
    console.log('Success! index.html updated.');

  } catch (error) {
    console.error('FAILED to update GMP:', error);
    process.exit(1);
  }
}

updateGMP();
