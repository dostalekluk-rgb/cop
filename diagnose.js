import fs from 'fs';
import ExcelJS from 'exceljs';
import { fetchRedcapRecords, cleanRc, parseDate } from './redcap.js';

async function diagnose() {
    console.log('Načítám REDCap záznamy...');
    const redcapRecords = await fetchRedcapRecords('A0062F58293C7206CF3768BFE25F65AD', 'https://redcap.vfn.cz/api/');
    console.log('Celkem záznamů v REDCapu:', redcapRecords.length);

    // 1. Analýza prospektivních vizit po 1.3.2026
    const cutoff = new Date(Date.UTC(2026, 2, 1));
    let postCutoffAll = 0;
    let postCutoffWithHisto = 0;
    let postCutoffWithHistoAndModel = 0;
    const histoWithoutModel = [];

    for (const r of redcapRecords) {
        const dStr = r.datum || r.v1_date || r.vfu_date;
        const d = parseDate(dStr);
        if (!d || d <= cutoff) continue;
        postCutoffAll++;

        const hasKon = r.konizace || r.v1_kon_res;
        const hasPb = r.biopsie || r.v1_pb_res;
        if (!hasKon && !hasPb) continue;
        postCutoffWithHisto++;

        const probVal = (r.prob !== undefined && r.prob !== '') ? r.prob : r.hg_probability;
        if (probVal !== undefined && probVal !== '' && probVal !== null && !isNaN(parseFloat(probVal))) {
            postCutoffWithHistoAndModel++;
        } else {
            histoWithoutModel.push({
                record_id: r.record_id || r.id,
                rc: r.rc,
                jmeno: `${r.jmeno || ''} ${r.prijmeni || ''}`.trim(),
                datum: dStr,
                konizace: hasKon,
                biopsie: hasPb,
                prob: probVal
            });
        }
    }

    console.log('\n==================================================');
    console.log('REDCAP STAV PO 1. 3. 2026:');
    console.log('Celkem vizit po 1. 3. 2026:                     ', postCutoffAll);
    console.log('Z toho s histologií (konizace nebo biopsie):     ', postCutoffWithHisto);
    console.log('Z toho s histologií A predikcí modelu (validace):', postCutoffWithHistoAndModel);
    console.log('S histologií, ale CHYBÍ predikce modelu:        ', histoWithoutModel.length);
    console.log('==================================================');

    if (histoWithoutModel.length > 0) {
        console.log('\nVizity s histologií, ale bez modelu (prvních 10):');
        console.table(histoWithoutModel.slice(0, 10));
    }

    // 2. Analýza souborů h15.xlsx a h16.xlsx
    for (const fileName of ['h15.xlsx', 'h16.xlsx']) {
        if (!fs.existsSync(fileName)) {
            console.log(`Soubor ${fileName} neexistuje!`);
            continue;
        }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(fileName);
        const ws = wb.getWorksheet(1);

        console.log(`\n==================================================`);
        console.log(`DETAILNÍ ANALÝZA SOUBORU: ${fileName} (${ws.rowCount - 1} záznamů)`);
        console.log(`==================================================`);

        ws.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const dateStr = (row.getCell(1).value || '').toString().trim();
            const jmeno = (row.getCell(2).value || '').toString().trim();
            const rcRaw = (row.getCell(3).value || '').toString().trim();
            const rc = cleanRc(rcRaw);
            const pb = (row.getCell(6).value || '').toString().trim().toLowerCase();
            const kon = (row.getCell(7).value || '').toString().trim().toLowerCase();
            const vysledek = (row.getCell(8).value || '').toString().trim();
            const redcapId = (row.getCell(12).value || '').toString().trim();

            const histDate = parseDate(dateStr);
            let maxAllowedDays = kon === 'ano' ? 60 : 7;

            // Najít všechny záznamy v REDCapu pro dané RČ
            const matchingRc = redcapRecords.filter(rec => {
                const rRc = cleanRc(rec.rc || rec.cislo_pojistence || rec.record_id);
                return rRc === rc;
            });

            console.log(`\n[${fileName} R${rowNumber}] ${jmeno} | RČ: ${rc} | Datum příjmu: ${dateStr} | Typ: PB=${pb}, Kon=${kon} (${vysledek}) | ID v Excelu: "${redcapId}"`);

            if (matchingRc.length === 0) {
                console.log(`   ❌ RČ "${rc}" VŮBEC NEEXISTUJE v REDCapu (mezi ${redcapRecords.length} záznamy)!`);
            } else {
                console.log(`   Nalezeno ${matchingRc.length} vizit v REDCapu pro toto RČ:`);
                for (const rec of matchingRc) {
                    const recDateStr = rec.datum || rec.v1_date || rec.vfu_date;
                    const recDate = parseDate(recDateStr);
                    let diff = null;
                    if (histDate && recDate) {
                        diff = Math.round((histDate.getTime() - recDate.getTime()) / (1000 * 3600 * 24));
                    }
                    const hasModel = rec.prob !== undefined && rec.prob !== '' && rec.prob !== null;
                    console.log(`      • Record ID: ${rec.record_id || rec.id} | Datum vizity: ${recDateStr} | Rozdíl: ${diff} dní (limit: ${maxAllowedDays}) | Model prob: ${rec.prob || rec.hg_probability || 'CHYBÍ'} | Kon: ${rec.konizace || rec.v1_kon_res || '-'} | PB: ${rec.biopsie || rec.v1_pb_res || '-'}`);
                }
            }
        });
    }
}

diagnose().catch(console.error);
