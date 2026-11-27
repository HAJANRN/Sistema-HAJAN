@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo Primeira execucao: compilando a interface...
  call npm run build
  if errorlevel 1 goto falhou
)

echo Iniciando o Acompanhamento de entregas...
call npm start
pause
exit /b 0

:falhou
echo.
echo Nao consegui compilar. Veja as mensagens acima.
pause
exit /b 1
