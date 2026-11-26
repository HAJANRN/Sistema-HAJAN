import ctypes
import html
import io
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
EXCEL_PATH = BASE_DIR / "Infos Clientes.xlsx"
PRODUCTS_EXCEL_PATH = BASE_DIR / "Infos Produtos.xlsx"
LIMITS_EXCEL_PATH = BASE_DIR / "CARTEIRA DE TERCEIRO - DIVISÃO 1.xlsx"
UNITS_EXCEL_PATH = BASE_DIR / "Infos Unidades.xlsx"
DATABASE_PATH = BASE_DIR / "hajan_pedidos.db"
SHEET_NAME = "Infos Clientes"
PRODUCTS_SHEET_NAME = "Infos Produtos"
UNITS_SHEET_NAME = "SiglasUnidades"
REQUIRED_COLUMNS = {
    "CÓDIGO",
    "RAZÃO SOCIAL PEDIDO + CÓDIGO",
    "CNPJ",
    "PRAZO",
    "CIDADE ",
    "UF",
    "OBS CLIENTES PED+",
    "CÓDIGO CENTRA- LIZADOR",
}
REQUIRED_PRODUCT_COLUMNS = {
    "Código",
    "Produto Frigorífico",
    "Produto Pedido",
    "Unidade",
    "Peso",
    "Produto Frigorífico (Completo)",
    "Estado Físico (Grupo)",
    "F/S/A",
    "Linha (Marca)",
    "Categoria (Divisão)",
}
REQUIRED_LIMIT_COLUMNS = {
    "Código",
    "Nome",
    "Limite",
    "Saldo de Crédito",
}
LIMIT_COLUMN_ALIASES = {
    "Código": ("Código", "CÓDIGO CENTRALIZADOR"),
    "Nome": ("Nome", "CENTRALIZADOR"),
    "Limite": ("Limite", "LIMITE"),
    "Saldo de Crédito": ("Saldo de Crédito", "DISPONÍVEL"),
}
REQUIRED_UNIT_COLUMNS = {"SIGLA", "NOME", "CRITICA"}
XLSX_MAX_BYTES = 25 * 1024 * 1024
XLSX_MAX_EXPANDED_BYTES = 100 * 1024 * 1024
XLSX_MAX_ENTRIES = 1000
XLSX_MAX_COMPRESSION_RATIO = 200


def validar_arquivo_xlsx(conteudo):
    if not isinstance(conteudo, (bytes, bytearray)) or not conteudo:
        raise ValueError("O arquivo Excel está vazio ou inválido.")
    if len(conteudo) > XLSX_MAX_BYTES:
        raise ValueError("O arquivo Excel excede o limite de 25 MB.")

    try:
        with zipfile.ZipFile(io.BytesIO(conteudo)) as arquivo:
            entradas = arquivo.infolist()
            nomes = {entrada.filename for entrada in entradas}
            if len(entradas) > XLSX_MAX_ENTRIES:
                raise ValueError("O arquivo Excel contém componentes demais.")
            if not {"[Content_Types].xml", "xl/workbook.xml"}.issubset(nomes):
                raise ValueError("O arquivo enviado não é uma planilha XLSX válida.")
            if "xl/vbaProject.bin" in nomes:
                raise ValueError("Planilhas com macros não são aceitas.")

            tamanho_expandido = 0
            for entrada in entradas:
                if entrada.flag_bits & 0x1:
                    raise ValueError("Planilhas criptografadas não são aceitas.")
                tamanho_expandido += entrada.file_size
                if tamanho_expandido > XLSX_MAX_EXPANDED_BYTES:
                    raise ValueError("O conteúdo expandido da planilha excede 100 MB.")
                razao = entrada.file_size / max(entrada.compress_size, 1)
                if razao > XLSX_MAX_COMPRESSION_RATIO:
                    raise ValueError("A planilha possui uma taxa de compactação não permitida.")

            if arquivo.testzip():
                raise ValueError("O arquivo Excel está corrompido.")
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError) as erro:
        raise ValueError("O arquivo enviado não é um XLSX válido ou está corrompido.") from erro


