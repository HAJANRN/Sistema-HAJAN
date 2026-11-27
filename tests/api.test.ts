import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('o harness responde /api/emissor/saude com o banco copiado', async () => {
  const resposta = await api.get('/api/emissor/saude');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.ok, true);
  assert.ok(corpo.clientes > 0);
});
