import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { attachmentUrl } from '../api';
import { db } from '../db';
import {
  deleteAnomalyFile,
  patchDelivery,
  patchOrderFields,
  queueAttachmentFile,
  removeQueuedFile,
  saveAnomalyToFolder,
  setAllDeliveries,
  setDeliveryStatus,
  subscribeSync,
  syncSnapshot,
} from '../sync';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_STATUS_LABEL,
  FINAL_STATUSES,
  INVOICE_KIND_LABEL,
  REASON_GROUPS,
  REASON_LABEL,
  REFUSAL_REASONS,
  STATUS_ACTIONS,
  STATUS_LABEL,
  TYPE_CLASS,
  TYPE_LABEL,
  TYPE_SOURCE,
  invoiceKindOf,
  invoicesForDelivery,
  isPhoto,
  isEscDelivery,
  isSchedulable,
  type Attachment,
  type Delivery,
  type DeliveryPatch,
  type BillingInvoice,
  type DeliveryProduct,
  type DeliveryStatus,
  type Order,
  type OrderBilling,
  type OrderPatch,
  type RefusalReason,
} from '../types';
import { fmtEta, fmtFullDate, fmtKg, fmtMoney, todayISO } from '../utils';

interface Props {
  orderId: string;
  onBack: () => void;
}

export function OrderDetail({ orderId, onBack }: Props) {
  const order = useLiveQuery(() => db.orders.get(orderId), [orderId]);

  if (!order) {
    return (
      <section className="empty">
        <h3>Pedido não encontrado</h3>
        <p>Ele pode ter sido substituído por uma revisão mais nova da planilha.</p>
        <button type="button" className="btn" onClick={onBack}>
          Voltar
        </button>
      </section>
    );
  }

  const controlaveis = order.deliveries.filter((d) => !isEscDelivery(order, d.name));
  const semControle = order.deliveries.length - controlaveis.length;
  const total = controlaveis.length;
  const entregues = controlaveis.filter((d) => d.status === 'entregue').length;
  const finalizadas = controlaveis.filter((d) => FINAL_STATUSES.includes(d.status)).length;
  const percent = total ? Math.round((finalizadas / total) * 100) : 0;
  const isCaixaria = order.type === 'CXS';

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        ‹ Voltar ao painel
      </button>

      <section className="panel detail-head">
        <div className="detail-title">
          <span className={`type-pill ${TYPE_CLASS[order.type]}`}>
            {TYPE_SOURCE[order.type]}
          </span>
          <h2>
            Pedido {order.number} <span className="rev">{order.revision}</span>
          </h2>
          <span className="route-pill">{order.route}</span>
          {order.pendingSync && <span className="sync-dot" title="Alterações aguardando envio" />}
          <img className="detail-logo" src="/images/hajan-mark.png" alt="HAJAN" />
        </div>
        <p className="panel-sub">
          {TYPE_LABEL[order.type]} · entrega {fmtFullDate(order.deliveryDate)} · embarque{' '}
          {fmtFullDate(order.shipDate)}
        </p>

        <dl className="meta-grid">
          <div>
            <dt>Cliente</dt>
            <dd>{order.client ?? '—'}</dd>
          </div>
          <div>
            <dt>Peso total</dt>
            <dd>{fmtKg(order.totalKg)}</dd>
          </div>
          <div>
            <dt>Entregas</dt>
            <dd>
              {entregues} de {total} entregues
            </dd>
          </div>
          <div>
            <dt>Arquivo</dt>
            <dd className="file-cell" title={order.sourceFile ?? ''}>
              {order.sourceFile ?? '—'}
              {order.pdfFile && (
                <span className="file-extra" title={order.pdfFile}>
                  pesos do PDF
                </span>
              )}
            </dd>
          </div>
        </dl>

        <OrderFields order={order} />

        {order.billing && <BillingSummary billing={order.billing} />}

        <div className="detail-progress">
          <div className="progress" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-caption">
            <span>
              {percent}% concluído
              {semControle > 0 && (
                <em
                  className="esc-note"
                  title="Clientes ESC aparecem na lista e podem ser marcados como Em rota, No cliente ou Entregue, mas ficam fora do percentual."
                >
                  {semControle} ESC fora da conta
                </em>
              )}
            </span>
            <span>
              <button
                type="button"
                className="link-btn"
                onClick={() => void setAllDeliveries(order, 'entregue')}
              >
                Marcar todas entregues
              </button>
              <span className="dot-sep" aria-hidden="true">
                •
              </span>
              <button
                type="button"
                className="link-btn"
                onClick={() => void setAllDeliveries(order, 'recusado')}
                title="Marca todas as entregas como recusado (carga recusada)"
              >
                Recusar toda a carga
              </button>
              <span className="dot-sep" aria-hidden="true">
                •
              </span>
              <button
                type="button"
                className="link-btn"
                onClick={() => void setAllDeliveries(order, 'pendente')}
              >
                Reabrir
              </button>
            </span>
          </div>
        </div>
      </section>

      <ol className="delivery-list">
        {order.deliveries.map((delivery) => (
          <DeliveryRow
            key={delivery.seq}
            order={order}
            delivery={delivery}
            isCaixaria={isCaixaria}
          />
        ))}
      </ol>
    </>
  );
}

