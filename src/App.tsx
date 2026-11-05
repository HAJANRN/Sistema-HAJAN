import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dashboard } from './screens/Dashboard';
import { OrderDetail } from './screens/OrderDetail';
import { ImportPanel } from './screens/ImportPanel';
import { initSync, subscribeSync, syncNow, syncSnapshot } from './sync';
import { relativeTime, todayISO } from './utils';

export default function App() {
  const [date, setDate] = useState(todayISO());
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);

  useEffect(() => {
    initSync();
  }, []);

  /** Abrir um pedido deixa o painel guardado, com filtros e lugar da rolagem. */
  const painelRolado = useRef(0);
  const primeiraVez = useRef(true);

  const abrirPedido = (id: string) => {
    painelRolado.current = window.scrollY;
    setOpenOrderId(id);
  };

  // Depois de mostrar/esconder a tela, antes de pintar: é aí que a altura já é a nova.
  useLayoutEffect(() => {
    if (primeiraVez.current) {
      primeiraVez.current = false;
      return;
    }
    window.scrollTo(0, openOrderId === null ? painelRolado.current : 0);
  }, [openOrderId]);

  const connectionLabel = sync.online
    ? sync.syncing
      ? 'Sincronizando…'
      : `Atualizado ${relativeTime(sync.lastSyncAt)}`
    : 'Sem servidor local';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/images/hajan-mark.png" alt="HAJAN" />
          <div>
            <h1>Expedição de carne</h1>
            <p>Pedidos HAJAN · Friboi</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`conn-badge ${sync.online ? 'online' : 'offline'}`}>
            <i aria-hidden="true" />
            {connectionLabel}
          </span>
          {sync.pending > 0 && <span className="pending-badge">{sync.pending} a enviar</span>}
          <button
            type="button"
            className="btn ghost"
            onClick={() => void syncNow()}
            disabled={sync.syncing}
          >
            Atualizar
          </button>
          <button type="button" className="btn ghost" onClick={() => setShowImport(true)}>
            Importação
          </button>
        </div>
      </header>

      <main className="content">
        <div className="painel-shell" hidden={openOrderId !== null}>
          <Dashboard
            date={date}
            onDateChange={setDate}
            onOpenOrder={abrirPedido}
            onShowImport={() => setShowImport(true)}
            offline={!sync.online}
          />
        </div>
        {openOrderId !== null && (
          <OrderDetail orderId={openOrderId} onBack={() => setOpenOrderId(null)} />
        )}
      </main>

      {showImport && <ImportPanel onClose={() => setShowImport(false)} />}
    </div>
  );
}
