
# Negative‑Check Web v2 (Windows‑friendly)

**What it does**
- Upload report (PDF/DOCX) that lists news URLs grouped by 8 keywords.
- Parses items like `1. ML  <Entity>` → reads `Title` + `URL` lines.
- Computes summary per keyword and exports Excel (6 columns).

**Keywords & Codes**
- ML: Money Laundering
- BR: Bribe
- CR: Corrupt
- FR: Fraud
- LI: Litigation
- AB: Abuse
- CA: Cartel
- EX1: Antitrust

**Run**
```powershell
cd server
npm install
# choose a port you like
$env:PORT=5050
node index.js
```
Open http://localhost:5050
