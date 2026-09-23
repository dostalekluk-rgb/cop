import fs from 'fs';

/**
 * SKRIPT PRO TESTOVÁNÍ ODESLÁNÍ 1 TESTOVACÍHO ŘÁDKU DO GOOGLE TABULKY
 * (prostřednictvím Google Apps Script Web App z kod.gs)
 */

const webAppUrl = process.argv[2] || process.env.GOOGLE_WEB_APP_URL;

if (!webAppUrl) {
    console.error(`
===================================================================
❌ CHYBA: Chybí URL webové aplikace Google Apps Script!
===================================================================

Použití:
  node test_google_sheets.js "https://script.google.com/macros/s/.../exec"

Nebo nastavte proměnnou prostředí GOOGLE_WEB_APP_URL:
  set GOOGLE_WEB_APP_URL=https://script.google.com/macros/s/.../exec
  node test_google_sheets.js

Jak získat URL webové aplikace z Google Tabulky:
  1. V Google Tabulce otevřete: Rozšíření -> Apps Script
  2. Vložte kód z kod.gs
  3. Klikněte na tlačítko "Nasadit" (Deploy) -> "Nová nasazení" (New deployment)
  4. Vyberte typ "Webová aplikace" (Web app)
  5. Nastavte "Spustit jako: Já" (Execute as: Me) a "Kdo má přístup: Kdo koli" (Anyone)
  6. Klikněte na "Nasadit" a zkopírujte URL Webové aplikace (Web App URL).
===================================================================
`);
    process.exit(1);
}

const now = new Date();
const dateStr = now.toLocaleDateString('cs-CZ') + ' ' + now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

// 1 testovací řádek odpovídající 12 sloupcům A-L v tabulce
const testRow = [
    dateStr,                                                                    // 1. Datum příjmu
    "TESTOVANÁ PACIENTKA",                                                      // 2. Jméno pacientky
    "999999/9999",                                                              // 3. Číslo pojištěnce
    "Testovací histologický nález z děložního hrdla (ověření propojení).",      // 4. Text nálezu
    "kontrola anonymizace OK",                                                 // 5. Kontrola anonymizace
    "ne",                                                                       // 6. Punch biopsie z hrdla?
    "ano",                                                                      // 7. Konizace?
    "CIN2",                                                                     // 8. Výsledek
    "čistý",                                                                    // 9. Okraj konizace
    "neprovedeno",                                                              // 10. Výsledek kyretáže
    "žádný",                                                                    // 11. Zbylý histologický nález
    "REC_TEST_999"                                                              // 12. ID RedCap (Sloupec L)
];

async function runTest() {
    console.log(`\n==================================================`);
    console.log(`🚀 SPUŠTĚNÍ TESTU ODESLÁNÍ 1 ŘÁDKU DO GOOGLE TABULKY`);
    console.log(`==================================================`);
    console.log(`🌐 Web App URL: ${webAppUrl}`);
    console.log(`📝 Připravený testovací řádek (11 sloupců):`);
    console.log(testRow);
    console.log(`--------------------------------------------------`);

    try {
        const response = await fetch(webAppUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rows: [testRow] }),
            redirect: 'follow'
        });

        const rawText = await response.text();
        let resJson;
        try {
            resJson = JSON.parse(rawText);
        } catch {
            resJson = { raw: rawText };
        }

        console.log(`✅ ODPOVĚĎ SERVERU (Google Apps Script):`);
        console.dir(resJson, { depth: null });
        
        if (resJson.status === 'success') {
            console.log(`\n🎉 TEST ÚSPĚŠNÝ! 1 testovací řádek byl úspěšně zapsán na konec Google Tabulky.`);
        } else {
            console.warn(`\n⚠️ Server vrátil nečekaný stav:`, resJson);
        }
        console.log(`==================================================\n`);
    } catch (err) {
        console.error(`\n❌ CHYBA PŘI ODESÍLÁNÍ:`, err.message);
        console.error(err);
        process.exit(1);
    }
}

runTest();
