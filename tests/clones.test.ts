import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const payload = (numero: string, cliente: string) => ({
  numero,
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: '',
  data_pedido: '27/11/2026',
  data_embarque: '27/11/2026',
  data_entrega: '01/12/2026',
  entregas: [
    {
      cliente,
      destino: 'SEM DESTINO',
      operacao: 3,
      produtos: [
        { codigo: '1000', descricao: 'PATINHO', qtd: 10, unidade: 'CX', peso: 15.5, preco: 19.5, prazo: '30' },
      ],
    },
  ],
});

test('clone do banco tem prioridade', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare('INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)')
    .run('9001', '2026-11-27T10:00:00', JSON.stringify(payload('9001', 'Cliente Banco')));
  db.close();

  const resposta = await api.get('/api/emissor/clones/9001?tipo=CXS');
  const corpo = await resposta.json();
  assert.equal(corpo.encontrado, true);
  assert.equal(corpo.fonte, 'banco');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Banco');
});

test('clone em JSON na rede é usado quando o banco não tem', async () => {
  fs.writeFileSync(path.join(api.clones, '9002.json'), JSON.stringify(payload('9002', 'Cliente Rede')));
  const resposta = await api.get('/api/emissor/clones/9002?tipo=CXS');
  const corpo = await resposta.json();
  assert.equal(corpo.fonte, 'rede');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Rede');
});

test('informa o outro tipo quando o histórico só tem PÇS', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare(
    `INSERT OR REPLACE INTO emissor_pedidos_semana
       (numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('9003', 'PÇS', 'MRB', '2026-11-27', '2026-12-01', '2026-11-27', '[]');
  db.close();

  const corpo = await (await api.get('/api/emissor/clones/9003?tipo=CXS')).json();
  assert.deepEqual(corpo, { encontrado: false, outroTipo: 'PÇS' });
});

test('número inexistente devolve encontrado:false', async () => {
  const corpo = await (await api.get('/api/emissor/clones/999999?tipo=CXS')).json();
  assert.deepEqual(corpo, { encontrado: false });
});

test('banco vence a rede quando o número existe nos dois', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare('INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)')
    .run('9004', '2026-11-27T10:00:00', JSON.stringify(payload('9004', 'Cliente Banco')));
  db.close();
  fs.writeFileSync(path.join(api.clones, '9004.json'), JSON.stringify(payload('9004', 'Cliente Rede')));

  const corpo = await (await api.get('/api/emissor/clones/9004?tipo=CXS')).json();
  assert.equal(corpo.fonte, 'banco');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Banco');
});

test('payload corrompido no banco cai para a rede', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare('INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)')
    .run('9005', '2026-11-27T10:00:00', '{"numero": "9005", "entregas": [');
  db.close();
  fs.writeFileSync(path.join(api.clones, '9005.json'), JSON.stringify(payload('9005', 'Cliente Rede')));

  const resposta = await api.get('/api/emissor/clones/9005?tipo=CXS');
  const corpo = await resposta.json();
  assert.equal(resposta.status, 200);
  assert.equal(corpo.fonte, 'rede');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Rede');
});

test('número com separador de caminho é recusado com 400 JSON', async () => {
  for (const numero of ['1%2F2', '..%2F']) {
    const resposta = await api.get(`/api/emissor/clones/${numero}?tipo=CXS`);
    assert.equal(resposta.status, 400, numero);
    assert.match(resposta.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await resposta.json(), { error: 'número de pedido inválido' });
  }
});

// último teste do arquivo: altera o schema da cópia temporária do banco
test('erro inesperado responde JSON genérico, sem caminho absoluto', async () => {
  const db = new DatabaseSync(api.db);
  db.exec('ALTER TABLE emissor_pedidos_clonagem RENAME COLUMN payload TO payload_renomeado');
  db.close();

  const resposta = await api.get('/api/emissor/clones/9006?tipo=CXS');
  assert.equal(resposta.status, 500);
  assert.match(resposta.headers.get('content-type') ?? '', /application\/json/);
  const texto = await resposta.text();
  assert.ok(!texto.includes('C:/'), `resposta vazou caminho absoluto: ${texto}`);
  assert.ok(!texto.includes('C:\\'), `resposta vazou caminho absoluto: ${texto}`);
  assert.deepEqual(JSON.parse(texto), { error: 'não consegui ler o clone do pedido' });
});
