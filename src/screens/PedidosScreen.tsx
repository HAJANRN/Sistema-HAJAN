import { useEffect, useMemo, useState } from 'react';
import { api, type EmissorPedido } from '../api';
import { TYPE_CLASS, TYPE_SOURCE, type OrderType } from '../types';
import { fmtDate } from '../utils';
import { PERIODOS, limites, type Periodo } from '../periodo';

const tipoDe = (categoria: string): OrderType | null => {
  const valor = categoria.trim().toUpperCase();
  if (valor === 'CXS') return 'CXS';
  if (valor === 'PÇS' || valor === 'PCS') return 'PCS';
  if (valor === 'CHQ') return 'CHQ';
  if (valor === 'SPG') return 'SPG';
  return null;
};

function TipoPill({ categoria }: { categoria: string }) {
  const tipo = tipoDe(categoria);
  if (!tipo) return <span className="type-pill">{categoria}</span>;
  return (
    <span className={`type-pill ${TYPE_CLASS[tipo]}`} title={categoria}>
      {TYPE_SOURCE[tipo]}
    </span>
  );
}

export function PedidosScreen() {
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const inicial = limites('30d');
  const [de, setDe] = useState(inicial.de);
  const [ate, setAte] = useState(inicial.ate);
  const [busca, setBusca] = useState('');
  const [lista, setLista] = useState<EmissorPedido[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const escolherPeriodo = (opcao: Periodo) => {
    const faixa = limites(opcao);
    setPeriodo(opcao);
    setDe(faixa.de);
    setAte(faixa.ate);
  };

  useEffect(() => {
    let ativo = true;
    setErro(null);
    api
      .emissorPedidos(de, ate)
      .then((resposta) => {
        if (ativo) setLista(resposta.pedidos);
      })
      .catch((causa: unknown) => {
        if (!ativo) return;
        setLista([]);
        setErro(causa instanceof Error ? causa.message : 'Não foi possível carregar os pedidos.');
      });
    return () => {
      ativo = false;
    };
  }, [de, ate]);

  const pedidos = useMemo(() => {
    if (!lista) return null;
    const termo = busca.trim().toLowerCase();
    if (!termo) return lista;
    return lista.filter((pedido) =>
      [pedido.numero, pedido.unidade, pedido.tipo, ...pedido.clientes]
        .join(' ')
        .toLowerCase()
        .includes(termo),
    );
  }, [lista, busca]);

  const resumo = useMemo(() => {
    if (!pedidos) return null;
    const clientes = new Set<string>();
    let destinos = 0;
    for (const pedido of pedidos) {
      pedido.clientes.forEach((cliente) => clientes.add(cliente));
      destinos += pedido.destinos;
    }
    return { pedidos: pedidos.length, destinos, clientes: clientes.size };
  }, [pedidos]);

  const periodoInvalido = de > ate;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Emissor de pedidos</span>
            <h2>Pedidos emitidos</h2>
            <p className="panel-sub">
              {resumo
                ? `${resumo.pedidos} pedido${resumo.pedidos === 1 ? '' : 's'} · ${resumo.destinos} destino${resumo.destinos === 1 ? '' : 's'} · ${resumo.clientes} cliente${resumo.clientes === 1 ? '' : 's'} — entregas entre ${fmtDate(de)} e ${fmtDate(ate)}`
                : 'Carregando os pedidos do período…'}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Período dos pedidos">
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
          placeholder="Número, unidade ou cliente"
          value={busca}
          onChange={(evento) => setBusca(evento.target.value)}
        />
      </section>

      {periodoInvalido ? (
        <section className="empty">
          <h3>A data final é anterior à inicial</h3>
          <p>Ajuste o período para ver os pedidos.</p>
        </section>
      ) : erro ? (
        <section className="empty">
          <h3>Não foi possível carregar os pedidos</h3>
          <p>{erro}</p>
        </section>
      ) : pedidos === null ? (
        <section className="empty">
          <h3>Carregando…</h3>
        </section>
      ) : pedidos.length === 0 ? (
        <section className="empty">
          <h3>{busca.trim() ? 'Nenhum pedido com esta busca' : 'Nenhum pedido neste período'}</h3>
          <p>
            Os pedidos aparecem aqui quando o PDF é gerado no Emissor. A data considerada é a de
            entrega.
          </p>
        </section>
      ) : (
        <div className="pedidos-table-wrap">
          <table className="pedidos-table">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Unidade</th>
                <th>Embarque</th>
                <th>Entrega</th>
                <th>Destinos</th>
                <th>Clientes</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((pedido) => (
                <tr key={`${pedido.numero}-${pedido.tipo}-${pedido.criadoEm ?? pedido.entrega}`}>
                  <td>
                    <span className="pedido-num">{pedido.numero}</span>{' '}
                    <TipoPill categoria={pedido.tipo} />
                  </td>
                  <td className="pedido-unidade">{pedido.unidade || '—'}</td>
                  <td className="pedido-data">{fmtDate(pedido.embarque) || '—'}</td>
                  <td className="pedido-data">{fmtDate(pedido.entrega) || '—'}</td>
                  <td className="pedido-destinos">{pedido.destinos}</td>
                  <td className="pedidos-clientes" title={pedido.clientes.join('\n')}>
                    {pedido.clientes.join(', ') || '—'}
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
