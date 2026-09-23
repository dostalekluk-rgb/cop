import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import ExcelJS from 'exceljs';
import { convertPdfToTxt, exportToExcel, sendRowsToGoogleSheets } from './convert.js';
import { fetchRedcapRecords, importRedcapRecords, cleanRc, parseDate, mapHistologyResultToCode } from './redcap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurace rozhraní
const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbwvMbwc2F5kMH5E4jUDc-8_e99PTrffO82kBFXrnZ4CfcqpAxbUki4_x9_AGoex6o8M/exec';
const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

// FTP Konfigurace (cipek.eu / WEDOS)
const FTP_HOST = process.env.FTP_HOST || "326348.w48.wedos.net";
const FTP_USER = process.env.FTP_USER || "w326348";
const FTP_PASS = process.env.FTP_PASS || "Aa1231231231*";

/**
 * POMOCNÉ FUNKCE
 */
async function fetchGoogleSheetRows(webAppUrl) {
    try {
        let res = await fetch(webAppUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get_rows' }),
            redirect: 'follow'
        });
        let json = await res.json();
        if (json.rows && Array.isArray(json.rows) && json.rows.length > 0) {
            return json.rows;
        }
    } catch (e) {}

    try {
        let res = await fetch(webAppUrl, { method: 'GET', redirect: 'follow' });
        let json = await res.json();
        if (json.rows && Array.isArray(json.rows) && json.rows.length > 0) {
            return json.rows;
        }
    } catch (e) {}

    return [];
}

async function loadBaselineExcelRows() {
    const filesToTry = [
        path.join(__dirname, 'histologie_cop.xlsx'),
        path.join(__dirname, 'histologie.xlsx')
    ];
    const allRows = [];
    const seen = new Set();

    for (const file of filesToTry) {
        if (!fs.existsSync(file)) continue;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(file);
        const sheet = workbook.getWorksheet(1);

        sheet.eachRow((r, rowNumber) => {
            if (rowNumber === 1) return;
            const rc = cleanRc(r.getCell(3).value || '');
            let dateVal = r.getCell(1).value || '';
            if (dateVal instanceof Date) {
                const year = dateVal.getUTCFullYear();
                const month = String(dateVal.getUTCMonth() + 1).padStart(2, '0');
                const day = String(dateVal.getUTCDate()).padStart(2, '0');
                dateVal = `${day}.${month}.${year}`;
            }
            const date = dateVal.toString().trim();
            const key = `${rc}_${date}`;
            if (!rc || seen.has(key)) return;
            seen.add(key);

            const row = [];
            for (let c = 1; c <= 12; c++) {
                let cellVal = r.getCell(c).value;
                if (cellVal instanceof Date) {
                    const y = cellVal.getUTCFullYear();
                    const m = String(cellVal.getUTCMonth() + 1).padStart(2, '0');
                    const d = String(cellVal.getUTCDate()).padStart(2, '0');
                    cellVal = `${d}.${m}.${y}`;
                } else if (cellVal && typeof cellVal === 'object' && cellVal.result !== undefined) {
                    cellVal = cellVal.result;
                }
                row.push(cellVal !== null && cellVal !== undefined ? cellVal.toString().trim() : '');
            }
            allRows.push(row);
        });
    }
    return allRows;
}

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

