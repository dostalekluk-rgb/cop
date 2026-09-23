@echo off
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=%SCRIPT_DIR%node.exe"

if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo ===================================================================
echo   RECER AI - KOMPLETNI PIPELINE ZPRACOVANI HISTOLOGIE A VALIDACE
echo ===================================================================

if "%~1"=="" goto USE_DEFAULT

echo Spoustim pipeline pro zadaný soubor: "%~1"
echo.
"%NODE_EXE%" "%SCRIPT_DIR%run_pipeline.js" "%~1"
goto END

:USE_DEFAULT
echo Nebyl zadan zadny soubor. Pouzivam vychozi: "%SCRIPT_DIR%histologie.pdf"
echo.
"%NODE_EXE%" "%SCRIPT_DIR%run_pipeline.js" "%SCRIPT_DIR%histologie.pdf"
goto END

:END
echo.
pause
