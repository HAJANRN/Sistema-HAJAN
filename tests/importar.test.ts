import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import XLSX from 'xlsx';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const livro = (aba: string, linhas: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), aba);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const arquivo = (nome: string, bytes: Buffer) =>
  new File([new Uint8Array(bytes)], nome, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

const clientes = () =>
  arquivo(
    'clientes.xlsx',
    livro('Infos Clientes', [
      [
        'CÓDIGO',
        'RAZÃO SOCIAL PEDIDO + CÓDIGO',
        'CNPJ',
        'PRAZO',
        'CIDADE',
        'UF',
        'OBS CLIENTES PED+',
        'CÓDIGO CENTRALIZADOR',
        'Status do Cliente',
      ],
      ['501', 'CLIENTE IMPORTADO 501', '11.111.111/0001-11', '28', 'Natal', 'RN', '', '501', 'Liberado'],
      ['501', 'CLIENTE IMPORTADO 501', '11.111.111/0001-11', '35', 'Natal', 'RN', '', '501', 'Liberado'],
    ]),
  );

const produtos = () =>
  arquivo(
    'produtos.xlsx',
    livro('Infos Produtos', [
      [
        'Código',
        'Produto Frigorífico',
        'Produto Pedido',
        'Unidade',
        'Peso',
        'Produto Frigorífico (Completo)',
        'Estado Físico (Grupo)',
        'F/S/A',
        'Linha (Marca)',
        'Categoria (Divisão)',
      ],
      ['TSTP1', 'PATINHO IMPORTADO', 'PATINHO', 'CX', '15,5', 'PATINHO COMPLETO', 'RESFRIADO', 'A', 'HAJAN', 'CXS'],
    ]),
  );

const limites = () =>
  arquivo(
    'limites.xlsx',
    livro('Limites', [
      ['Centralizador', 'Nome', 'Limite', 'Disponível'],
      ['501', 'CLIENTE IMPORTADO 501', 90000, 85000],
    ]),
  );

const unidades = () =>
  arquivo(
    'unidades.xlsx',
    livro('SiglasUnidades', [
      ['SIGLA', 'NOME', 'CRITICA'],
      ['zzz', 'UNIDADE IMPORTADA', 'não'],
    ]),
  );

test('importa as quatro planilhas e faz backup', async () => {
  const resposta = await api.postArquivos('/api/emissor/importar', {
    clientes: clientes(),
    produtos: produtos(),
    limites: limites(),
    unidades: unidades(),
  });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.deepEqual(corpo.contagens, { clientes: 1, produtos: 1, limites: 1, unidades: 1 });
  assert.ok(fs.existsSync(corpo.backup), 'backup não foi criado');

  const db = new DatabaseSync(api.db, { readOnly: true });
  const cliente = db.prepare('SELECT * FROM emissor_clientes WHERE codigo = ?').get('501') as any;
  const produto = db.prepare('SELECT * FROM emissor_produtos WHERE codigo = ?').get('TSTP1') as any;
  const unidade = db.prepare('SELECT * FROM emissor_unidades_carregamento WHERE sigla = ?').get('ZZZ') as any;
  const total = db.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c;
  db.close();

  assert.equal(cliente.prazo_padrao, '35', 'dedupe deve manter a última linha');
  assert.equal(produto.peso, 15.5);
  assert.equal(unidade.nome, 'UNIDADE IMPORTADA');
  assert.equal(unidade.critica, 'NÃO');
  assert.equal(total, 1, 'importação substitui a base de clientes');
});

test('cabeçalho errado rejeita sem alterar a base', async () => {
  const antes = new DatabaseSync(api.db, { readOnly: true });
  const totalAntes = antes.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c;
  antes.close();

  const ruim = arquivo('clientes.xlsx', livro('Infos Clientes', [['CODIGO'], ['999']]));
  const resposta = await api.postArquivos('/api/emissor/importar', { clientes: ruim });
  assert.equal(resposta.status, 400);
  const corpo = await resposta.json();
  assert.match(corpo.error, /clientes/);

  const depois = new DatabaseSync(api.db, { readOnly: true });
  assert.equal(depois.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c, totalAntes);
  depois.close();
});

test('arquivo que não é xlsx é recusado', async () => {
  const resposta = await api.postArquivos('/api/emissor/importar', {
    clientes: new File([new TextEncoder().encode('nada')], 'clientes.xlsx'),
  });
  assert.equal(resposta.status, 400);
});
