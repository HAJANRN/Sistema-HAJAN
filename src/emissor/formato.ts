/** Converte texto pt-BR em número. Devolve null quando não é número. */
export function converterNumero(texto: string): number | null {
  const limpo = String(texto ?? '').trim().replace(/\s/g, '');
  if (!limpo) return null;
  let normalizado = limpo;
  if (limpo.includes(',')) {
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(limpo)) {
    normalizado = limpo.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(normalizado)) return null;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

export function formatarNumero(valor: number, casas = 0): string {
  return valor.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
}

export function formatarMoeda(valor: number): string {
  return formatarNumero(valor, 2);
}

/** dd/mm/yyyy, dd/mm/yy, dd-mm-yyyy, dd.mm.yyyy, ddmmyyyy, ddmmyy. */
export function converterData(texto: string): Date | null {
  const limpo = String(texto ?? '').trim();
  let dia = 0;
  let mes = 0;
  let ano = 0;

  const separado = limpo.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  const colado = limpo.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/);
  if (separado) {
    dia = Number(separado[1]);
    mes = Number(separado[2]);
    ano = Number(separado[3]);
  } else if (colado) {
    dia = Number(colado[1]);
    mes = Number(colado[2]);
    ano = Number(colado[3]);
  } else {
    return null;
  }
  if (ano < 100) ano += 2000;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const data = new Date(ano, mes - 1, dia);
  if (data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) {
    return null;
  }
  return data;
}

const dois = (n: number) => String(n).padStart(2, '0');

export function formatarData(data: Date): string {
  return `${dois(data.getDate())}/${dois(data.getMonth() + 1)}/${data.getFullYear()}`;
}

export function dataIso(data: Date): string {
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;
}

export function isoParaData(iso: string): Date | null {
  const achado = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!achado) return null;
  const data = new Date(Number(achado[1]), Number(achado[2]) - 1, Number(achado[3]));
  return dataIso(data) === iso ? data : null;
}

export function normalizarBusca(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export interface Opcao {
  valor: string;
  rotulo: string;
}

/**
 * Ordem da busca do Streamlit: código exato, rótulo exato, começa com código,
 * token numérico da busca dentro do rótulo, e por fim trecho do rótulo.
 */
export function localizarOpcao(opcoes: Opcao[], texto: string): Opcao | null {
  const busca = normalizarBusca(texto);
  if (!busca) return null;
  const exatoCodigo = opcoes.find((o) => normalizarBusca(o.valor) === busca);
  if (exatoCodigo) return exatoCodigo;
  const exatoRotulo = opcoes.find((o) => normalizarBusca(o.rotulo) === busca);
  if (exatoRotulo) return exatoRotulo;
  const comecaCodigo = opcoes.find((o) => normalizarBusca(o.valor).startsWith(busca));
  if (comecaCodigo) return comecaCodigo;
  if (/^\d+$/.test(busca)) {
    const token = opcoes.find((o) => normalizarBusca(o.rotulo).split(/\D+/).includes(busca));
    if (token) return token;
  }
  return opcoes.find((o) => normalizarBusca(o.rotulo).includes(busca)) ?? null;
}
