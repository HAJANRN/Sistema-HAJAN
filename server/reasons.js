/** Motivos de anomalia usados pelo servidor (as etiquetas vão para o PDF de resumo). */
export const REFUSAL_LABELS = {
  falta_peso: 'Falta de peso',
  falta_pecas: 'Falta de peças',
  falta_peso_peca: 'Falta de peso e peça',
  sobra_peso: 'Sobra de peso',
  troca_palete: 'Troca de palete',
  falta_caixa: 'Falta de caixa',
  qualidade: 'Qualidade',
  sem_vacuo: 'Mercadoria sem vácuo',
  produto_invertido: 'Produto invertido',
  camera_fria: 'Problema na câmara fria',
  falha_padrao: 'Falha de padrão',
  erro_faturamento: 'Erro no faturamento',
  desconto_preco: 'Desconto de preço',
  erro_digitacao: 'Erro de digitação',
  erro_envio_pedido: 'Erro no envio do pedido',
  divergencia_pedido: 'Divergência de pedido',
  cadastro: 'Cadastro',
  atraso_entrega: 'Atraso de entrega',
  sem_espaco_recebimento: 'Sem espaço para recebimento',
  outro: 'Outro',
};

export const REFUSAL_REASONS = Object.keys(REFUSAL_LABELS);
