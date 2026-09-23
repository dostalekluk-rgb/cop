import fs from 'fs';
import path from 'path';
import * as ftp from 'basic-ftp';
import { fetchRedcapRecords, parseDate } from './redcap.js';

/**
 * SKRIPT PRO PROSPEKTIVNÍ VALIDACI AI MODELU PROTI HISTOLOGII A ANALÝZU ROC AUC KŘIVEK
 * PŘEKRESLENÍ GRAFŮ V JEMNÉM, ELEGANTNÍM A TENKÉM VĚDECKÉM STYLU
 */

const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

// FTP Konfigurace (cipek.eu / WEDOS)
const FTP_HOST = process.env.FTP_HOST || "326348.w48.wedos.net";
const FTP_USER = process.env.FTP_USER || "w326348";
const FTP_PASS = process.env.FTP_PASS || "Aa1231231231*";

/**
 * Převod kódů histologie na text a zjištění is_hg (CIN 2+)
 */
function mapHistologyDetail(konVal, pbVal) {
    let type = '';
    let rawResult = '';

    if (konVal && konVal !== '0') {
        type = 'Konizace';
        rawResult = konVal;
    } else if (pbVal && pbVal !== '0') {
        type = 'Biopsie';
        rawResult = pbVal;
    } else {
        return { type: 'Neznámé', resultText: 'Chybí', isHg: 0, categoryKey: 'ned' };
    }

    const r = rawResult.toString().trim().toLowerCase();
    let resultText = 'Bez dysplázie';
    let isHg = 0;
    let categoryKey = 'ned';

    if (r === '1' || r.includes('bez dyspl') || r.includes('ned')) {
        resultText = 'Bez dysplázie';
        isHg = 0;
        categoryKey = 'ned';
    } else if (r === '2' || r.includes('cin1') || r.includes('cin 1')) {
        resultText = 'CIN 1';
        isHg = 0;
        categoryKey = 'cin1';
    } else if (r === '3' || r.includes('cin2') || r.includes('cin 2')) {
        resultText = 'CIN 2';
        isHg = 1;
        categoryKey = 'cin2';
    } else if (r === '4' || r.includes('cin3') || r.includes('cin 3')) {
        resultText = 'CIN 3';
        isHg = 1;
        categoryKey = 'cin3';
    } else if (r === '5' || r.includes('ais')) {
        resultText = 'AIS';
        isHg = 1;
        categoryKey = 'cin3';
    } else if (r === '6' || r.includes('karcinom') || r.includes('ca')) {
        resultText = 'Karcinom';
        isHg = 1;
        categoryKey = 'cin3';
    } else {
        resultText = rawResult;
        isHg = r.includes('2') || r.includes('3') ? 1 : 0;
        categoryKey = isHg ? 'cin2' : 'cin1';
    }

    return { type, resultText, isHg, categoryKey };
}

/**
 * Výpočet 95% konfidenčního intervalu (95% CI) pro ROC AUC podle DeLongovy metodiky
 */
function computeAucCi(auc, nPos, nNeg) {
    if (nPos <= 0 || nNeg <= 0 || auc <= 0) return { ciLow: 0, ciHigh: 0, str: '[0.000-0.000]' };
    const a = auc;
    const q1 = a / (2 - a);
    const q2 = (2 * a * a) / (1 + a);
    const varA = (a * (1 - a) + (nPos - 1) * (q1 - a * a) + (nNeg - 1) * (q2 - a * a)) / (nPos * nNeg);
    const se = Math.sqrt(Math.max(0, varA));
    const ciLow = Math.max(0, Math.round((a - 1.96 * se) * 1000) / 1000);
    const ciHigh = Math.min(1, Math.round((a + 1.96 * se) * 1000) / 1000);
    return {
        se: Math.round(se * 10000) / 10000,
        ciLow,
        ciHigh,
        str: `[${ciLow.toFixed(3)}-${ciHigh.toFixed(3)}]`
    };
}

/**
 * Výpočet ROC AUC křivky a diagnostických metrik
 */
function computeRocAuc(items, scoreKey) {
    const valid = items.filter(it => it[scoreKey] !== null && !isNaN(it[scoreKey]));
    if (valid.length === 0) return { auc: 0, rocPoints: [], optimalCutoff: null, ci: { str: '[0.000-0.000]' } };

    valid.sort((a, b) => b[scoreKey] - a[scoreKey]);

    const totalPos = valid.filter(it => it.is_hg === 1).length;
    const totalNeg = valid.filter(it => it.is_hg === 0).length;

    if (totalPos === 0 || totalNeg === 0) return { auc: 0, rocPoints: [], optimalCutoff: null, ci: { str: '[0.000-0.000]' } };

    let tp = 0;
    let fp = 0;
    let auc = 0;
    let prevFp = 0;
    let prevTp = 0;

    const rocPoints = [{ fpr: 0, tpr: 0, threshold: valid[0][scoreKey] + 0.05, sensitivity: 0, specificity: 1, youdenJ: 0 }];
    let maxYoudenJ = -1;
    let optimalCutoff = null;

    for (let i = 0; i < valid.length; i++) {
        const item = valid[i];
        if (item.is_hg === 1) {
            tp++;
        } else {
            fp++;
        }

        if (i === valid.length - 1 || valid[i + 1][scoreKey] !== item[scoreKey]) {
            const fpr = fp / totalNeg;
            const tpr = tp / totalPos;
            const sensitivity = tpr;
            const specificity = 1 - fpr;
            const youdenJ = sensitivity + specificity - 1;

            auc += (fpr - prevFp) * (tpr + prevTp) / 2;
            prevFp = fpr;
            prevTp = tpr;

            const pt = {
                fpr: Math.round(fpr * 10000) / 10000,
                tpr: Math.round(tpr * 10000) / 10000,
                sensitivity: Math.round(sensitivity * 10000) / 10000,
                specificity: Math.round(specificity * 10000) / 10000,
                threshold: Math.round(item[scoreKey] * 10000) / 10000,
                youdenJ: Math.round(youdenJ * 10000) / 10000
            };

            rocPoints.push(pt);

            if (youdenJ > maxYoudenJ) {
                maxYoudenJ = youdenJ;
                optimalCutoff = pt;
            }
        }
    }

    const calcAuc = Math.round(auc * 10000) / 10000;
    const ci = computeAucCi(calcAuc, totalPos, totalNeg);

    return {
        auc: calcAuc,
        totalPos,
        totalNeg,
        rocPoints,
        optimalCutoff,
        ci
    };
}

