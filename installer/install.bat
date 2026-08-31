@echo off
rem Double-click-friendly launcher for install.ps1 - raw .ps1 files don't run on double-click by default on
rem Windows (they open in a text editor instead), so this just calls PowerShell directly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
