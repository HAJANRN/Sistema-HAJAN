export type OrderType = 'CXS' | 'PCS' | 'CHQ' | 'SPG';

/** `operacao` marca entregas e registra anomalias; `administracao` abre importação, ajustes e servidor. */
export type Papel = 'operacao' | 'administracao';

export type DeliveryStatus = 'pendente' | 'em_rota' | 'no_cliente' | 'entregue' | 'recusado';

export type RefusalReason =
  | 'falta_peso'
  | 'falta_pecas'
  | 'falta_peso_peca'
  | 'sobra_peso'
  | 'troca_palete'
  | 'falta_caixa'
  | 'qualidade'
  | 'sem_vacuo'
  | 'produto_invertido'
  | 'camera_fria'
  | 'falha_padrao'
  | 'erro_faturamento'
  | 'desconto_preco'
  | 'erro_digitacao'
  | 'erro_envio_pedido'
  | 'divergencia_pedido'
  | 'cadastro'
  | 'atraso_entrega'
  | 'sem_espaco_recebimento'
  | 'outro';

export type AttachmentKind = 'arquivo' | 'resumo';
export type AttachmentLocation = 'fila' | 'no_s' | 'erro';

export interface Attachment {
  id: string;
  seq: number;
  name: string;
  mime: string | null;
  bytes: number;
  kind: AttachmentKind;
  status: AttachmentLocation;
  path: string | null;
  createdAt: string;
}

export interface DeliveryProduct {
  code: string;
  name: string;
  kg: number | null;
  boxes?: number | null;
}

export interface Delivery {
  seq: number;
  name: string;
  city: string;
  uf: string;
  weightKg: number | null;
  products?: DeliveryProduct[];
  status: DeliveryStatus;
  note: string | null;
  observation: string | null;
  statusAt: string | null;
  eta?: string | null;
  scheduledAt: string | null;
  reason: RefusalReason | null;
  resale: boolean | null;
  resaleDate: string | null;
  /** Pedidos com osso: o cliente já tem lombador? */
  lombador: boolean | null;
  attachments?: Attachment[];
}

export interface DeliveryPatch {
  status?: DeliveryStatus;
  note?: string | null;
  observation?: string | null;
  scheduledAt?: string | null;
  reason?: RefusalReason | null;
  resale?: boolean | null;
  resaleDate?: string | null;
  lombador?: boolean | null;
}

export type InvoiceKind = 'venda' | 'devolucao' | 'revenda';

export interface BillingInvoiceItem {
  /** Código do produto no ERP. */
  code: string;
  /** Peso líquido embarcado: o mesmo peso do produto na entrega, sem a embalagem. */
  kg: number;
}

export interface BillingInvoice {
  number: string;
  series: string | null;
  date: string | null;
  client: string | null;
  /** Código JBS do terceiro que recebeu a nota. */
  clientCode?: string | null;
  /** Nome oficial da filial no cadastro de clientes FRIBOI, quando o código é conhecido. */
  clientOfficial?: string | null;
  city: string | null;
  kind?: InvoiceKind;
  kg: number;
  value: number;
  /** Itens da nota (código + peso líquido): identificam a entrega certa mesmo na central. */
  items?: BillingInvoiceItem[];
}

/** Resumo do ERP por pedido. É informativo: não muda o status das entregas. */
export interface OrderBilling {
  status: string | null;
  deliveryStatus: string | null;
  billedAt: string | null;
  shipAt: string | null;
  deliveryAt: string | null;
  kg: number;
  value: number;
  rows: number;
  invoices: BillingInvoice[];
  erpOrders: string[];
  clients: string[];
  cities: string[];
  plates: string[];
  instruction: string | null;
  instructionCode: string | null;
  sourceFile: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  type: OrderType;
  number: number;
  revision: string;
  route: string;
  shipDate: string | null;
  deliveryDate: string | null;
  client: string | null;
  totalKg: number | null;
  sourceFile: string | null;
  pdfFile: string | null;
  plates: string | null;
  branchInstruction: string | null;
  billing?: OrderBilling | null;
  updatedAt: string;
  deliveries: Delivery[];
  pendingSync?: boolean;
}

