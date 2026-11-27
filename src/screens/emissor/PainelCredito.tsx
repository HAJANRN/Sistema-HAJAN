import { useEffect, useState } from 'react';
import { api, type Carteira } from '../../api';
import { valorEntrega } from '../../emissor/calculo';
import type { Estado } from '../../emissor/estado';
import { formatarMoeda, normalizarBusca } from '../../emissor/formato';
import type { BaseEmissor, ClienteBase } from '../../emissor/tipos';

interface Grupo {
  chave: string;
  nome: string;
  valor: number;
  cliente?: ClienteBase;
}

interface Mensagem {
  texto: string;
  nivel: 'erro' | 'aviso';
}

export function PainelCredito({ estado, base }: { estado: Estado; base: BaseEmissor }) {
  const [carteira, setCarteira] = useState<Carteira | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    api
      .emissorCarteira()
      .then(setCarteira)
      .catch(() => setFalhou(true));
  }, []);

  const grupos = new Map<string, Grupo>();
  for (const entrega of estado.entregas) {
    const cliente = base.clientes.find((c) => c.nome === entrega.cliente);
    const chave = cliente?.codigoCentralizador?.trim() || cliente?.codigo || entrega.cliente;
    const atual: Grupo = grupos.get(chave) ?? {
      chave,
      nome: cliente?.centralizador || cliente?.nome || entrega.cliente,
      valor: 0,
      cliente,
    };
    atual.valor += valorEntrega(entrega);
    grupos.set(chave, atual);
  }

  return (
    <section className="card emissor-credito">
      <h2>Limite por cliente</h2>
      {falhou && <p className="hint">Carteira indisponível — usando o limite da base.</p>}
      {!carteira && !falhou && <p className="panel-sub">Consultando a carteira…</p>}
      <ul>
        {[...grupos.values()].map((grupo) => (
          <LinhaCredito key={grupo.chave} grupo={grupo} carteira={carteira} />
        ))}
      </ul>
      <p className="hint">O painel informa; a geração do pedido não é bloqueada pelo crédito.</p>
    </section>
  );
}

function LinhaCredito({ grupo, carteira }: { grupo: Grupo; carteira: Carteira | null }) {
  const registro = carteira?.disponivel ? carteira.registros[grupo.chave] : undefined;
  const media = carteira?.disponivel ? carteira.media[grupo.chave] : undefined;
  const statusOriginal = registro?.status || grupo.cliente?.statusCliente || '';
  const status = normalizarBusca(statusOriginal);
  const mensagens: Mensagem[] = [];

  // mesmas regras de _mensagem_status_credito do app.py
  const bloqueantes = ['bloqueado', 'protesto', 'juridico', 'falencia', 'recuperacao', 'concordata', 'perdas'];
  if (bloqueantes.some((termo) => status.includes(termo))) {
    mensagens.push({ texto: `Status ${statusOriginal}`, nivel: 'erro' });
  } else if (['observacao', 'encargos'].some((termo) => status.includes(termo))) {
    mensagens.push({ texto: `Status ${statusOriginal}`, nivel: 'aviso' });
  }

  if (registro) {
    if (registro.saldoCredito <= 0) {
      mensagens.push({ texto: 'Saldo de crédito negativo/zerado', nivel: 'erro' });
    } else if (grupo.valor > registro.saldoCredito) {
      mensagens.push({ texto: 'Pedido acima do saldo de crédito', nivel: 'aviso' });
    }
    if (media && media.mediaSemana > 0 && registro.saldoCredito < media.mediaSemana) {
      mensagens.push({ texto: 'Saldo de crédito abaixo da compra média semanal', nivel: 'aviso' });
    }
  } else if (!grupo.cliente) {
    mensagens.push({ texto: 'Cliente fora da base; sem limite para consultar', nivel: 'aviso' });
  } else if (grupo.cliente.limite <= 0) {
    mensagens.push({ texto: 'Sem limite aprovado cadastrado', nivel: 'aviso' });
  } else if (grupo.cliente.disponivel <= 0) {
    mensagens.push({ texto: 'Saldo disponível negativo/zerado', nivel: 'aviso' });
  } else if (grupo.valor > grupo.cliente.disponivel) {
    mensagens.push({ texto: 'Pedido acima do saldo disponível', nivel: 'aviso' });
  }

  const saldo = registro ? registro.saldoCredito : grupo.cliente?.disponivel ?? 0;
  const nivel = mensagens.some((m) => m.nivel === 'erro')
    ? 'erro'
    : mensagens.length > 0
      ? 'aviso'
      : 'ok';

  return (
    <li className={`credito-linha ${nivel}`}>
      <div>
        <strong>{grupo.nome}</strong>
        <small>
          saldo R$ {formatarMoeda(saldo)} · pedido R$ {formatarMoeda(grupo.valor)}
        </small>
      </div>
      {mensagens.map((mensagem) => (
        <span key={mensagem.texto} className={`credito-msg ${mensagem.nivel}`}>
          {mensagem.texto}
        </span>
      ))}
    </li>
  );
}
