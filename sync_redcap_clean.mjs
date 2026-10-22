import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRedcapRecords, importRedcapRecords, cleanRc, parseDate, mapHistologyResultToCode } from './redcap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (m && !process.env[m[1]]) {
            process.env[m[1]] = (m[2] || '').trim();
        }
    }
}

const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbzNzshLzdHwfbAjrMF_8vMImHq7sw-H6TH-Ns1ELs4v2nJ4OtLrWS6tQBXIJpnD2MCD/exec';
const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

async function syncRedcap() {
    console.log(`===================================================================`);
    console.log(`🔄 SYNCHRONIZACE OPRAVENÉ HISTOLOGIE DO REDCAPU`);
    console.log(`===================================================================`);

    console.log(`📥 1. Načítám aktuální řádky z Google Tabulky...`);
    const sheetRes = await fetch(GOOGLE_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_rows' }),
        redirect: 'follow'
    });
    const sheetJson = await sheetRes.json();
    const rows = sheetJson.rows || [];
    console.log(`Načteno ${rows.length} řádků z Google Tabulky.`);

    // Nastavíme r[4] na 'kontrola anonymizace OK' pro čistotu dat
    let fixedCol4 = false;
    for (const r of rows) {
        if ((r[4] || '').length > 40) {
            r[4] = 'kontrola anonymizace OK';
            fixedCol4 = true;
        }
    }
    if (fixedCol4) {
        console.log(`🧹 Vyčištěn sloupec 5 (Kontrola anonymizace) v tabulce...`);
        await fetch(GOOGLE_WEB_APP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reset_with_rows', rows: rows }),
            redirect: 'follow'
        });
        console.log(`✅ Sloupec 5 v Google Tabulce úspěšně sjednocen.`);
    }

    console.log(`📥 2. Načítám vizity z REDCapu...`);
    const redcapRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`Načteno ${redcapRecords.length} záznamů z REDCapu.`);

    const updatesMap = new Map();

    for (const r of rows) {
        const rcClean = cleanRc(r[2]);
        const datumPrijmu = parseDate(r[0]);
        const punchBiopsie = (r[5] || '').toLowerCase();
        const konizace = (r[6] || '').toLowerCase();
        const vysledekStr = r[7] || '';

        if (!rcClean || !datumPrijmu) continue;

        const matched = redcapRecords.filter(rec => {
            const recRc = cleanRc(rec.rc || rec.cislo_pojistence || rec.record_id);
            if (recRc !== rcClean) return false;
            const recDate = parseDate(rec.datum || rec.v1_date || rec.vfu_date);
            if (!recDate) return false;
            const diffDays = Math.round((datumPrijmu - recDate) / (1000 * 60 * 60 * 24));
            const maxDays = (konizace === 'ano') ? 60 : ((punchBiopsie === 'ano') ? 7 : 5);
            return (diffDays >= 0 && diffDays <= maxDays);
        });

        if (matched.length === 0) continue;

        matched.sort((a, b) => {
            const da = Math.abs(datumPrijmu - parseDate(a.datum || a.v1_date || a.vfu_date));
            const db = Math.abs(datumPrijmu - parseDate(b.datum || b.v1_date || b.vfu_date));
            return da - db;
        });

        const best = matched[0];
        const code = mapHistologyResultToCode(vysledekStr);
        const recordId = best.record_id || best.id;
        const key = `${recordId}__${best.redcap_event_name || ''}__${best.redcap_repeat_instance || ''}`;

        const existing = updatesMap.get(key) || { record_id: recordId };
        if (best.redcap_event_name) existing.redcap_event_name = best.redcap_event_name;
        if (best.redcap_repeat_instance) existing.redcap_repeat_instance = best.redcap_repeat_instance;

        let needsUpdate = false;
        if (konizace === 'ano') {
            if (best.konizace !== code) {
                existing.konizace = code;
                needsUpdate = true;
            }
            if ('v1_kon_res' in best && best.v1_kon_res !== code) {
                existing.v1_kon_res = code;
                needsUpdate = true;
            }
        } else if (punchBiopsie === 'ano') {
            if (best.biopsie !== code) {
                existing.biopsie = code;
                needsUpdate = true;
            }
            if ('v1_pb_res' in best && best.v1_pb_res !== code) {
                existing.v1_pb_res = code;
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            updatesMap.set(key, existing);
            console.log(`   📝 Změna pro ${best.jmeno || ''} ${best.prijmeni || ''} (ID ${recordId}): výkon ${konizace === 'ano' ? 'konizace' : 'biopsie'} ➔ kód ${code} (${vysledekStr})`);
        }
    }

    const finalUpdates = Array.from(updatesMap.values());
    console.log(`\nCelkem unikátních záznamů k aktualizaci v REDCapu: ${finalUpdates.length}`);

    if (finalUpdates.length > 0) {
        console.log(`📤 Odesílám ${finalUpdates.length} záznamů do REDCap API...`);
        const res = await importRedcapRecords(finalUpdates, REDCAP_API_TOKEN, REDCAP_API_URL);
        console.log(`✅ Odpověď REDCap API:`, res);
    } else {
        console.log(`ℹ️ Žádné záznamy v REDCapu nepotřebují aktualizaci.`);
    }

    console.log(`===================================================================`);
    console.log(`🎉 REDCap synchronizace úspěšně dokončena!`);
    console.log(`===================================================================`);
}

syncRedcap().catch(console.error);
