import { shiftISO, todayISO } from './utils';

export type Periodo = '30d' | 'mes' | 'ano';

export const PERIODOS: { id: Periodo; label: string }[] = [
  { id: '30d', label: 'Últimos 30 dias' },
  { id: 'mes', label: 'Este mês' },
  { id: 'ano', label: 'Este ano' },
];

export const limites = (periodo: Periodo): { de: string; ate: string } => {
  const hoje = todayISO();
  if (periodo === 'mes') return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
  if (periodo === 'ano') return { de: `${hoje.slice(0, 4)}-01-01`, ate: hoje };
  return { de: shiftISO(hoje, -30), ate: hoje };
};
