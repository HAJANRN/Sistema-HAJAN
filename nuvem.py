"""Armazenamento no Firebase (Storage para arquivos, Firestore para a clonagem).

Substitui as pastas fixas do escritório (D:\\ e S:\\). Fica ativo quando
FIREBASE_STORAGE_BUCKET está definido; a credencial é o arquivo .json da conta
de serviço, apontado por FIREBASE_CREDENTIALS ou GOOGLE_APPLICATION_CREDENTIALS.
Sem essas variáveis, todas as funções retornam vazio e o app segue sem nuvem.
"""

import logging
import os
import threading

PREFIXO_PDFS = "pedidos/pdf/"
PREFIXO_CARTEIRA = "credito/carteira/"
CAMINHO_MEDIA_COMPRAS = "credito/decisao_credito.json"
COLECAO_CLONES = "pedidos_clonagem"

_trava = threading.Lock()
_estado = {"app": None, "falhou": False}


def configurado():
    return bool(os.environ.get("FIREBASE_STORAGE_BUCKET")) and not _estado["falhou"]


def _app():
    if not configurado():
        return None
    with _trava:
        if _estado["app"] is not None:
            return _estado["app"]
        try:
            import firebase_admin
            from firebase_admin import credentials

            arquivo = os.environ.get("FIREBASE_CREDENTIALS") or os.environ.get(
                "GOOGLE_APPLICATION_CREDENTIALS"
            )
            credencial = (
                credentials.Certificate(arquivo)
                if arquivo
                else credentials.ApplicationDefault()
            )
            opcoes = {"storageBucket": os.environ["FIREBASE_STORAGE_BUCKET"]}
            if os.environ.get("FIREBASE_PROJECT_ID"):
                opcoes["projectId"] = os.environ["FIREBASE_PROJECT_ID"]
            _estado["app"] = firebase_admin.initialize_app(
                credencial, opcoes, name="hajan"
            )
        except Exception:
            logging.exception("Falha ao iniciar o Firebase; seguindo sem nuvem")
            _estado["falhou"] = True
            return None
        return _estado["app"]


def _bucket():
    app = _app()
    if app is None:
        return None
    from firebase_admin import storage

    return storage.bucket(app=app)


def _firestore():
    app = _app()
    if app is None:
        return None
    from firebase_admin import firestore

    return firestore.client(app=app)


def salvar_arquivo(caminho, conteudo, tipo="application/octet-stream"):
    bucket = _bucket()
    if bucket is None:
        raise OSError("Firebase não configurado")
    try:
        bucket.blob(caminho).upload_from_string(conteudo, content_type=tipo)
    except Exception as erro:
        raise OSError(f"Falha ao enviar {caminho} ao Firebase: {erro}") from erro
    return f"Firebase: {caminho}"


def ler_arquivo(caminho):
    bucket = _bucket()
    if bucket is None:
        return None
    try:
        blob = bucket.blob(caminho)
        if not blob.exists():
            return None
        return blob.download_as_bytes()
    except Exception:
        logging.exception("Falha ao ler %s no Firebase", caminho)
        return None


def listar(prefixo):
    """Lista (caminho, instante em segundos, tamanho) dos arquivos do prefixo."""
    bucket = _bucket()
    if bucket is None:
        return []
    try:
        return [
            (
                blob.name,
                blob.updated.timestamp() if blob.updated else 0.0,
                blob.size or 0,
            )
            for blob in bucket.list_blobs(prefix=prefixo)
            if not blob.name.endswith("/")
        ]
    except Exception:
        logging.exception("Falha ao listar %s no Firebase", prefixo)
        return []


def info_arquivo(caminho):
    bucket = _bucket()
    if bucket is None:
        return None
    try:
        blob = bucket.get_blob(caminho)
    except Exception:
        logging.exception("Falha ao consultar %s no Firebase", caminho)
        return None
    if blob is None:
        return None
    return (blob.updated.timestamp() if blob.updated else 0.0, blob.size or 0)


def salvar_clone(numero, dados):
    banco = _firestore()
    if banco is None:
        return False
    try:
        banco.collection(COLECAO_CLONES).document(str(numero)).set(dados)
        return True
    except Exception:
        logging.exception("Falha ao gravar o pedido nº %s no Firestore", numero)
        return False


def ler_clone(numero):
    banco = _firestore()
    if banco is None:
        return None
    try:
        documento = banco.collection(COLECAO_CLONES).document(str(numero)).get()
    except Exception:
        logging.exception("Falha ao ler o pedido nº %s no Firestore", numero)
        return None
    return documento.to_dict() if documento.exists else None
