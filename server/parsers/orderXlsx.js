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

export function parseOrderXlsx(file) {
  const fileName = path.basename(file);
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

  for (const row of rows) {
    const a = row?.[0];
    const b = row?.[1];
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
    deliveries.push({ ...parsed, weightKg: null, items: null });
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
