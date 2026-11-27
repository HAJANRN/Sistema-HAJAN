import { converterData, converterNumero, dataIso, normalizarBusca } from './formato.ts';
import type {
  BaseEmissor,
  ClonePayload,
  EntregaForm,
  PedidoForm,
  ProdutoBase,
  ProdutoForm,
} from './tipos';

export interface DadosGerais {
  numero: string;
  atencao: string;
  local: string;
  unidade: string;
  observacao: string;
  dataEmissao: string;
  dataEmbarque: string;
  dataEntrega: string;
}

export interface Estado {
  carregado: boolean;
  base: BaseEmissor;
  dados: DadosGerais;
  entregas: EntregaForm[];
  avisos: string[];
}

export type Acao =
  | { tipo: 'campo'; campo: keyof DadosGerais; valor: string }
  | { tipo: 'novaEntrega' }
  | { tipo: 'duplicarEntrega'; id: string }
  | { tipo: 'removerEntrega'; id: string }
  | { tipo: 'moverEntrega'; id: string; direcao: -1 | 1 }
  | { tipo: 'campoEntrega'; id: string; campo: 'cliente' | 'destino'; valor: string }
  | { tipo: 'operacao'; id: string; valor: 3 | 9 }
  | { tipo: 'pesoManual'; id: string; valor: number | null }
  | { tipo: 'novoProduto'; entregaId: string }
  | { tipo: 'campoProduto'; entregaId: string; produtoId: string; campo: keyof ProdutoForm; valor: string | number }
  | { tipo: 'produtoDoCatalogo'; entregaId: string; produtoId: string; produto: ProdutoBase }
  | { tipo: 'limparProduto'; entregaId: string; produtoId: string }
  | { tipo: 'removerProduto'; entregaId: string; produtoId: string }
  | { tipo: 'aplicarClone'; payload: ClonePayload; base: BaseEmissor }
  | { tipo: 'aviso'; texto: string }
  | { tipo: 'limparAvisos' };

let sequencia = 0;
const novoId = () => `id${++sequencia}`;

const isoHoje = () => dataIso(new Date());

/** dd/mm/aaaa (também dd-mm-aaaa, dd.mm.aaaa) → ISO. Vazio ou inválida → ''. */
const brParaIso = (texto: string): string => {
  const data = converterData(texto);
  return data ? dataIso(data) : '';
};

/** Valor numérico do payload; 0 é um valor legítimo, não cai no padrão. */
const numeroOu = (valor: unknown, padrao: number): number => {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : padrao;
  if (typeof valor === 'string') {
    const numero = converterNumero(valor);
    return numero === null ? padrao : numero;
  }
  return padrao;
};

const prazoDoCliente = (base: BaseEmissor, cliente: string) => {
  const nome = normalizarBusca(cliente);
  const achado = base.clientes.find(
    (c) => normalizarBusca(c.nome) === nome || normalizarBusca(c.codigo) === nome,
  );
  return achado?.prazo || '';
};

function produtoVazio(base: BaseEmissor, prazo: string, id: string = novoId()): ProdutoForm {
  const primeiro = base.produtos[0];
  return {
    id,
    codigo: primeiro?.codigo ?? '',
    descricao: primeiro?.descricao ?? '',
    qtd: 1,
    unidade: primeiro?.unidade ?? 'kg',
    peso: primeiro?.peso ?? 1,
    preco: 0,
    prazo,
    categoria: primeiro?.categoria ?? 'CXS',
  };
}

function entregaVazia(
  base: BaseEmissor,
  id: string = novoId(),
  produtoId: string = novoId(),
): EntregaForm {
  const cliente = base.clientes[0];
  return {
    id,
    cliente: cliente?.nome ?? '',
    operacao: 3,
    destino: 'SEM DESTINO',
    pesoManual: null,
    produtos: [produtoVazio(base, cliente?.prazo ?? '', produtoId)],
  };
}

/**
 * Ids do estado inicial são determinísticos: duas chamadas de estadoInicial(base)
 * devolvem os mesmos ids (o contador global só serve para itens criados depois).
 */
function entregasIniciais(base: BaseEmissor): EntregaForm[] {
  return [entregaVazia(base, 'inicio-entrega-1', 'inicio-produto-1')];
}

