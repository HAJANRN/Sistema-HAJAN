import { api } from './api';
import { db } from './db';
import {
  FINAL_STATUSES,
  type Delivery,
  type DeliveryPatch,
  type DeliveryStatus,
  type Order,
  type OutboxEntry,
  type Papel,
} from './types';
import { shiftISO, todayISO } from './utils';

export interface SyncState {
  online: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  pendingFiles: number;
  role: Papel;
  senhaDefinida: boolean;
}

const RANGE_BACK_DAYS = 45;
const RANGE_FORWARD_DAYS = 90;
const POLL_MS = 30_000;
/** Limite do lado do navegador; o servidor confirma o dele em /api/status. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  pendingFiles: 0,
  role: 'operacao',
  senhaDefinida: false,
};

const listeners = new Set<() => void>();

function emit(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribeSync(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const syncSnapshot = () => state;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'falha desconhecida';

async function overlayPending() {
  const entries = await db.outbox.toArray();
  for (const entry of entries) {
    const order = await db.orders.get(entry.orderId);
    if (!order) continue;
    await db.orders.put({
      ...order,
      pendingSync: true,
      deliveries: order.deliveries.map((d) =>
        d.seq === entry.seq ? { ...d, ...deliveryPatch(entry) } : d,
      ),
    });
  }
}

const deliveryPatch = (entry: OutboxEntry): DeliveryPatch => {
  const patch: DeliveryPatch = {};
  if (entry.status !== undefined) patch.status = entry.status;
  if (entry.note !== undefined) patch.note = entry.note;
  if (entry.scheduledAt !== undefined) patch.scheduledAt = entry.scheduledAt;
  if (entry.reason !== undefined) patch.reason = entry.reason;
  if (entry.resale !== undefined) patch.resale = entry.resale;
  if (entry.resaleDate !== undefined) patch.resaleDate = entry.resaleDate;
  return patch;
};

/** Importação, ajustes e servidor pedem a senha do escritório; marcar entregas não pede. */
export const administrador = () => state.role === 'administracao';

let flushing = false;

async function flushOutbox(): Promise<boolean> {
  if (flushing) return true;
  flushing = true;
  try {
    const entries = await db.outbox.orderBy('id').toArray();
    for (const entry of entries) {
      try {
        await api.setDeliveryStatus(entry.orderId, entry.seq, deliveryPatch(entry));
      } catch (error) {
        const message = errorMessage(error);
        const permanent = message.includes('(404)') || message.includes('não encontrada');
        if (!permanent) {
          emit({
            online: false,
            lastError: message,
            pending: await db.outbox.count(),
          });
          return false;
        }
      }
      await db.outbox.delete(entry.id!);
      const remaining = await db.outbox.where('orderId').equals(entry.orderId).count();
      if (remaining === 0) {
        const order = await db.orders.get(entry.orderId);
        if (order?.pendingSync) await db.orders.put({ ...order, pendingSync: false });
      }
    }
    emit({ pending: await db.outbox.count() });
    return true;
  } finally {
    flushing = false;
  }
}

/** Guarda o arquivo no navegador e devolve o erro de tamanho, quando houver. */
export async function queueAttachmentFile(
  orderId: string,
  seq: number,
  file: File,
): Promise<string | null> {
  if (!file.size) return `${file.name} está vazio`;
  if (file.size > MAX_FILE_BYTES)
    return `${file.name} passa de ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB`;
  await db.files.add({
    orderId,
    seq,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: file.size,
    blob: file,
    queuedAt: new Date().toISOString(),
    error: null,
  });
  emit({ pendingFiles: await db.files.count() });
  void flushFiles();
  return null;
}

export async function removeQueuedFile(id: number) {
  await db.files.delete(id);
  emit({ pendingFiles: await db.files.count() });
}

let flushingFiles = false;

/** Tenta enviar tudo o que ainda está no navegador; devolve os pedidos afetados. */
async function flushFiles(): Promise<string[]> {
  if (flushingFiles) return [];
  flushingFiles = true;
  const sent: string[] = [];
  try {
    for (const job of await db.files.orderBy('queuedAt').toArray()) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) break;
      try {
        await api.uploadAttachment(job);
        await db.files.delete(job.id!);
        sent.push(job.orderId);
      } catch (error) {
        const message = errorMessage(error);
        const unreachable =
          error instanceof TypeError || /falha no envio \((5\d\d)\)/.test(message);
        if (unreachable) break;
        await db.files.update(job.id!, { error: message });
      }
    }
    return sent;
  } finally {
    flushingFiles = false;
    emit({ pendingFiles: await db.files.count() });
  }
}

