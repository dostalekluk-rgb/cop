import fs from 'fs';

/**
 * MODUL PRO KONTROLU A SYNCHRONIZACI HISTOLOGICKÝCH VÝSLEDKŮ S REDCAP API
 */

const DEFAULT_TOKEN = 'A0062F58293C7206CF3768BFE25F65AD';

/**
 * Pomocná funkce pro vyčištění a normalizaci rodného čísla (odstranění lomítek, mezer a jiných nečíselných znaků)
 */
export function cleanRc(rcStr) {
    if (!rcStr) return '';
    return rcStr.toString().replace(/\D/g, '').trim();
}

/**
 * Pomocná funkce pro převod řetězce data na objekt Date (vynulované hodiny pro přesné porovnání dnů)
 */
export function parseDate(dateStr) {
    if (!dateStr) return null;
    const s = dateStr.toString().trim();

    // Formát DD.MM.YYYY nebo DD.MM.YYYY HH:mm
    const dmyMatch = s.match(/^(\d{1,2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{4})/);
    if (dmyMatch) {
        const day = parseInt(dmyMatch[1], 10);
        const month = parseInt(dmyMatch[2], 10) - 1; // 0-indexed
        const year = parseInt(dmyMatch[3], 10);
        const date = new Date(Date.UTC(year, month, day));
        return isNaN(date.getTime()) ? null : date;
    }

    // Formát YYYY-MM-DD
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

/**
 * Převod názvu výsledku histologie z Google Tabulky na číselný kód v RedCapu
 * 1: bez dysplázie (NED)
 * 2: CIN 1
 * 3: CIN 2
 * 4: CIN 3
 * 5: AIS
 * 6: karcinom
 */
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

/**
 * Načtení záznamů z RedCap API
 */
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

/**
 * Odeslání aktualizovaných záznamů do RedCap API
 */
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

/**
 * Hlavní porovnávací a synchronizační logika mezi řádky z tabulky Google / PDF a záznamy z RedCapu
 * 
 * Pravidla párování:
 * 1. Shoda rodného čísla (rc)
 * 2. Datum příjmu v tabulce Google musí být stejné jako datum vizity v RedCapu (datum / v1_date),
 *    nebo maximálně 5 dní PO datu vizity v RedCapu (0 až +5 dní).
 * 3. Pokud je konizace = 'ano' -> uloží se výsledek do proměnné konizace (a v1_kon_res).
 * 4. Pokud konizace = 'ne' a punch_biopsie = 'ano' -> uloží se výsledek do proměnné biopsie (a v1_pb_res).
 */
export function matchAndPrepareRedcapUpdates(googleRows, redcapRecords) {
    const matchedStats = {
        totalRows: googleRows.length,
        matched: 0,
        unmatched: 0,
        alreadyUpToDate: 0,
        updatedRecords: []
    };

    const updatesMap = new Map(); // record_id -> update object

    for (let i = 0; i < googleRows.length; i++) {
        const row = googleRows[i];
        
        // Získání hodnot ze sloupců tabulky Google:
        // Sloupec 0: Datum příjmu
        // Sloupec 2: Číslo pojištěnce (rodné číslo)
        // Sloupec 5: Punch biopsie z hrdla? ("ano"/"ne")
        // Sloupec 6: Konizace? ("ano"/"ne")
        // Sloupec 7: Výsledek histologie ("bez dysplázie", "CIN1", "CIN2", "CIN3", "AIS", "karcinom")
        const datumPrijmuStr = row[0] || '';
        const cisloPoj = row[2] || '';
        const punchBiopsie = (row[5] || '').toString().trim().toLowerCase();
        const konizace = (row[6] || '').toString().trim().toLowerCase();
        const vysledekStr = row[7] || '';

        const cleanRcGoogle = cleanRc(cisloPoj);
        const dateGoogle = parseDate(datumPrijmuStr);

        if (!cleanRcGoogle || !dateGoogle) {
            console.warn(`⚠️ [RedCap Kontrola] Řádek ${i + 1} obsahuje neplatné RC ("${cisloPoj}") nebo Datum příjmu ("${datumPrijmuStr}").`);
            matchedStats.unmatched++;
            continue;
        }

        // Hledání odpovídající vizity v RedCapu
        let candidateVisits = [];

        for (const rcRec of redcapRecords) {
            // Zjištění RČ z RedCap záznamu (podporuje 'rc', 'cislo_pojistence', 'record_id')
            const recRc = cleanRc(rcRec.rc || rcRec.cislo_pojistence || rcRec.record_id);
            if (recRc !== cleanRcGoogle) continue;

            // Zjištění data z RedCap záznamu (podporuje 'datum', 'v1_date', 'vfu_date')
            const recDateStr = rcRec.datum || rcRec.v1_date || rcRec.vfu_date;
            const dateRedcap = parseDate(recDateStr);
            if (!dateRedcap) continue;

            // Určení maximálního přípustného odstupu vizity v REDCapu před datem příjmu:
            // 1. Pokud konizace = 'ano' -> vizita v REDCapu může předcházet Datum příjmu o max 60 dní (0 až 60 dní)
            // 2. Pokud punch biopsie = 'ano' -> vizita v REDCapu může předcházet Datum příjmu o max 7 dní (o týden, 0 až 7 dní)
            // 3. Jinak výchozí tolerance 5 dní (0 až 5 dní)
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
            console.warn(`⚠️ [RedCap Kontrola] Nenašena adekvátní vizita v RedCapu pro RC "${cisloPoj}" s datem příjmu "${datumPrijmuStr}".`);
            row[11] = ''; // Sloupec L zůstává prázdný
            matchedStats.unmatched++;
            continue;
        }

        // Pokud je více kandidátů, vybere se ten s nejmenším rozdílem dnů (nejbližší vizita)
        candidateVisits.sort((a, b) => a.diffDays - b.diffDays);
        const bestMatch = candidateVisits[0].record;

        matchedStats.matched++;
        const mappedCode = mapHistologyResultToCode(vysledekStr);

        // Zjištění ID vizity z RedCapu (id, record_id, v1_id nebo scr_id)
        const redcapId = bestMatch.id || bestMatch.record_id || bestMatch.v1_id || bestMatch.scr_id || '';
        row[11] = redcapId; // Doplnění do sloupce L (index 11) v tabulce Google

        // Určení proměnných pro uložení výsledku v RedCapu
        const recordId = bestMatch.record_id || bestMatch.rc || redcapId;
        const updateObj = updatesMap.get(recordId) || { record_id: recordId };
        
        if (bestMatch.redcap_event_name) updateObj.redcap_event_name = bestMatch.redcap_event_name;
        if (bestMatch.redcap_repeat_instance) updateObj.redcap_repeat_instance = bestMatch.redcap_repeat_instance;

        let targetFieldLog = '';

        if (konizace === 'ano') {
            // Uložení do konizace
            updateObj.konizace = mappedCode || vysledekStr;
            if ('v1_kon_res' in bestMatch) updateObj.v1_kon_res = mappedCode || vysledekStr;
            if ('v1_kon' in bestMatch) updateObj.v1_kon = '1';
            targetFieldLog = `konizace = ${mappedCode || vysledekStr}`;
        } else if (punchBiopsie === 'ano') {
            // Uložení do biopsie
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

/**
 * Kompletní obslužná funkce pro ověření a synchronizaci s RedCap API
 */
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
