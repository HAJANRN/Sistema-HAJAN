import { useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { attachmentUrl } from '../api';
import { db } from '../db';
import {
  patchDelivery,
  queueAttachmentFile,
  removeQueuedFile,
  setAllDeliveries,
  setDeliveryStatus,
} from '../sync';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_STATUS_LABEL,
  FINAL_STATUSES,
  REASON_GROUPS,
  REFUSAL_REASONS,
  STATUS_ACTIONS,
  STATUS_LABEL,
  TYPE_LABEL,
  TYPE_SOURCE,
  isPhoto,
  isSchedulable,
  type Attachment,
  type Delivery,
  type DeliveryPatch,
  type DeliveryStatus,
  type Order,
  type RefusalReason,
} from '../types';
import { fmtEta, fmtFullDate, fmtKg, todayISO } from '../utils';

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

  const total = order.deliveries.length;
  const entregues = order.deliveries.filter((d) => d.status === 'entregue').length;
  const finalizadas = order.deliveries.filter((d) => FINAL_STATUSES.includes(d.status)).length;
  const percent = total ? Math.round((finalizadas / total) * 100) : 0;
  const isCaixaria = order.type === 'CXS';

  const toggle = (seq: number, status: DeliveryStatus) => {
    const current = order.deliveries.find((d) => d.seq === seq)?.status;
    void setDeliveryStatus(order, seq, current === status ? 'pendente' : status);
  };

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        ‹ Voltar ao painel
      </button>

      <section className="panel detail-head">
        <div className="detail-title">
          <span className={`type-pill ${order.type === 'PCS' ? 'osso' : 'caixaria'}`}>
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

        <div className="detail-progress">
          <div className="progress" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-caption">
            <span>{percent}% concluído</span>
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
          <li key={delivery.seq} className={delivery.status}>
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
                        : 'Estimativa: 1º cliente às 06:00 + distância rodoviária real entre as cidades (estimativa offline como reserva), velocidade média e descarga configuradas em Importação. Recebimento só de segunda a sexta, 06:00–18:00'
                    }
                  >
                    {delivery.scheduledAt ? 'agendado' : 'previsão'}{' '}
                    {fmtEta(delivery.eta, order.deliveryDate)}
                  </span>
                )}
              </div>
              <div className="status-actions">
                {STATUS_ACTIONS.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`status-btn ${status} ${delivery.status === status ? 'active' : ''}`}
                    title={
                      delivery.status === status
                        ? 'Clique para voltar a pendente'
                        : status === 'entregue'
                          ? 'Entregue: a próxima entrega pendente passa a Em rota'
                          : STATUS_LABEL[status]
                    }
                    onClick={() => toggle(delivery.seq, status)}
                  >
                    {STATUS_LABEL[status]}
                  </button>
                ))}
              </div>
            </div>

            {isCaixaria && isSchedulable(delivery.name) && (
              <ScheduleField order={order} delivery={delivery} />
            )}
            {delivery.status === 'recusada' && <RefusalField order={order} delivery={delivery} />}
          </li>
        ))}
      </ol>
    </>
  );
}

function ScheduleField({ order, delivery }: { order: Order; delivery: Delivery }) {
  const save = (scheduledAt: string | null) =>
    void patchDelivery(order, delivery.seq, { scheduledAt });

  return (
    <div className={`field schedule ${delivery.scheduledAt ? 'set' : ''}`}>
      <span className="field-label">Agendamento</span>
      {delivery.scheduledAt ? (
        <>
          <input
            type="date"
            className="date-input"
            value={delivery.scheduledAt}
            aria-label={`Data do agendamento de ${delivery.name}`}
            onChange={(event) => save(event.target.value || null)}
          />
          <button type="button" className="link-btn" onClick={() => save(null)}>
            remover
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => save(order.deliveryDate ?? todayISO())}
          >
            Já agendado
          </button>
          <input
            type="date"
            className="date-input"
            value=""
            aria-label={`Agendar ${delivery.name} para outra data`}
            onChange={(event) => save(event.target.value || null)}
          />
        </>
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
          <input
            type="date"
            className="date-input"
            value={delivery.resaleDate ?? ''}
            aria-label="Data prevista da revenda"
            onChange={(event) => patch({ resaleDate: event.target.value || null })}
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const stored = delivery.attachments ?? [];
  const files = stored.filter((item) => item.kind === 'arquivo');
  const resumo = stored.find((item) => item.kind === 'resumo');
  const pendingJobs =
    useLiveQuery(() => db.files.where('orderId').equals(order.id).toArray(), [order.id]) ?? [];
  const queued = pendingJobs.filter((job) => job.seq === delivery.seq);

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
      </div>
      {feedback && <p className="attach-error">{feedback}</p>}

      {files.length === 0 && queued.length === 0 && (
        <p className="field-hint">
          Nenhum arquivo ainda — anexe a foto da balança, a nota ou a planilha da conferência.
        </p>
      )}

      <ul className="attach-list">
        {files.map((item) => (
          <AttachmentRow key={item.id} item={item} />
        ))}
        {queued.map((job) => (
          <li key={`fila-${job.id}`} className="attach-item fila">
            <span
              className={`attach-icon ${isPhoto(job.mime) ? 'photo' : 'doc'}`}
              aria-hidden="true"
            />
            <span className="attach-name">{job.name}</span>
            <span className="attach-meta">
              {fmtBytes(job.bytes)} ·{' '}
              {job.error ? `falha: ${job.error}` : 'enviando para a pasta de relatórios'}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => job.id != null && void removeQueuedFile(job.id)}
            >
              cancelar
            </button>
          </li>
        ))}
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

function AttachmentRow({ item }: { item: Attachment }) {
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
    </li>
  );
}
