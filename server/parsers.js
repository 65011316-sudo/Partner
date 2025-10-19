import fs from 'fs';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

// ---- PDF/DOCX extraction ----
async function pdfParseLazy(buffer) {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = mod.default || mod;
  return pdfParse(buffer);
}
export async function extractTextFromPdf(filePath) {
  const data = fs.readFileSync(filePath);
  const pdf = await pdfParseLazy(data);
  return (pdf.text || '').replace(/\r/g,'');
}
export async function extractTextFromDocx(filePath) {
  const data = fs.readFileSync(filePath);
  const res = await mammoth.extractRawText({ buffer: data });
  return (res.value || '').replace(/\r/g,'');
}

// ---- Keywords & code map ----
export const KEYWORDS = [
  'Money Laundering','Bribe','Corrupt','Fraud','Litigation','Abuse','Cartel','Antitrust'
];
const CODE_TO_KEYWORD = {
  ML:'Money Laundering', BR:'Bribe', CR:'Corrupt', FR:'Fraud',
  LI:'Litigation', AB:'Abuse', CA:'Cartel', EX1:'Antitrust'
};
const VALID_CODES = new Set(Object.keys(CODE_TO_KEYWORD)); // ใช้กรอง code แปลก/หัวข้ออื่น
// ให้หยุดเฉพาะเมื่อเจอหัวรายการข่าวจริง (ML|BR|CR|FR|LI|AB|CA|EX1)
const ITEM_HEAD_RE = new RegExp(String.raw`^\\s*\\d+\\s*[.)-]?\\s*(?:${Array.from(VALID_CODES).join('|')})\\b`, 'i');

// ---- Negative-from-Title (conservative) ----
const YES_CUES = [
  /\b(indict(ed|ment)?|charge(d)?|sue(d)?|convict(ed|ion)?|plead(ed)?\s+guilty|arrest(ed)?|fined|penal(t|ty)|sanction(ed)?)\b/i,
  /\b(class\s+action|lawsuit|settlement)\b/i,
  /\b(bribe(ry)?|kickback|corrupt(ion)?|fraud|money\s+launder(ing|ed)|cartel|antitrust)\b.*\b(case|probe|investigation|alleg(ation|e|ed))\b/i
];
function isNegativeFromTitle(title='') {
  const t = title.toLowerCase();
  return YES_CUES.some(re => re.test(t));
}

// ---- Parser (extra-lenient) ----
export function parseReportEntries(rawText='') {
  const text  = rawText
    .replace(/\t/g,' ')
    .replace(/\u00A0/g,' ')
    .replace(/[ ]{2,}/g,' ');
  const lines = text.split('\n');

  const entries = [];
  let currKeyword = null;
  const kwHeads = new Set(KEYWORDS.map(k => k.toLowerCase()));

  // ตรวจว่าเป็น label ข้อมูลเสริมหรือไม่
  const isNonData = (s) => /^(finding|comment|co\s*clarification)\b/i.test(s);
  const isLabel   = (s) => /^(title|url|link|description|finding|comment|co\s*clarification)\b/i.test(s);

  // หยุดเมื่อเจอหัว item ถัดไป หรือหัวคีย์เวิร์ด
  const isNextItemHead = (s) => /^\s*\d+\s*[.)-]?\s*[A-Za-z0-9]{2,3}\b/.test(s);

    function readTitleAndUrl(start) {
        let title = '', url = '';
        let seenTitle = false;

        for (let j = start; j < Math.min(lines.length, start + 30); j++) {
            const L = (lines[j] || '').trim();
            if (!L) continue;

            // หยุดเมื่อเจอหัวข้อใหม่หรือคีย์เวิร์ดใหม่
            if (ITEM_HEAD_RE.test(L)) break;
            if (kwHeads.has(L.toLowerCase())) break;

            // ข้ามบรรทัดที่ไม่เกี่ยว
            if (/^(finding|comment|co\s*clarification)\b/i.test(L)) continue;

            // ✅ จับกรณี "1. Title" หรือ "Title" หรือ "1 Title"
            const mt = L.match(/^(?:\d+\.\s*)?(?:title)[:\-\s]*\s*(.*)$/i);
            if (mt) {
                seenTitle = true;
                if (mt[1]) title = mt[1].trim();
                continue;
            }

            // ถ้าบรรทัดก่อนหน้าเป็น Title แต่ไม่มีค่า → ใช้บรรทัดนี้เป็นชื่อข่าว
            if (seenTitle && !title && L && !/^(?:\d+\.\s*)?(url|link|finding|comment|co\s*clarification)\b/i.test(L)) {
                title = L;
                seenTitle = false;
                continue;
            }

            // ✅ จับกรณี "3. URL ..." หรือ "URL ..." หรือ "Link ..."
            const mu = L.match(/^(?:\d+\.\s*)?(?:url|link)[:\-\s]*\s*(https?:\/\/\S+)/i);
            if (mu && !url) {
                url = mu[1].trim();
                continue;
            }

            // ✅ เผื่อกรณี URL ไม่มี label
            if (!url) {
                const bare = L.match(/https?:\/\/\S+/i);
                if (bare) {
                    url = bare[0].trim();
                    continue;
                }
            }
        }

        return { title, url };
    }


  function pickEntityFromNextLines(start) {
    // ใช้เมื่อบรรทัดหัวไม่มี entity (เช่น entity อยู่บรรทัดถัด ๆ ไป)
    for (let j = start; j < Math.min(lines.length, start+5); j++) {
      const L = (lines[j] || '').trim();
      if (!L) continue;
      if (ITEM_HEAD_RE.test(L) || kwHeads.has(L.toLowerCase())) break;
      if (isLabel(L)) continue;
      return L; // บรรทัดที่ไม่ใช่ label ถือเป็น entity
    }
    return '';
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    if (!line) continue;

    // หัวคีย์เวิร์ด (บรรทัดสีส้ม)
    if (kwHeads.has(line.toLowerCase())) { currKeyword = line; continue; }

    // หัวรายการข่าว: ยอมรับ 1., 1), 1- แล้วตามด้วย CODE
    const m = line.match(/^\s*(\d+)\s*[.)-]?\s*([A-Za-z0-9]{2,3})\b(?:\s+(.*))?$/);
    if (!m) continue;

    const code = m[2].toUpperCase();
    if (code === 'CO') continue;            // ข้าม "CO Clarification"
    if (!VALID_CODES.has(code)) continue;   // ยอมรับเฉพาะ ML,BR,CR,FR,LI,AB,CA,EX1

    let entity  = (m[3] || '').trim();
    if (!entity || isLabel(entity)) {
      // entity อยู่บรรทัดถัดไป (เช่น "BJC Healthcare" อยู่บรรทัดแยก)
      const probe = pickEntityFromNextLines(i+1);
      if (probe) entity = probe;
    }
    if (!entity) entity = 'Unknown';

    const keyword = CODE_TO_KEYWORD[code] || currKeyword;
    const { title, url } = readTitleAndUrl(i+1);

    if (keyword && (title || url)) {
      entries.push({ keyword, entity, title: title || '', url: url || '' });
    }
  }

  // debug counter per keyword
  const debug = {}; KEYWORDS.forEach(k => debug[k] = 0);
  for (const e of entries) if (debug[e.keyword] !== undefined) debug[e.keyword]++;

  return { entries, debug };
}

