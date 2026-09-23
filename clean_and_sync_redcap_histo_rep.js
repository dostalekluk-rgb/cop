import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { fetchRedcapRecords, importRedcapRecords, cleanRc, parseDate, mapHistologyResultToCode } from './redcap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

async function runCleanAndSyncHistoRep() {
    console.log(`===================================================================`);
    console.log(`🚀 VYČIŠTĚNÍ A OBNOVENÍ HISTOLOGIE V REDCAPU ZE SOUBORU histo_rep.xlsx`);
    console.log(`===================================================================`);
    console.log(`🌐 REDCap API Endpoint: ${REDCAP_API_URL}\n`);

    // ===================================================================
    // KROK 1: Načtení všech záznamů z REDCapu a MAZÁNÍ proměnných biopsie a konizace
    // ===================================================================
    console.log(`-------------------------------------------------------------------`);
    console.log(`KROK 1/3: NAČTENÍ VŠECH ZÁZNAMŮ Z REDCAPU A MAZÁNÍ BIOPSIE A KONIZACE`);
    console.log(`-------------------------------------------------------------------`);
    
    const redcapRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`📥 Načteno ${redcapRecords.length} záznamů/vizit z REDCapu.`);

    const clearPayloads = [];
    redcapRecords.forEach(rec => {
        const payload = {
            record_id: rec.record_id || rec.id,
            biopsie: "",
            konizace: ""
        };
        if (rec.redcap_event_name) payload.redcap_event_name = rec.redcap_event_name;
        if (rec.redcap_repeat_instance) payload.redcap_repeat_instance = rec.redcap_repeat_instance;
        clearPayloads.push(payload);
    });

    console.log(`🧹 Mazání proměnných biopsie a konizace u ${clearPayloads.length} záznamů v REDCapu...`);
    const clearRes = await importRedcapRecords(clearPayloads, REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`✅ Vyčištění dokončeno:`, clearRes);

    // ===================================================================
    // KROK 2: Načtení tabulky histo_rep.xlsx a filtrace platných histologií
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 2/3: NAČÍTÁNÍ TABULKY histo_rep.xlsx`);
    console.log(`-------------------------------------------------------------------`);

    const excelFilePath = path.join(__dirname, 'histo_rep.xlsx');
    if (!fs.existsSync(excelFilePath)) {
        throw new Error(`Soubor '${excelFilePath}' neexistuje!`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelFilePath);
    const sheet = workbook.getWorksheet(1);

    const validExcelEntries = [];
    let skippedEmptyHistolCount = 0;

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Hlavička

        const rawRc = row.getCell(1).value;
        const rawDate = row.getCell(2).value;
        const rawKon = row.getCell(3).value;
        const rawHistol = row.getCell(4).value;

        // Pokud není histol vyplněno, záznam přeskočíme
        if (rawHistol === null || rawHistol === undefined || String(rawHistol).trim() === '') {
            skippedEmptyHistolCount++;
            return;
        }

        const rc = cleanRc(rawRc);
        const parsedD = parseDate(rawDate);

        if (!rc || !parsedD) {
            return;
        }

        const year = parsedD.getUTCFullYear();
        const month = String(parsedD.getUTCMonth() + 1).padStart(2, '0');
        const day = String(parsedD.getUTCDate()).padStart(2, '0');
        const formattedDateYmd = `${year}-${month}-${day}`;

        const isKonizace = rawKon !== null && rawKon !== undefined && String(rawKon).trim().toLowerCase() === 'ano';
        const histolText = String(rawHistol).trim();
        const code = mapHistologyResultToCode(histolText);

        validExcelEntries.push({
            rowNumber,
            rc,
            dateYmd: formattedDateYmd,
            parsedD,
            isKonizace,
            histolText,
            code
        });
    });

    console.log(`📊 Zpracováno ${sheet.rowCount - 1} řádků z histo_rep.xlsx:`);
    console.log(`   • Přeskočeno (nevyplněná histologie): ${skippedEmptyHistolCount}`);
    console.log(`   • Platných záznamů k párování:       ${validExcelEntries.length}`);

    // ===================================================================
    // KROK 3: Přesné párování (RČ + Datum) a odeslání do REDCapu
    // ===================================================================
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`KROK 3/3: PŘESNÉ PÁROVÁNÍ (RČ + DATUM) A ZÁPIS DO REDCAPU`);
    console.log(`-------------------------------------------------------------------`);

    const updateMap = new Map(); // record_id -> payload
    let matchedCount = 0;
    let unmatchedCount = 0;

    for (let i = 0; i < validExcelEntries.length; i++) {
        const entry = validExcelEntries[i];

        // Hledání přesné shody v REDCapu (RČ a přesné datum YYYY-MM-DD)
        const matchedRec = redcapRecords.find(rec => {
            const recRc = cleanRc(rec.rc || rec.cislo_pojistence || rec.record_id);
            if (recRc !== entry.rc) return false;

            const recDateStr = rec.datum || rec.v1_date || rec.vfu_date;
            const recDate = parseDate(recDateStr);
            if (!recDate) return false;

            const recYear = recDate.getUTCFullYear();
            const recMonth = String(recDate.getUTCMonth() + 1).padStart(2, '0');
            const recDay = String(recDate.getUTCDate()).padStart(2, '0');
            const recYmd = `${recYear}-${recMonth}-${recDay}`;

            return recYmd === entry.dateYmd;
        });

        if (matchedRec) {
            matchedCount++;
            const recId = matchedRec.record_id || matchedRec.id || entry.rc;
            const payload = updateMap.get(recId) || { record_id: recId };

            if (matchedRec.redcap_event_name) payload.redcap_event_name = matchedRec.redcap_event_name;
            if (matchedRec.redcap_repeat_instance) payload.redcap_repeat_instance = matchedRec.redcap_repeat_instance;

            if (entry.isKonizace) {
                payload.konizace = entry.code || entry.histolText;
                console.log(`🎯 [Shoda ${matchedCount}] RČ: ${entry.rc} | Datum: ${entry.dateYmd} ➔ Konizace = ${entry.code} (${entry.histolText})`);
            } else {
                payload.biopsie = entry.code || entry.histolText;
                console.log(`🎯 [Shoda ${matchedCount}] RČ: ${entry.rc} | Datum: ${entry.dateYmd} ➔ Biopsie = ${entry.code} (${entry.histolText})`);
            }

            updateMap.set(recId, payload);
        } else {
            unmatchedCount++;
        }
    }

    console.log(`--------------------------------------------------`);
    console.log(`📊 Výsledky párování:`);
    console.log(`   • Přesně spárováno:                ${matchedCount}`);
    console.log(`   • Nespárováno (mimo REDCap vizity): ${unmatchedCount}`);
    console.log(`   • Připraveno záznamů k aktualizaci: ${updateMap.size}`);

    const finalPayloads = Array.from(updateMap.values());
    if (finalPayloads.length > 0) {
        console.log(`\n📤 Zapisuji ${finalPayloads.length} aktualizovaných histologických nálezů do REDCapu...`);
        const updateRes = await importRedcapRecords(finalPayloads, REDCAP_API_TOKEN, REDCAP_API_URL);
        console.log(`🎉 REDCap aktualizace dokončena:`, updateRes);
    } else {
        console.log(`ℹ️ Žádné záznamy k aktualizaci.`);
    }

    console.log(`\n===================================================================`);
    console.log(`🎉 VYČIŠTĚNÍ A OBNOVENÍ REDCAPU USPEŠNĚ DOKONČENO!`);
    console.log(`===================================================================\n`);
}

runCleanAndSyncHistoRep().catch(err => {
    console.error(`❌ CHYBA PŘI PROVÁDĚNÍ:`, err);
    process.exit(1);
});
