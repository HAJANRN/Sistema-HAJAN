import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

export const RAIZ = fileURLToPath(new URL('..', import.meta.url));

export interface Api {
  dir: string;
  db: string;
  pdfs: string;
  clones: string;
  carteira: string;
  url: string;
  get: (rota: string) => Promise<Response>;
  post: (rota: string, corpo: unknown) => Promise<Response>;
  postArquivos: (rota: string, campos: Record<string, File>) => Promise<Response>;
  fechar: () => Promise<void>;
}

/**
 * Sobe os routers do emissor numa cópia temporária do banco.
 * A config é lida no import; por isso os env vars são definidos antes do import dinâmico.
 */
export async function montarApi(): Promise<Api> {
  const origem = path.join(RAIZ, 'data', 'hajan.db');
  assert.ok(fs.existsSync(origem), 'data/hajan.db precisa existir para rodar os testes');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajan-teste-'));
  const db = path.join(dir, 'hajan.db');
  fs.copyFileSync(origem, db);
  const pdfs = path.join(dir, 'pdfs');
  const clones = path.join(dir, 'clones');
  const carteira = path.join(dir, 'carteira');
  for (const pasta of [pdfs, clones, carteira]) fs.mkdirSync(pasta, { recursive: true });

  process.env.FRIBOI_DB = db;
  process.env.FRIBOI_PDF_DIRS = pdfs;
  process.env.FRIBOI_CLONES_DIR = clones;
  process.env.FRIBOI_CARTEIRA_DIR = carteira;
  process.env.FRIBOI_CREDITO_JSON = path.join(carteira, 'media_compras.json');

  const { router: emissor } = await import('../server/emissor.js');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/emissor', emissor);

  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const porta = (servidor.address() as { port: number }).port;
  const url = `http://127.0.0.1:${porta}`;

  return {
    dir,
    db,
    pdfs,
    clones,
    carteira,
    url,
    get: (rota) => fetch(`${url}${rota}`),
    post: (rota, corpo) =>
      fetch(`${url}${rota}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      }),
    postArquivos: (rota, campos) => {
      const form = new FormData();
      for (const [nome, arquivo] of Object.entries(campos)) form.append(nome, arquivo);
      return fetch(`${url}${rota}`, { method: 'POST', body: form });
    },
    fechar: async () => {
      await new Promise((ok) => servidor.close(ok));
      const banco = await import('../server/emissorBanco.js' as string);
      banco.fechar();
    },
  };
}
