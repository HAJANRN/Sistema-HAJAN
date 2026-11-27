export const CATEGORIAS = ['CXS', 'PÇS', 'CHQ', 'SPG'];

export function ehEsc(texto) {
  return /^ESC(\s|$)/i.test(String(texto ?? '').trim());
}

export function categoriaDoProduto(categoria) {
  const texto = String(categoria ?? '').trim().toUpperCase();
  return CATEGORIAS.includes(texto) ? texto : '';
}

function produtoDeCategoria(produto) {
  return categoriaDoProduto(produto?.categoria);
}

export function categoriasDoPedido(entregas) {
  const presentes = new Set();
  for (const entrega of entregas ?? []) {
    if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) continue;
    for (const produto of entrega.produtos ?? []) {
      const categoria = produtoDeCategoria(produto);
      if (categoria) presentes.add(categoria);
    }
  }
  if (presentes.size === 0) presentes.add('PÇS');
  return CATEGORIAS.filter((c) => presentes.has(c));
}

export function pesoEntrega(entrega) {
  if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) return Number(entrega.pesoManual ?? 0);
  return (entrega.produtos ?? []).reduce(
    (soma, p) => soma + Number(p.qtd ?? 0) * Number(p.peso ?? 0),
    0,
  );
}

export function valorEntrega(entrega) {
  return (entrega.produtos ?? []).reduce(
    (soma, p) => soma + Number(p.qtd ?? 0) * Number(p.peso ?? 0) * Number(p.preco ?? 0),
    0,
  );
}

export function veiculoDoPeso(peso) {
  return peso <= 17000 ? 'Bi-truck' : 'Carreta';
}

export function resumoPedido(pedido) {
  const entregas = pedido.entregas ?? [];
  const pesoTotal = entregas.reduce((soma, e) => soma + pesoEntrega(e), 0);
  return {
    categorias: categoriasDoPedido(entregas).join('-'),
    pesoTotal,
    valor: entregas.reduce((soma, e) => soma + valorEntrega(e), 0),
    veiculo: veiculoDoPeso(pesoTotal),
    entregas: entregas.length,
    nfsRemessa: entregas.filter((e) => Number(e.operacao) !== 9).length,
  };
}

/** Linhas de uma categoria, como registrar_pedidos_semana do Emissor: só entregas com produto da categoria (ESC entra em PÇS). */
export function linhasHistorico(entregas, clientesPorNome, categoria) {
  return (entregas ?? [])
    .map((entrega, indice) => ({ entrega, indice }))
    .filter(({ entrega }) => {
      if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) return categoria === 'PÇS';
      return (entrega.produtos ?? []).some((p) => produtoDeCategoria(p) === categoria);
    })
    .map(({ entrega, indice }) => {
      const cliente = String(entrega.cliente ?? '').trim();
      const esc = ehEsc(cliente) || ehEsc(entrega.destino);
      const destinoBruto = String(entrega.destino ?? '').trim() || cliente;
      const destino = esc ? destinoBruto.replace(/\s*\(0\)\s*$/, '').trim() : destinoBruto;
      const clienteLinha = esc ? destino : cliente;
      const dados = clientesPorNome.get(esc ? destinoBruto : cliente) ?? clientesPorNome.get(destino);
      return {
        indice: indice + 1,
        destino,
        cliente: clienteLinha,
        localizacao: dados ? `${dados.cidade}-${dados.uf}` : '',
      };
    });
}

export function dataBr(iso) {
  const achado = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return achado ? `${achado[3]}/${achado[2]}/${achado[1]}` : String(iso ?? '');
}

export function dataBrCurta(iso) {
  const achado = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return achado ? `${achado[3]}/${achado[2]}/${achado[1].slice(2)}` : String(iso ?? '');
}

export function dataCurta(iso) {
  const achado = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return achado ? `${achado[3]}.${achado[2]}.${achado[1].slice(2)}` : String(iso ?? '');
}

export function nomeArquivoPdf({ numero, categorias, sigla, dataEmbarque }) {
  const bruto = `Pedido Hajan ${categorias} nº ${numero} (Embarque ${sigla} ${dataCurta(dataEmbarque)}).pdf`;
  const limpo = bruto.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  return limpo || 'pedido.pdf';
}
