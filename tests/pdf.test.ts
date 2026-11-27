import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { PDFParse } from 'pdf-parse';
import { gerarPdf } from '../server/emissorPdf.js';

const CLIENTE = 'MERCADO CENTRAL LTDA';

const produtos = [
  { descricao: 'PATINHO', qtd: 10, unidade: 'CX', preco: 19.5, prazo: '30' },
  { descricao: 'COXAO MOLE', qtd: 5, unidade: 'CX', preco: 42.75, prazo: '45' },
];

type Pedido = Record<string, unknown>;

function pedidoBase(extra: Pedido = {}): Pedido {
  return {
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
        cliente: CLIENTE,
        operacao: 3,
        destino: 'SEM DESTINO',
        peso: 155,
        pesoManual: null,
        prazo: '30',
        produtos,
      },
    ],
    ...extra,
  };
}

const PT = 72 / 25.4; // 1mm em pontos PostScript

function corDe(hex: string) {
  return [1, 3, 5].map((inicio) => parseInt(hex.slice(inicio, inicio + 2), 16) / 255);
}

const AZUL_RGB = corDe('#1F4E79');
const FUNDO_RGB = corDe('#DDEBF7');

const mesmaCor = (a: number[], b: number[]) =>
  a.length === b.length && a.every((valor, indice) => Math.abs(valor - b[indice]) < 0.01);

type Retangulo = {
  tipo: 'retangulo';
  x: number;
  y: number;
  largura: number;
  altura: number;
  cor: number[];
};
type TextoDesenhado = { tipo: 'texto'; cor: number[] };

/**
 * Operadores de desenho do content stream da 1ª página, na ordem em que saem, com a
 * cor de preenchimento (`scn`) em vigor em cada retângulo/texto. Permite conferir a
 * geometria da faixa da operação e se algum texto foi pintado com a cor do próprio
 * fundo (o caso "texto no PDF mas invisível"). pdfkit comprime a página com FlateDecode.
 */
