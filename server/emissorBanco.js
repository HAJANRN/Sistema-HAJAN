import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';

let leitura = null;
let escrita = null;

/** Conexão de leitura, usada pelas rotas de consulta. */
export function ler() {
  if (!leitura) leitura = new DatabaseSync(DB_FILE, { readOnly: true });
  return leitura;
}

/** Conexão de escrita, usada pela geração de pedido e pela importação. */
export function gravar() {
  if (!escrita) {
    escrita = new DatabaseSync(DB_FILE);
    escrita.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  return escrita;
}

/** Fecha tudo (testes e reinício limpo). */
export function fechar() {
  leitura?.close();
  escrita?.close();
  leitura = null;
  escrita = null;
}

/** Mensagens amigáveis quando o banco unificado ainda não existe nesta máquina. */
export function responderSemBanco(res, erro) {
  const mensagem = String(erro?.message ?? erro);
  if (mensagem.includes('no such table') || mensagem.includes('unable to open') || mensagem.includes('no such file')) {
    return res.status(503).json({ error: 'banco de dados do emissor indisponível no servidor' });
  }
  throw erro;
}
