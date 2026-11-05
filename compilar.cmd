@echo off
setlocal
set "NODE_DIR=%LOCALAPPDATA%\portable-node\node-v24.18.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"

echo Compilando a interface...
call npm run build
if errorlevel 1 goto falhou
echo.
echo Interface compilada. Feche o servidor e abra o iniciar.cmd novamente.
pause
exit /b 0

:falhou
echo.
echo Nao consegui compilar. Veja as mensagens acima.
pause
exit /b 1