export function estadoInicial(base: BaseEmissor): Estado {
  const hoje = isoHoje();
  return {
    carregado: true,
    base,
    dados: {
      numero: base.proximoNumero,
      atencao: 'Helcio Venancio',
      local: 'Natal',
      unidade: base.unidades[0]?.rotulo ?? '',
      observacao: '',
      dataEmissao: hoje,
      dataEmbarque: hoje,
      dataEntrega: hoje,
    },
    entregas: entregasIniciais(base),
    avisos: [],
  };
}

export function trocarOperacao(estado: Estado, id: string, operacao: 3 | 9): Estado {
  return {
    ...estado,
    entregas: estado.entregas.map((e) =>
      e.id === id ? { ...e, operacao, destino: operacao === 9 ? '' : e.destino || 'SEM DESTINO' } : e,
    ),
  };
}

export function aplicarClone(estadoAtual: Estado, payload: ClonePayload, base: BaseEmissor): Estado {
  const buscaUnidade = normalizarBusca(payload.unidade);
  const unidade =
    base.unidades.find(
      (u) =>
        normalizarBusca(u.rotulo) === buscaUnidade ||
        normalizarBusca(u.sigla) === buscaUnidade ||
        normalizarBusca(u.nome) === buscaUnidade,
    )?.rotulo ??
    payload.unidade;
  const hoje = isoHoje();
  const entregas: EntregaForm[] = (payload.entregas ?? []).map((entrega) => {
    const prazo = prazoDoCliente(base, entrega.cliente);
    const operacao = entrega.operacao === 9 ? 9 : 3;
    return {
      id: novoId(),
      cliente: entrega.cliente,
      operacao,
      // Operação 9 não tem destino (spec): o clone não pode reintroduzi-lo.
      destino: operacao === 9 ? '' : (entrega.destino ?? ''),
      pesoManual: entrega.peso_manual ?? null,
      produtos: (entrega.produtos ?? []).map((produto) => ({
        id: novoId(),
        codigo: produto.codigo,
        descricao: produto.descricao,
        qtd: numeroOu(produto.qtd, 0),
        unidade: produto.unidade || 'kg',
        peso: numeroOu(produto.peso, 1),
        preco: numeroOu(produto.preco, 0),
        prazo: produto.prazo || prazo,
        categoria: base.produtos.find((p) => p.codigo === produto.codigo)?.categoria ?? '',
      })),
    };
  });
  // Clone sem entregas mantém as atuais (contrato do brief) como cópia, sem
  // compartilhar as referências do estado anterior.
  const anteriores: EntregaForm[] = estadoAtual.entregas.map((entrega) => ({
    ...entrega,
    produtos: entrega.produtos.map((produto) => ({ ...produto })),
  }));
  return {
    ...estadoAtual,
    dados: {
      numero: String(payload.numero ?? estadoAtual.dados.numero),
      atencao: payload.atencao || 'Helcio Venancio',
      local: payload.local || 'Natal',
      unidade,
      observacao: payload.observacao ?? '',
      dataEmissao: brParaIso(payload.data_pedido) || hoje,
      dataEmbarque: brParaIso(payload.data_embarque) || hoje,
      dataEntrega: brParaIso(payload.data_entrega) || hoje,
    },
    entregas: entregas.length > 0 ? entregas : anteriores,
  };
}

/** Aplica um campo do formulário convertendo o valor para o tipo da coluna. */
function produtoComCampo(
  produto: ProdutoForm,
  campo: keyof ProdutoForm,
  valor: string | number,
): ProdutoForm {
  const copia: ProdutoForm = { ...produto };
  if (campo === 'qtd' || campo === 'peso' || campo === 'preco') {
    const numero = typeof valor === 'number' ? valor : converterNumero(valor);
    if (numero === null || !Number.isFinite(numero)) return produto;
    copia[campo] = numero;
  } else {
    copia[campo] = String(valor ?? '');
  }
  return copia;
}

/**
 * Produto sem código: linha vazia depois de escolher "—" no seletor (o clone de
 * um código fora do catálogo não fica preso). O servidor recusa a emissão
 * enquanto não houver produto escolhido, que é o mesmo que a linha em branco diz.
 */
function produtoLimpo(produto: ProdutoForm): ProdutoForm {
  return { ...produto, codigo: '', descricao: '', categoria: '', qtd: 1, peso: 0, preco: 0 };
}

