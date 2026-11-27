import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';
import { REFUSAL_REASONS } from './reasons.js';

export const STATUSES = ['pendente', 'em_rota', 'no_cliente', 'entregue', 'recusado'];
/** Navegadores com o bundle antigo em cache ainda mandam "recusada" para marcar anomalia. */
export const STATUSES_ACEITOS = [...STATUSES, 'recusada'];
export { REFUSAL_REASONS };

const DELIVERY_COLUMNS = [
  ['scheduled_at', 'TEXT'],
  ['reason', 'TEXT'],
  ['resale', 'INTEGER'],
  ['resale_date', 'TEXT'],
  ['products', 'TEXT'],
  ['observation', 'TEXT'],
  ['lombador', 'INTEGER'],
];

/** Dados que o escritório digita no pedido; a planilha não os traz e não os apaga. */
const ORDER_COLUMNS = [
  ['plates', 'TEXT'],
  ['branch_instruction', 'TEXT'],
  // 1 = preenchido pelo ERP; 0 = editado à mão; NULL = nunca preenchido
  ['plates_auto', 'INTEGER'],
  ['branch_instruction_auto', 'INTEGER'],
];

let db = null;
/** Contador de versão do conteúdo: o app só baixa os pedidos quando ele muda. */
let revision = Date.now();

export const revisionNow = () => revision;
const bump = () => {
  revision = Math.max(Date.now(), revision + 1);
  summaryCache = null;
};

/** Recalculou várias distâncias de uma vez: uma revisão só basta para o app baixar a lista nova. */
export const touchRevision = () => bump();

