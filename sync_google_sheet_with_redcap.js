import fs from 'fs';
import ExcelJS from 'exceljs';
import { fetchRedcapRecords, importRedcapRecords, cleanRc, parseDate, mapHistologyResultToCode } from './redcap.js';

async function loadAllLocalExcelRows() {
    const files = ['histologie.xlsx', 'h2.xlsx', 'h3.xlsx'];
    const allRows = [];
    const seen = new Set();

    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(file);
        const sheet = workbook.getWorksheet(1);

        sheet.eachRow((r, rowNumber) => {
            if (rowNumber === 1) return;
            const rc = cleanRc(r.getCell(3).value || '');
            const date = (r.getCell(1).value || '').toString().trim();
            const key = `${rc}_${date}`;
            if (seen.has(key)) return;
            seen.add(key);

            const row = [
                r.getCell(1).value || '',
                r.getCell(2).value || '',
                r.getCell(3).value || '',
                r.getCell(4).value || '',
                r.getCell(5).value || '',
                r.getCell(6).value || '',
                r.getCell(7).value || '',
                r.getCell(8).value || '',
                r.getCell(9).value || '',
                r.getCell(10).value || '',
                r.getCell(11).value || '',
                r.getCell(12).value || ''
            ];
            allRows.push(row);
        });
    }
    return allRows;
}


/**
 * SKRIPT PRO KONTROLU A SYNCHRONIZACI VŠECH ZÁZNAMŮ Z GOOGLE TABULKY PROTI REDCAPU
 * 
 * Tento skript:
 * 1. Načte všechny existující řádky přímo z Google Tabulky (pomocí Web App URL).
 * 2. Stáhne všechny vizity z RedCap API.
 * 3. Pro každý řádek v Google Tabulce ověří shodu rodného čísla (rc) a datum v rozmezí 0 až 5 dní.
 * 4. Pokud je shoda vizity nalezena:
 *    - Zapíše výsledek histologie do RedCapu (proměnná konizace nebo biopsie).
 *    - Doplní zjištěné RedCap ID do Sloupce L (12. sloupec) v Google Tabulce.
 * 5. Odešle aktualizované řádky zpět do Google Tabulky.
 */

const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';
const GOOGLE_WEB_APP_URL = process.argv[2] || process.env.GOOGLE_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbzNzshLzdHwfbAjrMF_8vMImHq7sw-H6TH-Ns1ELs4v2nJ4OtLrWS6tQBXIJpnD2MCD/exec';

async function fetchGoogleSheetRows(webAppUrl) {
    console.log(`📥 Načítám řádky přímo z Google Tabulky...`);
    
    // Zkusíme POST { action: 'get_rows' }
    let res = await fetch(webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_rows' }),
        redirect: 'follow'
    });
    
    let text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
        if (json.rows && Array.isArray(json.rows) && json.rows.length > 0) {
            return json.rows;
        }
    } catch (e) {
        // nepodařilo se rozparsovat JSON z POST
    }

    // Zkusíme GET
    res = await fetch(webAppUrl, { method: 'GET', redirect: 'follow' });
    text = await res.text();
    try {
        json = JSON.parse(text);
        if (json.rows && Array.isArray(json.rows) && json.rows.length > 0) {
            return json.rows;
        }
    } catch (e) {}

    return [];
}

async function sendUpdatedRowsToGoogleSheet(webAppUrl, rows) {
    console.log(`📤 Odesílám ${rows.length} aktualizovaných řádků (včetně Sloupce L ID RedCap) do Google Tabulky...`);
    const res = await fetch(webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rows }),
        redirect: 'follow'
    });

    const rawText = await res.text();
    let jsonRes;
    try {
        jsonRes = JSON.parse(rawText);
    } catch {
        jsonRes = { raw: rawText };
    }
    return jsonRes;
}

