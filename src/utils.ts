const kgFormatter = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 0,
});

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 2,
});

export const fmtKg = (value: number | null | undefined) =>
  value == null ? '—' : `${kgFormatter.format(value)} kg`;

export const fmtMoney = (value: number | null | undefined) =>
  value == null ? '—' : moneyFormatter.format(value);

export const todayISO = () => localISO(new Date());

export function localISO(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftISO(iso: string, days: number) {
  const date = parseISO(iso);
  date.setDate(date.getDate() + days);
  return localISO(date);
}

export function parseISO(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export const fmtDate = (iso: string | null | undefined) =>
  iso
    ? parseISO(iso).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
      })
    : '—';

export const fmtFullDate = (iso: string | null | undefined) =>
  iso
    ? parseISO(iso).toLocaleDateString('pt-BR', {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
    : '—';

export const weekdayShort = (iso: string) =>
  parseISO(iso).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');

/** Semana ISO 8601 (segunda a domingo). O ano devolvido é o ano da semana, que pode divergir do ano do dia. */
export function isoWeek(iso: string) {
  const date = parseISO(iso);
  const thursday = new Date(date);
  thursday.setDate(date.getDate() - ((date.getDay() + 6) % 7) + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  return {
    week: 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000)),
    year: thursday.getFullYear(),
  };
}

export function mondayOfIsoWeek(year: number, week: number) {
  const jan4 = new Date(year, 0, 4, 12);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (week - 1) * 7);
  return localISO(monday);
}

export function fmtEta(eta: string | null | undefined, referenceDate?: string | null) {
  if (!eta) return '';
  const [date, time] = eta.split('T');
  if (date === referenceDate) return time;
  return `${date.slice(8, 10)}/${date.slice(5, 7)} ${time}`;
}

export function relativeTime(isoTimestamp: string | null | undefined) {
  if (!isoTimestamp) return 'nunca';
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  if (diff < 60_000) return 'agora';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return new Date(isoTimestamp).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  });
}