async function runProspectiveRocValidation() {
    console.log(`==================================================`);
    console.log(`🚀 PROSPEKTIVNÍ VALIDACE MODELU PROTI HISTOLOGII & ROC AUC`);
    console.log(`==================================================`);
    console.log(`🌐 REDCap API URL: ${REDCAP_API_URL}`);

    // 1. Načtení z RedCapu
    console.log(`📥 Načítám existující vizity z RedCapu...`);
    const allRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`Celkem načteno z RedCapu: ${allRecords.length} záznamů.`);

    const cutoffDate = new Date(Date.UTC(2026, 2, 1)); // po 1.3.2026

    // 2. Filtrování prospektivní kohorty a výpočet detailních popisných statistik
    const prospectiveVisits = [];
    let hgCount = 0;
    let cin3Count = 0;
    let cin2Count = 0;
    let cin1Count = 0;
    let nedCount = 0;
    let biopsyCount = 0;
    let conizationCount = 0;

    for (const r of allRecords) {
        const dStr = r.datum || r.v1_date || r.vfu_date;
        const d = parseDate(dStr);

        if (!d || d <= cutoffDate) continue;

        const hasKon = r.konizace || r.v1_kon_res;
        const hasPb = r.biopsie || r.v1_pb_res;
        if (!hasKon && !hasPb) continue;

        const probVal = r.prob !== undefined && r.prob !== '' ? r.prob : r.hg_probability;
        const coveredVal = r.covered !== undefined && r.covered !== '' ? r.covered : r.tz_covered_by_hg_frac;
        const pfhgVal = r.pfhg !== undefined && r.pfhg !== '' ? r.pfhg : r.pixel_fraction_hg;

        if (probVal === undefined || probVal === '' || probVal === null) continue;

        const xProb = parseFloat(probVal);
        if (isNaN(xProb)) continue;

        const histDetail = mapHistologyDetail(r.konizace || r.v1_kon_res, r.biopsie || r.v1_pb_res);

        if (histDetail.isHg) hgCount++;
        if (histDetail.categoryKey === 'cin3') cin3Count++;
        else if (histDetail.categoryKey === 'cin2') cin2Count++;
        else if (histDetail.categoryKey === 'cin1') cin1Count++;
        else nedCount++;

        if (histDetail.type === 'Konizace') conizationCount++;
        else if (histDetail.type === 'Biopsie') biopsyCount++;

        prospectiveVisits.push({
            record_id: r.record_id || r.id || r.rc,
            rc: r.rc || '',
            jmeno: r.jmeno ? `${r.jmeno} ${r.prijmeni || ''}`.trim() : (r.record_id || r.rc),
            datum: dStr,
            model_img: r.model || r.v1_colpo || '',
            prob: Math.round(xProb * 10000) / 10000,
            covered: coveredVal ? Math.round(parseFloat(coveredVal) * 10000) / 10000 : 0,
            pfhg: pfhgVal ? Math.round(parseFloat(pfhgVal) * 10000) / 10000 : 0,
            hist_type: histDetail.type,
            hist_result: histDetail.resultText,
            is_hg: histDetail.isHg,
            categoryKey: histDetail.categoryKey
        });
    }

    prospectiveVisits.sort((a, b) => new Date(b.datum).getTime() - new Date(a.datum).getTime());

    const totalVisits = prospectiveVisits.length;
    const hgPrevalence = totalVisits > 0 ? Math.round((hgCount / totalVisits) * 1000) / 10 : 0;
    const lgCount = totalVisits - hgCount;
    const lgPrevalence = totalVisits > 0 ? Math.round((lgCount / totalVisits) * 1000) / 10 : 0;

    // Generování časové řady nárůstu vizit v čase od 1. 3. 2026
    const timelineAscending = [...prospectiveVisits].sort((a, b) => new Date(a.datum).getTime() - new Date(b.datum).getTime());
    let cumTotal = 0;
    let cumHg = 0;
    let cumLg = 0;

    const timelineData = timelineAscending.map(v => {
        cumTotal++;
        if (v.is_hg === 1) cumHg++;
        else cumLg++;
        return {
            datum: v.datum,
            timestamp: new Date(v.datum).getTime(),
            cumTotal,
            cumHg,
            cumLg
        };
    });

    // 3. Výpočet ROC AUC metrik pro proměnné prob, covered a pfhg
    const rocProb = computeRocAuc(prospectiveVisits, 'prob');
    const rocCovered = computeRocAuc(prospectiveVisits, 'covered');
    const rocPfhg = computeRocAuc(prospectiveVisits, 'pfhg');

    console.log(`\n==================================================`);
    console.log(`📈 VÝSLEDKY ROC AUC KŘIVEK PROSPEKTIVNÍ VALIDACE:`);
    console.log(`--------------------------------------------------`);
    console.log(`Celkem vyhovujících vizit po 1.3.2026: ${totalVisits}`);
    console.log(`High-Grade Léze (CIN 2+):             ${hgCount} (${hgPrevalence} %)`);
    console.log(`Low-Grade & NED:                       ${lgCount} (${lgPrevalence} %)`);
    console.log(`--------------------------------------------------`);
    console.log(`1. covered (podíl HGL v TZ):    AUC = ${rocCovered.auc}, 95% CI: ${rocCovered.ci.str} | Sens = ${Math.round(rocCovered.optimalCutoff?.sensitivity * 100)}% | Spec = ${Math.round(rocCovered.optimalCutoff?.specificity * 100)}%`);
    console.log(`2. prob (HG pravděpodobnost):   AUC = ${rocProb.auc}, 95% CI: ${rocProb.ci.str} | Sens = ${Math.round(rocProb.optimalCutoff?.sensitivity * 100)}% | Spec = ${Math.round(rocProb.optimalCutoff?.specificity * 100)}%`);
    console.log(`3. pfhg (plošný podíl HGL):     AUC = ${rocPfhg.auc}, 95% CI: ${rocPfhg.ci.str} | Sens = ${Math.round(rocPfhg.optimalCutoff?.sensitivity * 100)}% | Spec = ${Math.round(rocPfhg.optimalCutoff?.specificity * 100)}%`);
    console.log(`==================================================\n`);

    // 4. Vygenerování HTML Dashboardu s jemnými tenkými grafy
    const htmlContent = generateNejmDashboardHtml({
        totalVisits,
        hgCount,
        hgPrevalence,
        lgCount,
        lgPrevalence,
        cin3Count,
        cin2Count,
        cin1Count,
        nedCount,
        biopsyCount,
        conizationCount,
        timelineData,
        rocProb,
        rocCovered,
        rocPfhg
    });

    const outputHtmlPath = path.join(process.cwd(), 'prospektivni_validace.html');
    fs.writeFileSync(outputHtmlPath, htmlContent, 'utf-8');
    console.log(`✅ Vygenerován nový HTML Dashboard (Jemné Tenké Grafy): ${outputHtmlPath}`);

    // 5. Publikace na FTP Server (cipek.eu)
    await uploadDashboardToFtp(outputHtmlPath);
}