export async function syncNow() {
  if (state.syncing) return;
  emit({ syncing: true });
  const today = todayISO();
  const from = shiftISO(today, -RANGE_BACK_DAYS);
  const to = shiftISO(today, RANGE_FORWARD_DAYS);

  try {
    const { role, senhaDefinida } = await api.session();
    await db.meta.put({ key: 'role', value: role });
    if (role !== state.role || senhaDefinida !== state.senhaDefinida) emit({ role, senhaDefinida });

    const flushed = await flushOutbox();
    if (!flushed) throw new Error(state.lastError ?? 'servidor indisponível');

    const sentFiles = await flushFiles();
    if (sentFiles.length)
      await Promise.all([...new Set(sentFiles)].map((orderId) => refreshOrder(orderId)));

    const { orders } = await api.orders(from, to);
    const remoteIds = new Set(orders.map((order) => order.id));

    await db.transaction('rw', db.orders, async () => {
      const local = await db.orders
        .where('deliveryDate')
        .between(from, to, true, true)
        .primaryKeys();
      const stale = local.filter((id) => !remoteIds.has(id));
      if (stale.length) await db.orders.bulkDelete(stale);
      await db.orders.bulkPut(orders);
    });
    await overlayPending();

    const at = new Date().toISOString();
    await db.meta.put({ key: 'lastSyncAt', value: at });
    emit({
      online: true,
      syncing: false,
      lastSyncAt: at,
      lastError: null,
      pending: await db.outbox.count(),
    });
  } catch (error) {
    emit({
      online: false,
      syncing: false,
      lastError: errorMessage(error),
      pending: await db.outbox.count(),
    });
  }
}

export async function patchDelivery(order: Order, seq: number, patch: DeliveryPatch) {
  const at = new Date().toISOString();
  const deliveries = order.deliveries.map((d) => {
    if (d.seq !== seq) return d;
    const merged: Delivery = {
      ...d,
      ...patch,
      statusAt: patch.status ? at : d.statusAt,
    };
    if (patch.status && patch.status !== 'recusada') {
      merged.reason = patch.reason ?? null;
      merged.resale = patch.resale ?? null;
      merged.resaleDate = patch.resaleDate ?? null;
      merged.note = patch.note ?? null;
    }
    return merged;
  });

  const advanced =
    patch.status && FINAL_STATUSES.includes(patch.status)
      ? (deliveries
          .filter((d) => d.seq > seq && d.status === 'pendente')
          .sort((a, b) => a.seq - b.seq)[0]?.seq ?? null)
      : null;
  if (advanced != null) {
    const index = deliveries.findIndex((d) => d.seq === advanced);
    deliveries[index] = {
      ...deliveries[index],
      status: 'em_rota',
      statusAt: at,
    };
  }

  await db.orders.put({ ...order, pendingSync: true, deliveries });

  const entries: OutboxEntry[] = [{ orderId: order.id, seq, ...patch, queuedAt: at }];
  if (advanced != null)
    entries.push({
      orderId: order.id,
      seq: advanced,
      status: 'em_rota',
      queuedAt: at,
    });
  for (const entry of entries) {
    await db.outbox.filter((e) => e.orderId === order.id && e.seq === entry.seq).delete();
    await db.outbox.add(entry);
  }

  emit({ pending: await db.outbox.count() });
  const flushed = await flushOutbox();
  if (flushed) await refreshOrder(order.id);
}

async function refreshOrder(orderId: string) {
  if (await db.outbox.where('orderId').equals(orderId).count()) return;
  try {
    const fresh = await api.order(orderId);
    const local = await db.orders.get(orderId);
    await db.orders.put({ ...fresh, pendingSync: local?.pendingSync ?? false });
  } catch {
    // a próxima sincronização traz as previsões recalculadas
  }
}

export async function setDeliveryStatus(order: Order, seq: number, status: DeliveryStatus) {
  await patchDelivery(order, seq, { status });
}

export async function setAllDeliveries(order: Order, status: DeliveryStatus) {
  const at = new Date().toISOString();
  await db.orders.put({
    ...order,
    pendingSync: true,
    deliveries: order.deliveries.map((d) => ({ ...d, status, statusAt: at })),
  });
  await db.outbox.filter((entry) => entry.orderId === order.id).delete();
  for (const delivery of order.deliveries) {
    await db.outbox.add({
      orderId: order.id,
      seq: delivery.seq,
      status,
      queuedAt: at,
    });
  }
  emit({ pending: await db.outbox.count() });
  await flushOutbox();
}

/** Entra na área administrativa; o servidor é quem decide se a senha valeu. */
export async function entrar(senha: string) {
  const { role } = await api.entrar(senha);
  await db.meta.put({ key: 'role', value: role });
  emit({ role, senhaDefinida: true });
}

export async function sair() {
  const { role } = await api.sair();
  await db.meta.put({ key: 'role', value: role });
  emit({ role });
}

export async function trocarSenha(senha: string) {
  const { role } = await api.salvarSenha(senha);
  await db.meta.put({ key: 'role', value: role });
  emit({ role, senhaDefinida: true });
}

let initialized = false;

export function initSync() {
  if (initialized) return;
  initialized = true;

  db.meta.get('lastSyncAt').then((record) => {
    if (record) emit({ lastSyncAt: record.value });
  });
  db.meta.get('role').then((record) => {
    if (record?.value === 'operacao' || record?.value === 'administracao')
      emit({ role: record.value as Papel });
  });
  db.outbox.count().then((pending) => emit({ pending }));
  db.files.count().then((pendingFiles) => emit({ pendingFiles }));

  window.addEventListener('online', () => {
    emit({ online: true });
    void syncNow();
  });
  window.addEventListener('offline', () => emit({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void syncNow();
  });

  void syncNow();
  setInterval(() => {
    if (!document.hidden) void syncNow();
  }, POLL_MS);
}
