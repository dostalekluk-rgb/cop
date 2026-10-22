import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { fetchRedcapRecords, importRedcapRecords, cleanRc, parseDate, mapHistologyResultToCode } from './redcap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Načtení .env
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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ CHYBA: Chybí GEMINI_API_KEY v .env!');
    process.exit(1);
}

const GOOGLE_WEB_APP_URL = process.env.GOOGLE_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbzNzshLzdHwfbAjrMF_8vMImHq7sw-H6TH-Ns1ELs4v2nJ4OtLrWS6tQBXIJpnD2MCD/exec';
const REDCAP_API_URL = process.env.REDCAP_API_URL || 'https://redcap.vfn.cz/api/';
const REDCAP_API_TOKEN = process.env.REDCAP_API_TOKEN || 'A0062F58293C7206CF3768BFE25F65AD';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const SYSTEM_AI_INSTRUCTION = `
Jsi špičkový specializovaný medicínský patologicko-gynekologický asistent pro přesnou strukturovanou analýzu histologických nálezů z děložního hrdla a endometria.
Obdržíš text histologického nálezu (zprávy).
Tvým úkolem je provést přesnou odbornou extrakci následujících parametrů a vrátit výhradně platný JSON objekt v daném schématu:

1. \`punch_biopsie\`: "ano" pokud se jedná o punch biopsii (PB) / punkční biopsii z hrdla / probatorní biopsii hrdla; jinak "ne".
2. \`konizace\`: "ano" pokud se jedná o konizaci (kónus hrdla / loop / leep / plastika čípku); jinak "ne".
3. \`vysledek\`: přesně jedna z hodnot: "bez dysplázie", "CIN1", "CIN2", "CIN3", "AIS", "karcinom", "jiné".
   ZÁSADNÍ PRAVIDLA PRO VOLBU VÝSLEDKU:
   - V případě přechodných, hraničních nebo kombinovaných závěrů (např. CIN1 / CIN2, CIN 1-2, CIN2-3, LSIL/HSIL) VŽDY VOL TEN HORŠÍ (vyšší stupeň / závažnější diagnózu):
     * "CIN1 / CIN 2" nebo "CIN 1-2" -> zvol "CIN2"
     * "CIN2 / CIN 3" nebo "CIN 2-3" -> zvol "CIN3"
     * "LSIL / HSIL" -> zvol "CIN3"
     * Pokud je přítomno ložisko CIN1 a zároveň ložisko CIN3 -> zvol "CIN3"
   - Nález "H-SIL", "HSIL", "H SIL", "high grade skvamózní intraepiteliální léze" odpovídá těžké lézi:
     * Pokud text uvádí "H-SIL" nebo "HSIL" obecně, případně "H-SIL (dříve CIN2-3)" či "až CIN3" -> zvol "CIN3".
     * Pokud je explicitně specifikováno pouze "HSIL - CIN2" bez těžší složky -> zvol "CIN2".
   - Nález "L-SIL", "LSIL", "L SIL", "low grade skvamózní intraepiteliální léze" bez těžší složky -> zvol "CIN1".
   - Pozor na negace v textu: formulace jako "HSIL neprokazujeme", "bez struktur HSIL", "HSIL zastiženy nebyly", "bez známek dysplázie" znamenají, že léze NENÍ přítomna!
4. \`okraj_konizace\`: v případě konizace posoudit resekční okraj ("čistý", "přednádorový stav v okraji", "karcinom v okraji"); pokud konizace nebyla provedena, uveď "neuplatňuje se".
5. \`vysledek_kyretaze\`: stručný popis výsledku kyretáže hrdla (CK) / těla (RC), pokud byla provedena; jinak "neprovedeno".
6. \`zbyly_nalez\`: stručný popis zbylého histologického nálezu (zánět, cervicitis, metaplázie, ovula Nabothi, polyp apod.); jinak "žádný".
`;

const AI_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        punch_biopsie: { type: 'string', enum: ['ano', 'ne'] },
        konizace: { type: 'string', enum: ['ano', 'ne'] },
        vysledek: { type: 'string', enum: ['bez dysplázie', 'CIN1', 'CIN2', 'CIN3', 'AIS', 'karcinom', 'jiné'] },
        okraj_konizace: { type: 'string', enum: ['čistý', 'přednádorový stav v okraji', 'karcinom v okraji', 'neuplatňuje se'] },
        vysledek_kyretaze: { type: 'string' },
        zbyly_nalez: { type: 'string' }
    },
    required: ['punch_biopsie', 'konizace', 'vysledek', 'okraj_konizace', 'vysledek_kyretaze', 'zbyly_nalez']
};

