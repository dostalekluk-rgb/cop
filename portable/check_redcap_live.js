import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { verifyAndSyncRedcap } from './redcap.js';
import { sendRowsToGoogleSheets } from './convert.js';

/**
 * SAMOSTATNÝ SKRIPT PRO SPUŠTĚNÍ INTERAKCE A SYNCHRONIZACE S REDCAPEM
 * 
 * Použití:
 *   node check_redcap_live.js <REDCAP_API_URL> [cesta_k_excelu_nebo_txt]
 * 
 * Příklad:
 *   node check_redcap_live.js "https://redcap.link/api/" histologie.xlsx
 */

const apiUrl = process.argv[2] || process.env.REDCAP_API_URL;
const inputFilePath = process.argv[3] || 'histologie.xlsx';
const webAppUrl = process.argv[4] || process.env.GOOGLE_WEB_APP_URL;
const apiToken = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

if (!apiUrl) {
    console.error(`
===================================================================
❌ CHYBA: Chybí URL adresa RedCap API!
===================================================================

Použití:
  node check_redcap_live.js "https://vaše-redcap-instance.cz/api/" [histologie.xlsx] [GOOGLE_WEB_APP_URL]

Nebo nastavte proměnnou prostředí REDCAP_API_URL:
  set REDCAP_API_URL=https://vaše-redcap-instance.cz/api/
  node check_redcap_live.js
===================================================================
`);
    process.exit(1);
}

async function loadRowsFromExcel(excelPath) {
    if (!fs.existsSync(excelPath)) {
        throw new Error(`Soubor Excel '${excelPath}' neexistuje! Spusťte nejprve 'node convert.js'`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelPath);
    const worksheet = workbook.getWorksheet(1);

    const rows = [];
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // přeskočit hlavičku
        const rowVals = [
            row.getCell(1).value || '',  // Datum příjmu
            row.getCell(2).value || '',  // Jméno pacientky
            row.getCell(3).value || '',  // Číslo pojištěnce
            row.getCell(4).value || '',  // Text nálezu
            row.getCell(5).value || '',  // Kontrola anonymizace
            row.getCell(6).value || '',  // Punch biopsie z hrdla?
            row.getCell(7).value || '',  // Konizace?
            row.getCell(8).value || '',  // Výsledek
            row.getCell(9).value || '',  // Okraj konizace
            row.getCell(10).value || '', // Výsledek kyretáže
            row.getCell(11).value || '', // Zbylý histologický nález
            row.getCell(12).value || ''  // ID RedCap (Sloupec L)
        ];
        rows.push(rowVals);
    });

    return { workbook, worksheet, rows };
}

async function runLiveSync() {
    console.log(`\n==================================================`);
    console.log(`🚀 SPUŠTĚNÍ INTERAKCE A SYNCHRONIZACE S REDCAPEM A GOOGLE TABULKOU`);
    console.log(`==================================================`);
    console.log(`🌐 REDCap API URL: ${apiUrl}`);
    console.log(`🔑 REDCap Token:   ${apiToken.substring(0, 6)}...${apiToken.substring(apiToken.length - 4)}`);
    if (webAppUrl) console.log(`🌐 Google Web App: ${webAppUrl}`);
    console.log(`--------------------------------------------------\n`);

    try {
        let rows = [];
        let workbook = null;
        let worksheet = null;

        if (webAppUrl) {
            try {
                console.log(`📥 Pokus o načtení živých řádků přímo z Google Tabulky...`);
                const res = await fetch(webAppUrl, { method: 'GET', redirect: 'follow' });
                const json = await res.json();
                if (json.rows && json.rows.length > 0) {
                    rows = json.rows;
                    console.log(`✅ Načteno ${rows.length} řádků přímo z vaší Google Tabulky!`);
                }
            } catch (err) {
                console.warn(`⚠️ Nelze načíst řádky z Google Tabulky cez GET (${err.message}), použiji soubor Excel.`);
            }
        }

        if (rows.length === 0 && fs.existsSync(inputFilePath)) {
            const loaded = await loadRowsFromExcel(inputFilePath);
            workbook = loaded.workbook;
            worksheet = loaded.worksheet;
            rows = loaded.rows;
            console.log(`Načteno ${rows.length} řádků z Excel souboru '${inputFilePath}'.`);
        }

        if (rows.length === 0) {
            console.warn(`⚠️ Žádné řádky k ověření.`);
            return;
        }

        const stats = await verifyAndSyncRedcap(rows, apiToken, apiUrl);

        if (stats && stats.matched > 0) {
            if (worksheet) {
                console.log(`📝 Aktualizuji RedCap ID ve sloupcích Excel souboru '${inputFilePath}'...`);
                rows.forEach((r, idx) => {
                    const cellL = worksheet.getRow(idx + 2).getCell(12);
                    cellL.value = r[11] || '';
                });
                await workbook.xlsx.writeFile(inputFilePath);
                console.log(`✅ Excel soubor s novými RedCap ID uložen!`);
            }

            if (webAppUrl) {
                console.log(`🌐 Odesílám aktualizované řádky (včetně Sloupce L ID RedCap) do Google Tabulek...`);
                await sendRowsToGoogleSheets(rows, webAppUrl);
            }
        }


        console.log(`\n🎉 PROCES KONTROLY A INTERAKCE S REDCAPEM DOKONČEN!`);
        console.log(`==================================================\n`);
    } catch (err) {
        console.error(`\n❌ CHYBA PŘI INTERAKCI S REDCAPEM:`, err.message);
        process.exit(1);
    }
}

runLiveSync();
