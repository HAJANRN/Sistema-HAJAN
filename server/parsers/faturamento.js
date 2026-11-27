import path from 'node:path';
import XLSX from 'xlsx';
import { officialClientName } from '../clientes.js';

/**
 * Faturamento do ERP (FATURAMENTO HAJAN ...xlsx): uma linha por item vendido, com o número do
 * pedido Hajan (BITRUCK/CARRETA) no campo "Nome Instrução". O código da instrução filial agrupa
 * todas as linhas de um mesmo caminhão/pedido e traz a placa e a instrução da filial.
 */

const norm = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HEADERS = {
  pedido: ['pedido'],
  nomeInstrucao: ['nome instrucao'],
  instrucao: ['codigo instrucao filial'],
  situacao: ['situacao do pedido'],
  entregaSituacao: ['situacao da entrega'],
  peso: ['peso embarcado'],
  pesoLiquido: ['peso liquido estimado'],
  total: ['total'],
  faturamento: ['data do faturamento'],
  embarque: ['data de embarque'],
  entrega: ['data de entrega'],
  cancelamento: ['data de cancelamento'],
  cliente: ['nome do terceiro'],
  codigoCliente: ['codigo terceiro', 'codigo do terceiro'],
  cidade: ['cidade'],
  nota: ['numero documento'],
  serie: ['serie documento'],
  documento: ['codigo documento'],
  produto: ['produto'],
  empresa: ['empresa de entrega'],
  placa: ['placa do veiculo', 'placa veiculo', 'placa'],
  tipo: ['tipo de faturamento'],
};

/** "11 - E-CARNES-TERCEIRO-DEVOL.VENDA-C/MOV" → devolucao; "316 - ...REVENDA..." → revenda. */
function invoiceKind(value) {
  const text = norm(value);
  if (text.includes('devol')) return 'devolucao';
  if (text.includes('revenda')) return 'revenda';
  return 'venda';
}

