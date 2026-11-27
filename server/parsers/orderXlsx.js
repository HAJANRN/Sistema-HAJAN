import path from 'node:path';
import XLSX from 'xlsx';

const NAME_RE =
  /(\d{4})-(\d{2})-\s?(\d{1,2})\s+Pedido\s+HAJAN\s+(CXS|P[ÇC]S)\s+n[ºo°]?\s*(\d+)\s*-\s*(R\d+)\s+([A-Z]{2,5})/i;

const TITLE_RE = /Pedido\s+HAJAN\s+(CXS|P[ÇC]S)\s+n[ºo°]?\s*(\d+)\s*-\s*(R\d+)\s+([A-Z]{2,5})/i;

const FOOTER_RE =
  /CIF\s*-\s*EMBARQUE:\s*(\d{2})\/(\d{2})\/(\d{2})\s*-\s*ENTREGA:\s*(\d{2})\/(\d{2})\/(\d{2})/i;

const normType = (raw) => (/^cxs$/i.test(raw) ? 'CXS' : 'PCS');

const isoFromParts = (dd, mm, yy) => `20${yy}-${mm}-${dd.padStart(2, '0')}`;

function cleanName(raw) {
  let name = String(raw ?? '').trim();
  const tail = /\s*\|\s*([^-|]+-[A-Z]{2})\s*$/.exec(name);
  if (tail) name = name.slice(0, tail.index).trim();
  return name.replace(/\s{2,}/g, ' ');
}

const PLACEHOLDER_CITY = /^(CIDADE|SEM DESTINO)$/i;

function splitCity(raw) {
  const text = String(raw ?? '').trim();
  const m = /^(.*?)\s*-\s*([A-Z]{2})$/.exec(text);
  if (!m) return { city: text, uf: '' };
  const city = m[1].trim();
  return { city: PLACEHOLDER_CITY.test(city) ? '' : city, uf: m[2] };
}