/**
 * Generování akademického výstupního dokumentu s jemnými a tenkými grafy
 */
export function generateNejmDashboardHtml(stats) {
    const jsonRocProb = JSON.stringify(stats.rocProb.rocPoints);
    const jsonRocCovered = JSON.stringify(stats.rocCovered.rocPoints);
    const jsonRocPfhg = JSON.stringify(stats.rocPfhg.rocPoints);
    const jsonTimeline = JSON.stringify(stats.timelineData);

    return `<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prospektivní Validace AI Modelu - ROC AUC Analýza</title>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,300;0,400;0,700;1,300&family=Inter:wght@300;400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
    <!-- KaTeX CSS & JS -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"></script>

    <style>
        :root {
            --nejm-crimson: #990000;
            --nejm-dark-crimson: #770000;
            --nejm-navy: #1a365d;
            --nejm-teal: #0d9488;
            --nejm-amber: #d97706;
            --bg-page: #f8fafc;
            --surface-paper: #ffffff;
            --border-subtle: #cbd5e1;
            --border-dark: #334155;
            --text-heading: #0f172a;
            --text-body: #334155;
            --text-muted: #64748b;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-page);
            color: var(--text-body);
            line-height: 1.6;
            padding: 32px 16px;
        }

        .paper-container {
            max-width: 1100px;
            margin: 0 auto;
            background: var(--surface-paper);
            border: 1px solid var(--border-subtle);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
            border-top: 6px solid var(--nejm-crimson);
            padding: 48px 56px;
            border-radius: 4px;
        }

        @media (max-width: 768px) {
            .paper-container { padding: 24px 20px; }
        }

        /* NEJM Header */
        .nejm-header {
            border-bottom: 2px solid var(--text-heading);
            padding-bottom: 20px;
            margin-bottom: 32px;
        }

        .nejm-journal-tag {
            font-family: 'Merriweather', serif;
            font-size: 0.85rem;
            font-weight: 700;
            color: var(--nejm-crimson);
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 8px;
        }

        .nejm-title {
            font-family: 'Merriweather', serif;
            font-size: 2.1rem;
            font-weight: 700;
            color: var(--text-heading);
            line-height: 1.25;
            margin-bottom: 12px;
        }

        .nejm-subtitle {
            font-size: 1.05rem;
            color: var(--text-muted);
            font-weight: 400;
            margin-bottom: 16px;
        }

        .nejm-meta-bar {
            display: flex;
            gap: 24px;
            font-size: 0.85rem;
            color: var(--text-muted);
            border-top: 1px solid var(--border-subtle);
            padding-top: 12px;
            flex-wrap: wrap;
        }

        .nejm-meta-item strong {
            color: var(--text-heading);
        }

        /* Section Headings */
        .section-header {
            border-bottom: 1px solid var(--nejm-crimson);
            padding-bottom: 6px;
            margin: 40px 0 20px 0;
            display: flex;
            justify-content: space-between;
            align-items: baseline;
        }

        .section-header h2 {
            font-family: 'Merriweather', serif;
            font-size: 1.35rem;
            font-weight: 700;
            color: var(--nejm-crimson);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .section-header .table-num {
            font-family: 'Inter', sans-serif;
            font-size: 0.85rem;
            font-weight: 600;
            color: var(--text-muted);
        }

        /* KPI Callout Boxes */
        .kpi-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 24px;
        }

        @media (max-width: 768px) {
            .kpi-grid { grid-template-columns: repeat(2, 1fr); }
        }

        .kpi-box {
            background: #fafafa;
            border: 1px solid var(--border-subtle);
            border-left: 4px solid var(--border-dark);
            padding: 16px;
            border-radius: 2px;
        }

        .kpi-box.crimson { border-left-color: var(--nejm-crimson); }
        .kpi-box.teal { border-left-color: var(--nejm-teal); }
        .kpi-box.navy { border-left-color: var(--nejm-navy); }

        .kpi-val {
            font-family: 'Merriweather', serif;
            font-size: 1.8rem;
            font-weight: 700;
            color: var(--text-heading);
            line-height: 1.1;
        }

        .kpi-lbl {
            font-size: 0.78rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 4px;
            font-weight: 600;
        }

        /* Academic NEJM Tables */
        .nejm-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.92rem;
            margin-bottom: 24px;
        }

        .nejm-table th {
            border-top: 2px solid var(--text-heading);
            border-bottom: 1px solid var(--text-heading);
            padding: 10px 14px;
            text-align: left;
            font-weight: 700;
            color: var(--text-heading);
            background: transparent;
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .nejm-table td {
            padding: 10px 14px;
            border-bottom: 1px solid var(--border-subtle);
            color: var(--text-body);
        }

        .nejm-table tr.total-row td {
            border-top: 1px solid var(--text-heading);
            border-bottom: 2px solid var(--text-heading);
            font-weight: 700;
            color: var(--text-heading);
        }

        .nejm-table tr.sub-row td:first-child {
            padding-left: 28px;
            color: var(--text-muted);
        }

        .nejm-table .num-col {
            text-align: right;
            font-family: 'Fira Code', monospace;
            font-size: 0.88rem;
        }

        /* Matplotlib Scientific Graph Containers - Jemný a elegantní styl */
        .chart-box-matplotlib {
            background: #ffffff;
            border: 1px solid #d1d5db;
            padding: 20px 24px;
            margin: 24px 0;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }

        .mpl-title {
            font-family: 'Inter', -apple-system, sans-serif;
            font-size: 1.05rem;
            font-weight: 600;
            color: #111827;
            text-align: center;
            margin-bottom: 16px;
        }

        svg.mpl-svg {
            width: 100%;
            height: auto;
            background: #ffffff;
            overflow: visible;
        }

        .nejm-footer {
            margin-top: 48px;
            padding-top: 16px;
            border-top: 1px solid var(--border-subtle);
            font-size: 0.78rem;
            color: var(--text-muted);
            display: flex;
            justify-content: space-between;
        }
    </style>
</head>
<body>

    <div class="paper-container">
        
        <!-- NEJM Article Header -->
        <header class="nejm-header">
            <div class="nejm-journal-tag">PROSPEKTIVNÍ VALIDACE MODELU | ORIGINAL RESEARCH</div>
            <h1 class="nejm-title">Validace AI Segmentačního Modelu RECER v Detekci High-Grade Cervikálních Lézí</h1>
            <p class="nejm-subtitle">Zhodnocení diskriminační schopnosti proměnných modelu ($covered$, $prob$, $pfhg$) vůči histologickému zlatému standardu u prospektivní kohorty pacientek po 1. březnu 2026</p>
            
            <div class="nejm-meta-bar">
                <div class="nejm-meta-item">Datum validace: <strong>23. září 2026</strong></div>
                <div class="nejm-meta-item">Kohorta: <strong>Prospektivní ($>\text{1. 3. 2026}$)</strong></div>
                <div class="nejm-meta-item">Zdroj dat: <strong>VFN REDCap klinická databáze</strong></div>
                <div class="nejm-meta-item">Cílový parametr: <strong>High-Grade léze (CIN 2+)</strong></div>
            </div>
        </header>

        <!-- SECTION 1: POPISNÁ STATISTIKA KOHORTY -->
        <section>
            <div class="section-header">
                <h2>1. Popisná Statistika Kohorty</h2>
                <span class="table-num">TABULKA 1 & SUMMARY</span>
            </div>

            <div class="kpi-grid">
                <div class="kpi-box navy">
                    <div class="kpi-val">${stats.totalVisits}</div>
                    <div class="kpi-lbl">Celkem Vizit ($N$)</div>
                </div>
                <div class="kpi-box crimson">
                    <div class="kpi-val">${stats.hgCount}</div>
                    <div class="kpi-lbl">High-Grade (${stats.hgPrevalence} %)</div>
                </div>
                <div class="kpi-box teal">
                    <div class="kpi-val">${stats.lgCount}</div>
                    <div class="kpi-lbl">Low-Grade / NED (${stats.lgPrevalence} %)</div>
                </div>
                <div class="kpi-box">
                    <div class="kpi-val">${stats.rocCovered.auc}</div>
                    <div class="kpi-lbl">Top ROC AUC ($covered$)</div>
                </div>
            </div>

            <p style="font-size: 0.92rem; color: var(--text-body); margin-bottom: 16px;">
                Do prospektivní validace byly zařazeny všechny konsekutivní kolposkopické vizity po 1. 3. 2026 mající současně k dispozici ověřenou histologickou diagnózu (biopsie nebo konizace) a prediktivní proměnné z AI segmentačního modelu. 
                Všechny histologické nálezy byly kategorizovány binárně na <strong>High-Grade léze (CIN 2, CIN 3, AIS, karcinom)</strong> a <strong>Low-Grade / Bez dysplázie (CIN 1, bez dysplázie)</strong>.
            </p>

            <table class="nejm-table">
                <thead>
                    <tr>
                        <th>Charakteristika Nálezu / Histologie</th>
                        <th class="num-col">Počet vizit ($n$)</th>
                        <th class="num-col">Relativní Podíl (%)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr class="total-row">
                        <td>Celkový prospektivní soubor ($N$)</td>
                        <td class="num-col">${stats.totalVisits}</td>
                        <td class="num-col">100.0 %</td>
                    </tr>
                    <tr>
                        <td><strong>High-Grade Léze (CIN 2+) – Cílová třída</strong></td>
                        <td class="num-col"><strong>${stats.hgCount}</strong></td>
                        <td class="num-col"><strong>${stats.hgPrevalence} %</strong></td>
                    </tr>
                    <tr class="sub-row">
                        <td>• CIN 3 / AIS / Karcinom</td>
                        <td class="num-col">${stats.cin3Count}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.cin3Count / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                    <tr class="sub-row">
                        <td>• CIN 2</td>
                        <td class="num-col">${stats.cin2Count}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.cin2Count / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                    <tr>
                        <td><strong>Low-Grade & Bez dysplázie (CIN 1 / NED)</strong></td>
                        <td class="num-col"><strong>${stats.lgCount}</strong></td>
                        <td class="num-col"><strong>${stats.lgPrevalence} %</strong></td>
                    </tr>
                    <tr class="sub-row">
                        <td>• CIN 1</td>
                        <td class="num-col">${stats.cin1Count}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.cin1Count / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                    <tr class="sub-row">
                        <td>• Bez dysplázie (NED)</td>
                        <td class="num-col">${stats.nedCount}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.nedCount / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                    <tr class="total-row">
                        <td colspan="3" style="font-weight: 600; font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); background: #fafafa; padding-top: 12px; padding-bottom: 4px;">Způsob odběru histologie</td>
                    </tr>
                    <tr>
                        <td>Biopsie (PB)</td>
                        <td class="num-col">${stats.biopsyCount}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.biopsyCount / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                    <tr>
                        <td>Konizace (KON)</td>
                        <td class="num-col">${stats.conizationCount}</td>
                        <td class="num-col">${(stats.totalVisits > 0 ? (stats.conizationCount / stats.totalVisits * 100).toFixed(1) : 0)} %</td>
                    </tr>
                </tbody>
            </table>

            <!-- GRAF 1: KUMULATIVNÍ NÁRŮST VIZIT V ČASE (JEMNÉ TENKÉ ČÁRY) -->
            <div class="chart-box-matplotlib">
                <div class="mpl-title">Kumulativní nárůst prospektivních vizit v čase (po 1. 3. 2026)</div>
                <svg class="mpl-svg" viewBox="0 0 760 360" id="mplTimelineSvg">
                    <!-- Plot Area Boundary (Subtle Outline) -->
                    <rect x="65" y="25" width="665" height="290" fill="#ffffff" stroke="#4b5563" stroke-width="0.9"/>
                    
                    <!-- Horizontal Grid Lines (Very Subtle Dotted) -->
                    <line x1="65" y1="242.5" x2="730" y2="242.5" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="65" y1="170" x2="730" y2="170" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="65" y1="97.5" x2="730" y2="97.5" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>

                    <!-- Axes Ticks Y-axis -->
                    <line x1="61" y1="315" x2="65" y2="315" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="56" y="319" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0</text>
                    <line x1="61" y1="242.5" x2="65" y2="242.5" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="56" y="246.5" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">20</text>
                    <line x1="61" y1="170" x2="65" y2="170" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="56" y="174" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">40</text>
                    <line x1="61" y1="97.5" x2="65" y2="97.5" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="56" y="101.5" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">60</text>
                    <line x1="61" y1="25" x2="65" y2="25" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="56" y="29" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">80</text>

                    <!-- Tenké Křivky (Thinner Strokes: 1.35px) -->
                    <path id="mplTimelineTotal" fill="none" stroke="#1f77b4" stroke-width="1.35"/>
                    <path id="mplTimelineHg" fill="none" stroke="#ff7f0e" stroke-width="1.35"/>
                    <path id="mplTimelineLg" fill="none" stroke="#2ca02c" stroke-width="1.35"/>

                    <!-- Axes Ticks X-axis (Months) -->
                    <line x1="65" y1="315" x2="65" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="65" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">1. 3.</text>
                    
                    <line x1="175" y1="315" x2="175" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="175" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Duben</text>
                    
                    <line x1="285" y1="315" x2="285" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="285" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Květen</text>

                    <line x1="395" y1="315" x2="395" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="395" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Červen</text>

                    <line x1="505" y1="315" x2="505" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="505" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Červenec</text>

                    <line x1="615" y1="315" x2="615" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="615" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Srpen</text>

                    <line x1="730" y1="315" x2="730" y2="319" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="730" y="336" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">Září</text>

                    <!-- Legend Box -->
                    <g transform="translate(80, 40)">
                        <rect x="0" y="0" width="310" height="70" fill="#ffffff" stroke="#d1d5db" stroke-width="0.8" rx="2"/>
                        <line x1="12" y1="16" x2="32" y2="16" stroke="#1f77b4" stroke-width="1.35"/>
                        <text x="38" y="20" fill="#1f2937" font-family="Inter, sans-serif" font-size="11">Celkem prospektivních vizit (N = ${stats.totalVisits})</text>

                        <line x1="12" y1="35" x2="32" y2="35" stroke="#ff7f0e" stroke-width="1.35"/>
                        <text x="38" y="39" fill="#1f2937" font-family="Inter, sans-serif" font-size="11">High-Grade CIN 2+ (n = ${stats.hgCount})</text>

                        <line x1="12" y1="54" x2="32" y2="54" stroke="#2ca02c" stroke-width="1.35"/>
                        <text x="38" y="58" fill="#1f2937" font-family="Inter, sans-serif" font-size="11">Low-Grade & NED (n = ${stats.lgCount})</text>
                    </g>
                </svg>
            </div>

        </section>

        <!-- SECTION 2: ROC AUC ANALÝZA -->
        <section>
            <div class="section-header">
                <h2>2. ROC AUC Analýza a Diagnostická Účinnost Modelu</h2>
                <span class="table-num">TABULKA 2 & OBRÁZEK 2</span>
            </div>

            <p style="font-size: 0.92rem; color: var(--text-body); margin-bottom: 20px;">
                Vyjádření diskriminační schopnosti 3 hlavních spojitých výstupů modelu pomoci schodovitých ROC křivek (Receiver Operating Characteristic) a obsahu plochy pod křivkou (AUC s 95% konfidenčním intervalem). 
                Optimální diagnostický rozhodovací práh byl stanoven podle Youdenova indexu ($J = \text{Senzitivita} + \text{Specificita} - 1$).
            </p>

            <table class="nejm-table">
                <thead>
                    <tr>
                        <th>Prediktivní Proměnná Modelu</th>
                        <th>REDCap Kód</th>
                        <th class="num-col">ROC AUC (95% CI)</th>
                        <th class="num-col">Youden Cutoff ($x$)</th>
                        <th class="num-col">Senzitivita</th>
                        <th class="num-col">Specificita</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong>covered</strong> (Covered by HG) ⭐</td>
                        <td><code>tz_covered_by_hg_frac</code></td>
                        <td class="num-col"><strong>${stats.rocCovered.auc}</strong> <span style="font-size:0.8rem; color:var(--text-muted);">${stats.rocCovered.ci.str}</span></td>
                        <td class="num-col">${stats.rocCovered.optimalCutoff?.threshold}</td>
                        <td class="num-col">${Math.round(stats.rocCovered.optimalCutoff?.sensitivity * 1000) / 10} %</td>
                        <td class="num-col">${Math.round(stats.rocCovered.optimalCutoff?.specificity * 1000) / 10} %</td>
                    </tr>
                    <tr>
                        <td><strong>prob</strong> (HG Probability)</td>
                        <td><code>hg_probability</code></td>
                        <td class="num-col"><strong>${stats.rocProb.auc}</strong> <span style="font-size:0.8rem; color:var(--text-muted);">${stats.rocProb.ci.str}</span></td>
                        <td class="num-col">${stats.rocProb.optimalCutoff?.threshold}</td>
                        <td class="num-col">${Math.round(stats.rocProb.optimalCutoff?.sensitivity * 1000) / 10} %</td>
                        <td class="num-col">${Math.round(stats.rocProb.optimalCutoff?.specificity * 1000) / 10} %</td>
                    </tr>
                    <tr>
                        <td><strong>pfhg</strong> (Pixel fraction HG)</td>
                        <td><code>pixel_fraction_hg</code></td>
                        <td class="num-col"><strong>${stats.rocPfhg.auc}</strong> <span style="font-size:0.8rem; color:var(--text-muted);">${stats.rocPfhg.ci.str}</span></td>
                        <td class="num-col">${stats.rocPfhg.optimalCutoff?.threshold}</td>
                        <td class="num-col">${Math.round(stats.rocPfhg.optimalCutoff?.sensitivity * 1000) / 10} %</td>
                        <td class="num-col">${Math.round(stats.rocPfhg.optimalCutoff?.specificity * 1000) / 10} %</td>
                    </tr>
                </tbody>
            </table>

            <!-- GRAF 2: ROC KŘIVKY V JEMNÉM TENKÉM STYLU (STROKE 1.35px) -->
            <div class="chart-box-matplotlib">
                <div class="mpl-title">ROC křivky - Prospektivní validace (po 1. 3. 2026)</div>
                <svg class="mpl-svg" viewBox="0 0 680 500" id="mplRocSvg">
                    <!-- Plot Area Boundary (Subtle Outline) -->
                    <rect x="70" y="30" width="560" height="420" fill="#ffffff" stroke="#4b5563" stroke-width="0.9"/>
                    
                    <!-- Light Grid Lines (Very Subtle Dotted: 0.8px, dasharray 1.5,2) -->
                    <line x1="182" y1="30" x2="182" y2="450" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="294" y1="30" x2="294" y2="450" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="406" y1="30" x2="406" y2="450" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="518" y1="30" x2="518" y2="450" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>

                    <line x1="70" y1="366" x2="630" y2="366" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="70" y1="282" x2="630" y2="282" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="70" y1="198" x2="630" y2="198" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>
                    <line x1="70" y1="114" x2="630" y2="114" stroke="#e5e7eb" stroke-dasharray="1.5,2" stroke-width="0.8"/>

                    <!-- Diagonal Chance Line (Thinner 1.0px Dashed) -->
                    <line x1="70" y1="450" x2="630" y2="30" stroke="#1e3a8a" stroke-width="1.0" stroke-dasharray="4,4"/>

                    <!-- ROC Step Paths (Thinner 1.35px Lines) -->
                    <path id="pathProbMpl" fill="none" stroke="#1f77b4" stroke-width="1.35"/>
                    <path id="pathCoveredMpl" fill="none" stroke="#ff7f0e" stroke-width="1.35"/>
                    <path id="pathPfhgMpl" fill="none" stroke="#9467bd" stroke-width="1.35"/>

                    <!-- X-Axis Ticks & Labels -->
                    <line x1="70" y1="450" x2="70" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="70" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">0.0</text>

                    <line x1="182" y1="450" x2="182" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="182" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">0.2</text>

                    <line x1="294" y1="450" x2="294" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="294" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">0.4</text>

                    <line x1="406" y1="450" x2="406" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="406" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">0.6</text>

                    <line x1="518" y1="450" x2="518" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="518" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">0.8</text>

                    <line x1="630" y1="450" x2="630" y2="454" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="630" y="471" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="middle">1.0</text>

                    <!-- Y-Axis Ticks & Labels -->
                    <line x1="66" y1="450" x2="70" y2="450" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="454" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0.0</text>

                    <line x1="66" y1="366" x2="70" y2="366" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="370" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0.2</text>

                    <line x1="66" y1="282" x2="70" y2="282" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="286" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0.4</text>

                    <line x1="66" y1="198" x2="70" y2="198" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="202" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0.6</text>

                    <line x1="66" y1="114" x2="70" y2="114" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="118" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">0.8</text>

                    <line x1="66" y1="30" x2="70" y2="30" stroke="#4b5563" stroke-width="0.8"/>
                    <text x="61" y="34" fill="#374151" font-family="Inter, sans-serif" font-size="11" text-anchor="end">1.0</text>

                    <!-- Legend Box in Bottom Right (Refined border and padding) -->
                    <g transform="translate(225, 295)">
                        <rect x="0" y="0" width="395" height="145" fill="#ffffff" stroke="#d1d5db" stroke-width="0.8" rx="2"/>
                        
                        <line x1="12" y1="24" x2="35" y2="24" stroke="#1f77b4" stroke-width="1.35"/>
                        <text x="42" y="28" fill="#1f2937" font-family="Inter, sans-serif" font-size="11.5">HG Probability (prob) (AUC = ${stats.rocProb.auc}, 95% CI: ${stats.rocProb.ci.str})</text>

                        <line x1="12" y1="54" x2="35" y2="54" stroke="#ff7f0e" stroke-width="1.35"/>
                        <text x="42" y="58" fill="#1f2937" font-family="Inter, sans-serif" font-size="11.5">Covered by HG (covered) (AUC = ${stats.rocCovered.auc}, 95% CI: ${stats.rocCovered.ci.str})</text>

                        <line x1="12" y1="84" x2="35" y2="84" stroke="#9467bd" stroke-width="1.35"/>
                        <text x="42" y="88" fill="#1f2937" font-family="Inter, sans-serif" font-size="11.5">Pixel fraction HG (pfhg) (AUC = ${stats.rocPfhg.auc}, 95% CI: ${stats.rocPfhg.ci.str})</text>

                        <line x1="12" y1="114" x2="35" y2="114" stroke="#1e3a8a" stroke-width="1.0" stroke-dasharray="4,4"/>
                        <text x="42" y="118" fill="#1f2937" font-family="Inter, sans-serif" font-size="11.5">Náhodný klasifikátor (AUC = 0.500)</text>
                    </g>
                </svg>
            </div>
        </section>

        <footer class="nejm-footer">
            <div>RECER AI Colposcopy Validation Study Group &copy; 2026</div>
            <div>Generated automatically from VFN REDCap Registry</div>
        </footer>

    </div>

    <script>
        const rocPointsProb = ${jsonRocProb};
        const rocPointsCovered = ${jsonRocCovered};
        const rocPointsPfhg = ${jsonRocPfhg};
        const timelineData = ${jsonTimeline};

        function drawTimelineGraph() {
            if (!timelineData || timelineData.length === 0) return;

            const svgMinX = 65;
            const svgMaxX = 730;
            const svgMinY = 315;
            const svgMaxY = 25;

            const minTime = new Date('2026-03-01').getTime();
            const maxTime = new Date('2026-09-23').getTime();
            const maxVal = 80;

            const getX = (ts) => svgMinX + ((ts - minTime) / (maxTime - minTime)) * (svgMaxX - svgMinX);
            const getY = (val) => svgMinY - (val / maxVal) * (svgMinY - svgMaxY);

            // Step path calculation for timeline
            let pathTotal = 'M ' + svgMinX + ' ' + getY(0);
            let pathHg = 'M ' + svgMinX + ' ' + getY(0);
            let pathLg = 'M ' + svgMinX + ' ' + getY(0);

            timelineData.forEach(pt => {
                const x = getX(pt.timestamp).toFixed(1);
                pathTotal += ' L ' + x + ' ' + getY(pt.cumTotal).toFixed(1);
                pathHg += ' L ' + x + ' ' + getY(pt.cumHg).toFixed(1);
                pathLg += ' L ' + x + ' ' + getY(pt.cumLg).toFixed(1);
            });

            document.getElementById('mplTimelineTotal').setAttribute('d', pathTotal);
            document.getElementById('mplTimelineHg').setAttribute('d', pathHg);
            document.getElementById('mplTimelineLg').setAttribute('d', pathLg);
        }

        // Kreslení schodovitých ROC křivek (Jemný profil 1.35px)
        function drawStepRocCurve(points, elementId) {
            const svgMinX = 70;
            const svgMaxX = 630;
            const svgMinY = 450;
            const svgMaxY = 30;

            // Start at (0,0)
            let currentX = svgMinX;
            let currentY = svgMinY;
            let pathD = 'M ' + currentX.toFixed(1) + ' ' + currentY.toFixed(1);

            points.forEach(pt => {
                const targetX = (svgMinX + pt.fpr * (svgMaxX - svgMinX)).toFixed(1);
                const targetY = (svgMinY - pt.tpr * (svgMinY - svgMaxY)).toFixed(1);

                // Step-wise horizontal then vertical transition (drawstyle='steps-post')
                pathD += ' L ' + targetX + ' ' + currentY.toFixed(1);
                pathD += ' L ' + targetX + ' ' + targetY;

                currentX = parseFloat(targetX);
                currentY = parseFloat(targetY);
            });

            // Ensure ending at (1,1)
            pathD += ' L ' + svgMaxX + ' ' + svgMaxY;

            document.getElementById(elementId).setAttribute('d', pathD);
        }

        document.addEventListener('DOMContentLoaded', () => {
            drawTimelineGraph();
            drawStepRocCurve(rocPointsProb, 'pathProbMpl');
            drawStepRocCurve(rocPointsCovered, 'pathCoveredMpl');
            drawStepRocCurve(rocPointsPfhg, 'pathPfhgMpl');

            if (window.renderMathInElement) {
                renderMathInElement(document.body, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '$', right: '$', display: false}
                    ]
                });
            }
        });
    </script>
</body>
</html>`;
}

