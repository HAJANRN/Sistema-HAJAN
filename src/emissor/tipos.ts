export interface ClienteBase {
  codigo: string;
  nome: string;
  cnpj: string;
  cidade: string;
  uf: string;
  prazo: string;
  codigoCentralizador: string;
  centralizador: string;
  statusCliente: string;
  limite: number;
  disponivel: number;
}

export interface ProdutoBase {
  codigo: string;
  descricao: string;
  rotulo: string;
  unidade: string;
  peso: number;
  categoria: string;
}

export interface UnidadeBase {
  sigla: string;
  nome: string;
  rotulo: string;
  critica: string;
}

export interface BaseEmissor {
  revision: string;
  clientes: ClienteBase[];
  produtos: ProdutoBase[];
  unidades: UnidadeBase[];
  /** Maior número do histórico + 1 (sugestão para o formulário). */
  proximoNumero: string;
  /** Todos os clientes; SEM DESTINO primeiro (operação 3). */
  destinos: string[];
}

export interface ProdutoForm {
  id: string;
  codigo: string;
  descricao: string;
  qtd: number;
  unidade: string;
  peso: number;
  preco: number;
  prazo: string;
  categoria: string;
}

export interface EntregaForm {
  id: string;
  cliente: string;
  operacao: 3 | 9;
  destino: string;
  pesoManual: number | null;
  produtos: ProdutoForm[];
}

export interface PedidoForm {
  numero: string;
  atencao: string;
  local: string;
  unidade: string;
  observacao: string;
  /** Datas ISO (a tela usa <input type="date">). */
  dataEmissao: string;
  dataEmbarque: string;
  dataEntrega: string;
  entregas: EntregaForm[];
}

export interface CloneProduto {
  codigo: string;
  descricao: string;
  qtd: number;
  unidade: string;
  peso: number;
  preco: number;
  prazo: string;
}

export interface CloneEntrega {
  cliente: string;
  destino: string;
  operacao: number;
  peso_manual?: number | null;
  produtos: CloneProduto[];
}

export interface ClonePayload {
  numero: string;
  atencao: string;
  local: string;
  unidade: string;
  observacao: string;
  data_pedido: string;
  data_embarque: string;
  data_entrega: string;
  entregas: CloneEntrega[];
}

export interface ResumoPedido {
  categorias: string;
  pesoTotal: number;
  valor: number;
  veiculo: 'Bi-truck' | 'Carreta';
  entregas: number;
  nfsRemessa: number;
}
