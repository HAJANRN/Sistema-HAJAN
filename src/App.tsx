import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dashboard } from './screens/Dashboard';
import { OrderDetail } from './screens/OrderDetail';
import { ImportPanel } from './screens/ImportPanel';
import { LoginScreen } from './screens/LoginScreen';
import { PedidosScreen } from './screens/PedidosScreen';
import { AnomaliasScreen } from './screens/AnomaliasScreen';
import { LogisticaDashboardScreen } from './screens/LogisticaDashboardScreen';
import { FinanceiroPagarScreen } from './screens/FinanceiroPagarScreen';
import { FinanceiroReceberScreen } from './screens/FinanceiroReceberScreen';
import { FinanceiroDashboardScreen } from './screens/FinanceiroDashboardScreen';
import { EmissorPedidoScreen } from './screens/EmissorPedidoScreen';
import { ImportarPlanilhasScreen } from './screens/ImportarPlanilhasScreen';
import { api } from './api';
import { initSync, sair, subscribeSync, syncNow, syncSnapshot } from './sync';
import { relativeTime, todayISO } from './utils';

type Rota =
  | 'novo-pedido'
  | 'importar-planilhas'
  | 'pedidos-emitidos'
  | 'cargas'
  | 'anomalias'
  | 'logistica-dashboard'
  | 'contas-pagar'
  | 'contas-receber'
  | 'financeiro-dashboard';

const ROTA_KEY = 'hajan-rota';

const MENU: { grupo: string; itens: { rota: Rota; label: string }[] }[] = [
  {
    grupo: 'Digitação de pedidos',
    itens: [
      { rota: 'novo-pedido', label: 'Novo pedido' },
      { rota: 'importar-planilhas', label: 'Importar planilhas' },
      { rota: 'pedidos-emitidos', label: 'Pedidos emitidos' },
    ],
  },
  {
    grupo: 'Logística',
    itens: [
      { rota: 'cargas', label: 'Cargas' },
      { rota: 'anomalias', label: 'Anomalias' },
      { rota: 'logistica-dashboard', label: 'Dashboard' },
    ],
  },
  {
    grupo: 'Financeiro',
    itens: [
      { rota: 'contas-pagar', label: 'Contas a pagar' },
      { rota: 'contas-receber', label: 'Contas a receber' },
      { rota: 'financeiro-dashboard', label: 'Dashboard' },
    ],
  },
];

const ROTAS = MENU.flatMap((grupo) => grupo.itens.map((item) => item.rota));

const TITULOS: Record<Rota, { grupo: string; titulo: string }> = Object.fromEntries(
  MENU.flatMap((grupo) =>
    grupo.itens.map((item) => [item.rota, { grupo: grupo.grupo, titulo: item.label }]),
  ),
) as Record<Rota, { grupo: string; titulo: string }>;

const lerRota = (): Rota => {
  const salva = localStorage.getItem(ROTA_KEY) as Rota | null;
  return salva && ROTAS.includes(salva) ? salva : 'cargas';
};

