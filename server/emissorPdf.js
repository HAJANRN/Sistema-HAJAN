import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { ROOT } from './config.js';
import { dataBr, dataBrCurta, ehEsc } from './emissorRegras.js';

const MM = 72 / 25.4;
const MARGEM = 10 * MM;
const LARGURA_UTIL = 190 * MM;
const AZUL = '#1F4E79';
const AZUL_FUNDO = '#DDEBF7';
const AMARELO = '#FFF200';

const ALTURA_LINHA = 4 * MM;
const RODAPE_Y = 282 * MM;
// O conteúdo nunca desce até FIM_CONTEUDO: sobram ~12mm de folga antes do rodapé.
const FIM_CONTEUDO = 270 * MM;
// Espaço mínimo para abrir um bloco de entrega (título, cliente, CNPJ, faixa da
// operação, cabeçalho da tabela, ao menos uma linha e o "Peso Total da Entrega").
const ESPACO_ENTREGA = 34 * MM;
// Espaço mínimo para o resumo do pedido + rótulo da observação.
const ESPACO_TOTAIS = 30 * MM;
// Espaço mínimo para "Observações Logísticas:" e as quatro linhas fixas.
const ESPACO_OBSERVACOES = 22 * MM;

const numero = (valor) => {
  const achado = Number(valor);
  return Number.isFinite(achado) ? achado : 0;
};
const texto = (valor) => (valor === null || valor === undefined ? '' : String(valor).trim());
const moeda = (valor) => numero(valor).toFixed(2);
const milhar = (valor) => Math.round(numero(valor)).toLocaleString('pt-BR');

const COLUNAS = [
  { x: 0, largura: 80, align: 'left' },
  { x: 80, largura: 15, align: 'right' },
  { x: 95, largura: 15, align: 'center' },
  { x: 110, largura: 20, align: 'right' },
  { x: 130, largura: 30, align: 'right' },
];

function linhaTabela(doc, y, valores, { negrito = false, fundo = null } = {}) {
  const altura = ALTURA_LINHA;
  if (fundo) doc.rect(MARGEM, y, 160 * MM, altura).fill(fundo);
  doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor('#000000');
  COLUNAS.forEach((coluna, indice) => {
    doc.text(String(valores[indice] ?? ''), MARGEM + coluna.x * MM, y + 1.3 * MM, {
      width: coluna.largura * MM,
      height: altura,
      align: coluna.align,
      ellipsis: true,
      lineBreak: false,
    });
  });
  doc.lineWidth(0.3).strokeColor('#000000');
  for (const coluna of COLUNAS) {
    doc.rect(MARGEM + coluna.x * MM, y, coluna.largura * MM, altura).stroke();
  }
  doc.y = y + altura;
}

function cabecalhoTabela(doc) {
  linhaTabela(doc, doc.y, ['Produto', 'Qtde.', 'Unid.', 'Preço', 'Prazo'], {
    negrito: true,
    fundo: '#EDEDED',
  });
}

/** Nova página com o cabeçalho do pedido redesenhado (como o header() do FPDF). */
function novaPagina(doc) {
  doc.addPage(); // o handler 'pageAdded' redesenha o cabeçalho e posiciona doc.y
  doc.y += 2 * MM;
}

/** Garante `altura` disponível; se não houver, abre página. Retorna true se quebrou. */
function espacoPara(doc, altura) {
  if (doc.y + altura <= FIM_CONTEUDO) return false;
  novaPagina(doc);
  return true;
}

/** Maior prefixo de `conteudo` que cabe em `altura`, cortado em limite de palavra. */
function dividirTexto(doc, conteudo, width, altura) {
  if (altura <= 0) return ['', conteudo];
  let baixo = 0;
  let alto = conteudo.length;
  while (baixo < alto) {
    const meio = Math.ceil((baixo + alto) / 2);
    if (doc.heightOfString(conteudo.slice(0, meio), { width }) <= altura) baixo = meio;
    else alto = meio - 1;
  }
  let corte = baixo;
  while (corte > 0 && !/\s/.test(conteudo[corte] ?? ' ')) corte -= 1;
  if (corte <= 0) corte = baixo;
  if (corte <= 0) return ['', conteudo];
  return [conteudo.slice(0, corte).replace(/\s+$/, ''), conteudo.slice(corte).replace(/^\s+/, '')];
}

