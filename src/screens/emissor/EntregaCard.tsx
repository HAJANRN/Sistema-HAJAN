import { useState, type Dispatch } from 'react';
import { CATEGORIAS, categoriaDoProduto, ehEsc, pesoEntrega, valorEntrega } from '../../emissor/calculo';
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
  nome,
}: {
  valor: number | null;
  onValor: (valor: number) => void;
  /** Chamado quando o campo é esvaziado e perde o foco (campos que aceitam vazio). */
  aoEsvaziar?: () => void;
  className?: string;
  inputMode?: 'numeric' | 'decimal';
  /** Quantidade é inteira, como no Emissor. */
  arredondar?: boolean;
  /** Nome acessível: dentro da tabela não há <label> em volta. */
  nome?: string;
}) {
  const [texto, setTexto] = useState<string | null>(null);
  const exibido = texto ?? (valor === null ? '' : String(valor).replace('.', ','));

  return (
    <input
      className={className}
      inputMode={inputMode}
      aria-label={nome}
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
  // Mesma regra do produto: nome de clone antigo que saiu da base continua visível.
  const clienteForaDaBase =
    entrega.cliente !== '' && !base.clientes.some((c) => c.nome === entrega.cliente);
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
            {/* Cliente vindo de um clone pode não existir mais na base: sem esta opção
                o <select> apareceria em branco e preso no valor antigo. */}
            {clienteForaDaBase && (
              <option value={entrega.cliente}>{entrega.cliente} (fora do catálogo)</option>
            )}
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
        {/* Destino é só da operação 3 (spec); na 9 o campo não existe e o reducer o ignora. */}
        {entrega.operacao === 3 && (
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
        )}
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
                <th scope="col">Categoria</th>
                <th scope="col">Produto</th>
                <th scope="col">Qtde.</th>
                <th scope="col">Unid.</th>
                <th scope="col">Peso</th>
                <th scope="col">Preço</th>
                <th scope="col">Prazo</th>
                <th scope="col" aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {entrega.produtos.map((produto, linha) => {
                const nome = produto.descricao || produto.codigo || `item ${linha + 1}`;
                const catalogo =
                  produto.codigo === ''
                    ? undefined
                    : base.produtos.find((p) => p.codigo === produto.codigo);
                // Código vindo de um clone pode não existir mais no catálogo: sem esta
                // opção o <select> apareceria em branco e preso no valor antigo.
                const foraDoCatalogo = produto.codigo !== '' && !catalogo;
                // Categoria da linha: a escolhida ou, em "Auto", a que vem do catálogo.
                const categoriaCatalogo = categoriaDoProduto(catalogo?.categoria ?? '');
                const categoriaLinha = categoriaDoProduto(produto.categoria) || categoriaCatalogo;
                const opcoes = (lista: typeof base.produtos) =>
                  lista.map((p) => (
                    <option key={p.codigo} value={p.codigo}>
                      {p.rotulo}
                    </option>
                  ));
                // A categoria escolhida prioriza o catálogo no seletor de produto (o
                // controle segmentado do Emissor filtrava; aqui agrupa para não esconder
                // produto nenhum — inclusive o que já está na linha).
                const prioritarios = categoriaLinha
                  ? base.produtos.filter((p) => categoriaDoProduto(p.categoria) === categoriaLinha)
                  : base.produtos;
                const restantes = categoriaLinha
                  ? base.produtos.filter((p) => categoriaDoProduto(p.categoria) !== categoriaLinha)
                  : [];
                return (
                  <tr key={produto.id}>
                    <td>
                      {/* "Auto" = herdar do catálogo; é o padrão de um produto do catálogo.
                          Produto sem categoria de catálogo cai em PÇS, como no servidor. */}
                      <select
                        aria-label={`Categoria — ${nome}`}
                        value={produto.categoria}
                        onChange={(event) => campoProduto(produto, 'categoria', event.target.value)}
                      >
                        <option value="">{categoriaCatalogo ? `Auto — ${categoriaCatalogo}` : 'Auto — PÇS'}</option>
                        {CATEGORIAS.map((categoria) => (
                          <option key={categoria} value={categoria}>
                            {categoria}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Produto da linha ${linha + 1}`}
                        value={produto.codigo}
                        onChange={(event) => {
                          const codigo = event.target.value;
                          if (codigo === '') {
                            // "—" limpa o produto; sem isso o código antigo ficaria preso.
                            dispatch({ tipo: 'limparProduto', entregaId: entrega.id, produtoId: produto.id });
                            return;
                          }
                          const escolhido = base.produtos.find((p) => p.codigo === codigo);
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
                        {foraDoCatalogo && <option value={produto.codigo}>{produto.codigo} (fora do catálogo)</option>}
                        {categoriaLinha ? (
                          <>
                            <optgroup label={`Categoria ${categoriaLinha}`}>{opcoes(prioritarios)}</optgroup>
                            {restantes.length > 0 && (
                              <optgroup label="Outras categorias">{opcoes(restantes)}</optgroup>
                            )}
                          </>
                        ) : (
                          opcoes(prioritarios)
                        )}
                      </select>
                    </td>
                    <td>
                      <CampoNumero
                        className="num"
                        inputMode="numeric"
                        arredondar
                        nome={`Quantidade — ${nome}`}
                        valor={produto.qtd}
                        onValor={(valor) => campoProduto(produto, 'qtd', valor)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Unidade — ${nome}`}
                        value={produto.unidade}
                        onChange={(event) => campoProduto(produto, 'unidade', event.target.value)}
                      />
                    </td>
                    <td>
                      {/* O servidor usa o peso do catálogo quando o código existe (qtd ×
                          peso), então a linha mostra esse valor em vez de aceitar um
                          número que o PDF ignoraria. Fora do catálogo, o peso é editável. */}
                      {catalogo ? (
                        <span className="fixo num" title="Peso do catálogo — não editável">
                          {String(catalogo.peso).replace('.', ',')}
                        </span>
                      ) : (
                        <CampoNumero
                          className="num"
                          inputMode="decimal"
                          nome={`Peso unitário — ${nome}`}
                          valor={produto.peso}
                          onValor={(valor) => campoProduto(produto, 'peso', valor)}
                        />
                      )}
                    </td>
                    <td>
                      <CampoNumero
                        className="num"
                        inputMode="decimal"
                        nome={`Preço unitário — ${nome}`}
                        valor={produto.preco}
                        onValor={(valor) => campoProduto(produto, 'preco', valor)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Prazo — ${nome}`}
                        value={produto.prazo}
                        onChange={(event) => campoProduto(produto, 'prazo', event.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost small"
                        aria-label={`Remover produto da linha ${linha + 1}`}
                        disabled={entrega.produtos.length <= 1}
                        onClick={() =>
                          dispatch({ tipo: 'removerProduto', entregaId: entrega.id, produtoId: produto.id })
                        }
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
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
              Peso {formatarNumero(pesoEntrega(entrega), 1)} kg · Valor R$ {formatarMoeda(valorEntrega(entrega))}
            </span>
          </div>
        </>
      )}
    </article>
  );
}
