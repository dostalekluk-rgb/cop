import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import ExcelJS from 'exceljs';
import { GoogleGenAI } from '@google/genai';
import { verifyAndSyncRedcap, cleanRc, parseDate } from './redcap.js';

// Přenosné řešení cest nezávislé na aktuální složce
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurace workeru a WASM pro pdfjs-dist z adresáře skriptu
const workerPath = path.resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

// Automatické načtení .env souboru
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

// Gemini API Klíč
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('UPOZORNĚNÍ: Není nastaven klíč GEMINI_API_KEY v proměnných prostředí (process.env.GEMINI_API_KEY).');
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

class NodeCanvasFactory {
    create(width, height) {
        const canvas = createCanvas(Math.floor(width), Math.floor(height));
        const context = canvas.getContext('2d');
        return { canvas, context };
    }

    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = Math.floor(width);
        canvasAndContext.canvas.height = Math.floor(height);
    }

    destroy(canvasAndContext) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

/**
 * 1. KROK: 100% Lokální převod PDF do TXT pomocí OCR (Tesseract.js + pdfjs-dist)
 */
export async function convertPdfToTxt(inputPdfPath, outputTxtPath) {
    console.log(`==================================================`);
    console.log(`1. KROK: Lokální převod PDF do TXT (OCR Tesseract)...`);
    console.log(`==================================================`);

    if (!fs.existsSync(inputPdfPath)) {
        throw new Error(`Vstupní PDF soubor '${inputPdfPath}' neexistuje!`);
    }

    const wasmDir = pathToFileURL(path.resolve(__dirname, 'node_modules/pdfjs-dist/wasm/')).href + '/';
    const dataBuffer = new Uint8Array(fs.readFileSync(inputPdfPath));
    
    const pdfDocument = await pdfjsLib.getDocument({
        data: dataBuffer,
        isEvalSupported: false,
        wasmUrl: wasmDir
    }).promise;

    const totalPages = pdfDocument.numPages;
    console.log(`PDF načteno. Celkový počet stránek: ${totalPages}`);
    console.log('Inicializuji Tesseract OCR engine (čeština)...');

    const worker = await createWorker('ces', 1, {
        cachePath: __dirname,
        langPath: __dirname
    });

    let fullText = '';
    let totalChars = 0;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        console.log(`[Strana ${pageNum}/${totalPages}] Vykresluji stránku...`);
        
        const page = await pdfDocument.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 }); // High DPI for optimal OCR accuracy

        const canvasFactory = new NodeCanvasFactory();
        const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport: viewport,
            canvasFactory: canvasFactory
        };

        await page.render(renderContext).promise;
        const imageBuffer = canvasAndContext.canvas.toBuffer('image/png');

        console.log(`[Strana ${pageNum}/${totalPages}] Spouštím OCR rozpoznávání textu...`);
        const { data: { text } } = await worker.recognize(imageBuffer);
        const cleanText = text.trim();

        console.log(`[Strana ${pageNum}/${totalPages}] Rozpoznáno ${cleanText.length} znaků.`);

        const pageHeader = `=== STRANA ${pageNum} ===\n\n`;
        fullText += pageHeader + cleanText + '\n\n';
        totalChars += cleanText.length;
    }

    await worker.terminate();

    fs.writeFileSync(outputTxtPath, fullText, 'utf-8');

    console.log(`--------------------------------------------------`);
    console.log(`✅ Lokální převod do TXT dokončen!`);
    console.log(`Soubor uložen: ${outputTxtPath}`);
    console.log(`Zpracováno stránek: ${totalPages} (${totalChars} znaků)`);
    console.log(`==================================================\n`);
}

/**
 * 2. KROK: Extrakce polí, Audit Anonymizace a Gemini AI Vyhodnocení do Excelu
 */
