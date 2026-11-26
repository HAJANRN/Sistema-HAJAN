#!/bin/sh
set -eu

: "${HAJAN_DATA_DIR:=/data}"
: "${HAJAN_DATABASE_PATH:=$HAJAN_DATA_DIR/hajan_pedidos.db}"
: "${HAJAN_EXPORT_DIR:=$HAJAN_DATA_DIR/exports}"
: "${HAJAN_LOG_DIR:=$HAJAN_DATA_DIR/logs}"
export HAJAN_DATA_DIR HAJAN_DATABASE_PATH HAJAN_EXPORT_DIR HAJAN_LOG_DIR

if [ -z "${FRIBOI_USUARIO:-}" ] || [ ! -s "${FRIBOI_SENHA_ARQUIVO:-}" ]; then
    echo "Configure FRIBOI_USUARIO e monte o hash compartilhado em FRIBOI_SENHA_ARQUIVO." >&2
    exit 1
fi

if ! python -c 'import pathlib, sys; raise SystemExit(0 if pathlib.Path(sys.argv[1]).read_bytes().startswith(b"scrypt$") else 1)' "$FRIBOI_SENHA_ARQUIVO"; then
    echo "O segredo montado não tem o formato scrypt esperado; use senha-admin.txt do escritório." >&2
    exit 1
fi

if [ ! -s "$HAJAN_DATABASE_PATH" ]; then
    echo "Banco persistente não encontrado em $HAJAN_DATABASE_PATH." >&2
    echo "Copie uma cópia validada de hajan_pedidos.db para o volume /data antes do primeiro início." >&2
    exit 1
fi

python -c '
import sqlite3, sys
path = sys.argv[1]
with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
    integrity = db.execute("PRAGMA integrity_check").fetchone()
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = ?", ("table",))}
required = {"clientes", "produtos", "unidades_carregamento"}
missing = sorted(required - tables)
if not integrity or integrity[0] != "ok" or missing:
    print(f"Banco inválido ou incompleto: integrity={integrity}, tabelas ausentes={missing}", file=sys.stderr)
    raise SystemExit(1)
' "$HAJAN_DATABASE_PATH"

mkdir -p "$HAJAN_EXPORT_DIR" "$HAJAN_LOG_DIR"
if [ ! -w "$HAJAN_DATABASE_PATH" ] || [ ! -w "$HAJAN_EXPORT_DIR" ]; then
    echo "O usuário do container não tem permissão de escrita no volume persistente." >&2
    exit 1
fi

exec "$@"
