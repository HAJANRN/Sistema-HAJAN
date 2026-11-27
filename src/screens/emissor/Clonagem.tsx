import { useState } from 'react';
import type { Dispatch } from 'react';
import { api } from '../../api';
import type { Acao } from '../../emissor/estado';
import type { BaseEmissor } from '../../emissor/tipos';

interface Props {
  dispatch: Dispatch<Acao>;
  base: BaseEmissor;
}

export function Clonagem({ dispatch, base }: Props) {
  const [numero, setNumero] = useState('');
  const [tipo, setTipo] = useState<'CXS' | 'PÇS'>('CXS');
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);

  const buscar = async () => {
    const alvo = numero.trim();
    if (!alvo || buscando) return;
    setBuscando(true);
    setMensagem(null);
    try {
      const resultado = await api.emissorClone(alvo, tipo);
      if (resultado.encontrado && resultado.payload) {
        dispatch({ tipo: 'aplicarClone', payload: resultado.payload, base });
        setMensagem(
          `Clone de ${resultado.fonte === 'banco' ? 'banco' : 'rede'} aplicado — confira e ajuste o número.`,
        );
        setNumero('');
      } else if (resultado.outroTipo) {
        setMensagem(`Este pedido está em ${resultado.outroTipo}, não em ${tipo}.`);
      } else {
        setMensagem('Não encontrei clone para este número.');
      }
    } catch (cause) {
      setMensagem(cause instanceof Error ? cause.message : 'falha ao buscar o clone');
    } finally {
      setBuscando(false);
    }
  };

  return (
    <section className="card emissor-clonagem">
      <h2>Clonar pedido anterior</h2>
      <div className="emissor-grade">
        <label>
          <span>Nº do pedido</span>
          <input inputMode="numeric" value={numero} onChange={(event) => setNumero(event.target.value)} />
        </label>
        <label>
          <span>Tipo</span>
          <select value={tipo} onChange={(event) => setTipo(event.target.value === 'PÇS' ? 'PÇS' : 'CXS')}>
            <option value="CXS">CXS</option>
            <option value="PÇS">PÇS</option>
          </select>
        </label>
        <div className="emissor-clonagem-botao">
          <button type="button" className="btn ghost" onClick={() => void buscar()} disabled={!numero.trim() || buscando}>
            {buscando ? 'Buscando…' : 'Buscar clone'}
          </button>
        </div>
      </div>
      {mensagem && <p className="hint">{mensagem}</p>}
    </section>
  );
}
