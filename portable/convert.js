import { createPolyfilledPureCanvas } from './fetch-polyfill.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Writable } from 'stream';
import PImage from 'pureimage';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import ExcelJS from 'exceljs';
import { GoogleGenAI } from '@google/genai';

// Přenosné řešení cest nezávislé na aktuální složce (spustitelné i z USB/Flash disku)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Potlačení neškodného varování pdfjs-dist ohledně WASM v Node.js
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
    const msg = args.map(a => (typeof a === 'string' ? a : (a?.message || ''))).join(' ');
    if (msg.includes('#instantiateWasm') || msg.includes('jbig2.wasm')) {
        return;
    }
    originalConsoleWarn.apply(console, args);
};

// Gemini API Klíč
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('UPOZORNĚNÍ: Není nastaven klíč GEMINI_API_KEY v proměnných prostředí (process.env.GEMINI_API_KEY).');
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

let napiCanvasModule = null;
try {
    napiCanvasModule = await import('@napi-rs/canvas');
} catch (e) {
    // Odchycení blokace DLL zásadami řízení aplikací Windows (AppLocker)
}

class NodeCanvasFactory {
    create(width, height) {
        const w = Math.floor(width);
        const h = Math.floor(height);
        if (napiCanvasModule) {
            const canvas = napiCanvasModule.createCanvas(w, h);
            const context = canvas.getContext('2d');
            return { canvas, context, isNative: true };
        } else {
            const canvas = createPolyfilledPureCanvas(w, h);
            const context = canvas.getContext('2d');
            return { canvas, context, isNative: false };
        }
    }

    reset(canvasAndContext, width, height) {
        canvasAndContext.canvas.width = Math.floor(width);
        canvasAndContext.canvas.height = Math.floor(height);
    }

    destroy(canvasAndContext) {
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

async function getCanvasPngBuffer(canvasAndContext) {
    if (typeof canvasAndContext.canvas?.toBuffer === 'function') {
        return canvasAndContext.canvas.toBuffer('image/png');
    }
    const chunks = [];
    const outStream = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
        }
    });
    await PImage.encodePNGToStream(canvasAndContext.canvas, outStream);
    return Buffer.concat(chunks);
}

export function createBmpBuffer(width, height, rgbaBuffer) {
    const fileHeaderSize = 14;
    const infoHeaderSize = 40;
    const headerSize = fileHeaderSize + infoHeaderSize;
    const pixelDataSize = width * height * 4;
    const fileSize = headerSize + pixelDataSize;

    const buffer = Buffer.alloc(fileSize);

    // BM header
    buffer.write('BM', 0);
    buffer.writeUInt32LE(fileSize, 2);
    buffer.writeUInt32LE(headerSize, 10);

    // BITMAPINFOHEADER
    buffer.writeUInt32LE(infoHeaderSize, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(-height, 22); // Top-down image
    buffer.writeUInt16LE(1, 26);
    buffer.writeUInt16LE(32, 28);
    buffer.writeUInt32LE(0, 30);
    buffer.writeUInt32LE(pixelDataSize, 34);

    // Copy RGBA to BGRA
    let srcOffset = 0;
    let dstOffset = headerSize;
    for (let i = 0; i < width * height; i++) {
        buffer[dstOffset] = rgbaBuffer[srcOffset + 2];     // B
        buffer[dstOffset + 1] = rgbaBuffer[srcOffset + 1]; // G
        buffer[dstOffset + 2] = rgbaBuffer[srcOffset];     // R
        buffer[dstOffset + 3] = rgbaBuffer[srcOffset + 3]; // A
        srcOffset += 4;
        dstOffset += 4;
    }

    return buffer;
}

/**
 * 1. KROK: 100% Lokální převod PDF do TXT pomocí OCR (Tesseract.js + pdfjs-dist)
 */
export async function convertPdfToTxt(inputPdfPath, outputTxtPath) {
    console.log(`==================================================`);
    console.log(`1. KROK: Lokální převod PDF do TXT (OCR Tesseract)...`);
    console.log(`==================================================`);

    const wasmDir = pathToFileURL(path.resolve(__dirname, 'node_modules/pdfjs-dist/wasm/')).href + '/';
    const dataBuffer = new Uint8Array(fs.readFileSync(inputPdfPath));
    
    const pdfDocument = await pdfjsLib.getDocument({
        data: dataBuffer,
        isEvalSupported: true,
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
        console.log(`[Strana ${pageNum}/${totalPages}] Načítám stránku PDF...`);
        
        const page = await pdfDocument.getPage(pageNum);
        let cleanText = '';

        // 1) Zkusíme přímo vyextrahovat vestavěný text (pokud se nejedná o naskenované obrázky)
        const textContent = await page.getTextContent();
        if (textContent && textContent.items && textContent.items.length > 0) {
            cleanText = textContent.items.map(item => item.str).join(' ').trim();
        }

        // 2) Pokud stránka nemá text, extrahujeme skenovaný obrázek přímo v Pure JS (100% nezávislé na DLL/canvas)
        if (!cleanText || cleanText.length < 20) {
            const ops = await page.getOperatorList();
            let imageProcessed = false;

            for (let i = 0; i < ops.fnArray.length; i++) {
                if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
                    const imgName = ops.argsArray[i][0];
                    
                    await new Promise(resolve => {
                        page.objs.get(imgName, async (imgData) => {
                            if (!imgData || !imgData.data) {
                                resolve();
                                return;
                            }
                            console.log(`[Strana ${pageNum}/${totalPages}] Extrahována skenovaná stránka (${imgData.width}x${imgData.height}). Spouštím OCR...`);
                            
                            const w = imgData.width;
                            const h = imgData.height;
                            const src = imgData.data;
                            const rgba = new Uint8ClampedArray(w * h * 4);

                            if (imgData.kind === 1) { // 1BPP Černobílá
                                let q = 0;
                                for (let p = 0; p < src.length; p++) {
                                    const byte = src[p];
                                    for (let bit = 7; bit >= 0; bit--) {
                                        if (q >= w * h * 4) break;
                                        const val = ((byte >> bit) & 1) ? 255 : 0;
                                        rgba[q] = val;
                                        rgba[q + 1] = val;
                                        rgba[q + 2] = val;
                                        rgba[q + 3] = 255;
                                        q += 4;
                                    }
                                }
                            } else if (imgData.kind === 2) { // 24BPP RGB
                                for (let p = 0, q = 0; p < src.length; p += 3, q += 4) {
                                    rgba[q] = src[p];
                                    rgba[q + 1] = src[p + 1];
                                    rgba[q + 2] = src[p + 2];
                                    rgba[q + 3] = 255;
                                }
                            } else { // 32BPP RGBA nebo jiné
                                rgba.set(src);
                            }

                            const bmpBuffer = createBmpBuffer(w, h, rgba);
                            const { data: { text } } = await worker.recognize(bmpBuffer);
                            cleanText = text.trim();
                            imageProcessed = true;
                            resolve();
                        });
                    });

                    if (imageProcessed) break;
                }
            }

            // Záložní možnost renderování na canvas
            if (!imageProcessed) {
                console.log(`[Strana ${pageNum}/${totalPages}] Spouštím záložní vykreslování stránky...`);
                const viewport = page.getViewport({ scale: 2.0 });
                const canvasFactory = new NodeCanvasFactory();
                const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
                await page.render({
                    canvasContext: canvasAndContext.context,
                    viewport: viewport,
                    canvasFactory: canvasFactory
                }).promise;

                const imageBuffer = await getCanvasPngBuffer(canvasAndContext);
                const { data: { text } } = await worker.recognize(imageBuffer);
                cleanText = text.trim();
            }
        }

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

    // Definice sloupců A až K
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
        { header: 'Zbylý histologický nález', key: 'zbyly_nalez', width: 45 }
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
        const datumMatch = block.match(/Datum příjmu a čas příjmu\s*:\s*(.*?)(?=\s*Číslopoj|\s*Poj|\r?\n|$)/i);
        let datum = datumMatch ? datumMatch[1].trim() : '';
        datum = datum.replace(/[|=–-]/g, ' ').replace(/\s+/g, ' ').trim();

        // 2) Jméno pacientky
        const jmenoMatch = block.match(/Jméno\s*:\s*(.*?)(?=\s*Datum příjmu|\s*Číslopoj|\r?\n|$)/i);
        let jmeno = jmenoMatch ? jmenoMatch[1].trim() : '';
        jmeno = jmeno.replace(/^[|.=\s]+/, '').replace(/\s+/g, ' ').trim();

        // 3) Číslo pojištěnce
        const cisloPojMatch = block.match(/Číslopoj\.?\s*:\s*(.*?)(?=\s*Poj|\r?\n|$)/i);
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

    // Příprava polí pro odeslání do Google Tabulek
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
            row.getCell('zbyly_nalez').value || ''
        ];
    });

    return exportedRows;
}

