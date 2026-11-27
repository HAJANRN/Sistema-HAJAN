import { useCallback, useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import { estadoInicial, reduzir } from '../emissor/estado';
import type { BaseEmissor } from '../emissor/tipos';
import { Clonagem } from './emissor/Clonagem';
import { DadosGerais } from './emissor/DadosGerais';
import { EntregaCard } from './emissor/EntregaCard';
import { GerarPedido } from './emissor/GerarPedido';
import { PainelCredito } from './emissor/PainelCredito';
import { ResumoCarga } from './emissor/ResumoCarga';

export function EmissorPedidoScreen() {
  const [base, setBase] = useState<BaseEmissor | null>(null);
  const [chave, setChave] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const [tentativa, setTentativa] = useState(0);

  // O StrictMode roda o efeito duas vezes: o cleanup aborta a primeira carga em
  // vez de deixá-la competir com a segunda (e de responder depois da desmontagem).
  useEffect(() => {
    const controle = new AbortController();
    setErro(null);
    api
      .emissorBase(controle.signal)
      .then((dados) => {
        if (!controle.signal.aborted) setBase(dados);
      })
      .catch((cause) => {
        if (controle.signal.aborted) return;
        setErro(cause instanceof Error ? cause.message : 'sem resposta do servidor');
      });
    return () => controle.abort();
  }, [tentativa]);

  const carregar = useCallback(() => setTentativa((n) => n + 1), []);

  /**
   * "Novo pedido" relê a base antes de reabrir o formulário: o número sugerido é o
   * maior do histórico + 1, que mudou com a emissão. Reaproveitar o número antigo faria
   * o INSERT OR REPLACE do servidor sobrescrever histórico, clone e PDF do pedido
   * recém-emitido. Se a releitura falhar, o resultado na tela é mantido e o motivo é
   * devolvido para o cartão de geração — o operador tenta de novo com o mesmo botão.
   */
  const iniciarNovo = useCallback(async (numeroEmitido: string): Promise<string | null> => {
    try {
      const dados = await api.emissorBase();
      // Pedido sem PÇS/CXS não entra no histórico, então MAX(numero) não avança: sem
      // este piso o próximo pedido nasceria com o mesmo número e apagaria o clone.
      const sugerido = Math.max(
        Number(dados.proximoNumero) || 0,
        (Number(numeroEmitido) || 0) + 1,
      );
      setBase({ ...dados, proximoNumero: String(sugerido) });
      setChave((n) => n + 1);
      return null;
    } catch (cause) {
      const motivo = cause instanceof Error ? cause.message : 'sem resposta do servidor';
      return `O pedido ${numeroEmitido} já foi emitido e gravado, mas não consegui reler a base para o próximo número (${motivo}). Clique em "Novo pedido" de novo.`;
    }
  }, []);

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

  return <Formulario key={chave} base={base} onNovo={iniciarNovo} />;
}

function Formulario({
  base,
  onNovo,
}: {
  base: BaseEmissor;
  onNovo: (numeroEmitido: string) => Promise<string | null>;
}) {
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

      <div className="emissor-lateral">
        <PainelCredito estado={estado} base={base} />
      </div>

      <GerarPedido estado={estado} onNovo={onNovo} />
    </section>
  );
}
