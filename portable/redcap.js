import fs from 'fs';

/**
 * MODUL PRO KONTROLU A SYNCHRONIZACI HISTOLOGICKÝCH VÝSLEDKŮ S REDCAP API (PORTABLE VERSION)
 */

const DEFAULT_TOKEN = 'A0062F58293C7206CF3768BFE25F65AD';

export function cleanRc(rcStr) {
    if (!rcStr) return '';
    return rcStr.toString().replace(/\D/g, '').trim();
}

export function parseDate(dateStr) {
    if (!dateStr) return null;
    const s = dateStr.toString().trim();

    const dmyMatch = s.match(/^(\d{1,2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{4})/);
    if (dmyMatch) {
        const day = parseInt(dmyMatch[1], 10);
        const month = parseInt(dmyMatch[2], 10) - 1;
        const year = parseInt(dmyMatch[3], 10);
        const date = new Date(Date.UTC(year, month, day));
        return isNaN(date.getTime()) ? null : date;
    }

    const ymdMatch = s.match(/^(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
    if (ymdMatch) {
        const year = parseInt(ymdMatch[1], 10);
        const month = parseInt(ymdMatch[2], 10) - 1;
        const day = parseInt(ymdMatch[3], 10);
        const date = new Date(Date.UTC(year, month, day));
        return isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
        return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }

    return null;
}

export function mapHistologyResultToCode(vysledekText) {
    if (!vysledekText) return null;
    const v = vysledekText.toString().trim().toLowerCase();
    if (v.includes('bez dysplázi') || v.includes('ned') || v === '1') return '1';
    if (v.includes('cin1') || v.includes('cin 1') || v === '2') return '2';
    if (v.includes('cin2') || v.includes('cin 2') || v === '3') return '3';
    if (v.includes('cin3') || v.includes('cin 3') || v === '4') return '4';
    if (v.includes('ais') || v === '5') return '5';
    if (v.includes('karcinom') || v.includes('ca') || v === '6') return '6';
    return null;
}

export async function fetchRedcapRecords(apiToken = process.env.REDCAP_API_TOKEN || DEFAULT_TOKEN, apiUrl = process.env.REDCAP_API_URL) {
    if (!apiUrl) {
        throw new Error('Chybí URL adresa RedCap API (GOOGLE_WEB_APP_URL / REDCAP_API_URL)!');
    }

    const params = new URLSearchParams();
    params.append('token', apiToken);
    params.append('content', 'record');
    params.append('format', 'json');
    params.append('type', 'flat');
    params.append('returnFormat', 'json');

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`RedCap API chyba HTTP ${response.status}: ${errText}`);
    }

    return await response.json();
}

export async function importRedcapRecords(recordsToUpdate, apiToken = process.env.REDCAP_API_TOKEN || DEFAULT_TOKEN, apiUrl = process.env.REDCAP_API_URL) {
    if (!apiUrl) {
        throw new Error('Chybí URL adresa RedCap API!');
    }
    if (!recordsToUpdate || recordsToUpdate.length === 0) {
        return { count: 0 };
    }

    const params = new URLSearchParams();
    params.append('token', apiToken);
    params.append('content', 'record');
    params.append('format', 'json');
    params.append('type', 'flat');
    params.append('overwriteBehavior', 'normal');
    params.append('data', JSON.stringify(recordsToUpdate));
    params.append('returnContent', 'count');

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`RedCap API Import chyba HTTP ${response.status}: ${errText}`);
    }

    const textRes = await response.text();
    let jsonRes;
    try {
        jsonRes = JSON.parse(textRes);
    } catch {
        jsonRes = { count: textRes };
    }
    return jsonRes;
}

