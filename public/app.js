
const API = location.origin;
const $ = (sel) => document.querySelector(sel);
const tbody = $('#summaryTable tbody');
const raw = $('#raw'); // optional

// loader & buttons
const fileInput = $('#file');
const btnAnalyze = $('#analyzeBtn');
const btnExport = $('#exportBtn');
const loader = $('#loader');        // <div id="loader" class="overlay">…</div>

// ---------- UI helpers ----------
function showLoader() { loader?.classList.add('show'); }
function hideLoader() { loader?.classList.remove('show'); }
function setBusy(busy) {
    [btnAnalyze, btnExport, fileInput].forEach(el => { if (el) el.disabled = busy; });
}

function renderSummary(summary = {}, debugCount) {
    if (!tbody) return;

    const rows = summary.rows || [];
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="3"><pre class="tag">No results yet.</pre></td></tr>`;
    } else {
        tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.keyword}</td>
        <td>${r.total}</td>
        <td>${r.negative}</td>
      </tr>
    `).join('');
    }

    if (raw) {
        raw.textContent = JSON.stringify({ summary, debugCount }, null, 2);
    }
}

// ---------- network helpers ----------
async function postFile(endpoint) {
    const f = fileInput?.files?.[0];
    if (!f) { alert('Please choose a PDF/DOCX first.'); throw new Error('No file'); }
    const fd = new FormData();
    fd.append('file', f);

    const res = await fetch(`${API}/${endpoint}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return res;
}

// ---------- main actions ----------
async function analyze() {
    try {
        setBusy(true);
        showLoader();

        const res = await postFile('analyze-report');
        const data = await res.json();

        if (data?.ok) {
            renderSummary(data.summary, data.debugCount);
        } else {
            // show server error payload if any
            if (raw) raw.textContent = JSON.stringify(data, null, 2);
            alert('Analyze failed.');
        }
    } catch (e) {
        console.error(e);
        alert('Analyze failed: ' + (e.message || e));
    } finally {
        hideLoader();
        setBusy(false);
    }
}

async function exportExcel() {
    try {
        setBusy(true);
        showLoader();

        const res = await postFile('export-excel');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        const nm = (fileInput?.files?.[0]?.name || 'Report').replace(/\.(pdf|docx)$/i, '');
        a.href = url;
        a.download = nm + '_Check.xlsx';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error(e);
        alert('Export failed: ' + (e.message || e));
    } finally {
        hideLoader();
        setBusy(false);
    }
}

// ---------- wire up ----------
btnAnalyze?.addEventListener('click', analyze);
btnExport?.addEventListener('click', exportExcel);

// first paint
renderSummary({ rows: [] });
