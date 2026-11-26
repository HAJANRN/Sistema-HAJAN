@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_RUNTIME=portable_python\python.exe"

if not exist "hajan_pedidos.db" (
    echo Banco hajan_pedidos.db nao encontrado. Extraia todos os arquivos do pacote para a mesma pasta.
    pause
    exit /b 1
)

if not exist "%PYTHON_RUNTIME%" (
    echo Runtime portatil nao encontrado. Extraia o pacote completo.
    pause
    exit /b 1
)

set "STREAMLIT_BROWSER_GATHER_USAGE_STATS=false"
"%PYTHON_RUNTIME%" -m streamlit run app.py --server.address 127.0.0.1 --server.port 8501 --server.enableCORS true --server.enableXsrfProtection true --server.maxUploadSize 5 --server.maxMessageSize 8 --server.fileWatcherType none --client.toolbarMode minimal --runner.magicEnabled false
if errorlevel 1 goto :erro
exit /b 0

:erro
echo.
echo Nao foi possivel iniciar. Confira se o pacote foi extraido por completo.
pause
exit /b 1