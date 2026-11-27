import { useCallback, useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import { estadoInicial, reduzir } from '../emissor/estado';
import type { BaseEmissor } from '../emissor/tipos';
import { Clonagem } from './emissor/Clonagem';
import { DadosGerais } from './emissor/DadosGerais';
import { EntregaCard } from './emissor/EntregaCard';
import { GerarPedido } from './emissor/GerarPedido';
import { ResumoCarga } from './emissor/ResumoCarga';

export function EmissorPedidoScreen() {
  const [base, setBase] = useState<BaseEmissor | null>(null);
  const [chave, setChave] = useState(0);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setErro(null);
    api
      .emissorBase()
      .then(setBase)
      .catch((cause) => setErro(cause instanceof Error ? cause.message : 'sem resposta do servidor'));
  }, []);

  useEffect(() => carregar(), [carregar]);

  if (erro) {
    return (
      <section className="emissor-screen">
        <p className="alert">
          {erro}{' '}
          <button type="button" className="btn ghost small" onClick={carregar}>
            Tentar de novo
          </button>
        </p>
      </section>
    );
  }

  if (!base) {
    return (
      <section className="emissor-screen">
        <p className="panel-sub">Carregando clientes, produtos e unidades…</p>
      </section>
    );
  }

  return <Formulario key={chave} base={base} onNovo={() => setChave((n) => n + 1)} />;
}

function Formulario({ base, onNovo }: { base: BaseEmissor; onNovo: () => void }) {
  const [estado, dispatch] = useReducer(reduzir, base, estadoInicial);

  return (
    <section className="emissor-screen">
      <header className="emissor-cabecalho">
        <div>
          <span className="eyebrow">Digitação de pedidos</span>
          <h1>Novo pedido</h1>
        </div>
        <ResumoCarga estado={estado} />
      </header>

      <datalist id="destinos-pedido">
        {base.destinos.map((destino) => (
          <option key={destino} value={destino} />
        ))}
      </datalist>

      <Clonagem dispatch={dispatch} base={base} />
      <DadosGerais estado={estado} dispatch={dispatch} base={base} />

      <div className="emissor-entregas">
        {estado.entregas.map((entrega, indice) => (
          <EntregaCard
            key={entrega.id}
            entrega={entrega}
            indice={indice}
            total={estado.entregas.length}
            base={base}
            dispatch={dispatch}
          />
        ))}
      </div>

      <div className="emissor-acoes">
        <button type="button" className="btn ghost" onClick={() => dispatch({ tipo: 'novaEntrega' })}>
          + Entrega
        </button>
      </div>

      <GerarPedido estado={estado} onNovo={onNovo} />
    </section>
  );
}