/** Dados do pedido inteiro; a fila usa seq 0 com kind 'pedido'. */
export interface OrderPatch {
  plates?: string | null;
  branchInstruction?: string | null;
}

export interface OutboxEntry {
  id?: number;
  orderId: string;
  seq: number;
  kind?: 'pedido';
  plates?: string | null;
  branchInstruction?: string | null;
  status?: DeliveryStatus;
  note?: string | null;
  observation?: string | null;
  scheduledAt?: string | null;
  reason?: RefusalReason | null;
  resale?: boolean | null;
  resaleDate?: string | null;
  lombador?: boolean | null;
  queuedAt: string;
}

export interface AnomalySaveResult {
  id: string;
  folder: string | null;
  saved: number;
  pending: number;
  summary: Attachment;
}

export interface AttachmentJob {
  id?: number;
  orderId: string;
  seq: number;
  name: string;
  mime: string;
  bytes: number;
  blob: Blob;
  queuedAt: string;
  error?: string | null;
}

export interface ScanDir {
  dir: string;
  kind: 'xlsx' | 'pdf' | 'faturamento';
  exists: boolean;
  files: number;
}

export interface BillingStatus {
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncMs: number | null;
  lastSync: {
    files: number;
    rows: number;
    orders: number;
    matchedRows: number;
    unmatched: number;
    unmatchedRows: number;
    errors: number;
  };
  errors: { file: string; error: string; at: string }[];
  dirs: ScanDir[];
}

export interface ImportIssue {
  path: string;
  kind: string;
  error: string;
  imported_at: string;
}

export interface ImportStatus {
  scanning: boolean;
  lan: string | null;
  tunnel?: string | null;
  role?: Papel;
  attachmentRoot?: string;
  attachmentMaxBytes?: number;
  attachmentSummary?: {
    noS: { files: number; bytes: number };
    naFila: { files: number; bytes: number };
  };
  lastScanAt: string | null;
  lastScanMs: number | null;
  lastScan: { imported: number; skipped: number; errors: number };
  dirs: ScanDir[];
  billing?: BillingStatus;
  orphanPdfs: { file: string; reason: string; at: string }[];
  orders: number;
  deliveries: Record<string, number>;
  recentDates: { date: string; orders: number }[];
  road: number;
  errors: ImportIssue[];
}

export interface EtaSettings {
  speedKmh: number;
  stopMinutes: number;
}

export const TYPE_LABEL: Record<OrderType, string> = {
  CXS: 'Caixaria',
  PCS: 'Com osso',
  CHQ: 'Charque',
  SPG: 'SPG',
};

export const TYPE_SOURCE: Record<OrderType, string> = {
  CXS: 'CXS',
  PCS: 'PÇS',
  CHQ: 'CHQ',
  SPG: 'SPG',
};

/** Classe visual do card/etiqueta de cada tipo de pedido. */
export const TYPE_CLASS: Record<OrderType, string> = {
  CXS: 'caixaria',
  PCS: 'osso',
  CHQ: 'charque',
  SPG: 'spg',
};

/** Ordem de exibição dentro do dia: com osso, caixaria, charque e SPG. */
export const TYPE_ORDER: Record<OrderType, number> = {
  PCS: 0,
  CXS: 1,
  CHQ: 2,
  SPG: 3,
};

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pendente: 'Pendente',
  em_rota: 'Em rota',
  no_cliente: 'No cliente',
  entregue: 'Entregue',
  recusado: 'Recusado',
};

export const STATUS_ACTIONS: DeliveryStatus[] = [
  'em_rota',
  'no_cliente',
  'entregue',
  'recusado',
];

export const FINAL_STATUSES: DeliveryStatus[] = ['entregue', 'recusado'];

/** Clientes ESC não passam por agendamento de caixaria. */
export const isEscClient = (name: string | null | undefined) =>
  /^ESC(\s|$)/i.test(String(name ?? '').trim());

/** ESC aparece na lista, mas nenhum botao age na entrega. */
export const isSchedulable = (name: string | null | undefined) => !isEscClient(name);

