
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
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));

const upload = multer({ dest: path.resolve(__dirname, './uploads') });

async function readReportText(filePath, mimetype, originalName) {
  const lower = (originalName || '').toLowerCase();
  try {
    if (mimetype === 'application/pdf' || lower.endsWith('.pdf')) {
      return await extractTextFromPdf(filePath);
    }
    if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lower.endsWith('.docx')
    ) {
      return await extractTextFromDocx(filePath);
    }
  } catch (err) {
    console.warn('Primary read failed, trying fallback:', err?.message);
  }
  try { return await extractTextFromPdf(filePath); } catch {}
  try { return await extractTextFromDocx(filePath); } catch {}
  throw new Error('Unsupported or unreadable file type');
}

app.post('/analyze-report', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const text = await readReportText(req.file.path, req.file.mimetype, req.file.originalname);
      const { entries, debug } = parseReportEntries(text);
      const analyzed = await analyzeEntries(entries); // analyze the link
      const summary = buildSummary(analyzed);


    fs.unlink(req.file.path, () => {});
    res.json({ ok: true, summary, debugCount: debug, sample: text.split('\n').slice(0, 120) });
  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Analyze failed' });
  }
});

app.use((req, res, next) => {
    req.setTimeout?.(1000 * 60 * 5);  
    res.setTimeout?.(1000 * 60 * 5);
    next();
});


app.post('/export-excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const text = await readReportText(req.file.path, req.file.mimetype, req.file.originalname);
    const { entries } = parseReportEntries(text);
    const buf = await makeExcel(entries, path.parse(req.file.originalname).name);

    fs.unlink(req.file.path, () => {});
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${path.parse(req.file.originalname).name.replace(/\s+/g,'_')}_Check.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Export failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Negative-Check Web v2 running at http://localhost:${PORT}`);
});
