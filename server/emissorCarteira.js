import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { CARTEIRA_DIR, CREDITO_JSON } from './config.js';

const TTL_MS = 60_000;
let cache = { chave: '', quando: 0, valor: null };
/** Assinatura da pasta memorizada (lista assinada dos arquivos do grupo). */
let assinatura = { quando: 0, carimbo: '', lista: [] };

/** Campos numéricos da planilha; sem nenhum deles o arquivo não serve. */
const CAMPOS_VALOR = ['limite', 'saldoFinanceiro', 'saldoCarteira', 'saldoCredito'];

const normalizar = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const COLUNAS = {
  codigo: ['CODIGO', 'CODIGO CLIENTE', 'CODIGO CENTRALIZADOR', 'CENTRALIZADOR'],
  nome: ['NOME', 'CLIENTE', 'NOME CLIENTE', 'RAZAO SOCIAL', 'RAZAO SOCIAL PEDIDO'],
  limite: ['LIMITE', 'LIMITE DE CREDITO'],
  saldoFinanceiro: ['SALDO FINANCEIRO'],
  saldoCarteira: ['SALDO EM CARTEIRA', 'SALDO CARTEIRA'],
  saldoCredito: ['SALDO DE CREDITO', 'SALDO CREDITO', 'DISPONIVEL'],
  status: ['STATUS', 'STATUS DO CLIENTE'],
};

/** Carimbo barato da pasta (um `stat`), para antecipar a chegada de arquivo novo. */
function carimboDaPasta() {
  try {
    const info = fs.statSync(CARTEIRA_DIR);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'sem-pasta';
  }
}

function varrerPasta() {
  try {
    return fs
      .readdirSync(CARTEIRA_DIR)
      .filter((nome) => /^CARTEIRA DE TERCEIRO.*\.xlsx$/i.test(nome))
      .map((nome) => {
        const caminho = path.join(CARTEIRA_DIR, nome);
        const info = fs.statSync(caminho);
        return { nome, caminho, mtime: info.mtimeMs, tamanho: info.size };
      });
  } catch {
    return [];
  }
}

/**
 * Arquivos da pasta, assinados por nome/mtime/tamanho.
 * O legado memorizava essa assinatura por 60 s: conferir ~1400 arquivos no SMB a cada
 * requisição não é barato. O carimbo da própria pasta (um `stat`, barato) antecipa a
 * chegada de arquivo novo; remoção e alteração de conteúdo aparecem na expiração do TTL,
 * como no legado, e aí a assinatura inteira é refeita.
 */
function arquivos() {
  const agora = Date.now();
  const carimbo = carimboDaPasta();
  if (agora - assinatura.quando < TTL_MS && assinatura.carimbo === carimbo) return assinatura.lista;
  const lista = varrerPasta();
  assinatura = { quando: agora, carimbo, lista };
  return lista;
}

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

/** Data mais recente escrita no nome do arquivo; 0 quando não há data válida. */
function dataDoNome(nome) {
  let melhor = 0;
  const marcar = (dia, mes, ano) => {
    const data = new Date(ano, mes - 1, dia);
    if (data.getDate() === dia && data.getMonth() === mes - 1 && data.getFullYear() === ano) {
      melhor = Math.max(melhor, data.getTime());
    }
  };
  for (const achado of nome.matchAll(/(\d{1,2})\s*([a-zç]{3,9})\s*(\d{4})/gi)) {
    const mes = MESES[achado[2].slice(0, 3).toLowerCase().replace('ç', 'c')];
    if (mes) marcar(Number(achado[1]), mes, Number(achado[3]));
  }
  for (const achado of nome.matchAll(/(\d{2})[./-](\d{2})[./-](\d{2,4})/g)) {
    let ano = Number(achado[3]);
    if (ano < 100) ano += 2000;
    marcar(Number(achado[1]), Number(achado[2]), ano);
  }
  return melhor;
}