export async function exportToExcel(txtFilePath, excelFilePath) {
    console.log(`==================================================`);
    console.log(`2. KROK: Extrakce polí, Audit Anonymizace & Gemini AI...`);
    console.log(`==================================================`);

    if (!fs.existsSync(txtFilePath)) {
        throw new Error(`Soubor s textem '${txtFilePath}' neexistuje!`);
    }

    const text = fs.readFileSync(txtFilePath, 'utf-8');
    const pageBlocks = text.split(/=== STRANA \d+ ===/).map(b => b.trim()).filter(Boolean);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Histologické nálezy');

    // Definice sloupců A až L
    worksheet.columns = [
        { header: 'Datum příjmu', key: 'datum_prijmu', width: 20 },
        { header: 'Jméno pacientky', key: 'jmeno', width: 25 },
        { header: 'Číslo pojištěnce', key: 'cislo_pojistence', width: 18 },
        { header: 'Text nálezu', key: 'nalez_text', width: 80 },
        { header: 'Kontrola anonymizace', key: 'kontrola_anonymizace', width: 25 },
        { header: 'Punch biopsie z hrdla?', key: 'punch_biopsie', width: 22 },
        { header: 'Konizace?', key: 'konizace', width: 15 },
        { header: 'Výsledek', key: 'vysledek', width: 20 },
        { header: 'Okraj konizace', key: 'okraj_konizace', width: 30 },
        { header: 'Výsledek kyretáže', key: 'vysledek_kyretaze', width: 45 },
        { header: 'Zbylý histologický nález', key: 'zbyly_nalez', width: 45 },
        { header: 'ID RedCap', key: 'redcap_id', width: 20 }
    ];

    // Styling hlavičky
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    const records = [];
    const allSurnames = new Set();
    const allCislaPoj = new Set();

    // A) Extrakce základních polí
    for (let i = 0; i < pageBlocks.length; i++) {
        const block = pageBlocks[i];

        // 1) Datum příjmu
        const datumMatch = block.match(/Datum příjmu a čas příjmu\s*:\s*(.*?)(?=\s*Číslo\s*poj|\s*Poj[.:\s]|\r?\n|$)/i);
        let datum = datumMatch ? datumMatch[1].trim() : '';
        datum = datum.replace(/[|=–-]/g, ' ').replace(/\s+/g, ' ').trim();

        // 2) Jméno pacientky
        const jmenoMatch = block.match(/Jméno\s*:\s*(.*?)(?=\s*Datum příjmu|\s*Číslo\s*poj|\s*Poj[.:\s]|\r?\n|$)/i);
        let jmeno = jmenoMatch ? jmenoMatch[1].trim() : '';
        jmeno = jmeno.replace(/^[|.=\s]+/, '').replace(/\s+/g, ' ').trim();

        // 3) Číslo pojištěnce
        const cisloPojMatch = block.match(/Číslo\s*poj[a-zčěšžříáéúů]*\.?\s*:\s*(.*?)(?=\s*Poj[.:\s]|\r?\n|$)/i);
        let cisloPoj = cisloPojMatch ? cisloPojMatch[1].trim() : '';
        cisloPoj = cisloPoj.replace(/^[|=–-\s]+/, '').replace(/\s+/g, ' ').trim();

        // 4) Text nálezu
        const nalezIndex = block.search(/Nález\s*:/i);
        let nalezText = '';
        if (nalezIndex !== -1) {
            const afterNalez = block.substring(nalezIndex);
            const firstColon = afterNalez.indexOf(':');
            nalezText = afterNalez.substring(firstColon + 1).trim();
        }

        if (jmeno) {
            const surname = jmeno.split(/[\s,.]+/)[0];
            if (surname && surname.length >= 3 && !/^(mgr|mudr|doc|prof|phd|csc)$/i.test(surname)) {
                allSurnames.add(surname.toLowerCase());
            }
        }
        if (cisloPoj) {
            const cleanCislo = cisloPoj.replace(/\D/g, '');
            if (cleanCislo.length >= 6) {
                allCislaPoj.add(cleanCislo);
            }
        }

        records.push({
            pageIndex: i + 1,
            datum,
            jmeno,
            cisloPoj,
            nalezText
        });
    }

    let ownLeaksCount = 0;
    let crossLeaksCount = 0;

    // B) Audit anonymizace + Gemini AI analýza
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        let isLeaked = false;
        const cleanTextDigits = r.nalezText.replace(/\D/g, '');

        // Kontrola VLASTNÍHO čísla pojištěnce
        if (r.cisloPoj) {
            const cleanCislo = r.cisloPoj.replace(/\D/g, '');
            if (cleanCislo.length >= 6 && (r.nalezText.includes(cleanCislo) || cleanTextDigits.includes(cleanCislo))) {
                ownLeaksCount++;
                isLeaked = true;
                console.error(`❌ [ÚNÍK PII] Strana ${r.pageIndex} (${r.jmeno}): Číslo pojištěnce "${r.cisloPoj}" v textu nálezu!`);
            }
        }

        // Kontrola VLASTNÍHO jména a příjmení
        if (r.jmeno) {
            const nameParts = r.jmeno.split(/[\s,.]+/).filter(part => part.length >= 3 && !/^(mgr|mudr|doc|prof|phd|csc)$/i.test(part));
            for (const part of nameParts) {
                const regex = new RegExp(`\\b${escapeRegExp(part)}\\b`, 'i');
                if (regex.test(r.nalezText)) {
                    ownLeaksCount++;
                    isLeaked = true;
                    console.error(`❌ [ÚNÍK PII] Strana ${r.pageIndex} (${r.jmeno}): Jméno/příjmení "${part}" v textu nálezu!`);
                }
            }
        }

        // Křížová kontrola příjmení a čísel pojištěnců
        for (const surname of allSurnames) {
            const regex = new RegExp(`\\b${escapeRegExp(surname)}\\b`, 'i');
            if (regex.test(r.nalezText)) {
                const ownSurname = r.jmeno ? r.jmeno.split(/[\s,.]+/)[0].toLowerCase() : '';
                if (surname !== ownSurname) {
                    crossLeaksCount++;
                    isLeaked = true;
                    console.warn(`⚠️ [KŘÍŽOVÝ ÚNÍK] Strana ${r.pageIndex} (${r.jmeno}): Příjmení jiné pacientky "${surname}" v textu!`);
                }
            }
        }
        for (const cislo of allCislaPoj) {
            const ownCislo = r.cisloPoj ? r.cisloPoj.replace(/\D/g, '') : '';
            if (cislo !== ownCislo && (r.nalezText.includes(cislo) || cleanTextDigits.includes(cislo))) {
                crossLeaksCount++;
                isLeaked = true;
                console.error(`❌ [KŘÍŽOVÝ ÚNÍK] Strana ${r.pageIndex} (${r.jmeno}): Číslo pojištěnce jiné pacientky "${cislo}" v textu!`);
            }
        }

        const kontrolaStatus = isLeaked ? 'záznam není anonymní' : 'kontrola anonymizace OK';

        let aiResult = {
            punch_biopsie: '',
            konizace: '',
            vysledek: '',
            okraj_konizace: '',
            vysledek_kyretaze: '',
            zbyly_nalez: ''
        };

        // 🚨 STRIKTNÍ PODMÍNKA: Do AI se odešle POUZE anonymní záznam!
        if (kontrolaStatus === 'kontrola anonymizace OK') {
            console.log(`🤖 [Gemini AI (gemini-3.6-flash)] Analýza anonymního nálezu ${i + 1}/${records.length} (${r.jmeno})...`);
            aiResult = await callGeminiAiModel(r.nalezText);
        } else {
            console.warn(`⛔ [PŘESKOČENO AI] Strana ${r.pageIndex} není anonymní! (Sloupec E = "${kontrolaStatus}")`);
        }

        // Přidání řádku do Excelu
        const row = worksheet.addRow({
            datum_prijmu: r.datum,
            jmeno: r.jmeno,
            cislo_pojistence: r.cisloPoj,
            nalez_text: r.nalezText,
            kontrola_anonymizace: kontrolaStatus,
            punch_biopsie: aiResult.punch_biopsie,
            konizace: aiResult.konizace,
            vysledek: aiResult.vysledek,
            okraj_konizace: aiResult.okraj_konizace,
            vysledek_kyretaze: aiResult.vysledek_kyretaze,
            zbyly_nalez: aiResult.zbyly_nalez
        });

        // Formátování buněk řádku
        const cellE = row.getCell(5);
        if (isLeaked) {
            cellE.font = { color: { argb: 'FF9C0006' }, bold: true };
        } else {
            cellE.font = { color: { argb: 'FF006100' } };
        }

        row.getCell('nalez_text').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('datum_prijmu').alignment = { vertical: 'top' };
        row.getCell('jmeno').alignment = { vertical: 'top' };
        row.getCell('cislo_pojistence').alignment = { vertical: 'top' };
        row.getCell('kontrola_anonymizace').alignment = { vertical: 'top' };
        row.getCell('punch_biopsie').alignment = { vertical: 'top' };
        row.getCell('konizace').alignment = { vertical: 'top' };
        row.getCell('vysledek').alignment = { vertical: 'top' };
        row.getCell('okraj_konizace').alignment = { vertical: 'top' };
        row.getCell('vysledek_kyretaze').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('zbyly_nalez').alignment = { wrapText: true, vertical: 'top' };
    }

    await workbook.xlsx.writeFile(excelFilePath);

    console.log(`--------------------------------------------------`);
    if (ownLeaksCount === 0 && crossLeaksCount === 0) {
        console.log(`✅ AUDIT ANONYMIZACE 100% ÚSPĚŠNÝ: Nalezeno 0 úniků PII.`);
    } else {
        console.warn(`⚠️ AUDIT ZJISTIL ${ownLeaksCount} ÚNÍKŮ PII!`);
    }
    console.log(`✅ Gemini AI vyhodnocení dokončeno! Uloženo do: ${excelFilePath}`);
    console.log(`==================================================\n`);

    // Příprava polí pro odeslání do Google Tabulek (12 sloupců A-L)
    const exportedRows = records.map((r, index) => {
        const row = worksheet.getRow(index + 2);
        return [
            row.getCell('datum_prijmu').value || '',
            row.getCell('jmeno').value || '',
            row.getCell('cislo_pojistence').value || '',
            row.getCell('nalez_text').value || '',
            row.getCell('kontrola_anonymizace').value || '',
            row.getCell('punch_biopsie').value || '',
            row.getCell('konizace').value || '',
            row.getCell('vysledek').value || '',
            row.getCell('okraj_konizace').value || '',
            row.getCell('vysledek_kyretaze').value || '',
            row.getCell('zbyly_nalez').value || '',
            row.getCell('redcap_id').value || ''
        ];
    });

    return exportedRows;
}

