import type { InvoiceKind, Order } from './types';

/** Nota de venda (ou revenda) emitida no ERP: representa um valor a receber do cliente. */
export interface TituloReceber {
  chave: string;
  numero: string;
  serie: string | null;
  emissao: string | null;
  cliente: string;
  pedido: number;
  tipo: InvoiceKind;
  valor: number;
  kg: number;
}

export function titulosDe(pedidos: Order[]): TituloReceber[] {
  const titulos: TituloReceber[] = [];
  for (const pedido of pedidos) {
    const faturamento = pedido.billing;
    if (!faturamento) continue;
    for (const [indice, nota] of faturamento.invoices.entries()) {
      const tipo = nota.kind ?? 'venda';
      if (tipo === 'devolucao') continue;
      titulos.push({
        chave: `${pedido.id}-${nota.number}-${nota.series ?? ''}-${indice}`,
        numero: nota.number,
        serie: nota.series,
        emissao: nota.date ?? faturamento.billedAt,
        cliente: nota.clientOfficial ?? nota.client ?? pedido.client ?? '—',
        pedido: pedido.number,
        tipo,
        valor: nota.value,
        kg: nota.kg,
      });
    }
  }
  return titulos;
}
