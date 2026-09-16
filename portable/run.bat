@echo off
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=%SCRIPT_DIR%node.exe"

if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo ===================================================================
echo   AUTOMATIZOVANE ZPRACOVANI HISTOLOGICKYCH REPORTU (PDF -^> EXCEL)
echo ===================================================================

if "%~1"=="" goto USE_DEFAULT

echo Zpracovavam soubor: "%~1"
echo Nacitam OCR a AI engine, prosim cekejte...
echo.
"%NODE_EXE%" "%SCRIPT_DIR%convert.js" "%~1"
goto END

:USE_DEFAULT
echo Spoustim vyhodnoceni pro vychozi soubor histologie.pdf...
echo Nacitam OCR a AI engine, prosim cekejte...
echo.
"%NODE_EXE%" "%SCRIPT_DIR%convert.js" "%SCRIPT_DIR%histologie.pdf"
goto END

:END
echo.
pause
