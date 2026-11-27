import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

const NET_ROOT = process.env.FRIBOI_NET_ROOT ?? 'S:\\FRIBOI\\zzz Gestão Pedidos';
const PEDIDOS_ROOT = process.env.FRIBOI_PEDIDOS_ROOT ?? 'S:\\FRIBOI\\Pedidos';

const splitDirs = (value) =>
  value
    ? value
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
    : null;

export const XLSX_DIRS = splitDirs(process.env.FRIBOI_XLSX_DIRS) ?? [
  path.join(NET_ROOT, '@ Acompanhamento Pedido CXS'),
  path.join(NET_ROOT, '@@ ResumoSemanal CXS'),
  path.join(NET_ROOT, '@@ ResumoSemanal PÇS'),
  path.join(PEDIDOS_ROOT, 'CHQ'),
];

/**
 * Pasta local (nesta máquina) do PDF do pedido: é de onde o download serve o arquivo, porque a
 * pasta de rede pode estar fora do ar na hora do GET. Nos testes aponta para um diretório
 * temporário, para a suíte não espalhar PDFs dentro do repositório.
 */
export const PDF_LOCAL_DIR = process.env.FRIBOI_PDF_LOCAL_DIR ?? path.join(ROOT, 'pedidos-pdf');

export const PDF_DIRS = splitDirs(process.env.FRIBOI_PDF_DIRS) ?? [
  path.join(NET_ROOT, 'Pedidos Ped+'),
  PDF_LOCAL_DIR,
];

/** Pasta onde o ERP exporta "CARTEIRA DE TERCEIRO*.xlsx". */
export const CARTEIRA_DIR = process.env.FRIBOI_CARTEIRA_DIR ?? 'S:\\FRIBOI\\financeiro\\carteira clientes';

/** Clone em JSON ao lado dos PDFs, para quando o banco não tiver o pedido. */
export const CLONES_DIR = process.env.FRIBOI_CLONES_DIR ?? path.join(NET_ROOT, 'Pedidos Ped+', '_clone_data');

/** Média de compras por cliente (JSON exportado pela análise de crédito); ausente = regra de média omitida. */
export const CREDITO_JSON =
  process.env.FRIBOI_CREDITO_JSON ?? path.join(ROOT, 'credito', 'decisao_credito.json');

/** Faturamento do ERP: só leitura, usado para mostrar as NFs e o valor de cada pedido. */
export const FATURAMENTO_DIRS = splitDirs(process.env.FRIBOI_FATURAMENTO_DIRS) ?? [
  path.join(NET_ROOT, 'Dados de faturamento'),
];

/**
 * Banco único do sistema (Acompanhamento + Emissor). Enquanto a unificação não é
 * aplicada na máquina, cai no banco antigo do Acompanhamento.
 */
const bancoUnificado = path.join(ROOT, 'data', 'hajan.db');
const bancoPadrao = fs.existsSync(bancoUnificado)
  ? bancoUnificado
  : path.join(ROOT, 'data', 'expedicao.db');

export const DB_FILE = process.env.FRIBOI_DB ?? bancoPadrao;
export const DIST_DIR = path.join(ROOT, 'dist');
export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.FRIBOI_HOST ?? '0.0.0.0';
export const POLL_INTERVAL = Number(process.env.FRIBOI_POLL_MS ?? 15000);

/** Pasta de relatórios onde as anomalias são arquivadas (criamos arquivos novos, nunca editamos os existentes). */
export const ANEXO_ROOT = process.env.FRIBOI_ANEXO_ROOT ?? 'S:\\FRIBOI\\infos relatorios';
export const SPOOL_DIR = path.join(ROOT, 'data', 'anexos-fila');
export const ANEXO_MAX_BYTES = Number(process.env.FRIBOI_ANEXO_MAX ?? 25 * 1024 * 1024);

/**
 * Chave do acesso de fora (rede privada). Pode vir da variável de ambiente; sem ela geramos uma
 * na primeira execução e guardamos em data/chave-visita.txt, para o link continuar válido depois de
 * reiniciar o servidor.
 */
export const VISITA_CHAVE_ARQUIVO = path.join(ROOT, 'data', 'chave-visita.txt');

function chaveVisita() {
  if (process.env.FRIBOI_TOKEN_VISITA) return process.env.FRIBOI_TOKEN_VISITA;
  try {
    const guardada = fs.readFileSync(VISITA_CHAVE_ARQUIVO, 'utf8').trim();
    if (guardada) return guardada;
  } catch {
    // ainda não existe
  }
  const nova = randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(VISITA_CHAVE_ARQUIVO), { recursive: true });
    fs.writeFileSync(VISITA_CHAVE_ARQUIVO, `${nova}\n`);
  } catch {
    console.warn('não consegui guardar a chave de visita em data/chave-visita.txt');
  }
  return nova;
}

export const VISITA_TOKEN = chaveVisita();
export const VISITA_DIAS = Number(process.env.FRIBOI_VISITA_DIAS ?? 30);

/** Senha da área administrativa (importação, ajustes, servidor). Guardamos só o hash. */
export const SENHA_ARQUIVO = path.join(ROOT, 'data', 'senha-admin.txt');
export const SENHA_AMBIENTE = process.env.FRIBOI_SENHA ?? '';
export const USUARIO_AMBIENTE = process.env.FRIBOI_USUARIO ?? 'admin';
export const ADMIN_HORAS = Number(process.env.FRIBOI_SESSAO_ADMIN_HORAS ?? 12);

/** Endereço que as outras máquinas da rede usam para chegar neste servidor. */
const rangePrivada = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

export function lanUrl() {
  const adapters = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal && item.family === 'IPv4');
  // o túnel (100.64/10) não é a rede do escritório: link LAN continua apontando para o adaptador físico
  const fisicas = adapters.filter(
    (item) => !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(item.address),
  );
  const adapter = fisicas.find((item) => rangePrivada(item.address)) ?? fisicas[0] ?? adapters[0];
  return adapter ? `http://${adapter.address}:${PORT}` : null;
}

/** Endereços do túnel, para o painel mostrar o link que a pessoa de fora deve usar. */
export function tunnelUrl() {
  const adapter = Object.values(os.networkInterfaces())
    .flat()
    .find(
      (item) => item && !item.internal && item.family === 'IPv4' && /^100\./.test(item.address),
    );
  return adapter ? `http://${adapter.address}:${PORT}` : null;
}
