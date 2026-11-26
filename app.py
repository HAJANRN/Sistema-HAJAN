import copy
import ctypes
import gc
import hashlib
import hmac
import json
import logging
import os
import re
import time
import unicodedata
import zlib
import streamlit as st
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from functools import lru_cache
from io import BytesIO
from logging.handlers import RotatingFileHandler
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

# fpdf, openpyxl e streamlit_sortables são importados sob demanda dentro das
# funções que os usam, para não pagar o custo deles na abertura do app.

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("HAJAN_DATA_DIR", APP_DIR)).expanduser()
DATABASE_PATH = Path(
    os.environ.get("HAJAN_DATABASE_PATH", DATA_DIR / "hajan_pedidos.db")
).expanduser()
EXPORT_DIR = (
    Path(os.environ["HAJAN_EXPORT_DIR"]).expanduser()
    if os.environ.get("HAJAN_EXPORT_DIR")
    else None
)
ARQUIVO_SENHA_COMPARTILHADA = Path(
    os.environ.get(
        "FRIBOI_SENHA_ARQUIVO",
        APP_DIR.parent
        / "Acompanhamento de entregas"
        / "data"
        / "senha-admin.txt",
    )
)
LOGO_PATH = APP_DIR / "unnamed.png"
PASTA_PDFS = (
    Path(os.environ.get("HAJAN_PDF_DIR", EXPORT_DIR / "pdf"))
    if EXPORT_DIR
    else Path(r"D:\Dados Hajan\pedidos fornecedores\FRIBOI e SEARA\Pedidos\FRIBOI\Pedidos Ped+")
)
# Segundo destino dos PDFs: pasta de rede, para quem usa o emissor pela rede
# conseguir abrir o arquivo sem depender do disco da máquina que gerou.
PASTA_PDFS_REDE = (
    Path(os.environ.get("HAJAN_PDF_SHARED_DIR", EXPORT_DIR / "pdf"))
    if EXPORT_DIR
    else Path(r"S:\FRIBOI\zzz Gestão Pedidos\Pedidos Ped+")
)
PASTAS_PDFS = tuple(dict.fromkeys((PASTA_PDFS, PASTA_PDFS_REDE)))
# Índice de clonagem na pasta compartilhada: um .json por pedido, ao lado dos
# PDFs, para qualquer máquina clonar pedidos gerados em outra instância.
PASTA_CLONES_REDE = Path(
    os.environ.get(
        "HAJAN_CLONES_DIR",
        EXPORT_DIR / "clones" if EXPORT_DIR else PASTA_PDFS_REDE / "_clone_data",
    )
)
PASTAS_RESUMO_EXCEL = (
    {
        "CXS": Path(os.environ.get("HAJAN_RESUMO_CXS_DIR", EXPORT_DIR / "resumos" / "CXS")),
        "PÇS": Path(os.environ.get("HAJAN_RESUMO_PCS_DIR", EXPORT_DIR / "resumos" / "PCS")),
    }
    if EXPORT_DIR
    else {
        "CXS": Path(r"S:\FRIBOI\zzz Gestão Pedidos\@ Acompanhamento Pedido CXS"),
        "PÇS": Path(r"S:\FRIBOI\zzz Gestão Pedidos\@@ ResumoSemanal PÇS"),
    }
)
PASTA_CHQ = (
    Path(os.environ.get("HAJAN_CHQ_DIR", EXPORT_DIR / "CHQ"))
    if EXPORT_DIR
    else Path(r"S:\FRIBOI\Pedidos\CHQ")
)
PASTA_SPG_ANOTACOES = (
    Path(os.environ.get("HAJAN_SPG_ANOTACOES_DIR", EXPORT_DIR / "SPG"))
    if EXPORT_DIR
    else Path(r"S:\FRIBOI\zzz Gestão Pedidos\@ Acompanhamento Pedido CXS")
)
PASTA_SPG_FATURAMENTO = (
    Path(os.environ.get("HAJAN_SPG_FATURAMENTO_DIR", EXPORT_DIR / "SPG-Faturamento"))
    if EXPORT_DIR
    else Path(r"S:\FRIBOI\zzz Gestão Pedidos\Texto Dados Faturamento")
)
# Carteira de Terceiro: as divisões exportadas no mesmo dia repetem o registro
# consolidado; a mais recente é a fonte dos limites e saldos do pedido.
PASTA_CARTEIRA_CREDITO = Path(
    os.environ.get(
        "FRIBOI_CARTEIRA_DIR",
        Path(r"S:\FRIBOI\financeiro\carteira clientes"),
    )
).expanduser()
# Média mensal de compras (6 meses) calculada pela análise de crédito; quando
# o arquivo não existe, a regra de atenção é apenas omitida.
ARQUIVOS_MEDIA_COMPRAS = tuple(
    caminho
    for caminho in (
        Path(os.environ["FRIBOI_CREDITO_JSON"])
        if os.environ.get("FRIBOI_CREDITO_JSON")
        else None,
        APP_DIR / "credito" / "decisao_credito.json",
        Path(
            r"C:\Users\Trabalho2024\Documents\Qoder\2026-10-31\9097f397"
            r"\credito\decisao_credito.json"
        ),
    )
    if caminho is not None
)
LOGO_CHQ_B64 = (
    "R0lGODlhlgA6AHAAACwAAAAAlgA6AIf//////v7++Pj++vr87u386+r98/P86Of42tn65OP99fT//f387Ov40M71w8H++Pf99/b3xsT0trP2yMb77Ov98O/xoJzxpqP63tzykY30vbv98vL4xcLxh4PxgHv64uLsbmnzsa7++vnsXlj3tbL+///76enrSkPwm5jpT0j0urf8+PjwNS3qamT65uX9+vn4NCvoVlD2y8nmQTn40tD+LCPrenXrcm3mOzTlRT7vl5P0KyPvKSDsf3v5+fr29vj5+vvqMCj3Jh3sKyLwIxrz9Pb9/f3y8vX0+/zkhYHsKCDvJh375uX5ycf1xcP419b41NL5zsz87ez+/v7529r52df+9fX74N/sKiHmIRn+/f7m8vLbenboIhnlXljsiobrhYHnc27kV1HiODDnLCTlLibfQTnnZmDpfHf63dvhRkDlLCTaLSfkMSnlMCjrNCzhLibfMSreOjLjWlTujor99vXsd3HiTUbnb2rlU03eNS7nMiniIRny09Li5eno6e38/PzciIbfIBfzrqveIxvbJBzdIhrnJRzdJBziIxv2vrzrLSTqJBvgIxvjJBzrJx/rLib8+/v84uH+9/blJBvgIBfe0NH7+/z19ff6+fnb6ernuLbpKB/cIRnaJR3oJh3sgn3hJBzoW1XZJR3rJh3cIxvcGA/Z3uD7+/vS2Njy7e3fSkTZIxzla2XfJBvhGxPOzc3skY3rKCDrKyLuLSTxKCDpLSX7qqbhMyzlNS3n1dTZ39/U09Pg5OTf3t7o5+fGxcXvKyLHycnw8PC9vLzu7u7pYlziIhn92de/vr7hT0naIxu8u7vq6uq7urrc29v42dfzqqbjKiH4wr/Ew8O3trbjMCiysbHi4eH5+fnz8/O5uLiwr6/19PStrKyqqanoJR3sZmD+9vXAv7+zsrK6ubnW1tbQz8+0s7PnMCi2tbW4t7fwp6XxLyfKycnhIRnIx8fs7OzMzMz729nDwsK1tLTl5eWxsLD39/eura3a2dmvrq6sq6u5uLerqqqmpaUI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDIqxAUmTFChgwVDDJUmKFKDBbOlREc6XMmw8rKELBDgPOghVQfFFk86fRhhw62IjyE8OXFreOSoXIoUUMRS0reJiBYqpXiIpmnMAa8gutFkW/qmUIqkYKph3D0oq6tm5DDGZq2EhrscKNGif42h2MsEUNFhowRsnbgrBjhiiWELFhUAAShxaW6H3MWSE7ySlsHikmkPTCQEuWUI6IgYMTDRpkwMQgA0MU2rSRwZSh4TVRALZToiSpcvhwJiRLulRJECVv2BpuC4aYWZAepkcAjNaeUBOXV0TmTP+U8aX8DWVwaC1BhGh9eziIapjxYqP8F5/lW5lhz38Ue//puQeHHmbM0UIscCkUAihDkaRBC2qoYaANFLaiBhxwmNFCYhN9sYR1CFzmhybcHaRJIERYZxpGGsDHH3uCwMFhQhXY8CJ/1ymiATtfzKGeIECmdgI7CGlwQgxwfQGHfOxMV0EsksExXUMjIBKjJQNlZ6IGQc6YUStLjCKmmIh80VAUYY7pnzIGYTAHEf0JskQLkxRkgxCrYTADEUuAwpAMiNCCAEXFrGfKHKkgIYCWBaVSjBmCICIeRyggQqZ/S1jQEALwjcmeGgjNYSmZghDhBUGx1BDDQGqkCGpDKND/IkNFlQpiSiCnICQPEh62l6BGvaq5BJEMcWrpqIi8apAG66nZ3qwAVNAeh2iy15hDt0zZkLTs6YFAKgbJ4wsAenzqUWSeskfsQhh0SmayCBUDh5piLmEmcOpx2K6VyrJkY3tfaDLuQMWMA8BnAHuEmrPDbvrfu/0ShEx/Yy4RgkAVwLFEVwIpE6YgfrbELHtmACDMisyQxoV7XmoEJb0NM4RBucjCexAozZK5RL/sEAHHoNGCKecI0IrExH9LYKCJPAL5woxAJ0Qqq0dfUOzfugoh8DCZEQtU6bGRLnEDX5Hp4ZNA7MyR2hJeNBlSBeWO0nDKADAz8H6I/Hxuzphi/53QzMf6Z3O0GKT9IY4tFF1QFCnoVVQUoKihGSLKxCKDthXtJ3dX8gADgD+m0SyowmlW7DdCGFidtxpmYCgZkKPo8cWvCWkwhx43eIlBLDEsuQTuGmAOEdyCbA5AMf44PVAMMLac0cvvCnL6QfuqyYoeoIDCRSte6NHsgGq0gEIfMqMwQgot9DRQBRqEQQufsgNtUTHHIpJYMXb7M5ANRMh9L0cegtn0DKK1/xyrazK4QZhYASQ+zcF5B2GfDWIQg/usT0lE8BnHKjIy9pwNdKATCKDM1ZFKCfAucYMYQj7Div80cDUOiYINWBADJwzETVYiQiss8i+bIc8X6liR6P/kB6xmIWuABUnd1gZnEBQ5ixUbi0gxRlCDGxBEDeyxF0WI1x6OOc1pTEPbegSxQ0qNSmdIJAjg0tW19c3LWTGqU0RsUAM2CWRiVtKD8BCCLkToYSDyeJo69DcQZWRRcRj5ApzGJIipyUx1bRwIHIrnrFGsCCIaWxfN4HBJh8jLUkvgEBL88TRmMCOMwJkkIsygjY2YUE1Suou7BBfJ473RP2KyzkqCB5E3/W8/MdqjQVoAyjICIJAGcxrdBKIBWsgpDA9BgExkQESCKPJYUNzgQgp4RiYWBF0M6woG+gQRMxCBWJyS0/8eEpn2TOp4pjQNN0xJEHbQghVEWCcf97P/jjmoYXCvFEQNuPCQ6qnwIDKAAysYBkPvQfAgKKjjQLzAp2tBZGSCOAHK6Nk0ZqgDlQebZBQTgoD3vUidBZlDkNSQxmXxzT/eKggCUFO8SMmJpQR5EyK0idBW0MKKwJlDDeDA04aww0pLmENRTBlCQKrjlASJgh5KlQSFoMB7J01qbAy3hBi0dCACcJAaImUlGMGpFV/Ynhkks54lDKgVFyuIDJRBixogwgtfYAd02BELG6RAQ0yJwhfMcAILCLMg9gyURY85z4ERhBmkBGkFRiAZtNCIHefRw4AwtEo13MBtDqnAF8JgITXEYA6oTe0clMG6CEmoBTaIRXQWwj4L/4y2FbgNQ2zZgYyBRCEEv+nQh2iBNXnM82kGQQJkn3qZgaBAY3pA5EiS05mbVOBNXZUf/iAL0oIcgal2U2MLlkALfVZXLZUaKtaASEqDLSSQkW2uCBunh4eeFycIECot9kIw+EK1IfBtLGLVUAMvkO++RkGADchrg7MJJBXcGGR4H+IHj/rjqX4oiAaUUWDpIhgkCDALLUDhYAAok5TLjAh8UexYgUShBXoYgX0/jJEEZoinThskKcFVke36g8XyjRYKlBEDFFSTxhWZBDtGoIcW/AoJqXjqj0/ZSYqcmJT+kEcnndKCL4TgsEheFihi0IK4DsQX8sAyKYVBIo5ogv+pF36qowqCDKGgQBFVDrNBKuAEFNgAFLzsL5xRnGeNbJcbU5ZzJ5mgCHbcgppgfgwCnGABntCuGIG0MIq13BJtZPrHpJynuIIMnD5MEwPFiPRUiPMaJ1yOIMVAM2QhO2Vu+KLQIkGzmv0xzx33Ys/JUfVNUo0ADCBAOQJBgqx3zVROf0XXg+71KW+NYMEgIdb+pTWKs9ziush60FOesjDEVQxGDebavkiFccMNahRT+b7YnrW2p8wMRJtSHuQuRjFIHRJ9Y/vTKEY0qMFLbj0fb9mm1HG7Ex7ue+PbFxDXhL/1fe3jVZziE4c4xPFtSm3PmtftdndkqW3weH1b5CFPB7WEQ11vUAs85SAfuJTBe+GUd3zTJC85RIohMHmMY9bHZarCYd7ulxN94e6W8CnFFSKdd0TfG+f4zek9b5h3XOFPXbq4bt1Jfjv962sJCAA7"
)


