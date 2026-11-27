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
