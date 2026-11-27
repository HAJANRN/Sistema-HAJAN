import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { titulosDe } from '../financeiro';
import { fmtMoney } from '../utils';
import { PERIODOS, limites, type Periodo } from '../periodo';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function ultimosMeses(quantidade: number) {
  const hoje = new Date();
  return Array.from({ length: quantidade }, (_, indice) => {
    const data = new Date(hoje.getFullYear(), hoje.getMonth() - (quantidade - 1 - indice), 1);
    const chave = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
    return { chave, rotulo: MESES[data.getMonth()] };
  });
}

export function FinanceiroDashboardScreen() {
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

  const pedidos = useLiveQuery(() => db.orders.filter((order) => Boolean(order.billing)).toArray(), []);

  const dados = useMemo(() => {
    const titulos = titulosDe(pedidos ?? []);
    const noPeriodo = titulos.filter(
      (titulo) => titulo.emissao && titulo.emissao >= de && titulo.emissao <= ate,
    );
    const faturado = noPeriodo.reduce((soma, titulo) => soma + titulo.valor, 0);
    const clientes = new Map<string, number>();
    for (const titulo of noPeriodo) {
      clientes.set(titulo.cliente, (clientes.get(titulo.cliente) ?? 0) + titulo.valor);
    }

    let devolvido = 0;
    for (const pedido of pedidos ?? []) {
      for (const nota of pedido.billing?.invoices ?? []) {
        if (nota.kind !== 'devolucao') continue;
        const data = nota.date ?? pedido.billing?.billedAt ?? null;
        if (data && data >= de && data <= ate) devolvido += nota.value;
      }
    }

    const meses = ultimosMeses(6).map((mes) => {
      const total = titulos
        .filter((titulo) => titulo.emissao?.startsWith(mes.chave))
        .reduce((soma, titulo) => soma + titulo.valor, 0);
      return { ...mes, total };
    });
    const maiorMes = Math.max(1, ...meses.map((mes) => mes.total));

    return {
      faturado,
      notas: noPeriodo.length,
      ticket: noPeriodo.length ? faturado / noPeriodo.length : 0,
      devolvido,
      clientes: [...clientes.entries()].sort(([, a], [, b]) => b - a).slice(0, 6),
      meses,
      maiorMes,
    };
  }, [pedidos, de, ate]);

  const carregando = pedidos === undefined;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Financeiro</span>
            <h2>Dashboard financeiro</h2>
            <p className="panel-sub">
              Notas de venda do ERP emitidas entre {de.split('-').reverse().join('/')} e{' '}
              {ate.split('-').reverse().join('/')}
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
              <span>Faturado</span>
              <strong className="stat-money">{fmtMoney(dados.faturado)}</strong>
              <small>{dados.notas} nota{dados.notas === 1 ? '' : 's'} de venda no período</small>
            </article>
            <article className="stat">
              <span>Ticket médio</span>
              <strong className="stat-money">{fmtMoney(dados.ticket)}</strong>
              <small>por nota fiscal</small>
            </article>
            <article className="stat warn">
              <span>Devoluções</span>
              <strong className="stat-money">{fmtMoney(dados.devolvido)}</strong>
              <small>notas de devolução no período</small>
            </article>
            <article className="stat">
              <span>Contas a pagar</span>
              <strong>—</strong>
              <small>sem base importada</small>
            </article>
          </section>

          <section className="panel fin-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Evolução</span>
                <h2 className="panel-title-sm">Faturamento por mês</h2>
              </div>
            </div>
            <div className="fin-bars" role="img" aria-label="Faturamento dos últimos seis meses">
              {dados.meses.map((mes) => (
                <div key={mes.chave} className="fin-bar">
                  <span className="fin-bar-value">{fmtMoney(mes.total)}</span>
                  <i style={{ height: `${Math.max(2, (mes.total / dados.maiorMes) * 100)}%` }} />
                  <span className="fin-bar-label">{mes.rotulo}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel fin-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">Clientes</span>
                <h2 className="panel-title-sm">Maiores valores no período</h2>
              </div>
            </div>
            {dados.clientes.length === 0 ? (
              <p className="panel-sub">Nenhuma nota de venda no período.</p>
            ) : (
              <ul className="fin-clientes">
                {dados.clientes.map(([cliente, valor]) => (
                  <li key={cliente}>
                    <span className="fin-cliente-nome">{cliente}</span>
                    <span className="fin-cliente-valor">{fmtMoney(valor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
