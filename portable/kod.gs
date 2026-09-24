function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getTargetSheet(ss);

    // 1. Pokud je tabulka prázdná, automaticky zapíšeme hlavičku 12 sloupců (A-L)
    if (sheet.getLastRow() === 0) {
      ensureHeader(sheet);
    }

    var data = JSON.parse(e.postData.contents);

    // Pokud klient požaduje stažení všech řádků
    if (data.action === "get_rows") {
      return getRowsResponse(sheet);
    }

    // Příkaz pro čistý reset a naplnění základními řádky
    if (data.action === "reset_with_rows" && (data.rows || data.updates)) {
      var rowsToReset = data.rows || data.updates;
      sheet.clearContents();
      ensureHeader(sheet);
      if (rowsToReset.length > 0) {
        sheet.getRange(2, 1, rowsToReset.length, rowsToReset[0].length).setValues(rowsToReset);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", reset: true, count: rowsToReset.length }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Příkaz pro aktualizaci pouze Sloupce L (ID RedCap) bez přidávání nových řádků
    if (data.action === "update_ids_only" && (data.updates || data.rows)) {
      var updates = data.updates || data.rows;
      var lastRow = sheet.getLastRow();
      var updatedCount = 0;

      if (lastRow > 1) {
        var existingValues = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), 12)).getDisplayValues();

        for (var i = 0; i < updates.length; i++) {
          var uRow = updates[i];
          var uRc = cleanRcStr(uRow[2]);
          var uDateDmy = extractDmyStr(uRow[0]);
          var redcapId = uRow[11];

          if (!uRc || !redcapId) continue;

          for (var r = 0; r < existingValues.length; r++) {
            var exRc = cleanRcStr(existingValues[r][2]);
            var exDateDmy = extractDmyStr(existingValues[r][0]);

            if (exRc === uRc) {
              if (uDateDmy && exDateDmy) {
                if (exDateDmy === uDateDmy) {
                  sheet.getRange(r + 2, 12).setValue(redcapId);
                  existingValues[r][11] = redcapId;
                  updatedCount++;
                  break;
                }
              } else {
                sheet.getRange(r + 2, 12).setValue(redcapId);
                existingValues[r][11] = redcapId;
                updatedCount++;
                break;
              }
            }
          }
        }
      }

      return ContentService.createTextOutput(JSON.stringify({ status: "success", updated: updatedCount }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. Zpracování příchozích řádků pro zápis / aktualizaci nových záznamů
    var incomingRows = data.rows || data.new_rows;
    if (incomingRows && incomingRows.length > 0) {
      var lastRow = sheet.getLastRow();
      var addedCount = 0;
      var updatedCount = 0;
      var skippedCount = 0;

      var existingValues = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), 12)).getDisplayValues() : [];

      for (var i = 0; i < incomingRows.length; i++) {
        var newRow = incomingRows[i];

        while (newRow.length < 12) {
          newRow.push("");
        }

        var newDateDmy = extractDmyStr(newRow[0]);
        var newRc = cleanRcStr(newRow[2]);

        var foundMatchRowIndex = -1;

        if (newRc) {
          for (var r = 0; r < existingValues.length; r++) {
            var exRc = cleanRcStr(existingValues[r][2]);
            var exDateDmy = extractDmyStr(existingValues[r][0]);
            
            if (exRc === newRc) {
              if (newDateDmy && exDateDmy) {
                if (exDateDmy === newDateDmy) {
                  foundMatchRowIndex = r + 2;
                  break;
                }
              } else {
                foundMatchRowIndex = r + 2;
                break;
              }
            }
          }
        }

        if (foundMatchRowIndex > 0) {
          if (newRow[11]) {
            sheet.getRange(foundMatchRowIndex, 12).setValue(newRow[11]);
            existingValues[foundMatchRowIndex - 2][11] = newRow[11];
            updatedCount++;
          } else {
            skippedCount++;
          }
        } else {
          var nextRow = sheet.getLastRow() + 1;
          sheet.getRange(nextRow, 1, 1, newRow.length).setValues([newRow]);
          existingValues.push(newRow);
          addedCount++;
        }
      }

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        added: addedCount,
        updated: updatedCount,
        skipped: skippedCount,
        total: incomingRows.length 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "no_data" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getTargetSheet(ss);
    return getRowsResponse(sheet);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function ensureHeader(sheet) {
  var headers = [
    "Datum příjmu",
    "Jméno pacientky",
    "Číslo pojištěnce",
    "Text nálezu",
    "Kontrola anonymizace",
    "Punch biopsie z hrdla?",
    "Konizace?",
    "Výsledek",
    "Okraj konizace",
    "Výsledek kyretáže",
    "Zbylý histologický nález",
    "ID RedCap"
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
}

function getTargetSheet(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getLastRow() > 0) {
      return sheets[i];
    }
  }
  return sheets[0];
}

function getRowsResponse(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow <= 1) {
    return ContentService.createTextOutput(JSON.stringify({ status: "success", rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var values = sheet.getRange(2, 1, lastRow - 1, Math.max(lastCol, 12)).getDisplayValues();
  var formattedRows = [];
  
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var formattedRow = [];
    for (var j = 0; j < row.length; j++) {
      formattedRow.push(row[j] !== null && row[j] !== undefined ? row[j].toString() : "");
    }
    formattedRows.push(formattedRow);
  }

  return ContentService.createTextOutput(JSON.stringify({ 
    status: "success", 
    rows: formattedRows 
  })).setMimeType(ContentService.MimeType.JSON);
}

function cleanStr(val) {
  if (!val) return "";
  return val.toString().trim();
}

function cleanRcStr(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "number") {
    return val.toFixed(0).replace(/\D/g, "").trim();
  }
  return val.toString().replace(/\D/g, "").trim();
}

function extractDmyStr(val) {
  if (val === null || val === undefined) return "";
  var s = val.toString().trim();
  var m = s.match(/(\d{1,2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{4})/);
  if (m) {
    var d = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var y = m[3];
    return (d < 10 ? "0" + d : d) + "." + (month < 10 ? "0" + month : month) + "." + y;
  }
  var ymd = s.match(/(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
  if (ymd) {
    var y = ymd[1];
    var month = parseInt(ymd[2], 10);
    var d = parseInt(ymd[3], 10);
    return (d < 10 ? "0" + d : d) + "." + (month < 10 ? "0" + month : month) + "." + y;
  }
  return s;
}

