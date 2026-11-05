import type {
  Attachment,
  AttachmentJob,
  DeliveryPatch,
  DeliveryStatus,
  EtaSettings,
  ImportStatus,
  Order,
  Papel,
} from './types';

const TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 120_000;

export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/raw`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `falha na comunicação (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  orders: (from: string, to: string) =>
    request<{ orders: Order[] }>(`/api/orders?from=${from}&to=${to}`),
  order: (id: string) => request<Order>(`/api/orders/${id}`),
  status: () => request<ImportStatus>('/api/status'),
  session: () => request<{ role: Papel; senhaDefinida: boolean }>('/api/sessao'),
  entrar: (senha: string) =>
    request<{ role: Papel }>('/api/entrada', { method: 'POST', body: JSON.stringify({ senha }) }),
  sair: () => request<{ role: Papel }>('/api/saida', { method: 'POST' }),
  salvarSenha: (senha: string) =>
    request<{ role: Papel }>('/api/senha', { method: 'POST', body: JSON.stringify({ senha }) }),
  reiniciarServidor: () =>
    request<{ reiniciando: boolean }>('/api/servidor/reiniciar', { method: 'POST' }),
  uploadAttachment: async (job: AttachmentJob) => {
    const route = `/api/orders/${encodeURIComponent(job.orderId)}/deliveries/${job.seq}/attachments?name=${encodeURIComponent(job.name)}`;
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': job.mime || 'application/octet-stream' },
      body: job.blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error ?? `falha no envio (${response.status})`);
    }
    return (await response.json()) as {
      attachment: Attachment;
      summary: Attachment;
    };
  },
  settings: () => request<EtaSettings>('/api/settings'),
  saveSettings: (settings: EtaSettings) =>
    request<EtaSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  rescan: (force = false) =>
    request<{ started: boolean }>(`/api/rescan${force ? '?force=1' : ''}`, {
      method: 'POST',
    }),
  setDeliveryStatus: (orderId: string, seq: number, patch: DeliveryPatch) =>
    request<{
      orderId: string;
      seq: number;
      status: DeliveryStatus;
      advanced: number | null;
    }>(`/api/orders/${orderId}/deliveries/${seq}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
