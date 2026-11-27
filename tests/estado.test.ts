import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aplicarClone,
  estadoInicial,
  pedidoDe,
  reduzir,
  trocarOperacao,
} from '../src/emissor/estado.ts';
import type { BaseEmissor, ClonePayload } from '../src/emissor/tipos.ts';

const base: BaseEmissor = {
  revision: '1',
  proximoNumero: '3834',
  clientes: [
    { codigo: '100', nome: 'Cliente A', cnpj: '', cidade: 'Natal', uf: 'RN', prazo: '30', codigoCentralizador: '', centralizador: '', statusCliente: '', limite: 0, disponivel: 0 },
  ],
  produtos: [
    { codigo: '1000', descricao: 'PATINHO', rotulo: '1000 - PATINHO', unidade: 'CX', peso: 15.5, categoria: 'CXS' },
  ],
  unidades: [{ sigla: 'MRB', nome: 'MATRIZ', rotulo: 'MRB - MATRIZ', critica: 'NÃO' }],
  destinos: ['SEM DESTINO', 'Cliente A'],
};

const clone: ClonePayload = {
  numero: '3500',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'mrb - matriz',
  observacao: 'clonado',
  data_pedido: '20/11/2026',
  data_embarque: '21/11/2026',
  data_entrega: '25/11/2026',
  entregas: [
    {
      cliente: 'Cliente A',
      destino: 'SEM DESTINO',
      operacao: 9,
      produtos: [
        { codigo: '1000', descricao: 'PATINHO', qtd: 5, unidade: 'CX', peso: 15.5, preco: 18, prazo: '' },
      ],
    },
    { cliente: 'ESC - NATAL', destino: 'ESC - NATAL', operacao: 3, peso_manual: 700, produtos: [] },
  ],
};

test('estado inicial vem da base', () => {
  const estado = estadoInicial(base);
  assert.equal(estado.dados.numero, '3834');
  assert.equal(estado.dados.atencao, 'Helcio Venancio');
  assert.equal(estado.dados.local, 'Natal');
  assert.equal(estado.dados.unidade, 'MRB - MATRIZ');
  assert.equal(estado.entregas.length, 1);
  assert.equal(estado.entregas[0].cliente, 'Cliente A');
  assert.equal(estado.entregas[0].operacao, 3);
  assert.equal(estado.entregas[0].produtos[0].prazo, '30');
});

test('trocar para operação 9 esvazia o destino', () => {
  const estado = trocarOperacao(estadoInicial(base), estadoInicial(base).entregas[0].id, 9);
  assert.equal(estado.entregas[0].destino, '');
});

test('aplicar clone: datas, unidade canônica e prazo semeado', () => {
  const estado = aplicarClone(estadoInicial(base), clone, base);
  assert.equal(estado.dados.numero, '3500');
  assert.equal(estado.dados.unidade, 'MRB - MATRIZ');
  assert.equal(estado.dados.dataEmbarque, '2026-11-21');
  assert.equal(estado.dados.dataEntrega, '2026-11-25');
  assert.equal(estado.entregas.length, 2);
  assert.equal(estado.entregas[0].produtos[0].prazo, '30');
  assert.equal(estado.entregas[1].pesoManual, 700);
  assert.notEqual(estado.entregas[0].id, estado.entregas[1].id);
});

test('duplicar e mover entregas', () => {
  const inicial = estadoInicial(base);
  let estado = reduzir(inicial, { tipo: 'duplicarEntrega', id: inicial.entregas[0].id });
  assert.equal(estado.entregas.length, 2);
  assert.notEqual(estado.entregas[0].id, estado.entregas[1].id);
  estado = reduzir(estado, { tipo: 'moverEntrega', id: estado.entregas[1].id, direcao: -1 });
  assert.equal(estado.entregas[1].id, inicial.entregas[0].id);
});

test('pedidoDe devolve um PedidoForm completo', () => {
  const pedido = pedidoDe(estadoInicial(base));
  assert.equal(pedido.numero, '3834');
  assert.equal(pedido.entregas.length, 1);
  assert.equal(pedido.entregas[0].produtos[0].prazo, '30');
  assert.match(pedido.dataEmbarque, /^\d{4}-\d{2}-\d{2}$/);
});