/**
 * Escreve um parágrafo longo quebrando em páginas com o mesmo espaçamento, em vez
 * de deixar o auto page-break do pdfkit desenhar por cima do cabeçalho repetido.
 */
function escreverEmPaginas(doc, conteudo, { font = 'Helvetica', fontSize = 6.5, width = LARGURA_UTIL } = {}) {
  let restante = String(conteudo ?? '').trim();
  let paginas = 0;
  while (restante) {
    doc.font(font).fontSize(fontSize).fillColor('#000000');
    // folga de uma linha para o heightOfString não encostar no limite
    const [parte, resto] = dividirTexto(doc, restante, width, FIM_CONTEUDO - doc.y - fontSize);
    if (!parte) {
      if (paginas >= 40) {
        doc.text(restante, MARGEM, doc.y, { width });
        return;
      }
      novaPagina(doc);
      paginas += 1;
      continue;
    }
    doc.text(parte, MARGEM, doc.y, { width });
    restante = resto;
    if (restante) {
      novaPagina(doc);
      paginas += 1;
    }
  }
}

function cabecalho(doc, pedido) {
  const logo = path.join(ROOT, 'public', 'images', 'hajan-logo.png');
  const temLogo = fs.existsSync(logo);
  if (temLogo) doc.image(logo, MARGEM, 2 * MM, { width: 38 * MM });
  const y = temLogo ? 29 * MM : MARGEM;

  // como o legado: nº e sigla só entram quando existem
  const titulo = ['Pedido HAJAN'];
  if (texto(pedido.categorias)) titulo.push(texto(pedido.categorias));
  if (texto(pedido.numero)) titulo.push(`nº ${texto(pedido.numero)}`);
  if (texto(pedido.sigla)) titulo.push(`- ${texto(pedido.sigla)}`);
  titulo.push('(FRIBOI)');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
  if (doc.widthOfString(titulo.join(' ')) > LARGURA_UTIL) doc.fontSize(8);
  doc.text(titulo.join(' '), MARGEM, y, { width: LARGURA_UTIL, align: 'center' });

  const linhas = [
    'Vendedor: 1677169-HAJAN COM. E REPRESENTAÇÕES',
    'Ao: Frigorifico Friboi (Grupo JBS)',
  ];
  if (texto(pedido.unidade)) linhas.push(`Unidade de Carregamento: ${texto(pedido.unidade)}`);
  doc.font('Helvetica').fontSize(8);
  for (const linha of linhas) {
    doc.text(linha, MARGEM, doc.y + 1, { width: LARGURA_UTIL });
  }
  return doc.y + 2 * MM;
}

