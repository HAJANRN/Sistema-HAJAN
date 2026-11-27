import type { EntregaForm, PedidoForm, ResumoPedido } from './tipos';

export const CATEGORIAS = ['CXS', 'PÇS', 'CHQ', 'SPG'] as const;

/** Cliente ou destino de entrega ESC: não tem produtos, o peso é digitado. */
export function ehEsc(texto: string): boolean {
  return /^ESC(\s|$)/i.test(String(texto ?? '').trim());
}

/** Categoria do produto (comparação exata, como rotulo_categorias do Emissor); desconhecida fica de fora. */
export function categoriaDoProduto(categoria: string): string {
  const texto = String(categoria ?? '').trim().toUpperCase();
  return (CATEGORIAS as readonly string[]).includes(texto) ? texto : '';
}

export function categoriasDoPedido(pedido: PedidoForm): string[] {
  const presentes = new Set<string>();
  for (const entrega of pedido.entregas) {
    if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) continue;
    for (const produto of entrega.produtos) {
      const categoria = categoriaDoProduto(produto.categoria);
      if (categoria) presentes.add(categoria);
    }
  }
  if (presentes.size === 0) presentes.add('PÇS');
  return CATEGORIAS.filter((c) => presentes.has(c));
}

export function rotuloCategorias(pedido: PedidoForm): string {
  return categoriasDoPedido(pedido).join('-');
}

export function pesoEntrega(entrega: EntregaForm): number {
  if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) return Number(entrega.pesoManual ?? 0);
  return entrega.produtos.reduce((soma, p) => soma + p.qtd * p.peso, 0);
}

export function valorEntrega(entrega: EntregaForm): number {
  return entrega.produtos.reduce((soma, p) => soma + p.qtd * p.peso * p.preco, 0);
}

export function pesoTotal(pedido: PedidoForm): number {
  return pedido.entregas.reduce((soma, e) => soma + pesoEntrega(e), 0);
}

export function valorTotal(pedido: PedidoForm): number {
  return pedido.entregas.reduce((soma, e) => soma + valorEntrega(e), 0);
}

export function veiculoDoPeso(peso: number): 'Bi-truck' | 'Carreta' {
  return peso <= 17000 ? 'Bi-truck' : 'Carreta';
}

export function nfsRemessa(pedido: PedidoForm): number {
  return pedido.entregas.filter((e) => e.operacao !== 9).length;
}

export function resumoPedido(pedido: PedidoForm): ResumoPedido {
  const peso = pesoTotal(pedido);
  return {
    categorias: rotuloCategorias(pedido),
    pesoTotal: peso,
    valor: valorTotal(pedido),
    veiculo: veiculoDoPeso(peso),
    entregas: pedido.entregas.length,
    nfsRemessa: nfsRemessa(pedido),
  };
}
