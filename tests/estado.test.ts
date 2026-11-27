import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoriasDoPedido } from '../src/emissor/calculo.ts';
import {
  aplicarClone,
  estadoInicial,
  paraPayloadApi,
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

const isoHoje = () => {
  const d = new Date();
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
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

test('aplicar clone: data válida com hífen, inválida e vazia', () => {
  const hoje = isoHoje();
  const estado = aplicarClone(
    estadoInicial(base),
    { ...clone, data_pedido: '20-11-2026', data_embarque: '31/02/2026', data_entrega: '' },
    base,
  );
  assert.equal(estado.dados.dataEmissao, '2026-11-20');
  assert.equal(estado.dados.dataEmbarque, hoje);
  assert.equal(estado.dados.dataEntrega, hoje);
});

test('aplicar clone: unidade pela sigla e peso zero preservado', () => {
  const estado = aplicarClone(
    estadoInicial(base),
    {
      ...clone,
      unidade: 'MRB',
      entregas: [
        {
          cliente: 'Cliente A',
          destino: 'SEM DESTINO',
          operacao: 3,
          produtos: [
            { codigo: '1000', descricao: 'PATINHO', qtd: 0, unidade: 'CX', peso: 0, preco: 0, prazo: '' },
          ],
        },
      ],
    },
    base,
  );
  assert.equal(estado.dados.unidade, 'MRB - MATRIZ');
  assert.equal(estado.entregas[0].produtos[0].peso, 0);
  assert.equal(estado.entregas[0].produtos[0].qtd, 0);
});

test('aplicar clone sem entregas mantém as atuais como cópia', () => {
  const inicial = estadoInicial(base);
  const estado = aplicarClone(inicial, { ...clone, entregas: [] }, base);
  assert.deepEqual(estado.entregas, inicial.entregas);
  assert.notEqual(estado.entregas, inicial.entregas);
  assert.notEqual(estado.entregas[0], inicial.entregas[0]);
});

test('campoProduto converte texto em número', () => {
  const inicial = estadoInicial(base);
  const estado = reduzir(inicial, {
    tipo: 'campoProduto',
    entregaId: inicial.entregas[0].id,
    produtoId: inicial.entregas[0].produtos[0].id,
    campo: 'qtd',
    valor: '12,5',
  });
  assert.equal(estado.entregas[0].produtos[0].qtd, 12.5);
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

test('payload envia a categoria escolhida e omite a herdada', () => {
  const inicial = estadoInicial(base);
  // Produto do catálogo nasce em "Auto": sem categoria no corpo, o servidor herda a do catálogo.
  const herdada = paraPayloadApi(pedidoDe(inicial));
  assert.equal('categoria' in herdada.entregas[0].produtos[0], false);

  const escolhida = reduzir(inicial, {
    tipo: 'campoProduto',
    entregaId: inicial.entregas[0].id,
    produtoId: inicial.entregas[0].produtos[0].id,
    campo: 'categoria',
    valor: 'CHQ',
  });
  const payload = paraPayloadApi(pedidoDe(escolhida));
  assert.equal(payload.entregas[0].produtos[0].categoria, 'CHQ');
});

test('aplicar clone preserva a categoria herdada do catálogo', () => {
  const estado = aplicarClone(estadoInicial(base), clone, base);
  assert.equal(estado.entregas[0].produtos[0].categoria, '');
  // A linha herdada continua contando a categoria do catálogo no resumo.
  assert.deepEqual(categoriasDoPedido(pedidoDe(estado), base), ['CXS']);
});
