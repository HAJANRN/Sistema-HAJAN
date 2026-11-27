import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoriasDoPedido,
  ehEsc,
  nfsRemessa,
  pesoEntrega,
  pesoTotal,
  resumoPedido,
  valorEntrega,
  valorTotal,
  veiculoDoPeso,
} from '../src/emissor/calculo.ts';
import type { EntregaForm, PedidoForm } from '../src/emissor/tipos.ts';

const produto = (over: Partial<EntregaForm['produtos'][number]> = {}) => ({
  id: 'p1',
  codigo: '1000',
  descricao: 'PATINHO',
  qtd: 10,
  unidade: 'CX',
  peso: 15.5,
  preco: 19.5,
  prazo: '30',
  categoria: 'CXS',
  ...over,
});

const entrega = (over: Partial<EntregaForm> = {}): EntregaForm => ({
  id: 'e1',
  cliente: 'Cliente A',
  operacao: 3,
  destino: 'SEM DESTINO',
  pesoManual: null,
  produtos: [produto()],
  ...over,
});

const pedido = (entregas: EntregaForm[]): PedidoForm => ({
  numero: '3834',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: '',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  entregas,
});

test('ESC quando cliente ou destino começa com ESC', () => {
  assert.equal(ehEsc('ESC - NATAL'), true);
  assert.equal(ehEsc('esc 1'), true);
  assert.equal(ehEsc('ESCADA'), false);
  assert.equal(ehEsc('Cliente ESC'), false);
});

test('peso e valor por produto', () => {
  const e = entrega();
  assert.equal(pesoEntrega(e), 155);
  assert.equal(valorEntrega(e), 3022.5);
});

test('ESC usa peso manual e não soma produtos', () => {
  const e = entrega({ cliente: 'ESC - NATAL', pesoManual: 900, produtos: [] });
  assert.equal(pesoEntrega(e), 900);
  assert.equal(valorEntrega(e), 0);
});

test('totais e veículo', () => {
  const p = pedido([entrega(), entrega({ id: 'e2', produtos: [produto({ id: 'p2', qtd: 100 })] })]);
  assert.equal(pesoTotal(p), 1705);
  assert.equal(veiculoDoPeso(17000), 'Bi-truck');
  assert.equal(veiculoDoPeso(17001), 'Carreta');
});

test('categorias na ordem fixa e fallback PÇS', () => {
  const p = pedido([
    entrega({
      produtos: [
        produto({ id: 'a', categoria: 'SPG' }),
        produto({ id: 'b', categoria: 'CXS' }),
        produto({ id: 'c', categoria: '' }),
      ],
    }),
  ]);
  assert.deepEqual(categoriasDoPedido(p), ['CXS', 'SPG']);

  const semCategoria = pedido([entrega({ produtos: [produto({ categoria: 'outro' })] })]);
  assert.deepEqual(categoriasDoPedido(semCategoria), ['PÇS']);
});

test('NFs de remessa são as entregas fora da operação 9', () => {
  assert.equal(nfsRemessa(pedido([entrega(), entrega({ id: 'e2', operacao: 9 })])), 1);
});

test('resumo do pedido', () => {
  const r = resumoPedido(pedido([entrega()]));
  assert.equal(r.categorias, 'CXS');
  assert.equal(r.pesoTotal, 155);
  assert.equal(r.valor, 3022.5);
  assert.equal(r.veiculo, 'Bi-truck');
  assert.equal(r.entregas, 1);
  assert.equal(r.nfsRemessa, 1);
});