const dd = (n) => String(n).padStart(2, '0');
const dataBr = (ms) => {
  const d = new Date(ms);
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** Código como na planilha: 100.0 e "100" viram "100". */
function codigoPlanilha(valor) {
  const numero = Number(valor);
  if (String(valor ?? '').trim() !== '' && Number.isFinite(numero)) return String(Math.trunc(numero));
  return String(valor ?? '').trim();
}

/** Acha a linha do cabeçalho e devolve o índice de cada coluna usada. */
function mapearCabecalho(linha) {
  const celulas = linha.map(normalizar);
  const achar = (aliases) => {
    for (const alias of aliases) {
      const indice = celulas.indexOf(alias);
      if (indice >= 0) return indice;
    }
    return -1;
  };
  const mapa = {};
  for (const [campo, aliases] of Object.entries(COLUNAS)) mapa[campo] = achar(aliases);
  return mapa;
}

function lerArquivo(arquivo, colecao) {
  const livro = XLSX.read(fs.readFileSync(arquivo.caminho), { type: 'buffer' });
  const aba = livro.SheetNames[0];
  if (!aba) return;
  const linhas = XLSX.utils.sheet_to_json(livro.Sheets[aba], { header: 1, raw: true, defval: '' });
  const cabecalho = linhas.findIndex((linha) => {
    const mapa = mapearCabecalho(linha);
    return mapa.codigo >= 0 && mapa.nome >= 0 && CAMPOS_VALOR.some((campo) => mapa[campo] >= 0);
  });
  if (cabecalho < 0) return;
  const mapa = mapearCabecalho(linhas[cabecalho]);
  // Só entram os campos que a planilha realmente tem: coluna ausente não vira zero,
  // senão um arquivo sem "Limite" zeraria o limite da base ao consolidar.
  const presentes = CAMPOS_VALOR.filter((campo) => mapa[campo] >= 0);
  for (const linha of linhas.slice(cabecalho + 1)) {
    const codigo = codigoPlanilha(linha[mapa.codigo]);
    if (!codigo || codigo === '0') continue;
    const item = { nome: String(linha[mapa.nome] ?? '').trim() };
    for (const campo of presentes) {
      const valor = Number(linha[mapa[campo]]);
      item[campo] = Number.isFinite(valor) ? valor : 0;
    }
    item.status = mapa.status >= 0 ? String(linha[mapa.status] ?? '').trim() : '';
    const itens = colecao.get(codigo) ?? [];
    itens.push(item);
    colecao.set(codigo, itens);
  }
}

/**
 * As divisões repetem o consolidado e trazem recortes parciais: prevalece o maior valor,
 * e nome/status vêm da linha de maior limite. Campo que nenhum arquivo trouxe fica ausente
 * (o painel cai no valor da base em vez de zero).
 */
function consolidar(colecao) {
  const registros = {};
  for (const [codigo, itens] of colecao) {
    const base = itens.reduce((melhor, item) => ((item.limite ?? 0) > (melhor.limite ?? 0) ? item : melhor), itens[0]);
    const registro = { nome: base.nome };
    for (const campo of CAMPOS_VALOR) {
      const valores = itens.filter((item) => item[campo] !== undefined).map((item) => item[campo]);
      if (valores.length > 0) registro[campo] = Math.max(...valores);
    }
    registro.status = base.status || itens.find((item) => item.status)?.status || '';
    registros[codigo] = registro;
  }
  return registros;
}

function lerMedia() {
  const media = {};
  try {
    const bruto = JSON.parse(fs.readFileSync(CREDITO_JSON, 'utf8'));
    for (const cliente of Array.isArray(bruto.clientes) ? bruto.clientes : []) {
      const mensal = Number(cliente.media_mensal_compras_6m ?? 0);
      const informacao = {
        mediaMensal6m: Number.isFinite(mensal) ? mensal : 0,
        mediaSemana: (Number.isFinite(mensal) ? mensal : 0) * 12 / 52,
        statusCompra: String(cliente.status_compra ?? ''),
      };
      for (const codigo of Array.isArray(cliente.codigos) ? cliente.codigos : []) {
        media[codigoPlanilha(codigo)] = informacao;
      }
    }
  } catch {
    // sem JSON de média: o painel usa só a carteira
  }
  return media;
}

export function carteira() {
  const lista = arquivos();
  const chave = [
    ...lista.map((a) => `${a.nome}:${a.mtime}:${a.tamanho}`),
    fs.existsSync(CREDITO_JSON) ? String(fs.statSync(CREDITO_JSON).mtimeMs) : 'sem-media',
  ].join('|');

  if (cache.valor && cache.chave === chave && Date.now() - cache.quando < TTL_MS) {
    return cache.valor;
  }

  if (lista.length === 0) {
    const vazio = { disponivel: false };
    cache = { chave, quando: Date.now(), valor: vazio };
    return vazio;
  }

  const comData = lista.filter((arquivo) => dataDoNome(arquivo.nome) > 0);
  let grupo;
  let quando;
  if (comData.length > 0) {
    quando = Math.max(...comData.map((arquivo) => dataDoNome(arquivo.nome)));
    grupo = comData.filter((arquivo) => dataDoNome(arquivo.nome) === quando);
  } else {
    const escolhido = lista.reduce((melhor, atual) => (atual.mtime > melhor.mtime ? atual : melhor));
    grupo = [escolhido];
    quando = escolhido.mtime;
  }

  const colecao = new Map();
  for (const arquivo of [...grupo].sort((a, b) => a.nome.localeCompare(b.nome))) {
    try {
      lerArquivo(arquivo, colecao);
    } catch {
      // xlsx truncado/zip inválido: ignora este arquivo e segue com os demais,
      // como o `except Exception: continue` do leitor legado.
    }
  }

  const registros = consolidar(colecao);
  const valor = {
    disponivel: true,
    // Nenhum arquivo legível: sem data autoritativa para exibir (como o legado).
    data: Object.keys(registros).length > 0 ? dataBr(quando) : '',
    registros,
    media: lerMedia(),
  };
  cache = { chave, quando: Date.now(), valor };
  return valor;
}