function fallbackHistologyParse(nalezText) {
    let rawLower = (nalezText || '').toLowerCase();
    
    let punch_biopsie = (
        rawLower.includes('punch') || 
        rawLower.includes('pb') || 
        rawLower.includes('biops') || 
        rawLower.includes('částka z děložního hrdla') ||
        rawLower.includes('částky z děložního hrdla') ||
        rawLower.includes('z děložního hrdla') ||
        rawLower.includes('z hrdla')
    ) ? 'ano' : 'ne';

    let konizace = (
        rawLower.includes('konizace') || 
        rawLower.includes('konizát') || 
        rawLower.includes('kónus') || 
        rawLower.includes('konus') || 
        rawLower.includes('plastika čípku')
    ) ? 'ano' : 'ne';

    if (konizace === 'ano' && !rawLower.includes('punch') && !rawLower.includes('pb')) {
        punch_biopsie = 'ne';
    }

    let targetText = rawLower;
    const zaverMatch = rawLower.match(/závěr\s*:\s*([\s\S]*?)(?=(t83|t 83|\d{1,2}\.\d{1,2}\.\d{4}|$))/i);
    if (zaverMatch && zaverMatch[1].trim().length > 5) {
        targetText = zaverMatch[1].trim();
    }

    const norm = (txt) => {
        return txt
            .replace(/h[\s\-_/]*sil/gi, ' hsil ')
            .replace(/l[\s\-_/]*sil/gi, ' lsil ')
            .replace(/cin\s*2\s*[-–/]\s*3/gi, ' cin3 ')
            .replace(/cin\s*1\s*[-–/]\s*2/gi, ' cin2 ')
            .replace(/cin\s*3/gi, ' cin3 ')
            .replace(/cin\s*2/gi, ' cin2 ')
            .replace(/cin\s*1/gi, ' cin1 ')
            .replace(/cin\s*[ií]\b/gi, ' cin1 ')
            .replace(/cin\s*i{2}\b/gi, ' cin2 ')
            .replace(/cin\s*i{3}\b/gi, ' cin3 ');
    };

    const sentences = targetText.split(/[.;\n]+/).map(s => s.trim()).filter(Boolean);
    const positiveSentences = sentences.filter(s => {
        const isNegated = s.includes('zastiženy nebyly') || 
                          s.includes('zastíženy nebyly') || 
                          s.includes('nebyl zastižen') || 
                          s.includes('nebyly zastiženy') || 
                          s.includes('nepozorujeme') || 
                          s.includes('neprokazujeme') || 
                          s.includes('nenacházíme') || 
                          s.includes('bez známek') ||
                          s.includes('bez struktur') ||
                          s.includes('bez jednoznačných') ||
                          s.includes('bez dyspl');
        return !isNegated;
    });

    const evalText = norm(positiveSentences.join(' ') || targetText);

    let vysledek = 'bez dysplázie';
    if (evalText.includes('karcinom') || evalText.includes('ca čípku') || evalText.includes('dlaždicobuněčný ca')) {
        vysledek = 'karcinom';
    } else if (evalText.includes('ais') || evalText.includes('adenokarcinom in situ')) {
        vysledek = 'AIS';
    } else if (evalText.includes('cin3') || evalText.includes('těžká dysplázie') || evalText.includes('těžkými dysplastickými') || evalText.includes('hsil') || evalText.includes('high grade') || evalText.includes('high-grade')) {
        vysledek = 'CIN3';
    } else if (evalText.includes('cin2') || evalText.includes('středně těžká dysplázie')) {
        vysledek = 'CIN2';
    } else if (evalText.includes('cin1') || evalText.includes('mírná dysplázie') || evalText.includes('lsil') || evalText.includes('low grade') || evalText.includes('low-grade')) {
        vysledek = 'CIN1';
    } else {
        vysledek = 'bez dysplázie';
    }

    let okraj_konizace = 'neuplatňuje se';
    if (konizace === 'ano') {
        if (rawLower.includes('v okraji') || rawLower.includes('zasahuje do okraje') || rawLower.includes('okraj pozitivní')) okraj_konizace = 'přednádorový stav v okraji';
        else okraj_konizace = 'čistý';
    }

    let vysledek_kyretaze = 'neprovedeno';
    if (rawLower.includes('kyretáž') || rawLower.includes('ck') || rawLower.includes('endocervik')) {
        vysledek_kyretaze = 'provedena kyretáž';
    }

    let zbyly_nalez = 'žádný';
    if (rawLower.includes('zánět') || rawLower.includes('cervicitis') || rawLower.includes('metaplázie') || rawLower.includes('kondylom')) {
        zbyly_nalez = 'cervicitis / metaplázie';
    }

    return {
        punch_biopsie,
        konizace,
        vysledek,
        okraj_konizace,
        vysledek_kyretaze,
        zbyly_nalez
    };
}