function DeliveryRow({
  order,
  delivery,
  isCaixaria,
}: {
  order: Order;
  delivery: Delivery;
  isCaixaria: boolean;
}) {
  const semControle = isEscDelivery(order, delivery.name);
  const notas = invoicesForDelivery(order, delivery);
  const [anomaliaAberta, setAnomaliaAberta] = useState(Boolean(delivery.reason));

  const toggleStatus = (status: DeliveryStatus) => {
    const next = delivery.status === status ? 'pendente' : status;
    if (next === 'recusado') setAnomaliaAberta(true);
    void setDeliveryStatus(order, delivery.seq, next);
  };

  return (
    <li className={`${delivery.status}${semControle ? ' sem-controle' : ''}`}>
      <div className="delivery-main">
        <span className="seq">{delivery.seq}</span>
        <div className="dest">
          <strong>{delivery.name}</strong>
          <span>
            {delivery.city}
            {delivery.uf ? `-${delivery.uf}` : ''}
            {delivery.weightKg != null ? ` · ${fmtKg(delivery.weightKg)}` : ''}
          </span>
          {delivery.eta && (
            <span
              className={`eta ${delivery.scheduledAt ? 'anchored' : ''}`}
              title={
                delivery.scheduledAt
                  ? `Agendado para ${fmtFullDate(delivery.scheduledAt)} — as entregas seguintes partem dessa data`
                  : 'Estimativa: 1º cliente às 08:00 na data ENTREGA (que é a data da primeira entrega) + distância rodoviária real entre as cidades (estimativa offline como reserva), velocidade média e descarga configuradas em Importação. Depois das 18:00 o relógio passa para o dia seguinte às 08:00, sem pular sábado ou domingo'
              }
            >
              {delivery.scheduledAt ? 'agendado' : 'previsão'}{' '}
              {fmtEta(delivery.eta, order.deliveryDate)}
            </span>
          )}
          {delivery.reason && (
            <em className="flag recusa dest-flag">{REASON_LABEL[delivery.reason]}</em>
          )}
          {delivery.lombador === true && (
            <em className="flag lombador dest-flag">lombador</em>
          )}
        </div>
        <div className="status-actions">
          {(semControle
            ? (['em_rota', 'no_cliente', 'entregue'] as DeliveryStatus[])
            : STATUS_ACTIONS
          ).map(
            (status) => (
              <button
                key={status}
                type="button"
                className={`status-btn ${status} ${delivery.status === status ? 'active' : ''}`}
                title={
                  delivery.status === status
                    ? semControle
                      ? 'Clique para voltar a pendente'
                      : 'Clique para voltar a pendente (a anomalia registrada continua)'
                    : semControle
                      ? STATUS_LABEL[status]
                      : status === 'entregue'
                        ? 'Entregue: a próxima entrega pendente passa a Em rota'
                        : status === 'recusado'
                          ? 'Recusado: a próxima entrega pendente passa a Em rota'
                          : STATUS_LABEL[status]
                }
                onClick={() => toggleStatus(status)}
              >
                {STATUS_LABEL[status]}
              </button>
            ),
          )}
          {!semControle && (
            <button
              type="button"
              className={`status-btn anomalia ${delivery.reason ? 'active' : ''}`}
              aria-expanded={anomaliaAberta}
              title={
                delivery.reason
                  ? `Anomalia registrada: ${REASON_LABEL[delivery.reason]}. Clique para abrir ou fechar o motivo.`
                  : 'Registrar anomalia sem mudar o status: pode ficar Entregue e com anomalia'
              }
              onClick={() => setAnomaliaAberta((aberto) => !aberto)}
            >
              Anomalia
            </button>
          )}
        </div>
      </div>

      {notas.length > 0 && (
        <div className="delivery-invoices" aria-label="Notas fiscais desta entrega">
          <span className="field-label">Notas:</span>
          {notas.map((invoice, index) => (
            <InvoiceChip invoice={invoice} key={`${invoice.number}-${index}`} />
          ))}
        </div>
      )}

      {delivery.products && delivery.products.length > 0 && (
        <DeliveryProducts products={delivery.products} />
      )}

      {isCaixaria && isSchedulable(delivery.name) && (
        <ScheduleField order={order} delivery={delivery} />
      )}
      {order.type === 'PCS' && !semControle && (
        <LombadorField order={order} delivery={delivery} />
      )}
      {!semControle && <ObservationField order={order} delivery={delivery} />}
      {!semControle && anomaliaAberta && <RefusalField order={order} delivery={delivery} />}
    </li>
  );
}

