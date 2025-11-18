// scripts/debug_sheets_auth.js
if (typeof File === "undefined") {
  try {
    const { Blob } = require("buffer");
    class FilePoly extends Blob { constructor(chunks,name='',opts={}){ super(chunks,opts); this.name=name; } get [Symbol.toStringTag](){ return "File"; } }
    global.File = FilePoly; global.Blob = Blob;
  } catch(e){}
}

const { google } = require('googleapis');

const RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
let client_email = process.env.GOOGLE_CLIENT_EMAIL || "";
let private_key = process.env.GOOGLE_PRIVATE_KEY || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";

if (RAW && !client_email) {
  try { const p = JSON.parse(RAW); client_email = p.client_email; private_key = p.private_key; }
  catch(e){ console.error('Failed to parse service json:', e && e.message); process.exit(2); }
}
if (private_key && private_key.indexOf("\\n") !== -1) private_key = private_key.replace(/\\n/g, '\n');

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
