import { useMemo, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import {
  FINAL_STATUSES,
  STATUS_LABEL,
  TYPE_CLASS,
  TYPE_LABEL,
  TYPE_ORDER,
  TYPE_SOURCE,
  type Delivery,
  type DeliveryStatus,
  type OrderType,
} from '../types';
import { fmtKg } from '../utils';
import { PERIODOS, limites, type Periodo } from '../periodo';

const STATUS_ORDEM: DeliveryStatus[] = ['pendente', 'em_rota', 'no_cliente', 'entregue', 'recusado'];

export function LogisticaDashboardScreen() {
  const inicial = limites('30d');
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [de, setDe] = useState(inicial.de);
  const [ate, setAte] = useState(inicial.ate);

  const escolherPeriodo = (opcao: Periodo) => {
    const faixa = limites(opcao);
    setPeriodo(opcao);
    setDe(faixa.de);
    setAte(faixa.ate);
  };

  const pedidos = useLiveQuery(
    () => db.orders.where('deliveryDate').between(de, ate, true, true).toArray(),
    [de, ate],
  );

  const dados = useMemo(() => {
    const entregas: Delivery[] = [];
    const clientes = new Set<string>();
    let kg = 0;
    const porStatus = new Map<DeliveryStatus, number>();
    const porTipo = new Map<OrderType, { pedidos: number; entregas: number; finalizadas: number }>();

    for (const order of pedidos ?? []) {
      kg += order.totalKg ?? 0;
      const tipo = porTipo.get(order.type) ?? { pedidos: 0, entregas: 0, finalizadas: 0 };
      tipo.pedidos += 1;
      for (const delivery of order.deliveries) {
        entregas.push(delivery);
        if (delivery.name.trim()) clientes.add(delivery.name.trim());
        porStatus.set(delivery.status, (porStatus.get(delivery.status) ?? 0) + 1);
        tipo.entregas += 1;
        if (FINAL_STATUSES.includes(delivery.status)) tipo.finalizadas += 1;
      }
      porTipo.set(order.type, tipo);
    }

    const total = entregas.length;
    const finalizadas = entregas.filter((delivery) => FINAL_STATUSES.includes(delivery.status)).length;
    return {
      pedidos: (pedidos ?? []).length,
      entregas: total,
      finalizadas,
      percentual: total ? Math.round((finalizadas / total) * 100) : 0,
      anomalias: entregas.filter((delivery) => Boolean(delivery.reason)).length,
      recusadas: entregas.filter((delivery) => delivery.status === 'recusado').length,
      clientes: clientes.size,
      kg,
      porStatus: STATUS_ORDEM.map((status) => ({
        status,
        total: porStatus.get(status) ?? 0,
        fracao: total ? (porStatus.get(status) ?? 0) / total : 0,
      })),
      porTipo: [...porTipo.entries()]
        .sort(([a], [b]) => TYPE_ORDER[a] - TYPE_ORDER[b])
        .map(([tipo, numeros]) => ({ tipo, ...numeros })),
    };
  }, [pedidos]);

  const carregando = pedidos === undefined;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Logística</span>
            <h2>Dashboard logístico</h2>
            <p className="panel-sub">
              Entregas com data entre {de.split('-').reverse().join('/')} e{' '}
              {ate.split('-').reverse().join('/')} · {dados.pedidos} pedido
              {dados.pedidos === 1 ? '' : 's'} · {dados.clientes} cliente
              {dados.clientes === 1 ? '' : 's'}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Período do dashboard">
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

      {carregando ? (
        <section className="empty">
          <h3>Carregando…</h3>
        </section>
      ) : (
        <>
          <section className="stat-grid">
            <article className="stat">
              <span>Pedidos</span>
              <strong>{dados.pedidos}</strong>
              <small>{dados.kg > 0 ? fmtKg(dados.kg) : 'peso não informado'}</small>
            </article>
            <article className="stat">
              <span>Entregas</span>
              <strong>{dados.entregas}</strong>
              <small>no período selecionado</small>
            </article>
            <article className="stat stat-completion">
              <div
                className="stat-ring"
                style={{ '--pct': dados.percentual } as CSSProperties}
                aria-hidden="true"
              >
                <span>{dados.percentual}%</span>
              </div>
              <div className="stat-copy">
                <span>Finalizadas</span>
                <strong>
                  {dados.finalizadas}
                  <em>/{dados.entregas}</em>
                </strong>
                <small>entregues ou recusadas</small>
              </div>
            </article>
            <article className={`stat ${dados.anomalias > 0 ? 'warn' : 'ok'}`}>
              <span>Anomalias</span>
              <strong>{dados.anomalias}</strong>
              <small>
                {dados.recusadas > 0
                  ? `${dados.recusadas} recusada${dados.recusadas === 1 ? '' : 's'}`
                  : 'nenhuma recusa'}
              </small>
            </article>
          </section>

          <section className="panel logistica-status">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Situação</span>
                <h2 className="panel-title-sm">Entregas por status</h2>
              </div>
            </div>
            {dados.entregas === 0 ? (
              <p className="panel-sub">Nenhuma entrega no período.</p>
            ) : (
              <ul className="status-list">
                {dados.porStatus.map((item) => (
                  <li key={item.status}>
                    <span className={`status-pill ${item.status}`}>
                      <span className={`dot ${item.status}`} aria-hidden="true" />
                      {STATUS_LABEL[item.status]}
                    </span>
                    <span className="status-bar" aria-hidden="true">
                      <i style={{ width: `${item.fracao * 100}%` }} />
                    </span>
                    <span className="status-count">
                      {item.total}
                      <em>{Math.round(item.fracao * 100)}%</em>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel logistica-tipos">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Por tipo</span>
                <h2 className="panel-title-sm">Pedidos e entregas por tipo</h2>
              </div>
            </div>
            {dados.porTipo.length === 0 ? (
              <p className="panel-sub">Nenhum pedido no período.</p>
            ) : (
              <div className="pedidos-table-wrap">
                <table className="pedidos-table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Descrição</th>
                      <th>Pedidos</th>
                      <th>Entregas</th>
                      <th>Finalizadas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.porTipo.map((linha) => (
                      <tr key={linha.tipo}>
                        <td>
                          <span className={`type-pill ${TYPE_CLASS[linha.tipo]}`}>
                            {TYPE_SOURCE[linha.tipo]}
                          </span>
                        </td>
                        <td>{TYPE_LABEL[linha.tipo]}</td>
                        <td className="pedido-destinos">{linha.pedidos}</td>
                        <td className="pedido-destinos">{linha.entregas}</td>
                        <td className="pedido-destinos">
                          {linha.finalizadas}
                          <em className="tipo-percentual">
                            {linha.entregas
                              ? ` · ${Math.round((linha.finalizadas / linha.entregas) * 100)}%`
                              : ''}
                          </em>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
