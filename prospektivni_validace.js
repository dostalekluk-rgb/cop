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

/**
 * Sestavení plně anonymizovaných strukturovaných záznamů pro 33 spárovaných případů z histologické databáze s REDCapem
 * ŽÁDNÁ JMÉNA ANI RODNÁ ČÍSLA PACIENTEK NEJSOU ZDE UKLÁDÁNA ANI PŘENÁŠENA!
 */
export function buildMatchedCases(googleRows, redcapRecords) {
    if (!googleRows || !Array.isArray(googleRows)) return [];
    const redcapMap = new Map();
    if (redcapRecords && Array.isArray(redcapRecords)) {
        redcapRecords.forEach(r => {
            const id = (r.record_id || r.id || r.rc || '').toString().trim();
            if (id) redcapMap.set(id, r);
        });
    }

    const matchedCases = [];
    for (let i = 0; i < googleRows.length; i++) {
        const row = googleRows[i];
        const redcapId = (row[11] || '').toString().trim();
        if (!redcapId) continue;

        const rcRec = redcapMap.get(redcapId);
        const datumPrijmuStr = row[0] || '';
        // PLNÁ ANONYMIZACE: row[1] (jméno) ani row[2] (rodné číslo) se v žádném případě nepoužijí!
        const punchBiopsie = (row[5] || '').toString().trim().toLowerCase();
        const konizace = (row[6] || '').toString().trim().toLowerCase();
        const textDesc = (row[3] || '').toString().toLowerCase();
        const vysledekStr = (row[7] || '').toString().trim();

        let procedureType = 'Punch biopsie';
        if (konizace === 'ano' || textDesc.includes('konus') || textDesc.includes('koniz')) {
            procedureType = 'Konizace';
        } else if (punchBiopsie === 'ano') {
            procedureType = 'Punch biopsie';
        }

        const recDateStr = rcRec ? (rcRec.datum || rcRec.v1_date || rcRec.vfu_date || '') : '';
        const dateGoogle = parseDate(datumPrijmuStr);
        const dateRedcap = parseDate(recDateStr);
        let diffDays = null;
        if (dateGoogle && dateRedcap) {
            diffDays = Math.round((dateGoogle.getTime() - dateRedcap.getTime()) / (1000 * 60 * 60 * 24));
        }

        const probVal = rcRec ? (rcRec.prob !== undefined && rcRec.prob !== '' ? rcRec.prob : rcRec.hg_probability) : null;
        const coveredVal = rcRec ? (rcRec.covered !== undefined && rcRec.covered !== '' ? rcRec.covered : rcRec.tz_covered_by_hg_frac) : null;
        const pfhgVal = rcRec ? (rcRec.pfhg !== undefined && rcRec.pfhg !== '' ? rcRec.pfhg : rcRec.pixel_fraction_hg) : null;

        const xProb = probVal !== null && probVal !== undefined ? parseFloat(probVal) : null;
        const xCovered = coveredVal !== null && coveredVal !== undefined ? parseFloat(coveredVal) : null;
        const xPfhg = pfhgVal !== null && pfhgVal !== undefined ? parseFloat(pfhgVal) : null;

        let catKey = 'ned';
        const vLower = vysledekStr.toLowerCase();
        if (vLower.includes('cin3') || vLower.includes('cin 3') || vLower.includes('karcinom') || vLower.includes('ais')) {
            catKey = 'cin3';
        } else if (vLower.includes('cin2') || vLower.includes('cin 2')) {
            catKey = 'cin2';
        } else if (vLower.includes('cin1') || vLower.includes('cin 1')) {
            catKey = 'cin1';
        } else {
            catKey = 'ned';
        }

        const formatCz = (d) => {
            if (!d) return '';
            return `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}`;
        };

        const caseIdx = matchedCases.length + 1;
        matchedCases.push({
            id: caseIdx,
            case_label: `Případ #${caseIdx}`,
            redcap_id: redcapId,
            histo_date: datumPrijmuStr,
            histo_date_formatted: dateGoogle ? formatCz(dateGoogle) : datumPrijmuStr,
            redcap_date: recDateStr,
            redcap_date_formatted: dateRedcap ? formatCz(dateRedcap) : recDateStr,
            diff_days: diffDays,
            procedure_type: procedureType,
            histo_result: vysledekStr || 'neuvedeno',
            category_key: catKey,
            prob: xProb !== null && !isNaN(xProb) ? Math.round(xProb * 10000) / 10000 : null,
            covered: xCovered !== null && !isNaN(xCovered) ? Math.round(xCovered * 10000) / 10000 : null,
            pfhg: xPfhg !== null && !isNaN(xPfhg) ? Math.round(xPfhg * 10000) / 10000 : null,
            image_url: `model_images/${redcapId}_model.png`
        });
    }

    return matchedCases;
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
            record_id: r.record_id || r.id || '',
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

    // 4. Načtení řádků z Google Tabulky pro detailní tabulku případů
    console.log(`📥 Načítám řádky z Google Tabulky pro detailní tabulku případů...`);
    let googleSheetRows = [];
    try {
        const GOOGLE_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzNzshLzdHwfbAjrMF_8vMImHq7sw-H6TH-Ns1ELs4v2nJ4OtLrWS6tQBXIJpnD2MCD/exec';
        const gRes = await fetch(GOOGLE_WEB_APP_URL);
        const gJson = await gRes.json();
        googleSheetRows = Array.isArray(gJson) ? gJson : (gJson.data || gJson.rows || []);
    } catch (gErr) {
        console.warn(`⚠️ Nepodařilo se stáhnout data z Google Tabulky:`, gErr.message);
    }
    const matchedCases = buildMatchedCases(googleSheetRows, allRecords);
    console.log(`Celkem spárováno pro detailní tabulku případů: ${matchedCases.length} případů.`);

    // 5. Vygenerování HTML Dashboardu s jemnými tenkými grafy a tabulkou případů
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
        rocPfhg,
        matchedCases
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

    const matchedCases = stats.matchedCases || [];
    const statsKon = matchedCases.filter(c => c.procedure_type === 'Konizace').length;
    const statsPb = matchedCases.filter(c => c.procedure_type === 'Punch biopsie').length;
    const statsCin3 = matchedCases.filter(c => c.category_key === 'cin3').length;
    const statsCin2 = matchedCases.filter(c => c.category_key === 'cin2').length;
    const statsCin1 = matchedCases.filter(c => c.category_key === 'cin1').length;
    const statsNed = matchedCases.filter(c => c.category_key === 'ned').length;

    let casesTableRowsHtml = '';
    matchedCases.forEach((c, idx) => {
        const probText = c.prob !== null ? (c.prob * 100).toFixed(1) + ' %' : '–';
        const coveredText = c.covered !== null ? (c.covered * 100).toFixed(1) + ' %' : '–';
        const pfhgText = c.pfhg !== null ? (c.pfhg * 100).toFixed(1) + ' %' : '–';
        const isHgAlert = c.prob !== null && c.prob >= 0.5;

        casesTableRowsHtml += `
            <tr class="case-row" data-index="${idx}" data-category="${c.category_key}" data-type="${c.procedure_type === 'Konizace' ? 'konizace' : 'punch'}">
                <td style="text-align: center; font-weight: 700; color: var(--text-muted); font-size: 1.05rem;">${idx + 1}</td>
                <td style="text-align: center; padding: 12px 10px;">
                    <div class="thumb-container" onclick="openLightbox(${idx})" title="Kliknutím otevřete detail snímku v plné velikosti">
                        <img src="${c.image_url}" alt="Model ${c.redcap_id}" class="model-thumb" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'240\\' height=\\'240\\' viewBox=\\'0 0 240 240\\'><rect width=\\'240\\' height=\\'240\\' fill=\\'%231e293b\\'/><text x=\\'120\\' y=\\'125\\' font-size=\\'14\\' fill=\\'%2394a3b8\\' text-anchor=\\'middle\\'>Bez náhledu</text></svg>';" />
                        <div class="thumb-hover-overlay">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16" y2="16"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
                            <span>Zvětšit snímek</span>
                        </div>
                    </div>
                </td>
                <td>
                    <div class="case-identity-cell">
                        <span class="case-badge-title">${c.case_label}</span>
                        <div><span class="rc-badge" title="REDCap ID">ID: ${c.redcap_id}</span></div>
                    </div>
                </td>
                <td>
                    <span class="badge-procedure ${c.procedure_type === 'Konizace' ? 'badge-kon' : 'badge-pb'}">
                        ${c.procedure_type}
                    </span>
                </td>
                <td>
                    <span class="badge-diag badge-${c.category_key}">
                        ${c.histo_result}
                    </span>
                </td>
                <td>
                    <div class="date-cell">
                        <div class="date-row">
                            <span class="date-lbl">Kolposkopie:</span>
                            <span class="date-val">${c.redcap_date_formatted || '–'}</span>
                        </div>
                        <div class="date-row">
                            <span class="date-lbl">Histologie:</span>
                            <span class="date-val">${c.histo_date_formatted || '–'}</span>
                        </div>
                        ${c.diff_days !== null ? `<div class="date-diff ${c.diff_days > 45 ? 'diff-warn' : ''}">Odstup: ${c.diff_days} ${c.diff_days === 1 ? 'den' : (c.diff_days >= 2 && c.diff_days <= 4 ? 'dny' : 'dní')}</div>` : ''}
                    </div>
                </td>
                <td>
                    <div class="metrics-cell">
                        <div class="metric-item">
                            <span class="metric-lbl">prob:</span>
                            <span class="metric-val ${isHgAlert ? 'hg-alert' : ''}">${probText} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">(${c.prob !== null ? c.prob.toFixed(4) : '–'})</span></span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-lbl">covered:</span>
                            <span class="metric-val">${coveredText}</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-lbl">pfhg:</span>
                            <span class="metric-val">${pfhgText}</span>
                        </div>
                    </div>
                </td>
                <td style="text-align: center;">
                    <button class="btn-view-image" onclick="openLightbox(${idx})" title="Zobrazit velký detail snímku">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    </button>
                </td>
            </tr>
        `;
    });

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
            max-width: 1360px;
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


        /* Section 3: Matched Cases Table & Controls */
        .cases-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 12px;
            margin: 20px 0 16px 0;
            padding: 12px 16px;
            background: #f8fafc;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
        }

        .search-box {
            position: relative;
            flex: 1;
            min-width: 260px;
        }

        .search-box svg {
            position: absolute;
            left: 12px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-muted);
            pointer-events: none;
        }

        .search-box input {
            width: 100%;
            padding: 8px 12px 8px 36px;
            font-size: 0.88rem;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
            background: #ffffff;
            color: var(--text-heading);
            font-family: inherit;
            outline: none;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }

        .search-box input:focus {
            border-color: var(--nejm-crimson);
            box-shadow: 0 0 0 2px rgba(153, 0, 0, 0.1);
        }

        .filter-pills {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .filter-pill {
            padding: 6px 12px;
            font-size: 0.78rem;
            font-weight: 600;
            border-radius: 14px;
            border: 1px solid var(--border-subtle);
            background: #ffffff;
            color: var(--text-body);
            cursor: pointer;
            transition: all 0.15s ease;
            font-family: inherit;
        }

        .filter-pill:hover {
            border-color: var(--border-dark);
            background: #f1f5f9;
        }

        .filter-pill.active {
            background: var(--nejm-navy);
            color: #ffffff;
            border-color: var(--nejm-navy);
        }

        .filter-pill.pill-cin3.active { background: var(--nejm-crimson); border-color: var(--nejm-crimson); }
        .filter-pill.pill-cin2.active { background: #ea580c; border-color: #ea580c; }
        .filter-pill.pill-cin1.active { background: #d97706; border-color: #d97706; }
        .filter-pill.pill-ned.active { background: #16a34a; border-color: #16a34a; }

        .table-responsive {
            width: 100%;
            overflow-x: auto;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
            background: #ffffff;
            margin-bottom: 24px;
        }

        .cases-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.88rem;
            margin-bottom: 0;
        }

        .cases-table th {
            position: sticky;
            top: 0;
            background: #f8fafc;
            border-top: none;
            border-bottom: 2px solid var(--text-heading);
            padding: 10px 12px;
            font-weight: 700;
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-heading);
            white-space: nowrap;
        }

        .cases-table td {
            padding: 10px 12px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: middle;
        }

        .cases-table tr:hover td {
            background: #f8fafc;
        }

        /* Thumbnails - Výrazně větší zobrazení (240x240px) pro zřetelnost anotací */
        .thumb-container {
            width: 240px;
            height: 240px;
            position: relative;
            border-radius: 6px;
            overflow: hidden;
            border: 2px solid #cbd5e1;
            box-shadow: 0 4px 12px rgba(0,0,0,0.12);
            cursor: pointer;
            background: #090d16;
            margin: 4px auto;
            display: block;
            transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }

        .thumb-container:hover {
            transform: scale(1.03);
            border-color: var(--nejm-crimson);
            box-shadow: 0 8px 24px rgba(153,0,0,0.22);
        }

        .model-thumb {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
            transition: transform 0.25s ease;
        }

        .thumb-container:hover .model-thumb {
            transform: scale(1.05);
        }

        .thumb-hover-overlay {
            position: absolute;
            inset: 0;
            background: rgba(15, 23, 42, 0.5);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            color: #ffffff;
            font-size: 0.82rem;
            font-weight: 600;
            opacity: 0;
            transition: opacity 0.2s ease;
        }

        .thumb-container:hover .thumb-hover-overlay {
            opacity: 1;
        }

        /* Badges & Identity */
        .case-identity-cell {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }

        .case-badge-title {
            font-weight: 700;
            color: var(--text-heading);
            font-size: 0.95rem;
        }

        .rc-badge {
            display: inline-block;
            font-family: 'Fira Code', monospace;
            font-size: 0.74rem;
            padding: 2px 6px;
            border-radius: 3px;
            background: #f1f5f9;
            color: #475569;
            border: 1px solid #cbd5e1;
            font-weight: 500;
        }

        .badge-procedure {
            display: inline-block;
            font-size: 0.76rem;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 12px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            white-space: nowrap;
        }

        .badge-kon {
            background: #e0e7ff;
            color: #3730a3;
            border: 1px solid #c7d2fe;
        }

        .badge-pb {
            background: #ccfbf1;
            color: #0f766e;
            border: 1px solid #99f6e4;
        }

        .badge-diag {
            display: inline-block;
            font-size: 0.8rem;
            font-weight: 700;
            padding: 4px 9px;
            border-radius: 4px;
            white-space: nowrap;
        }

        .badge-cin3 {
            background: #fee2e2;
            color: #991b1b;
            border: 1px solid #fca5a5;
        }

        .badge-cin2 {
            background: #ffedd5;
            color: #c2410c;
            border: 1px solid #fdba74;
        }

        .badge-cin1 {
            background: #fef3c7;
            color: #b45309;
            border: 1px solid #fde68a;
        }

        .badge-ned {
            background: #dcfce7;
            color: #166534;
            border: 1px solid #bbf7d0;
        }

        .date-cell {
            display: flex;
            flex-direction: column;
            gap: 2px;
            font-size: 0.8rem;
        }

        .date-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
        }

        .date-lbl {
            color: var(--text-muted);
        }

        .date-val {
            font-weight: 600;
            color: var(--text-heading);
        }

        .date-diff {
            font-size: 0.74rem;
            color: #059669;
            font-weight: 600;
            margin-top: 1px;
        }

        .date-diff.diff-warn {
            color: #d97706;
        }

        .metrics-cell {
            display: flex;
            flex-direction: column;
            gap: 3px;
            font-family: 'Fira Code', monospace;
            font-size: 0.8rem;
        }

        .metric-item {
            display: flex;
            justify-content: space-between;
            gap: 6px;
        }

        .metric-lbl {
            color: var(--text-muted);
        }

        .metric-val {
            font-weight: 600;
            color: var(--text-heading);
        }

        .metric-val.hg-alert {
            color: var(--nejm-crimson);
            font-weight: 700;
        }

        .btn-view-image {
            background: #f1f5f9;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
            padding: 6px 10px;
            cursor: pointer;
            color: var(--text-body);
            transition: all 0.15s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .btn-view-image:hover {
            background: var(--nejm-crimson);
            color: #ffffff;
            border-color: var(--nejm-crimson);
        }

        /* Lightbox Modal - Velké zobrazení snímku */
        .lightbox-modal {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.90);
            backdrop-filter: blur(8px);
            z-index: 10000;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .lightbox-modal.open {
            display: flex;
        }

        .lightbox-content {
            background: #ffffff;
            border-radius: 8px;
            max-width: 1340px;
            width: 96%;
            max-height: 94vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.45);
            overflow: hidden;
            animation: modalFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.97); }
            to { opacity: 1; transform: scale(1); }
        }

        .lightbox-header {
            padding: 12px 20px;
            border-bottom: 1px solid var(--border-subtle);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #f8fafc;
        }

        .lightbox-title-area {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        .lightbox-title-area h3 {
            font-size: 1.15rem;
            color: var(--text-heading);
            font-family: 'Merriweather', serif;
        }

        .lightbox-close-btn {
            background: none;
            border: none;
            font-size: 1.8rem;
            line-height: 1;
            color: var(--text-muted);
            cursor: pointer;
            padding: 0 4px;
            border-radius: 4px;
        }

        .lightbox-close-btn:hover {
            color: var(--nejm-crimson);
        }

        .lightbox-body {
            display: flex;
            flex: 1;
            overflow-y: auto;
            gap: 24px;
            padding: 24px;
        }

        @media (max-width: 900px) {
            .lightbox-body {
                flex-direction: column;
            }
        }

        .lightbox-image-area {
            flex: 2;
            background: #060911;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            min-height: 520px;
            max-height: 75vh;
        }

        .lightbox-image-area img {
            max-width: 100%;
            max-height: 72vh;
            object-fit: contain;
            border-radius: 4px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }

        .lightbox-info-area {
            flex: 1;
            min-width: 320px;
            display: flex;
            flex-direction: column;
            font-size: 0.88rem;
        }

        .info-card {
            background: #f8fafc;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
            padding: 14px;
            margin-bottom: 14px;
        }

        .info-card-title {
            font-size: 0.8rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            margin-bottom: 10px;
            border-bottom: 1px solid #e2e8f0;
            padding-bottom: 4px;
        }

        .info-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid #f1f5f9;
        }

        .info-item:last-child {
            border-bottom: none;
        }

        .info-lbl {
            color: var(--text-muted);
            font-size: 0.84rem;
        }

        .info-val {
            font-weight: 600;
            color: var(--text-heading);
            font-size: 0.88rem;
        }

        .lightbox-footer {
            padding: 10px 20px;
            border-top: 1px solid var(--border-subtle);
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #f8fafc;
        }

        .lightbox-nav-btn {
            padding: 6px 14px;
            background: #ffffff;
            border: 1px solid var(--border-subtle);
            border-radius: 4px;
            font-size: 0.82rem;
            font-weight: 600;
            color: var(--text-body);
            cursor: pointer;
            transition: all 0.15s ease;
            font-family: inherit;
        }

        .lightbox-nav-btn:hover {
            background: #f1f5f9;
            border-color: var(--border-dark);
        }

        .btn-full-res {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            background: var(--nejm-navy);
            color: #ffffff;
            text-decoration: none;
            border-radius: 4px;
            font-size: 0.82rem;
            font-weight: 600;
            transition: background 0.15s ease;
            margin-top: 8px;
        }

        .btn-full-res:hover {
            background: #0f172a;
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

        <!-- Section 3: Detailní Přehled Spárovaných Případů a Anotací Modelu -->
        <section class="nejm-section" id="section-matched-cases">
            <div class="section-header">
                <h2>3. Přehled Případů z Histologické Databáze Spárovaných s REDCapem</h2>
                <span class="table-num">TABLE 3 & MODEL ANNOTATIONS (N = ${matchedCases.length})</span>
            </div>

            <p style="font-size: 0.92rem; color: var(--text-body); margin-bottom: 16px;">
                Následující tabulka uvádí všech <strong>${matchedCases.length} plně anonymizovaných případů</strong> z centrální tabulky <code>histologie_cop</code>, které mají identifikovaný a spárovaný záznam v registru REDCap. U každého případu je k dispozici velký anotovaný kolposkopický snímek vrácený AI segmentačním modelem s vyznačenou transformační zónou a lézí, vypočtené predikční parametry ($prob$, $covered$, $pfhg$), typ provedeného zákroku (konizace vs. punch biopsie), datumy provedení a finální histologický nález.
            </p>

            <div class="cases-toolbar">
                <div class="search-box">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input type="text" id="caseSearchInput" placeholder="Hledat podle REDCap ID, diagnózy, výkonu, data..." onkeyup="handleSearchFilter()" />
                </div>
                <div class="filter-pills">
                    <button class="filter-pill active" data-filter="all" onclick="setCategoryFilter('all', this)">Vše (${matchedCases.length})</button>
                    <button class="filter-pill" data-filter="konizace" onclick="setCategoryFilter('konizace', this)">Konizace (${statsKon})</button>
                    <button class="filter-pill" data-filter="punch" onclick="setCategoryFilter('punch', this)">Punch biopsie (${statsPb})</button>
                    <button class="filter-pill pill-cin3" data-filter="cin3" onclick="setCategoryFilter('cin3', this)">CIN 3 (${statsCin3})</button>
                    <button class="filter-pill pill-cin2" data-filter="cin2" onclick="setCategoryFilter('cin2', this)">CIN 2 (${statsCin2})</button>
                    <button class="filter-pill pill-cin1" data-filter="cin1" onclick="setCategoryFilter('cin1', this)">CIN 1 (${statsCin1})</button>
                    <button class="filter-pill pill-ned" data-filter="ned" onclick="setCategoryFilter('ned', this)">Bez dysplázie (${statsNed})</button>
                </div>
            </div>

            <div class="table-responsive">
                <table class="nejm-table cases-table" id="casesTable">
                    <thead>
                        <tr>
                            <th style="width: 40px; text-align: center;">#</th>
                            <th style="width: 260px; text-align: center;">Anotovaný Snímek z Modelu</th>
                            <th style="min-width: 130px;">Identifikátor</th>
                            <th style="min-width: 120px;">Typ Výkonu</th>
                            <th style="min-width: 110px;">Výsledek Histologie</th>
                            <th style="min-width: 160px;">Datum Provedení & Odstup</th>
                            <th style="min-width: 170px;">Parametry AI Modelu</th>
                            <th style="width: 60px; text-align: center;">Detail</th>
                        </tr>
                    </thead>
                    <tbody id="casesTableBody">
                        ${casesTableRowsHtml}
                    </tbody>
                </table>
            </div>
        </section>

        <footer class="nejm-footer">
            <div>RECER AI Colposcopy Validation Study Group &copy; 2026</div>
            <div>Generated automatically from VFN REDCap Registry</div>
        </footer>

    </div>

    <!-- Lightbox Modal pro Detailní Zobrazení Anotovaného Snímku a Parametrů -->
    <div id="imageLightboxModal" class="lightbox-modal" onclick="handleLightboxBackdropClick(event)">
        <div class="lightbox-content">
            <div class="lightbox-header">
                <div class="lightbox-title-area">
                    <h3 id="modalCaseTitle">Případ #1</h3>
                    <span id="modalRedcapId" class="rc-badge"></span>
                    <span id="modalProcBadge" class="badge-procedure"></span>
                    <span id="modalDiagBadge" class="badge-diag"></span>
                </div>
                <button class="lightbox-close-btn" onclick="closeLightbox()" title="Zavřít (Esc)">&times;</button>
            </div>
            <div class="lightbox-body">
                <div class="lightbox-image-area">
                    <img id="modalImg" src="" alt="Anotovaný snímek vrácený modelem" />
                </div>
                <div class="lightbox-info-area">
                    <div class="info-card">
                        <div class="info-card-title">Klinické & Histopatologické Údaje</div>
                        <div class="info-item">
                            <span class="info-lbl">Typ výkonu:</span>
                            <span class="info-val" id="modalInfoType"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Histologický výsledek:</span>
                            <span class="info-val" id="modalInfoResult"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Datum kolposkopie (REDCap):</span>
                            <span class="info-val" id="modalInfoRcDate"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Datum histologie:</span>
                            <span class="info-val" id="modalInfoHistoDate"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Časový interval:</span>
                            <span class="info-val" id="modalInfoDiff"></span>
                        </div>
                    </div>

                    <div class="info-card">
                        <div class="info-card-title">Predikční Parametry AI Modelu</div>
                        <div class="info-item">
                            <span class="info-lbl">HG Pravděpodobnost (prob):</span>
                            <span class="info-val" id="modalInfoProb"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Pokrytí léze v TZ (covered):</span>
                            <span class="info-val" id="modalInfoCovered"></span>
                        </div>
                        <div class="info-item">
                            <span class="info-lbl">Plošný podíl léze (pfhg):</span>
                            <span class="info-val" id="modalInfoPfhg"></span>
                        </div>
                    </div>

                    <div>
                        <a id="modalFullLink" href="" target="_blank" class="btn-full-res">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                            Otevřít snímek v plném rozlišení
                        </a>
                    </div>
                </div>
            </div>
            <div class="lightbox-footer">
                <button class="lightbox-nav-btn" onclick="prevLightbox()">&larr; Předchozí</button>
                <span id="modalCounter" style="font-size: 0.85rem; color: var(--text-muted); font-weight: 500;">Případ 1 z ${matchedCases.length}</span>
                <button class="lightbox-nav-btn" onclick="nextLightbox()">Následující &rarr;</button>
            </div>
        </div>
    </div>

    <script>
        const casesData = ${JSON.stringify(matchedCases)};
        let currentFilterCategory = 'all';
        let currentLightboxIndex = 0;

        function handleSearchFilter() {
            const query = (document.getElementById('caseSearchInput').value || '').toLowerCase().trim();
            const rows = document.querySelectorAll('#casesTableBody tr.case-row');

            rows.forEach(r => {
                const idx = parseInt(r.getAttribute('data-index'), 10);
                const item = casesData[idx];
                if (!item) return;

                const cat = r.getAttribute('data-category');
                const ptype = r.getAttribute('data-type');

                let matchCat = (currentFilterCategory === 'all') ||
                               (currentFilterCategory === 'konizace' && ptype === 'konizace') ||
                               (currentFilterCategory === 'punch' && ptype === 'punch') ||
                               (currentFilterCategory === cat);

                const matchQuery = !query ||
                                   item.case_label.toLowerCase().includes(query) ||
                                   item.redcap_id.toLowerCase().includes(query) ||
                                   item.histo_result.toLowerCase().includes(query) ||
                                   item.procedure_type.toLowerCase().includes(query) ||
                                   (item.histo_date_formatted && item.histo_date_formatted.includes(query)) ||
                                   (item.redcap_date_formatted && item.redcap_date_formatted.includes(query));

                if (matchCat && matchQuery) {
                    r.style.display = '';
                } else {
                    r.style.display = 'none';
                }
            });
        }

        function setCategoryFilter(cat, btn) {
            currentFilterCategory = cat;
            document.querySelectorAll('.filter-pills .filter-pill').forEach(b => b.classList.remove('active'));
            if (btn) btn.classList.add('active');
            handleSearchFilter();
        }

        function openLightbox(index) {
            if (index < 0 || index >= casesData.length) return;
            currentLightboxIndex = index;
            const item = casesData[index];

            document.getElementById('modalCaseTitle').textContent = item.case_label;
            document.getElementById('modalRedcapId').textContent = 'REDCap ID: ' + item.redcap_id;

            const procBadge = document.getElementById('modalProcBadge');
            procBadge.textContent = item.procedure_type;
            procBadge.className = 'badge-procedure ' + (item.procedure_type === 'Konizace' ? 'badge-kon' : 'badge-pb');

            const diagBadge = document.getElementById('modalDiagBadge');
            diagBadge.textContent = item.histo_result;
            diagBadge.className = 'badge-diag badge-' + item.category_key;

            document.getElementById('modalImg').src = item.image_url;
            document.getElementById('modalInfoType').textContent = item.procedure_type;
            document.getElementById('modalInfoResult').textContent = item.histo_result;
            document.getElementById('modalInfoRcDate').textContent = item.redcap_date_formatted || '–';
            document.getElementById('modalInfoHistoDate').textContent = item.histo_date_formatted || '–';
            document.getElementById('modalInfoDiff').textContent = item.diff_days !== null ? (item.diff_days + ' dní po vizitě') : '–';

            const probStr = item.prob !== null ? ((item.prob * 100).toFixed(1) + ' % (' + item.prob.toFixed(4) + ')') : '–';
            const coveredStr = item.covered !== null ? ((item.covered * 100).toFixed(1) + ' % (' + item.covered.toFixed(4) + ')') : '–';
            const pfhgStr = item.pfhg !== null ? ((item.pfhg * 100).toFixed(1) + ' % (' + item.pfhg.toFixed(4) + ')') : '–';

            document.getElementById('modalInfoProb').textContent = probStr;
            document.getElementById('modalInfoCovered').textContent = coveredStr;
            document.getElementById('modalInfoPfhg').textContent = pfhgStr;

            document.getElementById('modalFullLink').href = item.image_url;
            document.getElementById('modalCounter').textContent = 'Případ ' + (index + 1) + ' z ' + casesData.length;

            document.getElementById('imageLightboxModal').classList.add('open');
            document.body.style.overflow = 'hidden';
        }

        function closeLightbox() {
            document.getElementById('imageLightboxModal').classList.remove('open');
            document.body.style.overflow = '';
        }

        function handleLightboxBackdropClick(e) {
            if (e.target.id === 'imageLightboxModal') {
                closeLightbox();
            }
        }

        function prevLightbox() {
            let newIdx = currentLightboxIndex - 1;
            if (newIdx < 0) newIdx = casesData.length - 1;
            openLightbox(newIdx);
        }

        function nextLightbox() {
            let newIdx = currentLightboxIndex + 1;
            if (newIdx >= casesData.length) newIdx = 0;
            openLightbox(newIdx);
        }

        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('imageLightboxModal');
            if (modal && modal.classList.contains('open')) {
                if (e.key === 'Escape') closeLightbox();
                else if (e.key === 'ArrowLeft') prevLightbox();
                else if (e.key === 'ArrowRight') nextLightbox();
            }
        });

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
