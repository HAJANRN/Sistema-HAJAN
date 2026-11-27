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

const moeda = (valor) => Number(valor ?? 0).toFixed(2);
const milhar = (valor) => Math.round(Number(valor ?? 0)).toLocaleString('pt-BR');

const COLUNAS = [
  { x: 0, largura: 80, align: 'left' },
  { x: 80, largura: 15, align: 'right' },
  { x: 95, largura: 15, align: 'center' },
  { x: 110, largura: 20, align: 'right' },
  { x: 130, largura: 30, align: 'right' },
];

function linhaTabela(doc, y, valores, { negrito = false, fundo = null } = {}) {
  const altura = 4 * MM;
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

function cabecalho(doc, pedido) {
  const logo = path.join(ROOT, 'public', 'images', 'hajan-logo.png');
  const temLogo = fs.existsSync(logo);
  if (temLogo) doc.image(logo, MARGEM, 2 * MM, { width: 38 * MM });
  const y = temLogo ? 29 * MM : MARGEM;

  const titulo = `Pedido HAJAN ${pedido.categorias} nº ${pedido.numero} - ${pedido.sigla} (FRIBOI)`;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
  if (doc.widthOfString(titulo) > LARGURA_UTIL) doc.fontSize(8);
  doc.text(titulo, MARGEM, y, { width: LARGURA_UTIL, align: 'center' });

  doc.font('Helvetica').fontSize(8);
  for (const linha of [
    'Vendedor: 1677169-HAJAN COM. E REPRESENTAÇÕES',
    'Ao: Frigorifico Friboi (Grupo JBS)',
    `Unidade de Carregamento: ${pedido.unidade}`,
  ]) {
    doc.text(linha, MARGEM, doc.y + 1, { width: LARGURA_UTIL });
  }
  return doc.y + 2 * MM;
}

function desenhar(doc, pedido, contexto) {
  const clientes = contexto.clientes ?? new Map();
  const inicio = cabecalho(doc, pedido);

  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  doc.text(
    `PEDIDO: ${pedido.numero} | At.: Sr. ${pedido.atencao} | ${pedido.local}, ${dataBr(pedido.dataEmissao)}`,
    MARGEM,
    inicio,
    { width: LARGURA_UTIL },
  );
  doc.text(
    `CIF  -  EMBARQUE: ${dataBrCurta(pedido.dataEmbarque)} - ENTREGA: ${dataBrCurta(pedido.dataEntrega)}`,
    { width: LARGURA_UTIL },
  );
  doc.y += 3 * MM;

  pedido.entregas.forEach((entrega, indice) => {
    if (doc.y > 230 * MM) doc.addPage();
    const dados = clientes.get(entrega.cliente) ?? {};
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#000000')
      .text(`PEDIDO: ${pedido.numero} - ${indice + 1}ª entrega`, MARGEM, doc.y + 4);
    doc.font('Helvetica').fontSize(8).text(`Cliente: ${entrega.cliente}`, MARGEM, doc.y + 1);

    const cnpj = String(dados.cnpj ?? '');
    const localizacao = [dados.cidade, dados.uf].filter(Boolean).join(' - ');
    if (cnpj || localizacao) {
      const base = doc.y + 1;
      let x = MARGEM;
      if (cnpj) {
        doc.font('Helvetica-Bold').fontSize(8);
        const texto = `CNPJ: ${cnpj}`;
        const largura = doc.widthOfString(texto) + 1 * MM;
        doc.rect(MARGEM, base, largura, 4 * MM).fill(AMARELO);
        doc.fillColor('#000000').text(texto, MARGEM + 0.5 * MM, base + 0.7 * MM, { lineBreak: false });
        x = MARGEM + largura;
      }
      if (localizacao) {
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
        doc.text(`Cidade: ${localizacao}`, x, base + 0.7 * MM, { lineBreak: false });
      }
      doc.y = base + 4 * MM;
    }

    const textoOperacao =
      entrega.operacao === 9
        ? 'Operação 9'
        : entrega.destino
          ? `Operação 3: ${entrega.destino}`
          : 'Operação 3';
    const faixa = doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(AZUL);
    const larguraOperacao = doc.widthOfString(textoOperacao) + 1 * MM;
    doc.rect(MARGEM, faixa, larguraOperacao, 4 * MM).fill(AZUL_FUNDO);
    doc.text(textoOperacao, MARGEM + 0.5 * MM, faixa + 0.8 * MM, { lineBreak: false });
    doc.fillColor('#000000');

    linhaTabela(doc, faixa + 4 * MM, ['Produto', 'Qtde.', 'Unid.', 'Preço', 'Prazo'], {
      negrito: true,
      fundo: '#EDEDED',
    });

    if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) {
      linhaTabela(doc, doc.y, [
        'PESO',
        milhar(entrega.pesoManual ?? 0),
        'KG',
        '0,00',
        entrega.prazo ?? '',
      ]);
    } else {
      for (const produto of entrega.produtos ?? []) {
        linhaTabela(doc, doc.y, [
          produto.descricao,
          milhar(produto.qtd),
          produto.unidade,
          moeda(produto.preco),
          produto.prazo,
        ]);
      }
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(`Peso Total da Entrega: ${milhar(entrega.peso)} kg`, MARGEM, doc.y + 1, {
        width: LARGURA_UTIL,
      });
    doc.y += 3 * MM;
  });

  if (doc.y > 210 * MM) doc.addPage();
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(`Peso Carga (Total - Kg): ${milhar(pedido.pesoTotal)}`, MARGEM, doc.y + 4);
  doc.font('Helvetica').fontSize(8);
  doc.text(`Veículo: ${pedido.veiculo}`);
  doc.text(`Quantidade de Entregas (NFs): ${pedido.entregas.length}`);
  doc.text(`Quantidade NFs de Remessa: ${pedido.nfsRemessa}`);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(6).text('OBSERVAÇÃO:', MARGEM, doc.y + 2);
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .text(pedido.observacao?.trim() || 'Sem observações.', { width: LARGURA_UTIL });
  doc.moveDown(0.4);
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
      info: { Title: `Pedido ${pedido.numero}` },
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
        .text(`Página ${pagina + 1}/${total}`, MARGEM, 282 * MM, {
          width: LARGURA_UTIL,
          align: 'center',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
