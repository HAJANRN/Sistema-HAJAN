import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "emissor": ROOT / "hajan_pedidos.db",
    "expedicao": ROOT.parent / "Acompanhamento de entregas" / "data" / "expedicao.db",
}
BATCH_SIZE = 500
MAX_INDEXED_TEXT_LENGTH = 700


@dataclass(frozen=True)
class Column:
    name: str
    declared_type: str
    not_null: bool
    default: str | None
    primary_key_order: int
    indexed: bool
    max_length: int
    auto_increment: bool


@dataclass(frozen=True)
class Index:
    name: str
    unique: bool
    columns: tuple[str, ...]


@dataclass(frozen=True)
class ForeignKey:
    identifier: int
    target_table: str
    source_columns: tuple[str, ...]
    target_columns: tuple[str, ...]
    on_update: str
    on_delete: str


@dataclass(frozen=True)
class Table:
    source_name: str
    target_name: str
    columns: tuple[Column, ...]
    primary_key: tuple[str, ...]
    indexes: tuple[Index, ...]
    foreign_keys: tuple[ForeignKey, ...]
    source_create_sql: str
    row_count: int


def quote_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_]+", value):
        raise ValueError(f"Identificador SQL inesperado: {value!r}")
    return f"`{value}`"


def source_fingerprint(path: Path) -> tuple[tuple[str, str], ...]:
    result = []
    for suffix in ("", "-wal", "-journal"):
        component = Path(f"{path}{suffix}")
        if not component.is_file():
            continue
        digest = hashlib.sha256()
        with component.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        result.append((suffix, digest.hexdigest()))
    return tuple(result)