const mover = <T,>(lista: T[], indice: number, direcao: -1 | 1): T[] => {
  const destino = indice + direcao;
  if (indice < 0 || destino < 0 || destino >= lista.length) return lista;
  const copia = [...lista];
  [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
  return copia;
};

export function reduzir(estado: Estado, acao: Acao): Estado {
  switch (acao.tipo) {
    case 'campo':
      return { ...estado, dados: { ...estado.dados, [acao.campo]: acao.valor } };
    case 'novaEntrega':
      return { ...estado, entregas: [...estado.entregas, entregaVazia(estado.base)] };
    case 'duplicarEntrega': {
      const indice = estado.entregas.findIndex((e) => e.id === acao.id);
      if (indice < 0) return estado;
      const original = estado.entregas[indice];
      const copia: EntregaForm = {
        ...original,
        id: novoId(),
        produtos: original.produtos.map((p) => ({ ...p, id: novoId() })),
      };
      const entregas = [...estado.entregas];
      entregas.splice(indice + 1, 0, copia);
      return { ...estado, entregas };
    }
    case 'removerEntrega': {
      if (estado.entregas.length <= 1) return estado;
      return { ...estado, entregas: estado.entregas.filter((e) => e.id !== acao.id) };
    }
    case 'moverEntrega': {
      const indice = estado.entregas.findIndex((e) => e.id === acao.id);
      return { ...estado, entregas: mover(estado.entregas, indice, acao.direcao) };
    }
    case 'campoEntrega':
      return {
        ...estado,
        entregas: estado.entregas.map((e) => {
          if (e.id !== acao.id) return e;
          // Operação 9 não tem destino (spec): nem um dispatch direto o reintroduz.
          if (acao.campo === 'destino' && e.operacao === 9) return e;
          return { ...e, [acao.campo]: acao.valor };
        }),
      };
    case 'operacao':
      return trocarOperacao(estado, acao.id, acao.valor);
    case 'pesoManual':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.id ? { ...e, pesoManual: acao.valor } : e,
        ),
      };
    case 'novoProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: [
                  ...e.produtos,
                  produtoVazio(estado.base, prazoDoCliente(estado.base, e.cliente)),
                ],
              }
            : e,
        ),
      };
    case 'campoProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: e.produtos.map((p) =>
                  p.id === acao.produtoId ? produtoComCampo(p, acao.campo, acao.valor) : p,
                ),
              }
            : e,
        ),
      };
    case 'produtoDoCatalogo':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: e.produtos.map((p) =>
                  p.id === acao.produtoId
                    ? {
                        ...p,
                        codigo: acao.produto.codigo,
                        descricao: acao.produto.descricao,
                        unidade: acao.produto.unidade,
                        peso: acao.produto.peso,
                        categoria: acao.produto.categoria,
                      }
                    : p,
                ),
              }
            : e,
        ),
      };
    case 'limparProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: e.produtos.map((p) => (p.id === acao.produtoId ? produtoLimpo(p) : p)),
              }
            : e,
        ),
      };
    case 'removerProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? { ...e, produtos: e.produtos.filter((p) => p.id !== acao.produtoId) }
            : e,
        ),
      };
    case 'aplicarClone':
      return aplicarClone(estado, acao.payload, acao.base);
    case 'aviso':
      return { ...estado, avisos: [...estado.avisos, acao.texto] };
    case 'limparAvisos':
      return { ...estado, avisos: [] };
  }
}

/** O formulário guarda ids locais; a API recebe só os dados. */
export function pedidoDe(estado: Estado): PedidoForm {
  return {
    ...estado.dados,
    entregas: estado.entregas.map((e) => ({
      ...e,
      produtos: e.produtos.map((p) => ({ ...p })),
    })),
  };
}

/** Corpo do POST /api/emissor/pedidos, sem campos de uso local. */
export function paraPayloadApi(pedido: PedidoForm) {
  return {
    numero: pedido.numero,
    atencao: pedido.atencao,
    local: pedido.local,
    unidade: pedido.unidade,
    observacao: pedido.observacao,
    dataEmissao: pedido.dataEmissao,
    dataEmbarque: pedido.dataEmbarque,
    dataEntrega: pedido.dataEntrega,
    entregas: pedido.entregas.map((e) => ({
      cliente: e.cliente,
      operacao: e.operacao,
      destino: e.destino,
      pesoManual: e.pesoManual,
      produtos: e.produtos.map((p) => ({
        codigo: p.codigo,
        descricao: p.descricao,
        qtd: p.qtd,
        unidade: p.unidade,
        peso: p.peso,
        preco: p.preco,
        prazo: p.prazo,
      })),
    })),
  };
}