export default function App() {
  const [date, setDate] = useState(todayISO());
  const [rota, setRota] = useState<Rota>(lerRota);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [sessao, setSessao] = useState<{
    carregada: boolean;
    autenticada: boolean;
    senhaDefinida: boolean;
    erro: string | null;
  }>({ carregada: false, autenticada: false, senhaDefinida: false, erro: null });
  const [erroSaida, setErroSaida] = useState<string | null>(null);
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);

  const verificarSessao = useCallback(async () => {
    setSessao((atual) => ({ ...atual, carregada: false, erro: null }));
    try {
      const resultado = await api.session();
      setSessao({
        carregada: true,
        autenticada: resultado.senhaDefinida && resultado.role === 'administracao',
        senhaDefinida: resultado.senhaDefinida,
        erro: null,
      });
    } catch (cause) {
      setSessao((atual) => ({
        ...atual,
        carregada: true,
        erro: cause instanceof Error ? cause.message : 'Não foi possível conectar ao servidor.',
      }));
    }
  }, []);

  useEffect(() => {
    void verificarSessao();
  }, [verificarSessao]);

  useEffect(() => {
    if (sessao.autenticada) initSync();
  }, [sessao.autenticada]);

  useEffect(() => {
    localStorage.setItem(ROTA_KEY, rota);
  }, [rota]);

  /** Abrir um pedido ou trocar de tela deixa o painel guardado, com filtros e rolagem. */
  const painelRolado = useRef(0);
  const primeiraVez = useRef(true);

  const abrirPedido = (id: string) => {
    painelRolado.current = window.scrollY;
    setOpenOrderId(id);
  };

  const navegar = (nova: Rota) => {
    if (rota === 'cargas' && openOrderId === null) painelRolado.current = window.scrollY;
    setOpenOrderId(null);
    setRota(nova);
  };

  const sairDoSistema = async () => {
    setErroSaida(null);
    try {
      await sair();
      setSessao((atual) => ({ ...atual, autenticada: false }));
    } catch (cause) {
      setErroSaida(cause instanceof Error ? cause.message : 'Não foi possível encerrar a sessão.');
    }
  };

  // Depois de mostrar/esconder a tela, antes de pintar: é aí que a altura já é a nova.
  useLayoutEffect(() => {
    if (primeiraVez.current) {
      primeiraVez.current = false;
      return;
    }
    window.scrollTo(0, openOrderId === null && rota === 'cargas' ? painelRolado.current : 0);
  }, [openOrderId, rota]);

  const connectionLabel = sync.online
    ? sync.syncing
      ? 'Sincronizando…'
      : `Atualizado ${relativeTime(sync.lastSyncAt)}`
    : 'Sem servidor local';
  const logistica =
    rota === 'cargas' || rota === 'anomalias' || rota === 'logistica-dashboard';

  if (!sessao.carregada) {
    return (
      <main className="login-screen">
        <section className="login-card login-loading">
          <span className="eyebrow">Sistemas HAJAN</span>
          <p>Verificando acesso ao servidor…</p>
        </section>
      </main>
    );
  }

  if (!sessao.autenticada) {
    return (
      <LoginScreen
        senhaDefinida={sessao.senhaDefinida}
        erroSessao={sessao.erro}
        onAuthenticated={() => {
          setSessao((atual) => ({ ...atual, autenticada: true, senhaDefinida: true }));
          setErroSaida(null);
        }}
        onRetry={() => void verificarSessao()}
      />
    );
  }

  return (
    <div className="app app-shell">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="brand-tile">
            <img className="brand-mark" src="/images/hajan-mark.png" alt="HAJAN" />
          </span>
          <div className="side-brand-text">
            <strong>
              Sistemas HAJAN <span>FRIBOI</span>
            </strong>
            <small>Entregas · Pedidos · Financeiro</small>
          </div>
        </div>

        <nav className="side-nav" aria-label="Menu do sistema">
          {MENU.map((grupo) => (
            <div className="side-group" key={grupo.grupo}>
              <span className="side-group-title">{grupo.grupo}</span>
              {grupo.itens.map((item) => (
                <button
                  key={item.rota}
                  type="button"
                  className={`side-item ${rota === item.rota ? 'active' : ''}`}
                  aria-current={rota === item.rota ? 'page' : undefined}
                  onClick={() => navegar(item.rota)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          {logistica && (
            <span className={`conn-badge ${sync.online ? 'online' : 'offline'}`}>
              <i aria-hidden="true" />
              {connectionLabel}
            </span>
          )}
          {sync.pending > 0 && <span className="pending-badge">{sync.pending} a enviar</span>}
          <button type="button" className="btn ghost" onClick={() => void sairDoSistema()}>
            Sair
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <span>{TITULOS[rota].grupo}</span>
            <h1>{TITULOS[rota].titulo}</h1>
          </div>
          <div className="topbar-actions">
            {logistica && (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void syncNow()}
                  disabled={sync.syncing}
                >
                  Atualizar
                </button>
                <button type="button" className="btn" onClick={() => setShowImport(true)}>
                  Importação
                </button>
              </>
            )}
          </div>
        </header>

        {erroSaida && (
          <p className="session-error" role="alert">
            {erroSaida}
          </p>
        )}

        <main className="content">
          <div className="painel-shell" hidden={rota !== 'cargas' || openOrderId !== null}>
            <Dashboard
              date={date}
              onDateChange={setDate}
              onOpenOrder={abrirPedido}
              onShowImport={() => setShowImport(true)}
              offline={!sync.online}
            />
          </div>
          {rota === 'anomalias' && openOrderId === null && (
            <AnomaliasScreen onOpenOrder={abrirPedido} />
          )}
          {rota === 'logistica-dashboard' && <LogisticaDashboardScreen />}
          {rota === 'pedidos-emitidos' && <PedidosScreen />}
          {rota === 'contas-pagar' && <FinanceiroPagarScreen />}
          {rota === 'contas-receber' && <FinanceiroReceberScreen />}
          {rota === 'financeiro-dashboard' && <FinanceiroDashboardScreen />}
          {openOrderId !== null && (
            <OrderDetail orderId={openOrderId} onBack={() => setOpenOrderId(null)} />
          )}
          {rota === 'novo-pedido' && <EmissorPedidoScreen />}
          {rota === 'importar-planilhas' && <ImportarPlanilhasScreen />}
        </main>
      </div>

      {showImport && <ImportPanel onClose={() => setShowImport(false)} />}
    </div>
  );
}