/** No SPG as paradas são lojas ESC de verdade: entram no controle como qualquer entrega. */
export const isEscDelivery = (
  order: Pick<Order, 'type'>,
  name: string | null | undefined,
) => order.type !== 'SPG' && isEscClient(name);

/** Mesmo produto quando o código bate; sem código, compara pelo nome. */
export const productKey = (product: DeliveryProduct) => {
  const code = product.code.trim();
  return code ? `c:${code}` : `n:${product.name.trim().toUpperCase()}`;
};

export const productLabel = (product: DeliveryProduct) =>
  [product.code.trim(), product.name.trim()].filter(Boolean).join(' · ');

export const deliveryHasProduct = (delivery: Delivery, key: string) =>
  (delivery.products ?? []).some((product) => productKey(product) === key);

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  venda: 'NF',
  devolucao: 'Devolução',
  revenda: 'Revenda',
};

export const invoiceKindOf = (invoice: BillingInvoice): InvoiceKind => invoice.kind ?? 'venda';

const NAME_STOP = new Set([
  'ltda', 'me', 'epp', 'sa', 's', 'a', 'filial', 'matriz', 'de', 'da', 'do', 'das', 'dos',
  'e', 'com', 'dist', 'distribuidora', 'distribuidor', 'alimentos', 'comercial', 'comercio',
  'industria', 'cd', 'atacado', 'atacadista',
]);

const nameTokens = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token && !NAME_STOP.has(token.toLowerCase()));

const tokenSame = (a: string, b: string) =>
  a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

const fullName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/**
 * Mesmo critério do servidor: nome do ERP x nome da entrega, sem exigir igualdade exata.
 * `precision` diz quanto do nome da entrega foi coberto e `exact` marca o nome idêntico —
 * é o que separa filiais que o ERP chama igual (DIST. CARNES FRIOS x ... FILIAL).
 */
function clientNameMatch(a: string | null | undefined, b: string | null | undefined) {
  const ta = nameTokens(String(a ?? ''));
  const tb = nameTokens(String(b ?? ''));
  if (!ta.length || !tb.length) return { score: 0, precision: 0, exact: false };
  let hits = 0;
  let strong = false;
  const used = new Set<number>();
  for (const x of ta) {
    for (let index = 0; index < tb.length; index += 1) {
      if (used.has(index) || !tokenSame(x, tb[index])) continue;
      used.add(index);
      hits += 1;
      if (Math.min(x.length, tb[index].length) >= 4) strong = true;
      break;
    }
  }
  const ratio = hits / Math.min(ta.length, tb.length);
  if (!strong && ta.length === tb.length && ratio === 1) strong = true;
  return {
    score: strong && ratio >= 0.6 ? ratio : 0,
    precision: hits / tb.length,
    exact: fullName(String(a ?? '')) === fullName(String(b ?? '')),
  };
}

const normCity = (value: string | null | undefined) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cityMatches = (a: string | null | undefined, b: string | null | undefined) => {
  const city = normCity(a);
  return Boolean(city) && city === normCity(b);
};

const looseToken = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** O ERP fatura com o nome do terceiro; o cadastro FRIBOI traz a filial oficial. */
const clientNames = (invoice: BillingInvoice): string[] =>
  [invoice.client, invoice.clientOfficial].filter(
    (name, index, list): name is string => Boolean(name) && list.indexOf(name) === index,
  );

/** A cidade só decide entre lojas quando o nome também tem alguma ligação (FRIG/FRIGORIFICO). */
const sharesClientToken = (invoice: BillingInvoice, deliveryName: string) => {
  const offered = nameTokens(deliveryName);
  return clientNames(invoice).some((client) => {
    const wanted = nameTokens(client);
    return wanted.some((a) => offered.some((b) => looseToken(a, b)));
  });
};

const deliveryItemKg = (delivery: Delivery) => {
  const map = new Map<string, number>();
  for (const product of delivery.products ?? []) {
    const code = String(product.code ?? '').trim();
    const kg = product.kg ?? 0;
    if (!code || !(kg > 0)) continue;
    map.set(code, (map.get(code) ?? 0) + kg);
  }
  return map;
};

const invoiceNetKg = (invoice: BillingInvoice) => {
  const items = invoice.items ?? [];
  if (!items.length) return null;
  let total = 0;
  for (const item of items) total += item.kg ?? 0;
  return total > 0 ? total : null;
};

