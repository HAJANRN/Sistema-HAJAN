import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import { BACKUP_DIR } from './config.js';
import { gravar } from './emissorBanco.js';

export const router = express.Router();
const LIMITE = 4 * 25 * 1024 * 1024;

const erro400 = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

const chave = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const texto = (valor) => String(valor ?? '').trim();

function numero(valor, padrao = 0) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : padrao;
  const limpo = String(valor ?? '').trim();
  if (!limpo) return padrao;
  const normalizado = limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo.replace(/\.(?=\d{3}\b)/g, '');
  const achado = Number(normalizado);
  return Number.isFinite(achado) ? achado : padrao;
}

const COLUNAS = {
  clientes: {
    aba: 'Infos Clientes',
    campos: {
      codigo: ['CODIGO'],
      nome_formatado: ['RAZAO SOCIAL PEDIDO + CODIGO'],
      cnpj: ['CNPJ'],
      prazo_padrao: ['PRAZO'],
      cidade: ['CIDADE'],
      uf: ['UF'],
      observacao: ['OBS CLIENTES PED+'],
      codigo_centralizador: ['CODIGO CENTRALIZADOR', 'CENTRA-LIZADOR'],
      status_cliente: ['STATUS DO CLIENTE', 'STATUS'],
    },
    obrigatorias: [
      'codigo',
      'nome_formatado',
      'cnpj',
      'prazo_padrao',
      'cidade',
      'uf',
      'observacao',
      'codigo_centralizador',
    ],
  },
  produtos: {
    aba: 'Infos Produtos',
    campos: {
      codigo: ['CODIGO', 'CÓDIGO'],
      descricao: ['PRODUTO FRIGORIFICO'],
      produto_pedido: ['PRODUTO PEDIDO'],
      unidade: ['UNIDADE'],
      peso: ['PESO'],
      descricao_completa: ['PRODUTO FRIGORIFICO (COMPLETO)'],
      estado_fisico: ['ESTADO FISICO (GRUPO)'],
      f_s_a: ['F/S/A'],
      linha_marca: ['LINHA (MARCA)'],
      categoria: ['CATEGORIA (DIVISAO)'],
    },
    obrigatorias: [
      'codigo',
      'descricao',
      'produto_pedido',
      'unidade',
      'peso',
      'descricao_completa',
      'estado_fisico',
      'f_s_a',
      'linha_marca',
      'categoria',
    ],
  },
  limites: {
    aba: null,
    campos: {
      codigo_centralizador: ['CODIGO', 'CODIGO CENTRALIZADOR', 'CENTRALIZADOR'],
      centralizador: ['NOME', 'CENTRALIZADOR'],
      limite: ['LIMITE'],
      disponivel: ['SALDO DE CREDITO', 'DISPONIVEL'],
    },
    obrigatorias: ['codigo_centralizador', 'centralizador', 'limite', 'disponivel'],
  },
  unidades: {
    aba: 'SiglasUnidades',
    campos: { sigla: ['SIGLA'], nome: ['NOME'], critica: ['CRITICA'] },
    obrigatorias: ['sigla', 'nome', 'critica'],
  },
};

function linhasDaAba(buffer, config, tipo) {
  const livro = XLSX.read(buffer, { type: 'buffer' });
  const aba = config.aba ?? livro.SheetNames[0];
  const planilha = livro.Sheets[aba];
  if (!planilha) throw erro400(`${tipo}: aba "${aba}" não encontrada`);
  const linhas = XLSX.utils.sheet_to_json(planilha, { header: 1, raw: true, defval: '' });

  const mapear = (linha) => {
    const celulas = linha.map(chave);
    const indice = {};
    for (const [campo, aliases] of Object.entries(config.campos)) {
      indice[campo] = aliases.map((alias) => celulas.indexOf(chave(alias))).find((i) => i >= 0) ?? -1;
    }
    return indice;
  };

  const inicio = linhas.findIndex((linha) => {
    const indice = mapear(linha);
    return config.obrigatorias.every((campo) => indice[campo] >= 0);
  });
  if (inicio < 0 || inicio > 5) {
    const indiceZero = mapear(linhas[0] ?? []);
    const faltando = config.obrigatorias
      .filter((campo) => indiceZero[campo] < 0)
      .map((campo) => config.campos[campo][0]);
    throw erro400(`${tipo}: cabeçalho sem ${faltando.join(', ') || 'as colunas esperadas'}`);
  }

  const indice = mapear(linhas[inicio]);
  return linhas
    .slice(inicio + 1)
    .map((linha) => {
      const registro = {};
      for (const [campo, posicao] of Object.entries(indice)) {
        registro[campo] = posicao >= 0 ? linha[posicao] : '';
      }
      return registro;
    });
}

function lerClientes(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.clientes, 'clientes')) {
    const codigo = texto(linha.codigo);
    if (!codigo) continue;
    const registro = {
      codigo,
      nome_formatado: texto(linha.nome_formatado),
      cnpj: texto(linha.cnpj),
      prazo_padrao: texto(linha.prazo_padrao),
      cidade: texto(linha.cidade),
      uf: texto(linha.uf).toUpperCase(),
      observacao: texto(linha.observacao),
      codigo_centralizador: texto(linha.codigo_centralizador),
      status_cliente: texto(linha.status_cliente),
    };
    if (!registro.nome_formatado) continue;
    mapa.set(codigo === '0' ? `0|${chave(registro.nome_formatado)}` : codigo, registro);
  }
  return [...mapa.values()];
}