const ROW_A_RE = /^(?:[A-Z]\s+)?(\d+)\s*\|\s*(.*?)\s*(?:#\([^)]*\)#)?\s*\|\s*(.*)$/;
const ROW_B_RE = /^(\d+)\s*[ªa]?\s*Entrega\s*\|\s*(.*)$/i;
const ANNOT_SEQ_RE = /^(?:[A-Z]\s*)?(\d+)$/i;

function cleanAnnotation(company) {
  const name = String(company ?? '')
    .replace(/#\([^)]*\)#/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name);
  if (!m) return { name, city: '', uf: '' };
  return { name: m[1].trim(), city: m[2].trim(), uf: '' };
}

function parseAnnotationRow(a, b) {
  const seqText = typeof a === 'number' ? String(a) : typeof a === 'string' ? a.trim() : '';
  const sm = ANNOT_SEQ_RE.exec(seqText);
  if (!sm || typeof b !== 'string' || !b.trim()) return null;
  const { name, city, uf } = cleanAnnotation(b);
  if (!name || /^TOTAL$/i.test(name)) return null;
  return { seq: Number(sm[1]), name, city, uf };
}

function parseRow(a, b) {
  const aStr = typeof a === 'string' ? a.trim() : '';
  const bStr = typeof b === 'string' ? b.trim() : '';
  if (!aStr && !bStr) return null;
  if (/^CIF\b/i.test(aStr) || /^CIF\b/i.test(bStr)) return null;

  const bm = ROW_B_RE.exec(bStr);
  const am = ROW_A_RE.exec(aStr);

  let seq = null;
  let name = '';
  let city = '';
  let uf = '';

  if (am) {
    seq = Number(am[1]);
    name = cleanName(am[2]);
    const loc = splitCity(am[3]);
    city = loc.city;
    uf = loc.uf;
  }
  if (bm) {
    const bSeq = Number(bm[1]);
    const bName = cleanName(bm[2]);
    if (seq === null || bSeq === seq) seq = bSeq;
    if (bName && bName.length >= name.length) name = bName;
  }
  if (seq === null) {
    const annot = parseAnnotationRow(a, b);
    if (!annot) return null;
    return annot;
  }
  if (!name) return null;
  return { seq, name, city, uf };
}

export function orderIdOf({ type, number, revision, route }) {
  return `${type.toLowerCase()}-${number}-${revision.toLowerCase()}-${route.toLowerCase()}`;
}

const PRODUTO_LINHA_RE = /^(\d{1,8})\s*-\s*(.+)$/;
const RODAPE_RE = /^\s*TOTAL\s*$|CIF\s*-|TRANSPORTADORA|PLACA:/i;

/** Charque: um cliente por arquivo. O nome "Clientes Diversos" ficou nos pedidos antigos. */
const CHQ_FILE_RE =
  /^Pedido\s+(?:Hajan\s+CHQ|HAJAN\s+Clientes\s+Diversos\s+Charque)\s*n[ºo°]?\s*(\d+)\s*\(([^)]+)\)(?:\s*-\s*CANCELADO)?\.xlsx$/i;
const CHQ_TITLE_RE = /PEDIDO(?:\s+DE\s+VENDA)?\s*(?:n[ºo°])?\s*(\d+)/i;

/** SPG: o número do pedido e a rota estão no nome; as paradas ficam na planilha de anotações. */
const SPG_FILE_RE =
  /^Pedido\s+HAJAN\s+SPG\s+n[ºo°]?\s*(\d+)\s*-\s*(?:R(\d+)\s+)?([A-Z]{2,5})\b/i;
const SPG_REF_RE = /Pedido\s+HAJAN\s+SPG\s+n[ºo°]?\s*(\d+)/i;

export const isChqFileName = (name) =>
  CHQ_FILE_RE.test(name) && !/-\s*CANCELADO\.xlsx$/i.test(name);
export const isSpgFileName = (name) => SPG_FILE_RE.test(name);

const pad2 = (value) => String(value).padStart(2, '0');

const isoFromDate = (value) =>
  `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;

/** Data de célula do Excel: número de série, Date (cellDates) ou texto dd/mm/aa. */
function isoFromCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoFromDate(value);
  if (typeof value === 'number' && value > 1000) {
    const date = XLSX.SSF.parse_date_code(value);
    if (date?.y) return `${date.y}-${pad2(date.m)}-${pad2(date.d)}`;
  }
  const text = String(value ?? '').trim();
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (br) {
    const year = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${year}-${pad2(br[2])}-${pad2(br[1])}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

const normLabel = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

/** Valor da célula logo abaixo do rótulo (CNPJ, nome do cliente, cidade, estado, data). */
function valueBelow(rows, labelRe) {
  for (let r = 0; r < Math.min(rows.length, 40); r += 1) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      if (!labelRe.test(normLabel(row[c]))) continue;
      const value = rows[r + 1]?.[c];
      if (value == null || String(value).trim() === '') continue;
      return value;
    }
  }
  return null;
}

const cleanText = (value) => String(value ?? '').replace(/\s{2,}/g, ' ').trim();

function chqProductColumns(rows) {
  for (let r = 0; r < rows.length; r += 1) {
    const cells = (rows[r] ?? []).map(normLabel);
    const code = cells.findIndex((cell) => cell === 'CODIGO PRODUTO');
    if (code < 0) continue;
    return {
      row: r,
      code,
      name: cells.findIndex((cell) => cell === 'NOME PRODUTO'),
      boxes: cells.findIndex((cell) => cell.startsWith('VOLUME') || cell === 'PEDIDO'),
      boxKg: cells.findIndex((cell) => cell === 'PESO CAIXA'),
    };
  }
  return null;
}

function parseChq(file, fileName) {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { ok: false, reason: 'planilha vazia' };
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const fileMatch = CHQ_FILE_RE.exec(fileName);
  const title = rows
    .slice(0, 3)
    .flat()
    .map((cell) => String(cell ?? ''))
    .map((text) => CHQ_TITLE_RE.exec(text))
    .find(Boolean);
  // o nome do arquivo manda no número: há planilha com o título repetindo o pedido anterior
  const number = Number(fileMatch?.[1] ?? title?.[1]);
  if (!number) return { ok: false, reason: 'não identifiquei o número do pedido CHQ' };

  const columns = chqProductColumns(rows);
  if (!columns) return { ok: false, reason: 'tabela de produtos não encontrada' };

  const items = [];
  for (let r = columns.row + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    if (row.some((cell) => normLabel(cell) === 'TOTAL')) break;
    const code = String(row[columns.code] ?? '').trim();
    if (!code) continue;
    const boxes = toBoxes(row[columns.boxes]);
    const boxKg = columns.boxKg >= 0 ? toBoxes(row[columns.boxKg]) : null;
    const kg = boxes != null && boxKg != null ? boxes * boxKg : null;
    let name = cleanText(row[columns.name]);
    if (name.endsWith(`(${code})`)) name = name.slice(0, -`(${code})`.length).trim();
    items.push({ code, name, kg, boxes: boxes ?? null });
  }
  if (!items.length) return { ok: false, reason: 'nenhum produto encontrado' };

  const client = cleanText(valueBelow(rows, /^NOME CLIENTE$/)) || fileMatch?.[2] || '';
  const city = cleanText(valueBelow(rows, /^CIDADE$/));
  const uf = cleanText(valueBelow(rows, /^ESTADO$/)).toUpperCase();
  const date = isoFromCell(valueBelow(rows, /^DATA$/));
  // o pedido CHQ não tem data de entrega: a data do pedido é a única referência do arquivo
  const totalKg = items.every((item) => item.kg != null)
    ? Math.round(items.reduce((sum, item) => sum + item.kg, 0) * 1000) / 1000
    : null;
  const route = uf || 'CHQ';
  const identity = { type: 'CHQ', number, revision: 'R0', route };

  return {
    ok: true,
    id: orderIdOf(identity),
    ...identity,
    shipDate: date,
    deliveryDate: date,
    client: client || null,
    totalKg,
    deliveries: [
      {
        seq: 1,
        name: client || 'Cliente CHQ',
        city,
        uf,
        weightKg: totalKg,
        items,
      },
    ],
    sourceFile: fileName,
  };
}

const cleanSpgName = (value) =>
  cleanText(
    String(value ?? '')
      .replace(/#\([^)]*\)#/g, ' ')
      .replace(/#/g, ' '),
  );

function parseSpg(file, fileName) {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { ok: false, reason: 'planilha vazia' };
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const fileMatch = SPG_FILE_RE.exec(fileName);
  if (!fileMatch) return { ok: false, reason: 'não identifiquei o pedido SPG no nome do arquivo' };
  const refText = rows
    .flat()
    .map((cell) => String(cell ?? ''))
    .find((text) => /Ref\.?\s*Pedido\s+HAJAN\s+SPG/i.test(text));
  // o nome do arquivo manda no número; a linha "Ref. Pedido" é só reserva
  const number = Number(fileMatch[1] ?? SPG_REF_RE.exec(refText ?? '')?.[1]);
  const revision = fileMatch[2] ? `R${fileMatch[2]}` : 'R0';
  const route = fileMatch[3].toUpperCase();

  let header = null;
  for (let r = 0; r < rows.length; r += 1) {
    const cells = (rows[r] ?? []).map(normLabel);
    const ent = cells.indexOf('ENT.');
    const empresa = cells.indexOf('EMPRESA');
    if (ent >= 0 && empresa >= 0) {
      header = { row: r, ent, empresa };
      break;
    }
  }
  if (!header) return { ok: false, reason: 'cabeçalho ENT./EMPRESA não encontrado' };

  const deliveries = [];
  for (let r = header.row + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    if (row.some((cell) => normLabel(cell) === 'TOTAL')) break;
    const name = cleanSpgName(row[header.empresa]);
    if (!name || /^TOTAL$/i.test(name)) continue;
    const seqText = String(row[header.ent] ?? '');
    const seqMatch = /\d+/.exec(seqText);
    deliveries.push({
      seq: seqMatch ? Number(seqMatch[0]) : deliveries.length + 1,
      name,
      city: '',
      uf: '',
      weightKg: null,
      items: [],
    });
  }
  if (!deliveries.length) return { ok: false, reason: 'nenhuma parada encontrada' };

  const footer = rows
    .flat()
    .map((cell) => String(cell ?? ''))
    .find((text) => /CIF\s*-\s*EMBARQUE/i.test(text));
  const dates = footer
    ? /EMBARQUE:\s*(\d{2})\/(\d{2})\/(\d{2})(?:[\s\S]*?ENTREGA:\s*(\d{2})\/(\d{2})\/(\d{2}))?/i.exec(
        footer,
      )
    : null;
  const shipDate = dates ? isoFromCell(`${dates[1]}/${dates[2]}/${dates[3]}`) : null;
  const deliveryDate = dates
    ? isoFromCell(`${dates[4] ?? dates[1]}/${dates[5] ?? dates[2]}/${dates[6] ?? dates[3]}`)
    : null;

  const identity = { type: 'SPG', number, revision, route };
  return {
    ok: true,
    id: orderIdOf(identity),
    ...identity,
    shipDate,
    deliveryDate,
    client: null,
    totalKg: null,
    deliveries,
    sourceFile: fileName,
  };
}

/** A folha de anotação traz ENT./EMPRESA/PRODUTOS/QTD CXS/NF/TOTAL/PRAZO. */
function productColumns(rows) {
  for (const row of rows) {
    const cells = (row ?? []).map((cell) =>
      typeof cell === 'string' ? cell.trim().toUpperCase() : '',
    );
    const index = cells.indexOf('PRODUTOS');
    if (index < 0) continue;
    return {
      produtos: index,
      qtd: cells.findIndex((cell) => /^QTD/.test(cell)),
    };
  }
  return null;
}

const toBoxes = (raw) => {
  if (raw == null || raw === '') return null;
  const value = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};

/** Célula de produto: "352821-FRALDA CONG (2)", uma linha por produto. */
function parseProductCell(raw, boxes) {
  const linhas = String(raw ?? '')
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(Boolean);
  return linhas.map((linha, index) => {
    const m = PRODUTO_LINHA_RE.exec(linha);
    return {
      code: m ? m[1] : '',
      name: (m ? m[2] : linha).replace(/\s{2,}/g, ' ').trim(),
      kg: null,
      boxes: index === 0 ? boxes : null,
    };
  });
}

export function parseOrderXlsx(file) {
  const fileName = path.basename(file);
  if (isChqFileName(fileName)) return parseChq(file, fileName);
  if (isSpgFileName(fileName)) return parseSpg(file, fileName);
  const fileMatch = NAME_RE.exec(fileName);
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { ok: false, reason: 'planilha vazia' };

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  let titleText = '';
  for (const row of rows.slice(0, 30)) {
    const found = (row ?? []).find((cell) => typeof cell === 'string' && TITLE_RE.test(cell));
    if (found) {
      titleText = found;
      break;
    }
  }
  const titleMatch = TITLE_RE.exec(titleText) ?? TITLE_RE.exec(fileName);
  const identitySource = titleMatch
    ? {
        type: normType(titleMatch[1]),
        number: Number(titleMatch[2]),
        revision: titleMatch[3].toUpperCase(),
        route: titleMatch[4].toUpperCase(),
      }
    : fileMatch
      ? {
          type: normType(fileMatch[4]),
          number: Number(fileMatch[5]),
          revision: fileMatch[6].toUpperCase(),
          route: fileMatch[7].toUpperCase(),
        }
      : null;

  if (!identitySource) return { ok: false, reason: 'não identifiquei pedido/tipo/rota no arquivo' };

  let footer = null;
  const deliveries = [];
  const seen = new Set();
  const colunas = productColumns(rows);
  let depoisDoRodape = false;

  for (const row of rows) {
    const a = row?.[0];
    const b = row?.[1];
    const textoLinha = (row ?? [])
      .filter((cell) => cell != null)
      .map((cell) => String(cell))
      .join(' ');
    if (RODAPE_RE.test(textoLinha)) depoisDoRodape = true;
    if (typeof a === 'string' || typeof b === 'string') {
      const fm = FOOTER_RE.exec(`${a ?? ''} ${b ?? ''}`);
      if (fm) {
        footer = {
          shipDate: isoFromParts(fm[1], fm[2], fm[3]),
          deliveryDate: isoFromParts(fm[4], fm[5], fm[6]),
        };
        continue;
      }
    }
    const parsed = parseRow(a, b);
    if (!parsed) continue;
    if (seen.has(parsed.seq)) continue;
    seen.add(parsed.seq);
    const items =
      colunas && !depoisDoRodape
        ? parseProductCell(
            row?.[colunas.produtos],
            colunas.qtd >= 0 ? toBoxes(row?.[colunas.qtd]) : null,
          )
        : [];
    deliveries.push({ ...parsed, weightKg: null, items });
  }

  if (!deliveries.length) return { ok: false, reason: 'nenhuma entrega encontrada' };

  const filenameDate = fileMatch
    ? `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3].padStart(2, '0')}`
    : null;

  deliveries.sort((x, y) => x.seq - y.seq);

  return {
    ok: true,
    id: orderIdOf(identitySource),
    ...identitySource,
    shipDate: footer?.shipDate ?? filenameDate,
    deliveryDate: footer?.deliveryDate ?? filenameDate,
    client: null,
    totalKg: null,
    deliveries,
    sourceFile: fileName,
  };
}
export function orderIdFromName(file) {
  const m = TITLE_RE.exec(path.basename(file));
  if (!m) return null;
  return orderIdOf({
    type: normType(m[1]),
    number: Number(m[2]),
    revision: m[3].toUpperCase(),
    route: m[4].toUpperCase(),
  });
}
