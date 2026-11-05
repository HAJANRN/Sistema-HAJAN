@echo off
setlocal
set "NODE_DIR=%LOCALAPPDATA%\portable-node\node-v24.18.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo Primeira execucao: compilando a interface...
  call npm run build
  if errorlevel 1 goto falhou
)

echo Iniciando o servidor local (le as pastas da rede)...
call npm start
pause
exit /b 0

:falhou
echo.
echo Nao consegui compilar. Veja as mensagens acima.
pause
exit /b 1
