// Este módulo é carregado direto pelo `node --test`, que exige extensão no
// specifier ESM; o tsconfig usa moduleResolution "bundler" e recusa ".ts".
// @ts-ignore TS5097: extensão necessária para o runner de testes
import { normalizarBusca } from './formato.ts';
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
  | { tipo: 'removerProduto'; entregaId: string; produtoId: string }
  | { tipo: 'aplicarClone'; payload: ClonePayload; base: BaseEmissor }
  | { tipo: 'aviso'; texto: string }
  | { tipo: 'limparAvisos' };

let sequencia = 0;
const novoId = () => `id${++sequencia}`;

const isoHoje = () => {
  const d = new Date();
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
};

const brParaIso = (texto: string): string => {
  const achado = String(texto ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!achado) return '';
  const ano = Number(achado[3]) < 100 ? Number(achado[3]) + 2000 : Number(achado[3]);
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${ano}-${dois(Number(achado[2]))}-${dois(Number(achado[1]))}`;
};

const prazoDoCliente = (base: BaseEmissor, cliente: string, clienteBase?: string) => {
  const nome = normalizarBusca(clienteBase || cliente);
  const achado = base.clientes.find(
    (c) => normalizarBusca(c.nome) === nome || normalizarBusca(c.codigo) === nome,
  );
  return achado?.prazo || '';
};

function produtoVazio(base: BaseEmissor, prazo: string): ProdutoForm {
  const primeiro = base.produtos[0];
  return {
    id: novoId(),
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

function entregaVazia(base: BaseEmissor): EntregaForm {
  const cliente = base.clientes[0];
  return {
    id: novoId(),
    cliente: cliente?.nome ?? '',
    operacao: 3,
    destino: 'SEM DESTINO',
    pesoManual: null,
    produtos: [produtoVazio(base, cliente?.prazo ?? '')],
  };
}

/**
 * Ids do estado inicial são determinísticos: duas chamadas de estadoInicial(base)
 * devolvem os mesmos ids (o contador global só serve para itens criados depois).
 */
function entregasIniciais(base: BaseEmissor): EntregaForm[] {
  const entrega = entregaVazia(base);
  return [
    {
      ...entrega,
      id: 'inicio-entrega-1',
      produtos: entrega.produtos.map((produto, indice) => ({
        ...produto,
        id: `inicio-produto-${indice + 1}`,
      })),
    },
  ];
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
  const unidade =
    base.unidades.find((u) => normalizarBusca(u.rotulo) === normalizarBusca(payload.unidade))?.rotulo ??
    payload.unidade;
  const hoje = isoHoje();
  const entregas: EntregaForm[] = (payload.entregas ?? []).map((entrega) => {
    const prazo = prazoDoCliente(base, entrega.cliente);
    return {
      id: novoId(),
      cliente: entrega.cliente,
      operacao: entrega.operacao === 9 ? 9 : 3,
      destino: entrega.destino ?? '',
      pesoManual: entrega.peso_manual ?? null,
      produtos: (entrega.produtos ?? []).map((produto) => ({
        id: novoId(),
        codigo: produto.codigo,
        descricao: produto.descricao,
        qtd: Number(produto.qtd) || 0,
        unidade: produto.unidade || 'kg',
        peso: Number(produto.peso) || 1,
        preco: Number(produto.preco) || 0,
        prazo: produto.prazo || prazo,
        categoria: base.produtos.find((p) => p.codigo === produto.codigo)?.categoria ?? '',
      })),
    };
  });
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
    entregas: entregas.length > 0 ? entregas : estadoAtual.entregas,
  };
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
        entregas: estado.entregas.map((e) =>
          e.id === acao.id ? { ...e, [acao.campo]: acao.valor } : e,
        ),
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
                  p.id === acao.produtoId
                    ? ({ ...p, [acao.campo]: acao.valor } as ProdutoForm)
                    : p,
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
