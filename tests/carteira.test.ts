import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import XLSX from 'xlsx';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('sem arquivos, a carteira fica indisponível', async () => {
  const resposta = await api.get('/api/emissor/carteira');
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { disponivel: false });
});

test('lê o arquivo mais recente e consolida o maior valor por cliente', async () => {
  const linhas = [
    ['Codigo', 'Nome', 'Limite', 'Saldo Financeiro', 'Saldo Carteira', 'Saldo de Credito', 'Status'],
    ['100', 'Cliente A', 50000, 1000, 2000, 47000, 'Liberado'],
    ['100', 'Cliente A', 60000, 9000, 2000, 50000, 'Liberado'],
    ['200', 'Cliente B', 10000, 0, 0, -50, 'Protesto'],
  ];
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), 'Carteira');
  XLSX.writeFile(livro, path.join(api.carteira, 'CARTEIRA DE TERCEIRO 26.11.2026.xlsx'));

  fs.writeFileSync(
    path.join(api.carteira, 'media_compras.json'),
    JSON.stringify({
      clientes: [{ media_mensal_compras_6m: 52000, status_compra: 'OK', codigos: [100] }],
    }),
  );

  const resposta = await api.get('/api/emissor/carteira');
  const corpo = await resposta.json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.data, '26/11/2026');
  assert.equal(corpo.registros['100'].limite, 60000);
  assert.equal(corpo.registros['100'].saldoCredito, 50000);
  assert.equal(corpo.registros['200'].status, 'Protesto');
  assert.equal(corpo.media['100'].mediaMensal6m, 52000);
  assert.equal(corpo.media['100'].mediaSemana, 12000);
  assert.equal(corpo.media['100'].statusCompra, 'OK');
});

test('lê o grupo de arquivos com a data mais recente no nome, inclusive mês por extenso', async () => {
  const escrever = (arquivo: string, limite: number) => {
    const linhas = [
      ['Codigo', 'Nome', 'Limite', 'Saldo Financeiro', 'Saldo em Carteira', 'Saldo de Credito', 'Status do Cliente'],
      ['300', 'Cliente Antigo', limite, 0, 0, limite, 'Liberado'],
    ];
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), 'Carteira');
    XLSX.writeFile(livro, path.join(api.carteira, arquivo));
  };
  escrever('CARTEIRA DE TERCEIRO - DIVISÃO 1 27nov2026.xlsx', 100000);
  escrever('CARTEIRA DE TERCEIRO - DIVISÃO 47 15dez2026.xlsx', 1000);

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.data, '15/12/2026');
  assert.equal(corpo.registros['300'].limite, 1000);
});
