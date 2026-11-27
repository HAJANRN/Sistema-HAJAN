import fs from 'node:fs';
import XLSX from 'xlsx';

/**
 * Cadastro de clientes FRIBOI: cada célula "RAZÃO SOCIAL (CÓDIGO JBS)" liga o código do
 * terceiro que vem no faturamento à filial oficial. É o que separa lojas que o ERP fatura
 * com o mesmo nome (FRIGORIFICO DUBAIAO em OURICURI x SALGUEIRO, SUPERMERCADOS QUEIROZ
 * que na verdade é I L SUPERMERCADOS RUSSAS).
 */
const REGISTRY_FILES = [
  // a lista de faturamento é menor e às vezes traz a filial que falta no cadastro geral
  'S:/FRIBOI/zzz Gestão Pedidos/check list dados faturamento clientes.xlsx',
  'S:/FRIBOI/infos clientes FRIBOI.xlsx',
];
const SNAPSHOT = new URL('./data/clientes-jbs.json', import.meta.url);
const NAME_CODE_RE = /^(.*?)\s*\((\d{3,})\)\s*$/;

let cache = null;

function readRegistry(map, file) {
  if (!fs.existsSync(file)) return;
  try {
    const workbook = XLSX.readFile(file);
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      });
      for (const row of rows) {
        const match = NAME_CODE_RE.exec(String(row?.[0] ?? '').trim());
        if (!match) continue;
        const name = match[1].replace(/\s+/g, ' ').trim();
        if (name.length >= 2) map.set(match[2], name);
      }
    }
  } catch {
    // S: fora do ar: segue com a cópia empacotada no projeto
  }
}

/** Código JBS → nome oficial da filial. Lê o S: quando disponível; senão usa a cópia local. */
export function clientRegistry() {
  if (cache) return cache;
  const map = new Map();
  for (const file of REGISTRY_FILES) readRegistry(map, file);
  try {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    for (const [code, name] of Object.entries(snapshot)) {
      if (!map.has(code)) map.set(code, name);
    }
  } catch {
    // sem cópia local: fica só o que veio do S:
  }
  cache = map;
  return cache;
}

/** Nome oficial da filial para o código do terceiro; null quando o código não está no cadastro. */
export function officialClientName(code) {
  const key = String(code ?? '').replace(/\D/g, '');
  return key ? (clientRegistry().get(key) ?? null) : null;
}