/**
 * 3. KROK: Odeslání výsledných řádků do Google Tabulek přes Google Apps Script Web App (kod.gs)
 */
export async function sendRowsToGoogleSheets(rows, webAppUrl = process.env.GOOGLE_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbzNzshLzdHwfbAjrMF_8vMImHq7sw-H6TH-Ns1ELs4v2nJ4OtLrWS6tQBXIJpnD2MCD/exec') {

    if (!rows || rows.length === 0) {
        console.warn(`⚠️ [Google Tabulky] Žádné řádky k odeslání.`);
        return null;
    }

    // Deduplikace řádků před odesláním podle RČ a Data příjmu (bez času)
    const uniqueMap = new Map();
    const rowsToSend = [];
    rows.forEach(r => {
        const rc = cleanRc(r[2]);
        const dateObj = parseDate(r[0]);
        let dmy = '';
        if (dateObj) {
            const day = String(dateObj.getUTCDate()).padStart(2, '0');
            const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
            const year = dateObj.getUTCFullYear();
            dmy = `${day}.${month}.${year}`;
        } else {
            dmy = (r[0] || '').toString().trim();
        }
        const key = `${rc}_${dmy}`;
        if (rc && dmy && uniqueMap.has(key)) {
            const existing = uniqueMap.get(key);
            if (!existing[11] && r[11]) existing[11] = r[11];
            return;
        }
        if (rc && dmy) uniqueMap.set(key, r);
        rowsToSend.push(r);
    });

    console.log(`==================================================`);
    console.log(`3. KROK: Odesílání ${rowsToSend.length} unifikovaných řádků do Google Tabulek...`);
    console.log(`==================================================`);
    console.log(`🌐 Cílové Web App URL: ${webAppUrl}`);

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (attempt > 1) {
                console.log(`🔄 [Google Tabulky] Opakovaný pokus ${attempt}/3 odeslání...`);
            }
            const response = await fetch(webAppUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ rows: rowsToSend }),
                redirect: 'follow'
            });

            const rawText = await response.text();
            let jsonRes;
            try {
                jsonRes = JSON.parse(rawText);
            } catch {
                jsonRes = { raw: rawText };
            }

            console.log(`✅ [Google Tabulky] Odpověď z Google Apps Script:`, jsonRes);
            console.log(`==================================================\n`);
            return jsonRes;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ [Google Tabulky] Pokus ${attempt}/3 selhal (${err.message})...`);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    console.error(`❌ [Google Tabulky] Všechny 3 pokusy odeslání do Google Tabulek selhaly:`, lastError.message);
    throw lastError;
}

function fallbackHistologyParse(nalezText) {
    let rawLower = (nalezText || '').toLowerCase();
    
    // Punch biopsie
    let punch_biopsie = (
        rawLower.includes('punch') || 
        rawLower.includes('pb') || 
        rawLower.includes('biops') || 
        rawLower.includes('částka z děložního hrdla') ||
        rawLower.includes('částky z děložního hrdla') ||
        rawLower.includes('z děložního hrdla') ||
        rawLower.includes('z hrdla')
    ) ? 'ano' : 'ne';

    // Konizace
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

    // Extrakce závěru, pokud existuje
    let targetText = rawLower;
    const zaverMatch = rawLower.match(/závěr\s*:\s*([\s\S]*?)(?=(t83|t 83|\d{1,2}\.\d{1,2}\.\d{4}|$))/i);
    if (zaverMatch && zaverMatch[1].trim().length > 5) {
        targetText = zaverMatch[1].trim();
    }

    // Normalizace textu pro zachycení tvarů s pomlčkou, římskými číslicemi a přechodnými stupni
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

    // Filtrace negovaných vět
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
    // Pravidlo: u přechodných nálezů brát horší (karcinom > AIS > CIN3 > CIN2 > CIN1)
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

/**
 * Přímé volání Gemini AI Modelu (gemini-3.8-flash) se záložním pravidlovým parserem při absenci klíče nebo chybě sítě
 */
async function callGeminiAiModel(nalezText) {
    if (!GEMINI_API_KEY) {
        console.log(`ℹ️ [Gemini API] GEMINI_API_KEY není v prostředí. Používám záložní medicínský parser.`);
        return fallbackHistologyParse(nalezText);
    }

    const prompt = `Analýza histologického nálezu:\n"""\n${nalezText}\n"""`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
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
        console.warn(`⚠️ [Gemini API] Volání Gemini API selhalo (${err.message}). Používám záložní medicínský parser.`);
        return fallbackHistologyParse(nalezText);
    }
}

/**
 * Systémové instrukce pro Gemini AI Model
 */
const SYSTEM_AI_INSTRUCTION = `
Jsi specializovaný medicínský patologicko-gynekologický asistent pro strukturovanou analýzu histologických nálezů z děložního hrdla a endometria.
Obdržíš ANONYMIZOVANÝ text histologického nálezu.
Tvým úkolem je provést přesnou odbornou extrakci následujících 6 parametrů a vrátit výhradně platný JSON objekt v daném schématu:

