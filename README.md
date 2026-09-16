# Automatizované zpracování histologických reportů (PDF ➔ Excel)

Skript `convert.js` slouží ke kompletnímu automatizovanému zpracování naskenovaných i textových histologických reportů (PDF) s **100% garancí ochrany osobních údajů (PII)** a vyhodnocením klíčových klinických parametrů pomocí **Gemini 3.6 Flash AI**.

---

## 🚀 Jak skript spustit (Přenosné z Flash Disku / CLI)

Skript je navržen jako přenosný (portable) a lze jej spustit z jakékoliv složky nebo USB flash disku bez nutnosti pevně zadaných cest.

### 1. Spuštění z příkazové řádky (CMD / PowerShell / Terminal)
```bash
# Zpracování konkrétního PDF souboru
node convert.js "C:\Cesta\K\Souboru\histologie.pdf"

# Zpracování souboru z flash disku / relativní cesty
node convert.js report.pdf

# Pokud nezadáte žádný argument, automaticky se zpracuje 'histologie.pdf' ve složce skriptu
node convert.js
```

### 2. Spuštění přetažením myší (Drag & Drop na Windows)
Ve složce je připraven soubor `run.bat`. Stačí jakýkoliv PDF soubor chytit myší a přetáhnout na ikonu `run.bat`. Zpracování proběhne automaticky v okně příkazové řádky.

---

## 📋 Průběh a architektura zpracování

1. **OCR / Převod do TXT (100% Lokálně)**
   - Pomocí `pdfjs-dist` a `tesseract.js` (český OCR model) se naskenované stránky PDF převedou na strukturovaný text.
   - Výstupní text se uloží do `.txt` souboru se stejným názvem jako vstupní PDF.

2. **Extrakce hlavičky a textu nálezu**
   - Z hlavičky každé stránky se extrahuje:
     - **Datum příjmu** ➔ Sloupec A
     - **Jméno pacientky** ➔ Sloupec B
     - **Číslo pojištěnce** ➔ Sloupec C
     - **Text nálezu** (od "Nález:" do konce stránky) ➔ Sloupec D

3. **Striktní Bezpečnostní Audit Anonymizace**
   - Před odesláním do AI proběhne lokální audit Sloupce D:
     - Kontroluje se výskyt jména, příjmení a čísla pojištěnce dané pacientky i křížově ostatních pacientek.
     - Výsledek auditu se zapíše do **Sloupce E** (`kontrola anonymizace OK` nebo `záznam není anonymní`).
   - 🔒 **Bezpečnostní pojistka:** Pokud záznam v auditním kroku neprojde jako 100% anonymní, **NEBUDE odeslán do AI**!

4. **Klinická AI Analýza (Gemini 3.6 Flash)**
   - Pouze pro anonymizované záznamy se zavolá model Gemini 3.6 Flash se strukturovaným schématem odpovědi:
     - **Punch biopsie z hrdla?** (`ano`/`ne`) ➔ Sloupec F
     - **Konizace?** (`ano`/`ne`) ➔ Sloupec G
     - **Výsledek** (`bez dysplázie` / `CIN1` / `CIN2` / `CIN3` / `AIS` / `karcinom` / `jiné`) ➔ Sloupec H
     - **Okraj konizace** (`čistý` / `přednádorový stav v okraji` / `karcinom v okraji` / `neuplatňuje se`) ➔ Sloupec I
     - **Výsledek kyretáže** ➔ Sloupec J
     - **Zbylý histologický nález** ➔ Sloupec K

5. **Export do Excelu (.xlsx)**
   - Všechny údaje se zformátují a uloží do Excel tabulky `.xlsx` (se zalamováním textu a barevným odlišením stavu anonymizace).