def validar_arquivo_xlsx_local(caminho):
    caminho = Path(caminho)
    if caminho.stat().st_size > XLSX_MAX_BYTES:
        raise ValueError("O arquivo Excel excede o limite de 25 MB.")
    validar_arquivo_xlsx(caminho.read_bytes())


@contextmanager
def conexao_sqlite(caminho):
    conn = sqlite3.connect(caminho)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


_SID_USUARIO_ATUAL = None


def _sid_usuario_atual():
    global _SID_USUARIO_ATUAL
    if _SID_USUARIO_ATUAL is None:
        try:
            saida = subprocess.run(
                ["whoami", "/user", "/fo", "csv", "/nh"],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            ).stdout.strip()
            _SID_USUARIO_ATUAL = saida.split(",")[-1].strip().strip('"')
        except (OSError, subprocess.SubprocessError):
            _SID_USUARIO_ATUAL = ""
    return _SID_USUARIO_ATUAL


def _disco_local(caminho):
    unidade = os.path.splitdrive(str(caminho))[0]
    if not unidade:
        return False
    try:
        return ctypes.windll.kernel32.GetDriveTypeW(f"{unidade}\\") == 3
    except (AttributeError, OSError):
        return False


def proteger_arquivo_sensivel(caminho):
    if os.name != "nt":
        return
    caminho = Path(caminho)
    if not _disco_local(caminho) or not caminho.is_file():
        # Em compartilhamento o SID local não é mapeado pelo servidor e a ACL restrita corta o próprio acesso.
        return
    sid = _sid_usuario_atual()
    if not sid:
        return
    try:
        subprocess.run(
            [
                "icacls",
                str(caminho),
                "/grant:r",
                f"*{sid}:F",
                "*S-1-5-18:F",
                "*S-1-5-32-544:F",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        subprocess.run(
            ["icacls", str(caminho), "/inheritance:r"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        logging.getLogger(__name__).exception(
            "Não foi possível restringir o ACL de %s", caminho
        )


def normalizar_valor(valor):
    if pd.isna(valor):
        return ""
    if isinstance(valor, (int, float)) and float(valor).is_integer():
        return str(int(valor))
    return html.unescape(str(valor)).strip()


def importar_clientes(caminho_excel=EXCEL_PATH, caminho_banco=DATABASE_PATH):
    caminho_excel = Path(caminho_excel)
    caminho_banco = Path(caminho_banco)
    if not caminho_excel.is_file():
        raise FileNotFoundError(f"Planilha não encontrada: {caminho_excel}")
    validar_arquivo_xlsx_local(caminho_excel)

    df = pd.read_excel(caminho_excel, sheet_name=SHEET_NAME)
    colunas_ausentes = REQUIRED_COLUMNS.difference(df.columns)
    if colunas_ausentes:
        nomes = ", ".join(sorted(colunas_ausentes))
        raise ValueError(f"Colunas obrigatórias ausentes na planilha: {nomes}")

    clientes = pd.DataFrame({
        "codigo": df["CÓDIGO"].map(normalizar_valor),
        "nome_formatado": df["RAZÃO SOCIAL PEDIDO + CÓDIGO"].map(normalizar_valor),
        "cnpj": df["CNPJ"].map(normalizar_valor),
        "prazo_padrao": df["PRAZO"].map(normalizar_valor),
        "cidade": df["CIDADE "].map(normalizar_valor),
        "uf": df["UF"].map(normalizar_valor),
        "observacao": df["OBS CLIENTES PED+"].map(normalizar_valor),
        "status_cliente": (
            df["Status do Cliente"].map(normalizar_valor)
            if "Status do Cliente" in df.columns
            else ""
        ),
        "codigo_centralizador": df["CÓDIGO CENTRA- LIZADOR"].map(normalizar_valor),
    })
    clientes = clientes[
        clientes["codigo"].ne("") & clientes["nome_formatado"].ne("")
    ]
    # Código 0 identifica destinos sem cadastro próprio (escritórios/representantes);
    # cada nome é um cliente distinto e não pode ser colapsado pelo código.
    sem_codigo = clientes["codigo"].eq("0")
    clientes = pd.concat(
        [
            clientes[~sem_codigo].drop_duplicates(subset="codigo", keep="last"),
            clientes[sem_codigo].drop_duplicates(
                subset=["codigo", "nome_formatado"], keep="last"
            ),
        ],
        ignore_index=True,
    )

    caminho_banco.parent.mkdir(parents=True, exist_ok=True)
    with conexao_sqlite(caminho_banco) as conn:
        clientes.to_sql("clientes", conn, if_exists="replace", index=False)
        conn.execute(
            "CREATE INDEX idx_clientes_nome_formatado "
            "ON clientes (nome_formatado COLLATE NOCASE)"
        )

    return len(clientes)


def importar_produtos(caminho_excel=PRODUCTS_EXCEL_PATH, caminho_banco=DATABASE_PATH):
    caminho_excel = Path(caminho_excel)
    caminho_banco = Path(caminho_banco)
    if not caminho_excel.is_file():
        raise FileNotFoundError(f"Planilha de produtos não encontrada: {caminho_excel}")
    validar_arquivo_xlsx_local(caminho_excel)

    df = pd.read_excel(caminho_excel, sheet_name=PRODUCTS_SHEET_NAME)
    colunas_ausentes = REQUIRED_PRODUCT_COLUMNS.difference(df.columns)
    if colunas_ausentes:
        nomes = ", ".join(sorted(colunas_ausentes))
        raise ValueError(f"Colunas obrigatórias ausentes na planilha de produtos: {nomes}")

    catalogo = pd.DataFrame({
        "codigo": df["Código"].map(normalizar_valor),
        "descricao": df["Produto Frigorífico"].map(normalizar_valor),
        "produto_pedido": df["Produto Pedido"].map(normalizar_valor),
        "unidade": df["Unidade"].map(normalizar_valor),
        "peso": pd.to_numeric(df["Peso"], errors="coerce").fillna(1.0),
        "descricao_completa": df["Produto Frigorífico (Completo)"].map(normalizar_valor),
        "estado_fisico": df["Estado Físico (Grupo)"].map(normalizar_valor),
        "f_s_a": df["F/S/A"].map(normalizar_valor),
        "linha_marca": df["Linha (Marca)"].map(normalizar_valor),
        "categoria": df["Categoria (Divisão)"].map(normalizar_valor),
    })
    catalogo = catalogo[
        catalogo["codigo"].ne("") & catalogo["descricao"].ne("")
    ].drop_duplicates(subset=["codigo", "descricao"], keep="last")

    caminho_banco.parent.mkdir(parents=True, exist_ok=True)
    with conexao_sqlite(caminho_banco) as conn:
        catalogo.to_sql("produtos", conn, if_exists="replace", index=False)
        conn.execute(
            "CREATE UNIQUE INDEX idx_produtos_codigo_descricao "
            "ON produtos (codigo, descricao)"
        )
        conn.execute("CREATE INDEX idx_produtos_codigo ON produtos (codigo)")
        conn.execute(
            "CREATE INDEX idx_produtos_descricao "
            "ON produtos (descricao COLLATE NOCASE)"
        )

    return len(catalogo)


def _colunas_equivalentes_limites(df):
    equivalentes = {}
    for destino, alternativas in LIMIT_COLUMN_ALIASES.items():
        if destino in df.columns:
            continue
        nome = next((nome for nome in alternativas if nome in df.columns), None)
        if nome:
            equivalentes[nome] = destino
    return equivalentes


def importar_limites(caminho_excel=LIMITS_EXCEL_PATH, caminho_banco=DATABASE_PATH):
    caminho_excel = Path(caminho_excel)
    caminho_banco = Path(caminho_banco)
    if not caminho_excel.is_file():
        raise FileNotFoundError(f"Planilha de limites não encontrada: {caminho_excel}")
    validar_arquivo_xlsx_local(caminho_excel)

    df = pd.read_excel(caminho_excel, sheet_name=0)
    colunas_equivalentes = _colunas_equivalentes_limites(df)
    if not REQUIRED_LIMIT_COLUMNS.issubset(df.rename(columns=colunas_equivalentes).columns):
        df = pd.read_excel(caminho_excel, sheet_name=0, header=1)
        colunas_equivalentes = _colunas_equivalentes_limites(df)
    # O layout "Infos Limite Disponível" lista só centralizadores ativos: mescla em vez de substituir tudo.
    mesclar = "Código" not in df.columns and "CÓDIGO CENTRALIZADOR" in df.columns
    df = df.rename(columns=colunas_equivalentes)
    colunas_ausentes = REQUIRED_LIMIT_COLUMNS.difference(df.columns)
    if colunas_ausentes:
        nomes = ", ".join(sorted(colunas_ausentes))
        raise ValueError(f"Colunas obrigatórias ausentes na planilha de limites: {nomes}")

    limites = pd.DataFrame({
        "codigo_centralizador": df["Código"].map(normalizar_valor),
        "centralizador": df["Nome"].map(normalizar_valor),
        "limite": pd.to_numeric(df["Limite"], errors="coerce"),
        "disponivel": pd.to_numeric(df["Saldo de Crédito"], errors="coerce"),
    })
    limites = limites[limites["codigo_centralizador"].ne("")].drop_duplicates(
        subset="codigo_centralizador", keep="last"
    )

    caminho_banco.parent.mkdir(parents=True, exist_ok=True)
    with conexao_sqlite(caminho_banco) as conn:
        if mesclar and conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'limites_clientes'"
        ).fetchone():
            existentes = pd.read_sql(
                "SELECT codigo_centralizador, centralizador, limite, disponivel "
                "FROM limites_clientes",
                conn,
            )
            limites = pd.concat([existentes, limites], ignore_index=True).drop_duplicates(
                subset="codigo_centralizador", keep="last"
            )
        limites.to_sql("limites_clientes", conn, if_exists="replace", index=False)
        conn.execute(
            "CREATE UNIQUE INDEX idx_limites_codigo_centralizador "
            "ON limites_clientes (codigo_centralizador)"
        )

    return len(limites)


def importar_unidades(caminho_excel=UNITS_EXCEL_PATH, caminho_banco=DATABASE_PATH):
    caminho_excel = Path(caminho_excel)
    caminho_banco = Path(caminho_banco)
    if not caminho_excel.is_file():
        raise FileNotFoundError(f"Planilha de unidades não encontrada: {caminho_excel}")
    validar_arquivo_xlsx_local(caminho_excel)

    df = pd.read_excel(caminho_excel, sheet_name=UNITS_SHEET_NAME)
    colunas_ausentes = REQUIRED_UNIT_COLUMNS.difference(df.columns)
    if colunas_ausentes:
        nomes = ", ".join(sorted(colunas_ausentes))
        raise ValueError(f"Colunas obrigatórias ausentes na planilha de unidades: {nomes}")

    unidades = pd.DataFrame({
        "sigla": df["SIGLA"].map(normalizar_valor).str.upper(),
        "nome": df["NOME"].map(normalizar_valor),
        "critica": df["CRITICA"].map(normalizar_valor).str.upper(),
    })
    unidades = unidades[
        unidades["sigla"].ne("") & unidades["nome"].ne("")
    ].drop_duplicates(subset="sigla", keep="last")

    caminho_banco.parent.mkdir(parents=True, exist_ok=True)
    with conexao_sqlite(caminho_banco) as conn:
        unidades.to_sql("unidades_carregamento", conn, if_exists="replace", index=False)
        conn.execute(
            "CREATE UNIQUE INDEX idx_unidades_carregamento_sigla "
            "ON unidades_carregamento (sigla)"
        )

    return len(unidades)


def atualizar_banco_com_planilhas(arquivos, caminho_banco=DATABASE_PATH):
    caminho_banco = Path(caminho_banco).resolve()
    importadores = {
        "clientes": importar_clientes,
        "produtos": importar_produtos,
        "limites": importar_limites,
        "unidades": importar_unidades,
    }
    desconhecidos = set(arquivos) - set(importadores)
    if desconhecidos:
        raise ValueError(f"Tipo de planilha desconhecido: {', '.join(sorted(desconhecidos))}")

    arquivos_selecionados = {
        tipo: arquivo for tipo, arquivo in arquivos.items() if arquivo is not None
    }
    if not arquivos_selecionados:
        raise ValueError("Selecione ao menos uma planilha para atualizar.")
    if not caminho_banco.is_file() and set(arquivos_selecionados) != set(importadores):
        raise ValueError("Sem banco existente, envie as quatro planilhas para iniciar os dados.")

    caminho_banco.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".hajan_atualizacao_",
        dir=caminho_banco.parent,
    ) as diretorio_temporario:
        pasta_temporaria = Path(diretorio_temporario)
        banco_temporario = pasta_temporaria / caminho_banco.name
        if caminho_banco.is_file():
            shutil.copy2(caminho_banco, banco_temporario)

        quantidades = {}
        for tipo, (nome_arquivo, conteudo) in arquivos_selecionados.items():
            if not nome_arquivo.lower().endswith(".xlsx"):
                raise ValueError(f"O arquivo de {tipo} precisa estar no formato .xlsx.")
            planilha_temporaria = pasta_temporaria / f"{tipo}.xlsx"
            planilha_temporaria.write_bytes(conteudo)
            quantidade = importadores[tipo](planilha_temporaria, banco_temporario)
            if quantidade < 1:
                raise ValueError(f"A planilha de {tipo} não contém registros válidos.")
            quantidades[tipo] = quantidade

        with conexao_sqlite(banco_temporario) as conn:
            integridade = conn.execute("PRAGMA quick_check").fetchone()[0]
            tabelas = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            obrigatorias = {
                "clientes",
                "produtos",
                "limites_clientes",
                "unidades_carregamento",
            }
            if integridade != "ok" or not obrigatorias.issubset(tabelas):
                raise sqlite3.DatabaseError("A validação do banco atualizado falhou.")

        backup = None
        if caminho_banco.is_file():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            backup = caminho_banco.with_name(
                f"{caminho_banco.name}.backup-{timestamp}"
            )
            shutil.copy2(caminho_banco, backup)
            proteger_arquivo_sensivel(backup)
        os.replace(banco_temporario, caminho_banco)
        proteger_arquivo_sensivel(caminho_banco)

    return quantidades, backup


if __name__ == "__main__":
    try:
        quantidade_clientes = importar_clientes()
        quantidade_produtos = importar_produtos()
        quantidade_limites = importar_limites()
        quantidade_unidades = importar_unidades()
        proteger_arquivo_sensivel(DATABASE_PATH)
    except (FileNotFoundError, ValueError, KeyError) as erro:
        raise SystemExit(f"Erro ao importar clientes: {erro}") from erro
    print(
        f"Base atualizada em {DATABASE_PATH}. "
        f"Clientes importados: {quantidade_clientes}. "
        f"Produtos importados: {quantidade_produtos}. "
        f"Limites importados: {quantidade_limites}. "
        f"Unidades de carregamento importadas: {quantidade_unidades}."
    )
