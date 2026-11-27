import type {
  AnomalySaveResult,
  Attachment,
  AttachmentJob,
  DeliveryPatch,
  DeliveryStatus,
  EtaSettings,
  ImportStatus,
  Order,
  OrderPatch,
  Papel,
} from './types';
import type { BaseEmissor, ClonePayload } from './emissor/tipos';

/** O servidor pode demorar ao gravar a anomalia no S:; 20 s evita marcar como offline sem motivo. */
const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/raw`;

/** Pedido emitido pelo Emissor e registrado no banco unificado (tabela emissor_pedidos_semana). */
export interface EmissorPedido {
  numero: string;
  tipo: string;
  unidade: string;
  embarque: string | null;
  entrega: string | null;
  criadoEm: string | null;
  destinos: number;
  clientes: string[];
}

export interface EmissorLista {
  de: string;
  ate: string;
  total: number;
  pedidos: EmissorPedido[];
}


export interface CarteiraRegistro {
  nome: string;
  limite: number;
  saldoFinanceiro: number;
  saldoCarteira: number;
  saldoCredito: number;
  status: string;
}

export interface CarteiraMedia {
  mediaMensal6m: number;
  mediaSemana: number;
  statusCompra: string;
}

export type Carteira =
  | { disponivel: false }
  | {
      disponivel: true;
      data: string;
      registros: Record<string, CarteiraRegistro>;
      media: Record<string, CarteiraMedia>;
    };

export interface EmissaoResultado {
  ok: boolean;
  pedido: {
    categorias: string;
    pesoTotal: number;
    valor: number;
    veiculo: string;
    entregas: number;
    nfsRemessa: number;
    registradoNoHistorico: boolean;
  };
  arquivo: string;
  salvoEm: string[];
  download: string;
  avisos: string[];
}

export interface ImportacaoResultado {
  backup: string;
  contagens: { clientes: number; produtos: number; limites: number; unidades: number };
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `falha na comunicação (${response.status})`);
  }
  return (await response.json()) as T;
}

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
  orders: (from: string, to: string, revision?: number) =>
    request<{ orders?: Order[]; revision: number; unchanged?: boolean }>(
      `/api/orders?from=${from}&to=${to}${revision ? `&revision=${revision}` : ''}`,
    ),
  order: (id: string) => request<Order>(`/api/orders/${id}`),
  patchOrder: (id: string, patch: OrderPatch) =>
    request<{ id: string; plates: string | null; branchInstruction: string | null }>(
      `/api/orders/${id}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  status: () => request<ImportStatus>('/api/status'),
  session: () => request<{ role: Papel; senhaDefinida: boolean; revision: number }>('/api/sessao'),
  entrar: (usuario: string, senha: string) =>
    request<{ role: Papel }>('/api/entrada', {
      method: 'POST',
      body: JSON.stringify({ usuario, senha }),
    }),
  sair: () => request<{ role: Papel }>('/api/saida', { method: 'POST' }),
  salvarSenha: (senha: string, usuario = 'admin') =>
    request<{ role: Papel }>('/api/senha', {
      method: 'POST',
      body: JSON.stringify({ usuario, senha }),
    }),
  reiniciarServidor: () =>
    request<{ reiniciando: boolean }>('/api/servidor/reiniciar', { method: 'POST' }),
  uploadAttachment: (job: AttachmentJob, onProgress?: (percent: number) => void) =>
    new Promise<{ attachment: Attachment; summary: Attachment }>((resolve, reject) => {
      const route = `/api/orders/${encodeURIComponent(job.orderId)}/deliveries/${job.seq}/attachments?name=${encodeURIComponent(job.name)}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', route);
      xhr.setRequestHeader('Content-Type', job.mime || 'application/octet-stream');
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let body: { error?: string } & Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // resposta sem JSON: usa a mensagem padrão abaixo
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body as unknown as { attachment: Attachment; summary: Attachment });
        } else {
          reject(new Error(body.error ?? `falha no envio (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new TypeError('sem conexão com o servidor'));
      xhr.ontimeout = () => reject(new Error('o envio demorou demais'));
      xhr.send(job.blob);
    }),
  deleteAttachment: (id: string) =>
    request<{ removed: boolean; summary?: Attachment }>(
      `/api/attachments/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  saveAnomaly: (orderId: string, seq: number) =>
    request<AnomalySaveResult>(
      `/api/orders/${encodeURIComponent(orderId)}/deliveries/${seq}/anomalia/salvar`,
      { method: 'POST' },
    ),
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
  emissorPedidos: (de: string, ate: string) =>
    request<EmissorLista>(
      `/api/emissor/pedidos?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`,
    ),
  emissorBase: () => request<BaseEmissor>('/api/emissor/base'),
  emissorCarteira: () => request<Carteira>('/api/emissor/carteira'),
  emissorClone: (numero: string, tipo: string) =>
    request<{
      encontrado: boolean;
      fonte?: 'banco' | 'rede';
      payload?: ClonePayload;
      outroTipo?: string;
    }>(`/api/emissor/clones/${encodeURIComponent(numero)}?tipo=${encodeURIComponent(tipo)}`),
  emitirPedido: (corpo: unknown) =>
    request<EmissaoResultado>('/api/emissor/pedidos', {
      method: 'POST',
      body: JSON.stringify(corpo),
    }),
  importarPlanilhas: (arquivos: Partial<Record<'clientes' | 'produtos' | 'limites' | 'unidades', File>>) => {
    const form = new FormData();
    for (const [tipo, arquivo] of Object.entries(arquivos)) {
      if (arquivo) form.append(tipo, arquivo);
    }
    return requestForm<ImportacaoResultado>('/api/emissor/importar', form);
  },
};
