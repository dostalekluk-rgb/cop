import fs from 'fs';
import ExcelJS from 'exceljs';
import { fetchRedcapRecords, cleanRc, parseDate } from './redcap.js';

async function diagnose() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile('histologie.xlsx');
    const sheet = workbook.getWorksheet(1);

    const rows = [];
    sheet.eachRow((row, i) => {
        if (i === 1) return;
        rows.push({
            rowNum: i,
            datumStr: row.getCell(1).value || '',
            jmeno: row.getCell(2).value || '',
            rc: row.getCell(3).value || ''
        });
    });

    console.log('--- NALEZENÉ ŘÁDKY V EXCELU ---');
    console.log(rows);

    console.log('\n--- NAČÍTÁM REDCAP ZÁZNAMY ---');
    const redcapRecords = await fetchRedcapRecords('A0062F58293C7206CF3768BFE25F65AD', 'https://redcap.vfn.cz/api/');

    for (const r of rows) {
        const cleanRcExcel = cleanRc(r.rc);
        const dateExcel = parseDate(r.datumStr);

        const matchingRcRecords = redcapRecords.filter(rec => {
            const recRc = cleanRc(rec.rc || rec.cislo_pojistence || rec.record_id);
            return recRc === cleanRcExcel;
        });

        console.log(`\n==================================================`);
        console.log(`Řádek ${r.rowNum}: ${r.jmeno} | RC: ${r.rc} (vyčištěno: ${cleanRcExcel}) | Datum příjmu: ${r.datumStr}`);
        console.log(`--------------------------------------------------`);
        
        if (matchingRcRecords.length === 0) {
            console.log(`❌ V RedCapu neexistuje ŽÁDNÝ ZÁZNAM s tímto rodným číslem (${cleanRcExcel})!`);
        } else {
            console.log(`Nalezeno ${matchingRcRecords.length} záznamů v RedCapu pro toto RČ:`);
            for (const rec of matchingRcRecords) {
                const recDateStr = rec.datum || rec.v1_date || rec.vfu_date;
                const dateRedcap = parseDate(recDateStr);
                let diffDays = 'N/A';
                if (dateExcel && dateRedcap) {
                    diffDays = Math.round((dateExcel.getTime() - dateRedcap.getTime()) / (1000 * 60 * 60 * 24));
                }
                console.log(`   -> RedCap Record ID: "${rec.record_id || rec.id}" | Datum vizity v RedCapu: "${recDateStr}" | Rozdíl ve dnech: ${diffDays} dní`);
                if (diffDays >= 0 && diffDays <= 5) {
                    console.log(`      ✅ TATO VIZITA VYHOVUJE PRAVIDLU (0 až 5 dní)!`);
                } else if (typeof diffDays === 'number') {
                    if (diffDays < 0) {
                        console.log(`      ❌ Datum příjmu je O ${Math.abs(diffDays)} DNÍ PŘED vizitou v RedCapu (vzorek nemůže přijít před vizitou).`);
                    } else {
                        console.log(`      ❌ Datum příjmu je O ${diffDays} DNÍ PO vizitou v RedCapu (povoleno je max +5 dní).`);
                    }
                }
            }
        }
    }
}

diagnose();
