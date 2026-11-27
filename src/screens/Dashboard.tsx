import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import {
  FINAL_STATUSES,
  REASON_LABEL,
  STATUS_LABEL,
  TYPE_CLASS,
  TYPE_LABEL,
  TYPE_ORDER,
  TYPE_SOURCE,
  deliveryHasProduct,
  invoiceKindOf,
  invoicesForDelivery,
  isEscDelivery,
  isSchedulable,
  productKey,
  productLabel,
  type Delivery,
  type Order,
} from '../types';
import {
  fmtDate,
  fmtEta,
  fmtKg,
  fmtMoney,
  isoWeek,
  mondayOfIsoWeek,
  parseISO,
  shiftISO,
  todayISO,
  weekdayShort,
} from '../utils';

type Filter = 'all' | 'CXS' | 'PCS' | 'CHQ' | 'SPG';
type SituationFilter = 'aberto' | 'finalizado';

/** Pedido sem nenhuma entrega pendente ou no cliente. */
const isFinalizado = (order: Order) =>
  order.deliveries.length > 0 && order.deliveries.every((d) => FINAL_STATUSES.includes(d.status));
type View = 'all' | 'day' | 'week';

const VIEW_KEY = 'expedicao-view';
const VIEWS: View[] = ['all', 'week', 'day'];
const readView = (): View => {
  const saved = localStorage.getItem(VIEW_KEY);
  return VIEWS.includes(saved as View) ? (saved as View) : 'week';
};

interface Props {
  date: string;
  onDateChange: (date: string) => void;
  onOpenOrder: (id: string) => void;
  onShowImport: () => void;
  offline: boolean;
}

const mondayOf = (iso: string) => shiftISO(iso, -((parseISO(iso).getDay() + 6) % 7));