/**
 * 3. KROK: Odeslání výsledných řádků do Google Tabulek přes Google Apps Script Web App (kod.gs)
 */
export async function sendRowsToGoogleSheets(rows, webAppUrl = process.env.GOOGLE_WEB_APP_URL) {
    if (!webAppUrl) {
        console.log(`ℹ️ [Google Tabulky] Proměnná GOOGLE_WEB_APP_URL není nastavena. Odesílání do Google Tabulek přeskočeno.`);
        return null;
    }

    if (!rows || rows.length === 0) {
        console.warn(`⚠️ [Google Tabulky] Žádné řádky k odeslání.`);
        return null;
    }

    console.log(`==================================================`);
    console.log(`3. KROK: Odesílání ${rows.length} řádků do Google Tabulek...`);
    console.log(`==================================================`);
    console.log(`🌐 Cílové Web App URL: ${webAppUrl}`);

    try {
        const response = await fetch(webAppUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rows: rows }),
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
        console.error(`❌ [Google Tabulky] Chyba při odesílání do Google Tabulek:`, err.message);
        throw err;
    }
}

/**
 * Přímé volání Gemini AI Modelu (gemini-3.6-flash) se strukturovaným JSON výstupem a automatickým retry při výpadku sítě
 */
async function callGeminiAiModel(nalezText, maxRetries = 4) {
    const prompt = `Analýza histologického nálezu:\n"""\n${nalezText}\n"""`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: prompt,
                config: {
                    systemInstruction: SYSTEM_AI_INSTRUCTION,
                    responseMimeType: 'application/json',
                    responseSchema: AI_RESPONSE_SCHEMA
                }
            });

            const parsed = JSON.parse(response.text);
            return parsed;
        } catch (err) {
            console.warn(`⚠️ [Gemini API] Pokus ${attempt}/${maxRetries} selhal (${err.message})...`);
            if (attempt === maxRetries) {
                throw err;
            }
            const delayMs = attempt * 3000;
            console.log(`⏱️ Čekám ${delayMs / 1000}s před dalším pokusem...`);
            await new Promise(res => setTimeout(res, delayMs));
        }
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
    const outputExcelPath = path.join(pdfDir, inputArg ? `${pdfBasename}.xlsx` : 'cop.xlsx');

    console.log(`\n==================================================`);
    console.log(`🚀 SPUŠTĚNÍ AUTOMATIZOVANÉHO SKRIPTVU (CONVERT.JS)`);
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

        // 3. Krok: Excel ➔ Google Tabulky (pokud je nastaveno GOOGLE_WEB_APP_URL)
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