/**
 * Nahrání vygenerovaného HTML souboru na WEDOS FTP Server (cipek.eu)
 */
async function uploadDashboardToFtp(localHtmlPath) {
    const client = new ftp.Client();
    client.ftp.verbose = true;

    try {
        console.log(`\n1. Připojuji se k WEDOS FTP serveru (${FTP_HOST})...`);
        await client.access({
            host: FTP_HOST,
            user: FTP_USER,
            password: FTP_PASS,
            secure: false
        });

        console.log(`2. Přecházím do složky /www/...`);
        await client.cd('/www');

        console.log(`3. Nahrávám prospektivní validaci jako 'prospektivni_validace.html'...`);
        await client.uploadFrom(localHtmlPath, 'prospektivni_validace.html');

        console.log(`4. Nahrávám kopii jako 'validace.html'...`);
        await client.uploadFrom(localHtmlPath, 'validace.html');

        console.log(`\n🎉 PUBLIKACE NA FTP 100% ÚSPĚŠNÁ!`);
        console.log(`🌐 Živá adresa 1: http://cipek.eu/prospektivni_validace.html`);
        console.log(`🌐 Živá adresa 2: http://cipek.eu/validace.html\n`);
    } catch (err) {
        console.error(`❌ Chyba při nahrávání na FTP:`, err.message);
        throw err;
    } finally {
        client.close();
    }
}

import { fileURLToPath } from 'url';
const __filename_pv = fileURLToPath(import.meta.url);

if (process.argv[1]) {
    try {
        const realScriptPath = fs.realpathSync(__filename_pv);
        const realArgPath = fs.realpathSync(process.argv[1]);
        if (realScriptPath.toLowerCase() === realArgPath.toLowerCase()) {
            runProspectiveRocValidation();
        }
    } catch {
        // standalone execution fallback
    }
}
