import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('base traz clientes com limite e produtos com rótulo', async () => {
  const resposta = await api.get('/api/emissor/base');
  assert.equal(resposta.status, 200);
  const base = await resposta.json();

  assert.ok(base.clientes.length > 0);
  const cliente = base.clientes[0];
  for (const campo of ['codigo', 'nome', 'cnpj', 'cidade', 'uf', 'prazo', 'limite', 'disponivel']) {
    assert.ok(campo in cliente, `cliente sem ${campo}`);
  }

  assert.ok(base.produtos.length > 0);
  const produto = base.produtos[0];
  assert.equal(produto.rotulo, `${produto.codigo} - ${produto.descricao}`);
  assert.ok(produto.peso > 0);
  assert.equal(produto.unidade.length > 0, true);

  assert.ok(base.unidades.length > 0);
  assert.equal(base.unidades[0].rotulo, `${base.unidades[0].sigla} - ${base.unidades[0].nome}`);
  assert.match(base.revision, /^\d+(\.\d+)?$/);
  assert.match(base.proximoNumero, /^\d+$/);
  assert.equal(base.destinos[0], 'SEM DESTINO');
  assert.ok(base.destinos.includes(base.clientes[0].nome));
  // como o `set` do legado: destino repetido (cliente homônimo, "SEM DESTINO" na base) não duplica
  assert.equal(new Set(base.destinos).size, base.destinos.length);
  assert.equal(base.destinos.filter((destino: string) => destino === 'SEM DESTINO').length, 1);
});
