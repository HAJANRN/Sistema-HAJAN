import { useState, type Dispatch } from 'react';
import { ehEsc, pesoEntrega, valorEntrega } from '../../emissor/calculo';
import type { Acao } from '../../emissor/estado';
import { converterNumero, formatarMoeda, formatarNumero } from '../../emissor/formato';
import type { BaseEmissor, EntregaForm, ProdutoForm } from '../../emissor/tipos';

interface Props {
  entrega: EntregaForm;
  indice: number;
  total: number;
  base: BaseEmissor;
  dispatch: Dispatch<Acao>;
}

/**
 * O reducer descarta número inválido ('' / '12.' / '12,') e mantém o valor
 * anterior, então despachar cada tecla crua impediria limpar e digitar decimal.
 * Aqui o texto digitado vive no componente até virar número; o estado só recebe
 * valores válidos e, ao sair do campo, inválido/vazio volta a mostrar o último
 * valor válido (como o number_input do Emissor).
 */
function CampoNumero({
  valor,
  onValor,
  aoEsvaziar,
  className,
  inputMode,
  arredondar,
}: {
  valor: number | null;
  onValor: (valor: number) => void;
  /** Chamado quando o campo é esvaziado e perde o foco (campos que aceitam vazio). */
  aoEsvaziar?: () => void;
  className?: string;
  inputMode?: 'numeric' | 'decimal';
  /** Quantidade é inteira, como no Emissor. */
  arredondar?: boolean;
}) {
  const [texto, setTexto] = useState<string | null>(null);
  const exibido = texto ?? (valor === null ? '' : String(valor).replace('.', ','));

  return (
    <input
      className={className}
      inputMode={inputMode}
      value={exibido}
      onChange={(event) => {
        const bruto = event.target.value;
        setTexto(bruto);
        const numero = converterNumero(bruto);
        if (numero !== null) onValor(arredondar ? Math.round(numero) : numero);
      }}
      onBlur={() => {
        if (texto !== null && aoEsvaziar && texto.trim() === '') aoEsvaziar();
        setTexto(null);
      }}
    />
  );
}

export function EntregaCard({ entrega, indice, total, base, dispatch }: Props) {
  const esc = ehEsc(entrega.cliente) || ehEsc(entrega.destino);
  const campoProduto = (produto: ProdutoForm, campo: keyof ProdutoForm, valor: string | number) =>
    dispatch({
      tipo: 'campoProduto',
      entregaId: entrega.id,
      produtoId: produto.id,
      campo,
      valor,
    });

  return (
    <article className="card emissor-entrega">
      <header className="emissor-entrega-topo">
        <strong>Entrega {indice + 1}</strong>
        <div className="emissor-entrega-acoes">
          <button
            type="button"
            className="btn ghost small"
            aria-label="Subir entrega"
            disabled={indice === 0}
            onClick={() => dispatch({ tipo: 'moverEntrega', id: entrega.id, direcao: -1 })}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn ghost small"
            aria-label="Descer entrega"
            disabled={indice === total - 1}
            onClick={() => dispatch({ tipo: 'moverEntrega', id: entrega.id, direcao: 1 })}
          >
            ↓
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => dispatch({ tipo: 'duplicarEntrega', id: entrega.id })}
          >
            Duplicar
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={total <= 1}
            onClick={() => dispatch({ tipo: 'removerEntrega', id: entrega.id })}
          >
            Excluir
          </button>
        </div>
      </header>

      <div className="emissor-grade">
        <label>
          <span>Cliente de faturamento</span>
          <select
            value={entrega.cliente}
            onChange={(event) =>
              dispatch({ tipo: 'campoEntrega', id: entrega.id, campo: 'cliente', valor: event.target.value })
            }
          >
            {base.clientes.map((cliente) => (
              <option key={cliente.codigo} value={cliente.nome}>
                {cliente.nome}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Operação</span>
          <select
            value={entrega.operacao}
            onChange={(event) =>
              dispatch({
                tipo: 'operacao',
                id: entrega.id,
                valor: Number(event.target.value) === 9 ? 9 : 3,
              })
            }
          >
            <option value={3}>3</option>
            <option value={9}>9</option>
          </select>
        </label>
        <label>
          <span>Destino</span>
          <input
            list="destinos-pedido"
            value={entrega.destino}
            onChange={(event) =>
              dispatch({ tipo: 'campoEntrega', id: entrega.id, campo: 'destino', valor: event.target.value })
            }
          />
        </label>
        {esc && (
          <label>
            <span>Peso manual (kg)</span>
            <CampoNumero
              inputMode="decimal"
              valor={entrega.pesoManual}
              onValor={(valor) => dispatch({ tipo: 'pesoManual', id: entrega.id, valor })}
              aoEsvaziar={() => dispatch({ tipo: 'pesoManual', id: entrega.id, valor: null })}
            />
          </label>
        )}
      </div>

      {esc ? (
        <p className="hint">Entrega ESC: sem produtos, o PDF imprime só a linha de peso.</p>
      ) : (
        <>
          <table className="emissor-tabela">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Qtde.</th>
                <th>Unid.</th>
                <th>Peso</th>
                <th>Preço</th>
                <th>Prazo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entrega.produtos.map((produto) => (
                <tr key={produto.id}>
                  <td>
                    <select
                      value={produto.codigo}
                      onChange={(event) => {
                        const escolhido = base.produtos.find((p) => p.codigo === event.target.value);
                        if (escolhido) {
                          dispatch({
                            tipo: 'produtoDoCatalogo',
                            entregaId: entrega.id,
                            produtoId: produto.id,
                            produto: escolhido,
                          });
                        }
                      }}
                    >
                      <option value="">—</option>
                      {base.produtos.map((p) => (
                        <option key={p.codigo} value={p.codigo}>
                          {p.rotulo}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <CampoNumero
                      className="num"
                      inputMode="numeric"
                      arredondar
                      valor={produto.qtd}
                      onValor={(valor) => campoProduto(produto, 'qtd', valor)}
                    />
                  </td>
                  <td>
                    <input value={produto.unidade} onChange={(event) => campoProduto(produto, 'unidade', event.target.value)} />
                  </td>
                  <td>
                    <CampoNumero
                      className="num"
                      inputMode="decimal"
                      valor={produto.peso}
                      onValor={(valor) => campoProduto(produto, 'peso', valor)}
                    />
                  </td>
                  <td>
                    <CampoNumero
                      className="num"
                      inputMode="decimal"
                      valor={produto.preco}
                      onValor={(valor) => campoProduto(produto, 'preco', valor)}
                    />
                  </td>
                  <td>
                    <input value={produto.prazo} onChange={(event) => campoProduto(produto, 'prazo', event.target.value)} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-label="Remover produto"
                      disabled={entrega.produtos.length <= 1}
                      onClick={() =>
                        dispatch({ tipo: 'removerProduto', entregaId: entrega.id, produtoId: produto.id })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="emissor-entrega-pe">
            <button
              type="button"
              className="btn ghost small"
              onClick={() => dispatch({ tipo: 'novoProduto', entregaId: entrega.id })}
            >
              + Produto
            </button>
            <span className="tabular">
              Peso {formatarNumero(pesoEntrega(entrega))} kg · Valor R$ {formatarMoeda(valorEntrega(entrega))}
            </span>
          </div>
        </>
      )}
    </article>
  );
}
