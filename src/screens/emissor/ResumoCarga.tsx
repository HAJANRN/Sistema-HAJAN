import { resumoPedido } from '../../emissor/calculo';
import type { Estado } from '../../emissor/estado';
import { formatarMoeda, formatarNumero } from '../../emissor/formato';

export function ResumoCarga({ estado }: { estado: Estado }) {
  const resumo = resumoPedido({ ...estado.dados, entregas: estado.entregas });
  return (
    <div className="emissor-resumo tabular">
      <span>
        <small>Peso</small>
        <strong>{formatarNumero(resumo.pesoTotal)} kg</strong>
      </span>
      <span>
        <small>Veículo</small>
        <strong>{resumo.veiculo}</strong>
      </span>
      <span>
        <small>Valor</small>
        <strong>R$ {formatarMoeda(resumo.valor)}</strong>
      </span>
      <span>
        <small>Entregas</small>
        <strong>{resumo.entregas}</strong>
      </span>
    </div>
  );
}
