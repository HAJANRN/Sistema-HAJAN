@echo off
setlocal
cd /d "%~dp0"

rem Mantem os emissores 8501 (local) e 8502 (rede) sempre no ar.
rem O vigia cuida do reinicio automatico; aqui so garantimos que ele esteja rodando.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File .\vigia_servidor.ps1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b 0
