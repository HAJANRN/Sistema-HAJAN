import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { titulosDe } from '../financeiro';
import { fmtDate, fmtMoney } from '../utils';
import { PERIODOS, limites, type Periodo } from '../periodo';

export function FinanceiroReceberScreen() {
  const inicial = limites('30d');
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [de, setDe] = useState(inicial.de);
  const [ate, setAte] = useState(inicial.ate);
  const [busca, setBusca] = useState('');

  const escolherPeriodo = (opcao: Periodo) => {
    const faixa = limites(opcao);
    setPeriodo(opcao);
    setDe(faixa.de);
    setAte(faixa.ate);
  };

  const pedidos = useLiveQuery(() => db.orders.filter((order) => Boolean(order.billing)).toArray(), []);

  const titulos = useMemo(
    () =>
      titulosDe(pedidos ?? [])
        .filter((titulo) => titulo.emissao && titulo.emissao >= de && titulo.emissao <= ate)
        .sort((a, b) => (b.emissao ?? '').localeCompare(a.emissao ?? '') || a.numero.localeCompare(b.numero)),
    [pedidos, de, ate],
  );

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return titulos;
    return titulos.filter((titulo) =>
      `${titulo.numero} ${titulo.serie ?? ''} ${titulo.cliente} ${titulo.pedido}`
        .toLowerCase()
        .includes(termo),
    );
  }, [titulos, busca]);

  const resumo = useMemo(() => {
    const clientes = new Set(filtrados.map((titulo) => titulo.cliente));
    return {
      valor: filtrados.reduce((soma, titulo) => soma + titulo.valor, 0),
      clientes: clientes.size,
    };
  }, [filtrados]);

  const carregando = pedidos === undefined;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Financeiro</span>
            <h2>Contas a receber</h2>
            <p className="panel-sub">
              {carregando
                ? 'Carregando as notas do período…'
                : `${filtrados.length} nota${filtrados.length === 1 ? '' : 's'} de venda · ${fmtMoney(resumo.valor)} · ${resumo.clientes} cliente${resumo.clientes === 1 ? '' : 's'}`}
            </p>
          </div>
          <div className="panel-head-side">
            <div className="segmented" role="group" aria-label="Período das notas">
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
        <p className="panel-note">
          Valores das notas de venda emitidas no ERP, pela data de emissão. Vencimentos e baixas
          entram quando a base financeira for importada.
        </p>
      </section>

      <section className="toolbar">
        <label className="periodo-jump">
          <span>Emissão de</span>
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
          placeholder="Nota, cliente ou pedido"
          value={busca}
          onChange={(evento) => setBusca(evento.target.value)}
        />
      </section>

      {carregando ? (
        <section className="empty">
          <h3>Carregando…</h3>
        </section>
      ) : filtrados.length === 0 ? (
        <section className="empty">
          <h3>Nenhuma nota de venda no período</h3>
          <p>
            As notas aparecem aqui conforme o faturamento do ERP é importado para os pedidos da
            expedição.
          </p>
        </section>
      ) : (
        <div className="pedidos-table-wrap">
          <table className="pedidos-table">
            <thead>
              <tr>
                <th>Emissão</th>
                <th>Nota fiscal</th>
                <th>Cliente</th>
                <th>Pedido</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((titulo) => (
                <tr key={titulo.chave}>
                  <td className="pedido-data">{fmtDate(titulo.emissao) || '—'}</td>
                  <td>
                    <span className="pedido-num">
                      NF {titulo.numero}
                      {titulo.serie ? `/${titulo.serie}` : ''}
                    </span>{' '}
                    {titulo.tipo === 'revenda' && <em className="flag revenda">revenda</em>}
                  </td>
                  <td>{titulo.cliente}</td>
                  <td className="pedido-num">{titulo.pedido}</td>
                  <td className="pedido-valor">{fmtMoney(titulo.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
