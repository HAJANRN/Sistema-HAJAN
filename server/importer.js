import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { PDF_DIRS, POLL_INTERVAL, XLSX_DIRS } from './config.js';
import { parseOrderXlsx } from './parsers/orderXlsx.js';
import { parseOrderPdf } from './parsers/orderPdf.js';
import {
  applyPdf,
  forgetFile,
  getFile,
  getMeta,
  knownFileKeys,
  recordFile,
  setMeta,
  upsertOrder,
} from './store.js';

const state = {
  scanning: false,
  lastScanAt: null,
  lastScanMs: null,
  imported: 0,
  skipped: 0,
  errors: 0,
};

const orphanPdfs = new Map();
const pendingTimers = new Map();

const fileSize = (stat) => stat.size;
const fileMtime = (stat) => Math.floor(stat.mtimeMs);

const ORDER_XLSX_RE = /Pedido\s+HAJAN\s+(?:CXS|P[ÇC]S)\b/i;

const isOrderFileName = (name, kind) => {
  if (name.startsWith('~$') || name.startsWith('.')) return false;
  return kind === 'xlsx'
    ? /\.xlsx$/i.test(name) && ORDER_XLSX_RE.test(name)
    : /\.pdf$/i.test(name) && /pedido|hajan/i.test(name);
};

function listOrderFiles(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && isOrderFileName(entry.name, kind))
    .map((entry) => path.join(dir, entry.name));
}

function retryOrphanPdfs(orderId) {
  for (const [file, info] of orphanPdfs) {
    if (info.orderId !== orderId) continue;
    orphanPdfs.delete(file);
    ingestFile(file, 'pdf', { force: true }).catch(() => {});
  }
}

export async function ingestFile(file, kind, { force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    forgetFile(file);
    return 'skipped';
  }
  const mtime = fileMtime(stat);
  const size = fileSize(stat);
  const cached = getFile(file);
  if (!force && cached && cached.mtime === mtime && cached.size === size) return 'skipped';

  if (kind === 'xlsx') {
    const parsed = parseOrderXlsx(file);
    if (!parsed.ok) {
      recordFile({ path: file, kind, mtime, size, error: parsed.reason });
      return 'error';
    }
    const result = upsertOrder(parsed, { file: path.basename(file), mtime });
    recordFile({
      path: file,
      kind,
      mtime,
      size,
      orderId: result.action === 'superseded' ? null : parsed.id,
    });
    retryOrphanPdfs(parsed.id);
    return result.action === 'superseded' ? 'skipped' : 'imported';
  }

  const parsed = await parseOrderPdf(file);
  if (!parsed.ok) {
    orphanPdfs.delete(file);
    recordFile({ path: file, kind, mtime, size, error: parsed.reason });
    return 'error';
  }
  const result = applyPdf(parsed);
  if (result.action === 'orphan') {
    forgetFile(file);
    orphanPdfs.set(file, {
      orderId: parsed.id,
      reason: 'PDF lido, aguardando a planilha do pedido na pasta da rede',
      at: new Date().toISOString(),
    });
    return 'skipped';
  }
  orphanPdfs.delete(file);
  recordFile({ path: file, kind, mtime, size, orderId: parsed.id });
  return 'imported';
}

export function scheduleIngest(file, kind) {
  if (!isOrderFileName(path.basename(file), kind)) return;
  const key = `${kind}:${file}`;
  if (pendingTimers.has(key)) clearTimeout(pendingTimers.get(key));
  pendingTimers.set(
    key,
    setTimeout(async () => {
      pendingTimers.delete(key);
      try {
        const result = await ingestFile(file, kind);
        if (result === 'imported') state.imported += 1;
      } catch (error) {
        recordFile({
          path: file,
          kind,
          mtime: 0,
          size: 0,
          error: error.message,
        });
      }
    }, 1200),
  );
}

export async function scanAll({ force = false } = {}) {
  if (state.scanning) return getScanState();
  state.scanning = true;
  const started = Date.now();
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const files = [
    ...XLSX_DIRS.flatMap((dir) =>
      listOrderFiles(dir, 'xlsx').map((file) => ({ file, kind: 'xlsx' })),
    ),
    ...PDF_DIRS.flatMap((dir) => listOrderFiles(dir, 'pdf').map((file) => ({ file, kind: 'pdf' }))),
  ];

  for (const item of files) {
    try {
      const result = await ingestFile(item.file, item.kind, { force });
      if (result === 'imported') imported += 1;
      else if (result === 'error') errors += 1;
      else skipped += 1;
    } catch (error) {
      errors += 1;
      recordFile({
        path: item.file,
        kind: item.kind,
        mtime: 0,
        size: 0,
        error: error.message,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const roots = [...XLSX_DIRS, ...PDF_DIRS].map((dir) => path.resolve(dir).toLowerCase());
  for (const { path: tracked } of knownFileKeys()) {
    const resolved = path.resolve(tracked);
    const name = path.basename(resolved);
    const kind = /\.pdf$/i.test(name) ? 'pdf' : 'xlsx';
    const insideWatched = roots.some((root) =>
      resolved.toLowerCase().startsWith(`${root}${path.sep}`),
    );
    if (!insideWatched || !isOrderFileName(name, kind)) forgetFile(tracked);
  }

  state.scanning = false;
  state.lastScanAt = new Date().toISOString();
  state.lastScanMs = Date.now() - started;
  state.imported = imported;
  state.skipped = skipped;
  state.errors = errors;
  setMeta('lastScanAt', state.lastScanAt);
  return getScanState();
}

function dirsReport() {
  return [
    ...XLSX_DIRS.map((dir) => ({ dir, kind: 'xlsx' })),
    ...PDF_DIRS.map((dir) => ({ dir, kind: 'pdf' })),
  ].map(({ dir, kind }) => {
    const exists = fs.existsSync(dir);
    return {
      dir,
      kind,
      exists,
      files: exists ? listOrderFiles(dir, kind).length : 0,
    };
  });
}

export function getScanState() {
  return {
    scanning: state.scanning,
    lastScanAt: state.lastScanAt ?? getMeta('lastScanAt'),
    lastScanMs: state.lastScanMs,
    lastScan: {
      imported: state.imported,
      skipped: state.skipped,
      errors: state.errors,
    },
    dirs: dirsReport(),
    orphanPdfs: [...orphanPdfs.entries()].map(([file, info]) => ({
      file,
      ...info,
    })),
  };
}

export function startWatch() {
  const dirs = [
    ...XLSX_DIRS.map((dir) => ({ dir, kind: 'xlsx' })),
    ...PDF_DIRS.map((dir) => ({ dir, kind: 'pdf' })),
  ];
  for (const { dir, kind } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const root = path.resolve(dir);
    const watcher = chokidar.watch(dir, {
      depth: 0,
      ignoreInitial: true,
      usePolling: true,
      interval: POLL_INTERVAL,
      binaryInterval: POLL_INTERVAL,
      awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 1500 },
      ignored: (candidate) => {
        const resolved = path.resolve(candidate);
        if (resolved === root) return false;
        return !isOrderFileName(path.basename(resolved), kind);
      },
    });
    watcher.on('add', (file) => scheduleIngest(file, kind));
    watcher.on('change', (file) => scheduleIngest(file, kind));
    watcher.on('unlink', (file) => forgetFile(file));
    watcher.on('error', () => {});
  }
}
