import { fetchRedcapRecords, parseDate } from './redcap.js';

function computeRocAuc(items, scoreKey) {
    const valid = items.filter(it => it[scoreKey] !== null && !isNaN(it[scoreKey]));
    if (valid.length === 0) return { auc: 0, rocPoints: [], optimalCutoff: null };

    valid.sort((a, b) => b[scoreKey] - a[scoreKey]);

    const totalPos = valid.filter(it => it.is_hg === 1).length;
    const totalNeg = valid.filter(it => it.is_hg === 0).length;

    if (totalPos === 0 || totalNeg === 0) return { auc: 0, rocPoints: [], optimalCutoff: null };

    let tp = 0;
    let fp = 0;
    let auc = 0;
    let prevFp = 0;
    let prevTp = 0;

    const rocPoints = [{ fpr: 0, tpr: 0, threshold: valid[0][scoreKey] + 0.05, sensitivity: 0, specificity: 1, youdenJ: 0 }];
    let maxYoudenJ = -1;
    let optimalCutoff = null;

    for (let i = 0; i < valid.length; i++) {
        const item = valid[i];
        if (item.is_hg === 1) {
            tp++;
        } else {
            fp++;
        }

        if (i === valid.length - 1 || valid[i + 1][scoreKey] !== item[scoreKey]) {
            const fpr = fp / totalNeg;
            const tpr = tp / totalPos;
            const sensitivity = tpr;
            const specificity = 1 - fpr;
            const youdenJ = sensitivity + specificity - 1;

            auc += (fpr - prevFp) * (tpr + prevTp) / 2;
            prevFp = fpr;
            prevTp = tpr;

            const pt = {
                fpr: Math.round(fpr * 10000) / 10000,
                tpr: Math.round(tpr * 10000) / 10000,
                sensitivity: Math.round(sensitivity * 10000) / 10000,
                specificity: Math.round(specificity * 10000) / 10000,
                threshold: Math.round(item[scoreKey] * 10000) / 10000,
                youdenJ: Math.round(youdenJ * 10000) / 10000
            };

            rocPoints.push(pt);

            if (youdenJ > maxYoudenJ) {
                maxYoudenJ = youdenJ;
                optimalCutoff = pt;
            }
        }
    }

    return {
        auc: Math.round(auc * 10000) / 10000,
        totalPos,
        totalNeg,
        rocPoints,
        optimalCutoff
    };
}

async function runRocAnalysis() {
    console.log(`==================================================`);
    console.log(`📊 ANALÝZA ROC AUC A PROSPEKTIVNÍ VALIDACE MODELU`);
    console.log(`==================================================`);

    const records = await fetchRedcapRecords('A0062F58293C7206CF3768BFE25F65AD', 'https://redcap.vfn.cz/api/');
    const cutoffDate = new Date(Date.UTC(2026, 2, 1)); // po 1.3.2026

    const dataset = [];

    for (const r of records) {
        const d = parseDate(r.datum || r.v1_date || r.vfu_date);
        if (!d || d <= cutoffDate) continue;

        const konVal = r.konizace || r.v1_kon_res;
        const pbVal = r.biopsie || r.v1_pb_res;
        if (!konVal && !pbVal) continue;

        const probVal = parseFloat(r.prob !== undefined && r.prob !== '' ? r.prob : r.hg_probability);
        const coveredVal = parseFloat(r.covered !== undefined && r.covered !== '' ? r.covered : r.tz_covered_by_hg_frac);
        const pfhgVal = parseFloat(r.pfhg !== undefined && r.pfhg !== '' ? r.pfhg : r.pixel_fraction_hg);

        if (isNaN(probVal)) continue;

        const rawHist = (konVal && konVal !== '0') ? konVal.toString().trim() : pbVal.toString().trim();
        const rLower = rawHist.toLowerCase();

        let is_hg = 0;
        let histLabel = 'Bez dysplázie';
        if (rLower === '1' || rLower.includes('bez dyspl') || rLower.includes('ned')) {
            is_hg = 0; histLabel = 'Bez dysplázie';
        } else if (rLower === '2' || rLower.includes('cin1') || rLower.includes('cin 1')) {
            is_hg = 0; histLabel = 'CIN 1';
        } else if (rLower === '3' || rLower.includes('cin2') || rLower.includes('cin 2')) {
            is_hg = 1; histLabel = 'CIN 2';
        } else if (rLower === '4' || rLower.includes('cin3') || rLower.includes('cin 3')) {
            is_hg = 1; histLabel = 'CIN 3';
        } else if (rLower === '5' || rLower.includes('ais')) {
            is_hg = 1; histLabel = 'AIS';
        } else if (rLower === '6' || rLower.includes('karcinom') || rLower.includes('ca')) {
            is_hg = 1; histLabel = 'Karcinom';
        }

        dataset.push({
            record_id: r.record_id || r.id,
            datum: r.datum || r.v1_date,
            is_hg,
            histLabel,
            prob: probVal,
            covered: isNaN(coveredVal) ? 0 : coveredVal,
            pfhg: isNaN(pfhgVal) ? 0 : pfhgVal
        });
    }

    console.log(`\nVybraná prospektivní kohorta (vizity po 1.3.2026):`);
    console.log(`Celkem vizit:                ${dataset.length}`);
    console.log(`High-Grade léze (CIN 2+):    ${dataset.filter(d => d.is_hg === 1).length}`);
    console.log(`Low-Grade / Bez dysplázie:   ${dataset.filter(d => d.is_hg === 0).length}\n`);

    const rocProb = computeRocAuc(dataset, 'prob');
    const rocCovered = computeRocAuc(dataset, 'covered');
    const rocPfhg = computeRocAuc(dataset, 'pfhg');

    console.log(`--------------------------------------------------`);
    console.log(`📈 ROC AUC VÝSLEDKY PROSPEKTIVNÍ VALIDACE MODELU:`);
    console.log(`--------------------------------------------------`);
    console.log(`1. prob (HG pravděpodobnost / hg_probability):`);
    console.log(`   -> ROC AUC = ${rocProb.auc}`);
    console.log(`   -> Optimal Cutoff (Youden J): threshold = ${rocProb.optimalCutoff?.threshold}, Sens = ${Math.round(rocProb.optimalCutoff?.sensitivity * 100)}%, Spec = ${Math.round(rocProb.optimalCutoff?.specificity * 100)}%`);

    console.log(`\n2. covered (podíl HGL v TZ / tz_covered_by_hg_frac):`);
    console.log(`   -> ROC AUC = ${rocCovered.auc}`);
    console.log(`   -> Optimal Cutoff (Youden J): threshold = ${rocCovered.optimalCutoff?.threshold}, Sens = ${Math.round(rocCovered.optimalCutoff?.sensitivity * 100)}%, Spec = ${Math.round(rocCovered.optimalCutoff?.specificity * 100)}%`);

    console.log(`\n3. pfhg (plošný podíl HGL / pixel_fraction_hg):`);
    console.log(`   -> ROC AUC = ${rocPfhg.auc}`);
    console.log(`   -> Optimal Cutoff (Youden J): threshold = ${rocPfhg.optimalCutoff?.threshold}, Sens = ${Math.round(rocPfhg.optimalCutoff?.sensitivity * 100)}%, Spec = ${Math.round(rocPfhg.optimalCutoff?.specificity * 100)}%`);
    console.log(`==================================================\n`);
}

runRocAnalysis();
