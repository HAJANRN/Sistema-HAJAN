import type { Dispatch } from 'react';
import type { Acao, Estado } from '../../emissor/estado';
import { localizarOpcao } from '../../emissor/formato';
import type { BaseEmissor } from '../../emissor/tipos';

interface Props {
  estado: Estado;
  dispatch: Dispatch<Acao>;
  base: BaseEmissor;
}

export function DadosGerais({ estado, dispatch, base }: Props) {
  const { dados } = estado;
  const campo = (nome: keyof typeof dados) => ({
    value: dados[nome],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      dispatch({ tipo: 'campo', campo: nome, valor: event.target.value }),
  });

  return (
    <section className="card emissor-bloco">
      <h2>Dados gerais</h2>
      <div className="emissor-grade">
        <label>
          <span>Nº do pedido</span>
          <input inputMode="numeric" {...campo('numero')} />
        </label>
        <label>
          <span>A/C</span>
          <input {...campo('atencao')} />
        </label>
        <label>
          <span>Data de emissão</span>
          <input type="date" {...campo('dataEmissao')} />
        </label>
        <label>
          <span>Local</span>
          <input {...campo('local')} />
        </label>
        <label>
          <span>Unidade de carregamento</span>
          <input
            list="unidades-pedido"
            {...campo('unidade')}
            onBlur={(event) => {
              const achado = localizarOpcao(
                base.unidades.map((u) => ({ valor: u.sigla, rotulo: u.rotulo })),
                event.target.value,
              );
              if (achado) dispatch({ tipo: 'campo', campo: 'unidade', valor: achado.rotulo });
            }}
          />
          <datalist id="unidades-pedido">
            {base.unidades.map((unidade) => (
              <option key={unidade.sigla} value={unidade.rotulo} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Embarque</span>
          <input type="date" {...campo('dataEmbarque')} />
        </label>
        <label>
          <span>Entrega</span>
          <input type="date" {...campo('dataEntrega')} />
        </label>
      </div>
      <label className="emissor-observacao">
        <span>Observação</span>
        <textarea
          rows={2}
          value={dados.observacao}
          onChange={(event) => dispatch({ tipo: 'campo', campo: 'observacao', valor: event.target.value })}
        />
      </label>
      {dados.dataEmbarque !== '' && dados.dataEntrega !== '' && dados.dataEntrega < dados.dataEmbarque && (
        <p className="hint">A entrega está antes do embarque — confira as datas.</p>
      )}
    </section>
  );
}
