export type OrderType = 'CXS' | 'PCS';

/** `operacao` marca entregas e registra anomalias; `administracao` abre importação, ajustes e servidor. */
export type Papel = 'operacao' | 'administracao';

export type DeliveryStatus = 'pendente' | 'em_rota' | 'entregue' | 'recusada';

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

export interface Delivery {
  seq: number;
  name: string;
  city: string;
  uf: string;
  weightKg: number | null;
  status: DeliveryStatus;
  note: string | null;
  statusAt: string | null;
  eta?: string | null;
  scheduledAt: string | null;
  reason: RefusalReason | null;
  resale: boolean | null;
  resaleDate: string | null;
  attachments?: Attachment[];
}

export interface DeliveryPatch {
  status?: DeliveryStatus;
  note?: string | null;
  scheduledAt?: string | null;
  reason?: RefusalReason | null;
  resale?: boolean | null;
  resaleDate?: string | null;
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
  updatedAt: string;
  deliveries: Delivery[];
  pendingSync?: boolean;
}

export interface OutboxEntry {
  id?: number;
  orderId: string;
  seq: number;
  status?: DeliveryStatus;
  note?: string | null;
  scheduledAt?: string | null;
  reason?: RefusalReason | null;
  resale?: boolean | null;
  resaleDate?: string | null;
  queuedAt: string;
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
  kind: 'xlsx' | 'pdf';
  exists: boolean;
  files: number;
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
};

export const TYPE_SOURCE: Record<OrderType, string> = {
  CXS: 'CXS',
  PCS: 'PÇS',
};

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pendente: 'Pendente',
  em_rota: 'Em rota',
  entregue: 'Entregue',
  recusada: 'Anomalia',
};

export const STATUS_ACTIONS: DeliveryStatus[] = ['em_rota', 'entregue', 'recusada'];

export const FINAL_STATUSES: DeliveryStatus[] = ['entregue', 'recusada'];

/** Clientes ESC não passam por agendamento de caixaria. */
export const isSchedulable = (name: string | null | undefined) =>
  !/^ESC(\s|$)/i.test(String(name ?? '').trim());

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
