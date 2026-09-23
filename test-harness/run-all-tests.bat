@echo off
setlocal EnableDelayedExpansion

rem Runs every automated test-harness script one after another and prints a PASS/FAIL summary at the end.
rem See test-harness/README.md for what each script actually does.
rem
rem Requirements (same as running any of these by hand - see test-harness/README.md's "Your first run"):
rem   - A real, interactive Windows desktop session (the ui/ scripts launch the actual app window).
rem   - The app already built (npm run build:prod, or just app\main.js already present).
rem   - 7-Zip (and, for optical-media tests, ImgBurn) configured in appData\config.json.
rem
rem Usage:
rem   test-harness\run-all-tests.bat

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."

set "RESULTS_FILE=%TEMP%\test-harness-run-results-%RANDOM%.txt"
type nul > "%RESULTS_FILE%"

set /a TOTAL=0
set /a PASS_COUNT=0
set /a FAIL_COUNT=0

if not exist "app\main.js" (
    echo WARNING: app\main.js was not found - the app does not look built yet.
    echo Run "npm run build:prod" first, or every test below will fail immediately.
    echo.
)

echo ============================================================
echo  Cleaning up leftovers from any previous run first
echo ============================================================
call node test-harness\cleanup.js
echo.

echo ============================================================
echo  Running the full test-harness suite
echo  worker-ipc tests first ^(fast, no UI^), then ui tests ^(slower, opens real app windows^)
echo  See test-harness\README.md / test-harness\worker-ipc\README.md / test-harness\ui\README.md
echo ============================================================
echo.

rem --- worker-ipc: talks directly to the app's engine over IPC, no on-screen clicking ---
call :run "worker-ipc: test-partitioning" "test-harness\worker-ipc\test-partitioning.js"
call :run "worker-ipc: test-merge" "test-harness\worker-ipc\test-merge.js"
call :run "worker-ipc: test-incremental-backup" "test-harness\worker-ipc\test-incremental-backup.js"
call :run "worker-ipc: test-sync-dirs" "test-harness\worker-ipc\test-sync-dirs.js"
call :run "worker-ipc: test-scan-progress" "test-harness\worker-ipc\test-scan-progress.js"
call :run "worker-ipc: test-large-file-split" "test-harness\worker-ipc\test-large-file-split.js"
call :run "worker-ipc: test-large-file-split-boundary" "test-harness\worker-ipc\test-large-file-split-boundary.js"
call :run "worker-ipc: test-multi-large-file-split" "test-harness\worker-ipc\test-multi-large-file-split.js"
call :run "worker-ipc: test-split-piece-capacity-guard" "test-harness\worker-ipc\test-split-piece-capacity-guard.js"

rem --- ui: drives the real on-screen app with Playwright, clicking through it like a person would ---
call :run "ui: test-recover-single-disc" "test-harness\ui\test-recover-single-disc.js"
call :run "ui: test-incremental-backup" "test-harness\ui\test-incremental-backup.js"
call :run "ui: test-sync-dirs" "test-harness\ui\test-sync-dirs.js"
call :run "ui: test-recover-multi-disc" "test-harness\ui\test-recover-multi-disc.js"
call :run "ui: test-recover-from-json-metadata" "test-harness\ui\test-recover-from-json-metadata.js"
call :run "ui: test-backup-to-optical-media" "test-harness\ui\test-backup-to-optical-media.js"
call :run "ui: test-backup-to-optical-media-overflow-disc" "test-harness\ui\test-backup-to-optical-media-overflow-disc.js"
call :run "ui: test-add-missing-files" "test-harness\ui\test-add-missing-files.js"
call :run "ui: test-backup-to-optical-media-sha256" "test-harness\ui\test-backup-to-optical-media-sha256.js"
call :run "ui: test-recover-integrity-detects-corruption" "test-harness\ui\test-recover-integrity-detects-corruption.js"
call :run "ui: test-verify-cold-storage-integrity" "test-harness\ui\test-verify-cold-storage-integrity.js"
call :run "ui: test-startup-temp-snackbar" "test-harness\ui\test-startup-temp-snackbar.js"

echo.
echo ============================================================
echo  SUMMARY
echo ============================================================
type "%RESULTS_FILE%"
echo ------------------------------------------------------------
echo  !PASS_COUNT!/!TOTAL! passed, !FAIL_COUNT!/!TOTAL! failed
echo ============================================================
echo.

del "%RESULTS_FILE%" >nul 2>&1

if !FAIL_COUNT! GTR 0 (
    echo Not auto-cleaning scratch data - at least one test failed, and a failure deliberately leaves its
    echo scratch data in place for you to inspect ^(see test-harness\README.md's "Safety model"^). Once you're
    echo done looking, clear it out with:
    echo   node test-harness\cleanup.js --dry-run   ^(see what would be removed first^)
    echo   node test-harness\cleanup.js             ^(actually remove it^)
    set "EXITCODE=1"
    goto :end
)

echo Everything passed - cleaning up this run's scratch data.
call node test-harness\cleanup.js
set "EXITCODE=0"

:end
popd
echo.
pause
exit /b %EXITCODE%

:run
set "NAME=%~1"
set "SCRIPT=%~2"
set /a TOTAL+=1
echo ------------------------------------------------------------
echo [!TOTAL!] %NAME%
echo ------------------------------------------------------------
if not exist "%SCRIPT%" (
    echo RESULT: FAIL - script not found: %SCRIPT%
    echo   FAIL  - %NAME%  -  script not found>> "%RESULTS_FILE%"
    set /a FAIL_COUNT+=1
    echo.
    goto :eof
)
node "%SCRIPT%"
if !errorlevel! EQU 0 (
    set /a PASS_COUNT+=1
    echo RESULT: PASS
    echo   PASS  - %NAME%>> "%RESULTS_FILE%"
) else (
    set /a FAIL_COUNT+=1
    echo RESULT: FAIL  -  exit code !errorlevel!
    echo   FAIL  - %NAME%  -  exit code !errorlevel!>> "%RESULTS_FILE%"
)
echo.
goto :eof