export function matchAndPrepareRedcapUpdates(googleRows, redcapRecords) {
    const matchedStats = {
        totalRows: googleRows.length,
        matched: 0,
        unmatched: 0,
        alreadyUpToDate: 0,
        updatedRecords: []
    };

    const updatesMap = new Map();

    for (let i = 0; i < googleRows.length; i++) {
        const row = googleRows[i];
        
        const datumPrijmuStr = row[0] || '';
        const cisloPoj = row[2] || '';
        const punchBiopsie = (row[5] || '').toString().trim().toLowerCase();
        const konizace = (row[6] || '').toString().trim().toLowerCase();
        const vysledekStr = row[7] || '';

        const cleanRcGoogle = cleanRc(cisloPoj);
        const dateGoogle = parseDate(datumPrijmuStr);

        if (!cleanRcGoogle || !dateGoogle) {
            console.warn(`⚠️ [RedCap Kontrola] Řádek ${i + 1} obsahuje neplatné RC ("${cisloPoj}") nebo Datum příjmu ("${datumPrijmuStr}").`);
            row[11] = '';
            matchedStats.unmatched++;
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

            if (diffDays >= 0 && diffDays <= 5) {
                candidateVisits.push({
                    record: rcRec,
                    diffDays: diffDays
                });
            }
        }

        if (candidateVisits.length === 0) {
            console.warn(`⚠️ [RedCap Kontrola] Nenašena adekvátní vizita v RedCapu pro RC "${cisloPoj}" s datem příjmu "${datumPrijmuStr}".`);
            row[11] = '';
            matchedStats.unmatched++;
            continue;
        }

        candidateVisits.sort((a, b) => a.diffDays - b.diffDays);
        const bestMatch = candidateVisits[0].record;

        matchedStats.matched++;
        const mappedCode = mapHistologyResultToCode(vysledekStr);

        const redcapId = bestMatch.id || bestMatch.record_id || bestMatch.v1_id || bestMatch.scr_id || '';
        row[11] = redcapId;

        const recordId = bestMatch.record_id || bestMatch.rc || redcapId;
        const updateObj = updatesMap.get(recordId) || { record_id: recordId };
        
        if (bestMatch.redcap_event_name) updateObj.redcap_event_name = bestMatch.redcap_event_name;
        if (bestMatch.redcap_repeat_instance) updateObj.redcap_repeat_instance = bestMatch.redcap_repeat_instance;

        let targetFieldLog = '';

        if (konizace === 'ano') {
            updateObj.konizace = mappedCode || vysledekStr;
            if ('v1_kon_res' in bestMatch) updateObj.v1_kon_res = mappedCode || vysledekStr;
            if ('v1_kon' in bestMatch) updateObj.v1_kon = '1';
            targetFieldLog = `konizace = ${mappedCode || vysledekStr}`;
        } else if (punchBiopsie === 'ano') {
            updateObj.biopsie = mappedCode || vysledekStr;
            if ('v1_pb_res' in bestMatch) updateObj.v1_pb_res = mappedCode || vysledekStr;
            if ('v1_pb' in bestMatch) updateObj.v1_pb = '1';
            targetFieldLog = `biopsie = ${mappedCode || vysledekStr}`;
        } else {
            console.log(`ℹ️ [RedCap Kontrola] U vizity pro RC "${cisloPoj}" není konizace ani punch biopsie označena jako ano.`);
            continue;
        }

        updatesMap.set(recordId, updateObj);
        console.log(`✅ [RedCap Spárováno] RC ${cisloPoj} | Datum příjmu: ${datumPrijmuStr} ➔ Vizita z: ${bestMatch.datum || bestMatch.v1_date} (Rozdíl ${candidateVisits[0].diffDays} dnů) | RedCap ID: "${redcapId}" | Cíl: ${targetFieldLog}`);
    }

    matchedStats.updatedRecords = Array.from(updatesMap.values());
    return matchedStats;
}

export async function verifyAndSyncRedcap(googleRows, apiToken = process.env.REDCAP_API_TOKEN || DEFAULT_TOKEN, apiUrl = process.env.REDCAP_API_URL) {
    if (!apiUrl) {
        console.log(`ℹ️ [RedCap API] Proměnná REDCAP_API_URL není nastavena. Kontrola RedCapu přeskočena.`);
        return null;
    }

    if (!googleRows || googleRows.length === 0) {
        console.warn(`⚠️ [RedCap API] Žádné řádky k ověření.`);
        return null;
    }

    console.log(`==================================================`);
    console.log(`4. KROK: Kontrola a synchronizace histologie s RedCap API...`);
    console.log(`==================================================`);
    console.log(`🌐 REDCap API URL: ${apiUrl}`);

    try {
        console.log(`📥 Načítám existující vizity z RedCapu...`);
        const redcapRecords = await fetchRedcapRecords(apiToken, apiUrl);
        console.log(`Načteno ${redcapRecords.length} záznamů/vizit z RedCapu.`);

        const stats = matchAndPrepareRedcapUpdates(googleRows, redcapRecords);
        console.log(`--------------------------------------------------`);
        console.log(`📊 Výsledky párování: Spárováno: ${stats.matched}/${stats.totalRows} | Nespárováno: ${stats.unmatched} | Připraveno k aktualizaci: ${stats.updatedRecords.length}`);

        if (stats.updatedRecords.length > 0) {
            console.log(`📤 Odesílám aktualizované výsledky histologie do RedCapu...`);
            const importRes = await importRedcapRecords(stats.updatedRecords, apiToken, apiUrl);
            console.log(`✅ [RedCap API] Odpověď z RedCapu (aktualizováno):`, importRes);
        } else {
            console.log(`ℹ️ Žádné záznamy nebyly vyžadovány k aktualizaci.`);
        }

        console.log(`==================================================\n`);
        return stats;
    } catch (err) {
        console.error(`❌ [RedCap API] Chyba při synchronizaci s RedCapem:`, err.message);
        throw err;
    }
}