/**
 * Quanto do peso da nota bate com os produtos da entrega. O peso total da nota no ERP é bruto
 * (com embalagem); o peso por item é o mesmo peso líquido do pedido, então casa exato.
 * Na caixaria o pedido só tem caixas: aí o código do produto é a única prova.
 */
const invoiceItemMatch = (invoice: BillingInvoice, delivery: Delivery) => {
  const items = invoice.items ?? [];
  if (!items.length) return 0;
  const offered = deliveryItemKg(delivery);
  if (!offered.size) {
    const codes = new Set(
      (delivery.products ?? []).map((product) => String(product.code ?? '').trim()).filter(Boolean),
    );
    if (!codes.size) return 0;
    let total = 0;
    let hits = 0;
    for (const item of items) {
      const code = String(item.code ?? '').trim();
      const kg = item.kg ?? 0;
      if (!code || !(kg > 0)) continue;
      total += kg;
      if (codes.has(code)) hits += kg;
    }
    return total > 0 ? hits / total : 0;
  }
  let total = 0;
  let hits = 0;
  for (const item of items) {
    const code = String(item.code ?? '').trim();
    const kg = item.kg ?? 0;
    if (!code || !(kg > 0)) continue;
    total += kg;
    const weight = offered.get(code) ?? 0;
    if (weight > 0 && Math.abs(weight - kg) <= Math.max(1, kg * 0.01)) hits += kg;
  }
  return total > 0 ? hits / total : 0;
};

/**
 * Onde a nota pode encostar. Os itens da nota (produto + peso líquido) mandam; depois o nome
 * aponta a loja e a cidade desempata praças da mesma rede (DUBAIÃO OURICURI x SALGUEIRO).
 * Nota da central (CD QUEIROZ, JL CENTRAL) sem itens não traz loja no nome: fica para o rateio.
 */
const invoiceTargets = (invoice: BillingInvoice, deliveries: Delivery[]): number[] => {
  const itemScores = deliveries.map((delivery) => invoiceItemMatch(invoice, delivery));
  const bestItem = Math.max(0, ...itemScores);
  const itemWinners =
    bestItem >= 0.999
      ? itemScores
          .map((score, index) => ({ score, index }))
          .filter((entry) => entry.score >= 0.999)
          .map((entry) => entry.index)
      : [];
  if (itemWinners.length === 1) return itemWinners;

  const names = clientNames(invoice);
  const matches = deliveries.map((delivery) =>
    names.length
      ? names.reduce(
          (best, name) => {
            const match = clientNameMatch(name, delivery.name);
            const better =
              match.exact !== best.exact
                ? match.exact
                : match.score > best.score ||
                  (match.score === best.score && match.precision > best.precision);
            return better ? match : best;
          },
          { score: 0, precision: 0, exact: false },
        )
      : { score: 0, precision: 0, exact: false },
  );
  const best = Math.max(0, ...matches.map((match) => match.score));
  let named: number[] = [];
  if (best > 0) {
    const winners = deliveries
      .map((_, index) => index)
      // "CENTRAL DIST. REDE MAIS" x "SUP MJ GOIS (REDE MAIS SELECT)": a rede não é a loja,
      // então o nome só aponta uma entrega quando cobre boa parte do nome dela
      .filter((index) => matches[index].score === best && matches[index].precision >= 0.5);
    const exactWinners = winners.filter((index) => matches[index].exact);
    const pool = exactWinners.length ? exactWinners : winners;
    const firstName = pool.length ? deliveries[pool[0]].name.trim().toUpperCase() : '';
    if (!pool.length) {
      named = [];
    } else if (pool.every((index) => deliveries[index].name.trim().toUpperCase() === firstName)) {
      named = pool;
    } else {
      // lojas da mesma rede com nomes diferentes: fica a que o nome cobre por inteiro
      const maxPrecision = Math.max(...pool.map((index) => matches[index].precision));
      const precise = pool.filter((index) => matches[index].precision === maxPrecision);
      if (precise.length === 1) named = precise;
    }
  }
  const sameCity = names.length
    ? deliveries
        .map((_, index) => index)
        .filter(
          (index) =>
            cityMatches(invoice.city, deliveries[index].city) &&
            sharesClientToken(invoice, deliveries[index].name),
        )
    : [];
  let candidates: number[];
  if (named.length) {
    const namedCity = named.some((index) => cityMatches(invoice.city, deliveries[index].city));
    // nome que cobre a entrega inteira é a loja: cidade vazia na planilha não desfaz isso
    const exact = named.length === 1 && matches[named[0]].precision === 1;
    candidates =
      !namedCity && !exact && sameCity.length === 1 && !named.includes(sameCity[0]) ? sameCity : named;
  } else {
    candidates = sameCity.length === 1 ? sameCity : [];
  }
  if (itemWinners.length) {
    const narrowed = candidates.filter((index) => itemWinners.includes(index));
    return narrowed.length ? narrowed : itemWinners;
  }
  return candidates;
};

