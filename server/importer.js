import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { PDF_DIRS, POLL_INTERVAL, XLSX_DIRS } from './config.js';
import { isChqFileName, isSpgFileName, orderIdFromName, parseOrderXlsx } from './parsers/orderXlsx.js';
import { parseOrderPdf } from './parsers/orderPdf.js';
import {
  applyPdf,
  applyProducts,
  forgetFile,
  getFile,
  getMeta,
  hasOrder,
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

/** A pasta de PDFs tem milhares de arquivos: olhar de minuto em minuto já basta. */
const PDF_POLL_MS = Math.max(60000, POLL_INTERVAL * 4);
const DIRS_CACHE_MS = 15000;
const YIELD_EVERY = 50;

let dirsCache = null;
let dirsCacheAt = 0;
const watchers = new Map();

const ORDER_XLSX_RE = /Pedido\s+HAJAN\s+(?:CXS|P[ÇC]S)\b/i;

const isOrderFileName = (name, kind) => {
  if (name.startsWith('~$') || name.startsWith('.')) return false;
  if (kind === 'xlsx') {
    return (
      /\.xlsx$/i.test(name) &&
      (ORDER_XLSX_RE.test(name) || isChqFileName(name) || isSpgFileName(name))
    );
  }
  return /\.pdf$/i.test(name) && /pedido|hajan/i.test(name);
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
  // a pasta da rede tem milhares de PDFs; só abrimos os que batem com um pedido já importado
  if (kind === 'pdf') {
    const esperado = orderIdFromName(file);
    if (!esperado || !hasOrder(esperado)) return 'skipped';
  }

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
    applyProducts(parsed);
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

  try {
    const files = [
      ...XLSX_DIRS.flatMap((dir) =>
        listOrderFiles(dir, 'xlsx').map((file) => ({ file, kind: 'xlsx' })),
      ),
      ...PDF_DIRS.flatMap((dir) =>
        listOrderFiles(dir, 'pdf').map((file) => ({ file, kind: 'pdf' })),
      ),
    ];

    let processed = 0;
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
      processed += 1;
      if (processed % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    }

    const roots = [...XLSX_DIRS, ...PDF_DIRS].map((dir) => path.resolve(dir).toLowerCase());
    for (const { path: tracked, kind: trackedKind } of knownFileKeys()) {
      // o faturamento tem a própria pasta e o próprio controle de arquivos
      if (trackedKind === 'faturamento') continue;
      const resolved = path.resolve(tracked);
      const name = path.basename(resolved);
      const kind = /\.pdf$/i.test(name) ? 'pdf' : 'xlsx';
      const insideWatched = roots.some((root) =>
        resolved.toLowerCase().startsWith(`${root}${path.sep}`),
      );
      if (!insideWatched || !isOrderFileName(name, kind)) forgetFile(tracked);
    }
  } finally {
    state.scanning = false;
    state.lastScanAt = new Date().toISOString();
    state.lastScanMs = Date.now() - started;
    state.imported = imported;
    state.skipped = skipped;
    state.errors = errors;
    setMeta('lastScanAt', state.lastScanAt);
    dirsCache = null;
  }

  // a rede pode ter voltado depois do início do programa: completa os watchers que faltam
  startWatch();
  return getScanState();
}

function dirsReport() {
  if (dirsCache && Date.now() - dirsCacheAt < DIRS_CACHE_MS) return dirsCache;
  dirsCache = [
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
  dirsCacheAt = Date.now();
  return dirsCache;
}

export function getScanState() {
  if (state.lastScanAt == null) state.lastScanAt = getMeta('lastScanAt');
  return {
    scanning: state.scanning,
    lastScanAt: state.lastScanAt,
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
    if (watchers.has(dir) || !fs.existsSync(dir)) continue;
    const root = path.resolve(dir);
    const interval = kind === 'pdf' ? PDF_POLL_MS : POLL_INTERVAL;
    const watcher = chokidar.watch(dir, {
      depth: 0,
      ignoreInitial: true,
      usePolling: true,
      interval,
      binaryInterval: interval,
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
    watchers.set(dir, watcher);
  }
}
