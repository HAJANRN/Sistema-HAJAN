import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

const CABECALHO_CLIENTES = [
  'CÓDIGO',
  'RAZÃO SOCIAL PEDIDO + CÓDIGO',
  'CNPJ',
  'PRAZO',
  'CIDADE',
  'UF',
  'OBS CLIENTES PED+',
  'CÓDIGO CENTRALIZADOR',
  'Status do Cliente',
];

const linhaCliente = (codigo: string, nome: string, prazo = '28') => [
  codigo,
  nome,
  '11.111.111/0001-11',
  prazo,
  'Natal',
  'RN',
  '',
  codigo,
  'Liberado',
];

const clientes = () =>
  arquivo(
    'clientes.xlsx',
    livro('Infos Clientes', [
      CABECALHO_CLIENTES,
      linhaCliente('501', 'CLIENTE IMPORTADO 501', '28'),
      linhaCliente('501', 'CLIENTE IMPORTADO 501', '35'),
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
  // campo aditivo: nenhuma linha descartada por falta de código/nome/descrição/sigla
  assert.deepEqual(corpo.ignoradas, { clientes: 0, produtos: 0, limites: 0, unidades: 0 });
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

test('falha no meio da transação desfaz o que já foi apagado', async () => {
  const antes = new DatabaseSync(api.db, { readOnly: true });
  const codigosAntes = antes
    .prepare('SELECT codigo FROM emissor_clientes ORDER BY codigo')
    .all()
    .map((linha: any) => linha.codigo);
  antes.close();
  assert.ok(codigosAntes.length > 0, 'a base precisa ter clientes antes deste teste');

  // quebra a SEGUNDA tabela da transação: clientes é apagada e recarregada antes de produtos falhar
  const escritor = new DatabaseSync(api.db);
  escritor.exec(
    'ALTER TABLE emissor_produtos RENAME COLUMN produto_pedido TO produto_pedido_desvio',
  );
  try {
    const resposta = await api.postArquivos('/api/emissor/importar', {
      clientes: arquivo(
        'clientes.xlsx',
        livro('Infos Clientes', [CABECALHO_CLIENTES, linhaCliente('999', 'CLIENTE NOVO 999')]),
      ),
      produtos: produtos(),
    });
    assert.equal(resposta.status, 500);
    const corpo = await resposta.json();
    assert.ok(
      !String(corpo.error).includes(api.dir),
      'o 500 não pode devolver o caminho absoluto do backup',
    );
  } finally {
    escritor.exec(
      'ALTER TABLE emissor_produtos RENAME COLUMN produto_pedido_desvio TO produto_pedido',
    );
    escritor.close();
  }

  const depois = new DatabaseSync(api.db, { readOnly: true });
  const codigosDepois = depois
    .prepare('SELECT codigo FROM emissor_clientes ORDER BY codigo')
    .all()
    .map((linha: any) => linha.codigo);
  depois.close();

  assert.deepEqual(codigosDepois, codigosAntes, 'o ROLLBACK devolve os clientes antigos');
  assert.ok(!codigosDepois.includes('999'), 'a linha nova da planilha não pode ficar');
});

test('retenção mantém só os 10 backups mais recentes', async () => {
  fs.rmSync(api.backups, { recursive: true, force: true });
  fs.mkdirSync(api.backups, { recursive: true });
  const antigos = Array.from(
    { length: 12 },
    (_, indice) => `hajan-2020-01-01T00-00-${String(indice + 1).padStart(2, '0')}-000Z-000000.db`,
  );
  for (const nome of antigos) fs.writeFileSync(path.join(api.backups, nome), 'backup antigo');

  const resposta = await api.postArquivos('/api/emissor/importar', { unidades: unidades() });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  // "mantém os 10 mais recentes" conta o backup novo: 9 antigos sobrevivem, os 3 mais velhos saem
  const restantes = fs.readdirSync(api.backups).sort();
  assert.equal(restantes.length, 10, 'no total são 10 snapshots, o novo incluído');
  assert.ok(fs.existsSync(corpo.backup), 'o backup novo precisa existir');
  assert.ok(restantes.includes(path.basename(corpo.backup)), 'o backup novo fica no diretório');
  assert.ok(!restantes.includes(antigos[0]), 'o backup mais antigo sai');
  assert.ok(!restantes.includes(antigos[1]), 'o segundo mais antigo sai');
  assert.ok(!restantes.includes(antigos[2]), 'o terceiro mais antigo sai');
  assert.ok(restantes.includes(antigos[11]), 'o mais recente dos antigos fica');
  assert.deepEqual(restantes, [...antigos.slice(3), path.basename(corpo.backup)].sort());
});

test('linhas sem código/nome/descrição/sigla voltam em ignoradas', async () => {
  const resposta = await api.postArquivos('/api/emissor/importar', {
    unidades: arquivo(
      'unidades.xlsx',
      livro('SiglasUnidades', [
        ['SIGLA', 'NOME', 'CRITICA'],
        ['zzz', 'UNIDADE IMPORTADA', 'não'],
        ['', 'SEM SIGLA', 'não'],
        ['yyy', '', 'não'],
      ]),
    ),
  });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.deepEqual(corpo.contagens, { clientes: 0, produtos: 0, limites: 0, unidades: 1 });
  assert.deepEqual(corpo.ignoradas, { clientes: 0, produtos: 0, limites: 0, unidades: 2 });
});