function findColumns(row) {
  const cells = (row ?? []).map(norm);
  const find = (aliases) => {
    for (const alias of aliases) {
      const index = cells.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };
  const map = {};
  for (const [key, aliases] of Object.entries(HEADERS)) map[key] = find(aliases);
  return map;
}

const isHeader = (map) =>
  map.pedido >= 0 &&
  map.peso >= 0 &&
  map.total >= 0 &&
  (map.nomeInstrucao >= 0 || map.instrucao >= 0);

export function isFaturamentoFileName(name) {
  if (name.startsWith('~$') || name.startsWith('.')) return false;
  return /\.xlsx$/i.test(name);
}

/** Datas da planilha vêm como número de série do Excel (46296 = 2026-10-01) ou texto dd/mm/aa. */
function isoDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value).trim();
  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s|$)/.exec(text);
  if (br) {
    const year = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${year}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const NUMBER_RE = /(?<![\d/.-])(\d{3,5})(?![\d/.-])/g;

/** O número do pedido Hajan aparece no meio de textos como "BITRUCK N°2633 ATO 04/11 HAJAN". */
function planNumberOf(text, knownNumbers) {
  const found = [...text.matchAll(NUMBER_RE)].map((match) => Number(match[1]));
  return found.find((number) => knownNumbers.has(number)) ?? null;
}

function routeOf(text, planNumber, knownRoutes) {
  const tokens = text.split(/[^A-Z0-9]+/).filter(Boolean);
  const index = tokens.indexOf(String(planNumber));
  const hits = tokens
    .map((token, position) => ({ token, position }))
    .filter((item) => knownRoutes.has(item.token));
  if (!hits.length) return null;
  if (index < 0) return hits[0].token;
  hits.sort((a, b) => Math.abs(a.position - index) - Math.abs(b.position - index));
  return hits[0].token;
}

function finalize(group) {
  return {
    status: group.status,
    deliveryStatus: group.deliveryStatus,
    billedAt: group.billedAt,
    shipAt: group.shipAt,
    deliveryAt: group.deliveryAt,
    kg: round(group.kg, 3),
    value: round(group.value, 2),
    rows: group.rows,
    hasSales: group.hasSales,
    hasReturns: group.hasReturns,
    returnClients: [...group.returnClients].filter(Boolean),
    invoices: [...group.invoices.values()]
      .map(({ items, ...invoice }) => ({
        ...invoice,
        kg: round(invoice.kg, 3),
        value: round(invoice.value, 2),
        ...(items?.size
          ? {
              items: [...items.entries()]
                .map(([code, kg]) => ({ code, kg: round(kg, 3) }))
                .sort((a, b) => b.kg - a.kg),
            }
          : {}),
      }))
      .sort(
        (a, b) =>
          (a.date ?? '').localeCompare(b.date ?? '') || a.number.localeCompare(b.number),
      ),
    erpOrders: [...group.erpOrders].filter(Boolean),
    clients: [...group.clients].filter(Boolean),
    cities: [...group.cities].filter(Boolean),
    plates: [...group.plates].filter(Boolean).sort(),
    deliveryDates: [...group.deliveryDates].sort(),
    shipDates: [...group.shipDates].sort(),
    instruction: group.instruction || null,
    instructionCode: group.instructionCode || null,
  };
}

/**
 * Lê a planilha inteira e devolve um grupo por instrução filial, com totais e notas fiscais.
 * `knownNumbers`/`knownRoutes` vêm dos pedidos já importados e evitam casar com números de datas.
 */
export function parseFaturamentoFile(file, { knownNumbers = new Set(), knownRoutes = new Set() } = {}) {
  let workbook;
  try {
    workbook = XLSX.readFile(file, { cellDates: false });
  } catch (error) {
    return { ok: false, reason: `não consegui abrir a planilha: ${error.message}` };
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { ok: false, reason: 'planilha vazia' };

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  let columns = null;
  let headerRow = -1;
  for (let index = 0; index < Math.min(rows.length, 15); index += 1) {
    const found = findColumns(rows[index]);
    if (isHeader(found)) {
      columns = found;
      headerRow = index;
      break;
    }
  }
  if (!columns) return { ok: false, reason: 'cabeçalho do faturamento não encontrado' };

  const groups = new Map();
  let totalRows = 0;
  let dataDate = null;

  for (const row of rows.slice(headerRow + 1)) {
    if (!row || row[columns.pedido] == null) continue;
    if (columns.cancelamento >= 0 && row[columns.cancelamento] != null) continue;

    const agText = columns.nomeInstrucao >= 0 ? String(row[columns.nomeInstrucao] ?? '').trim() : '';
    const ag = agText.toUpperCase();
    const planNumber = planNumberOf(ag, knownNumbers);
    const instruction = columns.instrucao >= 0 ? String(row[columns.instrucao] ?? '').trim() : '';
    const empresa = columns.empresa >= 0 ? String(row[columns.empresa] ?? '').trim().toUpperCase() : '';
    const key = instruction || ag || `linha-${totalRows}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        planNumber,
        route: planNumber
          ? routeOf(ag, planNumber, knownRoutes)
          : knownRoutes.has(empresa)
            ? empresa
            : null,
        company: empresa,
        instruction: agText,
        instructionCode: instruction || ag || null,
        status: null,
        deliveryStatus: null,
        billedAt: null,
        shipAt: null,
        deliveryAt: null,
        kg: 0,
        value: 0,
        rows: 0,
        hasSales: false,
        hasReturns: false,
        returnClients: new Set(),
        invoices: new Map(),
        erpOrders: new Set(),
        clients: new Set(),
        cities: new Set(),
        plates: new Set(),
        deliveryDates: new Set(),
        shipDates: new Set(),
      };
      groups.set(key, group);
    }

    const kg = num(row[columns.peso]);
    const value = num(row[columns.total]);
    const kind = invoiceKind(columns.tipo >= 0 ? row[columns.tipo] : null);
    const isSale = kind === 'venda';
    const billedAt = isoDate(row[columns.faturamento]);
    const shipAt = columns.embarque >= 0 ? isoDate(row[columns.embarque]) : null;
    const deliveryAt = columns.entrega >= 0 ? isoDate(row[columns.entrega]) : null;
    // devolução/revenda não representa a carga do pedido: fica fora dos totais, placas e instrução
    if (isSale) {
      group.hasSales = true;
      group.status = group.status ?? (row[columns.situacao] ?? null);
      group.deliveryStatus = group.deliveryStatus ?? (row[columns.entregaSituacao] ?? null);
      group.shipAt = later(group.shipAt, shipAt);
      group.deliveryAt = later(group.deliveryAt, deliveryAt);
      if (shipAt) group.shipDates.add(shipAt);
      if (deliveryAt) group.deliveryDates.add(deliveryAt);
      group.kg += kg;
      group.value += value;
    } else {
      group.hasReturns = true;
    }
    group.billedAt = later(group.billedAt, billedAt);
    for (const date of [billedAt, shipAt, deliveryAt]) {
      if (date && (!dataDate || date > dataDate)) dataDate = date;
    }
    group.rows += 1;
    totalRows += 1;

    const pedido = row[columns.pedido];
    if (pedido != null) group.erpOrders.add(String(pedido));
    const cliente = row[columns.cliente];
    const clientCode =
      columns.codigoCliente >= 0 && row[columns.codigoCliente] != null
        ? String(row[columns.codigoCliente]).trim()
        : '';
    if (cliente) {
      group.clients.add(String(cliente).trim());
      // quem devolve é um cliente do pedido; o comprador da revenda normalmente não é
      if (kind === 'devolucao') group.returnClients.add(String(cliente).trim());
    }
    const cidade = row[columns.cidade];
    if (cidade) group.cities.add(String(cidade).trim());
    const placa = columns.placa >= 0 ? String(row[columns.placa] ?? '').trim().toUpperCase() : '';
    if (placa && isSale) group.plates.add(placa);

    const nota = row[columns.nota];
    if (nota != null) {
      const document = columns.documento >= 0 ? String(row[columns.documento] ?? '') : '';
      const serie = columns.serie >= 0 && row[columns.serie] != null
        ? String(row[columns.serie])
        : null;
      const invoiceKey = `${document}\u0000${nota}\u0000${serie ?? ''}`;
      const invoice = group.invoices.get(invoiceKey) ?? {
        number: String(nota),
        series: serie,
        date: null,
        client: null,
        clientCode: null,
        clientOfficial: null,
        city: null,
        kind: 'venda',
        kg: 0,
        value: 0,
        items: new Map(),
      };
      if (kind === 'devolucao' || (kind === 'revenda' && invoice.kind === 'venda')) {
        invoice.kind = kind;
      }
      invoice.date = later(invoice.date, billedAt);
      // a nota é emitida para um cliente: guarda o nome do ERP junto dela
      if (!invoice.client && cliente) invoice.client = String(cliente).trim();
      if (!invoice.clientCode && clientCode) {
        invoice.clientCode = clientCode;
        invoice.clientOfficial = officialClientName(clientCode);
      }
      if (!invoice.city && cidade) invoice.city = String(cidade).trim();
      invoice.kg += kg;
      invoice.value += value;
      // peso por produto (peso líquido embarcado) casa a nota com a entrega pelos itens
      const produto =
        columns.produto >= 0 && row[columns.produto] != null
          ? String(row[columns.produto]).trim()
          : '';
      // "Peso Embarcado" leva embalagem; o peso líquido é o mesmo da entrega no pedido
      const itemKg = columns.pesoLiquido >= 0 ? num(row[columns.pesoLiquido]) : kg;
      if (produto && itemKg > 0) invoice.items.set(produto, (invoice.items.get(produto) ?? 0) + itemKg);
      group.invoices.set(invoiceKey, invoice);
    }
  }

  if (!groups.size) return { ok: false, reason: 'nenhuma linha de faturamento encontrada' };

  return {
    ok: true,
    file: path.basename(file),
    rows: totalRows,
    dataDate,
    groups: [...groups.values()].map((group) => ({
      key: group.key,
      planNumber: group.planNumber,
      route: group.route,
      company: group.company,
      rows: group.rows,
      billing: finalize(group),
    })),
  };
}