function InvoiceChip({ invoice }: { invoice: BillingInvoice }) {
  const kind = invoiceKindOf(invoice);
  return (
    <span
      className={`invoice-chip ${kind}`}
      title={[
        kind === 'devolucao'
          ? 'Nota de devolução: mercadoria que voltou deste cliente'
          : kind === 'revenda'
            ? 'Nota de revenda: mercadoria devolvida e vendida a outro cliente'
            : 'Nota fiscal de venda',
        invoice.series ? `série ${invoice.series}` : null,
        invoice.client,
        invoice.clientOfficial && invoice.clientOfficial !== invoice.client
          ? `cadastro: ${invoice.clientOfficial}`
          : null,
        invoice.city,
        invoice.date ? fmtFullDate(invoice.date) : null,
        fmtKg(invoice.kg),
        fmtMoney(invoice.value),
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      {kind === 'venda' ? `NF ${invoice.number}` : `${INVOICE_KIND_LABEL[kind]} · NF ${invoice.number}`}
    </span>
  );
}

function DeliveryProducts({ products }: { products: DeliveryProduct[] }) {
  const peso = products.reduce((soma, item) => soma + (item.kg ?? 0), 0);
  const caixas = products.reduce((soma, item) => soma + (item.boxes ?? 0), 0);
  const total = peso > 0 ? fmtKg(peso) : caixas > 0 ? `${caixas} cx` : '';
  return (
    <details className="products" open={products.length <= 3}>
      <summary>
        {products.length} {products.length === 1 ? 'produto' : 'produtos'}
        {total ? ` · ${total}` : ''}
      </summary>
      <ul>
        {products.map((item, index) => (
          <li key={[item.code, index].join('-')}>
            <span className="product-code">{item.code}</span>
            <span className="product-name">{item.name}</span>
            <span className="product-kg">
              {item.kg != null ? fmtKg(item.kg) : item.boxes != null ? `${item.boxes} cx` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function OrderFields({ order }: { order: Order }) {
  return (
    <div className="order-fields">
      <OrderTextField order={order} field="plates" label="Placas" maxLength={80} />
      <OrderTextField
        order={order}
        field="branchInstruction"
        label="Instrução filial"
        maxLength={500}
        multiline
      />
    </div>
  );
}

function OrderTextField({
  order,
  field,
  label,
  maxLength,
  multiline = false,
}: {
  order: Order;
  field: 'plates' | 'branchInstruction';
  label: string;
  maxLength: number;
  multiline?: boolean;
}) {
  const server = order[field] ?? '';
  const [draft, setDraft] = useState(server);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(server);
  }, [server]);

  const save = () => {
    const text = draft.trim().slice(0, maxLength);
    setDraft(text);
    if (text === server) return;
    const patch: OrderPatch =
      field === 'plates' ? { plates: text || null } : { branchInstruction: text || null };
    void patchOrderFields(order, patch);
  };

  const shared = {
    className: 'order-input',
    value: draft,
    maxLength,
    'aria-label': label,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(event.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      save();
    },
  };

  return (
    <label className="field order-field">
      <span className="field-label">{label}</span>
      {multiline ? (
        <textarea rows={2} {...shared} />
      ) : (
        <input
          type="text"
          {...shared}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

/** Resumo do ERP; informativo, não mexe no status das entregas. */
function BillingSummary({ billing }: { billing: OrderBilling }) {
  const notas = billing.invoices.length;
  const devolucoes = billing.invoices.filter((invoice) => invoiceKindOf(invoice) === 'devolucao');
  const revendas = billing.invoices.filter((invoice) => invoiceKindOf(invoice) === 'revenda');
  const temVenda = billing.invoices.some((invoice) => invoiceKindOf(invoice) === 'venda');
  const porCliente = new Map<string, BillingInvoice[]>();
  for (const invoice of billing.invoices) {
    const cliente = invoice.client ?? '';
    porCliente.set(cliente, [...(porCliente.get(cliente) ?? []), invoice]);
  }
  return (
    <section className="billing-block">
      <header className="billing-head">
        <div>
          <span className="field-label">Faturamento do ERP</span>
          <strong>{billing.status ?? 'Faturado'}</strong>
          {billing.billedAt && (
            <span className="billing-date">em {fmtFullDate(billing.billedAt)}</span>
          )}
        </div>
        <div className="billing-totals">
          {temVenda ? (
            <>
              <strong>{fmtMoney(billing.value)}</strong>
              <span>{fmtKg(billing.kg)}</span>
            </>
          ) : (
            <span>sem venda faturada</span>
          )}
          <span>
            {notas} NF{notas === 1 ? '' : 's'}
          </span>
          {devolucoes.length > 0 && (
            <span className="invoice-chip devolucao" title="Este pedido teve nota de devolução">
              {devolucoes.length} {devolucoes.length === 1 ? 'devolução' : 'devoluções'}
            </span>
          )}
          {revendas.length > 0 && (
            <span className="invoice-chip revenda" title="Mercadoria devolvida e revendida a outro cliente">
              {revendas.length} revenda{revendas.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </header>

      {notas > 0 && (
        <ul className="invoice-groups">
          {[...porCliente].map(([cliente, invoices]) => {
            const vendas = invoices.filter((invoice) => invoiceKindOf(invoice) === 'venda');
            const kg = vendas.reduce((soma, invoice) => soma + invoice.kg, 0);
            const valor = vendas.reduce((soma, invoice) => soma + invoice.value, 0);
            return (
              <li className="invoice-group" key={cliente || 'sem-cliente'}>
                <div className="invoice-client">
                  <span>{cliente || 'Cliente não informado no ERP'}</span>
                  {(() => {
                    const oficial = invoices.find(
                      (invoice) => invoice.clientOfficial && invoice.clientOfficial !== cliente,
                    )?.clientOfficial;
                    return oficial ? <em className="invoice-alias">Cadastro: {oficial}</em> : null;
                  })()}
                  {vendas.length > 0 && (
                    <em>
                      {fmtMoney(valor)} · {fmtKg(kg)}
                    </em>
                  )}
                </div>
                <div className="invoice-chips">
                  {invoices.map((invoice, index) => (
                    <InvoiceChip invoice={invoice} key={`${invoice.number}-${index}`} />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="billing-note">
        {notas === 0 && billing.clients.length > 0 && (
          <>Cliente no ERP: {billing.clients.join(' · ')}. </>
        )}
        {billing.deliveryAt && <>Entrega no ERP: {fmtFullDate(billing.deliveryAt)}. </>}
        {billing.sourceFile && <>Fonte: {billing.sourceFile}. </>}
        O faturamento é só informativo e não altera o status das entregas.
      </p>
    </section>
  );
}

/** Data sem re-render a cada tecla: o input só é sincronizado quando não está em edição. */
function DateInput({
  value,
  label,
  onSave,
}: {
  value: string;
  label: string;
  onSave: (value: string | null) => void;
}) {
  const [editando, setEditando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editando && input.current) input.current.value = value;
  }, [value, editando]);

  return (
    <input
      ref={input}
      type="date"
      className="date-input"
      defaultValue={value}
      aria-label={label}
      onFocus={() => setEditando(true)}
      onBlur={(event) => {
        setEditando(false);
        const next = event.target.value || null;
        if ((next ?? '') !== value) onSave(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function ScheduleField({ order, delivery }: { order: Order; delivery: Delivery }) {
  const atual = delivery.scheduledAt ?? '';
  const save = (scheduledAt: string | null) => {
    if ((scheduledAt ?? '') !== atual)
      void patchDelivery(order, delivery.seq, { scheduledAt });
  };

  return (
    <div className={`field schedule ${atual ? 'set' : ''}`}>
      <span className="field-label">Agendamento</span>
      <DateInput
        value={atual}
        label={`Data do agendamento de ${delivery.name}`}
        onSave={save}
      />
      {atual ? (
        <button type="button" className="link-btn" onClick={() => save(null)}>
          remover
        </button>
      ) : (
        <button
          type="button"
          className="btn ghost small"
          onClick={() => save(order.deliveryDate ?? todayISO())}
        >
          Já agendado
        </button>
      )}
    </div>
  );
}

/** Pedidos com osso: o cliente já tem lombador? Sim/Não por cliente, sem mexer no status. */
function LombadorField({ order, delivery }: { order: Order; delivery: Delivery }) {
  return (
    <div className={`field lombador ${delivery.lombador != null ? 'set' : ''}`}>
      <span className="field-label">Já tem lombador?</span>
      {[true, false].map((option) => (
        <button
          key={String(option)}
          type="button"
          className={`reason-btn ${delivery.lombador === option ? 'active' : ''}`}
          aria-pressed={delivery.lombador === option}
          onClick={() =>
            void patchDelivery(order, delivery.seq, {
              lombador: delivery.lombador === option ? null : option,
            })
          }
        >
          {option ? 'Sim' : 'Não'}
        </button>
      ))}
    </div>
  );
}

function ObservationField({ order, delivery }: { order: Order; delivery: Delivery }) {
  const [aberto, setAberto] = useState(false);
  const atual = delivery.observation ?? '';

  const salvar = (value: string) => {
    const texto = value.trim().slice(0, 500);
    if (texto !== atual) void patchDelivery(order, delivery.seq, { observation: texto || null });
  };

  if (!aberto && atual) {
    return (
      <div className="obs-line">
        <span className="field-label">Observação</span>
        <span className="obs-text">{atual}</span>
        <button type="button" className="link-btn" onClick={() => setAberto(true)}>
          editar
        </button>
      </div>
    );
  }
  if (!aberto) {
    return (
      <button type="button" className="link-btn obs-open" onClick={() => setAberto(true)}>
        + Observação
      </button>
    );
  }
  return (
    <div className="field observation">
      <span className="field-label">Observação</span>
      <textarea
        className="obs-input"
        rows={2}
        maxLength={500}
        placeholder="Ex.: cliente só recebe até 11h; carga conferida por João…"
        defaultValue={atual}
        aria-label={`Observação da entrega de ${delivery.name}`}
        onBlur={(event) => {
          salvar(event.target.value);
          setAberto(false);
        }}
      />
      {atual && (
        <button
          type="button"
          className="link-btn"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setAberto(false);
            void patchDelivery(order, delivery.seq, { observation: null });
          }}
        >
          limpar
        </button>
      )}
    </div>
  );
}

function RefusalField({ order, delivery }: { order: Order; delivery: Delivery }) {
  const patch = (changes: DeliveryPatch) => void patchDelivery(order, delivery.seq, changes);

  return (
    <div className="field refusal">
      <span className="field-label">Motivo da anomalia</span>
      <div className="reason-row">
        <select
          className="reason-select"
          value={delivery.reason ?? ''}
          aria-label="Motivo da anomalia"
          onChange={(event) => {
            const next = (event.target.value || null) as RefusalReason | null;
            const changes: DeliveryPatch = { reason: next };
            if (next !== 'outro') changes.note = null;
            patch(changes);
          }}
        >
          <option value="">selecione o motivo</option>
          {REASON_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {REFUSAL_REASONS.filter((reason) => reason.group === group).map((reason) => (
                <option key={reason.key} value={reason.key}>
                  {reason.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {delivery.reason && (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => patch({ reason: null, note: null })}
          >
            limpar motivo
          </button>
        )}
      </div>

      {delivery.reason === 'outro' && (
        <input
          type="text"
          className="reason-text"
          placeholder="Descreva o motivo"
          defaultValue={delivery.note ?? ''}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value !== (delivery.note ?? '')) patch({ note: value || null });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}

      <div className="resale-row">
        <span className="field-label">Vai ter revenda?</span>
        {[true, false].map((option) => (
          <button
            key={String(option)}
            type="button"
            className={`reason-btn ${delivery.resale === option ? 'active' : ''}`}
            onClick={() =>
              patch({
                resale: delivery.resale === option ? null : option,
                resaleDate: null,
              })
            }
          >
            {option ? 'Sim' : 'Não'}
          </button>
        ))}
        {delivery.resale === true && (
          <DateInput
            value={delivery.resaleDate ?? ''}
            label="Data prevista da revenda"
            onSave={(resaleDate) => patch({ resaleDate })}
          />
        )}
        {delivery.resale === true && !delivery.resaleDate && (
          <span className="field-hint">informe a data da revenda</span>
        )}
      </div>

      <AttachmentField order={order} delivery={delivery} />
    </div>
  );
}

const fmtBytes = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function AttachmentField({ order, delivery }: { order: Order; delivery: Delivery }) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removendo, setRemovendo] = useState<string | null>(null);
  const stored = delivery.attachments ?? [];
  const files = stored.filter((item) => item.kind === 'arquivo');
  const resumo = stored.find((item) => item.kind === 'resumo');
  const pendingJobs =
    useLiveQuery(() => db.files.where('orderId').equals(order.id).toArray(), [order.id]) ?? [];
  const queued = pendingJobs.filter((job) => job.seq === delivery.seq);
  const upload = sync.upload;
  const uploading = upload && queued.some((job) => job.id === upload.id) ? upload : null;

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!selected.length) return;
    const problems: string[] = [];
    for (const file of selected) {
      const error = await queueAttachmentFile(order.id, delivery.seq, file);
      if (error) problems.push(error);
    }
    setFeedback(problems.length ? problems.join(' · ') : null);
  };

  const removeFile = async (item: Attachment) => {
    if (!window.confirm(`Excluir "${item.name}" da pasta da semana?`)) return;
    setFeedback(null);
    setSaveMsg(null);
    setRemovendo(item.id);
    try {
      await deleteAnomalyFile(order.id, item.id);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'não foi possível excluir o arquivo');
    } finally {
      setRemovendo(null);
    }
  };

  const salvarNaPasta = async () => {
    setSaving(true);
    setFeedback(null);
    setSaveMsg(null);
    try {
      const result = await saveAnomalyToFolder(order.id, delivery.seq);
      const partes = [`${result.saved} arquivo${result.saved === 1 ? '' : 's'} na pasta da semana`];
      if (result.pending)
        partes.push(`${result.pending} ainda na fila (pasta de relatórios fora do ar)`);
      if (result.folder) partes.push(result.folder);
      setSaveMsg(partes.join(' · '));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'não foi possível salvar a anomalia');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="attachments">
      <span className="field-label">Arquivos da anomalia</span>
      <div className="attach-actions">
        <label className="btn ghost small file-btn">
          Anexar fotos, PDF, planilha
          <input type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={addFiles} />
        </label>
        <label className="btn ghost small file-btn">
          Tirar foto
          <input type="file" accept="image/*" capture="environment" onChange={addFiles} />
        </label>
        <button
          type="button"
          className="btn small"
          onClick={() => void salvarNaPasta()}
          disabled={!delivery.reason || saving || Boolean(uploading)}
          title={
            delivery.reason
              ? 'Grava os arquivos e o resumo na pasta da semana'
              : 'Marque o motivo da anomalia antes de salvar'
          }
        >
          {saving ? 'Salvando…' : 'Salvar na pasta da semana'}
        </button>
      </div>
      {feedback && <p className="attach-error">{feedback}</p>}
      {saveMsg && <p className="attach-save-msg">{saveMsg}</p>}

      {files.length === 0 && queued.length === 0 && (
        <p className="field-hint">
          Nenhum arquivo ainda — anexe a foto da balança, a nota ou a planilha da conferência.
        </p>
      )}

      <ul className="attach-list">
        {files.map((item) => (
          <AttachmentRow
            key={item.id}
            item={item}
            deleting={removendo === item.id}
            onDelete={() => void removeFile(item)}
          />
        ))}
        {queued.map((job) => {
          const enviando = uploading && uploading.id === job.id ? uploading.percent : null;
          return (
            <li key={`fila-${job.id}`} className="attach-item fila">
              <span
                className={`attach-icon ${isPhoto(job.mime) ? 'photo' : 'doc'}`}
                aria-hidden="true"
              />
              <span className="attach-name">{job.name}</span>
              <span className="attach-meta">
                {fmtBytes(job.bytes)} ·{' '}
                {job.error
                  ? `falha: ${job.error}`
                  : enviando != null
                    ? `enviando ${enviando}%`
                    : 'aguardando envio'}
              </span>
              {enviando != null && (
                <span
                  className="attach-progress"
                  role="progressbar"
                  aria-label={`Enviando ${job.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={enviando}
                >
                  <span style={{ width: `${enviando}%` }} />
                </span>
              )}
              <button
                type="button"
                className="link-btn"
                onClick={() => job.id != null && void removeQueuedFile(job.id)}
              >
                cancelar
              </button>
            </li>
          );
        })}
      </ul>

      {resumo && (
        <p className="attach-resumo">
          {resumo.status === 'no_s' ? (
            <>
              Resumo em PDF gerado:{' '}
              <a href={attachmentUrl(resumo.id)} target="_blank" rel="noreferrer">
                {resumo.name}
              </a>
            </>
          ) : (
            `Resumo em PDF na fila: ${resumo.name}`
          )}
        </p>
      )}
    </div>
  );
}

function AttachmentRow({
  item,
  deleting,
  onDelete,
}: {
  item: Attachment;
  deleting: boolean;
  onDelete: () => void;
}) {
  const openable = item.status !== 'fila' && item.status !== 'erro';
  return (
    <li className={`attach-item ${item.status}`}>
      <span className={`attach-icon ${isPhoto(item.mime) ? 'photo' : 'doc'}`} aria-hidden="true" />
      {openable ? (
        <a className="attach-name" href={attachmentUrl(item.id)} target="_blank" rel="noreferrer">
          {item.name}
        </a>
      ) : (
        <span className="attach-name">{item.name}</span>
      )}
      <span className="attach-meta">
        {fmtBytes(item.bytes)} · {ATTACHMENT_STATUS_LABEL[item.status]}
      </span>
      <button
        type="button"
        className="link-btn attach-delete"
        onClick={onDelete}
        disabled={deleting}
        title="Excluir este arquivo da pasta da semana"
      >
        {deleting ? 'excluindo…' : 'excluir'}
      </button>
    </li>
  );
}
