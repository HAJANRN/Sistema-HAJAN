import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import XLSX from 'xlsx';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

// Import dinâmico, depois do `montarApi()`: `config.js` congela `CARTEIRA_DIR` no import.
const { limparCache } = await import('../server/emissorCarteira.js');

/**
 * A carteira memoriza assinatura e resultado por 60 s; sem o reset, um teste herda a
 * resposta do anterior e a suíte fica dependente da ordem (era a falha intermitente).
 */
beforeEach(() => limparCache());

const COLUNAS = [
  'Codigo',
  'Nome',
  'Limite',
  'Saldo Financeiro',
  'Saldo em Carteira',
  'Saldo de Credito',
  'Status do Cliente',
];

function escreverPlanilha(arquivo: string, linhas: (string | number)[][]): string {
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), 'Carteira');
  const caminho = path.join(api.carteira, arquivo);
  XLSX.writeFile(livro, caminho);
  return caminho;
}

/** Grava um `.xlsx` truncado (zip inválido): o SheetJS estoura e o arquivo tem de ser ignorado. */
function escreverCorrompido(arquivo: string): string {
  const bom = escreverPlanilha('modelo.xlsx', [COLUNAS, ['1', 'Modelo', 1, 0, 0, 1, '']]);
  const bytes = fs.readFileSync(bom);
  fs.rmSync(bom);
  const caminho = path.join(api.carteira, arquivo);
  fs.writeFileSync(caminho, bytes.subarray(0, Math.floor(bytes.length / 2)));
  return caminho;
}

test('sem arquivos, a carteira fica indisponível', async () => {
  const resposta = await api.get('/api/emissor/carteira');
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { disponivel: false });
});

test('lê o arquivo mais recente e consolida o maior valor por cliente', async () => {
  escreverPlanilha('CARTEIRA DE TERCEIRO 26.11.2026.xlsx', [
    ['Codigo', 'Nome', 'Limite', 'Saldo Financeiro', 'Saldo Carteira', 'Saldo de Credito', 'Status'],
    ['100', 'Cliente A', 50000, 1000, 2000, 47000, 'Liberado'],
    ['100', 'Cliente A', 60000, 9000, 2000, 50000, 'Liberado'],
    ['200', 'Cliente B', 10000, 0, 0, -50, 'Protesto'],
  ]);

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
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 27nov2026.xlsx', [
    COLUNAS,
    ['300', 'Cliente Antigo', 100000, 0, 0, 100000, 'Liberado'],
  ]);
  const maisNovo = escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 47 15dez2026.xlsx', [
    COLUNAS,
    ['300', 'Cliente Novo', 1000, 0, 0, 1000, 'Liberado'],
  ]);

  // O arquivo de nome mais novo recebe o mtime mais antigo: uma regressão para "mtime mais
  // recente" escolheria o de 27/11 e o teste falharia.
  const bemAntigo = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(maisNovo, bemAntigo, bemAntigo);

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.data, '15/12/2026');
  assert.equal(corpo.registros['300'].limite, 1000);
  assert.equal(corpo.registros['300'].nome, 'Cliente Novo');
});

test('arquivo corrompido no grupo é ignorado e os demais são lidos', async () => {
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 16dez2026.xlsx', [
    COLUNAS,
    ['400', 'Cliente Bom', 7000, 0, 0, 7000, 'Liberado'],
  ]);
  escreverCorrompido('CARTEIRA DE TERCEIRO - DIVISÃO 2 16dez2026.xlsx');

  const resposta = await api.get('/api/emissor/carteira');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.data, '16/12/2026');
  assert.equal(corpo.registros['400'].limite, 7000);
});

test('planilha sem coluna de limite não registra limite zero', async () => {
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 17dez2026.xlsx', [
    ['Codigo', 'Nome', 'Saldo de Credito'],
    ['500', 'Cliente Sem Limite', 3000],
  ]);

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.registros['500'].saldoCredito, 3000);
  assert.equal('limite' in corpo.registros['500'], false);
});

test('grupo sem nenhum arquivo legível devolve data vazia', async () => {
  escreverCorrompido('CARTEIRA DE TERCEIRO - DIVISÃO 1 18dez2026.xlsx');

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.data, '');
  assert.deepEqual(corpo.registros, {});
});

test('planilha sem nenhuma coluna reconhecida é ignorada', async () => {
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 19dez2026.xlsx', [
    ['Codigo', 'Nome', 'Observacao'],
    ['600', 'Cliente Sem Saldo', 'nada'],
  ]);

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.data, '');
  assert.deepEqual(corpo.registros, {});
});

test('dentro da janela de 60 s o grupo memorizado é reaproveitado; o reset o refaz', async () => {
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 20dez2026.xlsx', [
    COLUNAS,
    ['700', 'Cliente de Hoje', 9000, 0, 0, 9000, 'Liberado'],
  ]);
  const primeiro = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(primeiro.data, '20/12/2026');

  // Arquivo novo no meio da janela: a assinatura está memorizada, então só aparece quando
  // ela é refeita. Nada de carimbo de mtime da pasta, que no Windows não muda de forma confiável.
  escreverPlanilha('CARTEIRA DE TERCEIRO - DIVISÃO 1 21dez2026.xlsx', [
    COLUNAS,
    ['700', 'Cliente de Amanhã', 12000, 0, 0, 12000, 'Liberado'],
  ]);
  const dentroDaJanela = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(dentroDaJanela.data, '20/12/2026');
  assert.equal(dentroDaJanela.registros['700'].limite, 9000);

  limparCache();
  const depoisDoReset = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(depoisDoReset.data, '21/12/2026');
  assert.equal(depoisDoReset.registros['700'].limite, 12000);
});
