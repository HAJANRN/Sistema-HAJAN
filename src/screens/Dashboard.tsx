import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import {
  FINAL_STATUSES,
  REASON_LABEL,
  STATUS_LABEL,
  TYPE_LABEL,
  TYPE_SOURCE,
  isSchedulable,
  type Delivery,
  type Order,
} from '../types';
import {
  fmtDate,
  fmtEta,
  fmtKg,
  isoWeek,
  mondayOfIsoWeek,
  parseISO,
  shiftISO,
  todayISO,
  weekdayShort,
} from '../utils';

type Filter = 'all' | 'CXS' | 'PCS';
type SituationFilter = 'aberto' | 'finalizado';

/** Pedido sem nenhuma entrega pendente ou em rota. */
const isFinalizado = (order: Order) =>
  order.deliveries.length > 0 && order.deliveries.every((d) => FINAL_STATUSES.includes(d.status));
type View = 'day' | 'week';

const VIEW_KEY = 'expedicao-view';

interface Props {
  date: string;
  onDateChange: (date: string) => void;
  onOpenOrder: (id: string) => void;
  onShowImport: () => void;
  offline: boolean;
}

const mondayOf = (iso: string) => shiftISO(iso, -((parseISO(iso).getDay() + 6) % 7));

export function Dashboard({ date, onDateChange, onOpenOrder, onShowImport, offline }: Props) {
  const [view, setView] = useState<View>(() =>
    localStorage.getItem(VIEW_KEY) === 'day' ? 'day' : 'week',
  );
  const [filter, setFilter] = useState<Filter>('all');
  const [situation, setSituation] = useState<SituationFilter | null>(null);
  const [query, setQuery] = useState('');
  const [client, setClient] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeChip = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    const strip = stripRef.current;
    const chip = activeChip.current;
    if (!strip || !chip) return;
    const chipRect = chip.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    strip.scrollLeft += chipRect.left - stripRect.left - (stripRect.width - chipRect.width) / 2;
  }, [date, view]);

  const monday = useMemo(() => mondayOf(date), [date]);
  const sunday = useMemo(() => shiftISO(monday, 6), [monday]);
  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, index) => shiftISO(monday, index)),
    [monday],
  );

  const dayOrders = useLiveQuery(
    () => db.orders.where('deliveryDate').equals(date).toArray(),
    [date],
  );
  const weekOrders = useLiveQuery(
    () => db.orders.where('deliveryDate').between(monday, sunday, true, true).toArray(),
    [monday, sunday],
  );
  const stripData = useLiveQuery(async () => {
    const from = shiftISO(date, -7);
    const to = shiftISO(date, 7);
    const list = await db.orders.where('deliveryDate').between(from, to, true, true).toArray();
    const map = new Map<string, number>();
    for (const order of list) {
      map.set(order.deliveryDate!, (map.get(order.deliveryDate!) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [date]);

  const sourceOrders = view === 'day' ? dayOrders : weekOrders;

  const orders = useMemo(() => {
    const list = (sourceOrders ?? []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'PCS' ? -1 : 1;
      return a.number - b.number;
    });
    const term = query.trim().toLowerCase();
    return list.filter((order) => {
      if (filter !== 'all' && order.type !== filter) return false;
      if (situation && isFinalizado(order) !== (situation === 'finalizado')) return false;
      if (!term) return true;
      const haystack = [
        String(order.number),
        order.route,
        order.revision,
        order.client ?? '',
        ...order.deliveries.map((d) => `${d.name} ${d.city} ${d.uf}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [sourceOrders, filter, situation, query]);

  /** O seletor lista os clientes das entregas do período que está na tela. */
  const clientNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const order of sourceOrders ?? []) {
      for (const delivery of order.deliveries) {
        const name = delivery.name.trim();
        if (!name) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }, [sourceOrders]);

  const clientOrderList = useLiveQuery(
    () =>
      client
        ? db.orders
            .filter((order) => order.deliveries.some((d) => d.name.trim() === client))
            .toArray()
        : Promise.resolve([] as Order[]),
    [client],
  );

  /** Cliente escolhido atravessa as semanas: agenda dele fora da semana da tela também aparece. */
  const agenda = useMemo(() => {
    if (!client) return null;
    const term = query.trim().toLowerCase();
    const rows: { order: Order; delivery: Delivery }[] = [];
    for (const order of clientOrderList ?? []) {
      if (!order.deliveryDate) continue;
      if (filter !== 'all' && order.type !== filter) continue;
      for (const delivery of order.deliveries) {
        if (delivery.name.trim() !== client) continue;
        const finalizada = FINAL_STATUSES.includes(delivery.status);
        if (situation && finalizada !== (situation === 'finalizado')) continue;
        if (
          term &&
          !`${order.number} ${order.route} ${order.revision} ${delivery.city} ${delivery.uf}`
            .toLowerCase()
            .includes(term)
        )
          continue;
        rows.push({ order, delivery });
      }
    }
    rows.sort(
      (a, b) =>
        a.order.deliveryDate!.localeCompare(b.order.deliveryDate!) ||
        a.delivery.seq - b.delivery.seq,
    );
    const byWeek = new Map<string, { label: string; list: typeof rows }>();
    for (const row of rows) {
      const { year, week } = isoWeek(row.order.deliveryDate!);
      const key = `${year}-${week}`;
      const group = byWeek.get(key) ?? { label: '', list: [] };
      group.list.push(row);
      byWeek.set(key, group);
    }
    return [...byWeek.entries()].map(([key, group]) => {
      const [year, week] = key.split('-');
      const monday = mondayOfIsoWeek(Number(year), Number(week));
      return {
        key,
        label: `Semana ${week} · ${fmtDate(monday)} – ${fmtDate(shiftISO(monday, 6))}`,
        list: group.list,
      };
    });
  }, [client, clientOrderList, filter, situation, query]);

  const clientOptions = useMemo(() => {
    const names = [...clientNames.keys()];
    if (client && !clientNames.has(client)) names.push(client);
    return names.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [clientNames, client]);

  const filtrando =
    filter !== 'all' || situation !== null || query.trim() !== '' || client !== null;

  const weekGroups = useMemo(() => {
    if (view !== 'week') return null;
    const byDate = new Map<string, Order[]>();
    for (const order of orders) {
      const list = byDate.get(order.deliveryDate!) ?? [];
      list.push(order);
      byDate.set(order.deliveryDate!, list);
    }
    return weekDates
      .map((iso) => ({ iso, list: byDate.get(iso) ?? [] }))
      .filter((group) => group.list.length > 0);
  }, [view, orders, weekDates]);

  const stats = useMemo(() => {
    const deliveries: Delivery[] = agenda
      ? agenda.flatMap((group) => group.list.map((row) => row.delivery))
      : orders.flatMap((order) => order.deliveries);
    const pedidoCount = agenda
      ? new Set(agenda.flatMap((group) => group.list.map((row) => row.order.id))).size
      : orders.length;
    const kg = agenda
      ? deliveries.reduce((sum, delivery) => sum + (delivery.weightKg ?? 0), 0)
      : orders.reduce((sum, order) => sum + (order.totalKg ?? 0), 0);
    return {
      orders: pedidoCount,
      deliveries: deliveries.length,
      entregues: deliveries.filter((d) => d.status === 'entregue').length,
      emRota: deliveries.filter((d) => d.status === 'em_rota').length,
      recusadas: deliveries.filter((d) => d.status === 'recusada').length,
      kg,
    };
  }, [orders, agenda]);

  const isToday = date === todayISO();
  const strip = useMemo(() => {
    const counts = new Map(stripData ?? []);
    return Array.from({ length: 15 }, (_, index) => {
      const iso = shiftISO(date, index - 7);
      return { iso, count: counts.get(iso) ?? 0 };
    });
  }, [stripData, date]);

  const weekCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const order of weekOrders ?? []) {
      counts.set(order.deliveryDate!, (counts.get(order.deliveryDate!) ?? 0) + 1);
    }
    return counts;
  }, [weekOrders]);

  const loading = sourceOrders === undefined;
  const periodLabel = view === 'day' ? 'do dia' : 'da semana';
  const weekInfo = useMemo(() => isoWeek(monday), [monday]);
  const weekCount = useMemo(() => isoWeek(`${weekInfo.year}-12-28`).week, [weekInfo.year]);
  const weekLabel = `${weekInfo.week}${weekInfo.year === parseISO(monday).getFullYear() ? '' : ` · ${weekInfo.year}`}`;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">
              {agenda
                ? 'Agenda do cliente'
                : view === 'week'
                  ? `Semana ${weekLabel}`
                  : isToday
                    ? 'Hoje'
                    : 'Programação'}
            </span>
            <h2 className={agenda ? 'client-title' : undefined}>
              {agenda ? (
                client
              ) : view === 'week' ? (
                <>
                  {fmtDate(monday)} – {fmtDate(sunday)}
                </>
              ) : (
                <>
                  {weekdayShort(date)}, {fmtDate(date)}
                  <span className="title-week">sem {weekLabel}</span>
                </>
              )}
            </h2>
            <p className="panel-sub">
              {agenda ? (
                <>
                  {stats.deliveries} entrega{stats.deliveries === 1 ? '' : 's'} em {stats.orders}{' '}
                  pedido{stats.orders === 1 ? '' : 's'} · {agenda.length} semana
                  {agenda.length === 1 ? '' : 's'}
                </>
              ) : (
                <>
                  {stats.orders} pedido{stats.orders === 1 ? '' : 's'} · {stats.deliveries} entrega
                  {stats.deliveries === 1 ? '' : 's'}
                </>
              )}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Visualização">
              {(['week', 'day'] as View[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={view === option ? 'active' : ''}
                  onClick={() => setView(option)}
                >
                  {option === 'week' ? 'Semana' : 'Dia'}
                </button>
              ))}
            </div>
            {view === 'week' && (
              <label className="week-jump">
                <span>Semana</span>
                <select
                  aria-label="Ir para a semana"
                  value={weekInfo.week}
                  onChange={(event) =>
                    onDateChange(mondayOfIsoWeek(weekInfo.year, Number(event.target.value)))
                  }
                >
                  {Array.from({ length: weekCount }, (_, index) => index + 1).map((week) => (
                    <option key={week} value={week}>
                      {week}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="date-nav">
              <button
                type="button"
                className="btn ghost"
                onClick={() => onDateChange(shiftISO(date, view === 'week' ? -7 : -1))}
                aria-label={view === 'week' ? 'Semana anterior' : 'Dia anterior'}
              >
                ‹
              </button>
              <button type="button" className="btn" onClick={() => onDateChange(todayISO())}>
                Hoje
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => onDateChange(shiftISO(date, view === 'week' ? 7 : 1))}
                aria-label={view === 'week' ? 'Próxima semana' : 'Próximo dia'}
              >
                ›
              </button>
            </div>
          </div>
        </div>

        <div
          className="date-strip"
          role="tablist"
          aria-label={view === 'week' ? 'Dias da semana' : 'Escolher data de entrega'}
          ref={stripRef}
        >
          {(view === 'week'
            ? weekDates.map((iso) => ({ iso, count: weekCounts.get(iso) ?? 0 }))
            : strip
          ).map(({ iso, count }) => (
            <button
              key={iso}
              type="button"
              role="tab"
              aria-selected={iso === date}
              ref={iso === date ? activeChip : undefined}
              className={`date-chip ${iso === date ? 'active' : ''} ${iso === todayISO() ? 'today' : ''}`}
              onClick={() => {
                onDateChange(iso);
                if (view === 'week') setView('day');
              }}
            >
              <span className="date-chip-week">{weekdayShort(iso)}</span>
              <span className="date-chip-day">{fmtDate(iso)}</span>
              <span className={`date-chip-count ${count ? '' : 'empty'}`}>{count || '·'}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="stat-grid">
        <article className="stat">
          <span>Pedidos</span>
          <strong>{stats.orders}</strong>
          <small>{stats.kg > 0 ? fmtKg(stats.kg) : 'peso não informado'}</small>
        </article>
        <article className="stat">
          <span>Entregas</span>
          <strong>{stats.deliveries}</strong>
          <small>no total {periodLabel}</small>
        </article>
        <article className="stat ok">
          <span>Entregues</span>
          <strong>
            {stats.entregues}
            <em>/{stats.deliveries}</em>
          </strong>
          <small>
            {stats.deliveries ? Math.round((stats.entregues / stats.deliveries) * 100) : 0}%
            concluído
          </small>
        </article>
        <article className="stat warn">
          <span>Em rota</span>
          <strong>{stats.emRota}</strong>
          <small>
            {stats.recusadas > 0
              ? `${stats.recusadas} anomalia${stats.recusadas === 1 ? '' : 's'}`
              : 'nenhuma anomalia'}
          </small>
        </article>
      </section>

      <section className="toolbar">
        <div className="segmented" role="group" aria-label="Filtrar tipo de carne">
          {(['all', 'PCS', 'CXS'] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              className={filter === option ? 'active' : ''}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? 'Todos' : TYPE_LABEL[option]}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Filtrar situação do pedido">
          {(['aberto', 'finalizado'] as SituationFilter[]).map((option) => (
            <button
              key={option}
              type="button"
              className={situation === option ? 'active' : ''}
              aria-pressed={situation === option}
              onClick={() => setSituation(situation === option ? null : option)}
            >
              {option === 'aberto' ? 'Em aberto' : 'Finalizados'}
            </button>
          ))}
        </div>
        <label className="client-jump">
          <span>Cliente</span>
          <select
            aria-label="Filtrar por cliente"
            value={client ?? ''}
            onChange={(event) => setClient(event.target.value || null)}
          >
            <option value="">Todos os clientes</option>
            {clientOptions.map((name) => (
              <option key={name} value={name}>
                {name} · {clientNames.get(name) ?? 0}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          className="search"
          placeholder="Pedido, rota, cliente ou cidade"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </section>

      {loading ? (
        <section className="empty">
          <h3>Carregando…</h3>
        </section>
      ) : agenda ? (
        agenda.length === 0 ? (
          <section className="empty">
            <h3>Nenhuma entrega de {client} com este filtro</h3>
            <p>
              O app conhece as entregas dos últimos 45 dias e dos próximos 90.{' '}
              <button type="button" className="link" onClick={() => setClient(null)}>
                Voltar para todos os clientes
              </button>
            </p>
          </section>
        ) : (
          agenda.map((group) => (
            <section key={group.key} className="week-group">
              <header className="week-day-head">
                <h3>{group.label}</h3>
                <span className="week-day-sub">
                  {group.list.length} entrega{group.list.length === 1 ? '' : 's'} para {client}
                </span>
              </header>
              <ul className="agenda-list">
                {group.list.map(({ order, delivery }) => (
                  <li
                    key={`${order.id}-${delivery.seq}`}
                    className={`agenda-row ${order.deliveryDate! < todayISO() ? 'passada' : ''}`}
                  >
                    <span className="agenda-day">
                      <strong>{fmtDate(order.deliveryDate)}</strong>
                      <small>{weekdayShort(order.deliveryDate!)}</small>
                    </span>
                    <span className="agenda-order">
                      <span className={`type-pill ${order.type === 'PCS' ? 'osso' : 'caixaria'}`}>
                        {TYPE_SOURCE[order.type]}
                      </span>
                      <strong>{order.number}</strong>
                      <span className="rev">{order.revision}</span>
                      <span className="route-pill">{order.route}</span>
                    </span>
                    <span className="agenda-place">
                      <span className="agenda-seq">#{delivery.seq}</span>
                      {delivery.city}
                      {delivery.uf ? `-${delivery.uf}` : ''}
                    </span>
                    <span className="agenda-when">
                      {delivery.scheduledAt
                        ? `agendado ${fmtDate(delivery.scheduledAt)}`
                        : delivery.eta
                          ? `previsão ${fmtEta(delivery.eta, order.deliveryDate)}`
                          : 'sem horário'}
                    </span>
                    <span className={`status-pill ${delivery.status}`}>
                      <span className={`dot ${delivery.status}`} aria-hidden="true" />
                      {STATUS_LABEL[delivery.status]}
                    </span>
                    {delivery.reason && (
                      <em className="flag recusa">{REASON_LABEL[delivery.reason]}</em>
                    )}
                    {delivery.resale === true && <em className="flag revenda">revenda</em>}
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onOpenOrder(order.id)}
                    >
                      Abrir
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )
      ) : view === 'week' ? (
        weekGroups!.length === 0 ? (
          <section className="empty">
            <h3>{filtrando ? 'Nenhum pedido com este filtro' : 'Nenhum pedido nesta semana'}</h3>
            {!filtrando && !offline && (
              <>
                <p>
                  As planilhas dos pedidos são lidas das pastas <code>@@ ResumoSemanal CXS</code> e{' '}
                  <code>@@ ResumoSemanal PÇS</code> na rede.
                </p>
                <button type="button" className="btn" onClick={onShowImport}>
                  Ver importação
                </button>
              </>
            )}
            {!filtrando && offline && (
              <p>
                Sem conexão com o servidor local. Exibindo apenas o que já foi importado neste
                computador.
              </p>
            )}
          </section>
        ) : (
          weekGroups!.map((group) => {
            const deliveries = group.list.flatMap((order) => order.deliveries);
            const entregues = deliveries.filter((d) => d.status === 'entregue').length;
            return (
              <section key={group.iso} className="week-group">
                <header className="week-day-head">
                  <h3>
                    {weekdayShort(group.iso)}, {fmtDate(group.iso)}
                  </h3>
                  <span className="week-day-sub">
                    {group.list.length} pedido
                    {group.list.length === 1 ? '' : 's'} · {deliveries.length} entregas ·{' '}
                    {entregues} entregue{entregues === 1 ? '' : 's'}
                  </span>
                </header>
                <div className="order-grid">
                  {group.list.map((order) => (
                    <OrderCard key={order.id} order={order} onOpen={() => onOpenOrder(order.id)} />
                  ))}
                </div>
              </section>
            );
          })
        )
      ) : orders.length === 0 ? (
        <section className="empty">
          <h3>{filtrando ? 'Nenhum pedido com este filtro' : 'Nenhum pedido para esta data'}</h3>
          {dayOrders?.length === 0 && !offline && (
            <>
              <p>
                As planilhas dos pedidos são lidas das pastas <code>@@ ResumoSemanal CXS</code> e{' '}
                <code>@@ ResumoSemanal PÇS</code> na rede.
              </p>
              <button type="button" className="btn" onClick={onShowImport}>
                Ver importação
              </button>
            </>
          )}
          {offline && (
            <p>
              Sem conexão com o servidor local. Exibindo apenas o que já foi importado neste
              computador.
            </p>
          )}
        </section>
      ) : (
        <section className="order-grid">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} onOpen={() => onOpenOrder(order.id)} />
          ))}
        </section>
      )}
    </>
  );
}

function OrderCard({ order, onOpen }: { order: Order; onOpen: () => void }) {
  const total = order.deliveries.length;
  const entregues = order.deliveries.filter((d) => d.status === 'entregue').length;
  const finalizadas = order.deliveries.filter((d) => FINAL_STATUSES.includes(d.status)).length;
  const recusadas = order.deliveries.filter((d) => d.status === 'recusada').length;
  const agendaveis = order.deliveries.filter((d) => isSchedulable(d.name)).length;
  const agendadas = order.deliveries.filter((d) => d.scheduledAt).length;
  const percent = total ? Math.round((finalizadas / total) * 100) : 0;

  return (
    <article className={`order-card ${order.type === 'PCS' ? 'osso' : 'caixaria'}`}>
      <header>
        <div className="order-title">
          <span className={`type-pill ${order.type === 'PCS' ? 'osso' : 'caixaria'}`}>
            {TYPE_SOURCE[order.type]}
          </span>
          <strong>{order.number}</strong>
          <span className="rev">{order.revision}</span>
          {order.pendingSync && <span className="sync-dot" title="Alterações aguardando envio" />}
        </div>
        <span className="route-pill">{order.route}</span>
      </header>

      <div className="order-meta">
        <span>{total} entregas</span>
        <span className="dot-sep" aria-hidden="true">
          •
        </span>
        <span>{order.totalKg != null ? fmtKg(order.totalKg) : 'sem peso'}</span>
        {order.type === 'CXS' && agendaveis > 0 && (
          <span className={`agenda-flag ${agendadas === agendaveis ? 'ok' : ''}`}>
            {agendadas}/{agendaveis} agendadas
          </span>
        )}
        {recusadas > 0 && (
          <span className="recusa-flag">
            {recusadas} anomalia{recusadas === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="progress" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-caption">
        <span>
          {entregues}/{total} entregues
        </span>
        <span>{percent}%</span>
      </div>

      <ul className="mini-deliveries">
        {order.deliveries.slice(0, 4).map((delivery) => (
          <li key={delivery.seq}>
            <span className={`dot ${delivery.status}`} aria-hidden="true" />
            <span className="mini-name">{delivery.name}</span>
            <span className="mini-city">
              {delivery.city}
              {delivery.eta ? ` · ${fmtEta(delivery.eta, order.deliveryDate)}` : ''}
            </span>
            {(delivery.scheduledAt || delivery.reason || delivery.resale === true) && (
              <span className="mini-flags">
                {delivery.scheduledAt && <em className="flag agenda">agendada</em>}
                {delivery.reason && (
                  <em className="flag recusa">{REASON_LABEL[delivery.reason]}</em>
                )}
                {delivery.resale === true && <em className="flag revenda">revenda</em>}
              </span>
            )}
          </li>
        ))}
        {total > 4 && <li className="more">+{total - 4} outras entregas</li>}
      </ul>

      <footer>
        <span className="footer-date">embarque {fmtDate(order.shipDate)}</span>
        <button type="button" className="btn" onClick={onOpen}>
          Ver entregas
        </button>
      </footer>
    </article>
  );
}
