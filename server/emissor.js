import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';

export const router = express.Router();

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

let banco = null;

function conexao() {
  if (!banco) {
    banco = new DatabaseSync(DB_FILE, { readOnly: true });
  }
  return banco;
}

function isoLocal(data) {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mes}-${dia}`;
}

/** Período de entrega; sem parâmetros, cobre os últimos 30 dias. */
function periodo(query) {
  const hoje = new Date();
  const de = String(query.de ?? isoLocal(new Date(hoje.getTime() - 30 * 86_400_000)));
  const ate = String(query.ate ?? isoLocal(hoje));
  if (!DATA_ISO.test(de) || !DATA_ISO.test(ate)) {
    throw Object.assign(new Error('use datas no formato AAAA-MM-DD'), { status: 400 });
  }
  if (ate < de) {
    throw Object.assign(new Error('a data final é anterior à inicial'), { status: 400 });
  }
  return { de, ate };
}

function responderSemBanco(res, erro) {
  const mensagem = String(erro?.message ?? erro);
  if (mensagem.includes('no such table')) {
    return res.status(503).json({
      error: 'o banco unificado ainda não foi migrado nesta máquina (scripts/unificar-banco.mjs)',
    });
  }
  if (mensagem.includes('unable to open') || mensagem.includes('no such file')) {
    return res.status(503).json({ error: 'banco de dados indisponível no servidor' });
  }
  throw erro;
}

router.get('/saude', (req, res) => {
  try {
    const db = conexao();
    const clientes = db.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c;
    const produtos = db.prepare('SELECT COUNT(*) c FROM emissor_produtos').get().c;
    const pedidos = db.prepare('SELECT COUNT(*) c FROM emissor_pedidos_semana').get().c;
    res.json({ ok: true, banco: DB_FILE, clientes, produtos, pedidos });
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});

router.get('/catalogo', (req, res) => {
  try {
    const db = conexao();
    const unidades = db
      .prepare(
        'SELECT sigla, nome FROM emissor_unidades_carregamento ORDER BY sigla COLLATE NOCASE',
      )
      .all();
    const contagens = {
      clientes: db.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c,
      produtos: db.prepare('SELECT COUNT(*) c FROM emissor_produtos').get().c,
      limites: db.prepare('SELECT COUNT(*) c FROM emissor_limites_clientes').get().c,
      unidades: unidades.length,
    };
    res.json({ contagens, unidades });
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});

router.get('/pedidos', (req, res) => {
  let de;
  let ate;
  try {
    ({ de, ate } = periodo(req.query));
  } catch (erro) {
    return res.status(erro.status ?? 400).json({ error: erro.message });
  }
  try {
    const db = conexao();
    const registros = db
      .prepare(
        'SELECT numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas ' +
          'FROM emissor_pedidos_semana WHERE data_entrega BETWEEN ? AND ? ' +
          'ORDER BY data_entrega DESC, CAST(numero AS INTEGER) DESC, categoria',
      )
      .all(de, ate);

    const pedidos = registros.map((registro) => {
      let linhas = [];
      try {
        linhas = JSON.parse(registro.linhas) ?? [];
      } catch {
        linhas = [];
      }
      const clientes = [
        ...new Set(
          linhas
            .map((linha) => (linha.cliente || linha.destino || '').trim())
            .filter(Boolean),
        ),
      ];
      return {
        numero: registro.numero,
        tipo: registro.categoria,
        unidade: registro.sigla ? `R0 ${registro.sigla}` : '',
        embarque: registro.data_embarque,
        entrega: registro.data_entrega,
        criadoEm: registro.criado_em,
        destinos: linhas.length,
        clientes,
      };
    });

    res.json({ de, ate, total: pedidos.length, pedidos });
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});

router.get('/pedidos/:numero/clonar', (req, res) => {
  try {
    const db = conexao();
    const registro = db
      .prepare('SELECT payload FROM emissor_pedidos_clonagem WHERE numero = ?')
      .get(String(req.params.numero).trim());
    if (!registro) return res.status(404).json({ error: 'pedido não encontrado' });
    res.json(JSON.parse(registro.payload));
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});
