import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import {
  REASON_LABEL,
  STATUS_LABEL,
  TYPE_CLASS,
  TYPE_SOURCE,
  type Delivery,
  type Order,
} from '../types';
import { fmtDate } from '../utils';
import { PERIODOS, limites, type Periodo } from '../periodo';

interface Props {
  onOpenOrder: (id: string) => void;
}

export function AnomaliasScreen({ onOpenOrder }: Props) {
  const inicial = limites('30d');
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [de, setDe] = useState(inicial.de);
  const [ate, setAte] = useState(inicial.ate);
  const [busca, setBusca] = useState('');

  const pedidos = useLiveQuery(
    () => db.orders.where('deliveryDate').between(de, ate, true, true).toArray(),
    [de, ate],
  );

  const escolherPeriodo = (opcao: Periodo) => {
    const faixa = limites(opcao);
    setPeriodo(opcao);
    setDe(faixa.de);
    setAte(faixa.ate);
  };

  const linhas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const rows: { order: Order; delivery: Delivery }[] = [];
    for (const order of pedidos ?? []) {
      for (const delivery of order.deliveries) {
        if (!delivery.reason) continue;
        if (
          termo &&
          !`${order.number} ${order.route} ${delivery.name} ${delivery.city} ${delivery.uf}`
            .toLowerCase()
            .includes(termo)
        ) {
          continue;
        }
        rows.push({ order, delivery });
      }
    }
    rows.sort(
      (a, b) =>
        (b.order.deliveryDate ?? '').localeCompare(a.order.deliveryDate ?? '') ||
        a.delivery.seq - b.delivery.seq,
    );
    return rows;
  }, [pedidos, busca]);

  const resumo = useMemo(() => {
    const pedidoIds = new Set(linhas.map((linha) => linha.order.id));
    const clientes = new Set(linhas.map((linha) => linha.delivery.name));
    const recusadas = linhas.filter((linha) => linha.delivery.status === 'recusado').length;
    return { pedidos: pedidoIds.size, clientes: clientes.size, recusadas };
  }, [linhas]);

  const carregando = pedidos === undefined;
  const periodoInvalido = de > ate;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Logística</span>
            <h2>Anomalias nas entregas</h2>
            <p className="panel-sub">
              {carregando
                ? 'Carregando as entregas do período…'
                : `${linhas.length} ocorrência${linhas.length === 1 ? '' : 's'} em ${resumo.pedidos} pedido${resumo.pedidos === 1 ? '' : 's'} · ${resumo.clientes} cliente${resumo.clientes === 1 ? '' : 's'}${resumo.recusadas > 0 ? ` · ${resumo.recusadas} recusada${resumo.recusadas === 1 ? '' : 's'}` : ''}`}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Período das anomalias">
              {PERIODOS.map((opcao) => (
                <button
                  key={opcao.id}
                  type="button"
                  className={periodo === opcao.id ? 'active' : ''}
                  aria-pressed={periodo === opcao.id}
                  onClick={() => escolherPeriodo(opcao.id)}
                >
                  {opcao.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <label className="periodo-jump">
          <span>Entregas de</span>
          <input
            type="date"
            value={de}
            max={ate}
            onChange={(evento) => setDe(evento.target.value)}
          />
        </label>
        <label className="periodo-jump">
          <span>até</span>
          <input
            type="date"
            value={ate}
            min={de}
            onChange={(evento) => setAte(evento.target.value)}
          />
        </label>
        <input
          type="search"
          className="search"
          placeholder="Pedido, cliente, cidade ou motivo"
          value={busca}
          onChange={(evento) => setBusca(evento.target.value)}
        />
      </section>

      {periodoInvalido ? (
        <section className="empty">
          <h3>A data final é anterior à inicial</h3>
          <p>Ajuste o período para ver as anomalias.</p>
        </section>
      ) : carregando ? (
        <section className="empty">
          <h3>Carregando…</h3>
        </section>
      ) : linhas.length === 0 ? (
        <section className="empty">
          <h3>Nenhuma anomalia no período</h3>
          <p>
            {busca.trim()
              ? 'Nenhuma entrega registrada com este filtro.'
              : 'As entregas marcadas com motivo de recusa ou falta aparecem aqui.'}
          </p>
        </section>
      ) : (
        <div className="pedidos-table-wrap">
          <table className="pedidos-table anomalias-table">
            <thead>
              <tr>
                <th>Entrega</th>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Cidade</th>
                <th>Motivo</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {linhas.map(({ order, delivery }) => (
                <tr key={`${order.id}-${delivery.seq}`}>
                  <td className="pedido-data">
                    {fmtDate(order.deliveryDate) || '—'}
                    <span className="anomalia-seq">#{delivery.seq}</span>
                  </td>
                  <td>
                    <span className={`type-pill ${TYPE_CLASS[order.type]}`}>
                      {TYPE_SOURCE[order.type]}
                    </span>{' '}
                    <span className="pedido-num">{order.number}</span>
                  </td>
                  <td>{delivery.name || '—'}</td>
                  <td className="anomalia-cidade">
                    {delivery.city}
                    {delivery.uf ? `-${delivery.uf}` : ''}
                  </td>
                  <td>
                    <em className="flag recusa">
                      {delivery.reason ? REASON_LABEL[delivery.reason] ?? delivery.reason : '—'}
                    </em>
                  </td>
                  <td>
                    <span className={`status-pill ${delivery.status}`}>
                      <span className={`dot ${delivery.status}`} aria-hidden="true" />
                      {STATUS_LABEL[delivery.status]}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onOpenOrder(order.id)}
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