def snapshot_source(source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve(strict=True)
    if not source.is_file():
        raise FileNotFoundError(f"Banco de origem não encontrado: {source}")
    before = source_fingerprint(source)
    if not before or before[0][0] != "":
        raise FileNotFoundError(f"Arquivo SQLite não encontrado: {source}")
    if any(suffix == "-journal" for suffix, _ in before):
        raise RuntimeError(
            f"Existe uma transação SQLite ativa para {source}. "
            "Feche a aplicação que o utiliza e tente novamente."
        )

    destination.mkdir(parents=True, exist_ok=True)
    snapshot = destination / source.name
    shutil.copyfile(source, snapshot)
    wal_source = Path(f"{source}-wal")
    if wal_source.is_file():
        shutil.copyfile(wal_source, Path(f"{snapshot}-wal"))

    after = source_fingerprint(source)
    if before != after:
        raise RuntimeError(
            f"O banco de origem mudou durante a cópia ({source}). "
            "Feche a aplicação que o utiliza e tente novamente."
        )
    return snapshot


def readonly_connection(path: Path) -> sqlite3.Connection:
    uri = f"{path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        connection.close()
        raise sqlite3.DatabaseError(f"Snapshot SQLite inválido: {integrity}")
    return connection


def sqlite_tables(connection: sqlite3.Connection, prefix: str) -> list[Table]:
    rows = connection.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    tables = []
    names = {row["name"] for row in rows}

    for row in rows:
        table_name = row["name"]
        create_sql = row["sql"] or ""
        table_identifier = quote_identifier(table_name)
        column_rows = connection.execute(
            f"PRAGMA table_info({table_identifier})"
        ).fetchall()
        index_rows = connection.execute(
            f"PRAGMA index_list({table_identifier})"
        ).fetchall()
        foreign_rows = connection.execute(
            f"PRAGMA foreign_key_list({table_identifier})"
        ).fetchall()

        indexed_names: set[str] = set()
        indexes = []
        for index_row in index_rows:
            index_name = index_row["name"]
            info = connection.execute(
                f"PRAGMA index_info({quote_identifier(index_name)})"
            ).fetchall()
            index_columns = tuple(item["name"] for item in info if item["name"] is not None)
            if len(index_columns) != len(info):
                raise ValueError(
                    f"Índice de expressão não suportado em {table_name}.{index_name}."
                )
            indexed_names.update(index_columns)
            origin = index_row["origin"]
            if origin == "pk":
                continue
            indexes.append(Index(
                name=index_name,
                unique=bool(index_row["unique"]),
                columns=index_columns,
            ))

        grouped_foreign_keys: dict[int, list[sqlite3.Row]] = {}
        for foreign_row in foreign_rows:
            grouped_foreign_keys.setdefault(foreign_row["id"], []).append(foreign_row)
        foreign_keys = []
        for identifier, parts in grouped_foreign_keys.items():
            parts.sort(key=lambda part: part["seq"])
            target_name = parts[0]["table"]
            if target_name not in names:
                raise ValueError(
                    f"Chave estrangeira de {table_name} aponta para tabela ausente {target_name}."
                )
            foreign_keys.append(ForeignKey(
                identifier=identifier,
                target_table=target_name,
                source_columns=tuple(part["from"] for part in parts),
                target_columns=tuple(part["to"] for part in parts),
                on_update=parts[0]["on_update"],
                on_delete=parts[0]["on_delete"],
            ))

        columns = []
        primary_key = []
        for column_row in column_rows:
            name = column_row["name"]
            declared_type = (column_row["type"] or "").upper()
            is_indexed = name in indexed_names or any(
                name in key.source_columns for key in foreign_keys
            )
            max_length = 0
            if declared_type in ("", "TEXT", "VARCHAR", "CHAR", "CLOB"):
                max_length = connection.execute(
                    f"SELECT MAX(LENGTH({quote_identifier(name)})) "
                    f"FROM {table_identifier}"
                ).fetchone()[0] or 0
            pk_order = column_row["pk"]
            if pk_order:
                primary_key.append((pk_order, name))
            columns.append(Column(
                name=name,
                declared_type=declared_type,
                not_null=bool(column_row["notnull"]),
                default=column_row["dflt_value"],
                primary_key_order=pk_order,
                indexed=is_indexed,
                max_length=max_length,
                auto_increment=(
                    pk_order > 0
                    and "AUTOINCREMENT" in create_sql.upper()
                    and declared_type == "INTEGER"
                    and sum(bool(item["pk"]) for item in column_rows) == 1
                ),
            ))

        tables.append(Table(
            source_name=table_name,
            target_name=f"{prefix}_{table_name}",
            columns=tuple(columns),
            primary_key=tuple(name for _, name in sorted(primary_key)),
            indexes=tuple(indexes),
            foreign_keys=tuple(foreign_keys),
            source_create_sql=create_sql,
            row_count=connection.execute(
                f"SELECT COUNT(*) FROM {table_identifier}"
            ).fetchone()[0],
        ))

    return tables


def mysql_column_type(column: Column, lengths: dict[tuple[str, str], int]) -> str:
    declared = column.declared_type
    if declared.startswith(("INT", "INTEGER")):
        return "BIGINT"
    if declared.startswith(("REAL", "FLOAT", "DOUBLE")):
        return "DOUBLE"
    if declared.startswith(("NUMERIC", "DECIMAL")):
        return "DECIMAL(65, 30)"
    if declared.startswith("BLOB"):
        return "LONGBLOB"
    if declared.startswith(("TEXT", "VARCHAR", "CHAR", "CLOB")) or not declared:
        length = lengths[(column.name, column.declared_type)]
        if column.indexed or column.default is not None:
            if length > MAX_INDEXED_TEXT_LENGTH:
                raise ValueError(
                    f"Coluna textual indexada {column.name!r} excede "
                    f"{MAX_INDEXED_TEXT_LENGTH} caracteres; migração interrompida."
                )
            return f"VARCHAR({max(length, 1)}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
        return "LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
    raise ValueError(f"Tipo SQLite não suportado: {column.declared_type!r} ({column.name}).")


def sql_default(value: str | None) -> str:
    if value is None:
        return ""
    text = value.strip()
    if re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        return f" DEFAULT {text}"
    if text.upper() in {"CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"}:
        return f" DEFAULT {text.upper()}"
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        decoded = text[1:-1].replace("''", "'")
        escaped = decoded.replace("\\", "\\\\").replace("'", "''")
        return f" DEFAULT '{escaped}'"
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        decoded = text[1:-1].replace('""', '"')
        escaped = decoded.replace("\\", "\\\\").replace("'", "''")
        return f" DEFAULT '{escaped}'"
    raise ValueError(f"Valor DEFAULT SQLite não suportado: {value!r}.")


def foreign_key_constraint_name(table_name: str, identifier: int) -> str:
    suffix = hashlib.sha1(f"{table_name}:{identifier}".encode()).hexdigest()[:10]
    return f"fk_{table_name[:40]}_{suffix}"[:64]


def table_ddl(table: Table, tables_by_source: dict[str, Table]) -> str:
    lengths: dict[tuple[str, str], int] = {}
    for column in table.columns:
        max_length = column.max_length
        if column.default is not None:
            default_text = column.default.strip()
            if len(default_text) >= 2 and default_text[0] in "'\"" and default_text[-1] == default_text[0]:
                max_length = max(max_length, len(default_text[1:-1]))
        for foreign_key in table.foreign_keys:
            if column.name not in foreign_key.source_columns:
                continue
            position = foreign_key.source_columns.index(column.name)
            target_table = tables_by_source[foreign_key.target_table]
            target_column_name = foreign_key.target_columns[position]
            target_column = next(item for item in target_table.columns if item.name == target_column_name)
            if max_length > target_column.max_length:
                raise ValueError(
                    f"Chave estrangeira {table.source_name}.{column.name} contém "
                    "valores maiores que a chave de destino; verifique a integridade da origem."
                )
            max_length = target_column.max_length
        lengths[(column.name, column.declared_type)] = max_length

    indexes_to_validate = [table.primary_key] + [
        index.columns for index in table.indexes if index.unique
    ]
    for indexed_columns in indexes_to_validate:
        byte_length = sum(
            max(lengths[(name, next(column.declared_type for column in table.columns if column.name == name))], 1) * 4
            for name in indexed_columns
            if next(column for column in table.columns if column.name == name).declared_type
            in ("", "TEXT", "VARCHAR", "CHAR", "CLOB")
        )
        if byte_length > 3000:
            raise ValueError(
                f"Índice textual de {table.source_name} excede o limite seguro do MySQL."
            )

    definitions = []
    for column in table.columns:
        kind = mysql_column_type(column, lengths)
        required = " NOT NULL" if column.not_null or column.primary_key_order else ""
        default = sql_default(column.default)
        auto_increment = " AUTO_INCREMENT" if column.auto_increment else ""
        definitions.append(
            f"{quote_identifier(column.name)} {kind}{required}{default}{auto_increment}"
        )

    if table.primary_key:
        columns_sql = ", ".join(quote_identifier(name) for name in table.primary_key)
        definitions.append(f"PRIMARY KEY ({columns_sql})")

    for index in table.indexes:
        if index.unique:
            columns_sql = ", ".join(quote_identifier(name) for name in index.columns)
            index_name = f"{table.target_name}_{index.name}"[:64]
            definitions.append(f"UNIQUE KEY {quote_identifier(index_name)} ({columns_sql})")

    for foreign_key in table.foreign_keys:
        source_columns = ", ".join(quote_identifier(name) for name in foreign_key.source_columns)
        target_columns = ", ".join(quote_identifier(name) for name in foreign_key.target_columns)
        target_table = tables_by_source[foreign_key.target_table].target_name
        constraint = foreign_key_constraint_name(table.target_name, foreign_key.identifier)
        actions = []
        for label, action in (("ON UPDATE", foreign_key.on_update), ("ON DELETE", foreign_key.on_delete)):
            normalized = action.upper()
            if normalized not in {"NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"}:
                raise ValueError(f"Ação de chave estrangeira não suportada: {action}")
            if normalized != "NO ACTION":
                actions.append(f"{label} {normalized}")
        definitions.append(
            f"CONSTRAINT {quote_identifier(constraint)} FOREIGN KEY ({source_columns}) "
            f"REFERENCES {quote_identifier(target_table)} ({target_columns}) "
            + " ".join(actions)
        )

    return (
        f"CREATE TABLE {quote_identifier(table.target_name)} (\n  "
        + ",\n  ".join(definitions)
        + "\n) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin"
    )


def topological_tables(tables: list[Table]) -> list[Table]:
    remaining = {table.source_name: table for table in tables}
    ordered = []
    while remaining:
        ready = [
            table for table in remaining.values()
            if all(key.target_table not in remaining for key in table.foreign_keys)
        ]
        if not ready:
            raise ValueError("Ciclo de chaves estrangeiras não suportado na migração.")
        ready.sort(key=lambda table: table.source_name)
        for table in ready:
            ordered.append(table)
            del remaining[table.source_name]
    return ordered


def json_safe(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"bytes_sha256": hashlib.sha256(value).hexdigest(), "length": len(value)}
    if isinstance(value, float) and not (float("-inf") < value < float("inf")):
        return {"float": repr(value)}
    return value


def row_digest(values: tuple[Any, ...] | list[Any]) -> str:
    normalized = [json_safe(value) for value in values]
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def multiset_digest(digests: list[str]) -> str:
    digest = hashlib.sha256()
    for value in sorted(digests):
        digest.update(value.encode("ascii"))
    return digest.hexdigest()


def table_indexes(cursor, table: Table):
    for index in table.indexes:
        if index.unique:
            continue
        columns_sql = ", ".join(quote_identifier(name) for name in index.columns)
        index_name = f"{table.target_name}_{index.name}"[:64]
        cursor.execute(
            f"CREATE INDEX {quote_identifier(index_name)} "
            f"ON {quote_identifier(table.target_name)} ({columns_sql})"
        )


def source_order(table: Table) -> str:
    if not table.primary_key:
        return ""
    return " ORDER BY " + ", ".join(quote_identifier(name) for name in table.primary_key)


def migration_plan(connection: sqlite3.Connection, prefix: str) -> list[Table]:
    tables = sqlite_tables(connection, prefix)
    if not tables:
        raise ValueError(f"Nenhuma tabela SQLite encontrada para prefixo {prefix}.")
    by_name = {table.source_name: table for table in tables}
    return topological_tables(list(by_name.values()))


def connect_mysql():
    required = ("MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError(
            "Defina as variáveis MySQL no ambiente local: " + ", ".join(missing)
            + ". Não envie a senha pelo chat."
        )

    host = os.environ["MYSQL_HOST"]
    port = int(os.environ.get("MYSQL_PORT", "3306"))
    kwargs = {
        "host": host,
        "port": port,
        "database": os.environ["MYSQL_DATABASE"],
        "user": os.environ["MYSQL_USER"],
        "password": os.environ["MYSQL_PASSWORD"],
        "connection_timeout": 20,
        "autocommit": False,
    }
    ca_file = os.environ.get("MYSQL_SSL_CA")
    if ca_file:
        ca_path = Path(ca_file).expanduser().resolve(strict=True)
        kwargs.update(
            ssl_ca=str(ca_path),
            ssl_verify_cert=True,
            ssl_verify_identity=True,
        )
    elif host.casefold() not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError(
            "Para conexão remota, configure MYSQL_SSL_CA com o certificado CA do provedor "
            "para validar o TLS."
        )

    import mysql.connector
    return mysql.connector.connect(**kwargs)


def migrate_source(
    source_connection: sqlite3.Connection,
    mysql_connection,
    prefix: str,
) -> list[dict[str, Any]]:
    tables = migration_plan(source_connection, prefix)
    by_source_name = {table.source_name: table for table in tables}
    mysql_cursor = mysql_connection.cursor()
    try:
        target_names = [table.target_name for table in tables]
        placeholders = ", ".join(["%s"] * len(target_names))
        mysql_cursor.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name IN (" + placeholders + ")",
            target_names,
        )
        existing = [row[0] for row in mysql_cursor.fetchall()]
        if existing:
            raise RuntimeError(
                "A migração não sobrescreve tabelas MySQL existentes. "
                f"Conflitos com o prefixo {prefix}: {', '.join(existing)}."
            )

        for table in tables:
            mysql_cursor.execute(table_ddl(table, by_source_name))
            mysql_connection.commit()

        report = []
        for table in tables:
            columns = [column.name for column in table.columns]
            columns_sql = ", ".join(quote_identifier(name) for name in columns)
            target_sql = quote_identifier(table.target_name)
            insert_sql = (
                f"INSERT INTO {target_sql} ({columns_sql}) VALUES ("
                + ", ".join(["%s"] * len(columns))
                + ")"
            )
            select_sql = (
                f"SELECT {columns_sql} FROM {quote_identifier(table.source_name)}"
                + source_order(table)
            )

            source_digests = []
            copied = 0
            source_cursor = source_connection.execute(select_sql)
            while True:
                rows = source_cursor.fetchmany(BATCH_SIZE)
                if not rows:
                    break
                source_digests.extend(row_digest(tuple(row)) for row in rows)
                mysql_cursor.executemany(insert_sql, [tuple(row) for row in rows])
                copied += len(rows)
            mysql_connection.commit()

            mysql_cursor.execute(f"SELECT COUNT(*) FROM {target_sql}")
            target_count = mysql_cursor.fetchone()[0]
            target_order = source_order(table)
            mysql_cursor.execute(
                f"SELECT {columns_sql} FROM {target_sql}{target_order}"
            )
            target_digests = []
            while True:
                rows = mysql_cursor.fetchmany(BATCH_SIZE)
                if not rows:
                    break
                target_digests.extend(row_digest(tuple(row)) for row in rows)
            source_hash = multiset_digest(source_digests)
            target_hash = multiset_digest(target_digests)
            if copied != table.row_count or target_count != table.row_count or source_hash != target_hash:
                raise RuntimeError(
                    f"Validação falhou em {table.source_name}: origem={table.row_count}, "
                    f"copiado={copied}, destino={target_count}, checksum divergente."
                )
            report.append({
                "tabela_origem": table.source_name,
                "tabela_destino": table.target_name,
                "registros": target_count,
                "checksum_validado": True,
            })

        for table in tables:
            table_indexes(mysql_cursor, table)
        mysql_connection.commit()
        return report
    except Exception:
        mysql_connection.rollback()
        raise
    finally:
        mysql_cursor.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Copia os dois SQLite para MySQL em tabelas isoladas, sem escrever "
            "nos bancos originais."
        )
    )
    parser.add_argument("--emissor-db", type=Path, default=SOURCES["emissor"])
    parser.add_argument("--expedicao-db", type=Path, default=SOURCES["expedicao"])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="valida snapshots e imprime tabelas/contagens sem conectar ao MySQL",
    )
    arguments = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="hajan-mysql-migration-") as temporary_dir:
        temporary_root = Path(temporary_dir)
        snapshots = {
            "emissor": snapshot_source(arguments.emissor_db, temporary_root / "emissor"),
            "expedicao": snapshot_source(arguments.expedicao_db, temporary_root / "expedicao"),
        }
        source_connections = {}
        mysql_connection = None
        try:
            for name, snapshot in snapshots.items():
                connection = readonly_connection(snapshot)
                source_connections[name] = connection

            if arguments.dry_run:
                report = {}
                for name, connection in source_connections.items():
                    tables = sqlite_tables(connection, name)
                    report[name] = [
                        {"table": table.source_name, "rows": table.row_count}
                        for table in tables
                    ]
                print(json.dumps({"dry_run": True, "sources": report}, ensure_ascii=False, indent=2))
                return

            mysql_connection = connect_mysql()
            destination_database = mysql_connection.database
            results = {}
            for name, connection in source_connections.items():
                results[name] = migrate_source(connection, mysql_connection, name)
            print(json.dumps({
                "status": "copied_and_validated",
                "mysql_database": destination_database,
                "sources": results,
                "source_files_modified": False,
            }, ensure_ascii=False, indent=2))
        finally:
            for connection in source_connections.values():
                connection.close()
            if mysql_connection is not None:
                mysql_connection.close()


if __name__ == "__main__":
    main()
