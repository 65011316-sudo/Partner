import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    extractTextFromPdf,
    extractTextFromDocx,
    parseReportEntries,
    buildSummary,
    makeExcel
} from './parsers.js';
import { analyzeEntries } from './linkAnalyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5050;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ✅ timeout middleware
app.use((req, res, next) => {
    req.setTimeout(1000 * 60 * 5);
    res.setTimeout(1000 * 60 * 5);
    next();
});

// ✅ serve static public folder
const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));

// ✅ upload ไปที่ /tmp (Railway, Render ใช้ได้)
const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, '/tmp'),
        filename: (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    }),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// ---------- Routes ----------

async function readReportText(filePath, mimetype, originalName) {
    const lower = (originalName || '').toLowerCase();
    try {
        if (mimetype === 'application/pdf' || lower.endsWith('.pdf')) {
            return await extractTextFromPdf(filePath);
        }
        if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lower.endsWith('.docx')) {
            return await extractTextFromDocx(filePath);
        }
    } catch (err) {
        console.warn('Primary read failed:', err?.message);
    }
    throw new Error('Unsupported file type');
}

app.post('/analyze-report', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

        const text = await readReportText(req.file.path, req.file.mimetype, req.file.originalname);
        const { entries, debug } = parseReportEntries(text);
        const analyzed = await analyzeEntries(entries);
        const summary = buildSummary(analyzed);

        fs.unlink(req.file.path, () => { });
        res.json({ ok: true, summary, debugCount: debug, sample: text.split('\n').slice(0, 120) });
    } catch (e) {
        console.error('Analyze error:', e);
        res.status(500).json({ ok: false, error: e.message || 'Analyze failed' });
    }
});

// --- export excel ---
app.post('/export-excel', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

        // 1) ไฟล์ -> ข้อความ
        const text = await readReportText(req.file.path, req.file.mimetype, req.file.originalname);

        // 2) ข้อความ -> entries (array)
        const entries = parseReportEntries(text);

        // 3) วิเคราะห์ลิงก์เพื่อเติม finding/note
        const analyzed = await analyzeEntries(entries);

        // ป้องกันพลาด: ต้องเป็น array เท่านั้น
        if (!Array.isArray(analyzed)) {
            console.error('Export error: analyzed is not array', typeof analyzed, analyzed && Object.keys(analyzed));
            return res.status(500).json({ ok: false, error: 'entries is not an array' });
        }

        // 4) ทำไฟล์ Excel จาก “อาร์เรย์ของรายการที่วิเคราะห์แล้ว”
        const filename = path.parse(req.file.originalname).name;
        const buf = await makeExcel(analyzed, filename);

        fs.unlink(req.file.path, () => { });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\s+/g, '_')}_Check.xlsx"`);
        res.send(buf);
    } catch (e) {
        console.error('Export error:', e);
        res.status(500).json({ ok: false, error: e.message || 'Export failed' });
    }
});


// ✅ start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Negative-Check Web v2 running on port ${PORT}`);
});
