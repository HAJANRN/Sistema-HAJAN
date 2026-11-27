import { api } from './api';
import { db } from './db';
import {
  FINAL_STATUSES,
  type DeliveryPatch,
  type DeliveryStatus,
  type Order,
  type OrderPatch,
  type OutboxEntry,
  type Papel,
  isEscDelivery,
} from './types';
import { shiftISO, todayISO } from './utils';

export interface SyncState {
  online: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  pendingFiles: number;
  upload: { id: number; percent: number } | null;
  role: Papel;
  senhaDefinida: boolean;
}

/** O painel "Tudo" mostra o histórico importado: a janela precisa cobrir os pedidos antigos. */
const RANGE_BACK_DAYS = 400;
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
  upload: null,
  role: 'operacao',
  senhaDefinida: false,
};

/** Última versão do conteúdo que este navegador já tem, para não baixar a lista inteira à toa. */
let syncedRevision = 0;
let syncedRange = '';
let metaLoaded = false;

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
  if (!entries.length) return;
  const byOrder = new Map<string, OutboxEntry[]>();
  for (const entry of entries) {
    if (!byOrder.has(entry.orderId)) byOrder.set(entry.orderId, []);
    byOrder.get(entry.orderId)!.push(entry);
  }
  for (const [orderId, list] of byOrder) {
    const order = await db.orders.get(orderId);
    if (!order) continue;
    const pedido = list.find((entry) => entry.kind === 'pedido');
    const bySeq = new Map(
      list.filter((entry) => entry.kind !== 'pedido').map((entry) => [entry.seq, entry]),
    );
    await db.orders.put({
      ...order,
      ...(pedido
        ? {
            plates: pedido.plates !== undefined ? pedido.plates : order.plates,
            branchInstruction:
              pedido.branchInstruction !== undefined
                ? pedido.branchInstruction
                : order.branchInstruction,
          }
        : {}),
      pendingSync: true,
      deliveries: order.deliveries.map((delivery) => {
        const entry = bySeq.get(delivery.seq);
        return entry ? { ...delivery, ...deliveryPatch(entry) } : delivery;
      }),
    });
  }
}

const deliveryPatch = (entry: OutboxEntry): DeliveryPatch => {
  const patch: DeliveryPatch = {};
  if (entry.status !== undefined) patch.status = entry.status;
  if (entry.note !== undefined) patch.note = entry.note;
  if (entry.observation !== undefined) patch.observation = entry.observation;
  if (entry.scheduledAt !== undefined) patch.scheduledAt = entry.scheduledAt;
  if (entry.reason !== undefined) patch.reason = entry.reason;
  if (entry.resale !== undefined) patch.resale = entry.resale;
  if (entry.resaleDate !== undefined) patch.resaleDate = entry.resaleDate;
  if (entry.lombador !== undefined) patch.lombador = entry.lombador;
  return patch;
};

/** Importação, ajustes e servidor pedem a senha do escritório; marcar entregas não pede. */
export const administrador = () => state.role === 'administracao';

interface FlushResult {
  ok: boolean;
  changed: Set<string>;
  error: string | null;
}

let flushing: Promise<FlushResult> | null = null;

