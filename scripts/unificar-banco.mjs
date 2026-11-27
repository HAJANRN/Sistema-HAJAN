import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origemEntregas = path.join(raiz, 'data', 'expedicao.db');
const origemEmissor = path.resolve(raiz, '..', 'HAJAN-Emissor-Local - V6', 'hajan_pedidos.db');
const destino = path.join(raiz, 'data', 'hajan.db');
const sobrescrever = process.argv.includes('--force');

const TABELAS_EMISSOR = [
  'clientes',
  'limites_clientes',
  'produtos',
  'unidades_carregamento',
  'pedidos_semana',
  'pedidos_clonagem',
];

if (!fs.existsSync(origemEntregas)) {
  console.error(`Banco do Acompanhamento não encontrado: ${origemEntregas}`);
  process.exit(1);
}
if (!fs.existsSync(origemEmissor)) {
  console.error(`Banco do Emissor não encontrado: ${origemEmissor}`);
  process.exit(1);
}
if (fs.existsSync(destino)) {
  if (!sobrescrever) {
    console.error(
      `O banco unificado já existe: ${destino}\nUse --force para recriá-lo (as origens não são alteradas).`,
    );
    process.exit(1);
  }
  fs.rmSync(destino);
}

const caminhoSql = destino.replace(/\\/g, '/').replace(/'/g, "''");

const entregas = new DatabaseSync(origemEntregas, { readOnly: true });
entregas.exec(`VACUUM INTO '${caminhoSql}'`);
entregas.close();

const db = new DatabaseSync(destino);
db.exec(`ATTACH DATABASE '${origemEmissor.replace(/\\/g, '/').replace(/'/g, "''")}' AS emissor_fonte`);

const relatorio = [];
try {
  for (const tabela of TABELAS_EMISSOR) {
    const definicao = db
      .prepare("SELECT sql FROM emissor_fonte.sqlite_master WHERE type = 'table' AND name = ?")
      .get(tabela);
    if (!definicao?.sql) {
      throw new Error(`Tabela ${tabela} não existe no banco do Emissor.`);
    }
    const nome = `emissor_${tabela}`;
    const sql = definicao.sql.replace(
      /^CREATE TABLE\s+(IF NOT EXISTS\s+)?"?[\w]+"?/i,
      (trecho) => trecho.replace(new RegExp(tabela), nome),
    );
    db.exec(sql);
    db.exec(`INSERT INTO ${nome} SELECT * FROM emissor_fonte.${tabela}`);

    const origemQtd = db.prepare(`SELECT COUNT(*) c FROM emissor_fonte.${tabela}`).get().c;
    const destinoQtd = db.prepare(`SELECT COUNT(*) c FROM ${nome}`).get().c;
    if (origemQtd !== destinoQtd) {
      throw new Error(`${tabela}: ${origemQtd} na origem e ${destinoQtd} no destino.`);
    }
    relatorio.push([nome, destinoQtd]);
  }
} finally {
  db.exec('DETACH DATABASE emissor_fonte');
}

const checks = {
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  deliveries: db.prepare('SELECT COUNT(*) c FROM deliveries').get().c,
  attachments: db.prepare('SELECT COUNT(*) c FROM attachments').get().c,
  billing: db.prepare('SELECT COUNT(*) c FROM billing').get().c,
};
const integridade = db.prepare('PRAGMA integrity_check').get().integrity_check;
db.close();

for (const [tabela, qtd] of relatorio) console.log(`${tabela}: ${qtd}`);
for (const [tabela, qtd] of Object.entries(checks)) console.log(`${tabela}: ${qtd}`);
console.log(`integridade: ${integridade}`);
console.log(`banco unificado: ${destino}`);
if (integridade !== 'ok') process.exit(1);
