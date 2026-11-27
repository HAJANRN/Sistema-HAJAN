import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CLONES_DIR, DB_FILE } from './config.js';
import { ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';

export const router = express.Router();

/**
 * Banco fora do ar vira 503 amigável (`responderSemBanco`); qualquer outro erro fica só no log
 * do servidor e vira JSON genérico — a página HTML do Express mostraria stack e caminho
 * absoluto. `mensagem` é o único texto que chega ao cliente; o detalhe pode conter caminho do SMB.
 */
function responderErro(res, erro, mensagem) {
  try {
    responderSemBanco(res, erro);
  } catch {
    console.error(`${mensagem}:`, erro);
    if (!res.headersSent) res.status(500).json({ error: mensagem });
  }
}

router.get('/base', (req, res) => {
  try {
    const db = ler();
    const clientes = db
      .prepare(
        `SELECT c.codigo, c.nome_formatado AS nome, COALESCE(c.cnpj,'') AS cnpj,
                COALESCE(c.prazo_padrao,'') AS prazo, COALESCE(c.cidade,'') AS cidade,
                COALESCE(c.uf,'') AS uf, COALESCE(c.status_cliente,'') AS statusCliente,
                COALESCE(c.codigo_centralizador,'') AS codigoCentralizador,
                COALESCE(l.centralizador,'') AS centralizador,
                COALESCE(l.limite,0) AS limite, COALESCE(l.disponivel,0) AS disponivel
           FROM emissor_clientes c
           LEFT JOIN emissor_limites_clientes l
             ON COALESCE(NULLIF(TRIM(c.codigo_centralizador),''), c.codigo) = l.codigo_centralizador
          ORDER BY c.nome_formatado COLLATE NOCASE`,
      )
      .all();

    const produtos = db
      .prepare(
        `SELECT codigo, descricao, COALESCE(unidade,'kg') AS unidade,
                COALESCE(peso,1) AS peso, COALESCE(categoria,'') AS categoria
           FROM emissor_produtos ORDER BY descricao COLLATE NOCASE`,
      )
      .all()
      .map((p) => ({ ...p, rotulo: `${p.codigo} - ${p.descricao}` }));

    const unidades = db
      .prepare('SELECT sigla, nome, COALESCE(critica,\'\') AS critica FROM emissor_unidades_carregamento ORDER BY sigla COLLATE NOCASE')
      .all()
      .map((u) => ({ ...u, rotulo: `${u.sigla} - ${u.nome}` }));

    const maior = db
      .prepare('SELECT MAX(CAST(numero AS INTEGER)) AS m FROM emissor_pedidos_semana')
      .get().m;

    // destinos da operação 3: todos os clientes, SEM DESTINO primeiro (listar_destinos_operacao_3)
    // o legado deduplica com `set`; cliente homônimo não pode aparecer duas vezes na lista
    const destinos = [...new Set(['SEM DESTINO', ...clientes.map((cliente) => cliente.nome)])];

    const revision = String(fs.statSync(DB_FILE).mtimeMs);
    res.json({
      revision,
      clientes,
      produtos,
      unidades,
      proximoNumero: String((maior ?? 0) + 1),
      destinos,
    });
  } catch (erro) {
    responderErro(res, erro, 'não consegui ler a base do emissor');
  }
});

router.get('/carteira', (req, res) => {
  try {
    res.json(carteira());
  } catch (erro) {
    responderErro(res, erro, 'não consegui ler a carteira de crédito');
  }
});

/** Número só entra em nome de arquivo com estes caracteres. */
function nomeSeguro(texto) {
  const nome = String(texto ?? '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(nome) ? nome : null;
}

router.get('/clones/:numero', (req, res) => {
  const numero = nomeSeguro(req.params.numero);
  if (!numero) return res.status(400).json({ error: 'número de pedido inválido' });
  const tipo = String(req.query.tipo ?? '').toUpperCase();
  try {
    const db = ler();
    const registro = db
      .prepare('SELECT payload FROM emissor_pedidos_clonagem WHERE numero = ?')
      .get(numero);
    if (registro) {
      try {
        // mesmo regime tolerante da rede: payload corrompido no banco cai para o arquivo
        // (legado `_carregar_clone_banco` devolve None e segue para `_carregar_clone_rede`)
        const payload = JSON.parse(registro.payload);
        return res.json({ encontrado: true, fonte: 'banco', payload });
      } catch {
        console.warn(`payload de clonagem inválido para o pedido nº ${numero}, tentando a rede`);
      }
    }

    const arquivo = path.join(CLONES_DIR, `${numero}.json`);
    if (fs.existsSync(arquivo)) {
      try {
        return res.json({
          encontrado: true,
          fonte: 'rede',
          payload: JSON.parse(fs.readFileSync(arquivo, 'utf8')),
        });
      } catch {
        // JSON corrompido na rede: segue para o histórico
      }
    }

    const categorias = db
      .prepare('SELECT DISTINCT categoria FROM emissor_pedidos_semana WHERE numero = ?')
      .all(numero)
      .map((linha) => linha.categoria);
    const outro = tipo === 'CXS' ? 'PÇS' : 'CXS';
    if (tipo && categorias.includes(outro) && !categorias.includes(tipo)) {
      return res.json({ encontrado: false, outroTipo: outro });
    }
    res.json({ encontrado: false });
  } catch (erro) {
    responderErro(res, erro, 'não consegui ler o clone do pedido');
  }
});