// ---- Summary & Excel (unchanged) ----
export function buildSummary(entries) {
  const rows = KEYWORDS.map(k => ({ keyword:k, total:0, negative:0 }));
  const idx = Object.fromEntries(KEYWORDS.map((k,i)=>[k,i]));
  for (const e of entries) {
    if (!(e.keyword in idx)) continue;
    const i = idx[e.keyword];
    if (e.url) rows[i].total += 1;
    if (e.url && isNegativeFromTitle(e.title)) rows[i].negative += 1;
  }
  const totals = rows.reduce((a,r)=>({ total:a.total+r.total, negative:a.negative+r.negative }), { total:0, negative:0 });
  return { rows, totals };
}

export async function makeExcel(entries) {
  const wb = new ExcelJS.Workbook();
  const headers = ["No.","Person or legal entity","URL","Title","Negative found","Note"];
  const widths  = [6, 28, 50, 60, 16, 40];

  for (const k of KEYWORDS) {
    const ws = wb.addWorksheet(k);
    ws.views = [{ state:'frozen', ySplit:1 }];
    ws.autoFilter = { from:'A1', to:'F1' };
    ws.addRow(headers);
    const hdr = ws.getRow(1);
    hdr.font = { bold:true };
    hdr.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    for (let c=1;c<=6;c++) ws.getColumn(c).width = widths[c-1];

    const rows = entries
      .filter(e => e.keyword === k)
      .sort((a,b)=> (a.entity||'').localeCompare(b.entity||'') || (a.title||'').localeCompare(b.title||''));

    rows.forEach((e, i) => {
      const neg  = isNegativeFromTitle(e.title) ? 'Yes' : 'No';
      const note = neg==='Yes' ? 'Direct allegation indicated in title.' : 'General/policy/context; no direct allegation in title.';
      ws.addRow([i+1, e.entity||'Unknown', e.url||'', e.title||'', neg, note]);
    });

    const thin = { style:'thin', color:{argb:'FFD1D5DB'} };
    for (let r=1;r<=ws.rowCount;r++) for (let c=1;c<=6;c++) ws.getCell(r,c).border = { top:thin,left:thin,bottom:thin,right:thin };
    for (let r=2;r<=ws.rowCount;r++) {
      ws.getCell(`C${r}`).alignment={wrapText:true,vertical:'top'};
      ws.getCell(`D${r}`).alignment={wrapText:true,vertical:'top'};
      ws.getCell(`F${r}`).alignment={wrapText:true,vertical:'top'};
    }

    ws.addConditionalFormatting({ ref:'E2:E2000', rules:[{ type:'expression', formulae:['EXACT(E2,"Yes")'], style:{ fill:{ type:'pattern', pattern:'solid', fgColor:{argb:'FFFFC7CE'} } } }] });
    ws.addConditionalFormatting({ ref:'F2:F2000', rules:[{ type:'expression', formulae:['EXACT(E2,"Yes")'], style:{ fill:{ type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF2CC'} } } }] });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