const closestByWeight = (invoice: BillingInvoice, list: number[], deliveries: Delivery[]) => {
  let best = list[0];
  let bestDiff = Infinity;
  const kg = invoice.kg ?? 0;
  for (const index of list) {
    const weight = deliveries[index].weightKg ?? 0;
    const diff = weight > 0 && kg > 0 ? Math.abs(kg - weight) / Math.max(kg, weight) : 0;
    if (diff < bestDiff) {
      best = index;
      bestDiff = diff;
    }
  }
  return best;
};

/**
 * Liga cada nota ao cliente do pedido. Nome identifica a loja; cidade separa filiais da
 * mesma rede; peso separa a revenda (mesmo peso) e as notas faturadas na central, que não
 * têm loja no nome. Nota sem evidência nenhuma fica sem entrega em vez de cair num cliente
 * qualquer — o resumo do pedido continua mostrando todas.
 */
const invoiceAssignments = (order: Order) => {
  const invoices = order.billing?.invoices ?? [];
  const deliveries = order.deliveries;
  const assigned = new Array<number>(invoices.length).fill(-1);
  if (!invoices.length || !deliveries.length) return assigned;

  const kindOf = (index: number) => invoiceKindOf(invoices[index]);
  const netOf = (index: number) => invoiceNetKg(invoices[index]);
  // o peso líquido dos itens é o mesmo peso da entrega; sem itens, vale o peso bruto da nota
  const kgOf = (index: number) => netOf(index) ?? invoices[index].kg ?? 0;
  const weightOf = (slot: number) => deliveries[slot].weightKg ?? 0;

  // espaço que a venda ainda ocupa em cada entrega: uma entrega pode receber mais de uma nota,
  // mas nunca mais quilos do que a carga que ela leva
  const room = deliveries.map((delivery) => delivery.weightKg ?? 0);
  // entrega que já recebeu uma nota de venda não entra no rateio da central
  const filled = new Set<number>();
  const fits = (index: number, slot: number) => {
    const net = netOf(index);
    if (net == null) return true;
    const capacity = room[slot];
    return !(capacity > 0) || net <= capacity + Math.max(0.5, capacity * 0.002);
  };
  const place = (index: number, slot: number, load = true) => {
    assigned[index] = slot;
    const net = netOf(index);
    if (load && net != null && room[slot] > 0) room[slot] = Math.max(0, room[slot] - net);
    if (load) filled.add(slot);
  };

  // a revenda tem o mesmo peso da venda/devolução que a originou e revela a loja real
  const pair = new Array<number>(invoices.length).fill(-1);
  const paired = new Set<number>();
  const findPair = (index: number, target: InvoiceKind) => {
    let best = -1;
    let bestDiff = Infinity;
    invoices.forEach((candidate, position) => {
      if (invoiceKindOf(candidate) !== target || paired.has(position)) return;
      const diff = Math.abs((invoices[index].kg ?? 0) - (candidate.kg ?? 0));
      if (diff <= Math.max(0.5, (candidate.kg ?? 0) * 0.002) && diff < bestDiff) {
        best = position;
        bestDiff = diff;
      }
    });
    return best;
  };
  invoices.forEach((_, index) => {
    if (kindOf(index) !== 'revenda') return;
    let match = findPair(index, 'venda');
    if (match < 0) match = findPair(index, 'devolucao');
    if (match >= 0) {
      pair[index] = match;
      paired.add(match);
    }
  });

  const targets = invoices.map((invoice) => invoiceTargets(invoice, deliveries));

  // devolução e revenda primeiro: a venda faturada na central pode herdar a loja delas
  invoices.forEach((invoice, index) => {
    if (kindOf(index) === 'venda' || !targets[index].length) return;
    place(index, closestByWeight(invoice, targets[index], deliveries), false);
  });
  invoices.forEach((_, index) => {
    if (kindOf(index) === 'venda' || assigned[index] >= 0) return;
    if (pair[index] >= 0 && assigned[pair[index]] >= 0) place(index, assigned[pair[index]], false);
  });
  invoices.forEach((_, index) => {
    if (kindOf(index) !== 'venda') return;
    const source = pair.findIndex((value) => value === index);
    if (source >= 0 && assigned[source] >= 0) place(index, assigned[source]);
  });

  // nota cujo peso líquido é exatamente o peso de uma entrega: não tem como errar a loja
  invoices.forEach((_, index) => {
    if (kindOf(index) !== 'venda' || assigned[index] >= 0) return;
    const net = netOf(index);
    if (net == null || !(net > 0)) return;
    const exact = deliveries
      .map((_, slot) => slot)
      .filter(
        (slot) =>
          weightOf(slot) > 0 && Math.abs(weightOf(slot) - net) <= Math.max(0.5, net * 0.002),
      );
    if (exact.length === 1) place(index, exact[0]);
  });

  // vendas que o nome/cidade levam a uma loja só (e que cabem na carga dela)
  invoices.forEach((_, index) => {
    if (kindOf(index) !== 'venda' || assigned[index] >= 0 || targets[index].length !== 1) return;
    if (fits(index, targets[index][0])) place(index, targets[index][0]);
  });

  // o mesmo cliente com várias entregas (R A B 2000/2000/1000): maior nota com maior peso
  const groups = new Map<string, { slots: number[]; invoices: number[] }>();
  invoices.forEach((_, index) => {
    if (kindOf(index) !== 'venda' || assigned[index] >= 0 || targets[index].length < 2) return;
    const key = [...targets[index]].sort((a, b) => a - b).join(',');
    const group = groups.get(key) ?? { slots: targets[index], invoices: [] };
    group.invoices.push(index);
    groups.set(key, group);
  });
  for (const group of groups.values()) {
    const list = [...group.invoices].sort((a, b) => kgOf(b) - kgOf(a));
    for (const index of list) {
      const free = group.slots
        .filter((slot) => fits(index, slot))
        .sort((a, b) => Math.abs(room[a] - kgOf(index)) - Math.abs(room[b] - kgOf(index)));
      if (free.length) place(index, free[0]);
    }
  }

  // notas sem loja no nome (central): a maior nota com a maior entrega livre que ainda cabe
  const pending = invoices
    .map((_, index) => index)
    .filter((index) => assigned[index] < 0 && kindOf(index) === 'venda')
    .sort((a, b) => kgOf(b) - kgOf(a));
  const freeDeliveries = deliveries
    .map((_, index) => index)
    .filter((slot) => room[slot] > 0 && !filled.has(slot))
    .sort((a, b) => room[b] - room[a]);
  const hasWeights = deliveries.some((delivery) => (delivery.weightKg ?? 0) > 0);
  if (hasWeights && pending.length === freeDeliveries.length) {
    pending.forEach((index, position) => place(index, freeDeliveries[position]));
  } else if (hasWeights) {
    for (const index of pending) {
      let best = -1;
      let bestDiff = Infinity;
      for (const slot of freeDeliveries) {
        if (filled.has(slot) || !fits(index, slot)) continue;
        const capacity = room[slot];
        const kg = kgOf(index);
        if (!(capacity > 0) || !(kg > 0)) continue;
        const diff = Math.abs(capacity - kg) / Math.max(capacity, kg);
        if (diff < bestDiff) {
          best = slot;
          bestDiff = diff;
        }
      }
      if (best >= 0 && bestDiff <= 0.5) place(index, best);
    }
  }

  // pedido sem pesos (planilha sem total): a ordem das notas acompanha a ordem das entregas
  if (!hasWeights) {
    const rest = invoices
      .map((_, index) => index)
      .filter((index) => assigned[index] < 0 && kindOf(index) === 'venda');
    const used = new Set(assigned.filter((slot) => slot >= 0));
    const slots = deliveries.map((_, index) => index).filter((index) => !used.has(index));
    if (rest.length === slots.length) {
      rest.forEach((index, position) => {
        assigned[index] = slots[position];
      });
    }
  }
  return assigned;
};

