import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CLONES_DIR, DB_FILE, PDF_DIRS, PDF_LOCAL_DIR } from './config.js';
import { gravar, ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';
import { gerarPdf } from './emissorPdf.js';
import {
  categoriasDoPedido,
  dataBr,
  ehEsc,
  linhasHistorico,
  nomeArquivoPdf,
  resumoPedido,
} from './emissorRegras.js';

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

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const NOME_PDF = /^[^<>:"/\\|?*\u0000-\u001f]{1,180}\.pdf$/;

const erro400 = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

function siglaDaUnidade(unidade) {
  return String(unidade ?? '').trim().split(/\s*-\s*/)[0].slice(0, 12) || 'SEM';
}

function pastasDoPdf() {
  const pastas = PDF_DIRS.filter((dir) => fs.existsSync(dir));
  const local = PDF_LOCAL_DIR;
  if (!pastas.includes(local)) {
    try {
      fs.mkdirSync(local, { recursive: true });
      pastas.push(local);
    } catch {
      // sem a pasta local: o PDF fica só onde a rede permitir
    }
  }
  return pastas;
}

function gravarAtomico(caminho, conteudo) {
  const temporario = `${caminho}.tmp`;
  fs.writeFileSync(temporario, conteudo);
  fs.renameSync(temporario, caminho);
}

router.post('/pedidos', async (req, res) => {
  const avisos = [];
  try {
    const bruto = req.body ?? {};
    const numero = String(bruto.numero ?? '').trim();
    if (!/^\d{1,10}$/.test(numero)) throw erro400('informe o número do pedido (só dígitos)');
    for (const [campo, chave] of [['emissão', 'dataEmissao'], ['embarque', 'dataEmbarque'], ['entrega', 'dataEntrega']]) {
      if (!ISO.test(String(bruto[chave] ?? ''))) throw erro400(`data de ${campo} inválida`);
    }
    const entregasBrutas = Array.isArray(bruto.entregas) ? bruto.entregas : [];
    if (entregasBrutas.length === 0) throw erro400('inclua pelo menos uma entrega');

    const db = gravar();
    const catalogo = new Map(
      db
        .prepare('SELECT codigo, descricao, unidade, peso, categoria FROM emissor_produtos')
        .all()
        .map((p) => [String(p.codigo), p]),
    );
    const clientesPorNome = new Map(
      db
        .prepare(
          `SELECT nome_formatado AS nome, COALESCE(cnpj,'') AS cnpj, COALESCE(cidade,'') AS cidade,
                  COALESCE(uf,'') AS uf, COALESCE(prazo_padrao,'') AS prazo_padrao
             FROM emissor_clientes`,
        )
        .all()
        .map((c) => [c.nome, c]),
    );

    const entregas = entregasBrutas.map((entrega, indice) => {
      const cliente = String(entrega.cliente ?? '').trim();
      if (!cliente) throw erro400(`entrega ${indice + 1}: informe o cliente`);
      const destino = String(entrega.destino ?? '').trim();
      const operacao = Number(entrega.operacao) === 9 ? 9 : 3;
      const dadosCliente = clientesPorNome.get(cliente);
      const esc = ehEsc(cliente) || ehEsc(destino);

      if (esc) {
        const pesoManual = Number(entrega.pesoManual);
        if (!Number.isFinite(pesoManual) || pesoManual <= 0) {
          throw erro400(`entrega ${indice + 1}: ESC exige peso manual maior que zero`);
        }
        return {
          cliente,
          operacao,
          destino,
          pesoManual,
          peso: pesoManual,
          prazo: dadosCliente?.prazo_padrao ?? '',
          produtos: [],
        };
      }

      const produtos = (Array.isArray(entrega.produtos) ? entrega.produtos : []).map((produto) => {
        const codigo = String(produto.codigo ?? '').trim();
        const doCatalogo = catalogo.get(codigo);
        const qtd = Number(produto.qtd);
        if (!codigo || !Number.isFinite(qtd) || qtd < 1) {
          throw erro400(`entrega ${indice + 1}: produto com código ou quantidade inválida`);
        }
        return {
          codigo,
          descricao: String(produto.descricao ?? doCatalogo?.descricao ?? '').trim(),
          qtd,
          unidade: String(produto.unidade ?? doCatalogo?.unidade ?? 'kg'),
          peso: Number(doCatalogo?.peso ?? produto.peso ?? 1) || 1,
          preco: Number(produto.preco ?? 0) || 0,
          prazo: String(produto.prazo ?? dadosCliente?.prazo_padrao ?? ''),
          // categoria vazia conta como ausente: cai na do catálogo e, sem ela, em PÇS — o mesmo
          // padrão que `categoriasDoPedido` usa quando nenhum produto tem categoria; sem isso o
          // pedido sairia com histórico PÇS e nenhuma linha dentro.
          categoria:
            String(produto.categoria ?? '').trim() ||
            String(doCatalogo?.categoria ?? '').trim() ||
            'PÇS',
        };
      });
      if (produtos.length === 0) throw erro400(`entrega ${indice + 1}: inclua ao menos um produto`);

      const peso = produtos.reduce((soma, p) => soma + p.qtd * p.peso, 0);
      return {
        cliente,
        operacao,
        destino,
        pesoManual: null,
        peso,
        prazo: dadosCliente?.prazo_padrao ?? '',
        produtos,
      };
    });

    const resumo = resumoPedido({ entregas });
    const sigla = siglaDaUnidade(bruto.unidade);
    const pedidoPdf = {
      numero,
      sigla,
      categorias: resumo.categorias,
      atencao: String(bruto.atencao ?? ''),
      local: String(bruto.local ?? ''),
      unidade: String(bruto.unidade ?? ''),
      observacao: String(bruto.observacao ?? ''),
      dataEmissao: bruto.dataEmissao,
      dataEmbarque: bruto.dataEmbarque,
      dataEntrega: bruto.dataEntrega,
      pesoTotal: resumo.pesoTotal,
      veiculo: resumo.veiculo,
      nfsRemessa: resumo.nfsRemessa,
      entregas,
    };

    const buffer = await gerarPdf(pedidoPdf, { clientes: clientesPorNome });
    const arquivo = nomeArquivoPdf({
      numero,
      categorias: resumo.categorias,
      sigla,
      dataEmbarque: bruto.dataEmbarque,
    });

    const salvoEm = [];
    for (const pasta of pastasDoPdf()) {
      try {
        gravarAtomico(path.join(pasta, arquivo), buffer);
        salvoEm.push(pasta);
      } catch {
        avisos.push(`não foi possível gravar em ${pasta}`);
      }
    }
    if (salvoEm.length === 0) throw new Error('nenhuma pasta de PDF disponível');

    const categoriasHistorico = categoriasDoPedido(entregas).filter(
      (c) => c === 'PÇS' || c === 'CXS',
    );
    const agora = new Date().toISOString();
    let registradoNoHistorico = false;
    if (categoriasHistorico.length === 0) {
      avisos.push('pedido sem PÇS nem CXS: PDF e clone gerados, histórico não registrado');
    }

    const payloadClone = {
      numero,
      atencao: pedidoPdf.atencao,
      local: pedidoPdf.local,
      unidade: pedidoPdf.unidade,
      observacao: pedidoPdf.observacao,
      data_pedido: dataBr(bruto.dataEmissao),
      data_embarque: dataBr(bruto.dataEmbarque),
      data_entrega: dataBr(bruto.dataEntrega),
      entregas: entregas.map((e) => ({
        cliente: e.cliente,
        destino: e.destino,
        operacao: e.operacao,
        ...(e.pesoManual != null ? { peso_manual: e.pesoManual } : {}),
        produtos: e.produtos.map((p) => ({
          codigo: p.codigo,
          descricao: p.descricao,
          qtd: p.qtd,
          unidade: p.unidade,
          peso: p.peso,
          preco: p.preco,
          prazo: p.prazo,
        })),
      })),
    };

    // O número é ocupado numa única transação: histórico e clone entram juntos ou não
    // entram. `BEGIN IMMEDIATE` pega o lock de escrita antes de qualquer INSERT, então
    // duas máquinas digitando o mesmo número não se intercalam.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (categoriasHistorico.length > 0) {
        const inserir = db.prepare(
          `INSERT OR REPLACE INTO emissor_pedidos_semana
             (numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const categoria of categoriasHistorico) {
          const linhas = JSON.stringify(linhasHistorico(entregas, clientesPorNome, categoria));
          inserir.run(numero, categoria, sigla, bruto.dataEmbarque, bruto.dataEntrega, agora, linhas);
        }
        registradoNoHistorico = true;
      }
      db.prepare(
        'INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)',
      ).run(numero, agora, JSON.stringify(payloadClone));
      db.exec('COMMIT');
    } catch (erro) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // transação já desfeita pelo SQLite: nada a fazer
      }
      throw erro;
    }

    try {
      fs.mkdirSync(CLONES_DIR, { recursive: true });
      gravarAtomico(path.join(CLONES_DIR, `${numero}.json`), JSON.stringify(payloadClone, null, 2));
    } catch {
      avisos.push(`não foi possível gravar o clone em ${CLONES_DIR}`);
    }

    res.json({
      ok: true,
      pedido: {
        categorias: resumo.categorias,
        pesoTotal: resumo.pesoTotal,
        valor: resumo.valor,
        veiculo: resumo.veiculo,
        entregas: resumo.entregas,
        nfsRemessa: resumo.nfsRemessa,
        registradoNoHistorico,
      },
      arquivo,
      salvoEm,
      download: `/api/emissor/pedidos/pdf/${encodeURIComponent(arquivo)}`,
      avisos,
    });
  } catch (erro) {
    if (erro?.status === 400) return res.status(400).json({ error: erro.message });
    responderErro(res, erro, 'não consegui gerar o pedido');
  }
});

router.get('/pedidos/pdf/:arquivo', (req, res) => {
  const nome = String(req.params.arquivo ?? '');
  if (!NOME_PDF.test(nome) || path.basename(nome) !== nome) {
    return res.status(400).json({ error: 'nome de arquivo inválido' });
  }
  // `sendFile` com callback: arquivo apagado (ou pasta fora do ar) entre a checagem e a leitura
  // cai no callback como ENOENT e vira o mesmo JSON de erro. Sem o callback o Express responde
  // a página HTML dele, com stack e caminho absoluto.
  res.sendFile(nome, { root: PDF_LOCAL_DIR }, (erro) => {
    if (!erro) return;
    if (res.headersSent) {
      console.error('falha ao enviar o PDF do pedido (resposta já iniciada):', erro);
      return;
    }
    if (erro.code === 'ENOENT' || erro.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'PDF não encontrado nesta máquina' });
    }
    responderErro(res, erro, 'não consegui ler o PDF do pedido');
  });
});