1. \`punch_biopsie\`: "ano" pokud se jedná o punch biopsii (PB) / punkční biopsii z hrdla; jinak "ne".
2. \`konizace\`: "ano" pokud se jedná o konizaci (kónus hrdla); jinak "ne".
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
4. \`okraj_konizace\`: v případě konizace posoudit resekční okraj ("čistý", "přednádorový stav v okraji", "karcinom v okraji"); pokud konizace nepatří k výkonu nebo nebyla provedena, uveď "neuplatňuje se".
5. \`vysledek_kyretaze\`: v případě provedení endocervikální kyretáže nebo kyretáže těla popiš stručně její výsledek; jinak "neprovedeno".
6. \`zbyly_nalez\`: stručný popis zbylého histologického nálezu (zánět, cervicitis, metaplázie, kondylom apod.), aby nic neuteklo; jinak "žádný".
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

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vstupní CLI funkce
 */
async function main() {
    const inputArg = process.argv[2];

    if (inputArg === '-h' || inputArg === '--help') {
        console.log(`
===================================================================
  AUTOMATIZOVANÉ ZPRACOVÁNÍ HISTOLOGICKÝCH REPORTŮ (PDF ➔ EXCEL)
===================================================================

Použití:
  node convert.js <cesta_k_pdf_souboru>