export function Dashboard({ date, onDateChange, onOpenOrder, onShowImport, offline }: Props) {
  const [view, setView] = useState<View>(readView);
  const [filter, setFilter] = useState<Filter>('all');
  const [situation, setSituation] = useState<SituationFilter | null>(null);
  const [query, setQuery] = useState('');
  const [client, setClient] = useState<string | null>(null);
  const [product, setProduct] = useState<string | null>(null);
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
  const allOrders = useLiveQuery(
    () => db.orders.filter((order) => Boolean(order.deliveryDate)).toArray(),
    [],
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

  const sourceOrders = view === 'day' ? dayOrders : view === 'week' ? weekOrders : allOrders;

  const orders = useMemo(() => {
    const list = (sourceOrders ?? []).slice().sort((a, b) => {
      if (view === 'all' && a.deliveryDate !== b.deliveryDate) {
        return (a.deliveryDate ?? '').localeCompare(b.deliveryDate ?? '');
      }
      if (a.type !== b.type) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      return a.number - b.number;
    });
    const term = query.trim().toLowerCase();
    return list.filter((order) => {
      if (filter !== 'all' && order.type !== filter) return false;
      if (product && !order.deliveries.some((delivery) => deliveryHasProduct(delivery, product)))
        return false;
      if (situation && isFinalizado(order) !== (situation === 'finalizado')) return false;
      if (!term) return true;
      const haystack = [
        String(order.number),
        order.route,
        order.revision,
        order.client ?? '',
        order.plates ?? '',
        order.branchInstruction ?? '',
        order.billing?.status ?? '',
        order.billing?.deliveryStatus ?? '',
        ...(order.billing?.invoices ?? []).map(
          (invoice) => `${invoice.number} ${invoice.series ?? ''}`,
        ),
        ...(order.billing?.clients ?? []),
        ...(order.billing?.cities ?? []),
        ...order.deliveries.map((d) => `${d.name} ${d.city} ${d.uf}`),
        ...order.deliveries.flatMap((d) =>
          (d.products ?? []).map((item) => `${item.code} ${item.name}`),
        ),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [sourceOrders, filter, situation, query, view, product]);

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

  /** Produtos das entregas do período; a contagem é de entregas que levam o produto. */
  const productOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const order of sourceOrders ?? []) {
      for (const delivery of order.deliveries) {
        for (const item of delivery.products ?? []) {
          const key = productKey(item);
          const entry = map.get(key) ?? { label: productLabel(item), count: 0 };
          entry.count += 1;
          map.set(key, entry);
        }
      }
    }
    return [...map.entries()]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }, [sourceOrders]);

  /** Mantém o rótulo do produto escolhido mesmo quando ele não aparece no período. */
  const selectedProduct = useMemo(() => {
    if (!product) return null;
    const found = productOptions.find((option) => option.key === product);
    if (found) return found;
    for (const order of allOrders ?? []) {
      for (const delivery of order.deliveries) {
        for (const item of delivery.products ?? []) {
          if (productKey(item) === product)
            return { key: product, label: productLabel(item), count: 0 };
        }
      }
    }
    return { key: product, label: product, count: 0 };
  }, [product, productOptions, allOrders]);

  const productList = useMemo(() => {
    if (!selectedProduct || productOptions.some((option) => option.key === selectedProduct.key))
      return productOptions;
    return [...productOptions, selectedProduct].sort((a, b) =>
      a.label.localeCompare(b.label, 'pt-BR'),
    );
  }, [productOptions, selectedProduct]);

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
        if (product && !deliveryHasProduct(delivery, product)) continue;
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
  }, [client, clientOrderList, filter, situation, query, product]);

  const clientOptions = useMemo(() => {
    const names = [...clientNames.keys()];
    if (client && !clientNames.has(client)) names.push(client);
    return names.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [clientNames, client]);

  const filtrando =
    filter !== 'all' ||
    situation !== null ||
    query.trim() !== '' ||
    client !== null ||
    product !== null;

  const productName = selectedProduct ? selectedProduct.label.replace(/^[^·]*·\s*/, '') : null;

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

  const allGroups = useMemo(() => {
    if (view !== 'all') return null;
    const byWeek = new Map<string, { year: number; week: number; days: Map<string, Order[]> }>();
    for (const order of orders) {
      const iso = order.deliveryDate!;
      const { year, week } = isoWeek(iso);
      const key = `${year}-${String(week).padStart(2, '0')}`;
      let group = byWeek.get(key);
      if (!group) {
        group = { year, week, days: new Map() };
        byWeek.set(key, group);
      }
      const list = group.days.get(iso) ?? [];
      list.push(order);
      group.days.set(iso, list);
    }
    return [...byWeek.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => {
        const monday = mondayOfIsoWeek(group.year, group.week);
        const days = [...group.days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([iso, list]) => ({ iso, list }));
        const deliveries = days.flatMap((day) => day.list.flatMap((order) => order.deliveries));
        return {
          key,
          label: `Semana ${group.week} · ${fmtDate(monday)} – ${fmtDate(shiftISO(monday, 6))}`,
          days,
          orders: days.reduce((sum, day) => sum + day.list.length, 0),
          deliveries: deliveries.length,
          entregues: deliveries.filter((d) => d.status === 'entregue').length,
        };
      });
  }, [view, orders]);

  const range = useMemo(() => {
    const dates = orders.map((order) => order.deliveryDate!).sort();
    return dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null;
  }, [orders]);

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
      noCliente: deliveries.filter((d) => d.status === 'no_cliente').length,
      anomalias: deliveries.filter((d) => Boolean(d.reason)).length,
      recusadas: deliveries.filter((d) => d.status === 'recusado').length,
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
                : view === 'all'
                  ? 'Todos os pedidos'
                  : view === 'week'
                    ? `Semana ${weekLabel}`
                    : isToday
                      ? 'Hoje'
                      : 'Programação'}
            </span>
            <h2 className={agenda ? 'client-title' : undefined}>
              {agenda ? (
                client
              ) : view === 'all' ? (
                'Histórico importado'
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
                  {view === 'all' && range && (
                    <>
                      {fmtDate(range.from)} – {fmtDate(range.to)} ·{' '}
                    </>
                  )}
                  {stats.orders} pedido{stats.orders === 1 ? '' : 's'} · {stats.deliveries} entrega
                  {stats.deliveries === 1 ? '' : 's'}
                </>
              )}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Período exibido">
              {VIEWS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={view === option ? 'active' : ''}
                  onClick={() => setView(option)}
                >
                  {option === 'all' ? 'Tudo' : option === 'week' ? 'Semana' : 'Dia'}
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
            {view !== 'all' && (
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
            )}
          </div>
        </div>

        {view !== 'all' && (
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
        )}
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
          <small>{view === 'all' ? 'no período importado' : `no total ${periodLabel}`}</small>
        </article>
        <article className="stat stat-completion">
          <div
            className="stat-ring"
            style={{ '--pct': stats.deliveries ? (stats.entregues / stats.deliveries) * 100 : 0 } as CSSProperties}
            aria-hidden="true"
          >
            <span>
              {stats.deliveries ? Math.round((stats.entregues / stats.deliveries) * 100) : 0}%
            </span>
          </div>
          <div className="stat-copy">
            <span>Entregues</span>
            <strong>
              {stats.entregues}
              <em>/{stats.deliveries}</em>
            </strong>
            <small>concluído</small>
          </div>
        </article>
        <article className="stat warn">
          <span>No cliente</span>
          <strong>{stats.noCliente}</strong>
          <small>
            {stats.emRota > 0 ? `${stats.emRota} em rota · ` : ''}
            {stats.anomalias > 0
              ? `${stats.anomalias} anomalia${stats.anomalias === 1 ? '' : 's'}`
              : 'nenhuma anomalia'}
            {stats.recusadas > 0
              ? ` · ${stats.recusadas} recusada${stats.recusadas === 1 ? '' : 's'}`
              : ''}
          </small>
        </article>
      </section>

      <section className="toolbar">
        <div className="segmented" role="group" aria-label="Filtrar tipo de carne">
          {(['all', 'PCS', 'CXS', 'CHQ', 'SPG'] as Filter[]).map((option) => (
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
        <label className="product-jump">
          <span>Produto</span>
          <select
            aria-label="Filtrar por produto"
            value={product ?? ''}
            onChange={(event) => setProduct(event.target.value || null)}
          >
            <option value="">Todos os produtos</option>
            {productList.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label} · {option.count}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          className="search"
          placeholder="Pedido, placa, rota, cliente, cidade ou produto"
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
                      <span className={`type-pill ${TYPE_CLASS[order.type]}`}>
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
      ) : view === 'all' ? (
        allGroups!.length === 0 ? (
          <section className="empty">
            <h3>{filtrando ? 'Nenhum pedido com este filtro' : 'Nenhum pedido importado'}</h3>
            {!filtrando && (
              <>
                <p>As planilhas dos pedidos são lidas das pastas de CXS, PÇS, CHQ e SPG na rede.</p>
                {offline ? (
                  <p>
                    Sem conexão com o servidor local. Exibindo apenas o que já foi importado neste
                    computador.
                  </p>
                ) : (
                  <button type="button" className="btn" onClick={onShowImport}>
                    Ver importação
                  </button>
                )}
              </>
            )}
          </section>
        ) : (
          allGroups!.map((week) => (
            <section key={week.key} className="week-group">
              <header className="week-day-head all-week-head">
                <h3>{week.label}</h3>
                <span className="week-day-sub">
                  {week.orders} pedido{week.orders === 1 ? '' : 's'} · {week.deliveries} entregas ·{' '}
                  {week.entregues} entregue{week.entregues === 1 ? '' : 's'}
                </span>
              </header>
              {week.days.map((day) => (
                <div key={day.iso} className="week-day-block">
                  <header className="week-day-head all-day-head">
                    <h3>
                      {weekdayShort(day.iso)}, {fmtDate(day.iso)}
                    </h3>
                    <span className="week-day-sub">
                      {day.list.length} pedido{day.list.length === 1 ? '' : 's'}
                    </span>
                  </header>
                  <div className="order-grid">
                    {day.list.map((order) => (
                      <OrderCard
                        key={order.id}
                        order={order}
                        product={product}
                        productName={productName}
                        onOpen={() => onOpenOrder(order.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))
        )
      ) : view === 'week' ? (
        weekGroups!.length === 0 ? (
          <section className="empty">
            <h3>{filtrando ? 'Nenhum pedido com este filtro' : 'Nenhum pedido nesta semana'}</h3>
            {!filtrando && !offline && (
              <>
                <p>As planilhas dos pedidos são lidas das pastas de CXS, PÇS, CHQ e SPG na rede.</p>
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
                    <OrderCard
                      key={order.id}
                      order={order}
                      product={product}
                      productName={productName}
                      onOpen={() => onOpenOrder(order.id)}
                    />
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
              <p>As planilhas dos pedidos são lidas das pastas de CXS, PÇS, CHQ e SPG na rede.</p>
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
            <OrderCard
              key={order.id}
              order={order}
              product={product}
              productName={productName}
              onOpen={() => onOpenOrder(order.id)}
            />
          ))}
        </section>
      )}
    </>
  );
}

function OrderCard({
  order,
  product,
  productName,
  onOpen,
}: {
  order: Order;
  product: string | null;
  productName: string | null;
  onOpen: () => void;
}) {
  const total = order.deliveries.length;
  const controlaveis = order.deliveries.filter((d) => !isEscDelivery(order, d.name));
  const semControle = total - controlaveis.length;
  const entregues = controlaveis.filter((d) => d.status === 'entregue').length;
  const finalizadas = controlaveis.filter((d) => FINAL_STATUSES.includes(d.status)).length;
  const anomalias = controlaveis.filter((d) => Boolean(d.reason)).length;
  const recusadas = controlaveis.filter((d) => d.status === 'recusado').length;
  const agendaveis = controlaveis.filter((d) => isSchedulable(d.name)).length;
  const agendadas = controlaveis.filter((d) => d.scheduledAt).length;
  const percent = controlaveis.length ? Math.round((finalizadas / controlaveis.length) * 100) : 0;
  const billing = order.billing ?? null;
  const notas = billing?.invoices.length ?? 0;
  const devolucoes = billing?.invoices.filter((invoice) => invoice.kind === 'devolucao').length ?? 0;
  const revendas = billing?.invoices.filter((invoice) => invoice.kind === 'revenda').length ?? 0;
  const soRetorno = notas > 0 && devolucoes + revendas === notas;

  return (
    <article className={`order-card ${TYPE_CLASS[order.type]}`}>
      <span className="order-rail" aria-hidden="true">
        {order.route}
      </span>
      <header>
        <div className="order-title">
          <span className={`type-pill ${TYPE_CLASS[order.type]}`}>
            {TYPE_SOURCE[order.type]}
          </span>
          <strong>{order.number}</strong>
          <span className="rev">{order.revision}</span>
        </div>
        {order.pendingSync && <span className="sync-dot" title="Alterações aguardando envio" />}
      </header>

      <div className="order-meta">
        <span>{total} entregas</span>
        <span className="dot-sep" aria-hidden="true">
          •
        </span>
        <span>{order.totalKg != null ? fmtKg(order.totalKg) : 'sem peso'}</span>
        {billing && (
          <span
            className="billing-flag"
            title={
              soRetorno
                ? `Só devolução/revenda no ERP${billing.billedAt ? ` em ${fmtDate(billing.billedAt)}` : ''} · ${notas} nota${notas === 1 ? '' : 's'}`
                : `${billing.status ?? 'Faturado'}${billing.billedAt ? ` em ${fmtDate(billing.billedAt)}` : ''} · ${fmtMoney(billing.value)} em ${notas} nota${notas === 1 ? '' : 's'}`
            }
          >
            {soRetorno ? 'sem venda' : 'faturado'} · {notas} NF{notas === 1 ? '' : 's'}
          </span>
        )}
        {devolucoes > 0 && (
          <span className="invoice-chip devolucao" title="Este pedido teve nota de devolução no ERP">
            {devolucoes} {devolucoes === 1 ? 'devolução' : 'devoluções'}
          </span>
        )}
        {revendas > 0 && (
          <span className="invoice-chip revenda" title="Mercadoria devolvida e revendida a outro cliente">
            {revendas} revenda{revendas === 1 ? '' : 's'}
          </span>
        )}
        {semControle > 0 && <span className="esc-flag">{semControle} ESC fora da conta</span>}
        {order.type === 'CXS' && agendaveis > 0 && (
          <span className={`agenda-flag ${agendadas === agendaveis ? 'ok' : ''}`}>
            {agendadas}/{agendaveis} agendadas
          </span>
        )}
        {(anomalias > 0 || recusadas > 0) && (
          <span className="recusa-flag">
            {anomalias > 0 ? `${anomalias} anomalia${anomalias === 1 ? '' : 's'}` : ''}
            {anomalias > 0 && recusadas > 0 ? ' · ' : ''}
            {recusadas > 0 ? `${recusadas} recusada${recusadas === 1 ? '' : 's'}` : ''}
          </span>
        )}
      </div>

      {order.plates && (
        <p className="plate-line">
          <span className="field-label">Placas</span> {order.plates}
        </p>
      )}
      {order.branchInstruction && <p className="branch-note">{order.branchInstruction}</p>}
      {billing && (
        <p className="billing-line">
          <span className="field-label">Faturamento</span>
          {soRetorno ? (
            <>
              só devolução/revenda no ERP
              {billing.billedAt ? ` · ${fmtDate(billing.billedAt)}` : ''}
            </>
          ) : (
            <>
              {fmtMoney(billing.value)} · {fmtKg(billing.kg)}
              {billing.billedAt ? ` · ${fmtDate(billing.billedAt)}` : ''}
            </>
          )}
        </p>
      )}

      <div className="progress" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-caption">
        <span>
          {entregues}/{controlaveis.length} entregues
        </span>
        <span>{percent}%</span>
      </div>

      <ul className="mini-deliveries">
        {order.deliveries.map((delivery) => {
          const temProduto = Boolean(product && deliveryHasProduct(delivery, product));
          const notas = invoicesForDelivery(order, delivery);
          return (
            <li
              key={delivery.seq}
              className={isEscDelivery(order, delivery.name) ? 'sem-controle' : ''}
            >
              <span className={`dot ${delivery.status}`} aria-hidden="true" />
              <span className="mini-client">
                <span className="mini-name">{delivery.name}</span>
                {notas.map((invoice, index) => {
                  const kind = invoiceKindOf(invoice);
                  return (
                    <span
                      className={`mini-nf ${kind}`}
                      key={`${invoice.number}-${index}`}
                      title={[
                        kind === 'devolucao'
                          ? 'Nota de devolução deste cliente'
                          : kind === 'revenda'
                            ? 'Nota de revenda da mercadoria devolvida'
                            : 'Nota fiscal de venda',
                        invoice.series ? `série ${invoice.series}` : null,
                        invoice.date ? fmtDate(invoice.date) : null,
                        fmtMoney(invoice.value),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {kind === 'venda'
                        ? `NF ${invoice.number}`
                        : `${kind === 'devolucao' ? 'Dev' : 'Rev'} ${invoice.number}`}
                    </span>
                  );
                })}
              </span>
              <span className="mini-city">
                {delivery.city}
                {delivery.eta ? ` · ${fmtEta(delivery.eta, order.deliveryDate)}` : ''}
              </span>
              {(delivery.scheduledAt ||
                delivery.reason ||
                delivery.resale === true ||
                delivery.lombador === true ||
                temProduto) && (
                <span className="mini-flags">
                  {temProduto && productName && (
                    <em className="flag produto" title={`Contém ${productName}`}>
                      {productName}
                    </em>
                  )}
                  {delivery.scheduledAt && <em className="flag agenda">agendada</em>}
                  {delivery.reason && (
                    <em className="flag recusa">{REASON_LABEL[delivery.reason]}</em>
                  )}
                  {delivery.resale === true && <em className="flag revenda">revenda</em>}
                  {delivery.lombador === true && <em className="flag lombador">lombador</em>}
                </span>
              )}
            </li>
          );
        })}
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