async function callGeminiWithRetry(nalezText, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: `Analýza histologického nálezu:\n"""\n${nalezText}\n"""`,
                config: {
                    systemInstruction: SYSTEM_AI_INSTRUCTION,
                    responseMimeType: 'application/json',
                    responseSchema: AI_RESPONSE_SCHEMA,
                    temperature: 0.1
                }
            });
            const parsed = JSON.parse(response.text);
            return parsed;
        } catch (err) {
            const isRateLimit = err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED');
            const waitTime = isRateLimit ? 10000 : (attempt * 2000);
            if (attempt === maxRetries) {
                console.warn(`    ⚠️ Gemini vyčerpal pokusy (${err.message.slice(0, 80)}). Používám záložní pravidlový parser.`);
                return fallbackHistologyParse(nalezText);
            }
            console.warn(`    ⚠️ Pokus ${attempt}/${maxRetries} (${err.message.slice(0, 60)}). Čekám ${waitTime / 1000}s...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
}

async function main() {
    console.log(`===================================================================`);
    console.log(`🚀 KOMPLETNÍ RE-PARSOVÁNÍ HISTOLOGICKÝCH ZPRÁV POMOCÍ GEMINI AI`);
    console.log(`   Model: gemini-3.8-flash`);
    console.log(`   Pravidlo: U přechodných nálezů (CIN1/CIN2 apod.) se VŽDY volí horší stupeň`);
    console.log(`===================================================================\n`);

    console.log(`📥 1. Krok: Stahuji existující řádky z Google Tabulky...`);
    const sheetRes = await fetch(GOOGLE_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_rows' }),
        redirect: 'follow'
    });
    const sheetJson = await sheetRes.json();
    const rows = sheetJson.rows || [];
    console.log(`✅ Načteno celkem ${rows.length} řádků z Google Tabulky.\n`);

    const corrections = [];
    const unchanged = [];

    console.log(`🔍 2. Krok: Průchod a re-klasifikace zpráv...`);
    console.log(`-------------------------------------------------------------------`);

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const uiRowNumber = i + 2;
        const datum = row[0] || '';
        const jmeno = row[1] || '';
        const rc = row[2] || '';
        const nalezText = row[3] || '';
        const oldPb = row[5] || '';
        const oldKon = row[6] || '';
        const oldVysledek = row[7] || '';
        const oldOkraj = row[8] || '';

        if (!nalezText || nalezText.trim().length < 10) {
            console.log(`[${i + 1}/${rows.length}] Řádek ${uiRowNumber} (${jmeno || 'Bez jména'}): Přeskakuji (prázdný text)`);
            continue;
        }

        const parsed = await callGeminiWithRetry(nalezText);
        
        const hasVysledekChange = (oldVysledek !== parsed.vysledek);
        const hasKonChange = (oldKon !== parsed.konizace);
        const hasPbChange = (oldPb !== parsed.punch_biopsie);
        const hasOkrajChange = (oldOkraj !== parsed.okraj_konizace);

        const isChanged = hasVysledekChange || hasKonChange || hasPbChange || hasOkrajChange;

        if (isChanged) {
            console.log(`\n⚡ [${i + 1}/${rows.length}] ŘÁDEK ${uiRowNumber} | Pacient: ${jmeno} (RČ: ${rc}) | Datum: ${datum}`);
            if (hasVysledekChange) {
                console.log(`   🔴 VÝSLEDEK ZMĚNA: "${oldVysledek}" ➔ "${parsed.vysledek}"`);
            }
            if (hasKonChange) {
                console.log(`   🟠 KONIZACE ZMĚNA: "${oldKon}" ➔ "${parsed.konizace}"`);
            }
            if (hasPbChange) {
                console.log(`   🟡 PB ZMĚNA: "${oldPb}" ➔ "${parsed.punch_biopsie}"`);
            }
            if (hasOkrajChange) {
                console.log(`   🔵 OKRAJ ZMĚNA: "${oldOkraj}" ➔ "${parsed.okraj_konizace}"`);
            }
            corrections.push({
                uiRow: uiRowNumber,
                jmeno,
                oldVysledek,
                newVysledek: parsed.vysledek,
                oldKon,
                newKon: parsed.konizace,
                oldPb,
                newPb: parsed.punch_biopsie
            });
        } else {
            console.log(`[${i + 1}/${rows.length}] Řádek ${uiRowNumber} (${jmeno}): Beze změny [${parsed.vysledek}]`);
            unchanged.push(uiRowNumber);
        }

        // Aktualizace hodnot v řádku
        row[5] = parsed.punch_biopsie;
        row[6] = parsed.konizace;
        row[7] = parsed.vysledek;
        row[8] = parsed.okraj_konizace;
        row[9] = parsed.vysledek_kyretaze || '';
        row[10] = parsed.zbyly_nalez || '';

        // Zápis průběhu do souboru pro snadné online sledování
        fs.writeFileSync('reparse_progress.json', JSON.stringify({
            current: i + 1,
            total: rows.length,
            percent: Math.round(((i + 1) / rows.length) * 100),
            lastPatient: jmeno,
            correctionsCount: corrections.length,
            lastCorrection: corrections[corrections.length - 1] || null
        }, null, 2));

        // Drobná pauza mezi voláními
        await new Promise(r => setTimeout(r, 400));
    }

    console.log(`\n\n-------------------------------------------------------------------`);
    console.log(`📊 SOUHRN RE-PARSOVÁNÍ:`);
    console.log(`   Celkem zpracováno: ${rows.length} řádků`);
    console.log(`   Počet opravených/změněných: ${corrections.length}`);
    console.log(`   Počet beze změny: ${unchanged.length}`);
    console.log(`-------------------------------------------------------------------`);

    if (corrections.length > 0) {
        console.log(`\n📋 PŘEHLED VŠECH OPRAV:`);
        console.table(corrections.map(c => ({
            'Řádek UI': c.uiRow,
            'Pacient': c.jmeno,
            'Původní výsledek': c.oldVysledek,
            'Nový výsledek': c.newVysledek,
            'Konizace': `${c.oldKon} -> ${c.newKon}`,
            'PB': `${c.oldPb} -> ${c.newPb}`
        })));
    }

    // 3. Krok: Odeslání aktualizovaných dat do Google Tabulek
    console.log(`\n📤 3. Krok: Odesílám ${rows.length} aktualizovaných řádků do Google Tabulky (reset_with_rows)...`);
    const updateRes = await fetch(GOOGLE_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_with_rows', rows: rows }),
        redirect: 'follow'
    });
    const updateJson = await updateRes.json();
    console.log(`✅ Odpověď Google Apps Script:`, updateJson);

    // 4. Krok: Synchronizace s REDCapem
    console.log(`\n🔄 4. Krok: Synchronizuji opravené výsledky do REDCapu...`);
    const redcapRecords = await fetchRedcapRecords(REDCAP_API_TOKEN, REDCAP_API_URL);
    console.log(`Načteno ${redcapRecords.length} záznamů z REDCapu.`);

    const redcapUpdates = [];

    for (const r of rows) {
        const rcClean = cleanRc(r[2]);
        const datumPrijmu = parseDate(r[0]);
        const vysledekStr = r[7];
        const konizace = (r[6] || '').toLowerCase();
        const punchBiopsie = (r[5] || '').toLowerCase();

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

        const updateObj = { record_id: recordId };
        if (best.redcap_event_name) updateObj.redcap_event_name = best.redcap_event_name;
        if (best.redcap_repeat_instance) updateObj.redcap_repeat_instance = best.redcap_repeat_instance;

        let needsUpdate = false;
        if (konizace === 'ano') {
            if (best.konizace !== code) {
                updateObj.konizace = code;
                needsUpdate = true;
            }
            if ('v1_kon_res' in best && best.v1_kon_res !== code) {
                updateObj.v1_kon_res = code;
                needsUpdate = true;
            }
        } else if (punchBiopsie === 'ano') {
            if (best.biopsie !== code) {
                updateObj.biopsie = code;
                needsUpdate = true;
            }
            if ('v1_pb_res' in best && best.v1_pb_res !== code) {
                updateObj.v1_pb_res = code;
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            redcapUpdates.push(updateObj);
            console.log(`   📝 REDCap update: ${best.jmeno || ''} ${best.prijmeni || ''} (ID ${recordId}): konizace/biopsie ➔ kód ${code} (${vysledekStr})`);
        }
    }

    if (redcapUpdates.length > 0) {
        console.log(`\n📤 Odesílám ${redcapUpdates.length} aktualizací do REDCapu...`);
        const redcapRes = await importRedcapRecords(redcapUpdates, REDCAP_API_TOKEN, REDCAP_API_URL);
        console.log(`✅ REDCap odpověď:`, redcapRes);
    } else {
        console.log(`ℹ️ V REDCapu již byly všechny záznamy aktuální.`);
    }

    console.log(`\n===================================================================`);
    console.log(`🎉 Celé re-parsování, zápis do Google Tabulky a synchronizace s REDCapem úspěšně dokončeny!`);
    console.log(`===================================================================`);
}

main().catch(err => {
    console.error('Kritická chyba:', err);
    process.exit(1);
});
