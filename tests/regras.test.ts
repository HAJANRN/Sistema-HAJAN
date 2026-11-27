import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoriasDoPedido,
  dataBr,
  dataBrCurta,
  linhasHistorico,
  nomeArquivoPdf,
  pesoEntrega,
  resumoPedido,
} from '../server/emissorRegras.js';

const produto = (over = {}) => ({
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

const entrega = (over = {}) => ({
  cliente: 'Cliente A',
  operacao: 3,
  destino: 'SEM DESTINO',
  pesoManual: null,
  produtos: [produto()],
  ...over,
});

test('categorias na ordem fixa', () => {
  const entregas = [
    entrega({ produtos: [produto({ categoria: 'SPG' }), produto({ categoria: 'CXS' })] }),
  ];
  assert.deepEqual(categoriasDoPedido(entregas), ['CXS', 'SPG']);
});

test('peso e resumo', () => {
  const pedido = {
    numero: '3834',
    entregas: [entrega(), entrega({ produtos: [produto({ qtd: 100 })] })],
  };
  assert.equal(pesoEntrega(pedido.entregas[0]), 155);
  const r = resumoPedido(pedido);
  assert.equal(r.pesoTotal, 1705);
  assert.equal(r.veiculo, 'Bi-truck');
  assert.equal(r.entregas, 2);
  assert.equal(r.nfsRemessa, 2);
  assert.equal(r.categorias, 'CXS');
});

test('linhas do histórico usam cidade-UF, limpam ESC (0) e filtram por categoria', () => {
  const clientes = new Map([
    ['Cliente A', { cidade: 'Natal', uf: 'RN' }],
    ['ESC - NATAL (0)', { cidade: 'Natal', uf: 'RN' }],
  ]);
  const entregas = [
    entrega({ cliente: 'Cliente A' }),
    entrega({ cliente: 'ESC - NATAL (0)', destino: 'ESC - NATAL (0)', operacao: 9, produtos: [] }),
  ];

  const cxs = linhasHistorico(entregas, clientes, 'CXS');
  assert.deepEqual(cxs, [
    { indice: 1, destino: 'SEM DESTINO', cliente: 'Cliente A', localizacao: 'Natal-RN' },
  ]);

  const pcs = linhasHistorico(entregas, clientes, 'PÇS');
  assert.equal(pcs.length, 1);
  assert.equal(pcs[0].indice, 2);
  assert.equal(pcs[0].destino, 'ESC - NATAL');
  assert.equal(pcs[0].cliente, 'ESC - NATAL');
  assert.equal(pcs[0].localizacao, 'Natal-RN');
});

test('datas para o PDF', () => {
  assert.equal(dataBr('2026-11-27'), '27/11/2026');
  assert.equal(dataBrCurta('2026-11-27'), '27/11/26');
});

test('nome do PDF segue o padrão e é sanitizado', () => {
  assert.equal(
    nomeArquivoPdf({ numero: '3834', categorias: 'CXS-PÇS', sigla: 'MRB', dataEmbarque: '2026-11-27' }),
    'Pedido Hajan CXS-PÇS nº 3834 (Embarque MRB 27.11.26).pdf',
  );
  assert.equal(
    nomeArquivoPdf({ numero: '38/34', categorias: 'CXS', sigla: 'MRB', dataEmbarque: '2026-11-27' }),
    'Pedido Hajan CXS nº 38_34 (Embarque MRB 27.11.26).pdf',
  );
});
