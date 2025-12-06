const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
// Dynamic import for node-fetch to support both CJS and ESM environments
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- CONFIGURATION ---
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT1lXkB8nKj8hF0gJ_rZfyW7x-M7Gz1t9L-uE5h/pub?output=csv"; // Replace with your actual Published CSV link if different
const TARGET_FILE = path.join(__dirname, 'index.html');

// --- CONSTANTS ---
const MAX_ITEMS_PER_GROUP = 10;

// --- HELPERS ---

// Helper to parse currency/text into a number for sorting
const parseGMPValue = (val) => {
  if (!val) return -999999;
  const cleaned = val.toString().replace(/[₹,]/g, '').trim();
  if (cleaned === '–' || cleaned === '-') return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

// Helper to determine status based on Date string
// Assumes formats like "12-14 Feb", "28 Feb", "Coming Soon"
const determineStatus = (dateStr) => {
  if (!dateStr) return 'upcoming';
  const str = dateStr.toLowerCase();
  
  if (str.includes('coming') || str.includes('soon')) return 'upcoming';

  try {
    // Extract the latest date in the range (e.g., "12-14 Feb" -> "14 Feb")
    const parts = dateStr.split('-');
    const lastDatePart = parts[parts.length - 1].trim();

    // Append current year to make it parseable
    const currentYear = new Date().getFullYear();
    const dateObj = new Date(`${lastDatePart} ${currentYear}`);

    if (isNaN(dateObj.getTime())) return 'upcoming'; // Fallback if parse fails

    const now = new Date();
    // Reset time for pure date comparison
    now.setHours(0,0,0,0);
    dateObj.setHours(0,0,0,0);

    // If the date is today or strictly future -> Active/Upcoming distinction
    // Simplified logic: 
    // If date is in past -> Closed
    // If date is today or future -> Active (or check if it's very far in future for upcoming)
    
    if (dateObj < now) {
      return 'closed';
    } else {
      // If it's active today or in the future, we treat it as active/upcoming.
      // To distinguish strictly, we'd need Open vs Close dates. 
      // For this script, we'll mark non-past dates as 'active' unless explicitly 'upcoming'
      return 'active';
    }
  } catch (e) {
    return 'upcoming';
  }
};

// Generate the HTML for a single card
const generateCardHTML = (row) => {
  // Map CSV columns to Variables
  // CSV Headers: IPO, GMP, Date, Kostak, SubjectToSauda, Type
  const name = row.IPO || 'Unknown IPO';
  const gmp = row.GMP || '₹0';
  const date = row.Date || 'TBA';
  const price = row.Kostak || 'N/A'; // Renamed to IPO Price in UI
  const gain = row.SubjectToSauda || 'N/A'; // Renamed to Listing Gain in UI
  const type = row.Type || 'Mainline';
  
  // Calculate Status
  // Priority: If 'Status' column exists in CSV use it, otherwise compute
  let status = 'active';
  if (row.Status) {
    status = row.Status.toLowerCase();
  } else {
    status = determineStatus(date);
  }

  // Visual Class for GMP (green if positive)
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
      
      <!-- Hidden Details - Toggled by gmp-client.js -->
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
    </div>
  `;
};

// --- MAIN FUNCTION ---
async function updateGMP() {
  try {
    console.log('Fetching CSV...');
    const response = await fetch(CSV_URL);
    const csvText = await response.text();

    console.log('Parsing CSV...');
    const result = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    const data = result.data;
    console.log(`Found ${data.length} rows.`);

    // Sort by GMP descending
    data.sort((a, b) => parseGMPValue(b.GMP) - parseGMPValue(a.GMP));

    // Generate HTML Cards
    const cardsHTML = data.map(row => generateCardHTML(row)).join('\n');

    // Construct the Full Injection Block
    // This structure matches what gmp-client.js expects (IDs: gmp-controls, gmp-cards, load-more-btn)
    const finalHTML = `
      <div id="gmp-wrapper">
        <!-- Controls & Timer -->
        <div id="gmp-controls">
          <div class="filters">
            <button class="filter-btn active" data-filter="all">All</button>
            <button class="filter-btn" data-filter="active">Active</button>
            <button class="filter-btn" data-filter="upcoming">Upcoming</button>
            <button class="filter-btn" data-filter="closed">Closed</button>
          </div>
          <div class="update-timer">
            Next update: <span id="gmp-next-run">Calculating...</span>
          </div>
        </div>

        <!-- Cards Container -->
        <div id="gmp-cards">
          ${cardsHTML}
        </div>

        <!-- Load More Button -->
        <div id="load-more-wrap">
          <button id="load-more-btn">Load More IPOs</button>
        </div>
        
        <div class="last-updated-ts" style="text-align:center; font-size:12px; color:#666; margin-top:10px;">
          Last Updated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </div>
      </div>
    `;

    // Inject into index.html
    console.log('Reading index.html...');
    let htmlContent = fs.readFileSync(TARGET_FILE, 'utf-8');

    // Regex to find the block between the comments
    const regex = /(<!-- === DO NOT REMOVE === -->)([\s\S]*?)(<!-- === DO NOT REMOVE === -->)/;
    
    if (htmlContent.match(regex)) {
      const newContent = htmlContent.replace(regex, `$1\n${finalHTML}\n$3`);
      fs.writeFileSync(TARGET_FILE, newContent, 'utf-8');
      console.log('Successfully updated index.html with HTML structure.');
    } else {
      console.error('Error: Could not find <!-- === DO NOT REMOVE === --> markers in index.html');
    }

  } catch (error) {
    console.error('Error updating GMP:', error);
  }
}

updateGMP();
