FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    HOME=/home/hajan

RUN groupadd --system --gid 10001 hajan \
    && useradd --system --uid 10001 --gid hajan --home-dir /home/hajan hajan \
    && mkdir -p /app /data /home/hajan \
    && chown -R hajan:hajan /app /data /home/hajan

WORKDIR /app

COPY requirements.txt app.py nuvem.py setup_db.py unnamed.png ./
COPY .streamlit/config.toml ./.streamlit/config.toml
COPY docker/entrypoint.sh /usr/local/bin/hajan-entrypoint

RUN chmod 0555 /usr/local/bin/hajan-entrypoint \
    && python -m pip install --upgrade pip \
    && python -m pip install -r requirements.txt

USER hajan
EXPOSE 8501

ENTRYPOINT ["/usr/local/bin/hajan-entrypoint"]
CMD ["streamlit", "run", "app.py", "--server.address=0.0.0.0", "--server.port=8501", "--server.headless=true", "--server.enableCORS=true", "--server.enableXsrfProtection=true", "--server.maxUploadSize=25", "--server.maxMessageSize=100", "--server.fileWatcherType=none", "--client.toolbarMode=minimal", "--runner.magicEnabled=false"]
