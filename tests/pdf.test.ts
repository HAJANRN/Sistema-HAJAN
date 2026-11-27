import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFParse } from 'pdf-parse';
import { gerarPdf } from '../server/emissorPdf.js';

const pedido = {
  numero: '3834',
  sigla: 'MRB',
  categorias: 'CXS-PÇS',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: 'Entregar pela manhã.',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  pesoTotal: 155,
  veiculo: 'Bi-truck',
  nfsRemessa: 1,
  entregas: [
    {
      cliente: 'Cliente A',
      operacao: 3,
      destino: 'SEM DESTINO',
      peso: 155,
      pesoManual: null,
      prazo: '30',
      produtos: [
        { descricao: 'PATINHO', qtd: 10, unidade: 'CX', preco: 19.5, prazo: '30' },
      ],
    },
  ],
};

test('gera um PDF com número e categorias', async () => {
  const buffer = await gerarPdf(pedido, {
    clientes: new Map([['Cliente A', { cnpj: '00.000.000/0001-00', cidade: 'Natal', uf: 'RN' }]]),
  });
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  const leitor = new PDFParse({ data: buffer });
  const { text } = await leitor.getText();
  await leitor.destroy();
  assert.ok(text.includes('3834'), 'falta o número');
  assert.ok(text.includes('CXS-PÇS'), 'faltam as categorias');
  assert.ok(text.includes('Bi-truck'), 'falta o veículo');
});
