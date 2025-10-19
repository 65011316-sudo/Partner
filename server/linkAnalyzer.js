import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import he from 'he';
import iconv from 'iconv-lite';

// ---------- helpers ----------
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function cleanText(t = '') {
    return he
        .decode(t)
        .replace(/\s+/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
}

function splitParagraphs(text) {
    return text
        .split(/[\r\n]{2,}|(?<=\.)\s+(?=[A-Z(])/g)
        .map((p) => p.trim())
        .filter(Boolean);
}

// ---------- keyword rules ----------
const KW = {
    'Money Laundering': /\bmoney[-\s]?launder(ing|ed)?|anti[-\s]?money[-\s]?laundering|aml\b/i,
    Bribe: /\bbribe(ry)?|kickback|pay[-\s]?off|gratification\b/i,
    Corrupt: /\bcorrupt(ion|ed)?|malfeasance|graft\b/i,
    Fraud: /\bfraud(ulent)?|scam|false\s+claim(s)?|decept(ion|ive)\b/i,
    Litigation:
        /\blawsuit|sue(d)?|filed\s+a\s+complaint|complaint\s+was\s+filed|indict(ed|ment)|charge(d)?|settlement(s)?|consent\s+decree\b/i,
    Abuse: /\babuse|harass(ment|ed)?|misconduct|bully(ing)?|assault\b/i,
    Cartel: /\bcartel|price[-\s]?fix(ing)?|bid[-\s]?rig(ging)?|collus(ion|ive)\b/i,
    Antitrust: /\banti[-\s]?trust|competition\s+law|monopol(y|ize|ization)|restraint\s+of\s+trade\b/i,
};

// หาประโยคที่มี entity + keyword ใกล้กัน เพื่อเอาไปเป็น note
function findEvidence(paragraphs, entity, pattern) {
    const ent = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape
    const entRe = new RegExp(ent, 'i');

    // 1) ประโยคที่มีทั้ง entity และ keyword ในย่อหน้าเดียวกัน
    for (const p of paragraphs) {
        if (entRe.test(p) && pattern.test(p)) return `Evidence: ${p.slice(0, 300)}...`;
    }
    // 2) ถ้าไม่เจอ ลองหาความใกล้ในหน้าทั้งหมด (window ~300 ตัวอักษร)
    const joined = paragraphs.join(' ');
    const entIdx = joined.search(entRe);
    const kwIdx = joined.search(pattern);
    if (entIdx !== -1 && kwIdx !== -1 && Math.abs(entIdx - kwIdx) <= 300) {
        const start = Math.max(0, Math.min(entIdx, kwIdx) - 80);
        const end = Math.min(joined.length, Math.max(entIdx, kwIdx) + 220);
        return `Evidence: ${joined.slice(start, end)}...`;
    }
    return '';
}

// ดึง HTML + แปลงเป็นข้อความ
async function fetchPageText(url) {
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
            maxRedirects: 5,
            validateStatus: (s) => s < 500, // ให้ผ่าน 4xx
        });

        // decode เผื่อเป็น ISO-8859-1, win-874 ฯลฯ
        let enc = 'utf8';
        const ctype = String(res.headers['content-type'] || '');
        const m = ctype.match(/charset=([^;]+)/i);
        if (m) enc = m[1].trim().toLowerCase();

        const html = iconv.decode(Buffer.from(res.data), enc);
        const $ = cheerio.load(html);

        // เอาเฉพาะ text หลัก ๆ (ตัด script/style/nav/footer)
        ['script', 'style', 'noscript', 'header', 'footer', 'nav', 'svg'].forEach((s) => $(s).remove());
        const text = cleanText($('body').text());
        return text;
    } catch (e) {
        return ''; // ถ้าดึงไม่ได้ ให้คืนค่าว่าง (จะถือว่า “No”)
    }
}

// ---------- main analyzer ----------
export async function analyzeEntries(entries) {
    const limit = pLimit(6); // จำกัด concurrent 6 ลิงก์พร้อมกัน (กันช้า/กันโดนบล็อก)
    const tasks = entries.map((e, idx) =>
        limit(async () => {
            const out = { ...e, finding: 'No', note: '' };

            const pattern = KW[e.keyword];
            if (!pattern || !e.url) return out;

            const pageText = await fetchPageText(e.url);
            if (!pageText) return out;

            const paragraphs = splitParagraphs(pageText);
            const evidence = findEvidence(paragraphs, e.entity, pattern);

            if (evidence) {
                out.finding = 'Yes';
                out.note = evidence;
            } else {
                out.note = 'No direct co-mention of entity and keyword in article.';
            }
            console.log(`[analyze] ${idx + 1}/${entries.length} → ${e.keyword} | ${e.entity} | ${e.url || 'no URL'} => ${out.finding}`);
            return out;
        })
    );

    return Promise.all(tasks);
}