function lerProdutos(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.produtos, 'produtos')) {
    const codigo = texto(linha.codigo);
    const descricao = texto(linha.descricao);
    if (!codigo || !descricao) continue;
    const peso = numero(linha.peso, 1);
    mapa.set(`${codigo}|${chave(descricao)}`, {
      codigo,
      descricao,
      produto_pedido: texto(linha.produto_pedido),
      unidade: texto(linha.unidade) || 'kg',
      peso: peso > 0 ? peso : 1,
      descricao_completa: texto(linha.descricao_completa),
      estado_fisico: texto(linha.estado_fisico),
      f_s_a: texto(linha.f_s_a),
      linha_marca: texto(linha.linha_marca),
      categoria: texto(linha.categoria),
    });
  }
  return [...mapa.values()];
}

function lerLimites(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.limites, 'limites')) {
    const codigo = texto(linha.codigo_centralizador);
    if (!codigo) continue;
    mapa.set(codigo, {
      codigo_centralizador: codigo,
      centralizador: texto(linha.centralizador),
      limite: numero(linha.limite, 0),
      disponivel: numero(linha.disponivel, 0),
    });
  }
  return [...mapa.values()];
}

function lerUnidades(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.unidades, 'unidades')) {
    const sigla = texto(linha.sigla).toUpperCase();
    const nome = texto(linha.nome);
    if (!sigla || !nome) continue;
    mapa.set(sigla, { sigla, nome, critica: texto(linha.critica).toUpperCase() });
  }
  return [...mapa.values()];
}

const TABELAS = {
  clientes: {
    limpar: 'DELETE FROM emissor_clientes',
    inserir: `INSERT INTO emissor_clientes
      (codigo, nome_formatado, cnpj, prazo_padrao, cidade, uf, observacao, codigo_centralizador, status_cliente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valores: (r) => [r.codigo, r.nome_formatado, r.cnpj, r.prazo_padrao, r.cidade, r.uf, r.observacao, r.codigo_centralizador, r.status_cliente],
    ler: lerClientes,
  },
  produtos: {
    limpar: 'DELETE FROM emissor_produtos',
    inserir: `INSERT INTO emissor_produtos
      (codigo, descricao, produto_pedido, unidade, peso, descricao_completa, estado_fisico, f_s_a, linha_marca, categoria)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valores: (r) => [r.codigo, r.descricao, r.produto_pedido, r.unidade, r.peso, r.descricao_completa, r.estado_fisico, r.f_s_a, r.linha_marca, r.categoria],
    ler: lerProdutos,
  },
  limites: {
    limpar: 'DELETE FROM emissor_limites_clientes',
    inserir: `INSERT INTO emissor_limites_clientes
      (codigo_centralizador, centralizador, limite, disponivel) VALUES (?, ?, ?, ?)`,
    valores: (r) => [r.codigo_centralizador, r.centralizador, r.limite, r.disponivel],
    ler: lerLimites,
  },
  unidades: {
    limpar: 'DELETE FROM emissor_unidades_carregamento',
    inserir: `INSERT INTO emissor_unidades_carregamento (sigla, nome, critica) VALUES (?, ?, ?)`,
    valores: (r) => [r.sigla, r.nome, r.critica],
    ler: lerUnidades,
  },
};

function backupDoBanco(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(BACKUP_DIR, `hajan-${carimbo}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const antigos = fs
    .readdirSync(BACKUP_DIR)
    .filter((nome) => /^hajan-.*\.db$/.test(nome))
    .sort()
    .reverse();
  for (const nome of antigos.slice(10)) fs.unlinkSync(path.join(BACKUP_DIR, nome));
  return destino;
}

router.post('/importar', express.raw({ type: 'multipart/form-data', limit: LIMITE }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw erro400('envie as planilhas no corpo multipart/form-data');
    }
    const formulario = await new Request('http://local/importar', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body: req.body,
    }).formData();

    const planilhas = {};
    for (const tipo of Object.keys(TABELAS)) {
      const arquivo = formulario.get(tipo);
      if (!arquivo || typeof arquivo === 'string') continue;
      if (!/\.xlsx$/i.test(arquivo.name)) throw erro400(`${tipo}: envie um arquivo .xlsx`);
      if (arquivo.size > 25 * 1024 * 1024) throw erro400(`${tipo}: arquivo acima de 25 MB`);
      const bytes = Buffer.from(await arquivo.arrayBuffer());
      if (bytes.subarray(0, 2).toString() !== 'PK') throw erro400(`${tipo}: arquivo não é uma planilha xlsx válida`);
      let registros;
      try {
        registros = TABELAS[tipo].ler(bytes);
      } catch (erro) {
        if (erro.status === 400) throw erro;
        throw erro400(`${tipo}: não consegui ler a planilha (${erro.message})`);
      }
      if (registros.length === 0) throw erro400(`${tipo}: nenhuma linha válida na planilha`);
      planilhas[tipo] = registros;
    }

    if (Object.keys(planilhas).length === 0) throw erro400('envie pelo menos uma planilha');

    const db = gravar();
    const backup = backupDoBanco(db);
    const contagens = { clientes: 0, produtos: 0, limites: 0, unidades: 0 };

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [tipo, registros] of Object.entries(planilhas)) {
        const config = TABELAS[tipo];
        db.exec(config.limpar);
        const inserir = db.prepare(config.inserir);
        for (const registro of registros) inserir.run(...config.valores(registro));
        contagens[tipo] = registros.length;
      }
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    }

    res.json({ backup, contagens });
  } catch (erro) {
    if (erro.status === 400) return res.status(400).json({ error: erro.message });
    const mensagem = String(erro?.message ?? erro);
    if (/no such table|unable to open|no such file/.test(mensagem)) {
      return res.status(503).json({ error: 'banco de dados do emissor indisponível no servidor' });
    }
    console.error('falha na importação:', erro);
    res.status(500).json({ error: `não consegui importar: ${mensagem}` });
  }
});