def _ram_total_gb():
    if os.name != "nt":
        try:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
        except (AttributeError, OSError, ValueError):
            return None

    class _StatusMemoria(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = _StatusMemoria()
    status.dwLength = ctypes.sizeof(_StatusMemoria)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return status.ullTotalPhys / 1024**3


_RAM_TOTAL_GB = _ram_total_gb()
# Máquinas de 5 GB ou menos: coleta antecipada e corte do working set devolvem
# memória física depois das gerações e evitam travamento por pressão de RAM.
MODO_RAM_BAIXA = _RAM_TOTAL_GB is not None and _RAM_TOTAL_GB <= 5
LIMITE_WORKING_SET_MB = 120

if MODO_RAM_BAIXA:
    gc.set_threshold(1000, 10, 10)


class _ContadoresMemoria(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def memoria_trabalho_mb():
    if os.name != "nt":
        return None
    try:
        contadores = _ContadoresMemoria()
        contadores.cb = ctypes.sizeof(_ContadoresMemoria)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(
            ctypes.c_void_p(-1), ctypes.byref(contadores), contadores.cb
        ):
            return None
    except (AttributeError, OSError):
        return None
    return contadores.WorkingSetSize / 1048576


def _cortar_working_set():
    # Devolve ao Windows as páginas ociosas; elas voltam sob demanda no próximo uso.
    try:
        ctypes.windll.psapi.EmptyWorkingSet(ctypes.c_void_p(-1))
    except (AttributeError, OSError):
        pass


def liberar_memoria(forcar=False):
    # Depois de gerar PDF/Excel o processo fica com o pico de memória; devolver
    # essas páginas ao Windows mantém o app leve também nas máquinas com mais RAM.
    if not forcar and not MODO_RAM_BAIXA:
        return
    gc.collect()
    if not forcar:
        atual = memoria_trabalho_mb()
        forcar = atual is not None and atual > LIMITE_WORKING_SET_MB
    if forcar:
        _cortar_working_set()


st.set_page_config(page_title="HAJAN - Emissor de Pedidos", layout="wide")
_EMBEDDED_EMISSOR = st.query_params.get("embedded") == "true"


@st.cache_resource(show_spinner=False, max_entries=1)
def _marcacao_logo():
    # Logo já recortado: o PNG original tem margem transparente grande, que
    # encolhia a marca no cabeçalho. Fallback para o arquivo original.
    import base64

    caminho = LOGO_PATH.with_name("logo_marca.png")
    if not caminho.is_file():
        caminho = LOGO_PATH
    try:
        dados = base64.b64encode(caminho.read_bytes()).decode("ascii")
    except OSError:
        return ""
    return f'<img class="hajan-logo" src="data:image/png;base64,{dados}" alt="HAJAN">'


def _cabecalho_marca(clientes, produtos):
    col_marca, col_sair = st.columns([9, 1], vertical_alignment="center")
    with col_marca:
        st.markdown(
            '<div class="hajan-masthead"><div class="masthead-marca">'
            f'{_marcacao_logo()}'
            '<div class="masthead-titulo">Emissor de pedidos'
            '<span>HAJAN · JBS / Friboi</span></div></div>'
            f'<div class="masthead-meta">{clientes} clientes · {produtos} produtos'
            f'<span>{"base persistente" if EXPORT_DIR else "base local"}</span></div></div>',
            unsafe_allow_html=True,
        )
    with col_sair:
        if st.button("Sair", key="sair_hajan", use_container_width=True):
            st.session_state.pop("hajan_autenticado", None)
            st.rerun()


def _carregar_hash_senha_compartilhada():
    try:
        texto = ARQUIVO_SENHA_COMPARTILHADA.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError:
        logging.exception("Não foi possível ler o arquivo da senha compartilhada.")
        return None
    if not texto.startswith("scrypt$"):
        return None
    partes = texto.split("$")
    if len(partes) != 3:
        return None
    try:
        salt = bytes.fromhex(partes[1])
        esperado = bytes.fromhex(partes[2])
    except ValueError:
        return None
    if not salt or len(esperado) != 64:
        return None
    return salt, esperado


def _senha_compartilhada_definida():
    return bool(os.environ.get("FRIBOI_SENHA")) or (
        _carregar_hash_senha_compartilhada() is not None
    )


def _conferir_senha_compartilhada(candidata):
    hash_guardado = _carregar_hash_senha_compartilhada()
    if hash_guardado is not None:
        salt, esperado = hash_guardado
        try:
            calculado = hashlib.scrypt(
                str(candidata or "").encode("utf-8"),
                salt=salt,
                n=16384,
                r=8,
                p=1,
                dklen=64,
            )
        except (ValueError, TypeError):
            logging.exception("Não foi possível validar a senha compartilhada.")
            return False
        return hmac.compare_digest(calculado, esperado)
    senha_ambiente = os.environ.get("FRIBOI_SENHA", "")
    return bool(senha_ambiente) and hmac.compare_digest(
        str(candidata or ""), senha_ambiente
    )


def _conferir_usuario_compartilhado(candidato):
    usuario_configurado = os.environ.get("FRIBOI_USUARIO", "admin")
    return hmac.compare_digest(
        str(candidato or "").encode("utf-8"),
        usuario_configurado.encode("utf-8"),
    )


def _tela_login():
    st.markdown(
        """
        <style>
            html, body, [data-testid="stAppViewContainer"] {
                background: #f5f7f9;
                color: #16222e;
                font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
            }
            [data-testid="stHeader"], [data-testid="stSidebar"],
            [data-testid="stSidebarCollapsedControl"], [data-testid="stToolbar"], footer {
                display: none;
            }
            .block-container { max-width: 440px; padding: 9vh 1.5rem 3rem; }
            .login-marca { text-align: center; margin-bottom: 1.5rem; }
            .login-marca .hajan-logo { height: 96px; }
            .login-produto { font-size: 1.02rem; font-weight: 650; margin-top: 0.35rem; }
            .login-org {
                font-size: 0.7rem;
                font-weight: 600;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                color: #5c6b78;
                margin-top: 0.15rem;
            }
            .login-titulo { font-size: 1.05rem; font-weight: 650; margin: 0.1rem 0 0.1rem; }
            [data-testid="stForm"] {
                padding: 1.15rem 1.15rem 1.25rem;
                border: 1px solid #e1e7ed;
                border-radius: 12px;
                background: #fff;
                box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
            }
            [data-testid="stWidgetLabel"] p { font-size: 0.83rem; font-weight: 600; }
            .stTextInput input {
                background: #fff;
                color: #16222e;
                border: 1px solid #cfd9e3;
                border-radius: 8px;
            }
            .stTextInput input:focus {
                border-color: #0b63a8 !important;
                box-shadow: 0 0 0 3px rgba(11, 99, 168, 0.14);
            }
            [data-testid="stFormSubmitButton"] button {
                width: 100%;
                background: #0b63a8;
                border: 0;
                border-radius: 8px;
                color: #fff;
                font-weight: 600;
            }
            [data-testid="stFormSubmitButton"] button:hover {
                background: #0a4f86;
                color: #fff;
            }
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown(
        f'<div class="login-marca">{_marcacao_logo()}'
        '<div class="login-produto">Emissor de pedidos</div>'
        '<div class="login-org">HAJAN · JBS / Friboi</div></div>',
        unsafe_allow_html=True,
    )
    st.markdown(
        '<div class="login-titulo">Acesso ao Emissor HAJAN</div>',
        unsafe_allow_html=True,
    )
    st.caption("Use seu usuário e a mesma senha do escritório do Acompanhamento de entregas.")
    if not _senha_compartilhada_definida():
        st.error(
            "A senha compartilhada ainda não está configurada ou não pode ser lida. "
            "Defina-a em Importação e ajustes no Acompanhamento de entregas."
        )
        st.stop()

    with st.form("login_hajan"):
        usuario = st.text_input(
            "Usuário",
            value=os.environ.get("FRIBOI_USUARIO", "admin"),
        )
        senha = st.text_input("Senha do escritório", type="password")
        enviar = st.form_submit_button("Entrar", use_container_width=True)
    if enviar:
        if _conferir_usuario_compartilhado(usuario) and _conferir_senha_compartilhada(senha):
            st.session_state["hajan_autenticado"] = True
            st.rerun()
        st.error("Usuário ou senha incorretos.")
    st.stop()


if not st.session_state.get("hajan_autenticado"):
    _tela_login()


@st.cache_resource(show_spinner=False, max_entries=1)
def _configurar_log():
    raiz = logging.getLogger()
    pasta_log = Path(
        os.environ.get(
            "HAJAN_LOG_DIR",
            Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "HAJAN",
        )
    ).expanduser()
    try:
        pasta_log.mkdir(parents=True, exist_ok=True)
        manipulador = RotatingFileHandler(
            pasta_log / "emissor.log",
            maxBytes=1_000_000,
            backupCount=2,
            encoding="utf-8",
        )
        manipulador.setLevel(logging.INFO)
        manipulador.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        )
        raiz.addHandler(manipulador)
    except OSError:
        raiz.warning("Não foi possível abrir o log em %s", pasta_log)


_configurar_log()


@st.cache_resource(show_spinner=False, max_entries=1)
def _congelar_coleta_inicial():
    # Os objetos de importação duram o processo inteiro; tirá-los da varredura
    # deixa cada coleta do gc mais barata.
    gc.collect()
    gc.freeze()


_congelar_coleta_inicial()

st.markdown(
    """
    <style>
        :root {
            --hajan-azul: #0b63a8;
            --hajan-azul-escuro: #0a4f86;
            --hajan-azul-claro: #edf4fb;
            --hajan-tinta: #16222e;
            --hajan-tinta-suave: #5c6b78;
            --hajan-papel: #f5f7f9;
            --hajan-superficie: #ffffff;
            --hajan-linha: #e1e7ed;
            --hajan-linha-forte: #cfd9e3;
        }
        html, body, [data-testid="stAppViewContainer"] {
            background-color: var(--hajan-papel);
            color: var(--hajan-tinta);
            font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
        }
        .stApp {
            background: transparent;
        }
        [data-testid="stHeader"] {
            background: transparent;
        }
        [data-testid="stSidebar"],
        [data-testid="stSidebarNav"],
        [data-testid="stSidebarCollapsedControl"] {
            display: none;
        }
        .block-container {
            max-width: 1600px;
            padding: 1.1rem clamp(1.25rem, 2.4vw, 2.75rem) 2.5rem;
        }
        h1, h2, h3, h4, h5, h6 {
            color: var(--hajan-tinta);
            letter-spacing: -0.015em;
        }
        h3 {
            font-size: 1.28rem;
            font-weight: 650;
            margin-bottom: 0.35rem;
        }
        p, li {
            line-height: 1.55;
        }

        /* Cabecalho de marca */
        .hajan-masthead {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1.5rem;
            padding-bottom: 0.8rem;
            border-bottom: 2px solid var(--hajan-azul);
            margin-bottom: 1.4rem;
        }
        .masthead-marca {
            display: flex;
            align-items: center;
            gap: 0.95rem;
            min-width: 0;
        }
        .hajan-logo {
            height: 58px;
            width: auto;
            display: block;
            mix-blend-mode: multiply;
        }
        .masthead-titulo {
            font-size: 1.02rem;
            font-weight: 650;
            line-height: 1.2;
        }
        .masthead-titulo span,
        .masthead-meta span {
            display: block;
            font-size: 0.7rem;
            font-weight: 600;
            letter-spacing: 0.09em;
            text-transform: uppercase;
            color: var(--hajan-tinta-suave);
            margin-top: 0.2rem;
        }
        .masthead-meta {
            text-align: right;
            font-size: 0.78rem;
            color: var(--hajan-tinta-suave);
            font-variant-numeric: tabular-nums;
            line-height: 1.3;
            white-space: nowrap;
        }

        /* Secoes */
        .hajan-secao {
            margin: 1.75rem 0 0.4rem;
        }
        .hajan-secao h2 {
            font-size: 1.32rem;
            font-weight: 650;
            margin: 0;
        }
        .bloco-titulo {
            font-size: 0.95rem;
            font-weight: 650;
            margin: 0 0 0.1rem;
        }

        /* Formularios */
        [data-testid="stWidgetLabel"] p {
            font-weight: 600;
            font-size: 0.83rem;
            color: var(--hajan-tinta) !important;
        }
        .stTextInput > div > div > input,
        .stTextArea textarea,
        .stNumberInput > div > div > input,
        .stDateInput > div > div {
            background: var(--hajan-superficie);
            color: var(--hajan-tinta);
            border: 1px solid var(--hajan-linha-forte);
            border-radius: 8px;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .stTextInput > div > div > input:focus,
        .stTextArea textarea:focus,
        .stNumberInput > div > div > input:focus {
            border-color: var(--hajan-azul) !important;
            box-shadow: 0 0 0 3px rgba(11, 99, 168, 0.14);
            outline: none;
        }
        [data-baseweb="select"] > div {
            background: var(--hajan-superficie);
            border-color: var(--hajan-linha-forte) !important;
            border-radius: 8px;
        }
        [data-baseweb="select"] > div:focus-within {
            border-color: var(--hajan-azul) !important;
            box-shadow: 0 0 0 3px rgba(11, 99, 168, 0.14);
        }
        [data-testid="stSelectbox"] [role="group"] {
            background: var(--hajan-superficie) !important;
            border: 1px solid var(--hajan-linha-forte) !important;
            border-radius: 8px;
        }
        [data-testid="stSelectbox"] [role="group"]:focus-within {
            border-color: var(--hajan-azul) !important;
            box-shadow: 0 0 0 3px rgba(11, 99, 168, 0.14);
        }
        ::placeholder {
            color: #8b98a5 !important;
            opacity: 1;
        }
        [data-testid="stRadio"] p {
            color: var(--hajan-tinta) !important;
            font-size: 0.88rem;
        }

        /* Botoes: secundario discreto, primario azul HAJAN */
        .stButton > button,
        .stDownloadButton > button,
        [data-testid="stFormSubmitButton"] button {
            background: var(--hajan-superficie);
            color: var(--hajan-tinta);
            border: 1px solid var(--hajan-linha-forte);
            border-radius: 8px;
            font-weight: 600;
            box-shadow: none;
            transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }
        .stButton > button:hover,
        .stDownloadButton > button:hover,
        [data-testid="stFormSubmitButton"] button:hover {
            background: var(--hajan-azul-claro);
            border-color: var(--hajan-azul);
            color: var(--hajan-azul-escuro);
        }
        .stButton > button[kind="primary"],
        .stDownloadButton > button[kind="primary"],
        [data-testid="stFormSubmitButton"] button[kind="primaryFormSubmit"] {
            background: var(--hajan-azul);
            border-color: var(--hajan-azul);
            color: #ffffff;
        }
        .stButton > button[kind="primary"]:hover,
        .stDownloadButton > button[kind="primary"]:hover,
        [data-testid="stFormSubmitButton"] button[kind="primaryFormSubmit"]:hover {
            background: var(--hajan-azul-escuro);
            border-color: var(--hajan-azul-escuro);
            color: #ffffff;
        }
        .stButton > button:focus-visible,
        .stDownloadButton > button:focus-visible,
        [data-testid="stFormSubmitButton"] button:focus-visible {
            outline: 3px solid rgba(11, 99, 168, 0.35);
            outline-offset: 2px;
        }
        .stButton > button:disabled,
        .stDownloadButton > button:disabled,
        [data-testid="stFormSubmitButton"] button:disabled {
            opacity: 0.45;
            box-shadow: none;
            cursor: not-allowed;
        }

        /* Mensagens */
        [data-testid="stAlert"] {
            border: 1px solid var(--hajan-linha);
            border-left-width: 3px;
            border-radius: 8px;
            padding: 0.55rem 0.8rem !important;
            font-size: 0.86rem;
            box-shadow: none;
        }
        [data-testid="stAlert"]:has([data-testid="stAlertContentInfo"]) {
            border-left-color: var(--hajan-azul);
        }
        [data-testid="stAlert"]:has([data-testid="stAlertContentSuccess"]) {
            border-left-color: #2f855a;
        }
        [data-testid="stAlert"]:has([data-testid="stAlertContentWarning"]) {
            border-left-color: #c98a12;
        }
        [data-testid="stAlert"]:has([data-testid="stAlertContentError"]) {
            border-left-color: #c0392b;
        }
        [data-testid="stAlert"] p {
            color: var(--hajan-tinta);
        }

        /* Indicadores e cartoes */
        [data-testid="stMetric"],
        .stMetric {
            background: var(--hajan-superficie);
            border: 1px solid var(--hajan-linha);
            border-radius: 10px;
            padding: 0.75rem 0.9rem;
        }
        [data-testid="stMetricLabel"] p {
            font-size: 0.71rem;
            font-weight: 600;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            color: var(--hajan-tinta-suave) !important;
        }
        [data-testid="stMetricValue"] {
            font-size: 1.2rem;
            font-weight: 650;
            line-height: 1.25;
            letter-spacing: -0.01em;
            font-variant-numeric: tabular-nums;
        }
        [data-testid="stMultiSelect"] [data-tag] {
            background: var(--hajan-superficie) !important;
            border: 1px solid var(--hajan-linha-forte);
            border-radius: 999px;
            color: var(--hajan-tinta) !important;
        }
        [data-testid="stMultiSelect"] [data-tag] span,
        [data-testid="stMultiSelect"] [data-tag] button {
            color: var(--hajan-tinta) !important;
        }
        [data-testid="stExpander"] {
            background: var(--hajan-superficie);
            border: 1px solid var(--hajan-linha);
            border-radius: 10px;
            box-shadow: none;
        }
        [data-testid="stExpander"] summary {
            padding: 0.6rem 0.9rem;
        }
        [data-testid="stExpander"] summary:hover {
            background: var(--hajan-azul-claro);
        }
        [data-testid="stExpander"] summary p {
            font-weight: 600;
        }
        [class*="st-key-bloco_clonar"] {
            border-color: var(--hajan-linha) !important;
            border-radius: 10px !important;
        }
        [class*="st-key-acao_"] {
            padding-top: 2rem;
        }
        [data-testid="stCaptionContainer"] p,
        [data-testid="stCaptionContainer"],
        .stCaption,
        small {
            color: var(--hajan-tinta-suave) !important;
            font-size: 0.76rem;
            line-height: 1.45;
        }

        /* Etiquetas de ordenacao das entregas */
        .sortable-container-body {
            gap: 6px;
        }
        .sortable-item,
        .sortable-item:hover {
            padding: 5px 9px !important;
            margin: 2px !important;
            font-size: 12px !important;
            line-height: 1.3 !important;
            border-radius: 999px !important;
        }
        .sortable-item:focus-visible {
            outline: 2px solid var(--hajan-azul);
            outline-offset: 2px;
        }

        /* Campos de data com calendario proprio */
        [class*="st-key-campodata_"] {
            position: relative;
            gap: 0 !important;
        }
        [class*="st-key-campodata_"] [data-testid="stElementContainer"] {
            position: static !important;
        }
        [class*="st-key-campodata_"] [class*="_abrir_calendario"] {
            position: absolute !important;
            right: 0.45rem;
            bottom: 0.28rem;
            width: auto;
            z-index: 3;
        }
        [class*="st-key-campodata_"] [class*="_abrir_calendario"] button {
            width: 1.9rem;
            height: 1.9rem;
            min-height: 1.9rem;
            padding: 0;
            border: none !important;
            border-radius: 8px;
            background: transparent !important;
            box-shadow: none !important;
            color: var(--hajan-tinta);
        }
        [class*="st-key-campodata_"] [data-testid="stTextInput"] input {
            padding-right: 2.4rem;
        }
        [class*="st-key-calendario_"] {
            position: absolute !important;
            top: calc(100% + 0.25rem);
            right: 0;
            width: 15rem !important;
            max-width: 100% !important;
            gap: 0.08rem !important;
            padding: 0.35rem 0.3rem 0.4rem;
            background: var(--hajan-superficie);
            border: 1px solid rgba(11, 99, 168, 0.24);
            border-radius: 10px;
            box-shadow: 0 12px 28px rgba(16, 24, 40, 0.14);
            z-index: 100;
        }
        [class*="st-key-calendario_"] [data-testid="stHorizontalBlock"] {
            gap: 0.08rem !important;
        }
        [class*="st-key-calendario_"] [data-testid="stMarkdownContainer"],
        [class*="st-key-calendario_"] [data-testid="stMarkdownContainer"] > div {
            margin: 0 !important;
        }
        [class*="st-key-calendario_"] .stButton > button {
            min-height: 1.55rem !important;
            height: 1.55rem !important;
            padding: 0;
            font-size: 0.75rem;
            line-height: 1;
            border-radius: 6px;
        }
        [class*="st-key-calendario_"] .stButton > button[kind="secondary"] {
            background: var(--hajan-superficie) !important;
            color: var(--hajan-tinta) !important;
            border: 1px solid rgba(11, 99, 168, 0.16) !important;
            box-shadow: none !important;
            font-weight: 600;
        }
        [class*="st-key-calendario_"] .stButton > button[kind="secondary"]:hover {
            background: var(--hajan-azul-claro) !important;
        }

        .hajan-assinatura {
            margin: 2.5rem 0 0.75rem;
            padding-top: 1rem;
            border-top: 1px solid var(--hajan-linha);
            text-align: center;
            font-size: 0.74rem;
            letter-spacing: 0.04em;
            color: #93a1ad;
            user-select: none;
        }
        .hajan-assinatura strong {
            color: #6f7f8d;
            font-weight: 600;
        }
        @media (prefers-reduced-motion: reduce) {
            .stButton > button,
            .stDownloadButton > button,
            .stTextInput input,
            .stTextArea textarea,
            .stNumberInput input,
            [data-baseweb="select"] > div {
                transition: none !important;
            }
        }
    </style>
    """,
    unsafe_allow_html=True,
)

if _EMBEDDED_EMISSOR:
    st.markdown(
        """
        <style>
            [data-testid="stHeader"], [data-testid="stSidebar"],
            [data-testid="stToolbar"], footer { display: none; }
            [data-testid="stMain"] { background: transparent; }
            .block-container { padding-top: 0.75rem; }
        </style>
        """,
        unsafe_allow_html=True,
    )

@contextmanager
def conexao_leitura():
    # O SQLite no Windows não aceita caminho UNC (\\servidor\...) via URI "file:", por isso abre pelo caminho e bloqueia escrita.
    conn = sqlite3.connect(DATABASE_PATH, timeout=10)
    try:
        conn.execute("PRAGMA query_only = ON")
        yield conn
    finally:
        conn.close()


@contextmanager
def conexao_escrita():
    conn = sqlite3.connect(DATABASE_PATH, timeout=10)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


ASSINATURA_BANCO_TTL = 3.0


@st.cache_resource(show_spinner=False, max_entries=1)
def _memo_assinatura_banco():
    # O script é reexecutado a cada interação; o dicionário precisa ficar fora
    # dele para o cache curto sobreviver aos reruns.
    return {}


def invalidar_assinatura_banco():
    # Chamado quando o próprio app grava no banco (tarefas em segundo plano).
    _memo_assinatura_banco().clear()


def assinatura_banco():
    # O banco fica em pasta de rede: com o cache curto evitamos um stat SMB a
    # cada interação e uma queda momentânea da unidade não trava a tela.
    memo = _memo_assinatura_banco()
    agora = time.monotonic()
    if "valor" in memo and agora - memo["momento"] < ASSINATURA_BANCO_TTL:
        return memo["valor"]
    try:
        info = DATABASE_PATH.stat()
    except OSError:
        return (0, 0)
    valor = (info.st_mtime_ns, info.st_size)
    memo["valor"] = valor
    memo["momento"] = agora
    return valor


@st.cache_resource(show_spinner=False, max_entries=1 if MODO_RAM_BAIXA else 2)
def _carregar_clientes(assinatura):
    if not DATABASE_PATH.is_file():
        return {}

    try:
        with conexao_leitura() as conn:
            colunas_clientes = {
                row[1] for row in conn.execute("PRAGMA table_info(clientes)").fetchall()
            }
            status_cliente = (
                "COALESCE(c.status_cliente, '')"
                if "status_cliente" in colunas_clientes
                else "''"
            )
            rows = conn.execute(
                "SELECT c.nome_formatado, c.cnpj, c.cidade, c.uf, c.prazo_padrao, "
                "COALESCE(NULLIF(TRIM(c.codigo_centralizador), ''), c.codigo), "
                "l.centralizador, l.limite, "
                f"l.disponivel, {status_cliente}, c.codigo "
                "FROM clientes c LEFT JOIN limites_clientes l "
                "ON COALESCE(NULLIF(TRIM(c.codigo_centralizador), ''), c.codigo) "
                "= l.codigo_centralizador "
                "WHERE TRIM(c.nome_formatado) <> '' "
                "ORDER BY c.nome_formatado COLLATE NOCASE"
            ).fetchall()
    except sqlite3.Error:
        return {}

    return {
        row[0]: {
            "cnpj": row[1] or "",
            "cidade": row[2] or "",
            "uf": row[3] or "",
            "prazo_padrao": row[4] or "",
            "codigo_centralizador": row[5] or "",
            "centralizador": row[6] or "",
            "limite": float(row[7]) if row[7] is not None else None,
            "disponivel": float(row[8]) if row[8] is not None else None,
            "status_cliente": row[9] or "",
            "codigo": str(row[10] or "").strip(),
        }
        for row in rows
    }


def carregar_clientes(assinatura=None):
    return _carregar_clientes(
        assinatura if assinatura is not None else assinatura_banco()
    )


@st.cache_resource(show_spinner=False, max_entries=1 if MODO_RAM_BAIXA else 2)
def _carregar_produtos(assinatura):
    if not DATABASE_PATH.is_file():
        return {}

    try:
        with conexao_leitura() as conn:
            rows = conn.execute(
                "SELECT codigo, descricao, produto_pedido, unidade, peso, "
                "descricao_completa, estado_fisico, f_s_a, linha_marca, categoria "
                "FROM produtos "
                "WHERE TRIM(descricao) <> '' AND TRIM(categoria) <> '' "
                "ORDER BY descricao COLLATE NOCASE, codigo"
            ).fetchall()
    except sqlite3.Error:
        return {}

    return {
        f"{codigo} - {descricao}": {
            "codigo": codigo,
            "produto_pedido": produto_pedido or "",
            "unidade": (unidade or "kg").strip(),
            "peso": float(peso or 1.0),
            "descricao_completa": descricao_completa or "",
            "estado_fisico": estado_fisico or "",
            "f_s_a": f_s_a or "",
            "linha_marca": linha_marca or "",
            "categoria": (categoria or "").strip().upper() or "Sem categoria",
        }
        for (
            codigo,
            descricao,
            produto_pedido,
            unidade,
            peso,
            descricao_completa,
            estado_fisico,
            f_s_a,
            linha_marca,
            categoria,
        ) in rows
    }


def carregar_produtos(assinatura=None):
    return _carregar_produtos(
        assinatura if assinatura is not None else assinatura_banco()
    )


@st.cache_resource(show_spinner=False, max_entries=1 if MODO_RAM_BAIXA else 2)
def _carregar_unidades(assinatura):
    if not DATABASE_PATH.is_file():
        return {}

    try:
        with conexao_leitura() as conn:
            rows = conn.execute(
                "SELECT sigla, nome, critica FROM unidades_carregamento "
                "ORDER BY nome COLLATE NOCASE"
            ).fetchall()
    except sqlite3.Error:
        return {}

    return {
        f"{sigla} - {nome}": {"sigla": sigla, "nome": nome, "critica": critica or ""}
        for sigla, nome, critica in rows
    }


def carregar_unidades(assinatura=None):
    return _carregar_unidades(
        assinatura if assinatura is not None else assinatura_banco()
    )


def novo_produto(descricao, catalogo, quantidade=1, preco=0.0, prazo=""):
    dados = catalogo.get(descricao, {})
    return {
        "_id": uuid4().hex,
        "produto": descricao,
        "qtd": quantidade,
        "unidade": dados.get("unidade", "kg"),
        "peso": dados.get("peso", 1.0),
        "preco": preco,
        "prazo": prazo,
    }


CHAVES_PRODUTO = (
    "categoria_{0}_{1}",
    "prod_{0}_{1}",
    "_produto_catalogo_{0}_{1}",
    "qtd_txt_{0}_{1}",
    "un_{0}_{1}",
    "prc_txt_{0}_{1}",
    "prz_{0}_{1}",
)


def chaves_produto(entrega_id, produto_id):
    return [modelo.format(entrega_id, produto_id) for modelo in CHAVES_PRODUTO]


def limpar_chaves_produto(entrega_id, produto_id):
    for chave in chaves_produto(entrega_id, produto_id):
        st.session_state.pop(chave, None)


def limpar_chaves_entrega(entrega):
    entrega_id = str(entrega.get("_id") or "")
    if not entrega_id:
        return
    for produto in entrega.get("produtos") or []:
        limpar_chaves_produto(entrega_id, produto.get("_id", ""))
    for chave in [chave for chave in st.session_state if entrega_id in str(chave)]:
        st.session_state.pop(chave, None)


def duplicar_entrega(entrega):
    # Novos identificadores mantêm os widgets da cópia independentes dos originais.
    copia = copy.deepcopy(entrega)
    copia["_id"] = uuid4().hex
    copia["produtos"] = [
        {**produto, "_id": uuid4().hex}
        for produto in copia.get("produtos") or []
    ]
    return copia


PADRAO_CODIGO_OPCAO = re.compile(r"\(([^()]+)\)\s*$")


@lru_cache(maxsize=2048 if MODO_RAM_BAIXA else 8192)
def normalizar_busca(valor):
    texto = unicodedata.normalize("NFKD", str(valor or ""))
    texto = "".join(caractere for caractere in texto if not unicodedata.combining(caractere))
    return re.sub(r"\s+", " ", texto).strip().casefold()


def _codigo_e_nome_opcao(opcao):
    texto = str(opcao).strip()
    achado = PADRAO_CODIGO_OPCAO.search(texto)
    if achado:
        return achado.group(1).strip(), texto[: achado.start()].strip()
    if " - " in texto:
        codigo, nome = texto.split(" - ", 1)
        return codigo.strip(), nome.strip()
    return "", texto


def localizar_opcao(valor, opcoes):
    alvo = normalizar_busca(valor)
    if not alvo or not opcoes:
        return None
    alvo_numerico = alvo.isdigit()
    por_codigo = []
    por_nome = []
    por_numero = []
    contem_alvo = []
    contidos = []
    for opcao in opcoes:
        normalizado = normalizar_busca(opcao)
        if normalizado == alvo:
            return opcao
        codigo, nome = _codigo_e_nome_opcao(opcao)
        codigo_normalizado = normalizar_busca(codigo) if codigo else ""
        nome_normalizado = normalizar_busca(nome) if nome else ""
        if codigo_normalizado and codigo_normalizado == alvo:
            por_codigo.append(opcao)
        if nome_normalizado and nome_normalizado == alvo:
            por_nome.append(opcao)
        if alvo_numerico and alvo in re.findall(r"\d+", opcao):
            por_numero.append(opcao)
        if alvo in (nome_normalizado or normalizado):
            contem_alvo.append(opcao)
        if alvo in normalizado:
            contidos.append(opcao)
    if len(por_codigo) == 1:
        return por_codigo[0]
    if len(por_codigo) > 1:
        return None
    if len(por_nome) == 1:
        return por_nome[0]
    if len(por_nome) > 1:
        return None
    if len(por_numero) == 1:
        return por_numero[0]
    if len(contem_alvo) == 1:
        return contem_alvo[0]
    if len(contidos) == 1:
        return contidos[0]
    return None


def formatar_numero(valor, inteiro=False):
    if inteiro:
        return f"{int(round(float(valor))):,}".replace(",", ".")
    return f"{float(valor):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def converter_numero(texto, inteiro=False):
    limpo = re.sub(r"[^\d,.\-]", "", str(texto or "")).strip()
    if not limpo:
        return None
    if "," in limpo:
        limpo = limpo.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?\d{1,3}(\.\d{3})+", limpo):
        limpo = limpo.replace(".", "")
    try:
        numero = float(limpo)
    except ValueError:
        return None
    return int(round(numero)) if inteiro else numero


DIAS_SEMANA = [
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
    "domingo",
]


def converter_data(texto):
    limpo = str(texto or "").strip()
    if not limpo:
        return None
    for formato in ("%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d.%m.%Y", "%d%m%Y", "%d%m%y"):
        try:
            return datetime.strptime(limpo, formato).date()
        except ValueError:
            continue
    return None


MESES = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
]


def _painel_calendario(chave, valor):
    hoje = date.today()
    chave_mes = f"{chave}_mes"
    mes = st.session_state.get(chave_mes)
    if not isinstance(mes, date):
        mes = (valor or hoje).replace(day=1)
        st.session_state[chave_mes] = mes
    with st.container(key=f"calendario_{chave}"):
        anterior, titulo, seguinte = st.columns([1, 3, 1], vertical_alignment="center")
        if anterior.button("‹", key=f"{chave}_mes_anterior", width="stretch"):
            st.session_state[chave_mes] = (mes - timedelta(days=1)).replace(day=1)
            st.rerun()
        titulo.markdown(
            "<div style='text-align:center;font-weight:700;font-size:.85rem;"
            "color:#0f172a;line-height:1.4'>"
            f"{MESES[mes.month - 1].capitalize()} {mes.year}</div>",
            unsafe_allow_html=True,
        )
        if seguinte.button("›", key=f"{chave}_mes_seguinte", width="stretch"):
            st.session_state[chave_mes] = (mes + timedelta(days=32)).replace(day=1)
            st.rerun()
        for coluna, nome in zip(st.columns(7), ["D", "S", "T", "Q", "Q", "S", "S"]):
            coluna.markdown(
                f"<div style='text-align:center;font-size:.7rem;color:#64748b'>{nome}</div>",
                unsafe_allow_html=True,
            )
        celulas = [None] * ((mes.weekday() + 1) % 7) + list(
            range(1, monthrange(mes.year, mes.month)[1] + 1)
        )
        while len(celulas) % 7:
            celulas.append(None)
        for inicio in range(0, len(celulas), 7):
            for coluna, dia in zip(st.columns(7), celulas[inicio : inicio + 7]):
                if dia is None:
                    coluna.write("")
                    continue
                data_dia = date(mes.year, mes.month, dia)
                if coluna.button(
                    str(dia),
                    key=f"{chave}_dia_{data_dia:%Y%m%d}",
                    width="stretch",
                    type="primary" if data_dia == valor else "secondary",
                ):
                    st.session_state[f"{chave}_pendente"] = data_dia.strftime("%d/%m/%Y")
                    st.session_state.pop("calendario_aberto", None)
                    st.rerun()
        if st.button("Hoje", key=f"{chave}_hoje", width="stretch"):
            st.session_state[f"{chave}_pendente"] = hoje.strftime("%d/%m/%Y")
            st.session_state.pop("calendario_aberto", None)
            st.rerun()


def campo_data(rotulo, chave, padrao):
    if chave not in st.session_state:
        st.session_state[chave] = padrao.strftime("%d/%m/%Y")
    pendente = st.session_state.pop(f"{chave}_pendente", None)
    if pendente:
        st.session_state[chave] = pendente
    aberto = st.session_state.get("calendario_aberto") == chave
    with st.container(key=f"campodata_{chave}"):
        texto = st.text_input(
            rotulo,
            key=chave,
            placeholder="dd/mm/aaaa (pode colar)",
        )
        if st.button("📅", key=f"{chave}_abrir_calendario"):
            if aberto:
                st.session_state.pop("calendario_aberto", None)
            else:
                st.session_state["calendario_aberto"] = chave
                st.session_state[f"{chave}_mes"] = (
                    converter_data(texto) or padrao
                ).replace(day=1)
            st.rerun()
        if aberto:
            _painel_calendario(chave, converter_data(texto) or padrao)
    valor = converter_data(texto)
    if valor is None:
        st.warning(f"{rotulo}: use dd/mm/aaaa.")
    else:
        st.caption(f"{DIAS_SEMANA[valor.weekday()]} · {valor:%d/%m/%Y}")
    return valor if valor is not None else padrao


def ajustar_opcao_colada(chave, opcoes, rotulo, padrao=None):
    if not opcoes:
        return None
    atual = st.session_state.get(chave)
    if atual is None or atual in opcoes:
        return atual
    canonica = localizar_opcao(atual, opcoes)
    if canonica:
        st.session_state[chave] = canonica
        return canonica
    st.session_state[chave] = padrao if padrao in opcoes else opcoes[0]
    st.warning(
        f'{rotulo} "{atual}" não foi encontrado no cadastro; mantido "{st.session_state[chave]}".'
    )
    return st.session_state[chave]


def entrega_peso_manual(entrega):
    nomes = (entrega.get("cliente", ""), entrega.get("destino", ""))
    return any(str(nome).strip().upper().startswith("ESC ") for nome in nomes)


def produtos_entrega(entrega):
    return [] if entrega_peso_manual(entrega) else (entrega.get("produtos") or [])


def calcular_peso_produtos(produtos):
    return sum(
        float(produto.get("qtd", 0) or 0) * float(produto.get("peso", 1.0) or 1.0)
        for produto in produtos
    )


def peso_entrega(entrega):
    if entrega_peso_manual(entrega):
        return float(entrega.get("peso_manual", 0) or 0)
    return calcular_peso_produtos(entrega.get("produtos") or [])


def calcular_peso_total(entregas):
    return sum(peso_entrega(entrega) for entrega in entregas)


def calcular_valor_pedido(produtos):
    return sum(
        float(produto.get("qtd", 0) or 0)
        * float(produto.get("peso", 1.0) or 1.0)
        * float(produto.get("preco", 0.0) or 0.0)
        for produto in produtos
    )


def formatar_moeda(valor):
    valor_formatado = f"{valor:,.2f}"
    return f"R\\$ {valor_formatado.replace(',', 'X').replace('.', ',').replace('X', '.')}"


MESES_CARTEIRA = {
    "jan": 1,
    "fev": 2,
    "mar": 3,
    "abr": 4,
    "mai": 5,
    "jun": 6,
    "jul": 7,
    "ago": 8,
    "set": 9,
    "out": 10,
    "nov": 11,
    "dez": 12,
}
DATA_NO_NOME_CARTEIRA = re.compile(r"(\d{1,2})\s*([a-zç]{3,9})\s*(\d{4})", re.IGNORECASE)


def _data_do_nome_carteira(nome):
    achado = DATA_NO_NOME_CARTEIRA.search(nome)
    if not achado:
        return None
    mes = MESES_CARTEIRA.get(achado.group(2)[:3].lower())
    if not mes:
        return None
    try:
        return date(int(achado.group(3)), mes, int(achado.group(1)))
    except ValueError:
        return None


@st.cache_resource(show_spinner=False, max_entries=1)
def _memo_carteira_credito():
    # Assinatura curta: os arquivos mudam no máximo uma vez por dia, então não
    # vale pagar um glob/stat em SMB a cada interação do formulário.
    return {"momento": 0.0, "assinatura": ()}


def _assinatura_carteira_credito():
    memo = _memo_carteira_credito()
    agora = time.monotonic()
    if memo["assinatura"] and agora - memo["momento"] < 60.0:
        return memo["assinatura"]

    try:
        arquivos = [
            arquivo
            for arquivo in PASTA_CARTEIRA_CREDITO.glob("CARTEIRA DE TERCEIRO*.xlsx")
            if not arquivo.name.startswith("~$")
        ]
    except OSError:
        return memo["assinatura"]

    por_data = {}
    for arquivo in arquivos:
        data_arquivo = _data_do_nome_carteira(arquivo.name)
        if data_arquivo:
            por_data.setdefault(data_arquivo, []).append(arquivo)
    if not por_data:
        return memo["assinatura"]

    assinatura = []
    for arquivo in sorted(por_data[max(por_data)]):
        try:
            info = arquivo.stat()
        except OSError:
            continue
        assinatura.append((arquivo.name, info.st_mtime_ns, info.st_size))
    memo["assinatura"] = tuple(assinatura)
    memo["momento"] = agora
    return memo["assinatura"]


def _codigo_planilha(valor):
    try:
        return str(int(float(valor)))
    except (TypeError, ValueError):
        return str(valor or "").strip()


def _numero_planilha(valor):
    try:
        return float(valor or 0)
    except (TypeError, ValueError):
        return 0.0


@st.cache_resource(show_spinner=False, max_entries=1)
def _carregar_carteira_credito(assinatura):
    if not assinatura:
        return {"registros": {}, "data": ""}

    import openpyxl

    registros = {}
    data_referencia = ""
    for nome_arquivo, _mtime, _tamanho in assinatura:
        if not data_referencia:
            data_arquivo = _data_do_nome_carteira(nome_arquivo)
            if data_arquivo:
                data_referencia = data_arquivo.strftime("%d/%m/%Y")
        try:
            wb = openpyxl.load_workbook(
                PASTA_CARTEIRA_CREDITO / nome_arquivo, read_only=True, data_only=True
            )
        except Exception:
            continue
        try:
            ws = wb.worksheets[0]
            colunas = None
            for linha in ws.iter_rows(values_only=True):
                if not linha:
                    continue
                cabecalho = [normalizar_busca(celula) for celula in linha]
                if (
                    cabecalho
                    and cabecalho[0] == "codigo"
                    and len(cabecalho) > 1
                    and cabecalho[1] == "nome"
                ):
                    colunas = {}
                    for indice, rotulo in enumerate(cabecalho):
                        if rotulo == "limite":
                            colunas["limite"] = indice
                        elif rotulo == "saldo financeiro":
                            colunas["saldo_financeiro"] = indice
                        elif rotulo == "saldo em carteira":
                            colunas["saldo_carteira"] = indice
                        elif rotulo == "saldo de credito":
                            colunas["saldo_credito"] = indice
                        elif rotulo == "status do cliente":
                            colunas["status"] = indice
                    colunas["codigo"] = 0
                    colunas["nome"] = 1
                    if len(colunas) < 7:
                        colunas = None
                    break
            if not colunas:
                continue
            for linha in ws.iter_rows(values_only=True):
                if not linha or len(linha) <= max(colunas.values()):
                    continue
                codigo = _codigo_planilha(linha[colunas["codigo"]])
                if not codigo or codigo == "0":
                    continue
                registros.setdefault(codigo, []).append({
                    "limite": _numero_planilha(linha[colunas["limite"]]),
                    "saldo_financeiro": _numero_planilha(
                        linha[colunas["saldo_financeiro"]]
                    ),
                    "saldo_carteira": _numero_planilha(
                        linha[colunas["saldo_carteira"]]
                    ),
                    "saldo_credito": _numero_planilha(
                        linha[colunas["saldo_credito"]]
                    ),
                    "status": str(linha[colunas["status"]] or "").strip(),
                    "nome": str(linha[colunas["nome"]] or "").strip(),
                })
        finally:
            wb.close()

    # As divisões repetem o registro consolidado e trazem recortes parciais;
    # somar duplicaria o saldo, então prevalece o maior valor de cada campo.
    consolidado = {}
    for codigo, itens in registros.items():
        base = max(itens, key=lambda item: item["limite"])
        status = base["status"] or next(
            (item["status"] for item in itens if item["status"]), ""
        )
        consolidado[codigo] = {
            "limite": max(item["limite"] for item in itens),
            "saldo_financeiro": max(item["saldo_financeiro"] for item in itens),
            "saldo_carteira": max(item["saldo_carteira"] for item in itens),
            "saldo_credito": max(item["saldo_credito"] for item in itens),
            "status": status,
            "nome": base["nome"],
        }

    return {"registros": consolidado, "data": data_referencia}


def _assinatura_media_compras():
    for caminho in ARQUIVOS_MEDIA_COMPRAS:
        try:
            info = caminho.stat()
        except OSError:
            continue
        return (str(caminho), info.st_mtime_ns, info.st_size)
    return ()


@st.cache_resource(show_spinner=False, max_entries=1)
def _carregar_media_compras(assinatura):
    if not assinatura:
        return {}
    try:
        with open(assinatura[0], encoding="utf-8") as arquivo:
            dados = json.load(arquivo)
    except (OSError, ValueError):
        return {}

    medias = {}
    for cliente in dados.get("clientes") or []:
        # A análise de crédito é mensal; a regra de atenção compara com a semana (52/12).
        informacao = {
            "media_semana": _numero_planilha(cliente.get("media_mensal_compras_6m")) * 12 / 52,
            "status_analise": str(cliente.get("status_compra") or ""),
        }
        for codigo in cliente.get("codigos") or []:
            medias[_codigo_planilha(codigo)] = informacao
    return medias


def resumir_limites_pedido(entregas, clientes, carteira=None):
    grupos = {}
    for entrega in entregas:
        nome_cliente = entrega["cliente"]
        dados = clientes.get(nome_cliente, {})
        codigo = dados.get("codigo_centralizador", "")
        chave = codigo or f"cliente:{nome_cliente}"
        registro = (carteira or {}).get(codigo) if codigo else None
        grupo = grupos.setdefault(chave, {
            "clientes": set(),
            "centralizador": dados.get("centralizador", "")
            or (registro or {}).get("nome", ""),
            "codigo": codigo,
            "carteira": registro,
            "limite": registro["limite"] if registro else dados.get("limite"),
            "disponivel": registro["saldo_credito"]
            if registro
            else dados.get("disponivel"),
            "pedido": 0.0,
        })
        grupo["clientes"].add(nome_cliente)
        grupo["pedido"] += calcular_valor_pedido(produtos_entrega(entrega))

    return grupos.values()


def determinar_tipo_veiculo(peso_total):
    return "Bi-truck" if peso_total <= 17000 else "Carreta"


def normalizar_grupo_operacao_3(nome_cliente):
    nome_limpo = re.sub(r"\s*\([^)]*\)\s*$", "", nome_cliente).strip()
    nome_upper = nome_limpo.upper()

    for prefixo in (
        "J L MEDEIROS",
        "H J L PEIXOTO",
        "JL CENTRAL",
        "J L DISTRIBUIDORA",
        "J L DISTRIBUIÇÃO",
    ):
        if nome_upper.startswith(prefixo):
            return prefixo

    partes = nome_limpo.split()
    if len(partes) >= 3:
        return " ".join(partes[:3])
    return nome_limpo


def listar_destinos_operacao_3(clientes):
    destinos = sorted(set(clientes), key=str.lower)
    if OPCAO_SEM_DESTINO in destinos:
        return destinos
    return [OPCAO_SEM_DESTINO, *destinos]


def mostrar_resumo_geral(entregas):
    total_peso = calcular_peso_total(entregas)
    total_valor = sum(
        calcular_valor_pedido(produtos_entrega(entrega)) for entrega in entregas
    )
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Entregas", len(entregas))
    with col2:
        st.metric("Peso total", f"{total_peso:,.0f} kg".replace(",", "."))
    with col3:
        st.metric("Veículo", determinar_tipo_veiculo(total_peso))
    with col4:
        st.metric("Valor", formatar_moeda(total_valor))


def rotulo_entrega(entrega, indice):
    nome = entrega.get("destino") or entrega["cliente"]
    return f"Entrega {indice + 1:02d} · {nome}"


def chave_ordenacao_entregas(entregas):
    payload = "|".join(
        f"{entrega['_id']}:{indice}:{entrega.get('cliente','')}:{entrega.get('destino','')}"
        for indice, entrega in enumerate(entregas)
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"ordem_entregas_{digest}"


def titulo_resumo_excel(categoria, numero_pedido, sigla_unidade):
    numero = nome_seguro_arquivo(numero_pedido)
    sigla = nome_seguro_arquivo(sigla_unidade)
    return f"Pedido HAJAN {categoria} nº {numero} - R0 {sigla}"


def nome_resumo_excel(categoria, numero_pedido, sigla_unidade, data_entrega):
    numero = nome_seguro_arquivo(numero_pedido)
    sigla = nome_seguro_arquivo(sigla_unidade)
    if categoria == "PÇS":
        return (
            f"{numero} {data_entrega.strftime('%Y-%m-%d')} "
            f"Pedido HAJAN PÇS nº {numero} - R0 {sigla} (FRIBOI)"
        )
    return f"Pedido HAJAN {categoria} nº {numero} - R0 {sigla} (FRIBOI)-Anotações"


def entregas_com_categoria(entregas, catalogo_produtos, categoria,
                           incluir_peso_manual=False):
    selecionadas = []
    for indice, entrega in enumerate(entregas, start=1):
        produtos = [
            produto
            for produto in produtos_entrega(entrega)
            if catalogo_produtos.get(produto["produto"], {}).get("categoria", "").strip().upper() == categoria
        ]
        if produtos or (incluir_peso_manual and entrega_peso_manual(entrega)):
            selecionadas.append((indice, entrega, produtos))
    return selecionadas


def rotulo_categorias(entregas, catalogo_produtos):
    presentes = {
        catalogo_produtos.get(produto["produto"], {}).get("categoria", "").strip().upper()
        for entrega in entregas
        for produto in produtos_entrega(entrega)
    }
    return "-".join(
        categoria for categoria in ("CXS", "PÇS", "CHQ", "SPG") if categoria in presentes
    ) or "PÇS"


def gerar_excel_resumo(categoria, numero_pedido, unidade_carregamento, entregas,
                       clientes, catalogo_produtos, data_embarque, data_entrega):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    entregas_categoria = entregas_com_categoria(
        entregas,
        catalogo_produtos,
        categoria,
        incluir_peso_manual=categoria == "PÇS",
    )
    if not entregas_categoria:
        return None

    sigla_unidade = UNIDADES_DADOS.get(unidade_carregamento, {}).get("sigla", unidade_carregamento)
    workbook = Workbook()
    planilha = workbook.active
    planilha.title = "ResumoSemanal"
    definir_texto_excel(
        planilha, 1, 1, titulo_resumo_excel(categoria, numero_pedido, sigla_unidade)
    )

    for linha, (indice, entrega, _) in enumerate(entregas_categoria, start=2):
        nome = entrega.get("destino") or entrega["cliente"]
        nome_cliente = re.sub(r"#\([^)]*\)#", "", entrega["cliente"])
        if entrega_peso_manual(entrega):
            nome = nome_cliente = re.sub(r"\s*\(0\)\s*$", "", nome).strip()
            dados_cliente = clientes.get(entrega.get("destino", ""), {})
        else:
            dados_cliente = clientes.get(entrega["cliente"], {})
        localizacao = "-".join(
            parte for parte in (dados_cliente.get("cidade", ""), dados_cliente.get("uf", "")) if parte
        )
        destino = " | ".join(parte for parte in (nome, localizacao) if parte)
        destino_cliente = " | ".join(parte for parte in (nome_cliente, localizacao) if parte)
        definir_texto_excel(planilha, linha, 1, f"{indice} | {destino}")
        definir_texto_excel(planilha, linha, 2, f"{indice}ª Entrega | {destino_cliente}")

    linha_datas = len(entregas_categoria) + 2
    definir_texto_excel(
        planilha,
        linha_datas,
        1,
        f"CIF  -  EMBARQUE: {data_embarque.strftime('%d/%m/%y')} - ENTREGA: {data_entrega.strftime('%d/%m/%y')}",
    )
    planilha.column_dimensions["A"].width = 59.42578125
    for row in planilha.iter_rows():
        for cell in row:
            cell.font = Font(name="Calibri", size=11)
    planilha["A1"].font = Font(name="Calibri", size=11, bold=True)
    planilha.page_margins.left = 0.511811024
    planilha.page_margins.right = 0.511811024
    planilha.page_margins.top = 0.787401575
    planilha.page_margins.bottom = 0.787401575
    planilha.page_margins.header = 0.31496062
    planilha.page_margins.footer = 0.31496062
    return workbook


def borda_excel(esquerda=False, direita=False, topo=False, base=False):
    from openpyxl.styles import Border, Side

    fina = Side(style="thin")
    vazia = Side()
    return Border(
        left=fina if esquerda else vazia,
        right=fina if direita else vazia,
        top=fina if topo else vazia,
        bottom=fina if base else vazia,
    )


def estilo_excel_anotacoes(celula, tamanho=12, negrito=False, horizontal=None,
                           vertical=None, wrap=False, numero=None, borda=None):
    from openpyxl.styles import Alignment, Font

    celula.font = Font(name="Arial", size=tamanho, bold=negrito)
    celula.alignment = Alignment(horizontal=horizontal, vertical=vertical, wrap_text=wrap or None)
    if numero:
        celula.number_format = numero
    if borda is not None:
        celula.border = borda
    return celula


def rotulo_produto_excel(produto, catalogo_produtos):
    chave = produto["produto"]
    codigo = str(catalogo_produtos.get(chave, {}).get("codigo", "") or "").strip()
    descricao = chave
    prefixo = f"{codigo} - "
    if codigo and chave.startswith(prefixo):
        descricao = chave[len(prefixo):]
    return f"{codigo}-{descricao}" if codigo else descricao


def gerar_excel_anotacoes_cxs(numero_pedido, unidade_carregamento, entregas, catalogo_produtos,
                              data_pedido, local_emissao, atencao_sr, data_embarque, data_entrega):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment

    # A planilha de caixaria lista todas as entregas do pedido: as de produto
    # CXS e também as ESC, que entram só com o peso manual na coluna TOTAL.
    linhas_tabela = []
    for indice, entrega in enumerate(entregas, start=1):
        produtos = [
            produto
            for produto in produtos_entrega(entrega)
            if catalogo_produtos.get(produto["produto"], {}).get("categoria", "").strip().upper()
            == "CXS"
        ]
        if produtos:
            linhas_tabela.append((indice, entrega, produtos))
        elif entrega_peso_manual(entrega):
            linhas_tabela.append((indice, entrega, []))
    if not linhas_tabela:
        return None

    sigla_unidade = UNIDADES_DADOS.get(unidade_carregamento, {}).get("sigla", unidade_carregamento)
    workbook = Workbook()
    planilha = workbook.active
    planilha.title = "Pedidos"

    planilha["A1"] = f"{local_emissao}, {data_pedido.strftime('%d/%m/%y')}"
    planilha["C1"] = 1
    planilha["F1"] = "22-25"
    planilha["G1"] = 2
    planilha["A2"] = "16.0"
    planilha["B2"] = "V4.0 M14"
    planilha["C2"] = 1235
    for coordenada in ("A1", "B1", "C1", "D1", "E1", "F1", "G1", "A2", "B2", "C2"):
        estilo_excel_anotacoes(planilha[coordenada])
    planilha["F1"].number_format = "@"
    planilha["A2"].number_format = "@"
    planilha["B2"].alignment = Alignment(horizontal="center", vertical="center")
    planilha["C2"].alignment = Alignment(horizontal="center", vertical="center")

    planilha["A3"] = f"Ao: Frigorífico Friboi (Grupo JBS){' ' * 22}At. Sr. {atencao_sr}".rstrip()
    estilo_excel_anotacoes(planilha["A3"], numero="@")
    planilha["B4"] = " "
    estilo_excel_anotacoes(planilha["B4"])
    planilha["A5"] = titulo_resumo_excel("CXS", numero_pedido, sigla_unidade)
    estilo_excel_anotacoes(planilha["A5"], numero="@")

    planilha.row_dimensions[6].height = 18
    planilha["B6"] = "LOGISTICA:"
    planilha["G6"] = "INST:"
    estilo_excel_anotacoes(planilha["B6"], tamanho=14)
    estilo_excel_anotacoes(planilha["G6"], tamanho=14)

    planilha.row_dimensions[7].height = 15.75
    planilha["A7"] = "                   Vendedor: 1677169 "
    estilo_excel_anotacoes(planilha["A7"], negrito=True, borda=borda_excel(True, True, True, True))
    estilo_excel_anotacoes(planilha["B7"], negrito=True, borda=borda_excel(True, True, True, True))
    for coluna in range(3, 7):
        estilo_excel_anotacoes(
            planilha.cell(7, coluna), borda=borda_excel(topo=True, base=True)
        )
    estilo_excel_anotacoes(
        planilha.cell(7, 7), borda=borda_excel(direita=True, topo=True, base=True)
    )

    cabecalhos = ("ENT.", "EMPRESA", "PRODUTOS", "QTD CXS", "NF", "TOTAL", "PRAZO")
    for coluna, texto in enumerate(cabecalhos, start=1):
        planilha.merge_cells(start_row=8, start_column=coluna, end_row=10, end_column=coluna)
        celula = planilha.cell(8, coluna, texto)
        estilo_excel_anotacoes(
            celula,
            horizontal="center",
            vertical="center",
            wrap=coluna != 2,
            numero="@" if coluna == 1 else None,
            borda=borda_excel(True, True, True, True),
        )
        for linha in (9, 10):
            planilha.cell(linha, coluna).border = borda_excel(True, True, base=linha == 10)

    primeira_linha = 11
    for deslocamento, (indice, entrega, produtos) in enumerate(linhas_tabela):
        linha = primeira_linha + deslocamento
        planilha.row_dimensions[linha].height = 20.25

        planilha.cell(linha, 1, indice)
        planilha.cell(linha, 2, entrega.get("destino") or entrega["cliente"])
        if produtos:
            planilha.cell(
                linha,
                3,
                "\n".join(rotulo_produto_excel(produto, catalogo_produtos) for produto in produtos),
            )
            planilha.cell(
                linha,
                6,
                sum(
                    float(produto["qtd"]) * float(produto.get("peso") or 1.0)
                    for produto in produtos
                ),
            )
            prazos = []
            for produto in produtos:
                prazo = str(produto.get("prazo", "") or "").strip()
                if prazo and prazo not in prazos:
                    prazos.append(prazo)
            planilha.cell(linha, 7, " / ".join(prazos) or None)
        else:
            planilha.cell(linha, 6, float(entrega.get("peso_manual") or 0))

        for coluna in range(1, 8):
            estilo_excel_anotacoes(
                planilha.cell(linha, coluna),
                tamanho=16 if coluna in (3, 4, 5, 6) else 12,
                horizontal="center" if coluna != 2 else None,
                numero="#,##0.00" if coluna == 6 else None,
                borda=borda_excel(True, True, True, True),
            )

    linha_total = primeira_linha + len(linhas_tabela)
    planilha.row_dimensions[linha_total].height = 20.25
    planilha.cell(linha_total, 2, "TOTAL")
    planilha.cell(linha_total, 6, f"=SUM(F{primeira_linha}:F{linha_total - 1})")
    for coluna in range(1, 8):
        estilo_excel_anotacoes(
            planilha.cell(linha_total, coluna),
            tamanho=16 if coluna == 6 else 12,
            horizontal="center" if coluna != 2 else None,
            numero="#,##0.00" if coluna == 6 else ("@" if coluna == 1 else None),
            borda=borda_excel(True, True, True, True),
        )

    planilha.row_dimensions[linha_total + 1].height = 15.75
    linha_cif = linha_total + 2
    planilha.row_dimensions[linha_cif].height = 20.25
    planilha.cell(
        linha_cif,
        1,
        f"CIF  -  EMBARQUE: {data_embarque.strftime('%d/%m/%y')} - ENTREGA: {data_entrega.strftime('%d/%m/%y')}",
    )
    estilo_excel_anotacoes(planilha.cell(linha_cif, 1), tamanho=13, numero="@")

    linha_transporte = linha_cif + 3
    for linha in (linha_transporte, linha_transporte + 1):
        planilha.row_dimensions[linha].height = 20.25
    planilha.cell(linha_transporte, 2, "TRANSPORTADORA:")
    planilha.cell(linha_transporte, 3, "GESTOR:")
    planilha.cell(linha_transporte + 1, 2, "PLACA:")
    planilha.cell(linha_transporte + 1, 3, "MOTORISTA:")
    for linha in (linha_transporte, linha_transporte + 1):
        for coluna in (2, 3):
            estilo_excel_anotacoes(planilha.cell(linha, coluna), tamanho=16)

    for coluna, largura in {
        "A": 7.140625,
        "B": 57.28515625,
        "C": 49.28515625,
        "D": 14.85546875,
        "E": 25.7109375,
        "F": 19.5703125,
        "G": 14.0,
        "H": 9.140625,
    }.items():
        planilha.column_dimensions[coluna].width = largura
    planilha.page_setup.orientation = "landscape"
    planilha.page_setup.paperSize = 9
    planilha.page_margins.left = 0.5118110236220472
    planilha.page_margins.right = 0.5118110236220472
    planilha.page_margins.top = 0.3937007874015748
    planilha.page_margins.bottom = 0.1968503937007874
    planilha.page_margins.header = 0.31496062992125984
    planilha.page_margins.footer = 0.31496062992125984
    return workbook


def gerar_excel_chq(numero_pedido, entregas, clientes, catalogo_produtos, data_pedido):
    import base64

    from openpyxl import Workbook
    from openpyxl.drawing.image import Image as ImagemExcel
    from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
    from openpyxl.drawing.xdr import XDRPositiveSize2D
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.styles.colors import Color
    from openpyxl.worksheet.properties import PageSetupProperties

    fina = Side(style="thin")
    borda = Border(left=fina, right=fina, top=fina, bottom=fina)
    fill_cabecalho = PatternFill("solid", fgColor=Color(theme=2))
    fill_valor = PatternFill("solid", fgColor=Color(theme=0, tint=-0.1499984740745262))
    fill_amarelo = PatternFill("solid", fgColor="FFFFFFCC")
    formato_moeda = r'_-"R$"\ * #,##0.00_-;\-"R$"\ * #,##0.00_-;_-"R$"\ * "-"??_-;_-@_-'

    def estilo(celula, fonte="Calibri", tamanho=12, negrito=False, italico=False,
               horizontal="center", vertical="center", wrap=False, numero=None,
               fundo=None, com_borda=True):
        celula.font = Font(
            name=fonte, size=tamanho, bold=negrito, italic=italico, color=Color(theme=1)
        )
        celula.alignment = Alignment(
            horizontal=horizontal, vertical=vertical, wrap_text=wrap or None
        )
        if numero:
            celula.number_format = numero
        if fundo is not None:
            celula.fill = fundo
        if com_borda:
            celula.border = borda
        return celula

    produtos_chq = {}
    for dados in catalogo_produtos.values():
        if dados.get("categoria", "").strip().upper() != "CHQ":
            continue
        codigo_produto = str(dados.get("codigo", "") or "").strip()
        if codigo_produto and codigo_produto not in produtos_chq:
            produtos_chq[codigo_produto] = dados

    def ordenar_por_codigo(item):
        return (int(item[0]) if item[0].isdigit() else 0, item[0])

    lista_produtos = sorted(produtos_chq.items(), key=ordenar_por_codigo)

    linhas_clientes = []
    for nome, dados in clientes.items():
        codigo_cliente = str(dados.get("codigo", "") or "").strip()
        if not codigo_cliente or codigo_cliente == "0":
            continue
        linhas_clientes.append(
            (
                int(codigo_cliente) if codigo_cliente.isdigit() else codigo_cliente,
                dados.get("cnpj", ""),
                re.sub(r"\s*\(\d+\)\s*$", "", nome).strip(),
                dados.get("prazo_padrao", ""),
                "",
                "",
                dados.get("cidade", ""),
                dados.get("uf", ""),
            )
        )
    linhas_clientes.sort(key=lambda linha: normalizar_busca(str(linha[2])))
    n_clientes = max(len(linhas_clientes) + 1, 2)

    def formula_cliente(coluna):
        return (
            f'=IFERROR(IF($D$12="","",TEXT(INDEX(\'CLIENTES CHARQUE\'!${coluna}$1:${coluna}${n_clientes},'
            f'MATCH(VALUE($D$12),\'CLIENTES CHARQUE\'!$A$1:$A${n_clientes},0)),"")),'
            '"CÓDIGO DE CLIENTE INEXISTENTE")'
        )

    grupos = {}
    ignorados = []
    for entrega in entregas:
        produtos = [
            produto
            for produto in produtos_entrega(entrega)
            if catalogo_produtos.get(produto["produto"], {})
            .get("categoria", "").strip().upper() == "CHQ"
        ]
        if not produtos:
            continue
        codigo_cliente = str(
            clientes.get(entrega["cliente"], {}).get("codigo", "") or ""
        ).strip()
        if not codigo_cliente or codigo_cliente == "0":
            nome_cliente = re.sub(r"#\([^)]*\)#", "", entrega.get("cliente", "")).strip()
            if nome_cliente and nome_cliente not in ignorados:
                ignorados.append(nome_cliente)
            continue
        grupo = grupos.setdefault(
            codigo_cliente, {"cliente": entrega["cliente"], "produtos": {}}
        )
        for produto in produtos:
            dados_produto = catalogo_produtos.get(produto["produto"], {})
            codigo_produto = str(dados_produto.get("codigo", "") or "").strip()
            if not codigo_produto:
                codigo_produto = produto["produto"].split(" - ", 1)[0].strip()
            item = grupo["produtos"].setdefault(
                codigo_produto, {"qtd": 0.0, "preco": 0.0}
            )
            item["qtd"] += float(produto.get("qtd") or 0)
            preco = float(produto.get("preco") or 0)
            if preco:
                item["preco"] = preco

    def montar_workbook(codigo_cliente, produtos_grupo):
        workbook = Workbook()
        workbook.calculation.fullCalcOnLoad = True
        planilha = workbook.active
        planilha.title = "PEDIDO"
        planilha.sheet_view.showGridLines = False

        for linha, altura in {
            1: 15.75, 2: 15.75, 3: 23.25, 7: 8.25, 9: 22.5, 11: 15.75,
            12: 30.75, 14: 15.75, 15: 22.5, 16: 15.75, 17: 22.5, 18: 15.75,
            19: 15.75, 20: 15.75, 21: 8.25, 22: 15.75,
        }.items():
            planilha.row_dimensions[linha].height = altura

        planilha.merge_cells("B3:J3")
        titulo = planilha["B3"]
        titulo.value = f"PEDIDO DE VENDA nº {numero_pedido}"
        titulo.font = Font(name="Calibri", size=18, italic=True, color=Color(theme=1))
        titulo.alignment = Alignment(horizontal="center", vertical="center")
        dupla = Side(style="double")
        titulo.border = Border(left=dupla, right=dupla)

        planilha["C6"] = "DADOS DO REPRESENTANTE DO PEDIDO"
        estilo(planilha["C6"], fonte="Arial", italico=True, horizontal=None,
               com_borda=False)

        for coordenada, texto in {
            "C8": "CÓDIGO VENDEDOR",
            "D8": "NOME DO VENDEDOR",
            "E8": "DATA",
        }.items():
            planilha[coordenada] = texto
            estilo(planilha[coordenada], fonte="Arial", tamanho=11, negrito=True,
                   fundo=fill_cabecalho)
        planilha["C9"] = 1677169
        planilha["D9"] = "HAJAN COM. E REPRESENTAÇÕES"
        planilha["E9"] = data_pedido
        for coordenada in ("C9", "D9", "E9"):
            estilo(planilha[coordenada], fonte="Arial", tamanho=11, fundo=fill_amarelo)
        planilha["E9"].number_format = "dd/mm/yyyy"

        planilha.merge_cells("E11:F11")
        planilha.merge_cells("E12:F12")
        for coordenada, texto in {
            "C11": "CNPJ CLIENTE",
            "D11": "CÓDIGO CLIENTE",
            "E11": "NOME CLIENTE",
            "H11": "PRAZO  PAGTO",
        }.items():
            planilha[coordenada] = texto
            estilo(planilha[coordenada], negrito=True, fundo=fill_cabecalho)
        planilha["D12"] = codigo_cliente
        planilha["C12"] = formula_cliente("B")
        planilha["E12"] = formula_cliente("C")
        planilha["H12"] = formula_cliente("D")
        estilo(planilha["D12"], numero="@", fundo=fill_amarelo)
        for coordenada in ("C12", "E12", "H12"):
            estilo(planilha[coordenada], numero="#,##0", fundo=fill_valor)
        planilha["E12"].alignment = Alignment(
            horizontal="center", vertical="center", wrap_text=True
        )

        for linha_rotulo, rotulo_esquerda, rotulo_direita in (
            (14, "ENDEREÇO ENTREGA", "BAIRRO"),
            (16, "CIDADE", "ESTADO"),
        ):
            for linha, coluna_inicio, coluna_fim in (
                (linha_rotulo, 3, 4),
                (linha_rotulo, 5, 9),
                (linha_rotulo + 1, 3, 4),
                (linha_rotulo + 1, 5, 9),
            ):
                planilha.merge_cells(
                    start_row=linha, start_column=coluna_inicio,
                    end_row=linha, end_column=coluna_fim,
                )
            planilha.cell(linha_rotulo, 3, rotulo_esquerda)
            planilha.cell(linha_rotulo, 5, rotulo_direita)
            estilo(planilha.cell(linha_rotulo, 3), negrito=True, horizontal="left",
                   fundo=fill_cabecalho)
            estilo(planilha.cell(linha_rotulo, 5), negrito=True, fundo=fill_cabecalho)
        for coordenada, coluna_lookup, numero in (
            ("C15", "E", None),
            ("E15", "F", None),
            ("C17", "G", None),
            ("E17", "H", "#,##0"),
        ):
            planilha[coordenada] = formula_cliente(coluna_lookup)
            estilo(
                planilha[coordenada],
                horizontal="left" if coordenada.startswith("C") else "center",
                numero=numero,
                fundo=fill_valor,
            )

        planilha["C20"] = "DADOS DO PRODUTO"
        estilo(planilha["C20"], italico=True, horizontal=None, com_borda=False)

        for coluna, texto in enumerate(
            (
                "CODIGO PRODUTO",
                "NOME PRODUTO",
                "VOLUME( CX )",
                "PREÇO (Cx)",
                "Peso Caixa",
                "VALOR PEDIDO",
                "ENTREGA DIA",
            ),
            start=3,
        ):
            planilha.cell(22, coluna, texto)
            estilo(planilha.cell(22, coluna), negrito=True, fundo=fill_cabecalho)

        quantidade_linhas = max(11, len(produtos_grupo))
        for deslocamento in range(quantidade_linhas):
            linha = 23 + deslocamento
            planilha.row_dimensions[linha].height = 15.75
            if deslocamento < len(produtos_grupo):
                codigo_produto, item = produtos_grupo[deslocamento]
                planilha.cell(
                    linha, 3,
                    int(codigo_produto) if codigo_produto.isdigit() else codigo_produto,
                )
                quantidade = item["qtd"]
                planilha.cell(
                    linha, 5,
                    int(quantidade) if float(quantidade).is_integer() else quantidade,
                )
                planilha.cell(linha, 6, item["preco"])
            planilha.cell(
                linha, 4,
                f'=IF(C{linha}="","",VLOOKUP(C{linha},\'CÓDIGOS DOS PRODUTOS\'!A:E,2,0))',
            )
            planilha.cell(
                linha, 7,
                f'=IF(C{linha}="","",VLOOKUP(C{linha},\'CÓDIGOS DOS PRODUTOS\'!A:E,5,0))',
            )
            planilha.cell(linha, 8, f'=IF(E{linha}="","",F{linha}*E{linha})')
            estilo(planilha.cell(linha, 3), fonte="Tahoma", fundo=fill_amarelo)
            estilo(planilha.cell(linha, 4), fonte="Tahoma", horizontal="left",
                   fundo=fill_valor)
            estilo(planilha.cell(linha, 5), numero="#,##0", fundo=fill_amarelo)
            estilo(planilha.cell(linha, 6), numero="#,##0.00", fundo=fill_amarelo)
            estilo(planilha.cell(linha, 7), numero="#,##0.00", fundo=fill_valor)
            estilo(planilha.cell(linha, 8), numero=formato_moeda, fundo=fill_valor)
            estilo(planilha.cell(linha, 9), numero="dd/mm/yyyy", fundo=fill_amarelo)

        linha_total = 23 + quantidade_linhas
        planilha.row_dimensions[linha_total].height = 15.75
        planilha.row_dimensions[linha_total + 1].height = 14.25
        planilha.merge_cells(
            start_row=linha_total, start_column=3, end_row=linha_total, end_column=4
        )
        planilha.cell(linha_total, 3, "TOTAL")
        planilha.cell(linha_total, 5, f"=SUM(E23:E{linha_total - 1})")
        planilha.cell(linha_total, 8, f"=SUM(H23:H{linha_total - 1})")
        estilo(planilha.cell(linha_total, 3), fonte="Tahoma", negrito=True,
               fundo=fill_valor)
        estilo(planilha.cell(linha_total, 5), negrito=True, numero="0.00",
               fundo=fill_valor)
        estilo(planilha.cell(linha_total, 8), negrito=True, numero="0.00",
               fundo=fill_valor)
        for coluna in (4, 6, 7, 9):
            estilo(planilha.cell(linha_total, coluna), fundo=fill_valor)

        linha_entrega = linha_total + 3
        planilha.row_dimensions[linha_entrega].height = 15.75
        planilha.row_dimensions[linha_entrega + 1].height = 8.25
        planilha.cell(linha_entrega, 3, "DADOS SOBRE A ENTREGA (SE NECESSÁRIO)")
        estilo(planilha.cell(linha_entrega, 3), italico=True, horizontal="left",
               com_borda=False)

        linha_pedido = linha_entrega + 2
        planilha.row_dimensions[linha_pedido].height = 15.75
        planilha.cell(linha_pedido, 3, "PEDIDO CLIENTE")
        planilha.cell(linha_pedido, 6, "CARGA PALETIZADA")
        planilha.cell(linha_pedido, 8, "SIM")
        estilo(planilha.cell(linha_pedido, 3), negrito=True, horizontal="left",
               fundo=fill_cabecalho)
        estilo(planilha.cell(linha_pedido, 4), fundo=fill_amarelo)
        estilo(planilha.cell(linha_pedido, 6), negrito=True, fundo=fill_cabecalho)
        estilo(planilha.cell(linha_pedido, 7), fundo=fill_cabecalho)
        estilo(planilha.cell(linha_pedido, 8), numero="#,##0", fundo=fill_amarelo)

        linha_ajudante = linha_pedido + 2
        planilha.row_dimensions[linha_ajudante].height = 15.75
        planilha.merge_cells(
            start_row=linha_ajudante, start_column=3,
            end_row=linha_ajudante, end_column=4,
        )
        planilha.cell(linha_ajudante, 3, "NECESSITA AJUDANTE NA DESCARGA")
        planilha.cell(linha_ajudante, 5, "NÃO")
        estilo(planilha.cell(linha_ajudante, 3), negrito=True, horizontal="left",
               fundo=fill_cabecalho)
        estilo(planilha.cell(linha_ajudante, 5), numero="#,##0", fundo=fill_amarelo)

        linha_observacao = linha_ajudante + 2
        planilha.merge_cells(
            start_row=linha_observacao, start_column=3,
            end_row=linha_observacao + 3, end_column=3,
        )
        planilha.cell(linha_observacao, 3, "OBSERVAÇÃO DA ENTREGA (CASO NECESSITE)")
        estilo(planilha.cell(linha_observacao, 3), negrito=True, wrap=True,
               fundo=fill_cabecalho)
        for deslocamento in range(4):
            linha = linha_observacao + deslocamento
            planilha.row_dimensions[linha].height = 15.75
            planilha.merge_cells(
                start_row=linha, start_column=4, end_row=linha, end_column=9
            )
            for coluna in range(4, 10):
                estilo(planilha.cell(linha, coluna), fundo=fill_amarelo)

        for intervalo in planilha.merged_cells.ranges:
            ancora = planilha.cell(intervalo.min_row, intervalo.min_col)
            for linha in range(intervalo.min_row, intervalo.max_row + 1):
                for coluna in range(intervalo.min_col, intervalo.max_col + 1):
                    celula = planilha.cell(linha, coluna)
                    if celula is not ancora:
                        celula._style = copy.copy(ancora._style)

        ultima_linha = linha_observacao + 6
        planilha.row_dimensions[ultima_linha].height = 15.75
        for coluna in range(2, 11):
            planilha.cell(2, coluna).border = Border(
                left=dupla if coluna == 2 else None,
                right=dupla if coluna == 10 else None,
                top=dupla,
            )
            planilha.cell(ultima_linha, coluna).border = Border(
                left=dupla if coluna == 2 else None,
                right=dupla if coluna == 10 else None,
                bottom=dupla,
            )
        for linha in range(3, ultima_linha):
            planilha.cell(linha, 2).border = Border(left=dupla)
            planilha.cell(linha, 10).border = Border(right=dupla)

        logo = ImagemExcel(BytesIO(base64.b64decode(LOGO_CHQ_B64)))
        logo.anchor = OneCellAnchor(
            _from=AnchorMarker(col=1, colOff=161925, row=1, rowOff=66675),
            ext=XDRPositiveSize2D(1428750, 552450),
        )
        planilha.add_image(logo)

        for coluna, largura in {
            "A": 1.28515625, "B": 3.7109375, "C": 72.7109375, "D": 65.7109375,
            "E": 19.28515625, "F": 19.7109375, "G": 12.5703125, "H": 15.28515625,
            "I": 15.7109375, "J": 3.7109375, "K": 9.28515625,
        }.items():
            planilha.column_dimensions[coluna].width = largura

        planilha.page_setup.orientation = "landscape"
        planilha.page_setup.paperSize = 9
        planilha.page_setup.fitToWidth = 1
        planilha.page_setup.fitToHeight = 0
        planilha.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        planilha.print_options.horizontalCentered = True
        planilha.print_options.verticalCentered = True
        planilha.page_margins.left = 0.0
        planilha.page_margins.right = 0.0
        planilha.page_margins.top = 0.0
        planilha.page_margins.bottom = 0.0
        planilha.page_margins.header = 0.31496062992125984
        planilha.page_margins.footer = 0.31496062992125984

        planilha_produtos = workbook.create_sheet("CÓDIGOS DOS PRODUTOS")
        planilha_produtos.sheet_view.showGridLines = False
        for coluna, texto in enumerate(
            ("Código", "PRODUTO", "Marca", "Tipo de Produto", "Peso Caixa2"), start=1
        ):
            estilo(planilha_produtos.cell(1, coluna, texto), fonte="Tahoma",
                   tamanho=8, negrito=True, fundo=fill_amarelo)
        for linha, (codigo_produto, dados) in enumerate(lista_produtos, start=2):
            planilha_produtos.cell(
                linha, 1,
                int(codigo_produto) if codigo_produto.isdigit() else codigo_produto,
            )
            planilha_produtos.cell(
                linha, 2,
                dados.get("descricao_completa") or dados.get("produto_pedido") or "",
            )
            planilha_produtos.cell(linha, 3, dados.get("linha_marca") or "")
            planilha_produtos.cell(linha, 4, dados.get("estado_fisico") or "")
            planilha_produtos.cell(linha, 5, float(dados.get("peso") or 0))
            estilo(planilha_produtos.cell(linha, 1), fonte="Tahoma", tamanho=8,
                   fundo=fill_amarelo)
            estilo(planilha_produtos.cell(linha, 2), fonte="Tahoma", tamanho=8,
                   horizontal="left", fundo=fill_amarelo)
            for coluna in (3, 4, 5):
                estilo(planilha_produtos.cell(linha, coluna), fonte="Tahoma",
                       tamanho=8, fundo=fill_amarelo)
        planilha_produtos.freeze_panes = "A2"
        for coluna, largura in {
            "A": 10.7109375, "B": 58.28515625, "C": 11.28515625, "D": 13.85546875,
        }.items():
            planilha_produtos.column_dimensions[coluna].width = largura

        planilha_clientes = workbook.create_sheet("CLIENTES CHARQUE")
        planilha_clientes.sheet_view.showGridLines = False
        for coluna, texto in enumerate(
            ("CÓDIGO", "CNPJ", "RAZÃO SOCIAL", "PRAZO", "ENDEREÇO", "BAIRRO",
             "CIDADE ", "UF"),
            start=1,
        ):
            estilo(
                planilha_clientes.cell(1, coluna, texto),
                fonte="Arial",
                numero="@" if coluna in (2, 3, 4) else None,
            )
        for linha, dados in enumerate(linhas_clientes, start=2):
            for coluna, valor in enumerate(dados, start=1):
                estilo(
                    planilha_clientes.cell(linha, coluna, valor),
                    fonte="Arial",
                    horizontal="left" if coluna == 5 else "center",
                    numero="@" if coluna in (2, 3, 4, 5, 6, 8) else None,
                )
        for coluna, largura in {
            "A": 13.5703125, "B": 22.140625, "C": 104.28515625,
            "D": 18.42578125, "E": 40.7109375, "F": 23.140625,
            "G": 40.28515625, "H": 4.5703125,
        }.items():
            planilha_clientes.column_dimensions[coluna].width = largura

        return workbook

    arquivos = []
    for codigo_cliente in sorted(
        grupos, key=lambda valor: (int(valor) if valor.isdigit() else 0, valor)
    ):
        grupo = grupos[codigo_cliente]
        arquivos.append(
            {
                "codigo": codigo_cliente,
                "cliente": grupo["cliente"],
                "workbook": montar_workbook(
                    codigo_cliente,
                    sorted(grupo["produtos"].items(), key=ordenar_por_codigo),
                ),
            }
        )
    return arquivos, ignorados


def gerar_excel_spg(numero_pedido, instrucao, atencao, local_emissao, data_pedido,
                    data_embarque, data_entrega, entregas, clientes, catalogo_produtos):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, Side

    def prazos_de_texto(texto):
        prazos = []
        for parte in re.split(r"[/,;]", str(texto or "")):
            parte = re.sub(r"\s*dias?\s*$", "", parte, flags=re.IGNORECASE).strip()
            if parte and parte not in prazos:
                prazos.append(parte)
        return prazos

    def prazos_da_entrega(produtos):
        prazos = []
        for produto in produtos:
            for parte in prazos_de_texto(produto.get("prazo", "")):
                if parte not in prazos:
                    prazos.append(parte)
        prazos.sort(key=lambda valor: (int(valor) if valor.isdigit() else 10**9, valor))
        return prazos

    def produtos_spg(entrega):
        return [
            produto
            for produto in produtos_entrega(entrega)
            if catalogo_produtos.get(produto["produto"], {})
            .get("categoria", "").strip().upper() == "SPG"
        ]

    if not any(produtos_spg(entrega) for entrega in entregas):
        return None

    linhas = []
    for entrega in entregas:
        produtos = produtos_spg(entrega)
        manual = entrega_peso_manual(entrega)
        if not produtos and not manual:
            continue
        prazos = prazos_da_entrega(produtos)
        if not prazos and manual:
            prazos = prazos_de_texto(
                clientes.get(entrega["cliente"], {}).get("prazo_padrao", "")
            )
        nome = entrega.get("destino") or entrega["cliente"]
        nome = re.sub(r"\s*#\([^)]*\)#\s*$", "", str(nome)).strip()
        nome = re.sub(r"\s*\(\d+\)\s*$", "", nome).strip()
        linhas.append(
            (f"{nome} #(//)#", "/".join(prazos) + " dias" if prazos else "")
        )
    if not linhas:
        return None

    fina = Side(style="thin")
    borda = Border(left=fina, right=fina, top=fina, bottom=fina)

    def estilizar(celula, tamanho=12, negrito=False, horizontal=None, vertical=None,
                  numero=None, com_borda=False):
        celula.font = Font(name="Arial", size=tamanho, bold=negrito)
        celula.alignment = Alignment(horizontal=horizontal, vertical=vertical)
        if numero:
            celula.number_format = numero
        if com_borda:
            celula.border = borda

    numero = str(numero_pedido).strip()
    instrucao = str(instrucao or "").strip()
    atencao = str(atencao or "").strip()
    local_emissao = str(local_emissao or "").strip()

    workbook = Workbook()
    planilha = workbook.active
    planilha.title = "Pedidos"

    planilha["A1"] = f"{local_emissao}, {data_pedido.strftime('%d/%m/%y')}"
    planilha["A2"] = "16.0"
    planilha["B2"] = "V3.3 M56"
    planilha["A3"] = f"Ao: Frigorífico Friboi (Grupo JBS){' ' * 22}At. Sr. {atencao}"
    planilha["B4"] = " "
    planilha["A5"] = f"Ref. Pedido Hajan SPG nº {numero} - {instrucao}"
    planilha["B6"] = "Logistica: Amanda Tomé"
    planilha["A7"] = f"{' ' * 19}Vendedor: 1677169 "
    for linha in range(1, 8):
        for coluna in range(1, 4):
            estilizar(planilha.cell(linha, coluna))
    estilizar(planilha["A2"], numero="@")
    estilizar(planilha["B2"], horizontal="center", vertical="center")
    estilizar(planilha["A7"], negrito=True)
    for coluna in range(1, 4):
        planilha.cell(7, coluna).border = borda

    planilha.merge_cells("A8:A10")
    planilha.merge_cells("B8:B10")
    planilha.merge_cells("C8:C10")
    for coordenada, texto in (("A8", "ENT."), ("B8", "EMPRESA"), ("C8", "PRAZO")):
        estilizar(
            planilha[coordenada],
            horizontal="center",
            vertical="center",
            com_borda=True,
        )
        planilha[coordenada].value = texto
    for linha in range(9, 11):
        for coluna in range(1, 4):
            planilha.cell(linha, coluna).border = borda
        planilha.row_dimensions[linha].height = 24.95

    primeira_linha = 11
    for indice, (empresa, prazo) in enumerate(linhas):
        linha = primeira_linha + indice
        planilha.cell(linha, 1, indice + 1)
        planilha.cell(linha, 2, empresa)
        if prazo:
            planilha.cell(linha, 3, prazo)
        for coluna in range(1, 4):
            estilizar(
                planilha.cell(linha, coluna),
                horizontal="center" if coluna == 1 else ("left" if coluna == 3 else None),
                com_borda=True,
            )
        planilha.row_dimensions[linha].height = 24.95

    linha_total = primeira_linha + len(linhas)
    planilha.cell(linha_total, 2, "TOTAL")
    for coluna in range(1, 4):
        estilizar(planilha.cell(linha_total, coluna), com_borda=True)
    planilha.row_dimensions[linha_total].height = 24.95
    planilha.row_dimensions[linha_total + 1].height = 24.95
    planilha.row_dimensions[linha_total + 2].height = 24.95

    linha_cif = linha_total + 2
    planilha.cell(
        linha_cif,
        1,
        f"CIF  -  EMBARQUE: {data_embarque.strftime('%d/%m/%y')} - "
        f"ENTREGA: {data_entrega.strftime('%d/%m/%y')}",
    )
    estilizar(planilha.cell(linha_cif, 1), tamanho=13, numero="@")

    for coluna, largura in {
        "A": 7.140625, "B": 75.0, "C": 17.42578125, "D": 9.140625,
    }.items():
        planilha.column_dimensions[coluna].width = largura

    planilha.page_setup.orientation = "landscape"
    planilha.page_setup.paperSize = 9
    planilha.page_setup.scale = 60
    planilha.page_margins.left = 0.5118110236220472
    planilha.page_margins.right = 0.5118110236220472
    planilha.page_margins.top = 0.3937007874015748
    planilha.page_margins.bottom = 0.1968503937007874
    planilha.page_margins.header = 0.31496062992125984
    planilha.page_margins.footer = 0.31496062992125984

    return workbook


def gerar_docx_spg(numero_pedido, instrucao, data_embarque):
    from zipfile import ZIP_DEFLATED, ZipFile
    from xml.sax.saxutils import escape

    numero = str(numero_pedido).strip()
    instrucao = str(instrucao or "").strip()
    data_txt = data_embarque.strftime("%d/%m/%y")
    dia_semana = ("Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom")[data_embarque.weekday()]

    def run(texto, negrito=False, tamanho=12, realce=None):
        props = ['<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>']
        if negrito:
            props.append("<w:b/><w:bCs/>")
        props.append(f'<w:sz w:val="{tamanho * 2}"/><w:szCs w:val="{tamanho * 2}"/>')
        if realce:
            props.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{realce}"/>')
        return (
            f"<w:r><w:rPr>{''.join(props)}</w:rPr>"
            f'<w:t xml:space="preserve">{escape(texto)}</w:t></w:r>'
        )

    def paragrafo(*runs):
        return (
            '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>'
            f"</w:pPr>{''.join(runs)}</w:p>"
        )

    corpo = "".join(
        (
            paragrafo(
                run(
                    f"Ajuda - Dados Faturamento Inst {instrucao} (Embarque {data_txt} - "
                    f"Pedido Hajan SPG nº {numero})",
                    negrito=True,
                    tamanho=16,
                )
            ),
            paragrafo(run(f"Prezada Equipe do Faturamento {instrucao},")),
            paragrafo(
                run("Bom dia! "),
                run("Estamos precisando d"),
                run("os "),
                run("Dados do Faturamento ", negrito=True),
                run("(", negrito=True),
                run("Diário", negrito=True),
                run(" de Faturamento, NFs", negrito=True),
                run(",", negrito=True),
                run(" Romaneio", negrito=True),
                run(" da ", negrito=True),
                run("Instrução", negrito=True),
                run(" c/ Peso ", negrito=True),
                run("Peça por Peça", negrito=True),
                run(", ", negrito=True),
                run("Controle de Estadia/", negrito=True, realce="B6D7A8"),
                run("Diário", negrito=True, realce="B6D7A8"),
                run(" de Bordo", negrito=True, realce="B6D7A8"),
                run(" e ", negrito=True),
                run("Termo de Responsabilidade", negrito=True, realce="9FC5E8"),
                run(")", negrito=True),
                run(", "),
                run("vcs conseguem"),
                run(" "),
                run("nos ajudar?"),
            ),
            paragrafo(
                run(f"Inst {instrucao} - Pedido Hajan SPG nº {numero}", negrito=True)
            ),
            paragrafo(run("Bi-truck Caixas c/ 01 NFs Venda ")),
            paragrafo(run(f"Embarque Previsto: {data_txt} ({dia_semana})")),
            paragrafo(run("Favor verificar, aguardamos retorno.")),
            paragrafo(run("Atenciosamente,")),
        )
    )

    documento = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{corpo}"
        '<w:sectPr><w:pgSz w:w="11907" w:h="16839"/>'
        '<w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" '
        'w:header="709" w:footer="709" w:gutter="0"/>'
        '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>'
        "</w:body></w:document>"
    )
    tipos = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.'
        'openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.'
        'openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        "</Types>"
    )
    relacoes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )
    relacoes_documento = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
        "</Relationships>"
    )
    estilos = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:docDefaults><w:rPrDefault><w:rPr>"
        '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
        '<w:sz w:val="24"/><w:szCs w:val="24"/>'
        "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>"
        '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>'
        '</w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
        '<w:name w:val="Normal"/></w:style>'
        "</w:styles>"
    )

    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as pacote:
        pacote.writestr("[Content_Types].xml", tipos)
        pacote.writestr("_rels/.rels", relacoes)
        pacote.writestr("word/document.xml", documento)
        pacote.writestr("word/styles.xml", estilos)
        pacote.writestr("word/_rels/document.xml.rels", relacoes_documento)
    return buffer.getvalue()


def registrar_pedidos_semana(numero_pedido, unidade_carregamento, entregas, clientes,
                             catalogo_produtos, data_embarque, data_entrega):
    if not DATABASE_PATH.is_file() or not data_embarque or not data_entrega:
        return False

    sigla = UNIDADES_DADOS.get(unidade_carregamento, {}).get("sigla", unidade_carregamento) or ""
    categorias_pedido = set(rotulo_categorias(entregas, catalogo_produtos).split("-"))
    registros = []
    for categoria in ("PÇS", "CXS"):
        if categoria not in categorias_pedido:
            continue
        linhas = []
        for indice, entrega, _ in entregas_com_categoria(
            entregas,
            catalogo_produtos,
            categoria,
            incluir_peso_manual=categoria == "PÇS",
        ):
            cliente_linha = entrega.get("cliente", "")
            destino = entrega.get("destino") or cliente_linha
            if entrega_peso_manual(entrega):
                dados_cliente = clientes.get(destino, {})
                destino = cliente_linha = re.sub(r"\s*\(0\)\s*$", "", destino).strip()
            else:
                dados_cliente = clientes.get(cliente_linha, {})
            linhas.append({
                "indice": indice,
                "destino": destino,
                "cliente": cliente_linha,
                "localizacao": "-".join(
                    parte for parte in (dados_cliente.get("cidade", ""), dados_cliente.get("uf", "")) if parte
                ),
            })
        if linhas:
            registros.append((categoria, linhas))

    if not registros:
        return True

    return salvar_registros_semana(
        [
            {
                "numero": str(numero_pedido).strip(),
                "categoria": categoria,
                "sigla": sigla,
                "data_embarque": data_embarque,
                "data_entrega": data_entrega,
                "linhas": linhas,
            }
            for categoria, linhas in registros
        ]
    ) is not None


def salvar_registros_semana(registros, substituir=True):
    if not DATABASE_PATH.is_file() or not registros:
        return 0
    comando = "INSERT OR REPLACE" if substituir else "INSERT OR IGNORE"
    try:
        with conexao_escrita() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS pedidos_semana ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "numero TEXT NOT NULL, "
                "categoria TEXT NOT NULL, "
                "sigla TEXT NOT NULL, "
                "data_embarque TEXT NOT NULL, "
                "data_entrega TEXT NOT NULL, "
                "criado_em TEXT NOT NULL, "
                "linhas TEXT NOT NULL, "
                "UNIQUE (numero, categoria, sigla, data_embarque, data_entrega))"
            )
            criado_em = datetime.now().isoformat(timespec="seconds")
            gravados = 0
            for registro in registros:
                cursor = conn.execute(
                    f"{comando} INTO pedidos_semana "
                    "(numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(registro["numero"]).strip(),
                        registro["categoria"],
                        registro["sigla"],
                        registro["data_embarque"].isoformat(),
                        registro["data_entrega"].isoformat(),
                        criado_em,
                        json.dumps(registro["linhas"], ensure_ascii=False),
                    ),
                )
                gravados += max(cursor.rowcount, 0)
    except sqlite3.Error:
        logging.exception("Falha ao gravar resumos semanais")
        return None
    return gravados


def _caminho_clone_rede(numero):
    return PASTA_CLONES_REDE / f"{nome_seguro_arquivo(numero)}.json"


def registrar_pedido_clonagem(numero, atencao, local, unidade, observacao,
                             data_pedido, data_embarque, data_entrega, entregas):
    # Guarda o pedido inteiro (clientes, produtos, quantidades e preços) para
    # permitir clonar pelo número; os resumos semanais só gravam as linhas.
    numero = str(numero or "").strip()
    if not numero:
        return False
    dados = {
        "numero": numero,
        "atencao": str(atencao or ""),
        "local": str(local or ""),
        "unidade": str(unidade or ""),
        "observacao": str(observacao or ""),
        "data_pedido": data_pedido.strftime("%d/%m/%Y") if data_pedido else "",
        "data_embarque": data_embarque.strftime("%d/%m/%Y") if data_embarque else "",
        "data_entrega": data_entrega.strftime("%d/%m/%Y") if data_entrega else "",
        "entregas": copy.deepcopy(entregas or []),
    }
    conteudo = json.dumps(dados, ensure_ascii=False)
    gravou = False
    if DATABASE_PATH.is_file():
        try:
            with conexao_escrita() as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS pedidos_clonagem ("
                    "numero TEXT PRIMARY KEY, "
                    "criado_em TEXT NOT NULL, "
                    "payload TEXT NOT NULL)"
                )
                conn.execute(
                    "INSERT OR REPLACE INTO pedidos_clonagem (numero, criado_em, payload) "
                    "VALUES (?, ?, ?)",
                    (numero, datetime.now().isoformat(timespec="seconds"), conteudo),
                )
            gravou = True
        except sqlite3.Error:
            logging.exception("Falha ao guardar o pedido nº %s para clonagem", numero)
    try:
        destino = _caminho_clone_rede(numero)
        destino.parent.mkdir(parents=True, exist_ok=True)
        temporario = destino.with_name(f".{destino.name}.{uuid4().hex}.tmp")
        try:
            temporario.write_text(conteudo, encoding="utf-8")
            os.replace(temporario, destino)
        finally:
            temporario.unlink(missing_ok=True)
        gravou = True
    except OSError:
        logging.exception("Falha ao gravar o pedido nº %s no índice da rede", numero)
    return gravou


def _carregar_clone_banco(numero):
    if not DATABASE_PATH.is_file():
        return None
    try:
        with conexao_leitura() as conn:
            linha = conn.execute(
                "SELECT payload FROM pedidos_clonagem WHERE numero = ?", (numero,)
            ).fetchone()
    except sqlite3.Error:
        logging.exception("Falha ao ler o pedido nº %s gravado para clonagem", numero)
        return None
    if not linha:
        return None
    try:
        return json.loads(linha[0])
    except ValueError:
        logging.warning("Conteúdo de clonagem inválido para o pedido nº %s", numero)
        return None


def _carregar_clone_rede(numero):
    caminho = _caminho_clone_rede(numero)
    try:
        if not caminho.is_file():
            return None
        return json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logging.exception("Falha ao ler o pedido nº %s no índice da rede", numero)
        return None


# Pedidos antigos só existem em PDF (gerados antes do índice de clonagem).
# Nesse caso o pedido é remontado lendo o próprio PDF da pasta de pedidos.
_TOKENS_PDF = re.compile(
    rb"\((?:\\.|[^()\\])*\)"
    rb"|[-+]?\d*\.?\d+"
    rb"|/[^\s/\[\]<>(){}]+"
    rb"|[\[\]]"
    rb"|[A-Za-z'\"*]+",
    re.S,
)
RE_ENTREGA_PDF = re.compile(
    r"^PEDIDO:\s*\S+.*?\s-\s(\d+)\s*[ªº°]?\s*entrega\b(.*)$", re.IGNORECASE
)
RE_OPERACAO_PDF = re.compile(
    r"Opera[çc][ãa]o\s*(\d+)(?:\s*:\s*(.+?)\s*\((\d+)\))?", re.IGNORECASE
)
RE_CLIENTE_PDF = re.compile(r"Cliente:\s*(.+?)\s*\((\d+)\)", re.IGNORECASE)
RE_PRODUTO_PDF = re.compile(r"^(-?\d{1,7})\s*-\s*(.+)$")
RE_QTDE_PDF = re.compile(
    r"(\d{1,3}(?:\.\d{3})+|\d+)\s*(kg|p[çc]|cx|un)\s+(\d+(?:[.,]\d{2}))",
    re.IGNORECASE,
)
RE_PRAZO_PDF = re.compile(r"\d+(?:\s*/\s*\d+)*\s*DIAS?\b", re.IGNORECASE)
RE_PESO_PDF = re.compile(r"Peso Total[^:]*:\s*([\d.]+)", re.IGNORECASE)
RE_ATENCAO_PDF = re.compile(
    r"\bAt\b\.?\s*:?\s*Sr\b\.?\s*:?\s*([^|]+)", re.IGNORECASE
)
RE_TITULO_PDF = re.compile(
    r"Pedido HAJAN\s+\S+\s+n[ºo°]\s*(\S+)\s*-\s*R\d+\s+(\S+)", re.IGNORECASE
)
RE_CIF_PDF = re.compile(
    r"EMBARQUE:\s*(\d{2}/\d{2}/\d{2,4}).*?ENTREGA:\s*(\d{2}/\d{2}/\d{2,4})",
    re.IGNORECASE,
)


def _pdf_desescapar(bruto):
    saida = bytearray()
    i = 0
    mapa = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
    while i < len(bruto):
        caractere = bruto[i]
        if caractere == 0x5C and i + 1 < len(bruto):
            proximo = bruto[i + 1]
            if proximo in mapa:
                saida.append(mapa[proximo])
                i += 2
                continue
            if 0x30 <= proximo <= 0x37:
                octal = bruto[i + 1:i + 4]
                fim = 0
                while fim < len(octal) and 0x30 <= octal[fim] <= 0x37:
                    fim += 1
                saida.append(int(octal[:fim], 8) & 0xFF)
                i += 1 + fim
                continue
            saida.append(proximo)
            i += 2
            continue
        saida.append(caractere)
        i += 1
    return saida.decode("latin-1")


def _pdf_blocos(conteudo):
    x = y = 0.0
    pilha = []
    texto_tj = []
    saida = []
    for token in _TOKENS_PDF.findall(conteudo):
        if token == b"BT":
            # BT reinicia a matriz de texto; sem isso o Td de cada célula é
            # somado ao anterior e as linhas saem fora de ordem.
            x = y = 0.0
            continue
        if token == b"[":
            texto_tj = []
            pilha = []
            continue
        if token == b"]":
            continue
        if token[:1] == b"(":
            texto_tj.append(_pdf_desescapar(token[1:-1]))
            continue
        if re.fullmatch(rb"[-+]?\d*\.?\d+", token):
            pilha.append(float(token))
            continue
        if token[:1] == b"/":
            continue
        if token == b"Tm":
            if len(pilha) >= 6:
                x, y = pilha[-2], pilha[-1]
        elif token in (b"Td", b"TD"):
            if len(pilha) >= 2:
                x += pilha[-2]
                y += pilha[-1]
        elif token in (b"Tj", b"TJ", b"'", b'"'):
            texto = "".join(texto_tj).strip()
            if texto:
                saida.append((round(y, 1), round(x, 1), texto))
            texto_tj = []
        pilha = []
    return saida


def _pdf_linhas_conteudo(conteudo):
    itens = _pdf_blocos(conteudo)
    itens.sort(key=lambda item: (-item[0], item[1]))
    resultado = []
    atual_y = None
    atual = []
    for y, x, texto in itens:
        if atual_y is None or abs(y - atual_y) <= 2.5:
            atual.append((x, texto))
            atual_y = y if atual_y is None else atual_y
        else:
            resultado.append(" ".join(t for _, t in sorted(atual)))
            atual = [(x, texto)]
            atual_y = y
    if atual:
        resultado.append(" ".join(t for _, t in sorted(atual)))
    return resultado


def _pdf_linhas(caminho):
    dados = caminho.read_bytes()
    linhas = []
    for achado in re.finditer(rb"stream\r?\n(.*?)endstream", dados, re.S):
        bruto = achado.group(1)
        try:
            conteudo = zlib.decompress(bruto)
        except zlib.error:
            conteudo = bruto
        # Fontes embutidas também são streams; só conteúdo de página tem texto.
        if b"BT" not in conteudo or (b"Tj" not in conteudo and b"TJ" not in conteudo):
            continue
        linhas.extend(_pdf_linhas_conteudo(conteudo))
    return linhas


def _pdf_do_numero(numero, categoria=None):
    padrao = re.compile(
        rf"^Pedido HAJAN\b.*?n[ºo°]\s*{re.escape(numero)}(?!\d)", re.IGNORECASE
    )
    # O mesmo número pode ter um PDF CXS e outro PÇS; o tipo escolhido desempata.
    tipo = normalizar_busca(categoria).upper() if categoria else ""
    melhor = None
    for pasta in PASTAS_PDFS:
        try:
            nomes = [pasta / nome for nome in os.listdir(pasta)]
        except OSError:
            continue
        for caminho in nomes:
            if caminho.suffix.lower() != ".pdf" or not padrao.match(caminho.name):
                continue
            if tipo and tipo not in normalizar_busca(caminho.name).upper():
                continue
            try:
                instante = caminho.stat().st_mtime
            except OSError:
                continue
            if melhor is None or instante > melhor[0]:
                melhor = (instante, caminho)
    return melhor[1] if melhor else None


def _data_pdf(texto):
    partes = str(texto or "").strip().split("/")
    if len(partes) != 3 or not all(partes):
        return ""
    dia, mes, ano = partes
    if len(ano) == 2:
        ano = f"20{ano}"
    return f"{dia}/{mes}/{ano}"


def _numero_pdf(texto):
    limpo = str(texto or "").strip()
    if "," in limpo:
        limpo = limpo.replace(".", "").replace(",", ".")
    try:
        return float(limpo)
    except ValueError:
        return None


def _cliente_pdf(por_codigo, nome, codigo):
    nome = re.sub(r"\s+", " ", str(nome or "")).strip(" .-")
    codigo = str(codigo or "").strip()
    # Vários clientes ESC usam o código 0 no PDF; nesse caso só o nome identifica.
    if codigo and codigo != "0":
        achado = por_codigo.get(codigo)
        if achado:
            return achado
    alvo = normalizar_busca(nome)
    for opcao in CLIENTES_LISTA:
        if normalizar_busca(opcao).split(" (")[0] == alvo:
            return opcao
    return f"{nome} ({codigo})" if nome else ""


def _produto_pdf(por_codigo, codigo, unidade):
    opcoes = por_codigo.get(str(codigo or "").strip()) or []
    alvo = normalizar_busca(unidade)
    for chave, dados in opcoes:
        if normalizar_busca(dados.get("unidade") or "") == alvo:
            return chave
    return opcoes[0][0] if opcoes else None


def _unidade_pdf(linhas):
    texto = "\n".join(linhas)
    achado = re.search(r"Unidade de Carregamento:\s*(.+)", texto, re.IGNORECASE)
    if achado:
        valor = achado.group(1).strip()
        if valor in UNIDADES_LISTA:
            return valor
        for chave in UNIDADES_LISTA:
            if chave.split(" - ", 1)[0].strip().upper() == valor.upper():
                return chave
    sigla = ""
    for linha in linhas[:20]:
        titulo = RE_TITULO_PDF.search(linha)
        if titulo:
            sigla = titulo.group(2)
            break
    for chave in UNIDADES_LISTA:
        if chave.split(" - ", 1)[0].strip().upper() == sigla.upper():
            return chave
    return ""


def _atencao_pdf(linhas):
    for linha in linhas[:20]:
        achado = RE_ATENCAO_PDF.search(linha)
        if achado:
            return achado.group(1).strip()
    return ""


def _cabecalho_pdf(linhas):
    for linha in linhas[:20]:
        achados = re.findall(
            r"([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.\s]*?)\s*,\s*(\d{2}/\d{2}/\d{2,4})", linha
        )
        if not achados:
            continue
        local, data = achados[-1]
        partes = local.split()
        fim = len(partes)
        while fim > 0 and not partes[fim - 1].isupper():
            fim -= 1
        local = " ".join(partes[fim:]).strip(" .-")
        return local, _data_pdf(data)
    return "", ""


def _observacao_pdf(linhas):
    for indice, linha in enumerate(linhas):
        if normalizar_busca(linha) not in ("observacao:", "observação:"):
            continue
        coletadas = []
        for seguinte in linhas[indice + 1:indice + 21]:
            if re.match(
                r"^(?:Observações Logísticas|Obs\.:|Atenção:|Peso Carga|"
                r"PEDIDO:|1677169 - Hajan)",
                seguinte,
                re.IGNORECASE,
            ):
                break
            coletadas.append(seguinte)
        texto = "\n".join(coletadas).strip()
        if texto.casefold() in ("", "sem observações.", "sem observacoes."):
            return ""
        return texto
    return ""


def _clone_de_pdf(numero, categoria=None):
    caminho = _pdf_do_numero(numero, categoria)
    if not caminho:
        return None
    try:
        linhas = _pdf_linhas(caminho)
    except OSError:
        logging.exception("Falha ao ler o PDF do pedido nº %s", numero)
        return None

    clientes_codigo = {}
    for nome, dados in CLIENTES_DADOS.items():
        codigo = str(dados.get("codigo") or "").strip()
        if codigo:
            clientes_codigo.setdefault(codigo, nome)
    produtos_codigo = {}
    for chave, dados in PRODUTOS_DADOS.items():
        produtos_codigo.setdefault(str(dados.get("codigo") or "").strip(), []).append(
            (chave, dados)
        )

    avisos = []
    entregas = []
    indices = [
        indice for indice, linha in enumerate(linhas) if RE_ENTREGA_PDF.match(linha)
    ]
    for posicao, inicio in enumerate(indices):
        fim = indices[posicao + 1] if posicao + 1 < len(indices) else len(linhas)
        bloco = linhas[inicio:fim]
        cabeca = RE_ENTREGA_PDF.match(bloco[0])
        indice_entrega = int(cabeca.group(1))
        operacao_numero = 3
        destino = ""
        # A operação pode quebrar em mais de uma linha quando o destino é longo.
        achado_operacao = RE_OPERACAO_PDF.search(" ".join(bloco[:3]))
        if achado_operacao:
            operacao_numero = int(achado_operacao.group(1))
            if achado_operacao.group(2) and achado_operacao.group(3):
                destino = _cliente_pdf(
                    clientes_codigo,
                    achado_operacao.group(2),
                    achado_operacao.group(3),
                )

        cliente = ""
        for linha in bloco[:4]:
            achado_cliente = RE_CLIENTE_PDF.search(linha)
            if achado_cliente:
                cliente = _cliente_pdf(
                    clientes_codigo, achado_cliente.group(1), achado_cliente.group(2)
                )
                break
        if not cliente:
            cliente = CLIENTES_LISTA[0] if CLIENTES_LISTA else ""
            avisos.append(f"Entrega {indice_entrega}: não achei o cliente no PDF.")
        if operacao_numero == 3 and not destino:
            destino = cliente

        produtos = []
        for indice_linha, linha in enumerate(bloco):
            achado_produto = RE_PRODUTO_PDF.match(linha)
            if not achado_produto:
                continue
            codigo = achado_produto.group(1)
            if codigo not in produtos_codigo:
                continue
            # A descrição pode quebrar em várias linhas; qtde/preço vêm junto.
            trecho = [linha]
            for seguinte in bloco[indice_linha + 1:indice_linha + 4]:
                if (
                    RE_PRODUTO_PDF.match(seguinte)
                    or RE_PESO_PDF.search(seguinte)
                    or RE_CLIENTE_PDF.search(seguinte)
                    or seguinte.startswith("PEDIDO:")
                ):
                    break
                trecho.append(seguinte)
            texto_produto = " ".join(trecho)
            achado_qtde = RE_QTDE_PDF.search(texto_produto)
            if not achado_qtde:
                avisos.append(
                    f"Entrega {indice_entrega}: não achei a qtde/preço do "
                    f"produto {codigo}."
                )
                continue
            chave_produto = _produto_pdf(
                produtos_codigo, codigo, achado_qtde.group(2)
            )
            if not chave_produto:
                avisos.append(
                    f"Entrega {indice_entrega}: o produto {codigo} não está "
                    "no cadastro."
                )
                continue
            quantidade = int(achado_qtde.group(1).replace(".", ""))
            preco = _numero_pdf(achado_qtde.group(3)) or 0.0
            achado_prazo = RE_PRAZO_PDF.search(texto_produto)
            prazo = achado_prazo.group(0).strip() if achado_prazo else ""
            produtos.append(
                novo_produto(chave_produto, PRODUTOS_DADOS, quantidade, preco, prazo)
            )

        entrega = {
            "_id": uuid4().hex,
            "cliente": cliente,
            "destino": destino,
            "operacao": f"Operação {operacao_numero}" + (f": {destino}" if destino else ""),
            "produtos": produtos,
        }
        achado_peso = None
        for linha in bloco:
            achado_peso = RE_PESO_PDF.search(linha)
            if achado_peso:
                break
        if not produtos:
            if cliente.upper().startswith("ESC ") and achado_peso:
                entrega["peso_manual"] = float(achado_peso.group(1).replace(".", ""))
            else:
                avisos.append(
                    f"Entrega {indice_entrega}: não achei os itens no PDF."
                )
        entregas.append(entrega)

    if not entregas:
        return None

    lugar, data_pedido = _cabecalho_pdf(linhas)
    data_embarque = data_entrega = ""
    texto_completo = "\n".join(linhas)
    achado_cif = RE_CIF_PDF.search(texto_completo)
    if achado_cif:
        data_embarque = _data_pdf(achado_cif.group(1))
        data_entrega = _data_pdf(achado_cif.group(2))
    else:
        avisos.append("Não achei as datas de embarque/entrega no PDF.")

    if any(
        not entrega.get("produtos") and "peso_manual" not in entrega
        for entrega in entregas
    ):
        avisos.append("Confira as entregas sem itens antes de gerar.")

    return {
        "numero": str(numero),
        "atencao": _atencao_pdf(linhas) or "Helcio Venancio",
        "local": lugar or "Natal",
        "unidade": _unidade_pdf(linhas),
        "observacao": _observacao_pdf(linhas),
        "data_pedido": data_pedido,
        "data_embarque": data_embarque,
        "data_entrega": data_entrega,
        "entregas": entregas,
        "_fonte": "pdf",
        "_avisos": list(dict.fromkeys(avisos)),
    }


def carregar_pedido_clonagem(numero, categoria=None):
    numero = str(numero or "").strip()
    if not numero:
        return None
    return (
        _carregar_clone_banco(numero)
        or _carregar_clone_rede(numero)
        or _clone_de_pdf(numero, categoria)
    )


def aplicar_pedido_clonado(dados):
    st.session_state["num_pedido_txt"] = str(dados.get("numero") or "")
    st.session_state["atencao_sr_txt"] = dados.get("atencao") or "Helcio Venancio"
    st.session_state["local_emissao_txt"] = dados.get("local") or "Natal"
    for chave, campo in (
        ("data_emissao_txt", "data_pedido"),
        ("data_embarque_txt", "data_embarque"),
        ("data_entrega_txt", "data_entrega"),
    ):
        if dados.get(campo):
            st.session_state[chave] = dados[campo]
    if dados.get("unidade") in UNIDADES_LISTA:
        st.session_state["unidade_carregamento"] = dados["unidade"]
    st.session_state["observacao"] = dados.get("observacao") or ""
    # Identificadores novos mantêm os widgets do pedido clonado independentes.
    st.session_state.entregas = [
        duplicar_entrega(entrega) for entrega in copy.deepcopy(dados.get("entregas") or [])
    ]
    # Semeia os controles com o que veio do pedido clonado; sem isso o widget
    # de destino/prazo reseta para o cliente e apaga o destino e o prazo.
    for entrega in st.session_state.entregas:
        entrega_id = entrega["_id"]
        cliente = str(entrega.get("cliente") or "")
        if cliente:
            st.session_state[f"_cliente_prazo_{entrega_id}"] = cliente
        if str(entrega.get("operacao") or "").startswith("Operação 3"):
            st.session_state[f"_op3_cliente_{entrega_id}"] = cliente
            st.session_state[f"op3_dest_{entrega_id}"] = (
                entrega.get("destino") or cliente
            )


# cache_resource compartilha as tuplas do SQLite (somente leitura) em vez de
# copiar tudo a cada leitura, como o cache_data faria.
@st.cache_resource(show_spinner=False, max_entries=2 if MODO_RAM_BAIXA else 6)
def _carregar_pedidos_semana(assinatura, inicio, fim):
    if not DATABASE_PATH.is_file():
        return []
    try:
        with conexao_leitura() as conn:
            return conn.execute(
                "SELECT numero, categoria, sigla, data_embarque, data_entrega, linhas "
                "FROM pedidos_semana "
                "WHERE data_entrega BETWEEN ? AND ? "
                "ORDER BY CAST(numero AS INTEGER), numero COLLATE NOCASE, sigla, categoria",
                (inicio.isoformat(), fim.isoformat()),
            ).fetchall()
    except sqlite3.Error:
        return []


def carregar_pedidos_semana(inicio, fim, assinatura=None):
    return _carregar_pedidos_semana(
        assinatura if assinatura is not None else assinatura_banco(), inicio, fim
    )


def agrupar_pedidos_semana(registros):
    grupos = {}
    for numero, categoria, sigla, data_embarque, data_entrega, linhas in registros:
        if categoria != "PÇS":
            continue
        chave = (numero, sigla, data_embarque, data_entrega)
        grupo = grupos.setdefault(chave, {
            "numero": numero,
            "sigla": sigla,
            "data_embarque": date.fromisoformat(data_embarque),
            "data_entrega": date.fromisoformat(data_entrega),
            "categorias": {},
        })
        grupo["categorias"][categoria] = {
            "numero": numero,
            "categoria": categoria,
            "sigla": sigla,
            "data_embarque": date.fromisoformat(data_embarque),
            "data_entrega": date.fromisoformat(data_entrega),
            "linhas": json.loads(linhas),
        }
    return list(grupos.values())


def rotulo_pedido_semana(grupo):
    sigla = f"R0 {grupo['sigla']}" if grupo["sigla"] else "sem unidade"
    return (
        f"{grupo['numero']} · {sigla} · "
        f"embarque {grupo['data_embarque']:%d/%m/%y} · "
        f"entrega {grupo['data_entrega']:%d/%m/%y} · PÇS"
    )


TITULO_RESUMO_SEMANA = re.compile(
    r"^Pedido HAJAN\s+(PÇS|CXS)\s+n[ºo°]\s*(.+?)\s*-\s*(?:R\d+\s+)?([A-Za-z0-9_-]+)\s*$",
    re.IGNORECASE,
)
CIF_RESUMO_SEMANA = re.compile(
    r"EMBARQUE:\s*(\d{2})/(\d{2})/(\d{2}).*?ENTREGA:\s*(\d{2})/(\d{2})/(\d{2})",
    re.IGNORECASE,
)
NOME_RESUMO_SEMANA = re.compile(
    r"^ResumoSemanal - Entrega Semana Nº \d+-\d+\.xlsx$", re.IGNORECASE
)


def _celula_texto(planilha, linha, coluna):
    valor = planilha.cell(linha, coluna).value
    return str(valor).strip() if valor is not None else ""


def _indice_linha_resumo(texto):
    achado = re.search(r"(\d+)\s*$", texto.split("|")[0])
    return int(achado.group(1)) if achado else 0


def _linha_resumo(texto):
    partes = texto.split("|")
    if len(partes) >= 3:
        destino = " | ".join(parte.strip() for parte in partes[1:-1])
        localizacao = partes[-1].strip()
    else:
        destino = partes[-1].strip()
        localizacao = ""
    return {
        "indice": _indice_linha_resumo(texto),
        "rotulo": partes[0].strip(),
        "destino": destino,
        "localizacao": localizacao,
    }


def _nome_cliente_resumo(destino):
    return re.sub(r"#\([^)]*\)#", "", destino).strip()


def _normalizar_nome_resumo(texto):
    return " ".join(texto.replace("\xa0", " ").split()).casefold()


def _nomes_compativeis(cliente, destino):
    nome = _normalizar_nome_resumo(cliente)
    base = _normalizar_nome_resumo(_nome_cliente_resumo(destino))
    return bool(nome and base) and (
        nome == base or nome.startswith(base) or base.startswith(nome)
    )


def _blocos_cliente_resumo(planilha):
    blocos = []
    for coluna in (1, 4, 7):
        atual = []
        for linha in range(1, planilha.max_row + 1):
            texto = _celula_texto(planilha, linha, coluna)
            partes = texto.split("|")
            if len(partes) >= 2 and re.match(
                r"^\s*(?:\S+\s+)?\d+\s*ª?\s*Entrega\b", texto, re.IGNORECASE
            ):
                cliente = partes[1].strip()
                if cliente:
                    localizacao = partes[-1].strip() if len(partes) >= 3 else ""
                    atual.append((cliente, localizacao))
                    continue
            if atual:
                blocos.append(atual)
                atual = []
        if atual:
            blocos.append(atual)
    return blocos


def _aplicar_clientes_resumo(pedidos, planilha_cliente):
    if planilha_cliente is None:
        return
    candidatos = _blocos_cliente_resumo(planilha_cliente)
    avaliacoes = []
    for ordem, pedido in enumerate(pedidos):
        bases = [item["destino"] for item in pedido["linhas"]]
        for indice_bloco, bloco in enumerate(candidatos):
            if len(bloco) != len(bases):
                continue
            acertos = sum(
                1 for (cliente, _), destino in zip(bloco, bases)
                if _nomes_compativeis(cliente, destino)
            )
            taxa = acertos / len(bases)
            if taxa >= 0.8:
                avaliacoes.append((taxa, indice_bloco, ordem))
    usados = set()
    atribuidos = set()
    for taxa, indice_bloco, ordem in sorted(avaliacoes, reverse=True):
        if indice_bloco in usados or ordem in atribuidos:
            continue
        for item, (cliente, localizacao) in zip(
            pedidos[ordem]["linhas"], candidatos[indice_bloco]
        ):
            item["cliente"] = cliente
            item["localizacao_cliente"] = localizacao
        usados.add(indice_bloco)
        atribuidos.add(ordem)


def _extrair_bloco_resumo(planilha, linha_titulo, coluna):
    titulo = TITULO_RESUMO_SEMANA.match(_celula_texto(planilha, linha_titulo, coluna))
    if not titulo:
        return None

    linha_cif = 0
    for linha in range(linha_titulo + 1, planilha.max_row + 1):
        texto = _celula_texto(planilha, linha, coluna)
        if texto.upper().startswith("CIF"):
            linha_cif = linha
            break
        if not texto:
            break
    if not linha_cif:
        return None

    datas = CIF_RESUMO_SEMANA.search(_celula_texto(planilha, linha_cif, coluna))
    if not datas:
        return None
    data_embarque = date(2000 + int(datas.group(3)), int(datas.group(2)), int(datas.group(1)))
    data_entrega = date(2000 + int(datas.group(6)), int(datas.group(5)), int(datas.group(4)))

    linhas = []
    for linha in range(linha_titulo + 1, linha_cif):
        texto = _celula_texto(planilha, linha, coluna)
        if not texto:
            continue
        item = _linha_resumo(texto)
        item["cliente"] = _nome_cliente_resumo(item["destino"])
        linhas.append(item)

    if not linhas:
        return None
    return {
        "numero": titulo.group(2).strip(),
        "categoria": titulo.group(1).upper(),
        "sigla": titulo.group(3).strip().upper(),
        "data_embarque": data_embarque,
        "data_entrega": data_entrega,
        "linhas": linhas,
    }


def _abrir_planilhas(caminho):
    from openpyxl import load_workbook

    try:
        return load_workbook(caminho, data_only=True)
    except Exception:
        logging.exception("Falha ao ler resumo para importação: %s", caminho)
        return None


def extrair_pedidos_resumo_semanal(caminho):
    workbook = _abrir_planilhas(caminho)
    if workbook is None:
        return []
    try:
        abas = {}
        for nome in workbook.sheetnames:
            chave = nome.strip().lower()
            if chave.startswith("peças cliente"):
                abas["peças_cliente"] = workbook[nome]
            elif chave.startswith("caixas cliente"):
                abas["caixas_cliente"] = workbook[nome]
            elif chave.startswith("peça"):
                abas["peças"] = workbook[nome]
            elif chave.startswith("caixa"):
                abas["caixas"] = workbook[nome]

        pedidos = []
        for aba_pedidos, aba_clientes in (
            ("peças", "peças_cliente"),
            ("caixas", "caixas_cliente"),
        ):
            planilha = abas.get(aba_pedidos)
            if planilha is None:
                continue
            bloco_inicio = len(pedidos)
            for linha in range(1, planilha.max_row + 1):
                for coluna in (1, 4, 7):
                    pedido = _extrair_bloco_resumo(planilha, linha, coluna)
                    if pedido:
                        pedidos.append(pedido)
            _aplicar_clientes_resumo(pedidos[bloco_inicio:], abas.get(aba_clientes))
        return pedidos
    finally:
        workbook.close()


def extrair_resumo_pedido(caminho):
    workbook = _abrir_planilhas(caminho)
    if workbook is None:
        return []
    try:
        pedido = _extrair_bloco_resumo(workbook.active, 1, 1)
        return [pedido] if pedido else []
    finally:
        workbook.close()


def _unicos_resumos(pedidos):
    unicos = {}
    for pedido in pedidos:
        chave = (
            pedido["numero"],
            pedido["categoria"],
            pedido["sigla"],
            pedido["data_embarque"],
            pedido["data_entrega"],
        )
        unicos[chave] = pedido
    return list(unicos.values())


def importar_resumos_semana():
    pasta = PASTAS_RESUMO_EXCEL["PÇS"]
    if not pasta.is_dir():
        return 0
    semanais = []
    avulsos = []
    for caminho in sorted(pasta.glob("*.xlsx")):
        if NOME_RESUMO_SEMANA.match(caminho.name):
            semanais.extend(extrair_pedidos_resumo_semanal(caminho))
        else:
            avulsos.extend(extrair_resumo_pedido(caminho))
    semanais = _unicos_resumos(semanais)
    avulsos = _unicos_resumos(avulsos)
    importados = salvar_registros_semana(semanais, substituir=True)
    if importados is None:
        return None
    avulsos_gravados = salvar_registros_semana(avulsos, substituir=False)
    if avulsos_gravados is None:
        return None
    return importados + avulsos_gravados


BANDAS_MODELO_SEMANA = {
    True: ((1, 25), (27, 51), (53, 77)),
    False: ((1, 25), (27, 51), (53, 77), (78, 102), (104, 128), (130, 154)),
}


def borda_semana(esquerda, topo=None, base=None, direita="thin"):
    from openpyxl.styles import Border, Side

    return Border(
        left=Side(style=esquerda),
        right=Side(style=direita) if direita else Side(),
        top=Side(style=topo) if topo else Side(),
        bottom=Side(style=base) if base else Side(),
    )


def linhas_bandas_semana(grupos, com_titulo):
    modelo = BANDAS_MODELO_SEMANA[com_titulo]
    bandas = []
    deslocado = False
    for indice, grupo in enumerate(grupos):
        altura = max(25, max((len(pedido["linhas"]) + 2 for pedido in grupo), default=0))
        inicio = None
        if not deslocado and indice < len(modelo):
            inicio_modelo, fim_modelo = modelo[indice]
            if fim_modelo - inicio_modelo + 1 >= altura:
                inicio, fim = inicio_modelo, fim_modelo
            else:
                deslocado = True
        if inicio is None:
            inicio = bandas[-1][1] + 2 if bandas else 1
            fim = inicio + altura - 1
        bandas.append((inicio, fim))
    return bandas


def escrever_bloco_semana(planilha, linha_inicio, linha_fim, coluna, pedido, com_titulo):
    from openpyxl.styles import Font

    linhas = pedido["linhas"] if pedido else []
    segunda = coluna + 1
    for linha in range(linha_inicio, linha_fim + 1):
        topo = "medium" if linha == linha_inicio else None
        base = "medium" if linha == linha_fim else None
        planilha.cell(linha, coluna).border = borda_semana(
            "medium", topo=topo, base=base, direita="thin" if com_titulo else None
        )
        planilha.cell(linha, segunda).border = borda_semana(
            "thin", topo=topo, base=base, direita="medium"
        )

    if not pedido:
        if com_titulo:
            planilha.cell(linha_inicio + 1, coluna).border = borda_semana("medium", topo="thin")
        return

    if com_titulo:
        celula_titulo = planilha.cell(
            linha_inicio,
            coluna,
            titulo_resumo_excel(pedido["categoria"], pedido["numero"], pedido["sigla"]),
        )
        celula_titulo.font = Font(name="Calibri", size=11, bold=True)
        for deslocamento, item in enumerate(linhas):
            rotulo = item.get("rotulo") or str(item["indice"])
            texto = f"{rotulo} | {item['destino']}"
            if item["localizacao"]:
                texto += f" | {item['localizacao']}"
            celula = planilha.cell(linha_inicio + 1 + deslocamento, coluna, texto)
            celula.font = Font(name="Calibri", size=11)
            celula.border = borda_semana(
                "medium", topo="thin", base="thin" if deslocamento == len(linhas) - 1 else None
            )
        celula_cif = planilha.cell(
            linha_inicio + len(linhas) + 1,
            coluna,
            f"CIF  -  EMBARQUE: {pedido['data_embarque']:%d/%m/%y} - "
            f"ENTREGA: {pedido['data_entrega']:%d/%m/%y}",
        )
        celula_cif.font = Font(name="Calibri", size=11)
        celula_cif.border = borda_semana("medium")
        return

    for deslocamento, item in enumerate(linhas):
        nome_cliente = re.sub(r"#\([^)]*\)#", "", item["cliente"]).strip()
        texto = f"{item['indice']}ª Entrega | {nome_cliente}"
        localizacao_cliente = item.get("localizacao_cliente", item["localizacao"])
        if localizacao_cliente:
            texto += f" | {localizacao_cliente}"
        celula = planilha.cell(linha_inicio + 1 + deslocamento, coluna, texto)
        celula.font = Font(name="Calibri", size=11)
        celula.border = borda_semana("medium", direita=None)


def gerar_resumo_semanal_excel(pedidos, semana):
    from openpyxl import Workbook

    larguras = {
        "A": 60.7109375, "B": 34.7109375, "C": 1.7109375,
        "D": 60.7109375, "E": 34.7109375, "F": 1.7109375,
        "G": 60.7109375, "H": 34.7109375, "I": 9.140625,
    }
    colunas = (1, 4, 7)
    definicoes = (
        ("Peças", "PÇS", True, "RESUMO PEDIDOS PEÇAS", 77),
        ("Caixas", "CXS", True, "RESUMO PEDIDOS CAIXAS", 77),
        ("Peças Cliente", "PÇS", False, None, 154),
        ("Caixas Cliente", "CXS", False, None, 154),
    )
    workbook = Workbook()
    workbook.remove(workbook.active)

    for nome, categoria, com_titulo, cabecalho, altura_minima in definicoes:
        planilha = workbook.create_sheet(nome)
        for coluna, largura in larguras.items():
            planilha.column_dimensions[coluna].width = largura
        planilha.page_setup.orientation = "landscape"
        planilha.page_setup.paperSize = 9
        planilha.page_setup.scale = 50
        planilha.page_margins.left = 0.15748031496062992
        planilha.page_margins.right = 0.11811023622047245
        planilha.page_margins.top = 0.2755905511811024
        planilha.page_margins.bottom = 0.0
        planilha.page_margins.header = 0.0
        planilha.page_margins.footer = 0.0
        if cabecalho:
            planilha.oddHeader.center.text = f"&B&U{cabecalho} - SEMANA Nº {semana}"

        pedidos_categoria = sorted(
            (pedido for pedido in pedidos if pedido["categoria"] == categoria),
            key=lambda pedido: (
                int(pedido["numero"]) if str(pedido["numero"]).isdigit() else float("inf"),
                str(pedido["numero"]),
                str(pedido["sigla"]),
            ),
        )
        grupos = [
            pedidos_categoria[inicio:inicio + len(colunas)]
            for inicio in range(0, len(pedidos_categoria), len(colunas))
        ]
        for _ in range(len(BANDAS_MODELO_SEMANA[com_titulo]) - len(grupos)):
            grupos.append([])

        ultima_linha = 0
        for grupo, (linha_inicio, linha_fim) in zip(
            grupos, linhas_bandas_semana(grupos, com_titulo)
        ):
            for posicao, coluna in enumerate(colunas):
                pedido = grupo[posicao] if posicao < len(grupo) else None
                escrever_bloco_semana(
                    planilha, linha_inicio, linha_fim, coluna, pedido, com_titulo
                )
            ultima_linha = linha_fim
        for linha in range(1, max(altura_minima, ultima_linha) + 1):
            planilha.row_dimensions[linha].height = 15

    workbook.active = 0
    return workbook


def nome_seguro_arquivo(valor):
    nome = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(valor))
    return nome.strip(" .") or "pedido"


def salvar_pdf_local(conteudo, nome_arquivo, pasta):
    destino = Path(pasta) / nome_seguro_arquivo(nome_arquivo)
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporario = destino.with_name(f".{destino.name}.{uuid4().hex}.tmp")
    try:
        temporario.write_bytes(conteudo)
        os.replace(temporario, destino)
    except OSError:
        temporario.unlink(missing_ok=True)
        raise
    return destino


def definir_texto_excel(planilha, linha, coluna, texto):
    celula = planilha.cell(linha, coluna, str(texto))
    celula.data_type = "s"
    return celula


# --- CLASSE PARA GERAÇÃO DO PDF ---
def _classe_pedido_pdf():
    from fpdf import FPDF  # type: ignore[reportMissingModuleSource]

    class PedidoPDF(FPDF):
        titulo_pedido = "Pedido HAJAN PÇS - (FRIBOI)"
        unidade_pedido = ""

        def header(self):
            if LOGO_PATH.is_file():
                largura_logo = 38
                self.image(
                    str(LOGO_PATH),
                    x=self.l_margin,
                    y=2,
                    w=largura_logo,
                )
                self.set_y(29)
            self.set_font("Arial", "B", 10)
            if self.get_string_width(self.titulo_pedido) > (self.w - self.l_margin - self.r_margin):
                self.set_font("Arial", "B", 8)
            self.cell(0, 5, self.titulo_pedido, ln=True, align="C")
            self.set_font("Arial", "", 8)
            self.cell(0, 4, "Vendedor: 1677169-HAJAN COM. E REPRESENTAÇÕES", ln=True)
            self.cell(0, 4, "Ao: Frigorifico Friboi (Grupo JBS)", ln=True)
            if self.unidade_pedido:
                self.cell(0, 4, f"Unidade de Carregamento: {self.unidade_pedido}", ln=True)
            self.ln(2)

        def footer(self):
            self.set_y(-15)
            self.set_font("Arial", "I", 8)
            self.cell(0, 10, f"Página {self.page_no()}/{{nb}}", align="C")

    return PedidoPDF


def _entrega_operacao_9(entrega):
    # Operação 9 é venda: não gera NF de remessa, então não entra nessa contagem.
    return bool(
        re.match(r"\s*opera[çc][ãa]o\s*9\b", str(entrega.get("operacao") or ""), re.IGNORECASE)
    )


def gerar_pdf(num_pedido, atencao, data_emissao, local, entregas, clientes, unidade_carregamento,
              observacao="", data_embarque=None, data_entrega=None):
    from fpdf.enums import MethodReturnValue

    pdf = _classe_pedido_pdf()()
    numero_texto = str(num_pedido or "").strip()
    unidade_texto = str(unidade_carregamento or "").strip()
    sigla_unidade = unidade_texto.split(" - ", 1)[0].strip()
    titulo = f"Pedido HAJAN {rotulo_categorias(entregas, PRODUTOS_DADOS)}"
    if numero_texto:
        titulo += f" nº {numero_texto}"
    if sigla_unidade:
        titulo += f" - {sigla_unidade}"
    pdf.titulo_pedido = f"{titulo} (FRIBOI)"
    pdf.unidade_pedido = unidade_texto
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font("Arial", "", 8)

    # Dados Gerais
    pdf.cell(0, 4, f"PEDIDO: {num_pedido} | At.: Sr. {atencao} | {local}, {data_emissao.strftime('%d/%m/%Y')}", ln=True)
    if data_embarque and data_entrega:
        pdf.cell(
            0,
            4,
            f"CIF  -  EMBARQUE: {data_embarque.strftime('%d/%m/%y')} - ENTREGA: {data_entrega.strftime('%d/%m/%y')}",
            ln=True,
        )
    pdf.ln(3)

    # Bloco de Entregas
    for idx, ent in enumerate(entregas, start=1):
        pdf.set_font("Arial", "B", 8)
        pdf.set_text_color(0, 0, 0)
        pdf.cell(0, 4, f"PEDIDO: {num_pedido} - {idx}ª entrega", ln=True)
        pdf.set_font("Arial", "", 8)
        pdf.cell(0, 4, f"Cliente: {ent['cliente']}", ln=True)
        dados_cliente = clientes.get(ent["cliente"], {})
        cnpj = dados_cliente.get("cnpj", "")
        cidade = dados_cliente.get("cidade", "")
        uf = dados_cliente.get("uf", "")
        if cnpj or cidade or uf:
            texto_cnpj = f"CNPJ: {cnpj}" if cnpj else ""
            localizacao = " - ".join(parte for parte in (cidade, uf) if parte)
            texto_cidade = f"Cidade: {localizacao}" if localizacao else ""
            if texto_cnpj:
                pdf.set_font("Arial", "B", 8)
                pdf.set_fill_color(255, 242, 0)
                largura_cnpj = pdf.get_string_width(texto_cnpj) + 2 * pdf.c_margin
                pdf.cell(largura_cnpj, 4, texto_cnpj, fill=True)
                pdf.set_font("Arial", "", 8)
            else:
                pdf.cell(80, 4, "", ln=False)
            if texto_cidade:
                pdf.cell(0, 4, texto_cidade, ln=True)
            else:
                pdf.ln(4)
        operacao = ent.get("operacao", "").strip()
        if operacao:
            # Faixa da operação na linha que antecede o quadro de produtos.
            pdf.set_font("Arial", "", 7)
            pdf.set_fill_color(221, 235, 247)
            pdf.set_text_color(31, 78, 121)
            linhas_operacao = pdf.multi_cell(
                0,
                4,
                operacao,
                dry_run=True,
                output=MethodReturnValue.LINES,
            )
            for linha_operacao in linhas_operacao:
                largura_fundo = pdf.get_string_width(linha_operacao) + 2 * pdf.c_margin
                pdf.cell(largura_fundo, 4, linha_operacao, fill=True, ln=True)
            pdf.set_text_color(0, 0, 0)
        # Tabela de Produtos
        subtotal_entrega = peso_entrega(ent)
        pdf.set_font("Arial", "B", 8)
        pdf.cell(80, 4, "Produto", 1)
        pdf.cell(15, 4, "Qtde.", 1)
        pdf.cell(15, 4, "Unid.", 1)
        pdf.cell(20, 4, "Preço", 1)
        pdf.cell(30, 4, "Prazo", 1, ln=True)

        pdf.set_font("Arial", "", 8)
        if entrega_peso_manual(ent):
            pdf.cell(80, 4, "PESO", 1)
            pdf.cell(15, 4, f"{subtotal_entrega:.0f}", 1)
            pdf.cell(15, 4, "KG", 1)
            pdf.cell(20, 4, "0,00", 1)
            pdf.cell(
                30,
                4,
                str(clientes.get(ent["cliente"], {}).get("prazo_padrao", "")),
                1,
                ln=True,
            )
        else:
            for p in ent["produtos"]:
                pdf.cell(80, 4, str(p["produto"]), 1)
                pdf.cell(15, 4, str(p["qtd"]), 1)
                pdf.cell(15, 4, str(p["unidade"]), 1)
                pdf.cell(20, 4, f"{p['preco']:.2f}", 1)
                pdf.cell(30, 4, str(p["prazo"]), 1, ln=True)
        pdf.set_font("Arial", "B", 8)
        pdf.cell(0, 4, f"Peso Total da Entrega: {subtotal_entrega:,.0f} kg".replace(",", "."), ln=True)
        pdf.ln(3)

    total_peso_geral = calcular_peso_total(entregas)
    veiculo = determinar_tipo_veiculo(total_peso_geral)
    pdf.set_font("Arial", "B", 8)
    pdf.cell(0, 4, f"Peso Carga (Total - Kg): {total_peso_geral:,.0f}".replace(",", "."), ln=True)
    pdf.cell(0, 4, f"Veículo: {veiculo}", ln=True)
    total_remessas = sum(1 for entrega in entregas if not _entrega_operacao_9(entrega))
    pdf.cell(0, 4, f"Quantidade de Entregas (NFs): {len(entregas)}", ln=True)
    pdf.cell(0, 4, f"Quantidade NFs de Remessa: {total_remessas}", ln=True)
    pdf.ln(2)

    pdf.set_font("Arial", "B", 6)
    pdf.cell(0, 4, "OBSERVAÇÃO:", ln=True)
    pdf.set_font("Arial", "", 6.5)
    texto_observacao = (observacao or "Sem observações.").strip() or "Sem observações."
    pdf.multi_cell(0, 3.5, texto_observacao)
    pdf.ln(1)

    # Observações de Rodapé
    pdf.set_font("Arial", "B", 8)
    pdf.cell(0, 4, "Observações Logísticas:", ln=True)
    pdf.set_font("Arial", "", 7)
    pdf.multi_cell(0, 3, "1. Anexar na NF Boletos Bancários e Romaneio c/ o peso Peça por Peça.\n"
                         "2. Entregar p/ motorista R$ 40,00 por tonelada p/ pagamento da descarga.\n"
                         "3. Passar p/ Motorista nossos telefones p/ que entre em contato ao iniciar viagem\n"
                         "   (Tim e WhatsApp (84) 98865-0413), falar c/ Andreia.")

    # Retorna o PDF em memória para o Streamlit
    return bytes(pdf.output())

# --- INTERFACE STREAMLIT ---
if _EMBEDDED_EMISSOR:
    _, coluna_sair = st.columns([8, 1.2])
    with coluna_sair:
        if st.button("Sair", key="sair_hajan_embedded", use_container_width=True):
            st.session_state.pop("hajan_autenticado", None)
            st.rerun()

ASSINATURA_BANCO = assinatura_banco()
CLIENTES_DADOS = carregar_clientes(ASSINATURA_BANCO)
CLIENTES_LISTA = list(CLIENTES_DADOS)
INDICE_CLIENTES = {nome: indice for indice, nome in enumerate(CLIENTES_LISTA)}
PRODUTOS_DADOS = carregar_produtos(ASSINATURA_BANCO)
PRODUTOS_LISTA = list(PRODUTOS_DADOS)
UNIDADES_DADOS = carregar_unidades(ASSINATURA_BANCO)
UNIDADES_LISTA = list(UNIDADES_DADOS)
CATEGORIAS_PRODUTO = ["Todas"] + sorted({
    dados["categoria"] for dados in PRODUTOS_DADOS.values()
})
PRODUTOS_POR_CATEGORIA = {"Todas": PRODUTOS_LISTA}
for _descricao_produto in PRODUTOS_LISTA:
    PRODUTOS_POR_CATEGORIA.setdefault(
        PRODUTOS_DADOS[_descricao_produto]["categoria"], []
    ).append(_descricao_produto)
del _descricao_produto
OPCAO_SEM_DESTINO = "SEM DESTINO"
OPCAO_CLIENTE_VAZIA = "Execute setup_db.py para carregar os clientes"
OPCAO_PRODUTO_VAZIA = "Execute setup_db.py para carregar os produtos"
OPCAO_UNIDADE_VAZIA = "Execute setup_db.py para carregar as unidades"

if not _EMBEDDED_EMISSOR:
    _cabecalho_marca(len(CLIENTES_LISTA), len(PRODUTOS_LISTA))
if not CLIENTES_LISTA:
    st.warning("Nenhum cliente foi carregado. Coloque 'Infos Clientes.xlsx' nesta pasta e execute 'python setup_db.py'.")
if not PRODUTOS_LISTA:
    st.warning("Nenhum produto foi carregado. Coloque 'Infos Produtos.xlsx' nesta pasta e execute 'python setup_db.py'.")
if not UNIDADES_LISTA:
    st.warning("Nenhuma unidade de carregamento foi carregada. Coloque 'Infos Unidades.xlsx' nesta pasta e execute 'python setup_db.py'.")

cliente_inicial = CLIENTES_LISTA[0] if CLIENTES_LISTA else OPCAO_CLIENTE_VAZIA
produto_padrao = PRODUTOS_LISTA[0] if PRODUTOS_LISTA else OPCAO_PRODUTO_VAZIA
if not isinstance(st.session_state.get("entregas"), list) or not st.session_state.entregas:
    st.session_state.entregas = [{
        "_id": uuid4().hex,
        "cliente": cliente_inicial,
        "operacao": "Operação 3: JL MEDEIROS LEVAMAIS MACAU (4229791)",
        "produtos": [novo_produto(
            produto_padrao,
            PRODUTOS_DADOS,
            quantidade=645,
            preco=19.50,
            prazo=CLIENTES_DADOS.get(cliente_inicial, {}).get("prazo_padrao", "")
        )]
    }]
for entrega in st.session_state.entregas:
    entrega.setdefault("_id", uuid4().hex)
    entrega.setdefault("cliente", cliente_inicial)
    entrega.setdefault("operacao", "Operação 3")
    if not isinstance(entrega.get("produtos"), list) or not entrega["produtos"]:
        # Entrega ESC usa só o peso manual; não inventa item padrão para ela.
        entrega["produtos"] = (
            [] if "peso_manual" in entrega
            else [novo_produto(produto_padrao, PRODUTOS_DADOS)]
        )
    for produto in entrega["produtos"]:
        produto.setdefault("_id", uuid4().hex)
        produto.setdefault("produto", produto_padrao)
        produto.setdefault("qtd", 1)
        dados_produto = PRODUTOS_DADOS.get(produto["produto"], {})
        produto.setdefault("unidade", dados_produto.get("unidade", "kg"))
        produto.setdefault("peso", dados_produto.get("peso", 1.0))
        produto.setdefault("preco", 0.0)
        produto.setdefault("prazo", "")


def _cabecalho_secao(titulo):
    st.markdown(
        f'<div class="hajan-secao"><h2>{titulo}</h2></div>',
        unsafe_allow_html=True,
    )


with st.container(border=True, key="bloco_clonar"):
    st.markdown(
        '<div class="bloco-titulo">Clonar pedido</div>',
        unsafe_allow_html=True,
    )
    col_clonar, col_clonar_tipo, col_clonar_acao = st.columns(
        [1.2, 0.9, 1.0], vertical_alignment="bottom"
    )
    with col_clonar:
        numero_clonar = st.text_input(
            "Clonar pedido pelo nº",
            key="pedido_clonar_txt",
            placeholder="nº já gerado (aqui ou na rede)",
            max_chars=40,
        )
    with col_clonar_tipo:
        tipo_clonar = st.radio(
            "Tipo do pedido",
            ("CXS", "PÇS"),
            key="pedido_clonar_tipo",
            horizontal=True,
        )
    with col_clonar_acao:
        deseja_clonar = st.button(
            "📋 Clonar pedido",
            key="clonar_pedido",
            use_container_width=True,
            disabled=not numero_clonar.strip(),
        )

    if deseja_clonar:
        st.session_state["_pedido_clonar"] = numero_clonar.strip()
        st.session_state["_pedido_clonar_tipo"] = tipo_clonar

    pedido_clonar = st.session_state.get("_pedido_clonar")
    tipo_pedido_clonar = st.session_state.get("_pedido_clonar_tipo", "CXS")
    if pedido_clonar:
        dados_clonar = carregar_pedido_clonagem(pedido_clonar, tipo_pedido_clonar)
        if not dados_clonar:
            st.session_state.pop("_pedido_clonar", None)
            outro_tipo = "PÇS" if tipo_pedido_clonar == "CXS" else "CXS"
            if carregar_pedido_clonagem(pedido_clonar, outro_tipo):
                st.error(
                    f"Não encontrei o pedido nº {pedido_clonar} como {tipo_pedido_clonar}. "
                    f"Ele está gravado como {outro_tipo}: mude o tipo e clone de novo."
                )
            else:
                st.error(
                    f"Não encontrei o pedido nº {pedido_clonar} ({tipo_pedido_clonar}). "
                    "Ele precisa estar no índice de clonagem ou ter o PDF na pasta de pedidos."
                )
        else:
            if dados_clonar.get("_fonte") == "pdf":
                st.warning(
                    "Reconstruí este pedido a partir do PDF antigo. "
                    "Confira cliente, itens, preços e datas antes de gerar."
                )
                for aviso in dados_clonar.get("_avisos") or []:
                    st.caption(f"• {aviso}")
            st.caption(
                f"Pedido nº {dados_clonar['numero']} · {tipo_pedido_clonar} · "
                f"{len(dados_clonar.get('entregas') or [])} entrega(s) · "
                f"embarque {dados_clonar.get('data_embarque')} · "
                f"entrega {dados_clonar.get('data_entrega')} · "
                f"{dados_clonar.get('unidade')}"
            )
            col_clonar_ok, col_clonar_nao = st.columns(2)
            with col_clonar_ok:
                if st.button(
                    "Substituir o pedido atual",
                    key="confirmar_clonar",
                    type="primary",
                    use_container_width=True,
                ):
                    aplicar_pedido_clonado(dados_clonar)
                    st.session_state.pop("_pedido_clonar", None)
                    st.rerun()
            with col_clonar_nao:
                if st.button("Manter o atual", key="cancelar_clonar", use_container_width=True):
                    st.session_state.pop("_pedido_clonar", None)
                    st.rerun()

_cabecalho_secao("Dados gerais")
for _chave_cabecalho, _valor_padrao in (
    ("num_pedido_txt", "2621"),
    ("atencao_sr_txt", "Helcio Venancio"),
    ("local_emissao_txt", "Natal"),
):
    if _chave_cabecalho not in st.session_state:
        st.session_state[_chave_cabecalho] = _valor_padrao
col1, col2, col3, col4 = st.columns([1.2, 1.5, 1, 1])
num_pedido = col1.text_input("Nº do Pedido", key="num_pedido_txt", max_chars=40)
atencao_sr = col2.text_input("A/C Sr.", key="atencao_sr_txt")
with col3:
    data_pedido = campo_data("Data de emissão", "data_emissao_txt", date.today())
local_emissao = col4.text_input("Local de emissão", key="local_emissao_txt")
if "unidade_carregamento" not in st.session_state:
    st.session_state.unidade_carregamento = (
        UNIDADES_LISTA[0] if UNIDADES_LISTA else OPCAO_UNIDADE_VAZIA
    )
if "observacao" not in st.session_state:
    st.session_state.observacao = ""
if "instrucao_spg" not in st.session_state:
    st.session_state.instrucao_spg = "CGS"

col_unidade, col_inst, col_obs = st.columns([1.5, 1.0, 3.5])
with col_unidade:
    ajustar_opcao_colada(
        "unidade_carregamento",
        UNIDADES_LISTA or [OPCAO_UNIDADE_VAZIA],
        "Unidade",
    )
    unidade_carregamento = st.selectbox(
        "Unidade de carregamento",
        UNIDADES_LISTA or [OPCAO_UNIDADE_VAZIA],
        disabled=not UNIDADES_LISTA,
        key="unidade_carregamento",
        accept_new_options=True,
    )
with col_inst:
    instrucao_spg = st.text_input(
        "Instrução (SPG)",
        key="instrucao_spg",
        max_chars=12,
        help="Sigla usada na carta de faturamento e no nome dos arquivos SPG (ex.: CGS, GPE).",
    )
with col_obs:
    st.text_area(
        "Observação do pedido",
        key="observacao",
        height=110,
        placeholder="Digite qualquer observação geral do pedido, instruções de entrega, horários, ou outras informações relevantes..."
    )

col_embarque, col_entrega_data = st.columns(2)
with col_embarque:
    data_embarque = campo_data("Data do embarque CIF", "data_embarque_txt", date.today())
with col_entrega_data:
    data_entrega = campo_data("Data prevista de entrega", "data_entrega_txt", date.today())


def hash_entregas(entregas):
    return hashlib.sha256(repr(entregas).encode("utf-8")).hexdigest()


def _mensagem_status_credito(status):
    chave = normalizar_busca(status)
    if not chave:
        st.info("Status do cliente: não informado na carteira.")
    elif chave == "cliente ok" or chave.endswith(" ok"):
        st.success(f"Status do cliente: {status}.")
    elif any(
        termo in chave
        for termo in (
            "bloqueado",
            "protesto",
            "juridico",
            "falencia",
            "recuperacao",
            "concordata",
            "perdas",
        )
    ):
        st.error(f"Status do cliente: {status}.")
    elif any(termo in chave for termo in ("observacao", "encargos")):
        st.warning(f"Status do cliente: {status}.")
    else:
        st.info(f"Status do cliente: {status}.")


@st.fragment
def _secao_entregas():

    titulo_entregas, acao_entrega = st.columns([5, 1.4])
    titulo_entregas.subheader("Entregas")
    if len(st.session_state.entregas) > 1:
        from streamlit_sortables import sort_items

        titulo_entregas.caption("Arraste as etiquetas para definir a ordem das entregas.")
        mostrar_resumo_geral(st.session_state.entregas)
        rotulos_entregas = [
            rotulo_entrega(entrega, idx)
            for idx, entrega in enumerate(st.session_state.entregas)
        ]
        ordem_rotulos = sort_items(
            rotulos_entregas,
            direction="horizontal",
            custom_style="""
                .sortable-container-body {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 6px;
                    background: transparent;
                }
                .sortable-item,
                .sortable-item:hover {
                    display: inline-flex;
                    align-items: center;
                    width: auto;
                    max-width: 100%;
                    height: auto;
                    padding: 6px 10px;
                    margin: 2px;
                    border: 1px solid #cfd9e3;
                    border-radius: 999px;
                    background: #ffffff !important;
                    color: #16222e !important;
                    font-size: 12px;
                    line-height: 1.3;
                    cursor: grab;
                    overflow-wrap: anywhere;
                }
                .sortable-item:active {
                    cursor: grabbing;
                }
            """,
            key=chave_ordenacao_entregas(st.session_state.entregas),
        )
        st.caption("Ordem atual: " + " → ".join(ordem_rotulos) if ordem_rotulos else "Nenhuma entrega")
        if (
            len(ordem_rotulos) == len(rotulos_entregas)
            and set(ordem_rotulos) == set(rotulos_entregas)
            and ordem_rotulos != rotulos_entregas
        ):
            entrega_por_rotulo = dict(zip(rotulos_entregas, st.session_state.entregas))
            st.session_state.entregas = [entrega_por_rotulo[rotulo] for rotulo in ordem_rotulos]
            st.rerun(scope="fragment")

    if acao_entrega.button("＋ Adicionar entrega", disabled=not CLIENTES_LISTA, use_container_width=True):
        st.session_state.entregas.append({
            "_id": uuid4().hex,
            "cliente": CLIENTES_LISTA[0],
            "operacao": "",
            "produtos": [novo_produto(
                PRODUTOS_LISTA[0] if PRODUTOS_LISTA else OPCAO_PRODUTO_VAZIA,
                PRODUTOS_DADOS,
                prazo=CLIENTES_DADOS.get(CLIENTES_LISTA[0], {}).get("prazo_padrao", "")
            )]
        })
        st.rerun(scope="fragment")

    for idx, entrega in enumerate(st.session_state.entregas):
        entrega_id = entrega["_id"]
        with st.expander(f"Entrega {idx + 1:02d}", expanded=True):
            col_cli, col_op, col_dup, col_del = st.columns([1.2, 1.2, 1.05, 0.3])
            with col_cli:
                ajustar_opcao_colada(
                    f"cli_{entrega_id}",
                    CLIENTES_LISTA or [OPCAO_CLIENTE_VAZIA],
                    "Cliente",
                    entrega["cliente"],
                )
                entrega["cliente"] = st.selectbox(
                    "Cliente de faturamento",
                    CLIENTES_LISTA or [OPCAO_CLIENTE_VAZIA],
                    index=INDICE_CLIENTES.get(entrega["cliente"], 0),
                    disabled=not CLIENTES_LISTA,
                    key=f"cli_{entrega_id}",
                    accept_new_options=True,
                )
            chave_cliente_prazo = f"_cliente_prazo_{entrega_id}"
            if st.session_state.get(chave_cliente_prazo) != entrega["cliente"]:
                prazo_cliente = CLIENTES_DADOS.get(entrega["cliente"], {}).get("prazo_padrao", "")
                for produto in entrega["produtos"]:
                    produto["prazo"] = prazo_cliente
                    chave_prazo = f"prz_{entrega_id}_{produto['_id']}"
                    if chave_prazo in st.session_state:
                        st.session_state[chave_prazo] = prazo_cliente
                st.session_state[chave_cliente_prazo] = entrega["cliente"]
            with col_op:
                opcoes_operacao = ["Operação 3", "Operação 9"]
                operacao_atual = entrega.get("operacao", "Operação 3")
                operacao_base = operacao_atual.split(":", 1)[0].strip() if ":" in operacao_atual else operacao_atual
                if operacao_base not in opcoes_operacao:
                    operacao_base = "Operação 3"
                ajustar_opcao_colada(
                    f"op_tipo_{entrega_id}",
                    opcoes_operacao,
                    "Operação",
                    operacao_base,
                )
                operacao_selecionada = st.selectbox(
                    "Operação",
                    opcoes_operacao,
                    index=opcoes_operacao.index(operacao_base),
                    key=f"op_tipo_{entrega_id}",
                    accept_new_options=True,
                )
                entrega["operacao"] = operacao_selecionada

                if operacao_selecionada == "Operação 3":
                    destinos = listar_destinos_operacao_3(CLIENTES_LISTA)
                    chave_destino = f"op3_dest_{entrega_id}"
                    chave_cliente_destino = f"_op3_cliente_{entrega_id}"
                    destino_padrao = entrega["cliente"] if entrega["cliente"] in destinos else (destinos[0] if destinos else "")
                    if st.session_state.get(chave_cliente_destino) != entrega["cliente"]:
                        st.session_state[chave_cliente_destino] = entrega["cliente"]
                        st.session_state[chave_destino] = destino_padrao
                    destino_atual = st.session_state.get(chave_destino, entrega.get("destino", destino_padrao))
                    if destino_atual not in destinos:
                        canonico = localizar_opcao(destino_atual, destinos) if destinos else None
                        if canonico:
                            destino_atual = canonico
                        else:
                            if destinos and str(destino_atual or "").strip() not in destinos:
                                st.warning(
                                    f'Destino "{destino_atual}" não foi encontrado; '
                                    f'mantido "{destino_padrao}".'
                                )
                            destino_atual = destino_padrao
                        st.session_state[chave_destino] = destino_atual
                    destino = st.selectbox(
                        "Cliente / destino",
                        destinos,
                        key=chave_destino,
                        disabled=not destinos,
                        accept_new_options=True,
                    )
                    entrega["destino"] = destino
                    entrega["operacao"] = f"Operação 3: {destino}"
                else:
                    entrega["destino"] = ""
                    entrega["operacao"] = "Operação 9"
            with col_dup, st.container(key=f"acao_dup_{entrega_id}"):
                if st.button(
                    "⧉ Duplicar entrega",
                    key=f"dup_ent_{entrega_id}",
                    help="Cria uma cópia desta entrega logo abaixo",
                    use_container_width=True,
                ):
                    st.session_state.entregas.insert(idx + 1, duplicar_entrega(entrega))
                    st.rerun(scope="fragment")
            with col_del, st.container(key=f"acao_del_{entrega_id}"):
                if len(st.session_state.entregas) > 1 and st.button("🗑️ Excluir", key=f"del_ent_{entrega_id}"):
                    entrega_removida = st.session_state.entregas.pop(idx)
                    limpar_chaves_entrega(entrega_removida)
                    st.rerun(scope="fragment")

            if entrega_peso_manual(entrega):
                st.markdown("**Peso da entrega**")
                st.caption(
                    "Cliente ESC: informe apenas o peso desta entrega, sem detalhamento de produtos."
                )
                chave_peso = f"peso_txt_{entrega_id}"
                if chave_peso not in st.session_state:
                    st.session_state[chave_peso] = formatar_numero(
                        entrega.get("peso_manual", 0) or 0
                    )
                texto_peso = st.text_input(
                    "Peso (kg)",
                    key=chave_peso,
                    placeholder="Pode colar: 1.500 ou 1500",
                )
                peso_informado = converter_numero(texto_peso)
                if peso_informado is None or peso_informado < 0:
                    st.warning("Informe o peso em kg (ex.: 1.500 ou 1500).")
                else:
                    entrega["peso_manual"] = peso_informado
            else:
                st.markdown("**Produtos**")
                for p_idx, prod in enumerate(entrega["produtos"]):
                    produto_id = prod["_id"]
                    (
                        chave_categoria,
                        chave_produto,
                        chave_produto_catalogo,
                        chave_qtd,
                        chave_unidade,
                        chave_preco,
                        chave_prazo,
                    ) = chaves_produto(entrega_id, produto_id)
                    with st.container(border=True):
                        produto_colado = st.session_state.get(chave_produto)
                        if produto_colado is not None and produto_colado not in PRODUTOS_LISTA:
                            canonico = localizar_opcao(produto_colado, PRODUTOS_LISTA)
                            if canonico:
                                st.session_state[chave_produto] = canonico
                                st.session_state[chave_categoria] = PRODUTOS_DADOS.get(
                                    canonico, {}
                                ).get("categoria", "Todas")
                                prod["produto"] = canonico
                            else:
                                st.warning(
                                    f'Produto "{produto_colado}" não foi encontrado no cadastro; '
                                    "mantido o produto anterior."
                                )
                                st.session_state[chave_produto] = prod["produto"]
                        if chave_categoria not in st.session_state:
                            categoria_atual = PRODUTOS_DADOS.get(prod["produto"], {}).get("categoria", "Todas")
                            st.session_state[chave_categoria] = categoria_atual
                        st.segmented_control(
                            f"Categoria do produto {p_idx + 1}",
                            options=CATEGORIAS_PRODUTO,
                            key=chave_categoria,
                            disabled=not PRODUTOS_LISTA,
                            width="stretch"
                        )
                        categoria_selecionada = st.session_state[chave_categoria]
                        produtos_filtrados = PRODUTOS_POR_CATEGORIA.get(
                            categoria_selecionada
                        ) or PRODUTOS_POR_CATEGORIA["Todas"]
                        if not produtos_filtrados:
                            if PRODUTOS_LISTA:
                                st.info(
                                    f"Nenhum produto cadastrado na categoria "
                                    f"\"{categoria_selecionada}\". Escolha outra categoria."
                                )
                            produtos_filtrados = [OPCAO_PRODUTO_VAZIA]
                        if prod["produto"] not in produtos_filtrados:
                            prod["produto"] = produtos_filtrados[0]
                            if chave_produto in st.session_state:
                                st.session_state[chave_produto] = prod["produto"]
                        col_prod, col_qtd, col_unid, col_preco, col_prazo, col_remover = st.columns([4.2, 0.85, 0.8, 1.15, 2.0, 0.45])
                        with col_prod:
                            prod["produto"] = st.selectbox(
                                "Produto",
                                produtos_filtrados,
                                index=produtos_filtrados.index(prod["produto"]) if prod["produto"] in produtos_filtrados else 0,
                                disabled=not PRODUTOS_LISTA,
                                key=chave_produto,
                                accept_new_options=True,
                            )
                    if st.session_state.get(chave_produto_catalogo) != prod["produto"]:
                        dados_produto = PRODUTOS_DADOS.get(prod["produto"], {})
                        prod["unidade"] = dados_produto.get("unidade", "kg")
                        prod["peso"] = dados_produto.get("peso", 1.0)
                        if chave_unidade in st.session_state:
                            st.session_state[chave_unidade] = prod["unidade"]
                        st.session_state[chave_produto_catalogo] = prod["produto"]
                    with col_qtd:
                        if chave_qtd not in st.session_state:
                            st.session_state[chave_qtd] = formatar_numero(prod["qtd"], inteiro=True)
                        texto_qtd = st.text_input("Qtde", key=chave_qtd)
                        qtd_informada = converter_numero(texto_qtd, inteiro=True)
                        if qtd_informada is None or qtd_informada < 1:
                            st.warning("Qtde inválida.")
                        else:
                            prod["qtd"] = qtd_informada
                    with col_unid:
                        if chave_unidade not in st.session_state:
                            st.session_state[chave_unidade] = prod["unidade"]
                        prod["unidade"] = st.text_input("Unid.", key=chave_unidade)
                    with col_preco:
                        if chave_preco not in st.session_state:
                            st.session_state[chave_preco] = formatar_numero(prod["preco"])
                        texto_preco = st.text_input("Preço (R$)", key=chave_preco)
                        preco_informado = converter_numero(texto_preco)
                        if preco_informado is None or preco_informado < 0:
                            st.warning("Preço inválido.")
                        else:
                            prod["preco"] = preco_informado
                    with col_prazo:
                        if chave_prazo not in st.session_state:
                            st.session_state[chave_prazo] = prod["prazo"]
                        prod["prazo"] = st.text_input("Prazo", key=chave_prazo)
                    with col_remover, st.container(key=f"acao_rem_{entrega_id}_{produto_id}"):
                        if len(entrega["produtos"]) > 1 and st.button(
                            "✕",
                            help="Remover produto",
                            key=f"rem_p_{entrega_id}_{produto_id}",
                        ):
                            entrega["produtos"].pop(p_idx)
                            limpar_chaves_produto(entrega_id, produto_id)
                            st.rerun(scope="fragment")

                if st.button(
                    "＋ Adicionar produto",
                    key=f"add_p_{entrega_id}",
                    disabled=not PRODUTOS_LISTA
                ):
                    entrega["produtos"].append(novo_produto(
                        PRODUTOS_LISTA[0] if PRODUTOS_LISTA else OPCAO_PRODUTO_VAZIA,
                        PRODUTOS_DADOS,
                        prazo=CLIENTES_DADOS.get(entrega["cliente"], {}).get("prazo_padrao", "")
                    ))
                    st.rerun(scope="fragment")

    _cabecalho_secao("Limite por cliente")
    dados_carteira = _carregar_carteira_credito(_assinatura_carteira_credito())
    registros_carteira = dados_carteira["registros"]
    medias_compras = _carregar_media_compras(_assinatura_media_compras())

    for resumo in resumir_limites_pedido(
        st.session_state.entregas, CLIENTES_DADOS, registros_carteira
    ):
        nome_clientes = ", ".join(sorted(resumo["clientes"]))
        registro = resumo["carteira"]
        if registro:
            titulo_cliente = resumo["centralizador"] or registro["nome"] or nome_clientes
            st.markdown(f"**{titulo_cliente}**")
            col_limite, col_financeiro, col_carteira, col_credito = st.columns(4)
            col_limite.metric("Limite total", formatar_moeda(registro["limite"]))
            col_financeiro.metric(
                "Saldo financeiro", formatar_moeda(registro["saldo_financeiro"])
            )
            col_carteira.metric(
                "Saldo em carteira", formatar_moeda(registro["saldo_carteira"])
            )
            col_credito.metric(
                "Saldo de crédito", formatar_moeda(registro["saldo_credito"])
            )
            _mensagem_status_credito(registro["status"])
            if dados_carteira["data"]:
                st.caption(
                    f"Carteira de Terceiro — posição de {dados_carteira['data']}."
                )

            saldo_credito = registro["saldo_credito"]
            if saldo_credito <= 0:
                st.error(
                    f"Saldo de crédito negativo/zerado ({formatar_moeda(saldo_credito)}); "
                    f"valor estimado do pedido: {formatar_moeda(resumo['pedido'])}."
                )
            elif resumo["pedido"] > saldo_credito:
                st.warning(
                    f"Pedido estimado em {formatar_moeda(resumo['pedido'])} "
                    f"excede o saldo de crédito de {formatar_moeda(saldo_credito)}."
                )

            media_semana = (medias_compras.get(resumo["codigo"]) or {}).get("media_semana", 0.0)
            if media_semana > 0:
                if saldo_credito < media_semana:
                    st.warning(
                        f"Atenção: saldo de crédito de {formatar_moeda(saldo_credito)} "
                        f"é menor que a compra média semanal de {formatar_moeda(media_semana)} "
                        "dos últimos 6 meses."
                    )
                else:
                    st.caption(
                        f"Compra média semanal (6 meses): {formatar_moeda(media_semana)}."
                    )
            continue

        if not resumo["codigo"]:
            st.warning(f"{nome_clientes}: cliente sem código centralizador cadastrado; não foi possível consultar o limite.")
        elif not resumo["centralizador"]:
            st.warning(f"{nome_clientes}: não há limite sincronizado para o centralizador {resumo['codigo']}.")
        else:
            limite = resumo["limite"]
            disponivel = resumo["disponivel"]
            if limite is None or limite <= 0:
                saldo = f" Saldo disponível: {formatar_moeda(disponivel)}." if disponivel is not None else ""
                st.warning(f"{nome_clientes}: sem limite aprovado cadastrado.{saldo}")
            elif disponivel is None:
                st.warning(f"{nome_clientes}: limite aprovado, mas sem saldo disponível informado na planilha.")
            elif disponivel <= 0:
                st.warning(
                    f"{nome_clientes}: saldo disponível negativo/zerado "
                    f"({formatar_moeda(disponivel)}); valor estimado do pedido: {formatar_moeda(resumo['pedido'])}."
                )
            elif resumo["pedido"] > disponivel:
                st.warning(
                    f"{nome_clientes}: pedido estimado em {formatar_moeda(resumo['pedido'])} "
                    f"excede o saldo disponível de {formatar_moeda(disponivel)}."
                )
            else:
                st.info(
                    f"Limite de {resumo['centralizador']}: {formatar_moeda(limite)} | "
                    f"Disponível: {formatar_moeda(disponivel)} | "
                    f"Pedido estimado: {formatar_moeda(resumo['pedido'])}."
                )

        for nome_cliente in sorted(resumo["clientes"]):
            status = CLIENTES_DADOS.get(nome_cliente, {}).get("status_cliente", "").strip()
            st.info(f"Status do cliente {nome_cliente}: {status or 'Não informado'}.")

    _cabecalho_secao("Resumo da carga")
    peso_carga_total = calcular_peso_total(st.session_state.entregas)
    tipo_veiculo = determinar_tipo_veiculo(peso_carga_total)
    resumo_peso, resumo_veiculo, resumo_entregas, resumo_remessas = st.columns(4)
    resumo_peso.metric("Peso consolidado", f"{peso_carga_total:,.0f} kg".replace(",", "."))
    resumo_veiculo.metric("Tipo de veículo", tipo_veiculo)
    resumo_entregas.metric("Entregas / NFs", len(st.session_state.entregas))
    resumo_remessas.metric(
        "NFs de remessa",
        sum(1 for entrega in st.session_state.entregas if not _entrega_operacao_9(entrega)),
        help="Operação 9 conta apenas como venda e não entra nas NFs de remessa.",
    )

    _hash_atual = hash_entregas(st.session_state.entregas)
    _obsoleto = False
    for _chave_resultado in ("_pdf_gerado", "_resumos_excel_gerados"):
        _resultado = st.session_state.get(_chave_resultado)
        if _resultado and _resultado.get("entregas_hash") != _hash_atual:
            st.session_state.pop(_chave_resultado, None)
            _obsoleto = True
    if _obsoleto:
        st.rerun()


_secao_entregas()


@st.cache_resource(show_spinner=False, max_entries=1)
def _executor_geracao():
    # Um único worker serializa as gravações no SQLite (SMB) e evita que duas
    # gerações concorrentes sobrescrevam os mesmos arquivos na pasta de rede.
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="hajan-geracao")


def _executar_tarefa(funcao, argumentos):
    try:
        return funcao(*argumentos)
    finally:
        liberar_memoria(forcar=True)


LIMITE_TAREFA_SEGUNDOS = 900


def iniciar_tarefa(chave, funcao, assinatura, *argumentos):
    if f"_tarefa_{chave}" in st.session_state:
        return
    st.session_state[f"_tarefa_{chave}"] = {
        "futuro": _executor_geracao().submit(_executar_tarefa, funcao, argumentos),
        "inicio": time.monotonic(),
        "assinatura": assinatura,
    }


def tarefa_em_andamento(chave):
    return f"_tarefa_{chave}" in st.session_state


def tarefa_expirada(chave, tarefa):
    if tarefa["futuro"].done():
        return False
    if time.monotonic() - tarefa["inicio"] <= LIMITE_TAREFA_SEGUNDOS:
        return False
    st.session_state.pop(f"_tarefa_{chave}", None)
    logging.warning("Tarefa %s cancelada após exceder o tempo limite", chave)
    _executor_geracao.clear()
    st.error(
        "A geração demorou mais que o esperado e foi cancelada. "
        "Verifique o armazenamento configurado e tente novamente."
    )
    return True


def _mensagem_espera(texto, inicio):
    return f"{texto} ({time.monotonic() - inicio:.0f}s)"


def _concluir_tarefa(chave):
    tarefa = st.session_state.pop(f"_tarefa_{chave}")
    resultado = tarefa["futuro"].result()
    # Tarefas gravam pedidos/base; o próximo rerun precisa ver a versão nova.
    invalidar_assinatura_banco()
    return resultado


def _tarefa_pdf_worker(numero, atencao, data_pedido, local, entregas, unidade,
                       observacao, data_embarque, data_entrega):
    pdf_bytes = gerar_pdf(
        numero,
        atencao,
        data_pedido,
        local,
        entregas,
        CLIENTES_DADOS,
        unidade,
        observacao,
        data_embarque,
        data_entrega,
    )
    registrado = registrar_pedidos_semana(
        numero,
        unidade,
        entregas,
        CLIENTES_DADOS,
        PRODUTOS_DADOS,
        data_embarque,
        data_entrega,
    )
    registrar_pedido_clonagem(
        numero, atencao, local, unidade, observacao,
        data_pedido, data_embarque, data_entrega, entregas,
    )
    sigla = UNIDADES_DADOS.get(unidade, {}).get("sigla") or unidade
    nome_arquivo = (
        f"Pedido Hajan {rotulo_categorias(entregas, PRODUTOS_DADOS)} "
        f"nº {nome_seguro_arquivo(numero)} "
        f"(Embarque {nome_seguro_arquivo(sigla)} {data_embarque.strftime('%d.%m.%y')}).pdf"
    )
    caminhos = []
    erro_salvar = False
    if os.name == "nt" or EXPORT_DIR:
        for pasta in PASTAS_PDFS:
            try:
                caminhos.append(str(salvar_pdf_local(pdf_bytes, nome_arquivo, pasta)))
            except OSError:
                logging.exception("Falha ao salvar PDF em %s", pasta)
                erro_salvar = True
    return {
        "pdf": pdf_bytes,
        "nome": nome_arquivo,
        "registrado": registrado,
        "caminhos": caminhos,
        "erro_salvar": erro_salvar,
        "entregas_hash": hash_entregas(entregas),
    }


@st.fragment(run_every=0.8)
def _acompanhar_pdf(assinatura):
    tarefa = st.session_state.get("_tarefa_pdf")
    if not tarefa:
        return
    if tarefa["assinatura"] != assinatura:
        st.session_state.pop("_tarefa_pdf", None)
        st.warning("Os dados do pedido mudaram durante a geração. Gere o PDF novamente.")
        return
    if tarefa_expirada("pdf", tarefa):
        return
    if not tarefa["futuro"].done():
        st.info(_mensagem_espera("Gerando PDF…", tarefa["inicio"]))
        return
    try:
        resultado = _concluir_tarefa("pdf")
    except Exception:
        logging.exception("Falha ao gerar o PDF em segundo plano")
        st.error("Não foi possível gerar o PDF. Consulte o log local.")
        return
    resultado["assinatura"] = assinatura
    st.session_state["_pdf_gerado"] = resultado
    st.rerun()


# Botão para gerar e descarregar o PDF
assinatura_pdf = hashlib.sha256(
    repr((
        num_pedido,
        unidade_carregamento,
        data_pedido,
        data_embarque,
        data_entrega,
        local_emissao,
        atencao_sr,
        st.session_state.observacao,
        st.session_state.entregas,
    )).encode("utf-8")
).hexdigest()
resultado_pdf = st.session_state.get("_pdf_gerado")
if resultado_pdf and resultado_pdf["assinatura"] != assinatura_pdf:
    st.session_state.pop("_pdf_gerado", None)
    resultado_pdf = None

assinatura_excel = hashlib.sha256(
    repr((num_pedido, unidade_carregamento, data_embarque, data_entrega,
          instrucao_spg, st.session_state.entregas)).encode("utf-8")
).hexdigest()
resultado_excel = st.session_state.get("_resumos_excel_gerados")
if resultado_excel and resultado_excel["assinatura"] != assinatura_excel:
    st.session_state.pop("_resumos_excel_gerados", None)
    resultado_excel = None

def _tarefa_excel_worker(numero, unidade, entregas, data_pedido, local, atencao,
                         data_embarque, data_entrega, instrucao="", observacao=""):
    registrado = registrar_pedidos_semana(
        numero,
        unidade,
        entregas,
        CLIENTES_DADOS,
        PRODUTOS_DADOS,
        data_embarque,
        data_entrega,
    )
    registrar_pedido_clonagem(
        numero, atencao, local, unidade, observacao,
        data_pedido, data_embarque, data_entrega, entregas,
    )

    def gravar_arquivo(conteudo, caminho, rotulo):
        if os.name != "nt" and not EXPORT_DIR:
            return "A gravação automática não está configurada neste servidor."
        temporario = caminho.with_name(f".{caminho.name}.{uuid4().hex}.tmp")
        try:
            caminho.parent.mkdir(parents=True, exist_ok=True)
            temporario.write_bytes(conteudo)
            os.replace(temporario, caminho)
            return ""
        except OSError:
            logging.exception("Falha ao gravar o Excel %s", rotulo)
            temporario.unlink(missing_ok=True)
            return "Falha de escrita na pasta configurada."

    arquivos_excel = {}
    erros_geracao = []

    # Cada pedido gera só a planilha do seu tipo: CXS vai para a pasta de
    # caixaria e PÇS para a de peças. Peso manual só conta como PÇS quando o
    # pedido é de peças (ou não tem produtos).
    categorias_pedido = set(rotulo_categorias(entregas, PRODUTOS_DADOS).split("-"))
    for categoria, nome_categoria in (("CXS", "Caixaria"), ("PÇS", "Peças")):
        if categoria not in categorias_pedido:
            continue
        try:
            if categoria == "CXS":
                workbook = gerar_excel_anotacoes_cxs(
                    numero,
                    unidade,
                    entregas,
                    PRODUTOS_DADOS,
                    data_pedido,
                    local,
                    atencao,
                    data_embarque,
                    data_entrega,
                )
            else:
                workbook = gerar_excel_resumo(
                    categoria,
                    numero,
                    unidade,
                    entregas,
                    CLIENTES_DADOS,
                    PRODUTOS_DADOS,
                    data_embarque,
                    data_entrega,
                )
            if workbook is None:
                continue

            buffer_excel = BytesIO()
            try:
                workbook.save(buffer_excel)
            finally:
                workbook.close()
            conteudo_excel = buffer_excel.getvalue()
            del buffer_excel, workbook
            sigla_unidade_excel = UNIDADES_DADOS.get(unidade, {}).get("sigla", unidade)
            nome_arquivo_excel = (
                f"{nome_resumo_excel(categoria, numero, sigla_unidade_excel, data_entrega)}.xlsx"
            )
            caminho_excel = PASTAS_RESUMO_EXCEL[categoria] / nome_arquivo_excel
            erro_salvamento = gravar_arquivo(conteudo_excel, caminho_excel, categoria)
            arquivos_excel[categoria] = {
                "categoria": nome_categoria,
                "conteudo": conteudo_excel,
                "nome_arquivo": nome_arquivo_excel,
                "caminho": str(caminho_excel),
                "salvo": not erro_salvamento,
                "erro": erro_salvamento,
            }
        except Exception:
            logging.exception("Falha ao gerar o Excel %s", categoria)
            erros_geracao.append(f"{nome_categoria}: falha ao gerar o arquivo.")

    numero_arquivo = nome_seguro_arquivo(numero)
    try:
        arquivos_chq, clientes_chq_ignorados = gerar_excel_chq(
            numero, entregas, CLIENTES_DADOS, PRODUTOS_DADOS, data_pedido
        )
    except Exception:
        logging.exception("Falha ao gerar o CHQ")
        arquivos_chq, clientes_chq_ignorados = [], []
        erros_geracao.append("CHQ: falha ao gerar o arquivo.")

    for item_chq in arquivos_chq:
        try:
            buffer_excel = BytesIO()
            try:
                item_chq["workbook"].save(buffer_excel)
            finally:
                item_chq["workbook"].close()
            conteudo_excel = buffer_excel.getvalue()
            del buffer_excel
            if len(arquivos_chq) == 1:
                chave_chq = "CHQ"
                rotulo_chq = "CHQ"
                nome_arquivo_excel = f"Pedido Hajan CHQ n° {numero_arquivo} (Friboi).xlsx"
            else:
                chave_chq = f"CHQ {item_chq['codigo']}"
                rotulo_chq = f"CHQ {item_chq['codigo']}"
                nome_arquivo_excel = (
                    f"Pedido Hajan CHQ n° {numero_arquivo} - "
                    f"{nome_seguro_arquivo(item_chq['codigo'])} (Friboi).xlsx"
                )
            caminho_excel = PASTA_CHQ / nome_arquivo_excel
            erro_salvamento = gravar_arquivo(conteudo_excel, caminho_excel, chave_chq)
            arquivos_excel[chave_chq] = {
                "categoria": rotulo_chq,
                "cliente": item_chq["cliente"],
                "conteudo": conteudo_excel,
                "nome_arquivo": nome_arquivo_excel,
                "caminho": str(caminho_excel),
                "salvo": not erro_salvamento,
                "erro": erro_salvamento,
            }
        except Exception:
            logging.exception("Falha ao gravar o CHQ %s", item_chq.get("codigo", ""))
            erros_geracao.append(f"CHQ {item_chq.get('codigo', '')}: falha ao gerar o arquivo.")
    del arquivos_chq

    instrucao = str(instrucao or "").strip() or "CGS"
    instrucao_arquivo = nome_seguro_arquivo(instrucao)
    try:
        workbook_spg = gerar_excel_spg(
            numero, instrucao, atencao, local, data_pedido,
            data_embarque, data_entrega, entregas, CLIENTES_DADOS, PRODUTOS_DADOS,
        )
    except Exception:
        logging.exception("Falha ao gerar o SPG")
        workbook_spg = None
        erros_geracao.append("SPG: falha ao gerar o arquivo.")

    if workbook_spg is not None:
        try:
            buffer_excel = BytesIO()
            try:
                workbook_spg.save(buffer_excel)
            finally:
                workbook_spg.close()
            conteudo_excel = buffer_excel.getvalue()
            del buffer_excel, workbook_spg
            nome_arquivo_excel = (
                f"Pedido HAJAN SPG nº {numero_arquivo} - {instrucao_arquivo} "
                "(FRIBOI)-Anotações.xlsx"
            )
            caminho_excel = PASTA_SPG_ANOTACOES / nome_arquivo_excel
            erro_salvamento = gravar_arquivo(conteudo_excel, caminho_excel, "SPG")
            arquivos_excel["SPG"] = {
                "categoria": "SPG",
                "cliente": "",
                "conteudo": conteudo_excel,
                "nome_arquivo": nome_arquivo_excel,
                "caminho": str(caminho_excel),
                "salvo": not erro_salvamento,
                "erro": erro_salvamento,
            }
        except Exception:
            logging.exception("Falha ao montar o Excel SPG")
            erros_geracao.append("SPG: falha ao montar o arquivo.")

        try:
            conteudo_docx = gerar_docx_spg(numero, instrucao, data_embarque)
            nome_arquivo_docx = (
                f"Solicitação Faturamento Pedido SPG {numero_arquivo} "
                f"{instrucao_arquivo}.docx"
            )
            caminho_docx = PASTA_SPG_FATURAMENTO / nome_arquivo_docx
            erro_salvamento_docx = gravar_arquivo(
                conteudo_docx, caminho_docx, "SPG Faturamento"
            )
            arquivos_excel["SPG FATURAMENTO"] = {
                "categoria": "Solicitação SPG",
                "cliente": "",
                "conteudo": conteudo_docx,
                "nome_arquivo": nome_arquivo_docx,
                "caminho": str(caminho_docx),
                "salvo": not erro_salvamento_docx,
                "erro": erro_salvamento_docx,
                "mime": (
                    "application/vnd.openxmlformats-officedocument"
                    ".wordprocessingml.document"
                ),
            }
        except Exception:
            logging.exception("Falha ao montar a carta SPG")
            erros_geracao.append("Solicitação SPG: falha ao montar o arquivo.")

    return {
        "arquivos": arquivos_excel,
        "erros": erros_geracao,
        "registrado": registrado,
        "clientes_chq_ignorados": clientes_chq_ignorados,
        "entregas_hash": hash_entregas(entregas),
    }


@st.fragment(run_every=0.8)
def _acompanhar_excel(assinatura):
    tarefa = st.session_state.get("_tarefa_excel")
    if not tarefa:
        return
    if tarefa["assinatura"] != assinatura:
        st.session_state.pop("_tarefa_excel", None)
        st.warning("Os dados do pedido mudaram durante a geração. Gere as planilhas novamente.")
        return
    if tarefa_expirada("excel", tarefa):
        return
    if not tarefa["futuro"].done():
        st.info(_mensagem_espera("Gerando planilhas CXS / PÇS / CHQ / SPG…", tarefa["inicio"]))
        return
    try:
        resultado = _concluir_tarefa("excel")
    except Exception:
        logging.exception("Falha ao gerar as planilhas em segundo plano")
        st.error("Não foi possível gerar as planilhas. Consulte o log local.")
        return
    resultado["assinatura"] = assinatura
    st.session_state["_resumos_excel_gerados"] = resultado
    st.rerun()


if st.button(
    "📄 Gerar pedido",
    type="primary",
    use_container_width=True,
    disabled=(
        not CLIENTES_LISTA
        or not PRODUTOS_LISTA
        or not UNIDADES_LISTA
        or tarefa_em_andamento("pdf")
        or tarefa_em_andamento("excel")
    ),
):
    # O executor tem um único worker: o Excel entra na fila e roda após o PDF.
    iniciar_tarefa(
        "pdf",
        _tarefa_pdf_worker,
        assinatura_pdf,
        num_pedido,
        atencao_sr,
        data_pedido,
        local_emissao,
        copy.deepcopy(st.session_state.entregas),
        unidade_carregamento,
        st.session_state.observacao,
        data_embarque,
        data_entrega,
    )
    iniciar_tarefa(
        "excel",
        _tarefa_excel_worker,
        assinatura_excel,
        num_pedido,
        unidade_carregamento,
        copy.deepcopy(st.session_state.entregas),
        data_pedido,
        local_emissao,
        atencao_sr,
        data_embarque,
        data_entrega,
        instrucao_spg,
        st.session_state.observacao,
    )

if tarefa_em_andamento("pdf"):
    _acompanhar_pdf(assinatura_pdf)

resultado_pdf = st.session_state.get("_pdf_gerado")
if resultado_pdf and resultado_pdf["assinatura"] == assinatura_pdf:
    if not resultado_pdf["registrado"]:
        st.warning(
            "O PDF foi gerado, mas o pedido não foi registrado para o resumo semanal. "
            "Consulte o log local."
        )
    if resultado_pdf["caminhos"]:
        salvo = "  \n".join(resultado_pdf["caminhos"])
        if resultado_pdf["erro_salvar"]:
            st.warning(f"Salvei em parte. Endereços gravados:  \n{salvo}")
        else:
            st.success(f"PDF salvo em:  \n{salvo}")
    elif resultado_pdf["erro_salvar"]:
        st.warning("Não foi possível salvar nas pastas configuradas. Baixe o PDF pelo botão abaixo.")
    elif os.name != "nt" and not EXPORT_DIR:
        st.info(
            "O salvamento automático não está configurado. Baixe o arquivo abaixo."
        )
    elif EXPORT_DIR and not resultado_pdf["caminhos"]:
        st.warning(
            "Não foi possível salvar o PDF no armazenamento persistente configurado. "
            "Baixe o arquivo pelo botão abaixo."
        )
    st.download_button(
        label="⬇️ Clique aqui para baixar o PDF",
        data=resultado_pdf["pdf"],
        file_name=resultado_pdf["nome"],
        mime="application/pdf",
        key=f"baixar_pdf_{assinatura_pdf}",
    )

if tarefa_em_andamento("excel"):
    _acompanhar_excel(assinatura_excel)

resultado_excel = st.session_state.get("_resumos_excel_gerados")
if resultado_excel and resultado_excel["assinatura"] == assinatura_excel:
    if not resultado_excel.get("registrado", True):
        st.warning(
            "Os arquivos foram gerados, mas o pedido não foi registrado para o resumo semanal. "
            "Consulte o log local."
        )
    if resultado_excel.get("clientes_chq_ignorados"):
        st.warning(
            "CHQ não gerado para "
            + ", ".join(resultado_excel["clientes_chq_ignorados"])
            + ": cliente sem código no cadastro."
        )
    for erro_geracao in resultado_excel.get("erros") or []:
        st.warning(erro_geracao + " Os demais arquivos foram gerados normalmente.")
    if not resultado_excel.get("arquivos"):
        st.warning(
            "Este pedido não contém produtos de caixaria (CXS), de peças (PÇS), "
            "de charque (CHQ) nem SPG."
        )
    else:
        col_download_cxs, col_download_pcs = st.columns(2)
        colunas_download = {"CXS": col_download_cxs, "PÇS": col_download_pcs}
        for chave_arquivo, arquivo in resultado_excel["arquivos"].items():
            coluna = colunas_download.get(chave_arquivo) or st.container()
            if arquivo["salvo"]:
                coluna.success(f"{arquivo['categoria']} salvo em:\n{arquivo['caminho']}")
            else:
                coluna.warning(
                    f"Não foi possível gravar {arquivo['categoria']} no armazenamento configurado. "
                    "Baixe o arquivo abaixo."
                )
            if arquivo.get("mime"):
                rotulo_download = f"Baixar Word {arquivo['categoria']}"
            else:
                rotulo_download = f"Baixar Excel {arquivo['categoria']}"
            coluna.download_button(
                rotulo_download,
                data=arquivo["conteudo"],
                file_name=arquivo["nome_arquivo"],
                mime=arquivo.get(
                    "mime",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ),
                key=f"baixar_excel_{chave_arquivo.replace(' ', '_')}_{assinatura_excel}",
                use_container_width=True,
            )

_cabecalho_secao("Resumo semanal")
def _tarefa_importacao_worker():
    return importar_resumos_semana()


@st.fragment(run_every=0.8)
def _acompanhar_importacao():
    tarefa = st.session_state.get("_tarefa_importacao")
    if not tarefa:
        return
    if not tarefa["futuro"].done():
        st.info(_mensagem_espera("Lendo resumos da pasta…", tarefa["inicio"]))
        return
    try:
        importados = _concluir_tarefa("importacao")
    except Exception:
        logging.exception("Falha ao importar os resumos da pasta em segundo plano")
        st.error("Não foi possível ler os resumos da pasta. Consulte o log local.")
        return
    st.session_state["_importacao_resumos_semana"] = importados
    st.rerun()


if st.button(
    "📥 Importar resumo da pasta",
    disabled=tarefa_em_andamento("importacao"),
):
    iniciar_tarefa("importacao", _tarefa_importacao_worker, "")
if tarefa_em_andamento("importacao"):
    _acompanhar_importacao()

importados_resumos = st.session_state.pop("_importacao_resumos_semana", None)
if importados_resumos is None:
    pass
elif importados_resumos:
    st.success(f"{importados_resumos} pedido(s) importado(s) dos resumos da pasta.")
else:
    st.warning(
        "Nenhum resumo novo encontrado na pasta, ou a pasta não está acessível. "
        "Consulte o log local."
    )

def _tarefa_resumo_semanal_worker(pedidos_semana, numero_semana, ano_semana):
    workbook = gerar_resumo_semanal_excel(pedidos_semana, numero_semana)
    buffer = BytesIO()
    try:
        workbook.save(buffer)
    finally:
        workbook.close()
    conteudo = buffer.getvalue()
    del workbook, buffer
    nome = f"ResumoSemanal - Entrega Semana Nº {numero_semana}-{ano_semana}.xlsx"
    caminho = PASTAS_RESUMO_EXCEL["PÇS"] / nome
    salvo = False
    if os.name == "nt" or EXPORT_DIR:
        temporario = caminho.with_name(f".{caminho.name}.{uuid4().hex}.tmp")
        try:
            caminho.parent.mkdir(parents=True, exist_ok=True)
            temporario.write_bytes(conteudo)
            os.replace(temporario, caminho)
            salvo = True
        except OSError:
            logging.exception("Falha ao gravar o resumo semanal")
            temporario.unlink(missing_ok=True)
    return {
        "conteudo": conteudo,
        "nome": nome,
        "caminho": str(caminho),
        "salvo": salvo,
    }


@st.fragment(run_every=0.8)
def _acompanhar_resumo_semanal(assinatura):
    tarefa = st.session_state.get("_tarefa_resumo_semanal")
    if not tarefa:
        return
    if tarefa["assinatura"] != assinatura:
        st.session_state.pop("_tarefa_resumo_semanal", None)
        st.warning("A seleção de pedidos mudou durante a geração. Gere o resumo novamente.")
        return
    if not tarefa["futuro"].done():
        st.info(_mensagem_espera("Gerando resumo semanal…", tarefa["inicio"]))
        return
    try:
        resultado = _concluir_tarefa("resumo_semanal")
    except Exception:
        logging.exception("Falha ao gerar o resumo semanal em segundo plano")
        st.error("Não foi possível gerar o resumo semanal. Consulte o log local.")
        return
    resultado["assinatura"] = assinatura
    st.session_state["_resumo_semanal_gerado"] = resultado
    st.rerun()


col_semana, col_semana_info = st.columns([1, 2.2], vertical_alignment="center")
with col_semana:
    data_semana = campo_data("Semana de entrega", "data_semana_txt", date.today())
ano_semana, numero_semana, _ = data_semana.isocalendar()
segunda_semana = data_semana - timedelta(days=data_semana.weekday())
domingo_semana = segunda_semana + timedelta(days=6)
with col_semana_info:
    st.caption(
        f"Semana Nº {numero_semana}-{ano_semana} · "
        f"{segunda_semana:%d/%m/%y} a {domingo_semana:%d/%m/%y}"
    )
    st.caption(f"Pasta de destino: {PASTAS_RESUMO_EXCEL['PÇS']}")

incluir_semana_anterior = st.checkbox(
    "Incluir pedidos com entrega na semana anterior",
    key=f"incluir_semana_anterior_{ano_semana}_{numero_semana}",
)
inicio_semana = segunda_semana - timedelta(days=7) if incluir_semana_anterior else segunda_semana

grupos_semana = agrupar_pedidos_semana(
    carregar_pedidos_semana(inicio_semana, domingo_semana, ASSINATURA_BANCO)
)
rotulos_semana = {rotulo_pedido_semana(grupo): grupo for grupo in grupos_semana}
if not rotulos_semana:
    st.info(
        "Nenhum pedido de peças registrado para esta semana. Gere o PDF ou o Excel "
        "de um pedido para registrá-lo automaticamente."
    )
else:
    opcoes_semana = list(rotulos_semana)
    chave_selecao_semana = (
        f"pedidos_semana_{ano_semana}_{numero_semana}_{int(incluir_semana_anterior)}"
    )
    chave_conhecidos_semana = f"{chave_selecao_semana}_conhecidos"
    if chave_selecao_semana in st.session_state:
        conhecidos = st.session_state.get(chave_conhecidos_semana, [])
        novos = [opcao for opcao in opcoes_semana if opcao not in conhecidos]
        if novos:
            st.session_state[chave_selecao_semana] = list(dict.fromkeys(
                [*st.session_state[chave_selecao_semana], *novos]
            ))
        pedidos_selecionados = st.multiselect(
            "Pedidos da semana",
            opcoes_semana,
            key=chave_selecao_semana,
        )
    else:
        pedidos_selecionados = st.multiselect(
            "Pedidos da semana",
            opcoes_semana,
            default=opcoes_semana,
            key=chave_selecao_semana,
        )
    st.session_state[chave_conhecidos_semana] = opcoes_semana
    assinatura_semana = hashlib.sha256(
        repr((ano_semana, numero_semana, tuple(pedidos_selecionados))).encode("utf-8")
    ).hexdigest()
    resultado_semana = st.session_state.get("_resumo_semanal_gerado")
    if resultado_semana and resultado_semana["assinatura"] != assinatura_semana:
        st.session_state.pop("_resumo_semanal_gerado", None)
        resultado_semana = None

    if st.button(
        "📅 Gerar resumo semanal",
        type="primary",
        use_container_width=True,
        disabled=not pedidos_selecionados or tarefa_em_andamento("resumo_semanal"),
    ):
        pedidos_semana = [
            rotulos_semana[rotulo]["categorias"]["PÇS"]
            for rotulo in pedidos_selecionados
        ]
        iniciar_tarefa(
            "resumo_semanal",
            _tarefa_resumo_semanal_worker,
            assinatura_semana,
            copy.deepcopy(pedidos_semana),
            numero_semana,
            ano_semana,
        )

    if tarefa_em_andamento("resumo_semanal"):
        _acompanhar_resumo_semanal(assinatura_semana)

    resultado_semana = st.session_state.get("_resumo_semanal_gerado")
    if resultado_semana and resultado_semana["assinatura"] == assinatura_semana:
        if resultado_semana["salvo"]:
            st.success(f"Resumo semanal salvo em: {resultado_semana['caminho']}")
        else:
            st.warning(
                "Não foi possível gravar o resumo semanal no armazenamento configurado. "
                "Baixe o arquivo abaixo."
            )
        st.download_button(
            "Baixar resumo semanal",
            data=resultado_semana["conteudo"],
            file_name=resultado_semana["nome"],
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            key=f"baixar_resumo_semanal_{assinatura_semana}",
            use_container_width=True,
        )

def _tarefa_atualizacao_worker(arquivos):
    from setup_db import atualizar_banco_com_planilhas

    return atualizar_banco_com_planilhas(arquivos, DATABASE_PATH)


@st.fragment(run_every=0.8)
def _acompanhar_atualizacao():
    tarefa = st.session_state.get("_tarefa_atualizacao")
    if not tarefa:
        return
    if not tarefa["futuro"].done():
        st.info(_mensagem_espera("Validando e atualizando a base…", tarefa["inicio"]))
        return
    try:
        quantidades, backup = _concluir_tarefa("atualizacao")
    except Exception:
        logging.exception("Falha na atualização da base local por planilhas")
        st.error("A base não foi alterada. Verifique se as planilhas são válidas e tente novamente.")
        return
    nomes_tipos = {
        "clientes": "clientes",
        "produtos": "produtos",
        "limites": "limites",
        "unidades": "unidades",
    }
    resumo_importacao = ", ".join(
        f"{nomes_tipos[tipo]}: {quantidade}"
        for tipo, quantidade in quantidades.items()
    )
    backup_texto = f" Backup: {backup.name}." if backup else ""
    st.session_state._resultado_atualizacao_dados = (
        f"Dados atualizados com sucesso ({resumo_importacao}).{backup_texto}"
    )
    st.session_state._versao_upload_dados += 1
    st.rerun()


if "_versao_upload_dados" not in st.session_state:
    st.session_state._versao_upload_dados = 0

with st.expander(
    "Atualizar base local",
    expanded="_resultado_atualizacao_dados" in st.session_state,
):
    st.caption("Envie somente as planilhas alteradas. Cada arquivo atualiza sua tabela correspondente.")
    versao_upload = st.session_state._versao_upload_dados
    col_upload_clientes, col_upload_produtos = st.columns(2)
    with col_upload_clientes:
        arquivo_clientes = st.file_uploader(
            "Planilha de clientes",
            type=["xlsx"],
            key=f"upload_clientes_{versao_upload}",
        )
    with col_upload_produtos:
        arquivo_produtos = st.file_uploader(
            "Planilha de produtos",
            type=["xlsx"],
            key=f"upload_produtos_{versao_upload}",
        )
    col_upload_limites, col_upload_unidades = st.columns(2)
    with col_upload_limites:
        arquivo_limites = st.file_uploader(
            "Planilha de limites",
            type=["xlsx"],
            key=f"upload_limites_{versao_upload}",
        )
    with col_upload_unidades:
        arquivo_unidades = st.file_uploader(
            "Planilha de unidades",
            type=["xlsx"],
            key=f"upload_unidades_{versao_upload}",
        )

    arquivos_upload = {
        "clientes": arquivo_clientes,
        "produtos": arquivo_produtos,
        "limites": arquivo_limites,
        "unidades": arquivo_unidades,
    }
    if st.button(
        "Validar e atualizar",
        key=f"atualizar_dados_{versao_upload}",
        disabled=tarefa_em_andamento("atualizacao") or not any(arquivos_upload.values()),
    ):
        arquivos = {
            tipo: (arquivo.name, arquivo.getvalue()) if arquivo else None
            for tipo, arquivo in arquivos_upload.items()
        }
        iniciar_tarefa("atualizacao", _tarefa_atualizacao_worker, "", arquivos)

    if tarefa_em_andamento("atualizacao"):
        _acompanhar_atualizacao()

    if "_resultado_atualizacao_dados" in st.session_state:
        st.success(st.session_state.pop("_resultado_atualizacao_dados"))

st.markdown(
    '<div class="hajan-assinatura">Powered by <strong>Anemilton Moura</strong></div>',
    unsafe_allow_html=True,
)

liberar_memoria()