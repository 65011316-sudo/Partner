import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import he from 'he';
import iconv from 'iconv-lite';

// ---- config (ปรับได้จาก Environment Variables บน Render) ----
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);       // concurrent jobs
const TIMEOUT = Number(process.env.REQ_TIMEOUT || 15000);        // timeout 15s
const MAX_BYTES = Number(process.env.MAX_HTML_BYTES || 1500000); // 1.5 MB

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---- cleaning helpers ----
function cleanText(t = '') {
    return he
        .decode(t)
        .replace(/\s+/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
}

function splitParagraphs(t = '') {
    return t.split(/\n+/).map(s => s.trim()).filter(Boolean);
}

// ---- keyword map ----
const KW = {
    'Money Laundering': /\blaunder(ing|ed)?|anti[-\s]?money[-\s]?laundering|aml\b/i,
    Bribe: /\bbribe(ry)?|kickback|pay[-\s]?off|gratification\b/i,
    Corrupt: /\bcorrupt(ion(ed)?)?|malfeasance|graft\b/i,
    Fraud: /\bfraud(ulent)?|scam|false\s*claim|decept(ion|ive)\b/i,
    Litigation:
        /\blawsuit|sue(d)?|filed|complaint|settlement(s)?|consent\s*decree|charged?\b/i,
    Abuse: /\babuse|harass(ment|ed)?|misconduct|bully(ing)?|assault\b/i,
    Cartel: /\bcartel|price[-\s]?fix(ing)?|rig(ging)?|collus(ion|ive)\b/i,
    Antitrust: /\banti[-\s]?trust|competition\s*law|monopoly|restraint\s*of\s*trade\b/i
};

// ---- evidence finder ----
function findEvidence(paragraphs, entity, pattern) {
    const entRe = new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const p of paragraphs) {
        if (entRe.test(p) && pattern.test(p)) {
            return `Evidence: ${p.slice(0, 300)}...`;
        }
    }
    return '';
}

// ---- fetch HTML text safely ----
async function fetchPageText(url) {
    try {
        // skip non-HTML links
        if (/\.(pdf|docx?|xlsx?|zip|rar|jpg|jpeg|png|gif|mp4|mp3)(\?|$)/i.test(url)) return '';

        const res = await axios.get(url, {
            timeout: TIMEOUT,
            maxContentLength: MAX_BYTES,
            maxBodyLength: MAX_BYTES,
            responseType: 'arraybuffer',
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
            validateStatus: () => true
        });

        const type = (res.headers['content-type'] || '').toLowerCase();
        if (!type.includes('text/html') || res.status >= 400) return '';

        // decode content
        let enc = 'utf-8';
        const m = type.match(/charset=([^;]+)/i);
        if (m) enc = m[1].trim();
        const html = iconv.decode(Buffer.from(res.data), enc);

        const $ = cheerio.load(html);
        ['script', 'style', 'nav', 'footer', 'svg'].forEach(sel => $(sel).remove());
        const text = cleanText($('body').text());
        return text;
    } catch {
        return ''; // สำคัญมาก: อย่า throw กลับขึ้นไป
    }
}

// ---- main analyzer ----
export async function analyzeEntries(entries = []) {
    const limit = pLimit(CONCURRENCY);
    const tasks = entries.map((e, idx) =>
        limit(async () => {
            const out = { ...e, finding: 'No', note: '' };

            try {
                const pattern = KW[e.keyword];
                if (!pattern || !e.url) {
                    out.note = 'Missing keyword or URL';
                    return out;
                }

                const pageText = await fetchPageText(e.url);
                if (!pageText) {
                    out.note = 'Fetch failed or non-HTML';
                    return out;
                }

                const paragraphs = splitParagraphs(pageText);
                const evidence = findEvidence(paragraphs, e.entity, pattern);

                if (evidence) {
                    out.finding = 'Yes';
                    out.note = evidence;
                } else {
                    out.note = 'No direct co-mention of entity & keyword.';
                }

                console.log(
                    `[analyze] ${idx + 1}/${entries.length} → ${e.keyword} | ${e.entity} | ${e.url || 'no URL'
                    } => ${out.finding}`
                );
            } catch (err) {
                out.finding = 'No';
                out.note = 'Analyzer error';
            }

            return out;
        })
    );

    return Promise.all(tasks);
}
