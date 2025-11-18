// scripts/debug_sheets_auth.js
if (typeof File === "undefined") {
  try {
    const { Blob } = require("buffer");
    class FilePoly extends Blob { constructor(chunks,name='',opts={}){ super(chunks,opts); this.name=name; } get [Symbol.toStringTag](){ return "File"; } }
    global.File = FilePoly; global.Blob = Blob;
  } catch(e){}
}
const { google } = require('googleapis');
// Use the new Base64 secret
const RAW_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || ""; 
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";

let client_email = process.env.GOOGLE_CLIENT_EMAIL || "";
let private_key = process.env.GOOGLE_PRIVATE_KEY || "";
let RAW = ""; // Will hold decoded JSON string

if (RAW_B64) {
    try {
        // Decode the Base64 string into the JSON content
        RAW = Buffer.from(RAW_B64, 'base64').toString('utf8');
    } catch(e) {
        console.error('Failed to decode Base64 service json:', e && e.message);
        process.exit(2);
    }
} else {
    // Fallback/Original
    RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
}

if (RAW) {
  try { 
    const p = JSON.parse(RAW); 
    client_email = p.client_email || client_email;
    private_key = p.private_key || private_key; 
  }
  catch(e){ 
    console.error('Failed to parse service json:', e && e.message); 
    process.exit(2); 
  }
}

console.log('DEBUG: client_email =', client_email || '(missing)');
console.log('DEBUG: sheetId =', SHEET_ID || '(missing)');
if (!client_email || !private_key || !SHEET_ID) {
  console.error('Missing one of client_email / private_key / sheet id. Check secrets.');
  process.exit(2);
}

(async ()=>{
  try {
    const jwt = new google.auth.JWT(client_email, null, private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: jwt });
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    console.log('Sheets API success — title:', res.data && res.data.properties && res.data.properties.title);
    process.exit(0);
  } catch (err) {
    console.error('Sheets API error (message):', err && err.message ? err.message : err);
    if (err && err.response && err.response.data) {
      console.error('Sheets API response data:', JSON.stringify(err.response.data));
    }
    process.exit(1);
  }
})();
