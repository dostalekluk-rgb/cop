import { fetchRedcapRecords, cleanRc, parseDate } from './redcap.js';

// Seznam všech 57 čísel pojištěnců přímo z Google Tabulky uživatele
const userBirthNumbers = [
    "8353090119",
    "9062120012",
    "9460170830",
    "9551252590",
    "9153142526",
    "551179057",
    "9355183343",
    "9452272632",
    "9056190165",
    "5851310443",
    "8154220712",
    "9158312097",
    "525319096",
    "9561170003",
    "53233268",
    "9558041394",
    "8959684041",
    "9954251714",
    "8956110031",
    "8554280823",
    "9057180297",
    "8355590584",
    "9256163081",
    "8856754665",
    "8162025586",
    "9254230502",
    "7860120191",
    "8652111072",
    "9755220134",
    "454257958",
    "9058014999",
    "8353090119",
    "9062120012",
    "9460170830",
    "9551252590",
    "9153142526",
    "551179057",
    "9355183343",
    "9452272632",
    "9056190165",
    "525107013",
    "525107013",
    "9561170003",
    "53233268",
    "9558041394",
    "8959684041",
    "9954251714",
    "5851310443",
    "8154220712",
    "9158312097",
    "525319096",
    "525107013",
    "9561170003",
    "53233268",
    "9558041394",
    "8959684041",
    "9954251714"
];

async function check57Records() {
    console.log(`==================================================`);
    console.log(`🔍 PROVĚŘOVÁNÍ VŠECH 57 ZÁZNAMŮ Z GOOGLE TABULKY PROTI REDCAPU`);
    console.log(`==================================================\n`);

    const redcapRecords = await fetchRedcapRecords('A0062F58293C7206CF3768BFE25F65AD', 'https://redcap.vfn.cz/api/');
    console.log(`Načteno ${redcapRecords.length} záznamů/vizit z RedCapu.\n`);

    const results = [];
    let matchedCount = 0;
    let notFoundInRedcap = 0;

    for (let i = 0; i < userBirthNumbers.length; i++) {
        const rawRc = userBirthNumbers[i];
        const cleaned = cleanRc(rawRc);

        const matches = redcapRecords.filter(rec => {
            const recRc = cleanRc(rec.rc || rec.cislo_pojistence || rec.record_id);
            return recRc === cleaned;
        });

        if (matches.length > 0) {
            matchedCount++;
            const rec = matches[0];
            const redcapId = rec.id || rec.record_id || rec.v1_id || rec.scr_id || '';
            const recDate = rec.datum || rec.v1_date || rec.vfu_date || '';
            results.push({
                index: i + 1,
                rawRc,
                cleanedRc: cleaned,
                found: true,
                redcapId,
                recDate,
                allMatchesCount: matches.length
            });
            console.log(`✅ Řádek ${i + 1}: RC ${rawRc} ➔ NAJÍT V REDCAPU! RedCap ID: "${redcapId}" | Datum vizity: ${recDate}`);
        } else {
            notFoundInRedcap++;
            results.push({
                index: i + 1,
                rawRc,
                cleanedRc: cleaned,
                found: false
            });
            console.log(`❌ Řádek ${i + 1}: RC ${rawRc} ➔ V RedCapu NEEXISTUJE žiadna vizita s tímto RC.`);
        }
    }

    console.log(`\n==================================================`);
    console.log(`📊 SOUHRN PROVĚŘENÍ VŠECH 57 ZÁZNAMŮ:`);
    console.log(`--------------------------------------------------`);
    console.log(`Celkem zkontrolováno v Google Tabulce: ${userBirthNumbers.length}`);
    console.log(`Nalezeno v RedCapu:                    ${matchedCount}`);
    console.log(`Nenalezeno v RedCapu:                  ${notFoundInRedcap}`);
    console.log(`==================================================\n`);
}

check57Records();
