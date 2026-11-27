import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { FATURAMENTO_DIRS, POLL_INTERVAL } from './config.js';
import { isFaturamentoFileName, parseFaturamentoFile } from './parsers/faturamento.js';
import {
  applyBilling,
  billingTargets,
  clearBillingSource,
  forgetFile,
  getFile,
  getMeta,
  knownBillingFiles,
  recordFile,
  refreshAutoFields,
  setMeta,
} from './store.js';

const state = {
  syncing: false,
  lastSyncAt: null,
  lastSyncMs: null,
  lastSync: {
    files: 0,
    rows: 0,
    orders: 0,
    matchedRows: 0,
    unmatched: 0,
    unmatchedRows: 0,
    errors: 0,
  },
  errors: [],
};

let hydrated = false;
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  state.lastSyncAt = getMeta('billingLastSyncAt');
  const saved = getMeta('billingLastSync');
  if (saved) {
    try {
      state.lastSync = { ...state.lastSync, ...JSON.parse(saved) };
    } catch {
      // conteúdo antigo/inválido: começa do zero
    }
  }
}

function listBillingFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isFaturamentoFileName(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** Devolve null quando o arquivo não mudou; senão o resumo da importação. */
function syncFile(file, force) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    forgetFile(file);
    return null;
  }
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;
  const cached = getFile(file);
  if (
    !force &&
    cached &&
    cached.kind === 'faturamento' &&
    cached.mtime === mtime &&
    cached.size === size
  ) {
    return null;
  }

  const parsed = parseFaturamentoFile(file, billingTargets());
  if (!parsed.ok) {
    recordFile({ path: file, kind: 'faturamento', mtime, size, error: parsed.reason });
    return { error: parsed.reason };
  }
  const result = applyBilling(path.basename(file), parsed);
  recordFile({ path: file, kind: 'faturamento', mtime, size, error: null });
  return result;
}

let running = null;

/** Lê os arquivos de faturamento que mudaram e atualiza os pedidos. */
export function syncBilling({ force = false } = {}) {
  if (!running) {
    running = doSync({ force }).finally(() => {
      running = null;
    });
  }
  return running;
}

async function doSync({ force }) {
  hydrate();
  state.syncing = true;
  const started = Date.now();
  const totals = {
    files: 0,
    rows: 0,
    orders: 0,
    matchedRows: 0,
    unmatched: 0,
    unmatchedRows: 0,
    errors: 0,
  };
  const seen = new Set();
  let parsedAny = false;
  let clearedAny = false;

  try {
    for (const dir of FATURAMENTO_DIRS) {
      for (const file of listBillingFiles(dir)) {
        seen.add(path.resolve(file).toLowerCase());
        try {
          const result = syncFile(file, force);
          if (!result) continue;
          parsedAny = true;
          totals.files += 1;
          if (result.error) {
            totals.errors += 1;
            state.errors = [
              { file, error: result.error, at: new Date().toISOString() },
              ...state.errors,
            ].slice(0, 8);
            continue;
          }
          totals.rows += result.rows;
          totals.orders += result.orders;
          totals.matchedRows += result.matchedRows;
          totals.unmatched += result.unmatched;
          totals.unmatchedRows += result.unmatchedRows;
        } catch (error) {
          parsedAny = true;
          totals.errors += 1;
          state.errors = [
            { file, error: error.message, at: new Date().toISOString() },
            ...state.errors,
          ].slice(0, 8);
          recordFile({
            path: file,
            kind: 'faturamento',
            mtime: 0,
            size: 0,
            error: error.message,
          });
        }
      }
    }

    // arquivo removido da pasta: o faturamento que veio dele sai dos pedidos
    for (const tracked of knownBillingFiles()) {
      if (seen.has(path.resolve(tracked.path).toLowerCase())) continue;
      if (clearBillingSource(path.basename(tracked.path))) clearedAny = true;
      forgetFile(tracked.path);
    }

    if (parsedAny || clearedAny) refreshAutoFields();

    if (parsedAny) {
      state.lastSync = totals;
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncMs = Date.now() - started;
      setMeta('billingLastSyncAt', state.lastSyncAt);
      setMeta('billingLastSync', JSON.stringify(totals));
    }
  } finally {
    state.syncing = false;
  }
  return getBillingState();
}

export function getBillingState() {
  hydrate();
  return {
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastSyncMs: state.lastSyncMs,
    lastSync: state.lastSync,
    errors: state.errors,
    dirs: FATURAMENTO_DIRS.map((dir) => {
      const exists = fs.existsSync(dir);
      return {
        dir,
        kind: 'faturamento',
        exists,
        files: exists ? listBillingFiles(dir).length : 0,
      };
    }),
  };
}

let timer = null;
function scheduleSync() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncBilling().catch(() => {});
  }, 2000);
}

const watchers = new Map();

export function startBillingWatch() {
  for (const dir of FATURAMENTO_DIRS) {
    if (watchers.has(dir) || !fs.existsSync(dir)) continue;
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
        return !isFaturamentoFileName(path.basename(resolved));
      },
    });
    watcher.on('add', () => scheduleSync());
    watcher.on('change', () => scheduleSync());
    watcher.on('unlink', () => scheduleSync());
    watcher.on('error', () => {});
    watchers.set(dir, watcher);
  }
}