/** Notas da entrega, na ordem em que o cliente aparece no pedido. */
export const invoicesForDelivery = (order: Order, delivery: Delivery): BillingInvoice[] => {
  const invoices = order.billing?.invoices ?? [];
  if (!invoices.length) return [];
  const index = order.deliveries.findIndex((item) => item.seq === delivery.seq);
  if (index < 0) return [];
  const assigned = invoiceAssignments(order);
  return invoices.filter((_, position) => assigned[position] === index);
};

export const REFUSAL_REASONS: {
  key: RefusalReason;
  label: string;
  group: string;
}[] = [
  { key: 'falta_peso', label: 'Falta de peso', group: 'Peso e carga' },
  { key: 'falta_pecas', label: 'Falta de peças', group: 'Peso e carga' },
  {
    key: 'falta_peso_peca',
    label: 'Falta de peso e peça',
    group: 'Peso e carga',
  },
  { key: 'sobra_peso', label: 'Sobra de peso', group: 'Peso e carga' },
  { key: 'troca_palete', label: 'Troca de palete', group: 'Peso e carga' },
  { key: 'falta_caixa', label: 'Falta de caixa', group: 'Peso e carga' },
  { key: 'qualidade', label: 'Qualidade', group: 'Produto' },
  { key: 'sem_vacuo', label: 'Mercadoria sem vácuo', group: 'Produto' },
  { key: 'produto_invertido', label: 'Produto invertido', group: 'Produto' },
  { key: 'camera_fria', label: 'Problema na câmara fria', group: 'Produto' },
  { key: 'falha_padrao', label: 'Falha de padrão', group: 'Produto' },
  {
    key: 'erro_faturamento',
    label: 'Erro no faturamento',
    group: 'Fiscal e pedido',
  },
  {
    key: 'desconto_preco',
    label: 'Desconto de preço',
    group: 'Fiscal e pedido',
  },
  {
    key: 'erro_digitacao',
    label: 'Erro de digitação',
    group: 'Fiscal e pedido',
  },
  {
    key: 'erro_envio_pedido',
    label: 'Erro no envio do pedido',
    group: 'Fiscal e pedido',
  },
  {
    key: 'divergencia_pedido',
    label: 'Divergência de pedido',
    group: 'Fiscal e pedido',
  },
  { key: 'cadastro', label: 'Cadastro', group: 'Fiscal e pedido' },
  {
    key: 'atraso_entrega',
    label: 'Atraso de entrega',
    group: 'Entrega e recebimento',
  },
  {
    key: 'sem_espaco_recebimento',
    label: 'Sem espaço para recebimento',
    group: 'Entrega e recebimento',
  },
  { key: 'outro', label: 'Outro', group: 'Outro' },
];

export const REASON_GROUPS: string[] = [...new Set(REFUSAL_REASONS.map((reason) => reason.group))];

export const REASON_LABEL: Record<RefusalReason, string> = Object.fromEntries(
  REFUSAL_REASONS.map((reason) => [reason.key, reason.label]),
) as Record<RefusalReason, string>;

/** Reserva quando o servidor ainda não informou o limite dele. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_ACCEPT = 'image/*,application/pdf,.xls,.xlsx,.doc,.docx,.csv';

export const ATTACHMENT_STATUS_LABEL: Record<AttachmentLocation, string> = {
  fila: 'na fila do servidor',
  no_s: 'na pasta de relatórios',
  erro: 'não gravou',
};

export const isPhoto = (mime: string | null) => /^image\//i.test(String(mime ?? ''));
