import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { copiarBanco, montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('o harness responde /api/emissor/saude com o banco copiado', async () => {
  const resposta = await api.get('/api/emissor/saude');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.ok, true);
  assert.ok(corpo.clientes > 0);
  // Prova que o harness isolou o banco: a rota enxerga a cópia temporária.
  assert.equal(corpo.banco, api.db);
});

test('conexões do emissor: banco copiado, WAL e read-only', async () => {
  // A config já foi lida no import acima (montarApi definiu FRIBOI_DB antes),
  // então o import dinâmico aqui reaproveita o mesmo DB_FILE temporário.
  const banco = await import('../server/emissorBanco.js' as string);

  // `gravar()` liga WAL e o timeout de lock na conexão de escrita.
  const escrita = banco.gravar();
  assert.equal(escrita.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(escrita.prepare('PRAGMA busy_timeout').get().timeout, 5000);

  // `ler()` é somente-leitura: qualquer escrita precisa ser recusada pelo SQLite.
  const leitura = banco.ler();
  assert.throws(
    () => leitura.exec('CREATE TABLE nao_deve_existir (id INTEGER)'),
    /readonly/i,
  );

  // Erros de banco ausente/migrado viram 503; o resto é relançado.
  const res = {
    status(code: number) {
      this.status = code;
      return this;
    },
    json(payload: unknown) {
      this.corpo = payload;
      return this;
    },
  };
  banco.responderSemBanco(res, new Error('no such table: x'));
  assert.equal(res.status, 503);
  assert.match(res.corpo.error, /indispon/i);
  assert.throws(() => banco.responderSemBanco(res, new Error('SQLITE_BUSY')), /SQLITE_BUSY/);
});

test('copiarBanco leva junto o que só está no -wal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajan-wal-'));
  const origem = path.join(dir, 'origem.db');
  // O escritor fica aberto até o fim: a transação não é checkpointada no `.db`.
  const escritor = new DatabaseSync(origem);
  try {
    escritor.exec('PRAGMA journal_mode = WAL');
    escritor.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, nome TEXT)');
    escritor.prepare('INSERT INTO t (nome) VALUES (?)').run('só no wal');

    // Cópia simples do `.db` não vê a linha (era exatamente o bug do harness).
    const simples = path.join(dir, 'copia-simples.db');
    fs.copyFileSync(origem, simples);
    const cru = new DatabaseSync(simples, { readOnly: true });
    try {
      assert.throws(() => cru.prepare('SELECT COUNT(*) c FROM t').get(), /no such table/);
    } finally {
      cru.close();
    }

    // `copiarBanco` (VACUUM INTO) tira um snapshot consistente, com o WAL aplicado.
    const destino = path.join(dir, 'copia.db');
    copiarBanco(origem, destino);
    const copia = new DatabaseSync(destino, { readOnly: true });
    try {
      assert.deepEqual({ ...copia.prepare('SELECT nome FROM t').get() }, { nome: 'só no wal' });
    } finally {
      copia.close();
    }
  } finally {
    escritor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
