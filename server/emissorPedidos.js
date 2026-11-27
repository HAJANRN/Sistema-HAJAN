import fs from 'node:fs';
import express from 'express';
import { DB_FILE } from './config.js';
import { ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';

export const router = express.Router();

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
    responderSemBanco(res, erro);
  }
});

router.get('/carteira', (req, res) => {
  try {
    res.json(carteira());
  } catch (erro) {
    // o detalhe pode conter caminho do SMB: fica no log do servidor, não na resposta
    console.error('não consegui ler a carteira:', erro);
    res.status(500).json({ error: 'não consegui ler a carteira de crédito' });
  }
});
