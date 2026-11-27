import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const corpo = (over: Record<string, unknown> = {}) => ({
  numero: '7001',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: 'Teste',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  entregas: [
    {
      cliente: 'Cliente A',
      operacao: 3,
      destino: 'SEM DESTINO',
      pesoManual: null,
      produtos: [
        { codigo: 'TST1', descricao: 'PATINHO', qtd: 10, unidade: 'CX', peso: 15.5, preco: 19.5, prazo: '30' },
        { codigo: 'TST2', descricao: 'COXAO', qtd: 2, unidade: 'CX', peso: 10, preco: 20, prazo: '30' },
      ],
    },
  ],
  ...over,
});

test('gera PDF, grava histórico e clone, e serve o download', async () => {
  const resposta = await api.post('/api/emissor/pedidos', corpo());
  assert.equal(resposta.status, 200);
  const resultado = await resposta.json();
  assert.equal(resultado.ok, true);
  assert.equal(resultado.pedido.pesoTotal, 175);
  assert.equal(resultado.pedido.nfsRemessa, 1);
  assert.equal(resultado.pedido.registradoNoHistorico, true);
  assert.match(resultado.arquivo, /^Pedido Hajan .* nº 7001 \(Embarque MRB 27\.11\.26\)\.pdf$/);

  const pdf = path.join(api.pdfs, resultado.arquivo);
  assert.ok(fs.existsSync(pdf), 'PDF não foi gravado na pasta configurada');
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');

  const db = new DatabaseSync(api.db, { readOnly: true });
  const historico = db
    .prepare('SELECT categoria, sigla, linhas FROM emissor_pedidos_semana WHERE numero = ? ORDER BY categoria')
    .all('7001');
  const clone = db.prepare('SELECT payload FROM emissor_pedidos_clonagem WHERE numero = ?').get('7001');
  db.close();
  assert.ok(historico.length >= 1);
  assert.equal(historico[0].sigla, 'MRB');
  assert.equal(JSON.parse(historico[0].linhas)[0].destino, 'SEM DESTINO');
  assert.equal(JSON.parse(clone!.payload as string).entregas[0].cliente, 'Cliente A');

  assert.ok(fs.existsSync(path.join(api.clones, '7001.json')), 'clone JSON não foi gravado');

  const download = await api.get(resultado.download);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /application\/pdf/);
});

test('ESC usa peso manual e não tem produtos', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({
      numero: '7002',
      entregas: [
        { cliente: 'ESC - NATAL', operacao: 9, destino: 'ESC - NATAL', pesoManual: 800, produtos: [] },
      ],
    }),
  );
  assert.equal(resposta.status, 200);
  const resultado = await resposta.json();
  assert.equal(resultado.pedido.pesoTotal, 800);
  assert.equal(resultado.pedido.nfsRemessa, 0);

  const db = new DatabaseSync(api.db, { readOnly: true });
  const pcs = db
    .prepare("SELECT linhas FROM emissor_pedidos_semana WHERE numero = '7002' AND categoria = 'PÇS'")
    .get();
  const cxs = db
    .prepare("SELECT linhas FROM emissor_pedidos_semana WHERE numero = '7002' AND categoria = 'CXS'")
    .get();
  db.close();
  assert.equal(JSON.parse(pcs.linhas)[0].destino, 'ESC - NATAL');
  assert.equal(cxs, undefined);
});

test('pedido sem cliente é recusado sem gravar nada', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({ numero: '7003', entregas: [{ cliente: '', operacao: 3, destino: '', produtos: [] }] }),
  );
  assert.equal(resposta.status, 400);
  const db = new DatabaseSync(api.db, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emissor_pedidos_semana WHERE numero = ?').get('7003').c, 0);
  db.close();
});

test('sem PÇS nem CXS grava PDF mas não grava histórico', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({
      numero: '7004',
      entregas: [
        {
          cliente: 'Cliente A',
          operacao: 3,
          destino: 'SEM DESTINO',
          pesoManual: null,
          produtos: [{ codigo: 'X1', descricao: 'ITEM', qtd: 1, unidade: 'KG', peso: 5, preco: 1, prazo: '30', categoria: 'SPG' }],
        },
      ],
    }),
  );
  const resultado = await resposta.json();
  assert.equal(resultado.ok, true);
  assert.equal(resultado.pedido.registradoNoHistorico, false);
  assert.ok(resultado.avisos.length > 0);
});

test('nome de PDF fora do padrão é recusado no download', async () => {
  const resposta = await api.get('/api/emissor/pedidos/pdf/..%5Csenha-admin.txt');
  assert.equal(resposta.status, 400);
});