export function initStore() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      number INTEGER NOT NULL,
      revision TEXT NOT NULL,
      route TEXT NOT NULL,
      ship_date TEXT,
      delivery_date TEXT,
      client TEXT,
      total_kg REAL,
      source_file TEXT,
      source_mtime INTEGER,
      pdf_file TEXT,
      plates TEXT,
      branch_instruction TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      city TEXT,
      uf TEXT,
      weight_kg REAL,
      status TEXT NOT NULL DEFAULT 'pendente',
      note TEXT,
      observation TEXT,
      status_at TEXT,
      scheduled_at TEXT,
      reason TEXT,
      resale INTEGER,
      resale_date TEXT,
      lombador INTEGER,
      PRIMARY KEY (order_id, seq)
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      order_id TEXT,
      error TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS distances (
      a_key TEXT NOT NULL,
      b_key TEXT NOT NULL,
      km REAL NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (a_key, b_key)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(delivery_date);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime TEXT,
      bytes INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'arquivo',
      status TEXT NOT NULL,
      path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_order ON attachments(order_id, seq);

    CREATE TABLE IF NOT EXISTS billing (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      source_file TEXT NOT NULL,
      data TEXT NOT NULL,
      data_date TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (order_id, source_file)
    );

    CREATE INDEX IF NOT EXISTS idx_billing_order ON billing(order_id);
  `);
  const present = new Set(
    db
      .prepare('PRAGMA table_info(deliveries)')
      .all()
      .map((row) => row.name),
  );
  for (const [column, type] of DELIVERY_COLUMNS) {
    if (!present.has(column)) db.exec(`ALTER TABLE deliveries ADD COLUMN ${column} ${type}`);
  }
  const orderPresent = new Set(
    db
      .prepare('PRAGMA table_info(orders)')
      .all()
      .map((row) => row.name),
  );
  for (const [column, type] of ORDER_COLUMNS) {
    if (!orderPresent.has(column)) db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
  }
  // placas/instrução digitadas antes do preenchimento automático são tratadas como manuais
  db.exec(`
    UPDATE orders SET plates_auto = 0
      WHERE plates_auto IS NULL AND plates IS NOT NULL AND TRIM(plates) <> '';
    UPDATE orders SET branch_instruction_auto = 0
      WHERE branch_instruction_auto IS NULL
        AND branch_instruction IS NOT NULL AND TRIM(branch_instruction) <> '';
  `);
  const billingPresent = new Set(
    db
      .prepare('PRAGMA table_info(billing)')
      .all()
      .map((row) => row.name),
  );
  if (!billingPresent.has('data_date')) db.exec('ALTER TABLE billing ADD COLUMN data_date TEXT');
  // versão da leitura do faturamento: relê os arquivos uma vez quando o parser/motor muda
  const matchVersion = db
    .prepare("SELECT value FROM meta WHERE key = 'billing_match_version'")
    .get()?.value;
  if (matchVersion !== '10') {
    db.exec("UPDATE files SET mtime = -1 WHERE kind = 'faturamento'");
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('billing_match_version', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
  }
  // "recusada" era o status de anomalia; agora anomalia é só o motivo, independente do status.
  db.exec(`
    UPDATE deliveries SET status = 'pendente'
      WHERE status IN ('recusada', 'recusado') AND (upper(name) = 'ESC' OR upper(name) LIKE 'ESC %');
    UPDATE deliveries SET status = 'entregue' WHERE status = 'recusada' AND reason IS NOT NULL;
    UPDATE deliveries SET status = 'recusado' WHERE status = 'recusada';
  `);
  return db;
}

const nowISO = () => new Date().toISOString();

const isCanonicalName = (name) => /\(FRIBOI\)\.xlsx$/i.test(String(name ?? ''));

export function upsertOrder(order, meta) {
  const existing = db
    .prepare('SELECT source_file, source_mtime, delivery_date FROM orders WHERE id = ?')
    .get(order.id);

  if (existing?.source_file && existing.source_file !== meta.file) {
    const incoming = [order.deliveryDate ?? '', isCanonicalName(meta.file) ? 1 : 0, meta.mtime];
    const stored = [
      existing.delivery_date ?? '',
      isCanonicalName(existing.source_file) ? 1 : 0,
      existing.source_mtime,
    ];
    const older =
      incoming[0] < stored[0] ||
      (incoming[0] === stored[0] &&
        (incoming[1] < stored[1] || (incoming[1] === stored[1] && incoming[2] < stored[2])));
    if (older) {
      const fill = db.prepare(`
        UPDATE deliveries SET
          city = COALESCE(NULLIF(city, ''), ?),
          uf = COALESCE(NULLIF(uf, ''), ?)
        WHERE order_id = ? AND seq = ?
      `);
      for (const d of order.deliveries) {
        fill.run(d.city ?? '', d.uf ?? '', order.id, d.seq);
      }
      return { action: 'superseded' };
    }
  }

  const upsert = db.prepare(`
    INSERT INTO orders (id, type, number, revision, route, ship_date, delivery_date, client, total_kg, source_file, source_mtime, pdf_file, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      number = excluded.number,
      revision = excluded.revision,
      route = excluded.route,
      ship_date = excluded.ship_date,
      delivery_date = excluded.delivery_date,
      source_file = excluded.source_file,
      source_mtime = excluded.source_mtime,
      updated_at = excluded.updated_at
  `);

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (order_id, seq, name, city, uf, weight_kg, products)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id, seq) DO UPDATE SET
      name = excluded.name,
      city = COALESCE(NULLIF(excluded.city, ''), deliveries.city),
      uf = COALESCE(NULLIF(excluded.uf, ''), deliveries.uf),
      weight_kg = COALESCE(deliveries.weight_kg, excluded.weight_kg),
      products = COALESCE(excluded.products, deliveries.products)
  `);

  const seqs = order.deliveries.map((d) => d.seq);

  db.exec('BEGIN');
  try {
    const current = db
      .prepare('SELECT pdf_file, client, total_kg FROM orders WHERE id = ?')
      .get(order.id);
    upsert.run(
      order.id,
      order.type,
      order.number,
      order.revision,
      order.route,
      order.shipDate,
      order.deliveryDate,
      order.client ?? current?.client ?? null,
      order.totalKg ?? current?.total_kg ?? null,
      meta.file,
      meta.mtime,
      current?.pdf_file ?? null,
      nowISO(),
    );
    db.prepare(
      `DELETE FROM deliveries WHERE order_id = ? AND seq NOT IN (${seqs.map(() => '?').join(',')})`,
    ).run(order.id, ...seqs);
    for (const d of order.deliveries) {
      insertDelivery.run(
        order.id,
        d.seq,
        d.name,
        d.city,
        d.uf,
        d.weightKg ?? null,
        d.items?.length ? JSON.stringify(d.items) : null,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  bump();
  return { action: existing ? 'updated' : 'created' };
}

export function applyPdf(pdf) {
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(pdf.id);
  if (!order) return { action: 'orphan' };

  const updateOrder = db.prepare(`
    UPDATE orders SET
      client = COALESCE(client, ?),
      total_kg = COALESCE(?, total_kg),
      pdf_file = ?
    WHERE id = ?
  `);
  const updateDelivery = db.prepare(`
    UPDATE deliveries SET
      weight_kg = COALESCE(?, weight_kg),
      city = COALESCE(NULLIF(city, ''), ?),
      uf = COALESCE(NULLIF(uf, ''), ?),
      products = COALESCE(products, ?)
    WHERE order_id = ? AND seq = ?
  `);

  db.exec('BEGIN');
  try {
    updateOrder.run(pdf.client, pdf.totalKg, path.basename(pdf.sourceFile), pdf.id);
    for (const d of pdf.deliveries) {
      updateDelivery.run(
        d.weightKg,
        d.city,
        d.uf,
        d.items?.length ? JSON.stringify(d.items) : null,
        pdf.id,
        d.seq,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  bump();
  return { action: 'enriched' };
}

/** A planilha de anotações manda nos produtos: ela é a que o escritório atualiza. */
export function applyProducts(order) {
  const comProduto = order.deliveries.filter((d) => d.items?.length);
  if (!comProduto.length) return { action: 'noop' };
  const existe = db.prepare('SELECT 1 FROM orders WHERE id = ?').get(order.id);
  if (!existe) return { action: 'orphan' };

  const update = db.prepare('UPDATE deliveries SET products = ? WHERE order_id = ? AND seq = ?');
  db.exec('BEGIN');
  try {
    for (const d of comProduto) {
      update.run(JSON.stringify(d.items), order.id, d.seq);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  bump();
  return { action: 'produtos' };
}

const revisionRank = (revision) => Number(String(revision ?? '').replace(/\D/g, '')) || 0;

const NAME_STOP = new Set([
  'ltda',
  'me',
  'epp',
  'sa',
  's',
  'a',
  'filial',
  'matriz',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'com',
  'dist',
  'distribuidora',
  'distribuidor',
  'alimentos',
  'comercial',
  'comercio',
  'industria',
  'cd',
  'atacado',
  'atacadista',
]);

const normName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

const nameTokenCache = new Map();
function nameTokens(name) {
  const key = normName(name);
  const cached = nameTokenCache.get(key);
  if (cached) return cached;
  const tokens = key
    .split(/[^A-Z0-9]+/)
    .filter((token) => token && !NAME_STOP.has(token.toLowerCase()));
  nameTokenCache.set(key, tokens);
  return tokens;
}

const tokenSame = (a, b) =>
  a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

/** Nome do cliente no ERP x nome da entrega na planilha (a planilha costuma trazer o nome maior). */
function nameScore(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  let hits = 0;
  let strong = false;
  const used = new Set();
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
  // nomes curtos (HB, JL) não geram token forte; se os dois nomes reduzem ao mesmo
  // conjunto de tokens, é o mesmo cliente
  if (!strong && ta.length === tb.length && ratio === 1) strong = true;
  return strong && ratio >= 0.6 ? ratio : 0;
}

const isEscName = (name) => /^ESC(\s|$)/i.test(String(name ?? '').trim());

const matchedNames = (names, pool) =>
  names.filter((name) => pool.some((other) => nameScore(name, other) > 0));

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/** Instrução de pedido com osso, mesmo quando o número ainda não foi importado. */
const PCS_INSTRUCTION_RE = /\b(BITRUCK|BI-TRUCK|CARRETA)\b|Pedido\s+HAJAN\s+P[ÇC]S/i;

/**
 * O código da instrução filial (207211) é o mesmo INST da planilha semanal (207.211).
 * O nome descritivo do ERP não entra no acompanhamento: fica só o número.
 */
function instructionTextOf(billing) {
  const digits = String(billing?.instructionCode ?? '').replace(/\D/g, '');
  return digits.length > 3 ? `${digits.slice(0, -3)}.${digits.slice(-3)}` : null;
}

/**
 * O faturamento de caixaria não traz o número do pedido: a instrução é casada pelo conjunto de
 * clientes da carga e pelas datas de entrega/embarque. Entregas ESC não entram na conta porque
 * não são faturadas.
 */
function cxsOrderIndex() {
  const rows = db
    .prepare(
      `SELECT o.id, o.number, o.route, o.revision, o.ship_date, o.delivery_date, d.name
         FROM orders o LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE o.type = 'CXS'`,
    )
    .all();
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.number}\u0000${row.route}`;
    const group = groups.get(key) ?? {
      key,
      ids: [],
      names: new Set(),
      shipDate: null,
      deliveryDate: null,
      revisionRank: 0,
    };
    if (!group.ids.includes(row.id)) group.ids.push(row.id);
    group.revisionRank = Math.max(group.revisionRank, revisionRank(row.revision));
    group.shipDate = group.shipDate ?? row.ship_date;
    group.deliveryDate = group.deliveryDate ?? row.delivery_date;
    if (row.name && !isEscName(row.name)) group.names.add(row.name);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.names.size);
}

/** Melhor pedido de caixaria para uma instrução do ERP; só aceita quando todos os clientes batem. */
function cxsTargetFor(group, candidates) {
  const billing = group.billing;
  const names = [...new Set(billing.clients ?? [])].filter(Boolean);
  if (!names.length) return null;
  const dates = billing.deliveryDates ?? [];
  const ships = billing.shipDates ?? [];
  let best = null;
  for (const candidate of candidates) {
    const pool = [...candidate.names];
    const groupHits = matchedNames(names, pool);
    if (groupHits.length / names.length < 0.999) continue;
    const orderCoverage = matchedNames(pool, names).length / pool.length;
    if (orderCoverage < 0.5) continue;
    let days = Infinity;
    for (const date of dates) {
      if (candidate.deliveryDate) days = Math.min(days, dayDiff(date, candidate.deliveryDate));
    }
    for (const date of ships) {
      if (candidate.shipDate) days = Math.min(days, dayDiff(date, candidate.shipDate));
    }
    if (!Number.isFinite(days)) continue;
    const limit = names.length === 1 || pool.length === 1 ? 3 : 7;
    if (days > limit) continue;
    const routeHit = Boolean(group.company) && group.company === candidate.route;
    if (
      !best ||
      orderCoverage > best.orderCoverage ||
      (orderCoverage === best.orderCoverage &&
        (days < best.days || (days === best.days && routeHit && !best.routeHit)))
    ) {
      best = { ...candidate, orderCoverage, days };
    }
  }
  return best;
}

/**
 * O faturamento é por instrução (caminhão) e traz o número do pedido Hajan no texto.
 * Quando o número existe em mais de uma rota, a rota que aparece na instrução desempata;
 * revisões do mesmo caminhão recebem o mesmo faturamento.
 */
function billingTargetsFor(group, byNumber) {
  if (!group.planNumber) return [];
  const candidates = byNumber.get(group.planNumber) ?? [];
  if (!candidates.length) return [];
  let route =
    group.route && candidates.some((order) => order.route === group.route) ? group.route : null;
  if (!route) {
    const routes = [...new Set(candidates.map((order) => order.route))];
    if (routes.length === 1) route = routes[0];
    else route = (candidates.find((order) => order.total_kg != null) ?? candidates[0]).route;
  }
  return candidates
    .filter((order) => order.route === route)
    .sort((a, b) => revisionRank(b.revision) - revisionRank(a.revision));
}

const WEIGHT_MATCH_TOLERANCE = 0.03;

/**
 * Instrução do ERP sem número de pedido (ex.: "BITRUCK 31/10 TCM HAJAN"): casa pela
 * empresa de entrega, peso faturado, data e clientes. Só devolve quando um pedido é
 * claramente o melhor; empate entre números diferentes fica sem vínculo.
 */
function weightTargetFor(group, orders, namesById, countById, claimed) {
  const billing = group.billing;
  const company = String(group.company ?? '').trim().toUpperCase();
  const pcsStyle = PCS_INSTRUCTION_RE.test(billing.instruction ?? '');
  const dates = [...(billing.deliveryDates ?? []), ...(billing.shipDates ?? [])];
  const clients = [...new Set(billing.clients ?? [])].filter(Boolean);
  const candidates = [];
  for (const order of orders) {
    if (claimed.has(order.id)) continue;
    if (order.type !== 'CXS' && order.type !== 'PCS') continue;
    if ((order.type === 'PCS') !== pcsStyle) continue;
    if (company && order.route.toUpperCase() !== company) continue;
    if (!(order.total_kg > 0)) continue;
    const diff = Math.abs(billing.kg - order.total_kg) / Math.max(billing.kg, order.total_kg);
    if (diff > WEIGHT_MATCH_TOLERANCE) continue;
    const pool = namesById.get(order.id) ?? [];
    const coverage = clients.length
      ? matchedNames(clients, pool).length / clients.length
      : 0;
    const countMatch =
      billing.invoices.length > 0 && billing.invoices.length === (countById.get(order.id) ?? 0);
    if (coverage < 0.999 && !countMatch) continue;
    let days = Infinity;
    for (const date of dates) {
      for (const target of [order.delivery_date, order.ship_date]) {
        if (target) days = Math.min(days, dayDiff(date, target));
      }
    }
    // sem todos os clientes batendo, a data precisa ser bem próxima
    if (!(days <= (countMatch ? 10 : 2))) continue;
    const score = coverage * 1000 + (countMatch ? 100 : 0) - diff * 100 - Math.min(days, 30) * 10;
    candidates.push({ order, diff, days, coverage, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.diff - b.diff || a.days - b.days);
  const best = candidates[0];
  const rival = candidates.find((item) => item.order.number !== best.order.number);
  // empate técnico entre pedidos diferentes (cargas gêmeas): não escolhe nenhum
  if (rival && Math.abs(rival.score - best.score) < 1) return null;
  const ids = orders
    .filter((order) => order.number === best.order.number && order.route === best.order.route)
    .sort((a, b) => revisionRank(b.revision) - revisionRank(a.revision))
    .map((order) => order.id);
  return { ids, number: best.order.number, score: best.score };
}

const ZERO_BILLING_DAYS = 10;

/**
 * Último recurso: o pedido ainda não tem nenhuma venda faturada e a instrução lista só parte
 * dos clientes da carga (ou o nome sai diferente). Exige rota, data a até 10 dias e ao menos
 * um cliente em comum — a carga inteira não precisa bater.
 */
function zeroBillingTargetFor(group, orders, namesById, claimed, soldElsewhere) {
  const billing = group.billing;
  const company = String(group.company ?? '').trim().toUpperCase();
  const pcsStyle = PCS_INSTRUCTION_RE.test(billing.instruction ?? '');
  const dates = [...(billing.deliveryDates ?? []), ...(billing.shipDates ?? [])];
  const clients = [...new Set(billing.clients ?? [])].filter(Boolean);
  if (!company || !dates.length || !clients.length) return null;
  const candidates = [];
  for (const order of orders) {
    if (claimed.has(order.id)) continue;
    if (order.type !== 'CXS' && order.type !== 'PCS') continue;
    if ((order.type === 'PCS') !== pcsStyle) continue;
    if (order.route.toUpperCase() !== company) continue;
    if (soldElsewhere.has(`${order.type}\u0000${order.number}\u0000${order.route}`)) continue;
    const pool = namesById.get(order.id) ?? [];
    const hits = matchedNames(clients, pool).length;
    if (!hits) continue;
    let days = Infinity;
    for (const date of dates) {
      for (const target of [order.delivery_date, order.ship_date]) {
        if (target) days = Math.min(days, dayDiff(date, target));
      }
    }
    if (!(days <= ZERO_BILLING_DAYS)) continue;
    const coverage = hits / clients.length;
    const score = coverage * 1000 - Math.min(days, 30) * 10;
    candidates.push({ order, days, coverage, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.days - b.days);
  const best = candidates[0];
  const rival = candidates.find((item) => item.order.number !== best.order.number);
  // empate entre pedidos diferentes: não arrisca
  if (rival && Math.abs(rival.score - best.score) < 1) return null;
  const ids = orders
    .filter((order) => order.number === best.order.number && order.route === best.order.route)
    .map((order) => order.id);
  return { ids, number: best.order.number, score: best.score };
}

/** Pedidos de caixaria/com osso pelos clientes das entregas, para achar a origem de uma devolução. */
function returnOrderIndex() {
  const rows = db
    .prepare(
      `SELECT o.id, o.type, o.number, o.route, o.delivery_date, d.name
         FROM orders o JOIN deliveries d ON d.order_id = o.id
        WHERE o.type IN ('CXS', 'PCS')`,
    )
    .all();
  const groups = new Map();
  for (const row of rows) {
    if (!row.name || isEscName(row.name)) continue;
    const key = `${row.type}\u0000${row.number}\u0000${row.route}`;
    const group = groups.get(key) ?? { ids: [], names: new Set(), deliveryDate: null };
    if (!group.ids.includes(row.id)) group.ids.push(row.id);
    group.names.add(row.name);
    if (row.delivery_date && (!group.deliveryDate || row.delivery_date > group.deliveryDate)) {
      group.deliveryDate = row.delivery_date;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Devolução/revenda não traz o número do pedido: a origem é o pedido mais recente entregue
 * ao cliente que devolveu (até 60 dias antes da nota). O comprador da revenda não casa.
 */
function returnTargetsFor(group, candidates) {
  const billing = group.billing;
  const hasReturnClients = Boolean(billing.returnClients?.length);
  const source = hasReturnClients ? billing.returnClients : (billing.clients ?? []);
  const names = [...new Set(source)].filter(Boolean);
  // sem o cliente que devolveu, o comprador da revenda pode parecer com outro cliente:
  // só aceita quando o nome bate quase inteiro
  const minScore = hasReturnClients ? 0.6 : 0.8;
  const ids = new Set();
  for (const name of names) {
    let best = null;
    for (const candidate of candidates) {
      let score = 0;
      for (const other of candidate.names) score = Math.max(score, nameScore(name, other));
      if (score < minScore) continue;
      let days = 0;
      if (billing.billedAt && candidate.deliveryDate) {
        if (Date.parse(candidate.deliveryDate) > Date.parse(billing.billedAt) + 3 * 86400000) {
          continue;
        }
        days = dayDiff(candidate.deliveryDate, billing.billedAt);
        if (days > 60) continue;
      }
      if (!best || score > best.score || (score === best.score && days < best.days)) {
        best = { candidate, score, days };
      }
    }
    if (best) best.candidate.ids.forEach((id) => ids.add(id));
  }
  return [...ids];
}

/**
 * Junta faturamentos do mesmo pedido. Entre arquivos mensais os totais se repetem (cada
 * exportação já traz o pedido inteiro), então vale o maior. Dentro de um arquivo, instruções
 * diferentes são caminhões diferentes do mesmo pedido e precisam somar.
 */
function mergeBillings(list, { combine = 'max' } = {}) {
  if (list.length === 1) return list[0];
  const pick = (total, value) => (combine === 'sum' ? total + value : Math.max(total, value));
  const invoices = new Map();
  const plates = new Set();
  const merged = {
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
    erpOrders: new Set(),
    clients: new Set(),
    cities: new Set(),
  };
  let instructionSource = null;
  // pedido só com devolução/revenda: usa o código da instrução do ERP mesmo assim
  let returnSource = null;
  for (const billing of list) {
    merged.status = merged.status ?? billing.status;
    merged.deliveryStatus = merged.deliveryStatus ?? billing.deliveryStatus;
    merged.billedAt = [merged.billedAt, billing.billedAt].filter(Boolean).sort().pop() ?? null;
    merged.shipAt = [merged.shipAt, billing.shipAt].filter(Boolean).sort().pop() ?? null;
    merged.deliveryAt = [merged.deliveryAt, billing.deliveryAt].filter(Boolean).sort().pop() ?? null;
    // cada exportação mensal repete o total do pedido; somar duplicaria peso, valor e notas
    merged.kg = pick(merged.kg, billing.kg ?? 0);
    merged.value = pick(merged.value, billing.value ?? 0);
    merged.rows = pick(merged.rows, billing.rows ?? 0);
    merged.hasSales = merged.hasSales || Boolean(billing.hasSales);
    merged.hasReturns = merged.hasReturns || Boolean(billing.hasReturns);
    for (const plate of billing.plates ?? []) plates.add(plate);
    for (const invoice of billing.invoices) {
      const key = `${invoice.number}\u0000${invoice.series ?? ''}`;
      const current = invoices.get(key) ?? {
        number: invoice.number,
        series: invoice.series,
        date: invoice.date,
        client: invoice.client ?? null,
        clientCode: invoice.clientCode ?? null,
        clientOfficial: invoice.clientOfficial ?? null,
        city: invoice.city ?? null,
        kind: 'venda',
        kg: 0,
        value: 0,
      };
      if (
        invoice.kind === 'devolucao' ||
        (invoice.kind === 'revenda' && current.kind === 'venda')
      ) {
        current.kind = invoice.kind;
      }
      if (invoice.date && (!current.date || invoice.date > current.date)) current.date = invoice.date;
      if (!current.client && invoice.client) current.client = invoice.client;
      if (!current.clientCode && invoice.clientCode) {
        current.clientCode = invoice.clientCode;
        current.clientOfficial = invoice.clientOfficial ?? null;
      }
      if (!current.city && invoice.city) current.city = invoice.city;
      // os itens dizem a qual entrega a nota pertence: guarda o detalhamento mais completo
      if ((invoice.items?.length ?? 0) > (current.items?.length ?? 0)) current.items = invoice.items;
      // mesma nota repetida nas exportações: fica o maior valor, nunca a soma
      current.kg = Math.max(current.kg, invoice.kg ?? 0);
      current.value = Math.max(current.value, invoice.value ?? 0);
      invoices.set(key, current);
    }
    billing.erpOrders.forEach((value) => merged.erpOrders.add(value));
    billing.clients.forEach((value) => merged.clients.add(value));
    billing.cities.forEach((value) => merged.cities.add(value));
    // instrução de devolução ("DEVOLUÇÃO COM REVENDA") não é a instrução filial do pedido
    if (billing.instruction) {
      if (billing.hasSales !== false) {
        if (!instructionSource || billing.kg > instructionSource.kg) instructionSource = billing;
      } else if (!returnSource || billing.kg > returnSource.kg) {
        returnSource = billing;
      }
    }
  }
  const source = instructionSource ?? returnSource;
  return {
    ...merged,
    kg: Math.round(merged.kg * 1000) / 1000,
    value: Math.round(merged.value * 100) / 100,
    invoices: [...invoices.values()]
      .map((invoice) => ({
        ...invoice,
        kg: Math.round(invoice.kg * 1000) / 1000,
        value: Math.round(invoice.value * 100) / 100,
      }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.number.localeCompare(b.number)),
    erpOrders: [...merged.erpOrders].filter(Boolean),
    clients: [...merged.clients].filter(Boolean),
    cities: [...merged.cities].filter(Boolean),
    plates: [...plates].filter(Boolean).sort(),
    instruction: source?.instruction ?? null,
    instructionCode: source?.instructionCode ?? null,
  };
}

/** Grava o resumo do faturamento por pedido, sem tocar no status das entregas. */
export function applyBilling(sourceFile, parsed) {
  const orders = db
    .prepare(
      'SELECT id, type, number, revision, route, total_kg, ship_date, delivery_date FROM orders',
    )
    .all();
  const byNumber = new Map();
  for (const order of orders) {
    if (order.type !== 'PCS') continue;
    if (!byNumber.has(order.number)) byNumber.set(order.number, []);
    byNumber.get(order.number).push(order);
  }
  const cxsOrders = cxsOrderIndex();
  const returnOrders = parsed.groups.some((group) => group.billing.hasReturns)
    ? returnOrderIndex()
    : [];
  const namesById = new Map();
  const countById = new Map();
  for (const row of db.prepare('SELECT order_id, name FROM deliveries').all()) {
    if (row.name) {
      const list = namesById.get(row.order_id) ?? [];
      list.push(row.name);
      namesById.set(row.order_id, list);
      if (!isEscName(row.name)) {
        countById.set(row.order_id, (countById.get(row.order_id) ?? 0) + 1);
      }
    }
  }

  // pedido com venda já faturada por outro arquivo fica fora da exceção de último recurso
  const soldElsewhere = new Set();
  for (const row of db
    .prepare(
      `SELECT o.type, o.number, o.route, b.data
         FROM billing b JOIN orders o ON o.id = b.order_id
        WHERE b.source_file <> ?`,
    )
    .all(sourceFile)) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data?.hasSales && (data.kg ?? 0) > 0) {
      soldElsewhere.add(`${row.type}\u0000${row.number}\u0000${row.route}`);
    }
  }

  const byOrder = new Map();
  const claimed = new Set();
  // devolução/revenda não ocupa o pedido: a venda da mesma carga ainda pode ser vinculada
  const sold = new Set();
  const add = (ids, billing) => {
    for (const orderId of ids) {
      claimed.add(orderId);
      if (billing.hasSales) sold.add(orderId);
      const list = byOrder.get(orderId) ?? [];
      list.push(billing);
      byOrder.set(orderId, list);
    }
  };

  let unmatched = 0;
  let unmatchedRows = 0;
  let matchedRows = 0;
  const fallback = [];
  for (const group of parsed.groups) {
    let targets = [];
    let pending = false;
    if (group.planNumber) {
      targets = billingTargetsFor(group, byNumber).map((order) => order.id);
    } else if (PCS_INSTRUCTION_RE.test(group.billing.instruction ?? '')) {
      targets = [];
      pending = Boolean(group.billing.hasSales) && group.billing.kg > 0;
    } else {
      const target = cxsTargetFor(group, cxsOrders);
      targets = target ? target.ids : [];
      pending = !targets.length && Boolean(group.billing.hasSales) && group.billing.kg > 0;
    }
    if (!targets.length && group.billing.hasReturns) {
      targets = returnTargetsFor(group, returnOrders);
      pending = false;
    }
    if (targets.length) {
      matchedRows += group.rows;
      add(targets, group.billing);
    } else if (pending) {
      fallback.push(group);
    } else {
      unmatched += 1;
      unmatchedRows += group.rows;
    }
  }

  // instruções sem número de pedido: casa pelo peso/rota/data/clientes, sempre depois
  // dos vínculos seguros, e resolve disputa pelo mesmo pedido pela maior pontuação
  const proposals = [];
  for (const group of fallback) {
    const target = weightTargetFor(group, orders, namesById, countById, claimed);
    if (target) proposals.push({ group, target });
  }
  proposals.sort((a, b) => b.target.score - a.target.score);
  const used = new Set();
  for (const { group, target } of proposals) {
    if (target.ids.some((orderId) => claimed.has(orderId))) continue;
    used.add(group);
    matchedRows += group.rows;
    add(target.ids, group.billing);
  }
  // último recurso: pedido que ainda não tem nenhuma venda faturada recebe a instrução mesmo
  // quando o ERP lista só parte dos clientes dele
  const orphans = [];
  for (const group of fallback) {
    if (used.has(group)) continue;
    const target = zeroBillingTargetFor(group, orders, namesById, sold, soldElsewhere);
    if (target) orphans.push({ group, target });
  }
  orphans.sort((a, b) => b.target.score - a.target.score);
  for (const { group, target } of orphans) {
    if (target.ids.some((orderId) => sold.has(orderId))) continue;
    used.add(group);
    matchedRows += group.rows;
    add(target.ids, group.billing);
  }
  for (const group of fallback) {
    if (used.has(group)) continue;
    unmatched += 1;
    unmatchedRows += group.rows;
  }

  const existing = new Map(
    db
      .prepare('SELECT order_id, data, data_date FROM billing WHERE source_file = ?')
      .all(sourceFile)
      .map((row) => [row.order_id, { data: row.data, dataDate: row.data_date }]),
  );
  const upsert = db.prepare(`
    INSERT INTO billing (order_id, source_file, data, data_date, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(order_id, source_file) DO UPDATE SET
      data = excluded.data, data_date = excluded.data_date, updated_at = excluded.updated_at
  `);

  let changed = false;
  const updatedAt = nowISO();
  const dataDate = parsed.dataDate ?? null;
  db.exec('BEGIN');
  try {
    for (const [orderId, list] of byOrder) {
      const data = JSON.stringify(mergeBillings(list, { combine: 'sum' }));
      const current = existing.get(orderId);
      if (current && current.data === data && current.dataDate === dataDate) continue;
      upsert.run(orderId, sourceFile, data, dataDate, updatedAt);
      changed = true;
    }
    const keep = [...byOrder.keys()];
    const removed = keep.length
      ? db
          .prepare(
            `DELETE FROM billing WHERE source_file = ? AND order_id NOT IN (${keep.map(() => '?').join(',')})`,
          )
          .run(sourceFile, ...keep)
      : db.prepare('DELETE FROM billing WHERE source_file = ?').run(sourceFile);
    if (removed.changes) changed = true;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (changed) bump();
  return {
    rows: parsed.rows,
    orders: byOrder.size,
    matchedRows,
    unmatched,
    unmatchedRows,
  };
}

export function clearBillingSource(sourceFile) {
  const result = db.prepare('DELETE FROM billing WHERE source_file = ?').run(sourceFile);
  if (result.changes) bump();
  return result.changes;
}

export function billingTargets() {
  return {
    knownNumbers: new Set(
      db
        .prepare("SELECT DISTINCT number FROM orders WHERE type = 'PCS'")
        .all()
        .map((row) => row.number),
    ),
    knownRoutes: new Set(
      db
        .prepare('SELECT DISTINCT route FROM orders')
        .all()
        .map((row) => row.route),
    ),
  };
}

export function knownBillingFiles() {
  return db.prepare("SELECT path FROM files WHERE kind = 'faturamento'").all();
}

function mapDelivery(d) {
  return {
    seq: d.seq,
    name: d.name,
    city: d.city,
    uf: d.uf,
    weightKg: d.weight_kg,
    products: parseProducts(d.products),
    status: d.status,
    note: d.note,
    observation: d.observation,
    statusAt: d.status_at,
    scheduledAt: d.scheduled_at,
    reason: d.reason,
    resale: d.resale == null ? null : Boolean(d.resale),
    resaleDate: d.resale_date,
    lombador: d.lombador == null ? null : Boolean(d.lombador),
  };
}

function mapAttachment(row) {
  return {
    id: row.id,
    seq: row.seq,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    kind: row.kind,
    status: row.status,
    path: row.path,
    createdAt: row.created_at,
  };
}

function mapBilling(row) {
  if (!row) return null;
  try {
    return { ...JSON.parse(row.data), sourceFile: row.source_file, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

function mapOrder(row, deliveries, attachments = [], billing = null) {
  const bySeq = new Map();
  for (const item of attachments) {
    if (!bySeq.has(item.seq)) bySeq.set(item.seq, []);
    bySeq.get(item.seq).push(mapAttachment(item));
  }
  const list = deliveries.map(mapDelivery);
  for (const delivery of list) delivery.attachments = bySeq.get(delivery.seq) ?? [];
  return {
    id: row.id,
    type: row.type,
    number: row.number,
    revision: row.revision,
    route: row.route,
    shipDate: row.ship_date,
    deliveryDate: row.delivery_date,
    client: row.client,
    totalKg: row.total_kg,
    sourceFile: row.source_file,
    pdfFile: row.pdf_file,
    plates: row.plates ?? null,
    branchInstruction: row.branch_instruction ?? null,
    billing: billing ?? null,
    updatedAt: row.updated_at,
    deliveries: list,
  };
}

/**
 * Um pedido pode ter faturamento em vários arquivos (um por mês): junta todos, senão a
 * instrução filial e as notas do mês anterior ficam de fora.
 */
const billingByOrderFromRows = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.order_id) ?? [];
    list.push(mapBilling(row));
    groups.set(row.order_id, list);
  }
  const map = new Map();
  for (const [orderId, list] of groups) {
    const merged = mergeBillings(list);
    map.set(orderId, {
      ...merged,
      sourceFile: merged.sourceFile ?? list[0].sourceFile,
      updatedAt: merged.updatedAt ?? list[0].updatedAt,
    });
  }
  return map;
};

const billingOf = (orderIds) => {
  if (!orderIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM billing WHERE order_id IN (${orderIds.map(() => '?').join(',')})
        ORDER BY data_date DESC, updated_at DESC`,
    )
    .all(...orderIds);
  return billingByOrderFromRows(rows);
};

/**
 * Placas e instrução filial vindas do ERP. Só preenche campos vazios ou que já são automáticos:
 * o que o escritório digitou à mão nunca é sobrescrito e volta a aparecer se o faturamento sumir.
 */
export function refreshAutoFields() {
  const billingRows = db
    .prepare('SELECT * FROM billing ORDER BY data_date DESC, updated_at DESC')
    .all();
  const billingByOrder = billingByOrderFromRows(billingRows);
  const orders = db
    .prepare(
      `SELECT id, plates, plates_auto, branch_instruction, branch_instruction_auto FROM orders`,
    )
    .all();
  const update = db.prepare(`
    UPDATE orders SET plates = ?, plates_auto = ?, branch_instruction = ?, branch_instruction_auto = ?
    WHERE id = ?
  `);

  let changed = false;
  db.exec('BEGIN');
  try {
    for (const order of orders) {
      const billing = billingByOrder.get(order.id);
      const desiredPlates = billing?.plates?.length ? billing.plates.join(', ') : null;
      const desiredInstruction = instructionTextOf(billing);

      let plates = order.plates;
      let platesAuto = order.plates_auto;
      if (platesAuto !== 0) {
        if (desiredPlates) {
          if (plates !== desiredPlates) {
            plates = desiredPlates;
            changed = true;
          }
          platesAuto = 1;
        } else if (platesAuto === 1) {
          if (plates !== null) {
            plates = null;
            changed = true;
          }
          platesAuto = null;
        }
      }

      let instruction = order.branch_instruction;
      let instructionAuto = order.branch_instruction_auto;
      if (instructionAuto !== 0) {
        if (desiredInstruction) {
          if (instruction !== desiredInstruction) {
            instruction = desiredInstruction;
            changed = true;
          }
          instructionAuto = 1;
        } else if (instructionAuto === 1) {
          if (instruction !== null) {
            instruction = null;
            changed = true;
          }
          instructionAuto = null;
        }
      }

      if (
        plates !== order.plates ||
        platesAuto !== order.plates_auto ||
        instruction !== order.branch_instruction ||
        instructionAuto !== order.branch_instruction_auto
      ) {
        update.run(plates, platesAuto, instruction, instructionAuto, order.id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (changed) bump();
  return changed;
}

const attachmentsOf = (orderIds) => {
  if (!orderIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM attachments WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
    )
    .all(...orderIds);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
    grouped.get(row.order_id).push(row);
  }
  return grouped;
};

export function listOrders({ from, to } = {}) {
  const conditions = [];
  const params = [];
  if (from) {
    conditions.push('delivery_date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('delivery_date <= ?');
    params.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orders = db
    .prepare(`SELECT * FROM orders ${where} ORDER BY delivery_date ASC, type ASC, number ASC`)
    .all(...params);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const rows = db
    .prepare(
      `SELECT * FROM deliveries WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq ASC`,
    )
    .all(...ids);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
    grouped.get(row.order_id).push(row);
  }
  const attachments = attachmentsOf(ids);
  const billing = billingOf(ids);
  return orders.map((order) =>
    mapOrder(
      order,
      grouped.get(order.id) ?? [],
      attachments.get(order.id) ?? [],
      billing.get(order.id) ?? null,
    ),
  );
}

export function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!row) return null;
  const deliveries = db
    .prepare('SELECT * FROM deliveries WHERE order_id = ? ORDER BY seq ASC')
    .all(id);
  return mapOrder(
    row,
    deliveries,
    attachmentsOf([id]).get(id) ?? [],
    billingOf([id]).get(id) ?? null,
  );
}

/** Só as paradas, em ordem de rota: o cálculo de distâncias não precisa do resto do pedido. */
export function deliveryLegs() {
  return db
    .prepare(
      `SELECT d.order_id, d.seq, d.city, d.uf
         FROM deliveries d JOIN orders o ON o.id = d.order_id
        ORDER BY o.delivery_date ASC, d.order_id ASC, d.seq ASC`,
    )
    .all();
}

/** Pedido e entrega no mínimo necessário para montar o caminho da pasta da semana. */
export function getDeliveryForPath(orderId, seq) {
  const row = db
    .prepare(
      `SELECT o.id, o.type, o.number, o.route, o.delivery_date AS deliveryDate,
              o.ship_date AS shipDate, d.seq, d.name, d.city, d.uf,
              d.scheduled_at AS scheduledAt
         FROM orders o JOIN deliveries d ON d.order_id = o.id
        WHERE o.id = ? AND d.seq = ?`,
    )
    .get(orderId, seq);
  if (!row) return null;
  const { id, type, number, route, deliveryDate, shipDate, ...delivery } = row;
  return {
    order: { id, type, number, route, deliveryDate, shipDate },
    delivery,
  };
}

export function updateDelivery(orderId, seq, patch) {
  const alvo = db
    .prepare('SELECT name, reason FROM deliveries WHERE order_id = ? AND seq = ?')
    .get(orderId, seq);
  if (!alvo) return null;

  // bundle antigo usava "recusada" para anomalia: vira entregue quando existe motivo
  const status =
    patch.status === 'recusada'
      ? (patch.reason ?? alvo.reason)
        ? 'entregue'
        : 'recusado'
      : patch.status;

  // Cliente ESC: o escritório só acompanha o status, sem anomalia, observação ou agendamento.
  const restrito = semControle(alvo.name);
  if (restrito && !['pendente', 'em_rota', 'no_cliente', 'entregue'].includes(patch.status))
    return null;
  if (
    restrito &&
    [
      patch.note,
      patch.observation,
      patch.scheduledAt,
      patch.reason,
      patch.resale,
      patch.resaleDate,
      patch.lombador,
    ].some((value) => value !== undefined)
  )
    return null;

  const sets = [];
  const values = [];
  const set = (column, value) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (status !== undefined) {
    set('status', status);
    set('status_at', nowISO());
  }
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.observation !== undefined) set('observation', patch.observation);
  if (patch.scheduledAt !== undefined) set('scheduled_at', patch.scheduledAt);
  if (patch.reason !== undefined) set('reason', patch.reason);
  if (patch.resale !== undefined) set('resale', patch.resale == null ? null : patch.resale ? 1 : 0);
  if (patch.resaleDate !== undefined) set('resale_date', patch.resaleDate);
  if (patch.lombador !== undefined)
    set('lombador', patch.lombador == null ? null : patch.lombador ? 1 : 0);
  if (!sets.length) return null;

  const result = db
    .prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE order_id = ? AND seq = ?`)
    .run(...values, orderId, seq);
  if (result.changes === 0) return null;
  bump();

  let advanced = null;
  if (!restrito && (status === 'entregue' || status === 'recusado')) {
    const next = db
      .prepare(
        "SELECT seq FROM deliveries WHERE order_id = ? AND seq > ? AND status = 'pendente' AND NOT (upper(name) = 'ESC' OR upper(name) LIKE 'ESC %') ORDER BY seq ASC LIMIT 1",
      )
      .get(orderId, seq);
    if (next) {
      db.prepare(
        'UPDATE deliveries SET status = ?, status_at = ? WHERE order_id = ? AND seq = ?',
      ).run('em_rota', nowISO(), orderId, next.seq);
      advanced = next.seq;
    }
  }

  const row = db
    .prepare('SELECT * FROM deliveries WHERE order_id = ? AND seq = ?')
    .get(orderId, seq);
  return { ...mapDelivery(row), orderId, advanced };
}

/** Placas e instrução da filial: digitadas no app, mantidas quando a planilha é reimportada. */
export function updateOrderFields(orderId, patch) {
  const clean = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
  };
  const sets = [];
  const values = [];
  if (patch.plates !== undefined) {
    sets.push('plates = ?', 'plates_auto = 0');
    values.push(clean(patch.plates));
  }
  if (patch.branchInstruction !== undefined) {
    sets.push('branch_instruction = ?', 'branch_instruction_auto = 0');
    values.push(clean(patch.branchInstruction));
  }
  if (!sets.length) return null;
  const result = db
    .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, orderId);
  if (result.changes === 0) return null;
  bump();
  const row = db
    .prepare('SELECT id, plates, branch_instruction FROM orders WHERE id = ?')
    .get(orderId);
  return { id: row.id, plates: row.plates, branchInstruction: row.branch_instruction };
}

export function getFile(filePath) {
  return db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) ?? null;
}
export function recordFile({ path: filePath, kind, mtime, size, orderId = null, error = null }) {
  db.prepare(
    `
    INSERT INTO files (path, kind, mtime, size, order_id, error, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      kind = excluded.kind, mtime = excluded.mtime, size = excluded.size,
      order_id = excluded.order_id, error = excluded.error, imported_at = excluded.imported_at
  `,
  ).run(filePath, kind, mtime, size, orderId, error, nowISO());
}

export function forgetFile(filePath) {
  db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
}

export function knownFileKeys() {
  return db.prepare('SELECT path, mtime, size, kind FROM files').all();
}

export function unresolvedPdfs() {
  return db.prepare("SELECT * FROM files WHERE kind = 'pdf' AND order_id IS NULL").all();
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

const SPEED_DEFAULT = 55;
const STOP_MIN_DEFAULT = 90;

export function getEtaSettings() {
  const speedRaw = getMeta('eta_speed_kmh');
  const stopRaw = getMeta('eta_stop_min');
  const speed = speedRaw == null ? NaN : Number(speedRaw);
  const stop = stopRaw == null ? NaN : Number(stopRaw);
  return {
    speedKmh: Number.isFinite(speed) && speed >= 20 && speed <= 120 ? speed : SPEED_DEFAULT,
    stopMinutes: Number.isFinite(stop) && stop >= 0 && stop <= 480 ? stop : STOP_MIN_DEFAULT,
  };
}

export function setEtaSettings({ speedKmh, stopMinutes }) {
  setMeta('eta_speed_kmh', speedKmh);
  setMeta('eta_stop_min', stopMinutes);
  bump();
  return getEtaSettings();
}

let summaryCache = null;

export function summary() {
  if (summaryCache) return summaryCache;
  const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const deliveries = db
    .prepare('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status')
    .all();
  const dates = db
    .prepare(
      'SELECT delivery_date, COUNT(*) AS n FROM orders WHERE delivery_date IS NOT NULL GROUP BY delivery_date ORDER BY delivery_date DESC LIMIT 14',
    )
    .all();
  const files = db
    .prepare(
      'SELECT status, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM attachments GROUP BY status',
    )
    .all();
  const count = (status) => {
    const row = files.find((item) => item.status === status);
    return { files: row?.n ?? 0, bytes: row?.bytes ?? 0 };
  };
  summaryCache = {
    orders,
    deliveries: Object.fromEntries(deliveries.map((r) => [r.status, r.n])),
    recentDates: dates.map((r) => ({ date: r.delivery_date, orders: r.n })),
    attachmentSummary: { noS: count('no_s'), naFila: count('fila') },
  };
  return summaryCache;
}

export function getDistance(aKey, bKey) {
  return allDistances().get(`${aKey}\u0000${bKey}`) ?? null;
}

let distanceCache = null;

/** Distâncias são poucas e mudam raramente: uma leitura serve todas as previsões. */
export function allDistances() {
  if (!distanceCache) {
    distanceCache = new Map();
    for (const row of db
      .prepare('SELECT a_key, b_key, km, source, updated_at FROM distances')
      .all()) {
      distanceCache.set(`${row.a_key}\u0000${row.b_key}`, {
        km: row.km,
        source: row.source,
        updated_at: row.updated_at,
      });
    }
  }
  return distanceCache;
}

export function setDistance(aKey, bKey, km, source) {
  const updatedAt = nowISO();
  db.prepare(
    `
    INSERT INTO distances (a_key, b_key, km, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(a_key, b_key) DO UPDATE SET
      km = excluded.km, source = excluded.source, updated_at = excluded.updated_at
  `,
  ).run(aKey, bKey, km, source, updatedAt);
  allDistances().set(`${aKey}\u0000${bKey}`, { km, source, updated_at: updatedAt });
}

export function distanceStats() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM distances WHERE source = 'rota'").get();
  return { road: row.n };
}

export function lastErrors(limit = 15) {
  return db
    .prepare(
      'SELECT path, kind, error, imported_at FROM files WHERE error IS NOT NULL ORDER BY imported_at DESC LIMIT ?',
    )
    .all(limit);
}

export function addAttachment({
  id,
  orderId,
  seq,
  name,
  mime,
  bytes,
  kind = 'arquivo',
  status,
  path: stored,
}) {
  db.prepare(
    `INSERT INTO attachments (id, order_id, seq, name, mime, bytes, kind, status, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orderId, seq, name, mime ?? null, bytes, kind, status, stored ?? null, nowISO());
  bump();
  return getAttachment(id);
}

export function getAttachment(id) {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  return row ? { ...mapAttachment(row), orderId: row.order_id } : null;
}

export function setAttachmentLocation(id, patch) {
  const fields = {};
  if (patch.status !== undefined) fields.status = patch.status;
  if (patch.path !== undefined) fields.path = patch.path ?? null;
  if (patch.bytes !== undefined) fields.bytes = patch.bytes;
  if (patch.name !== undefined) fields.name = patch.name;
  const columns = Object.keys(fields);
  if (!columns.length) return;
  db.prepare(
    `UPDATE attachments SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  ).run(...columns.map((c) => fields[c]), id);
  bump();
}

export function deleteAttachmentRow(id) {
  const removed = db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes > 0;
  if (removed) bump();
  return removed;
}

/** Anexos já gravados na pasta de relatórios, com o caminho para conferir se ainda existem. */
export function attachmentsOnNetwork() {
  return db
    .prepare("SELECT id, path FROM attachments WHERE status = 'no_s' AND path IS NOT NULL")
    .all();
}

/** Vários arquivos apagados de uma vez na pasta: uma transação e uma revisão só. */
export function deleteAttachmentRows(ids) {
  if (!ids.length) return 0;
  let removed = 0;
  db.exec('BEGIN');
  try {
    const stmt = db.prepare('DELETE FROM attachments WHERE id = ?');
    for (const id of ids) removed += stmt.run(id).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (removed) bump();
  return removed;
}

export function pendingAttachments() {
  return db
    .prepare("SELECT * FROM attachments WHERE status = 'fila' ORDER BY created_at ASC")
    .all()
    .map((row) => ({ ...mapAttachment(row), orderId: row.order_id }));
}

export function summaryAttachment(orderId, seq) {
  const row = db
    .prepare(
      "SELECT * FROM attachments WHERE order_id = ? AND seq = ? AND kind = 'resumo' ORDER BY created_at DESC LIMIT 1",
    )
    .get(orderId, seq);
  return row ? { ...mapAttachment(row), orderId } : null;
}
export function hasOrder(id) {
  return Boolean(db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id));
}

const PRODUTO_RE = /^ESC(\s|$)/i;

/** Clientes ESC: o escritorio so acompanha o status, sem anomalia nem observacao. */
export function semControle(name) {
  return PRODUTO_RE.test(String(name ?? '').trim());
}

function parseProducts(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