async function runSyncAllGoogleSheetRows() {
    console.log(`==================================================`);
    console.log(`🚀 KONTROLA A SYNCHRONIZACE ZÁZNAMŮ Z GOOGLE TABULKY PROTI REDCAPU`);
    console.log(`==================================================`);
    console.log(`🌐 REDCap API URL: ${REDCAP_API_URL}`);
    console.log(`🌐 Google Web App: ${GOOGLE_WEB_APP_URL}`);
    console.log(`--------------------------------------------------\n`);

    try {
        // 1. Načtení řádků z Google Tabulky
        let googleRows = await fetchGoogleSheetRows(GOOGLE_WEB_APP_URL);
        
        if (!googleRows || googleRows.length === 0) {
            console.log(`ℹ️ [Fallback] Načítám řádky z existujících Excel souborů (histologie.xlsx, h2.xlsx, h3.xlsx)...`);
            googleRows = await loadAllLocalExcelRows();
        }

        if (!googleRows || googleRows.length === 0) {
            console.warn(`⚠️ Nebyly nalezeny žádné řádky k ověření.`);
            return;
        }

        console.log(`✅ Připraveno celkem ${googleRows.length} řádků k ověření proti RedCapu.`);


        // 2. Načtení vizit z RedCapu
        console.log(`📥 Načítám existující vizity z RedCapu...`);
        const redcapRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
        console.log(`Načteno ${redcapRecords.length} záznamů/vizit z RedCapu.\n`);

        // 3. Párovací logika a příprava aktualizací
        const updatesMap = new Map();
        let matchedCount = 0;
        let unmatchedCount = 0;

        for (let i = 0; i < googleRows.length; i++) {
            const row = googleRows[i];
            
            // Sloupce:
            // 0: Datum příjmu, 2: Číslo pojištěnce, 5: Punch biopsie, 6: Konizace, 7: Výsledek
            const datumPrijmuStr = row[0] || '';
            const cisloPoj = row[2] || '';
            const punchBiopsie = (row[5] || '').toString().trim().toLowerCase();
            const konizace = (row[6] || '').toString().trim().toLowerCase();
            const vysledekStr = row[7] || '';

            const cleanRcGoogle = cleanRc(cisloPoj);
            const dateGoogle = parseDate(datumPrijmuStr);

            if (!cleanRcGoogle || !dateGoogle) {
                console.warn(`⚠️ Řádek ${i + 1}: Neplatné RC ("${cisloPoj}") nebo Datum příjmu ("${datumPrijmuStr}").`);
                row[11] = '';
                unmatchedCount++;
                continue;
            }

            let candidateVisits = [];

            for (const rcRec of redcapRecords) {
                const recRc = cleanRc(rcRec.rc || rcRec.cislo_pojistence || rcRec.record_id);
                if (recRc !== cleanRcGoogle) continue;

                const recDateStr = rcRec.datum || rcRec.v1_date || rcRec.vfu_date;
                const dateRedcap = parseDate(recDateStr);
                if (!dateRedcap) continue;

                const diffTimeMs = dateGoogle.getTime() - dateRedcap.getTime();
                const diffDays = Math.round(diffTimeMs / (1000 * 60 * 60 * 24));

                let maxAllowedDays = 5;
                if (konizace === 'ano') {
                    maxAllowedDays = 60;
                } else if (punchBiopsie === 'ano') {
                    maxAllowedDays = 7;
                }

                if (diffDays >= 0 && diffDays <= maxAllowedDays) {
                    candidateVisits.push({
                        record: rcRec,
                        diffDays: diffDays
                    });
                }
            }

            if (candidateVisits.length === 0) {
                console.warn(`⚠️ Řádek ${i + 1} (${row[1] || cisloPoj}): Nenašena vizita v RedCapu (RC "${cisloPoj}", Datum "${datumPrijmuStr}").`);
                row[11] = '';
                unmatchedCount++;
                continue;
            }

            // Vybere se vizita s nejmenším rozdílem dnů
            candidateVisits.sort((a, b) => a.diffDays - b.diffDays);
            const bestMatch = candidateVisits[0].record;

            matchedCount++;
            const mappedCode = mapHistologyResultToCode(vysledekStr);

            // Získání RedCap ID
            const redcapId = bestMatch.id || bestMatch.record_id || bestMatch.v1_id || bestMatch.scr_id || '';
            row[11] = redcapId; // Doplnění do Sloupce L v řádku

            const recordId = bestMatch.record_id || bestMatch.rc || redcapId;
            const updateObj = updatesMap.get(recordId) || { record_id: recordId };

            if (bestMatch.redcap_event_name) updateObj.redcap_event_name = bestMatch.redcap_event_name;
            if (bestMatch.redcap_repeat_instance) updateObj.redcap_repeat_instance = bestMatch.redcap_repeat_instance;

            let targetLog = '';
            if (konizace === 'ano') {
                updateObj.konizace = mappedCode || vysledekStr;
                if ('v1_kon_res' in bestMatch) updateObj.v1_kon_res = mappedCode || vysledekStr;
                if ('v1_kon' in bestMatch) updateObj.v1_kon = '1';
                targetLog = `konizace = ${mappedCode || vysledekStr}`;
            } else if (punchBiopsie === 'ano') {
                updateObj.biopsie = mappedCode || vysledekStr;
                if ('v1_pb_res' in bestMatch) updateObj.v1_pb_res = mappedCode || vysledekStr;
                if ('v1_pb' in bestMatch) updateObj.v1_pb = '1';
                targetLog = `biopsie = ${mappedCode || vysledekStr}`;
            }

            updatesMap.set(recordId, updateObj);
            console.log(`✅ [Spárováno] Řádek ${i + 1} (${row[1]} | RC ${cisloPoj}) ➔ RedCap ID: "${redcapId}" (Datum vizity: ${bestMatch.datum || bestMatch.v1_date}, Rozdíl ${candidateVisits[0].diffDays} dnů) | Cíl: ${targetLog}`);
        }

        console.log(`--------------------------------------------------`);
        console.log(`📊 Výsledky párování: Spárováno: ${matchedCount}/${googleRows.length} | Nespárováno: ${unmatchedCount} | Připraveno pro RedCap API: ${updatesMap.size}`);

        // 4. Odeslání aktualizací do RedCapu
        const recordsToUpdate = Array.from(updatesMap.values());
        if (recordsToUpdate.length > 0) {
            console.log(`📤 Odesílám aktualizované výsledky histologie do RedCapu...`);
            const importRes = await importRedcapRecords(recordsToUpdate, REDCAP_API_TOKEN, REDCAP_API_URL);
            console.log(`✅ [RedCap API Odpověď]:`, importRes);
        }

        // 5. Odeslání řádků (včetně Sloupce L ID RedCap) zpět do Google Tabulky
        const sheetRes = await sendUpdatedRowsToGoogleSheet(GOOGLE_WEB_APP_URL, googleRows);
        console.log(`✅ [Google Tabulka Odpověď]:`, sheetRes);

        console.log(`\n🎉 PROCES KONTROLY A SYNCHRONIZACE S GOOGLE TABULKOU DOKONČEN!`);
        console.log(`==================================================\n`);
    } catch (err) {
        console.error(`\n❌ CHYBA PŘI SYNCHRONIZACI:`, err.message);
        console.error(err);
        process.exit(1);
    }
}

runSyncAllGoogleSheetRows();
