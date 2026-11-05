@echo off
setlocal
set "NODE_DIR=%LOCALAPPDATA%\portable-node\node-v24.18.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
set "FRIBOI_SUPERVISOR=1"

:servidor
echo [%date% %time%] iniciando >> "logs\servidor.log"
node server\index.js >> "logs\servidor.log" 2>&1
rem continua alguem escutando? entao este laco e a copia: sai fora
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul && goto fim
rem pedido de reinicio vindo da tela de importacao: sobe na hora
if exist "data\reiniciar" (del "data\reiniciar" >nul & goto servidor)
ping -n 11 127.0.0.1 >nul
goto servidor

:fim
exit /b 0
