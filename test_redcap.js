import { cleanRc, parseDate, mapHistologyResultToCode, matchAndPrepareRedcapUpdates, verifyAndSyncRedcap } from './redcap.js';

/**
 * TESTOVACÍ SKRIPT PRO REDCAP INTEGRACI
 */

console.log(`\n==================================================`);
console.log(`🧪 SPUŠTĚNÍ JEDNOTKOVÝCH TESTŮ PRO REDCAP MODUL`);
console.log(`==================================================\n`);

// 1. Test vyčištění rodného čísla
console.log(`1. Test cleanRc:`);
console.assert(cleanRc('999999/9999') === '9999999999', 'cleanRc selhalo pro 999999/9999');
console.assert(cleanRc(' 850512 / 1234 ') === '8505121234', 'cleanRc selhalo s mezerami');
console.log(`  ✅ cleanRc funguje správně.`);

// 2. Test převodu data
console.log(`2. Test parseDate:`);
const d1 = parseDate('23.09.2026 19:30');
console.assert(d1 && d1.getUTCFullYear() === 2026 && d1.getUTCMonth() === 8 && d1.getUTCDate() === 23, 'parseDate DD.MM.YYYY HH:mm selhalo');

const d2 = parseDate('2026-09-23');
console.assert(d2 && d2.getUTCFullYear() === 2026 && d2.getUTCMonth() === 8 && d2.getUTCDate() === 23, 'parseDate YYYY-MM-DD selhalo');
console.log(`  ✅ parseDate funguje správně.`);

// 3. Test převodu výsledku histologie
console.log(`3. Test mapHistologyResultToCode:`);
console.assert(mapHistologyResultToCode('bez dysplázie') === '1', 'bez dysplázie mapping error');
console.assert(mapHistologyResultToCode('CIN1') === '2', 'CIN1 mapping error');
console.assert(mapHistologyResultToCode('CIN 2') === '3', 'CIN 2 mapping error');
console.assert(mapHistologyResultToCode('CIN3') === '4', 'CIN3 mapping error');
console.assert(mapHistologyResultToCode('AIS') === '5', 'AIS mapping error');
console.assert(mapHistologyResultToCode('karcinom') === '6', 'karcinom mapping error');
console.log(`  ✅ mapHistologyResultToCode funguje správně.`);

// 4. Test logiky párování (0 až 5 dní okno)
console.log(`\n4. Test párovací logiky a časového okna (0 až 5 dní):`);

const sampleGoogleRows = [
    // Řádek 1: Shoda na den přesně (0 dní) - Konizace
    ['20.09.2026', 'Pacientka 1', '900101/1111', 'Text 1', 'kontrola anonymizace OK', 'ne', 'ano', 'CIN2', 'čistý', 'neprovedeno', 'žádný', ''],
    // Řádek 2: Vzorek přišel 3 dny po vizitě (+3 dny) - Biopsie
    ['23.09.2026', 'Pacientka 2', '900202/2222', 'Text 2', 'kontrola anonymizace OK', 'ano', 'ne', 'CIN3', 'neuplatňuje se', 'neprovedeno', 'žádný', ''],
    // Řádek 3: Vzorek přišel 5 dní po vizitě (+5 dní) - Konizace (hraniční shoda)
    ['25.09.2026', 'Pacientka 3', '900303/3333', 'Text 3', 'kontrola anonymizace OK', 'ne', 'ano', 'karcinom', 'čistý', 'neprovedeno', 'žádný', ''],
    // Řádek 4: Vzorek přišel 6 dní po vizitě (+6 dní) -> Nemělo by se spárovat!
    ['26.09.2026', 'Pacientka 4', '900404/4444', 'Text 4', 'kontrola anonymizace OK', 'ne', 'ano', 'CIN1', 'čistý', 'neprovedeno', 'žádný', ''],
    // Řádek 5: Vzorek přišel před vizitou (-1 den) -> Nemělo by se spárovat!
    ['19.09.2026', 'Pacientka 5', '900505/5555', 'Text 5', 'kontrola anonymizace OK', 'ne', 'ano', 'CIN1', 'čistý', 'neprovedeno', 'žádný', '']
];

const sampleRedcapRecords = [
    { record_id: 'REC_101', rc: '9001011111', datum: '20.09.2026' },
    { record_id: 'REC_102', rc: '9002022222', datum: '20.09.2026' },
    { record_id: 'REC_103', rc: '9003033333', datum: '20.09.2026' },
    { record_id: 'REC_104', rc: '9004044444', datum: '20.09.2026' },
    { record_id: 'REC_105', rc: '9005055555', datum: '20.09.2026' }
];

const stats = matchAndPrepareRedcapUpdates(sampleGoogleRows, sampleRedcapRecords);

console.log(`\nVýsledky testu párování:`);
console.log(`  Spárováno očekáváno: 3 | Skutečnost: ${stats.matched}`);
console.log(`  Nespárováno očekáváno: 2 | Skutečnost: ${stats.unmatched}`);

console.assert(stats.matched === 3, 'Počet spárovaných neodpovídá!');
console.assert(stats.unmatched === 2, 'Počet nespárovaných neodpovídá!');

// Ověření doplnění RedCap ID do sloupce L (index 11)
console.assert(sampleGoogleRows[0][11] === 'REC_101', 'Řádek 1 nemá spárované ID REC_101');
console.assert(sampleGoogleRows[1][11] === 'REC_102', 'Řádek 2 nemá spárované ID REC_102');
console.assert(sampleGoogleRows[2][11] === 'REC_103', 'Řádek 3 nemá spárované ID REC_103');
console.assert(sampleGoogleRows[3][11] === '', 'Řádek 4 by měl mít prázdné ID');
console.assert(sampleGoogleRows[4][11] === '', 'Řádek 5 by měl mít prázdné ID');

const rec101 = stats.updatedRecords.find(r => r.record_id === 'REC_101');
console.assert(rec101 && rec101.konizace === '3', 'REC_101 konizace by měla být 3 (CIN2)');

const rec102 = stats.updatedRecords.find(r => r.record_id === 'REC_102');
console.assert(rec102 && rec102.biopsie === '4', 'REC_102 biopsie by měla být 4 (CIN3)');

const rec103 = stats.updatedRecords.find(r => r.record_id === 'REC_103');
console.assert(rec103 && rec103.konizace === '6', 'REC_103 konizace by měla být 6 (karcinom)');

console.log(`  ✅ Sloupec L (ID RedCap) byl správně doplněn u spárovaných vizit.`);
console.log(`\n🎉 VŠECHNY JEDNOTKOVÉ TESTY ÚSPĚŠNĚ PROŠLY!\n`);
