import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';
import { REFUSAL_REASONS } from './reasons.js';

export const STATUSES = ['pendente', 'em_rota', 'entregue', 'recusada'];
export { REFUSAL_REASONS };

const DELIVERY_COLUMNS = [
  ['scheduled_at', 'TEXT'],
  ['reason', 'TEXT'],
  ['resale', 'INTEGER'],
  ['resale_date', 'TEXT'],
];

let db = null;

export function initStore() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

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
      status_at TEXT,
      scheduled_at TEXT,
      reason TEXT,
      resale INTEGER,
      resale_date TEXT,
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
    INSERT INTO deliveries (order_id, seq, name, city, uf, weight_kg)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id, seq) DO UPDATE SET
      name = excluded.name,
      city = COALESCE(NULLIF(excluded.city, ''), deliveries.city),
      uf = COALESCE(NULLIF(excluded.uf, ''), deliveries.uf),
      weight_kg = COALESCE(deliveries.weight_kg, excluded.weight_kg)
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
      insertDelivery.run(order.id, d.seq, d.name, d.city, d.uf, d.weightKg ?? null);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
      uf = COALESCE(NULLIF(uf, ''), ?)
    WHERE order_id = ? AND seq = ?
  `);

  db.exec('BEGIN');
  try {
    updateOrder.run(pdf.client, pdf.totalKg, path.basename(pdf.sourceFile), pdf.id);
    for (const d of pdf.deliveries) {
      updateDelivery.run(d.weightKg, d.city, d.uf, pdf.id, d.seq);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { action: 'enriched' };
}

function mapDelivery(d) {
  return {
    seq: d.seq,
    name: d.name,
    city: d.city,
    uf: d.uf,
    weightKg: d.weight_kg,
    status: d.status,
    note: d.note,
    statusAt: d.status_at,
    scheduledAt: d.scheduled_at,
    reason: d.reason,
    resale: d.resale == null ? null : Boolean(d.resale),
    resaleDate: d.resale_date,
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

function mapOrder(row, deliveries, attachments = []) {
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
    updatedAt: row.updated_at,
    deliveries: list,
  };
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
  return orders.map((order) =>
    mapOrder(order, grouped.get(order.id) ?? [], attachments.get(order.id) ?? []),
  );
}

export function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!row) return null;
  const deliveries = db
    .prepare('SELECT * FROM deliveries WHERE order_id = ? ORDER BY seq ASC')
    .all(id);
  return mapOrder(row, deliveries, attachmentsOf([id]).get(id) ?? []);
}

export function updateDelivery(orderId, seq, patch) {
  const sets = [];
  const values = [];
  const set = (column, value) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.status !== undefined) {
    set('status', patch.status);
    set('status_at', nowISO());
    if (patch.status !== 'recusada') {
      if (patch.reason === undefined) set('reason', null);
      if (patch.resale === undefined) set('resale', null);
      if (patch.resaleDate === undefined) set('resale_date', null);
      if (patch.note === undefined) set('note', null);
    }
  }
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.scheduledAt !== undefined) set('scheduled_at', patch.scheduledAt);
  if (patch.reason !== undefined) set('reason', patch.reason);
  if (patch.resale !== undefined) set('resale', patch.resale == null ? null : patch.resale ? 1 : 0);
  if (patch.resaleDate !== undefined) set('resale_date', patch.resaleDate);
  if (!sets.length) return null;

  const result = db
    .prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE order_id = ? AND seq = ?`)
    .run(...values, orderId, seq);
  if (result.changes === 0) return null;

  let advanced = null;
  if (patch.status === 'entregue' || patch.status === 'recusada') {
    const next = db
      .prepare(
        "SELECT seq FROM deliveries WHERE order_id = ? AND seq > ? AND status = 'pendente' ORDER BY seq ASC LIMIT 1",
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
  return db.prepare('SELECT path, mtime, size FROM files').all();
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
  return getEtaSettings();
}

export function summary() {
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
  return {
    orders,
    deliveries: Object.fromEntries(deliveries.map((r) => [r.status, r.n])),
    recentDates: dates.map((r) => ({ date: r.delivery_date, orders: r.n })),
    attachmentSummary: { noS: count('no_s'), naFila: count('fila') },
  };
}

export function getDistance(aKey, bKey) {
  return (
    db
      .prepare('SELECT km, source, updated_at FROM distances WHERE a_key = ? AND b_key = ?')
      .get(aKey, bKey) ?? null
  );
}

export function setDistance(aKey, bKey, km, source) {
  db.prepare(
    `
    INSERT INTO distances (a_key, b_key, km, source, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(a_key, b_key) DO UPDATE SET
      km = excluded.km, source = excluded.source, updated_at = excluded.updated_at
  `,
  ).run(aKey, bKey, km, source, nowISO());
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