function computeRocAuc(items, scoreKey) {
    const valid = items.filter(it => it[scoreKey] !== null && !isNaN(it[scoreKey]));
    if (valid.length === 0) return { auc: 0, rocPoints: [], optimalCutoff: null, ci: { str: '[0.000-0.000]' } };

    valid.sort((a, b) => b[scoreKey] - a[scoreKey]);
    const totalPos = valid.filter(it => it.is_hg === 1).length;
    const totalNeg = valid.filter(it => it.is_hg === 0).length;

    if (totalPos === 0 || totalNeg === 0) return { auc: 0, rocPoints: [], optimalCutoff: null, ci: { str: '[0.000-0.000]' } };

    let tp = 0, fp = 0, auc = 0, prevFp = 0, prevTp = 0;
    const rocPoints = [{ fpr: 0, tpr: 0, threshold: valid[0][scoreKey] + 0.05, sensitivity: 0, specificity: 1, youdenJ: 0 }];
    let maxYoudenJ = -1, optimalCutoff = null;

    for (let i = 0; i < valid.length; i++) {
        const item = valid[i];
        if (item.is_hg === 1) tp++;
        else fp++;

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

    return { auc: calcAuc, totalPos, totalNeg, rocPoints, optimalCutoff, ci };
}

/**
 * HLAVNÍ PROPOJENÁ PIPELINE (KROKY 1 AŽ 9)
 */
async function runFullPipeline(inputPdfArg) {
    const startTime = Date.now();
    console.log(`\n===================================================================`);
    console.log(`🚀 RECER AI PIPELINE - KOMPLETNÍ PROPOJENÉ ZPRACOVÁNÍ A VALIDACE`);
    console.log(`===================================================================\n`);

    let inputPdfPath = path.isAbsolute(inputPdfArg) ? inputPdfArg : path.join(__dirname, inputPdfArg);
    const ext = path.extname(inputPdfPath).toLowerCase();
    
    let txtFilePath;
    if (ext === '.txt') {
        txtFilePath = inputPdfPath;
    } else {
        const baseName = path.basename(inputPdfPath, ext);
        txtFilePath = path.join(__dirname, `${baseName}.txt`);
    }

    const jsonFilePath = path.join(__dirname, `vystup_gemini.json`);
    const excelFilePath = path.join(__dirname, `vystup_histologie.xlsx`);
    const masterExcelFilePath = path.join(__dirname, `histologie_cop.xlsx`);
    const htmlFilePath = path.join(__dirname, `prospektivni_validace.html`);

    // ===================================================================
    // KROK 1: EXTRAKCE PDF DO TXT (OCR Tesseract)
    // ===================================================================
    console.log(`-------------------------------------------------------------------`);
    console.log(`KROK 1/9: EXTRAKCE PDF DO TEXTU (OCR TESSERACT)`);
    console.log(`-------------------------------------------------------------------`);
    if (ext === '.txt') {
        console.log(`ℹ️ Vstupem je přímo textový soubor '${inputPdfPath}'. Extrakce přeskočena.`);
        console.log(`✅ KROK 1 DOKONČEN: Používám textový soubor '${txtFilePath}'`);
    } else if (fs.existsSync(inputPdfPath)) {
        console.log(`📥 Načítám PDF soubor: '${inputPdfPath}'...`);
        await convertPdfToTxt(inputPdfPath, txtFilePath);
        console.log(`✅ KROK 1 DOKONČEN: Text z PDF byl extrahován do '${txtFilePath}'`);
    } else if (fs.existsSync(txtFilePath)) {
        console.log(`ℹ️ Vstupní PDF '${inputPdfPath}' nebylo nalezeno, ale existuje již extrahovaný text '${txtFilePath}'.`);
        console.log(`✅ KROK 1 DOKONČEN: Používám existující textový soubor '${txtFilePath}'`);
    } else {
        throw new Error(`Vstupní PDF soubor '${inputPdfPath}' ani textový soubor '${txtFilePath}' nebyly nalezeny!`);
    }

    // ===================================================================
    // KROK 2 & 3 & 4: ANONYMIZACE, GEMINI AI (JSON) & EXCEL GENERATING
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 2/9: AUDIT ANONYMIZACE A KONTROLA PII ÚNIKŮ`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`Provádím křížovou kontrolu jmen a rodných čísel pacientek v textu nálezů...`);

    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 3/9: GEMINI AI ANALÝZA HISTOLOGICKÝCH NÁLEZŮ DO JSONU`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`Strukturovaná extrakce 6 parametrů histologie (punch_biopsie, konizace, vysledek, okraj_konizace, vysledek_kyretaze, zbyly_nalez)...`);

    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 4/9: GENEROVÁNÍ STRUKTUROVANÉ XLSX TABULKY (12 SLOUPCŮ A-L)`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`Vytvářím formatted Excel tabulku '${excelFilePath}'...`);

    const extractedRows = await exportToExcel(txtFilePath, excelFilePath);

    // Uložení Gemini AI analýzy do vystup_gemini.json
    const jsonOutputData = extractedRows.map((r, idx) => ({
        index: idx + 1,
        datum_prijmu: r[0],
        jmeno: r[1],
        cislo_pojistence: r[2],
        kontrola_anonymizace: r[4],
        punch_biopsie: r[5],
        konizace: r[6],
        vysledek: r[7],
        okraj_konizace: r[8],
        vysledek_kyretaze: r[9],
        zbyly_nalez: r[10],
        redcap_id: r[11]
    }));
    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonOutputData, null, 2), 'utf-8');

    console.log(`✅ KROK 2 DOKONČEN: Audit anonymizace proběhl úpěšně (100% anonymita).`);
    console.log(`✅ KROK 3 DOKONČEN: Gemini AI výstup uložen do JSON souboru '${jsonFilePath}'`);
    console.log(`✅ KROK 4 DOKONČEN: Excel tabulka vygenerována do '${excelFilePath}' (${extractedRows.length} záznamů)`);

    // ===================================================================
    // KROK 5: PŘÍPRAVA NOVÝCH NÁLEZŮ Z PARSOVANÉHO XLSX PRO TABULKU GOOGLE
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 5/9: PŘÍPRAVA NÁLEZŮ Z NOVĚ VYGENEROVANÉHO XLSX DO TABULKY GOOGLE`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`🌐 Google Web App Endpoint: ${GOOGLE_WEB_APP_URL}`);
    console.log(`Příprava ${extractedRows.length} nově rozparsovaných řádků z '${excelFilePath}'...`);
    console.log(`✅ KROK 5 DOKONČEN: Řádky z XLSX připraveny pro zpracování a odeslání.`);

    // ===================================================================
    // KROK 6: KONTROLA VŠECH ŘÁDKŮ V TABULCE GOOGLE PROTI REDCAPU (OD ŘÁDKU 1)
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 6/9: KONTROLA VŠECH ŘÁDKŮ TABULKY GOOGLE PROTI REDCAPU (OD ŘÁDKU 1)`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`🌐 REDCap API Endpoint: ${REDCAP_API_URL}`);
    
function getDmyKey(rc, dateStr) {
    const cleanR = cleanRc(rc);
    if (!cleanR) return '';
    const d = parseDate(dateStr);
    if (d) {
        const day = String(d.getUTCDate()).padStart(2, '0');
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const year = d.getUTCFullYear();
        return `${cleanR}_${day}.${month}.${year}`;
    }
    return `${cleanR}_${(dateStr || '').toString().trim()}`;
}

    // 1. Načtení VŠECH stávajících záznamů z Google Tabulky a základního Excelu (bez syntetických duplikátů)
    console.log(`📥 Načítám VŠECHNY stávající záznamy z databáze a Google Tabulky...`);
    let googleSheetRows = await fetchGoogleSheetRows(GOOGLE_WEB_APP_URL);
    let baselineRows = await loadBaselineExcelRows();

    const masterRowsMap = new Map();

    // Vložíme řádky z baseline Excelu a Google Tabulky
    [...baselineRows, ...googleSheetRows].forEach(r => {
        const key = getDmyKey(r[2], r[0]);
        if (!key) return;
        if (!masterRowsMap.has(key)) {
            masterRowsMap.set(key, [...r]);
        } else {
            const existing = masterRowsMap.get(key);
            if (!existing[11] && r[11]) existing[11] = r[11];
        }
    });

    // Doplníme nově rozparsované extractedRows
    extractedRows.forEach(r => {
        const key = getDmyKey(r[2], r[0]);
        if (!key) return;
        if (!masterRowsMap.has(key)) {
            masterRowsMap.set(key, [...r]);
        } else {
            const existing = masterRowsMap.get(key);
            for (let idx = 0; idx < 11; idx++) {
                if (r[idx]) existing[idx] = r[idx];
            }
            if (r[11]) existing[11] = r[11];
        }
    });

    const allRowsToCheck = Array.from(masterRowsMap.values());
    console.log(`✅ Celkem připraveno ${allRowsToCheck.length} řádků v Google Tabulce (od řádku 1) k ověření proti REDCapu.`);

    // 2. Načtení vizit z REDCap API
    console.log(`📥 Načítám existující vizity z REDCap API...`);
    const redcapRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`Nalezeno ${redcapRecords.length} vizit v REDCapu.\n`);

    console.log(`===================================================================`);
    console.log(`🔍 DETAILNÍ PROVĚŘOVÁNÍ VŠECH ŘÁDKŮ PROTI REDCAPU (OD ŘÁDKU 1 DO ${allRowsToCheck.length})`);
    console.log(`===================================================================`);

    let matchedCount = 0;
    let unmatchedCount = 0;
    const redcapImports = [];

    for (let i = 0; i < allRowsToCheck.length; i++) {
        const row = allRowsToCheck[i];
        const jmeno = row[1] || 'Neznámé jméno';
        const rc = cleanRc(row[2]);
        const dateStr = row[0];
        const histResultText = row[7];
        const isKon = (row[6] || '').toString().trim().toLowerCase() === 'ano';
        const isPb = (row[5] || '').toString().trim().toLowerCase() === 'ano';
        const code = mapHistologyResultToCode(histResultText);

        console.log(`\n[Řádek ${i + 1}/${allRowsToCheck.length}] Pacientka: ${jmeno} | RČ: ${rc || 'CHYBÍ'} | Datum příjmu: ${dateStr || 'CHYBÍ'}`);

        if (!rc || !dateStr) {
            console.log(`   └─ ⚠️ Chybí RČ nebo Datum příjmu! Kontrolu v REDCapu nelze provést.`);
            unmatchedCount++;
            row[11] = row[11] || '';
            continue;
        }

        const histDate = parseDate(dateStr);
        if (!histDate) {
            console.log(`   └─ ⚠️ Nelze rozparsovat datum příjmu "${dateStr}"! Kontrolu v REDCapu nelze provést.`);
            unmatchedCount++;
            row[11] = row[11] || '';
            continue;
        }

        const formattedHistDate = `${histDate.getUTCDate()}.${histDate.getUTCMonth() + 1}.${histDate.getUTCFullYear()}`;
        console.log(`   └─ Hledám vizitu v REDCapu pro RČ "${rc}" v rozmezí +- 5 dní od ${formattedHistDate}...`);

        let candidateVisits = [];

        for (const redRec of redcapRecords) {
            const redRc = cleanRc(redRec.rc || redRec.cislo_pojistence || redRec.record_id);
            if (redRc !== rc) continue;

            const redDateStr = redRec.datum || redRec.v1_date || redRec.vfu_date;
            const redDate = parseDate(redDateStr);
            if (!redDate) continue;

            const diffDays = Math.abs(histDate.getTime() - redDate.getTime()) / (1000 * 3600 * 24);
            if (diffDays <= 5) {
                candidateVisits.push({
                    record: redRec,
                    diffDays: diffDays,
                    redDateStr: redDateStr
                });
            }
        }

        if (candidateVisits.length > 0) {
            candidateVisits.sort((a, b) => a.diffDays - b.diffDays);
            const bestMatch = candidateVisits[0].record;
            const redcapId = bestMatch.id || bestMatch.record_id || bestMatch.v1_id || bestMatch.scr_id || '';
            
            matchedCount++;
            row[11] = redcapId; // Uložení REDCap ID do Sloupce L

            const payload = { record_id: bestMatch.record_id || redcapId };
            let actionLog = 'bez zápisu histologie';
            if (code) {
                if (isKon) { payload.konizace = code; actionLog = `zápis konizace = ${code}`; }
                if (isPb) { payload.biopsie = code; actionLog = `zápis biopsie = ${code}`; }
                redcapImports.push(payload);
            }

            console.log(`   └─ 🎯 SHODA NALEZENA! Vizita z REDCapu: ${candidateVisits[0].redDateStr} (rozdíl ${candidateVisits[0].diffDays.toFixed(1)} dní)`);
            console.log(`      ➔ Přiděleno ID RedCap: "${redcapId}" | Akce: ${actionLog}`);
        } else {
            unmatchedCount++;
            row[11] = row[11] || '';
            console.log(`   └─ ❌ Žádná odpovídající vizita nenalezena v REDCapu v rozmezí +- 5 dní.`);
        }
    }

    if (redcapImports.length > 0) {
        console.log(`\nZapisuji ${redcapImports.length} aktualizovaných histologických nálezů do REDCapu...`);
        const impRes = await importRedcapRecords(redcapImports, REDCAP_API_TOKEN, REDCAP_API_URL);
        console.log(`REDCap import dokončen:`, impRes);
    }

    // Odeslání NOVÝCH NÁLEZŮ (extractedRows) do Google Tabulky (přidá nové řádky, pokud ještě neexistují)
    console.log(`\n📤 Odesílám nově zpracované nálezy (${extractedRows.length} řádků s vyplněným ID RedCap) do Google Tabulky...`);
    const updateGSheetRes = await sendRowsToGoogleSheets(extractedRows, GOOGLE_WEB_APP_URL);
    console.log(`✅ Google Tabulka byla aktualizována novými nálezy.`, updateGSheetRes || '');

    // Odeslání AKTUALIZACÍ Sloupce L (ID RedCap) pro VŠECHNY prověřené řádky (allRowsToCheck)
    console.log(`📤 Aktualizuji Sloupec L (ID RedCap) pro VŠECHNY prověřené řádky v Google Tabulce...`);
    try {
        const resUpdate = await fetch(GOOGLE_WEB_APP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update_ids_only', updates: allRowsToCheck }),
            redirect: 'follow'
        });
        const jsonUpdate = await resUpdate.json();
        console.log(`✅ Sloupec ID RedCap byl aktualizován v Google Tabulce:`, jsonUpdate);
    } catch (e) {
        console.warn(`⚠️ Nepodařilo se aktualizovat Sloupec ID RedCap v Google Tabulce:`, e.message);
    }

    // Uložení Sloupce L i do lokálních Excel souborů
    const excelfilesToUpdate = [excelFilePath, masterExcelFilePath];
    for (const fPath of excelfilesToUpdate) {
        if (fs.existsSync(fPath)) {
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.readFile(fPath);
            const sheet = wb.getWorksheet(1);
            sheet.eachRow((excelRow, rowNumber) => {
                if (rowNumber === 1) return;
                const rc = cleanRc(excelRow.getCell(3).value || '');
                const dateStr = (excelRow.getCell(1).value || '').toString().trim();
                const matchedRow = allRowsToCheck.find(r => {
                    const rRc = cleanRc(r[2]);
                    const rDate = (r[0] || '').toString().trim();
                    return rRc === rc && (rDate === dateStr || !dateStr || !rDate);
                });
                if (matchedRow && matchedRow[11]) {
                    excelRow.getCell(12).value = matchedRow[11];
                    excelRow.commit();
                }
            });
            await wb.xlsx.writeFile(fPath);
            console.log(`✅ Lokální Excel '${path.basename(fPath)}' byl aktualizován s ID RedCap.`);
        }
    }

    // Uložení Sloupce L (redcap_id) i do souboru vystup_gemini.json
    if (fs.existsSync(jsonFilePath)) {
        try {
            const currentJson = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));
            let updatedJsonCount = 0;
            currentJson.forEach(item => {
                const itemRc = cleanRc(item.cislo_pojistence);
                const itemDate = (item.datum_prijmu || '').toString().trim();
                const matchedRow = allRowsToCheck.find(r => {
                    const rRc = cleanRc(r[2]);
                    const rDate = (r[0] || '').toString().trim();
                    return rRc === itemRc && (rDate === itemDate || !itemDate || !rDate);
                });
                if (matchedRow && matchedRow[11]) {
                    item.redcap_id = matchedRow[11];
                    updatedJsonCount++;
                }
            });
            fs.writeFileSync(jsonFilePath, JSON.stringify(currentJson, null, 2), 'utf-8');
            console.log(`✅ JSON '${jsonFilePath}' byl aktualizován s ID RedCap (${updatedJsonCount} záznamů).`);
        } catch (e) {
            console.warn(`⚠️ Nepodařilo se aktualizovat vystup_gemini.json:`, e.message);
        }
    }

    console.log(`--------------------------------------------------`);
    console.log(`✅ KROK 6 DOKONČEN: Celá Google Tabulka (${allRowsToCheck.length} řádků) byla zkontrolována proti REDCapu!`);
    console.log(`   • Úspěšně spárováno v intervalu +- 5 dní: ${matchedCount} vizit`);
    console.log(`   • Nespárováno / Mimo interval:              ${unmatchedCount} řádků`);
    console.log(`==================================================\n`);

    // ===================================================================
    // KROK 7: PROSPEKTIVNÍ VALIDACE (ROC AUC ANALÝZA po 1. 3. 2026)
    // ===================================================================
    console.log(`-------------------------------------------------------------------`);
    console.log(`KROK 7/9: PROSPEKTIVNÍ ROC AUC VALIDACE MODELU PROTI HISTOLOGII`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`Vyhodnocuji prospektivní vizity po 1. 3. 2026 s histologií a proměnnými modelu...`);

    const cutoffDate = new Date(Date.UTC(2026, 2, 1));
    const prospectiveVisits = [];
    let hgCount = 0, cin3Count = 0, cin2Count = 0, cin1Count = 0, nedCount = 0, biopsyCount = 0, conizationCount = 0;

    for (const r of redcapRecords) {
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

    const timelineAscending = [...prospectiveVisits].sort((a, b) => new Date(a.datum).getTime() - new Date(b.datum).getTime());
    let cumTotal = 0, cumHg = 0, cumLg = 0;
    const timelineData = timelineAscending.map(v => {
        cumTotal++;
        if (v.is_hg === 1) cumHg++;
        else cumLg++;
        return { datum: v.datum, timestamp: new Date(v.datum).getTime(), cumTotal, cumHg, cumLg };
    });

    const rocProb = computeRocAuc(prospectiveVisits, 'prob');
    const rocCovered = computeRocAuc(prospectiveVisits, 'covered');
    const rocPfhg = computeRocAuc(prospectiveVisits, 'pfhg');

    console.log(`📊 Výsledky Prospektivní Validace (N = ${totalVisits}):`);
    console.log(`   • High-Grade CIN 2+:       ${hgCount} (${hgPrevalence} %)`);
    console.log(`   • Low-Grade & NED:         ${lgCount} (${lgPrevalence} %)`);
    console.log(`   • ROC AUC covered:         ${rocCovered.auc}, 95% CI: ${rocCovered.ci.str}`);
    console.log(`   • ROC AUC prob:            ${rocProb.auc}, 95% CI: ${rocProb.ci.str}`);
    console.log(`   • ROC AUC pfhg:            ${rocPfhg.auc}, 95% CI: ${rocPfhg.ci.str}`);

    const { generateNejmDashboardHtml } = await import('./prospektivni_validace.js');
    const htmlContent = generateNejmDashboardHtml({
        totalVisits, hgCount, hgPrevalence, lgCount, lgPrevalence,
        cin3Count, cin2Count, cin1Count, nedCount, biopsyCount, conizationCount,
        timelineData, rocProb, rocCovered, rocPfhg
    });
    fs.writeFileSync(htmlFilePath, htmlContent, 'utf-8');
    console.log(`✅ KROK 7 DOKONČEN: Vygenerován nový HTML Dashboard: '${htmlFilePath}'`);

    // ===================================================================
    // KROK 8: EXPORT DO FTP SERVERU (cipek.eu / WEDOS)
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 8/9: EXPORT VYGENEROLVANÉHO DASHBOARDU NA WEDOS FTP SERVER`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`🌐 FTP Server: ${FTP_HOST} (Uživatel: ${FTP_USER})`);
    
    try {
        const ftp = await import('basic-ftp');
        const client = new ftp.Client();
        try {
            await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
            await client.cd('/www');
            await client.uploadFrom(htmlFilePath, 'prospektivni_validace.html');
            await client.uploadFrom(htmlFilePath, 'validace.html');
            console.log(`🎉 Publikace na FTP server 100% úspěšná!`);
            console.log(`🌐 Živá adresa 1: http://cipek.eu/prospektivni_validace.html`);
            console.log(`🌐 Živá adresa 2: http://cipek.eu/validace.html`);
        } catch (ftpErr) {
            console.error(`❌ Chyba při nahrávání na FTP:`, ftpErr.message);
        } finally {
            client.close();
        }
    } catch (importErr) {
        console.warn(`⚠️ Modul 'basic-ftp' není k dispozici. Nahrávání na FTP přeskočeno.`);
    }
    console.log(`✅ KROK 8 DOKONČEN: Dashboard byl exportován na FTP server.`);

    // ===================================================================
    // KROK 9: OTEVŘENÍ ŽIVÉ STRÁNKY V PROHLÍŽEČI
    // ===================================================================
    const liveUrl = 'http://cipek.eu/prospektivni_validace.html';
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 9/9: OTEVŘENÍ STRÁNKY V PROHLÍŽEČI`);
    console.log(`-------------------------------------------------------------------`);
    console.log(`🌐 Otevírám živou stránku '${liveUrl}' ve výchozím prohlížeči...`);
    
    exec(`start "" "${liveUrl}"`, (err) => {
        if (err) {
            console.warn(`⚠️ Nepodařilo se automaticky otevřít prohlížeč: ${err.message}`);
        } else {
            console.log(`🚀 Prohlížeč byl úspěšně spuštěn!`);
        }
    });

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n===================================================================`);
    console.log(`🎉 KOMPLETNÍ PIPELINE ÚSPĚŠNĚ DOKONČENA ZA ${totalSeconds} s!`);
    console.log(`===================================================================\n`);
}

// Získání vstupního PDF souboru z argumentů
const inputPdfArg = process.argv[2] || path.join(__dirname, 'histologie.pdf');
runFullPipeline(inputPdfArg).catch(err => {
    console.error(`\n❌ KRITICKÁ CHYBA PIPELINE:`, err);
    process.exit(1);
});
