@echo off
powershell.exe -NoProfile -File "%~dp0scripts\start-sensor-test.ps1"
if errorlevel 1 pause