Příklady:
  node convert.js histologie.pdf
  node convert.js "E:\\Dokumenty\\report.pdf"
  node convert.js "C:\\Data\\dávka_01.pdf"

Popis funkčnosti:
  1. Lokální převod PDF do TXT (OCR s českým rozpoznáváním znaků)
  2. Extrakce strukturovaných dat (Datum příjmu, Jméno, Číslo pojištěnce, Nález)
  3. Bezpečnostní audit anonymizace (kontrola úniku PII do Sloupce D)
  4. Vyhodnocení anonymizovaných nálezů pomocí Gemini 3.6 Flash AI (Sloupce F-K)
  5. Výstup uložen do Excel tabulky (.xlsx)
===================================================================
`);
        process.exit(0);
    }

    const inputPdfPath = path.resolve(inputArg || 'histologie.pdf');

    if (!fs.existsSync(inputPdfPath)) {
        console.error(`\n❌ CHYBA: Soubor '${inputPdfPath}' neexistuje!`);
        console.error(`Zkontrolujte cestu k souboru nebo spusťte 'node convert.js --help'\n`);
        process.exit(1);
    }

    const pdfDir = path.dirname(inputPdfPath);
    const pdfBasename = path.basename(inputPdfPath, path.extname(inputPdfPath));

    const outputTxtPath = path.join(pdfDir, `${pdfBasename}.txt`);
    const outputExcelPath = path.join(pdfDir, inputArg ? `${pdfBasename}.xlsx` : 'histologie.xlsx');

    console.log(`\n==================================================`);
    console.log(`🚀 SPUŠTĚNÍ AUTOMATIZOVANÉHO SKRIPTU (CONVERT.JS)`);
    console.log(`==================================================`);
    console.log(`📄 Vstupní PDF:   ${inputPdfPath}`);
    console.log(`📝 Výstupní TXT:  ${outputTxtPath}`);
    console.log(`📊 Výstupní Excel: ${outputExcelPath}`);
    console.log(`==================================================\n`);

    try {
        // 1. Krok: PDF ➔ TXT
        await convertPdfToTxt(inputPdfPath, outputTxtPath);

        // 2. Krok: TXT ➔ Excel (Extrakce, Audit, Gemini AI)
        const exportedRows = await exportToExcel(outputTxtPath, outputExcelPath);

        // 3. Krok: Kontrola a synchronizace s RedCap API (doplní ID z RedCapu do sloupce L v exportedRows)
        await verifyAndSyncRedcap(exportedRows);

        // 4. Krok: Excel ➔ Google Tabulky (odeslání 12 sloupců včetně sloupce L do Google Tabulek)
        await sendRowsToGoogleSheets(exportedRows);

        console.log(`🎉 KOMPLETNÍ PROCES DOKONČEN ÚSPĚŠNĚ!`);
        console.log(`Výsledná tabulka je uložena v: ${outputExcelPath}\n`);
    } catch (err) {
        console.error(`\n❌ Nastala chyba při zpracování:`, err);
        process.exit(1);
    }
}

// Spuštění při přímém zavolání z CLI (kanonické porovnání cest odolné vůči Windows junction složkám jako Dokumenty/Documents)
if (process.argv[1]) {
    try {
        const realScriptPath = fs.realpathSync(__filename);
        const realArgPath = fs.realpathSync(process.argv[1]);
        if (realScriptPath.toLowerCase() === realArgPath.toLowerCase()) {
            main();
        }
    } catch {
        main();
    }
}