/** Chamadas simultâneas esperam a mesma gravação em vez de fingir que já terminou. */
function flushOutbox(): Promise<FlushResult> {
  if (!flushing) {
    flushing = runFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function runFlush(): Promise<FlushResult> {
  const changed = new Set<string>();
  const entries = await db.outbox.orderBy('id').toArray();
  for (const entry of entries) {
    let sent = false;
    try {
      if (entry.kind === 'pedido') {
        await api.patchOrder(entry.orderId, {
          ...(entry.plates !== undefined ? { plates: entry.plates } : {}),
          ...(entry.branchInstruction !== undefined
            ? { branchInstruction: entry.branchInstruction }
            : {}),
        });
      } else {
        await api.setDeliveryStatus(entry.orderId, entry.seq, deliveryPatch(entry));
      }
      sent = true;
    } catch (error) {
      const message = errorMessage(error);
      const permanent = message.includes('(404)') || /não encontrad[ao]/i.test(message);
      if (!permanent) {
        emit({
          online: false,
          lastError: message,
          pending: await db.outbox.count(),
        });
        return { ok: false, changed, error: message };
      }
    }
    if (sent) changed.add(entry.orderId);
    await db.outbox.delete(entry.id!);
    const remaining = await db.outbox.where('orderId').equals(entry.orderId).count();
    if (remaining === 0) {
      const order = await db.orders.get(entry.orderId);
      if (order?.pendingSync) await db.orders.put({ ...order, pendingSync: false });
    }
  }
  emit({ pending: await db.outbox.count() });
  return { ok: true, changed, error: null };
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

/** Exclui um anexo já enviado (no S: ou na fila do servidor) e atualiza o pedido local. */
export async function deleteAnomalyFile(orderId: string, attachmentId: string) {
  await api.deleteAttachment(attachmentId);
  await refreshOrder(orderId);
}

/** Força a gravação da anomalia na pasta da semana e regenera o resumo em PDF. */
export async function saveAnomalyToFolder(orderId: string, seq: number) {
  const result = await api.saveAnomaly(orderId, seq);
  await refreshOrder(orderId);
  return result;
}

let flushingFiles: Promise<string[]> | null = null;

/** Tenta enviar tudo o que ainda está no navegador; devolve os pedidos afetados. */
function flushFiles(): Promise<string[]> {
  if (!flushingFiles) {
    flushingFiles = runFlushFiles().finally(() => {
      flushingFiles = null;
    });
  }
  return flushingFiles;
}

async function runFlushFiles(): Promise<string[]> {
  const sent: string[] = [];
  try {
    for (const job of await db.files.orderBy('queuedAt').toArray()) {
      // erro permanente (arquivo vazio, grande demais, 4xx) fica parado até a pessoa cancelar
      if (job.error) continue;
      if (typeof navigator !== 'undefined' && !navigator.onLine) break;
      const jobId = job.id!;
      emit({ upload: { id: jobId, percent: 0 } });
      try {
        await api.uploadAttachment(job, (percent) => emit({ upload: { id: jobId, percent } }));
        await db.files.delete(jobId);
        sent.push(job.orderId);
      } catch (error) {
        const message = errorMessage(error);
        const unreachable =
          error instanceof TypeError || /falha no envio \((5\d\d)\)/.test(message);
        if (unreachable) break;
        await db.files.update(jobId, { error: message });
      } finally {
        emit({ upload: null });
      }
    }
    for (const orderId of new Set(sent)) await refreshOrder(orderId);
    return sent;
  } finally {
    emit({ pendingFiles: await db.files.count() });
  }
}

export async function syncNow() {
  if (state.syncing) return;
  emit({ syncing: true });
  if (!metaLoaded) {
    const [revision, range] = await Promise.all([
      db.meta.get('syncedRevision'),
      db.meta.get('syncedRange'),
    ]);
    syncedRevision = Number(revision?.value) || 0;
    syncedRange = range?.value ?? '';
    metaLoaded = true;
  }
  const today = todayISO();
  const from = shiftISO(today, -RANGE_BACK_DAYS);
  const to = shiftISO(today, RANGE_FORWARD_DAYS);

  try {
    const { role, senhaDefinida } = await api.session();
    await db.meta.put({ key: 'role', value: role });
    if (role !== state.role || senhaDefinida !== state.senhaDefinida) emit({ role, senhaDefinida });

    const flushed = await flushOutbox();
    if (!flushed.ok) throw new Error(flushed.error ?? state.lastError ?? 'servidor indisponível');

    const sentFiles = await flushFiles();
    if (sentFiles.length)
      await Promise.all([...new Set(sentFiles)].map((orderId) => refreshOrder(orderId)));

    const range = `${from}|${to}`;
    const payload = await api.orders(
      from,
      to,
      syncedRange === range && syncedRevision > 0 ? syncedRevision : undefined,
    );

    if (!payload.unchanged) {
      const orders = payload.orders ?? [];
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
    }
    await overlayPending();
    syncedRevision = payload.revision;
    syncedRange = range;
    await db.meta.bulkPut([
      { key: 'syncedRevision', value: String(syncedRevision) },
      { key: 'syncedRange', value: syncedRange },
    ]);

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

/** Junta a alteração com o que já estava na fila daquela entrega (ex.: observação + status). */
async function queueEntries(orderId: string, entries: OutboxEntry[]) {
  if (!entries.length) return;
  const existing = await db.outbox.where('orderId').equals(orderId).toArray();
  const bySeq = new Map(existing.map((entry) => [entry.seq, entry]));
  for (const entry of entries) {
    const prior = bySeq.get(entry.seq);
    if (prior) await db.outbox.put({ ...prior, ...entry, id: prior.id });
    else await db.outbox.add(entry);
  }
}

export async function patchDelivery(order: Order, seq: number, patch: DeliveryPatch) {
  const at = new Date().toISOString();
  const base = (await db.orders.get(order.id)) ?? order;
  const deliveries = base.deliveries.map((d) => {
    if (d.seq !== seq) return d;
    return { ...d, ...patch, statusAt: patch.status ? at : d.statusAt };
  });

  const origemEsc = isEscDelivery(
    base,
    base.deliveries.find((d) => d.seq === seq)?.name,
  );
  const advanced =
    patch.status && FINAL_STATUSES.includes(patch.status) && !origemEsc
      ? (deliveries
          .filter(
            (d) => d.seq > seq && d.status === 'pendente' && !isEscDelivery(base, d.name),
          )
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

  await db.orders.put({ ...base, pendingSync: true, deliveries });

  const entries: OutboxEntry[] = [{ orderId: base.id, seq, ...patch, queuedAt: at }];
  if (advanced != null)
    entries.push({
      orderId: base.id,
      seq: advanced,
      status: 'em_rota',
      queuedAt: at,
    });
  await queueEntries(base.id, entries);

  emit({ pending: await db.outbox.count() });
  const result = await flushOutbox();
  if (result.ok) await refreshOrder(base.id);
}

async function refreshOrder(orderId: string) {
  if (await db.outbox.where('orderId').equals(orderId).count()) return;
  try {
    const fresh = await api.order(orderId);
    // chegou alteração enquanto buscava: a fila local manda
    if (await db.outbox.where('orderId').equals(orderId).count()) return;
    const local = await db.orders.get(orderId);
    await db.orders.put({ ...fresh, pendingSync: local?.pendingSync ?? false });
  } catch {
    // a próxima sincronização traz as previsões recalculadas
  }
}

/** Placas e instrução filial: mesma fila das entregas, com seq 0 para separar do status. */
export async function patchOrderFields(order: Order, patch: OrderPatch) {
  const at = new Date().toISOString();
  const base = (await db.orders.get(order.id)) ?? order;
  await db.orders.put({ ...base, ...patch, pendingSync: true });
  await queueEntries(base.id, [
    { orderId: base.id, seq: 0, kind: 'pedido', ...patch, queuedAt: at },
  ]);
  emit({ pending: await db.outbox.count() });
  const result = await flushOutbox();
  if (result.ok) await refreshOrder(base.id);
}

export async function setDeliveryStatus(order: Order, seq: number, status: DeliveryStatus) {
  await patchDelivery(order, seq, { status });
}

export async function setAllDeliveries(order: Order, status: DeliveryStatus) {
  const at = new Date().toISOString();
  const base = (await db.orders.get(order.id)) ?? order;
  await db.orders.put({
    ...base,
    pendingSync: true,
    deliveries: base.deliveries.map((d) =>
      isEscDelivery(base, d.name) ? d : { ...d, status, statusAt: at },
    ),
  });
  await queueEntries(
    base.id,
    base.deliveries
      .filter((delivery) => !isEscDelivery(base, delivery.name))
      .map((delivery) => ({ orderId: base.id, seq: delivery.seq, status, queuedAt: at })),
  );
  emit({ pending: await db.outbox.count() });
  const result = await flushOutbox();
  if (result.ok) await refreshOrder(base.id);
}

/** Entra na área administrativa; o servidor é quem decide se a senha valeu. */
export async function entrar(senha: string, usuario = 'admin') {
  const { role } = await api.entrar(usuario, senha);
  await db.meta.put({ key: 'role', value: role });
  emit({ role, senhaDefinida: true });
}

export async function sair() {
  const { role } = await api.sair();
  await db.meta.put({ key: 'role', value: role });
  emit({ role });
}

export async function trocarSenha(senha: string, usuario = 'admin') {
  const { role } = await api.salvarSenha(senha, usuario);
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