function operacoes(buffer: Buffer) {
  const bruto = buffer.toString('latin1');
  const marcador = /stream\r?\n/g;
  let pagina: string | null = null;
  let achado = marcador.exec(bruto);
  while (achado && pagina === null) {
    const inicio = achado.index + achado[0].length;
    const fim = bruto.indexOf('endstream', inicio);
    if (fim > inicio) {
      try {
        const conteudo = zlib.inflateSync(buffer.subarray(inicio, fim)).toString('latin1');
        if (/(TJ|Tj)$/m.test(conteudo)) pagina = conteudo;
      } catch {
        // fonte/imagem comprimida: não é o conteúdo da página
      }
    }
    achado = marcador.exec(bruto);
  }
  assert.ok(pagina, 'content stream da página 1 não encontrado');

  const lista: Array<Retangulo | TextoDesenhado> = [];
  let cor: number[] | null = null;
  let caminho: { x: number; y: number; largura: number; altura: number } | null = null;

  for (const linha of pagina.split('\n')) {
    const tinta = linha.trim().match(/^([-\d.]+) ([-\d.]+) ([-\d.]+) scn$/);
    if (tinta) {
      cor = [Number(tinta[1]), Number(tinta[2]), Number(tinta[3])];
      continue;
    }
    const area = linha.trim().match(/^([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re$/);
    if (area) {
      caminho = {
        x: Number(area[1]),
        y: Number(area[2]),
        largura: Number(area[3]),
        altura: Number(area[4]),
      };
      continue;
    }
    if (/^(f\*?|S|s|B|b|n)$/.test(linha.trim())) {
      if (linha.trim().startsWith('f') && caminho && cor) {
        lista.push({ tipo: 'retangulo', ...caminho, cor });
      }
      caminho = null;
      continue;
    }
    if (/(TJ|Tj)$/.test(linha.trim()) && cor) lista.push({ tipo: 'texto', cor });
  }
  return lista;
}

async function extrair(buffer: Buffer) {
  const leitor = new PDFParse({ data: buffer });
  const texto = await leitor.getText();
  await leitor.destroy();
  return texto;
}

function conferirRodapes(
  resultado: { total: number; pages: Array<{ text: string }> },
  cabecalho = 'Pedido HAJAN',
) {
  assert.ok(resultado.total > 0, 'PDF sem páginas');
  resultado.pages.forEach((pagina, indice) => {
    const rodape = `Página ${indice + 1}/${resultado.total}`;
    assert.ok(pagina.text.includes(rodape), `página ${indice + 1} sem o rodapé "${rodape}"`);
    assert.ok(pagina.text.includes(cabecalho), `página ${indice + 1} sem o cabeçalho repetido`);
  });
}

test('gera PDF com cliente, produtos, totais do pedido e rodapé numerado', async () => {
  const buffer = await gerarPdf(pedidoBase(), {
    clientes: new Map([[CLIENTE, { cnpj: '00.000.000/0001-00', cidade: 'Natal', uf: 'RN' }]]),
  });
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');

  const { text, total, pages } = await extrair(buffer);

  // cabeçalho e dados gerais
  assert.ok(text.includes('3834'), 'falta o número');
  assert.ok(text.includes('CXS-PÇS'), 'faltam as categorias');
  assert.ok(text.includes('MRB'), 'falta a sigla');
  assert.ok(text.includes('Helcio Venancio'), 'falta a atenção');
  assert.ok(text.includes('Natal, 27/11/2026'), 'falta a praça/data de emissão');
  assert.ok(text.includes('EMBARQUE: 27/11/26 - ENTREGA: 01/12/26'), 'faltam as datas');

  // entrega: cliente, CNPJ/cidade e operação
  assert.ok(text.includes(`Cliente: ${CLIENTE}`), 'falta o cliente');
  assert.ok(text.includes('CNPJ: 00.000.000/0001-00'), 'falta o CNPJ');
  assert.ok(text.includes('Cidade: Natal - RN'), 'falta a cidade/UF');
  assert.ok(text.includes('Operação 3: SEM DESTINO'), 'falta a faixa da operação');

  // pelo menos dois produtos, com quantidade e valor na mesma linha da tabela
  assert.match(text, /PATINHO\s+10\s+CX\s+19\.50\s+30/, 'linha do PATINHO divergente');
  assert.match(text, /COXAO MOLE\s+5\s+CX\s+42\.75\s+45/, 'linha do COXAO MOLE divergente');

  // totais de peso do pedido e da entrega, e o resumo
  assert.ok(text.includes('Peso Total da Entrega: 155 kg'), 'falta o peso da entrega');
  assert.ok(text.includes('Peso Carga (Total - Kg): 155'), 'falta o peso do pedido');
  assert.ok(text.includes('Veículo: Bi-truck'), 'falta o veículo');
  assert.ok(text.includes('Quantidade de Entregas (NFs): 1'), 'faltam as NFs de entrega');
  assert.ok(text.includes('Quantidade NFs de Remessa: 1'), 'faltam as NFs de remessa');
  assert.ok(text.includes('Entregar pela manhã.'), 'falta a observação');

  // uma página, com rodapé "Página 1/1"
  assert.equal(total, 1);
  assert.equal(pages.length, 1);
  assert.ok(text.includes('Página 1/1'), 'falta o rodapé Página 1/1');
  conferirRodapes({ total, pages });
  assert.doesNotMatch(text, /undefined|NaN/, 'campos ausentes viraram undefined/NaN');
});

test('faixa da operação tem 4mm, o cabeçalho fica abaixo dela e o rótulo é visível', async () => {
  const buffer = await gerarPdf(pedidoBase(), {
    clientes: new Map([[CLIENTE, { cnpj: '00.000.000/0001-00', cidade: 'Natal', uf: 'RN' }]]),
  });
  const lista = operacoes(buffer);

  // fundo da faixa: retângulo #DDEBF7 com 4mm de altura
  const faixa = lista.find((op) => op.tipo === 'retangulo' && mesmaCor(op.cor, FUNDO_RGB));
  assert.ok(faixa?.tipo === 'retangulo', 'faixa da operação (#DDEBF7) não foi desenhada');
  assert.ok(
    Math.abs(faixa.altura - 4 * PT) < 0.05,
    `faixa com ${(faixa.altura / PT).toFixed(2)}mm de altura, esperava 4mm`,
  );
  const topoDaFaixa = faixa.y + faixa.altura;

  // cabeçalho da tabela (linha de 160mm com fundo #EDEDED) não invade a faixa
  const cabecalho = lista.find(
    (op) =>
      op.tipo === 'retangulo' &&
      Math.abs(op.largura - 160 * PT) < 0.05 &&
      mesmaCor(op.cor, corDe('#EDEDED')),
  );
  assert.ok(cabecalho?.tipo === 'retangulo', 'cabeçalho da tabela não foi desenhado');
  assert.ok(
    cabecalho.y >= topoDaFaixa - 0.01,
    `cabeçalho da tabela começa ${((topoDaFaixa - cabecalho.y) / PT).toFixed(2)}mm dentro da faixa`,
  );

  // o rótulo "Operação N" precisa sair no azul #1F4E79 sobre o fundo #DDEBF7
  assert.ok(
    lista.some((op) => op.tipo === 'texto' && mesmaCor(op.cor, AZUL_RGB)),
    'rótulo da operação não foi desenhado em #1F4E79',
  );

  // nenhum texto herda a cor do retângulo preenchido imediatamente anterior
  let ultimoPreenchimento: number[] | null = null;
  for (const op of lista) {
    if (op.tipo === 'retangulo') {
      ultimoPreenchimento = op.cor;
      continue;
    }
    if (ultimoPreenchimento) {
      const tinta = op.cor.map((valor) => valor.toFixed(3)).join(',');
      assert.ok(
        !mesmaCor(op.cor, ultimoPreenchimento),
        `texto pintado com a cor do fundo (${tinta}): invisível no PDF`,
      );
    }
  }
});

test('entrega ESC sai com peso manual, sem produtos e como Operação 9', async () => {
  const pedido = pedidoBase({
    numero: '3900',
    pesoTotal: 120,
    nfsRemessa: 0,
    observacao: '',
    entregas: [
      {
        cliente: 'ESC - FRIGORIFICO',
        // string de propósito: a faixa precisa sair de Number(operacao), não de === 9
        operacao: '9',
        destino: '',
        peso: 120,
        pesoManual: 120,
        prazo: '30',
        produtos: [],
      },
    ],
  });

  const buffer = await gerarPdf(pedido);
  const { text, total, pages } = await extrair(buffer);

  assert.ok(text.includes('Cliente: ESC - FRIGORIFICO'), 'falta o cliente ESC');
  assert.ok(text.includes('Operação 9'), 'falta a faixa Operação 9');
  assert.doesNotMatch(text, /Operação 3/, 'ESC não pode sair como Operação 3');
  assert.match(text, /PESO\s+120\s+KG\s+0,00\s+30/, 'linha de peso manual divergente');
  assert.ok(text.includes('Peso Total da Entrega: 120 kg'), 'falta o peso da entrega ESC');
  assert.ok(text.includes('Peso Carga (Total - Kg): 120'), 'falta o peso do pedido');
  assert.ok(text.includes('Quantidade de Entregas (NFs): 1'), 'faltam as NFs de entrega');
  assert.ok(text.includes('Quantidade NFs de Remessa: 0'), 'ESC não gera NF de remessa');
  assert.ok(text.includes('Sem observações.'), 'observação vazia deveria virar "Sem observações."');
  assert.doesNotMatch(text, /undefined|NaN/, 'campos ausentes viraram undefined/NaN');

  assert.equal(total, 1);
  conferirRodapes({ total, pages });
});

test('entrega com 60 produtos quebra página, mantém todos os itens e o total', async () => {
  const muitos = Array.from({ length: 60 }, (_, indice) => ({
    descricao: `PRODUTO ${String(indice + 1).padStart(2, '0')}`,
    qtd: indice + 1,
    unidade: 'CX',
    preco: 10 + indice,
    prazo: '30',
  }));
  const pedido = pedidoBase({
    numero: '4000',
    pesoTotal: 900,
    entregas: [
      {
        cliente: CLIENTE,
        operacao: 3,
        destino: 'SEM DESTINO',
        peso: 900,
        pesoManual: null,
        prazo: '30',
        produtos: muitos,
      },
    ],
  });

  const buffer = await gerarPdf(pedido);
  const { text, total, pages } = await extrair(buffer);

  assert.ok(total > 1, `esperava mais de uma página, veio ${total}`);
  // nenhum produto se perde: inclusive o último
  const faltando = muitos.filter((produto) => !text.includes(produto.descricao));
  assert.deepEqual(faltando.map((produto) => produto.descricao), [], 'produtos sumiram na quebra');
  assert.ok(text.includes('PRODUTO 60'), 'o último produto não foi impresso');
  assert.equal(text.split('PRODUTO ').length - 1, 60, 'esperava exatamente 60 linhas de produto');

  // o total da entrega continua saindo, junto do último produto ou na página seguinte
  assert.ok(text.includes('Peso Total da Entrega: 900 kg'), 'o total da entrega sumiu');
  assert.ok(text.includes('Peso Carga (Total - Kg): 900'), 'falta o peso do pedido');
  assert.ok(text.includes('Quantidade de Entregas (NFs): 1'), 'faltam as NFs de entrega');

  // cabeçalho da tabela redesenhado e rodapé correto em todas as páginas
  assert.equal((text.match(/Produto\s+Qtde\.\s+Unid\.\s+Preço\s+Prazo/g) ?? []).length, total);
  conferirRodapes({ total, pages });
  assert.ok(pages[total - 1].text.includes(`Página ${total}/${total}`), 'rodapé da última página');
});

test('observação longa quebra em páginas sem comer texto nem o rodapé', async () => {
  const marcadores = Array.from({ length: 400 }, (_, indice) => `FRASE ${String(indice + 1).padStart(3, '0')}`);
  const pedido = pedidoBase({
    numero: '4100',
    observacao: marcadores.map((marcador) => `${marcador} de observação longa do pedido.`).join(' '),
    entregas: [],
  });

  const buffer = await gerarPdf(pedido);
  const { text, total, pages } = await extrair(buffer);

  assert.ok(total > 1, `esperava mais de uma página de observação, veio ${total}`);
  // nenhuma frase perdida ou duplicada entre as páginas
  assert.equal((text.match(/FRASE /g) ?? []).length, marcadores.length);
  assert.ok(pages[0].text.includes('FRASE 001'), 'a observação não começou na 1ª página');
  assert.ok(pages[total - 1].text.includes('FRASE 400'), 'o fim da observação não foi impresso');
  conferirRodapes({ total, pages });
});

test('campos ausentes não viram undefined/NaN e entregas pode faltar', async () => {
  const buffer = await gerarPdf({ categorias: 'CXS' });
  const { text, total, pages } = await extrair(buffer);

  assert.doesNotMatch(text, /undefined|NaN/, 'campos ausentes viraram undefined/NaN');
  assert.ok(!text.includes('nº'), 'título não pode imprimir "nº" sem número');
  assert.ok(!text.includes('Unidade de Carregamento'), 'sem unidade não deve haver a linha');
  assert.ok(!text.includes('EMBARQUE:'), 'sem datas não deve haver a linha CIF');
  assert.ok(text.includes('Pedido HAJAN CXS (FRIBOI)'), 'título sem número/sigla divergente');
  assert.ok(text.includes('Quantidade de Entregas (NFs): 0'), 'entregas ausente deveria contar 0');
  assert.ok(text.includes('Peso Carga (Total - Kg): 0'), 'peso ausente deveria virar 0');
  assert.ok(text.includes('Sem observações.'), 'falta o texto padrão de observação');

  conferirRodapes({ total, pages });
});
