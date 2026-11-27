import { useState, useSyncExternalStore } from 'react';
import { api, type EmissaoResultado } from '../../api';
import { ehEsc } from '../../emissor/calculo';
import { paraPayloadApi, pedidoDe } from '../../emissor/estado';
import type { Estado } from '../../emissor/estado';
import { entrar, syncNow, syncSnapshot, subscribeSync } from '../../sync';

interface Props {
  estado: Estado;
  onNovo: () => void;
}

function problemasDoPedido(estado: Estado): string[] {
  const problemas: string[] = [];
  if (!/^\d{1,10}$/.test(estado.dados.numero.trim())) problemas.push('número do pedido inválido');
  if (!estado.dados.dataEmbarque || !estado.dados.dataEntrega) problemas.push('informe embarque e entrega');
  estado.entregas.forEach((entrega, indice) => {
    if (!entrega.cliente.trim()) problemas.push(`entrega ${indice + 1}: escolha o cliente`);
    const esc = ehEsc(entrega.cliente) || ehEsc(entrega.destino);
    if (esc && !(Number(entrega.pesoManual) > 0)) {
      problemas.push(`entrega ${indice + 1}: informe o peso manual`);
    }
    if (!esc) {
      if (entrega.produtos.every((p) => !p.codigo)) problemas.push(`entrega ${indice + 1}: escolha um produto`);
      if (entrega.produtos.some((p) => !(p.qtd >= 1))) problemas.push(`entrega ${indice + 1}: quantidade mínima 1`);
    }
  });
  return problemas;
}

export function GerarPedido({ estado, onNovo }: Props) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<EmissaoResultado | null>(null);

  const liberar = async () => {
    if (!senha || busy) return;
    setBusy(true);
    setErro(null);
    try {
      await entrar(senha);
      await syncNow();
      setSenha('');
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui conferir a senha');
    } finally {
      setBusy(false);
    }
  };

  const gerar = async () => {
    const problemas = problemasDoPedido(estado);
    if (problemas.length > 0) {
      setErro(problemas.join(' · '));
      return;
    }
    setBusy(true);
    setErro(null);
    setResultado(null);
    try {
      const resposta = await api.emitirPedido(paraPayloadApi(pedidoDe(estado)));
      setResultado(resposta);
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui gerar o pedido');
    } finally {
      setBusy(false);
    }
  };

  if (sync.role !== 'administracao') {
    return (
      <section className="card emissor-gerar">
        <h2>Gerar pedido</h2>
        <p className="hint">A geração e a importação pedem a senha do escritório.</p>
        <form
          className="emissor-grade"
          onSubmit={(event) => {
            event.preventDefault();
            void liberar();
          }}
        >
          <label>
            <span>Senha do escritório</span>
            <input type="password" autoComplete="off" value={senha} onChange={(event) => setSenha(event.target.value)} />
          </label>
          <div className="emissor-clonagem-botao">
            <button type="submit" className="btn" disabled={!senha || busy}>
              {busy ? 'Confirmando…' : 'Entrar'}
            </button>
          </div>
        </form>
        {erro && <p className="alert">{erro}</p>}
      </section>
    );
  }

  return (
    <section className="card emissor-gerar">
      <h2>Gerar pedido</h2>
      {erro && <p className="alert">{erro}</p>}
      {resultado ? (
        <div className="emissor-resultado">
          <p>
            Pedido <strong>{estado.dados.numero}</strong> gerado. Baixe o PDF:{' '}
            <a href={resultado.download} target="_blank" rel="noreferrer">
              {resultado.arquivo}
            </a>
          </p>
          <p className="hint">
            {resultado.pedido.registradoNoHistorico
              ? 'Histórico atualizado — confira em Pedidos emitidos.'
              : 'Histórico não registrado (pedido sem PÇS nem CXS).'}{' '}
            Gravado em: {resultado.salvoEm.join(', ') || '—'}
          </p>
          {resultado.avisos.map((aviso) => (
            <p className="hint" key={aviso}>
              {aviso}
            </p>
          ))}
          <div className="emissor-acoes">
            <a className="btn ghost" href={resultado.download} target="_blank" rel="noreferrer">
              Abrir PDF
            </a>
            <button type="button" className="btn" onClick={onNovo}>
              Novo pedido
            </button>
          </div>
        </div>
      ) : (
        <div className="emissor-acoes">
          <button type="button" className="btn" onClick={() => void gerar()} disabled={busy}>
            {busy ? 'Gerando…' : 'Gerar pedido e PDF'}
          </button>
          <span className="hint">O servidor recalcula peso, valor e veículo antes de gravar.</span>
        </div>
      )}
    </section>
  );
}
