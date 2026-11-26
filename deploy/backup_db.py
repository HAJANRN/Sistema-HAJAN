import argparse
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


def create_read_only_backup(source: Path, destination: Path) -> None:
    source = source.expanduser().resolve(strict=True)
    destination = destination.expanduser().resolve()
    if source == destination:
        raise ValueError("O arquivo de destino deve ser diferente do banco original.")
    if not source.is_file():
        raise FileNotFoundError(f"Banco original não encontrado: {source}")
    if destination.exists():
        raise FileExistsError(f"O destino já existe; nada foi sobrescrito: {destination}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with tempfile.TemporaryDirectory(prefix="hajan-sqlite-stage-") as stage_name:
            staged_database = Path(stage_name) / source.name
            for suffix in ("", "-wal"):
                component = Path(f"{source}{suffix}")
                if component.is_file():
                    shutil.copyfile(component, Path(f"{staged_database}{suffix}"))
            with closing(sqlite3.connect(
                f"{staged_database.as_uri()}?mode=ro",
                uri=True,
            )) as original:
                with closing(sqlite3.connect(temporary)) as copy:
                    original.backup(copy)
                    result = copy.execute("PRAGMA integrity_check").fetchone()
                    if not result or result[0] != "ok":
                        raise sqlite3.DatabaseError(f"Integridade do backup falhou: {result}")
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cria um backup consistente do SQLite sem alterar o banco original."
    )
    parser.add_argument("source", type=Path, help="caminho do banco original")
    parser.add_argument("destination", type=Path, help="novo caminho para a cópia")
    arguments = parser.parse_args()
    create_read_only_backup(arguments.source, arguments.destination)
    print(f"Backup verificado criado em: {arguments.destination.resolve()}")


if __name__ == "__main__":
    main()