function desenhar(doc, pedido, contexto) {
  const clientes = contexto.clientes ?? new Map();
  const entregas = pedido.entregas ?? [];
  const inicio = cabecalho(doc, pedido);

  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  const dataEmissao = dataBr(pedido.dataEmissao);
  doc.text(
    `PEDIDO: ${texto(pedido.numero)} | At.: Sr. ${texto(pedido.atencao)} | ${texto(pedido.local)}${
      dataEmissao ? `, ${dataEmissao}` : ''
    }`,
    MARGEM,
    inicio,
    { width: LARGURA_UTIL },
  );
  const embarque = dataBrCurta(pedido.dataEmbarque);
  const entrega = dataBrCurta(pedido.dataEntrega);
  // como o legado: a linha CIF só existe quando as duas datas existem
  if (embarque && entrega) {
    doc.text(`CIF  -  EMBARQUE: ${embarque} - ENTREGA: ${entrega}`, { width: LARGURA_UTIL });
  }
  doc.y += 3 * MM;

  entregas.forEach((item, indice) => {
    espacoPara(doc, ESPACO_ENTREGA);
    const dados = clientes.get(item.cliente) ?? {};
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#000000')
      .text(`PEDIDO: ${texto(pedido.numero)} - ${indice + 1}ª entrega`, MARGEM, doc.y + 4);
    doc.font('Helvetica').fontSize(8).text(`Cliente: ${texto(item.cliente)}`, MARGEM, doc.y + 1);

    const cnpj = texto(dados.cnpj);
    const localizacao = [texto(dados.cidade), texto(dados.uf)].filter(Boolean).join(' - ');
    if (cnpj || localizacao) {
      const base = doc.y + 1;
      let x = MARGEM;
      if (cnpj) {
        doc.font('Helvetica-Bold').fontSize(8);
        const conteudoCnpj = `CNPJ: ${cnpj}`;
        const largura = doc.widthOfString(conteudoCnpj) + 1 * MM;
        doc.rect(MARGEM, base, largura, 4 * MM).fill(AMARELO);
        doc.fillColor('#000000').text(conteudoCnpj, MARGEM + 0.5 * MM, base + 0.7 * MM, { lineBreak: false });
        x = MARGEM + largura;
      }
      if (localizacao) {
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
        doc.text(`Cidade: ${localizacao}`, x, base + 0.7 * MM, { lineBreak: false });
      }
      doc.y = base + 4 * MM;
    }

    const textoOperacao =
      Number(item.operacao) === 9
        ? 'Operação 9'
        : item.destino
          ? `Operação 3: ${item.destino}`
          : 'Operação 3';
    const faixa = doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(AZUL);
    const larguraOperacao = doc.widthOfString(textoOperacao) + 1 * MM;
    doc.rect(MARGEM, faixa, larguraOperacao, 4 * MM).fill(AZUL_FUNDO);
    doc.text(textoOperacao, MARGEM + 0.5 * MM, faixa + 0.8 * MM, { lineBreak: false });
    doc.fillColor('#000000');

    cabecalhoTabela(doc);

    if (ehEsc(item.cliente) || ehEsc(item.destino)) {
      linhaTabela(doc, doc.y, [
        'PESO',
        milhar(item.pesoManual),
        'KG',
        '0,00',
        texto(item.prazo),
      ]);
    } else {
      for (const produto of item.produtos ?? []) {
        if (espacoPara(doc, ALTURA_LINHA)) cabecalhoTabela(doc);
        linhaTabela(doc, doc.y, [
          texto(produto.descricao),
          milhar(produto.qtd),
          texto(produto.unidade),
          moeda(produto.preco),
          texto(produto.prazo),
        ]);
      }
    }

    // o total da entrega também precisa caber; se não couber, continua na página nova
    if (espacoPara(doc, 5 * MM)) cabecalhoTabela(doc);
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(`Peso Total da Entrega: ${milhar(item.peso)} kg`, MARGEM, doc.y + 1, {
        width: LARGURA_UTIL,
      });
    doc.y += 3 * MM;
  });

  espacoPara(doc, ESPACO_TOTAIS);
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(`Peso Carga (Total - Kg): ${milhar(pedido.pesoTotal)}`, MARGEM, doc.y + 4);
  doc.font('Helvetica').fontSize(8);
  doc.text(`Veículo: ${texto(pedido.veiculo)}`);
  doc.text(`Quantidade de Entregas (NFs): ${entregas.length}`);
  doc.text(`Quantidade NFs de Remessa: ${milhar(pedido.nfsRemessa)}`);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(6).text('OBSERVAÇÃO:', MARGEM, doc.y + 2);
  escreverEmPaginas(doc, pedido.observacao?.trim() || 'Sem observações.');
  doc.moveDown(0.4);
  espacoPara(doc, ESPACO_OBSERVACOES);
  doc.font('Helvetica-Bold').fontSize(8).text('Observações Logísticas:', MARGEM, doc.y + 2);
  doc.font('Helvetica').fontSize(7).text(
    '1. Anexar na NF Boletos Bancários e Romaneio c/ o peso Peça por Peça.\n' +
      '2. Entregar p/ motorista R$ 40,00 por tonelada p/ pagamento da descarga.\n' +
      '3. Passar p/ Motorista nossos telefones p/ que entre em contato ao iniciar viagem\n' +
      '   (Tim e WhatsApp (84) 98865-0413), falar c/ Andreia.',
    { width: LARGURA_UTIL },
  );
}

export function gerarPdf(pedido, contexto = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGEM, left: MARGEM, right: MARGEM, bottom: MARGEM },
      bufferPages: true,
      info: { Title: `Pedido ${texto(pedido.numero)}` },
    });
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    // o FPDF repete o cabeçalho em toda página; aqui redesenhamos ao adicionar página
    doc.on('pageAdded', () => cabecalho(doc, pedido));
    desenhar(doc, pedido, contexto);

    const total = doc.bufferedPageRange().count;
    for (let pagina = 0; pagina < total; pagina += 1) {
      doc.switchToPage(pagina);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor('#000000')
        .text(`Página ${pagina + 1}/${total}`, MARGEM, RODAPE_Y, {
          width: LARGURA_UTIL,
          align: 'center',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
