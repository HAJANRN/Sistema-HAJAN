# Digitação de pedidos nativa (Fase 2) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar a digitação de pedidos do Emissor (Streamlit) para telas nativas em React, com cálculo, carteira, clonagem, PDF no servidor Node, histórico e importação de planilhas, removendo o iframe.

**Architecture:** A tela React carrega a base (`emissor_*`) uma vez por sessão, mantém o formulário num reducer e envia um `POST /api/emissor/pedidos`. O servidor recalcula as regras, gera o PDF com `pdfkit`, grava o histórico e o clone (banco sempre, JSON best-effort), e devolve o link de download. Leitura e escrita passam pelo mesmo gate de sessão já existente em `server/index.js`.

**Tech Stack:** React 19 + TypeScript 7 + Vite 8 (PWA), Express 5, `node:sqlite`, `xlsx`, `pdfkit`, testes com `node:test` nativo.

**Spec:** `docs/superpowers/specs/2026-11-27-digitacao-pedidos-react-design.md`

## Global Constraints

- GitHub recebe só código: nunca commitar `data/*.db`, PDFs gerados, backups, `senha-admin.txt`, `chave-visita.txt` nem o harness temporário.
- README descreve o produto; changelog vive em `ATUALIZACOES.md`.
- Nunca pedir senha no chat; testes não tocam `data/senha-admin.txt` nem o banco real (cópia temporária).
- Toda data de rede é `dd/mm/yyyy` na tela e `yyyy-mm-dd` na API; números pt-BR na tela.
- Regras de negócio do `HAJAN-Emissor-Local - V6/app.py` são a fonte da verdade.
- Não rodar `npm install` (dependências já instaladas); não adicionar dependências novas.
- Neste PC não há `node` no PATH. Os comandos abaixo usam o Electron como Node:
  `ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" (...)`
  Em máquina com Node instalado, os mesmos comandos funcionam sem o prefixo.
- Trabalhar na raiz `Acompanhamento de entregas/` (é o repositório git).

## Mapa de arquivos

| Arquivo | Papel |
|---|---|
| `server/config.js` | Novas variáveis `CARTEIRA_DIR`, `CLONES_DIR`, `CREDITO_JSON`. |
| `server/emissorBanco.js` | Conexões compartilhadas (leitura e escrita) e fechamento para testes. |
| `server/emissorRegras.js` | Regras puras do servidor: categoria, peso, valor, veículo, NFs, linhas do histórico, nome seguro do PDF. |
| `server/emissorCarteira.js` | Lê `CARTEIRA DE TERCEIRO*.xlsx` + JSON de média, cache de 60 s. |
| `server/emissorPdf.js` | Gera o PDF do pedido com `pdfkit`. |
| `server/emissorPedidos.js` | Rotas `/base`, `/carteira`, `/clones/:numero`, `POST /pedidos`, `/pedidos/pdf/:arquivo`. |
| `server/emissorImportar.js` | `POST /importar` (multipart), validação, backup e transação. |
| `server/index.js` | Monta `emissorPedidosRouter` e `emissorImportarRouter`. |
| `src/emissor/tipos.ts` | Tipos do formulário, base e payloads de API. |
| `src/emissor/formato.ts` | Parsing/formatação pt-BR e busca de opções. |
| `src/emissor/calculo.ts` | Cálculos puros do cliente (espelham `emissorRegras.js`). |
| `src/emissor/estado.ts` | Reducer do formulário e aplicação de clone. |
| `src/screens/EmissorPedidoScreen.tsx` | Tela "Novo pedido". |
| `src/screens/emissor/DadosGerais.tsx` | Cabeçalho do pedido. |
| `src/screens/emissor/EntregaCard.tsx` | Um cartão de entrega com produtos. |
| `src/screens/emissor/ResumoCarga.tsx` | Impressão em tela e painel de crédito. |
| `src/screens/emissor/Clonagem.tsx` | Bloco de clonagem. |
| `src/screens/emissor/GerarPedido.tsx` | Botão "Gerar" com gate de senha e resultado. |
| `src/screens/ImportarPlanilhasScreen.tsx` | Importação das 4 planilhas. |
| `src/api.ts` | Novas chamadas `emissorBase`, `emissorCarteira`, `emissorClone`, `emitirPedido`, `importarPlanilhas`. |
| `src/App.tsx` | Rota `novo-pedido` → `EmissorPedidoScreen`; remove iframe; nova rota `importar-planilhas`. |
| `src/styles.css` | Classes da tela de digitação; remove `.emissor-frame`/`.content-emissor`. |
| `tests/*.test.ts` | Testes `node:test` (rodam com o Electron como Node). |

### Task 1: Configuração, conexões e harness de teste

**Files:**
- Modify: `server/config.js` (após `PDF_DIRS`, ~linha 32)
- Create: `server/emissorBanco.js`
- Create: `tests/helpers.ts`
- Create: `tests/api.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `CARTEIRA_DIR`, `CLONES_DIR`, `CREDITO_JSON` (constantes string em `config.js`).
- Produces: `server/emissorBanco.js` → `ler()` (DatabaseSync read-only), `gravar()` (DatabaseSync read-write), `fechar()`.
- Produces: `tests/helpers.ts` → `RAIZ: string`, `montarApi(): Promise<Api>` com `Api = { dir, db, pdfs, clones, carteira, url, get, post, postArquivos, fechar }`.

- [ ] **Step 1: Acrescentar as variáveis de config**

Em `server/config.js`, depois do bloco `PDF_DIRS`:

```js
/** Pasta onde o ERP exporta "CARTEIRA DE TERCEIRO*.xlsx". */
export const CARTEIRA_DIR = process.env.FRIBOI_CARTEIRA_DIR ?? 'S:\\FRIBOI\\financeiro\\carteira clientes';

/** Clone em JSON ao lado dos PDFs, para quando o banco não tiver o pedido. */
export const CLONES_DIR = process.env.FRIBOI_CLONES_DIR ?? path.join(NET_ROOT, 'Pedidos Ped+', '_clone_data');

/** Média de compras por cliente (JSON exportado pela análise de crédito); ausente = regra de média omitida. */
export const CREDITO_JSON =
  process.env.FRIBOI_CREDITO_JSON ?? path.join(ROOT, 'credito', 'decisao_credito.json');
```

- [ ] **Step 2: Criar as conexões compartilhadas**

`server/emissorBanco.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './config.js';

let leitura = null;
let escrita = null;

/** Conexão de leitura, usada pelas rotas de consulta. */
export function ler() {
  if (!leitura) leitura = new DatabaseSync(DB_FILE, { readOnly: true });
  return leitura;
}

/** Conexão de escrita, usada pela geração de pedido e pela importação. */
export function gravar() {
  if (!escrita) {
    escrita = new DatabaseSync(DB_FILE);
    escrita.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  return escrita;
}

/** Fecha tudo (testes e reinício limpo). */
export function fechar() {
  leitura?.close();
  escrita?.close();
  leitura = null;
  escrita = null;
}

/** Mensagens amigáveis quando o banco unificado ainda não existe nesta máquina. */
export function responderSemBanco(res, erro) {
  const mensagem = String(erro?.message ?? erro);
  if (mensagem.includes('no such table') || mensagem.includes('unable to open') || mensagem.includes('no such file')) {
    return res.status(503).json({ error: 'banco de dados do emissor indisponível no servidor' });
  }
  throw erro;
}
```

- [ ] **Step 3: Criar o harness de teste**

`tests/helpers.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

export const RAIZ = fileURLToPath(new URL('..', import.meta.url));

export interface Api {
  dir: string;
  db: string;
  pdfs: string;
  clones: string;
  carteira: string;
  url: string;
  get: (rota: string) => Promise<Response>;
  post: (rota: string, corpo: unknown) => Promise<Response>;
  postArquivos: (rota: string, campos: Record<string, File>) => Promise<Response>;
  fechar: () => Promise<void>;
}

/**
 * Sobe os routers do emissor numa cópia temporária do banco.
 * A config é lida no import; por isso os env vars são definidos antes do import dinâmico.
 */
export async function montarApi(): Promise<Api> {
  const origem = path.join(RAIZ, 'data', 'hajan.db');
  assert.ok(fs.existsSync(origem), 'data/hajan.db precisa existir para rodar os testes');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajan-teste-'));
  const db = path.join(dir, 'hajan.db');
  fs.copyFileSync(origem, db);
  const pdfs = path.join(dir, 'pdfs');
  const clones = path.join(dir, 'clones');
  const carteira = path.join(dir, 'carteira');
  for (const pasta of [pdfs, clones, carteira]) fs.mkdirSync(pasta, { recursive: true });

  process.env.FRIBOI_DB = db;
  process.env.FRIBOI_PDF_DIRS = pdfs;
  process.env.FRIBOI_CLONES_DIR = clones;
  process.env.FRIBOI_CARTEIRA_DIR = carteira;
  process.env.FRIBOI_CREDITO_JSON = path.join(carteira, 'media_compras.json');

  const { router: emissor } = await import('../server/emissor.js');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/emissor', emissor);

  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  const porta = (servidor.address() as { port: number }).port;
  const url = `http://127.0.0.1:${porta}`;

  return {
    dir,
    db,
    pdfs,
    clones,
    carteira,
    url,
    get: (rota) => fetch(`${url}${rota}`),
    post: (rota, corpo) =>
      fetch(`${url}${rota}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      }),
    postArquivos: (rota, campos) => {
      const form = new FormData();
      for (const [nome, arquivo] of Object.entries(campos)) form.append(nome, arquivo);
      return fetch(`${url}${rota}`, { method: 'POST', body: form });
    },
    fechar: async () => {
      await new Promise((ok) => servidor.close(ok));
      const banco = await import('../server/emissorBanco.js' as string);
      banco.fechar();
    },
  };
}
```

- [ ] **Step 4: Primeiro teste (o harness funciona)**

`tests/api.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('o harness responde /api/emissor/saude com o banco copiado', async () => {
  const resposta = await api.get('/api/emissor/saude');
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.ok, true);
  assert.ok(corpo.clientes > 0);
});
```

- [ ] **Step 5: Rodar o teste**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/api.test.ts
```

Esperado: `# pass 1`.

- [ ] **Step 6: Adicionar os scripts**

Em `package.json`:

```json
"test": "node --test tests/*.test.ts",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 7: Commit**

```bash
git add server/config.js server/emissorBanco.js tests/helpers.ts tests/api.test.ts package.json
git commit -m "test: harness do emissor com banco temporario"
```

### Task 2: Parsing e formatação pt-BR

**Files:**
- Create: `src/emissor/formato.ts`
- Test: `tests/formato.test.ts`

**Interfaces:**
- Produces: `converterNumero(texto: string): number | null`, `formatarNumero(valor: number, casas?: number): string`, `formatarMoeda(valor: number): string`, `converterData(texto: string): Date | null`, `formatarData(data: Date): string`, `dataIso(data: Date): string`, `isoParaData(iso: string): Date | null`, `normalizarBusca(texto: string): string`, `type Opcao = { valor: string; rotulo: string }`, `localizarOpcao(opcoes: Opcao[], texto: string): Opcao | null`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/formato.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  converterData,
  converterNumero,
  dataIso,
  formatarData,
  formatarMoeda,
  formatarNumero,
  isoParaData,
  localizarOpcao,
  normalizarBusca,
} from '../src/emissor/formato.ts';

test('números pt-BR', () => {
  assert.equal(converterNumero('1.234,56'), 1234.56);
  assert.equal(converterNumero('1.234'), 1234);
  assert.equal(converterNumero('19,50'), 19.5);
  assert.equal(converterNumero('645'), 645);
  assert.equal(converterNumero(' 12.5 '), 12.5);
  assert.equal(converterNumero('abc'), null);
  assert.equal(converterNumero(''), null);
});

test('formatação de números e moeda', () => {
  assert.equal(formatarNumero(1234.56, 2), '1.234,56');
  assert.equal(formatarNumero(17000), '17.000');
  assert.equal(formatarMoeda(19.5), '19,50');
});

test('datas aceitam os formatos do escritório', () => {
  assert.equal(formatarData(converterData('27/11/2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27/11/26')!), '27/11/2026');
  assert.equal(formatarData(converterData('27-11-2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27.11.2026')!), '27/11/2026');
  assert.equal(formatarData(converterData('27112026')!), '27/11/2026');
  assert.equal(formatarData(converterData('271126')!), '27/11/2026');
  assert.equal(converterData('31/02/2026'), null);
  assert.equal(converterData('27/13/2026'), null);
});

test('datas ISO', () => {
  assert.equal(dataIso(new Date(2026, 10, 27)), '2026-11-27');
  assert.equal(formatarData(isoParaData('2026-11-27')!), '27/11/2026');
  assert.equal(isoParaData('2026-11-27T12:00:00'), null);
});

test('busca de opções: código, nome, token numérico e trecho', () => {
  const opcoes = [
    { valor: '4229791', rotulo: 'Operação 3: JL MEDEIROS LEVAMAIS MACAU (4229791)' },
    { valor: '100', rotulo: 'Cliente Água Boa' },
    { valor: '200', rotulo: 'Cliente São José' },
  ];
  assert.equal(normalizarBusca('ÁGUA'), 'agua');
  assert.equal(localizarOpcao(opcoes, '100')?.valor, '100');
  assert.equal(localizarOpcao(opcoes, 'cliente agua')?.valor, '100');
  assert.equal(localizarOpcao(opcoes, 'sao jose')?.valor, '200');
  assert.equal(localizarOpcao(opcoes, '4229791')?.valor, '4229791');
  assert.equal(localizarOpcao(opcoes, 'macau')?.valor, '4229791');
  assert.equal(localizarOpcao(opcoes, 'inexistente'), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/formato.test.ts
```

Esperado: erro de módulo inexistente (`src/emissor/formato.ts`).

- [ ] **Step 3: Implementar**

`src/emissor/formato.ts`:

```ts
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
```

- [ ] **Step 4: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/formato.test.ts
```

Esperado: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add src/emissor/formato.ts tests/formato.test.ts
git commit -m "feat: parsing pt-BR de numeros e datas da digitacao"
```

### Task 3: Tipos e cálculos do formulário

**Files:**
- Create: `src/emissor/tipos.ts`
- Create: `src/emissor/calculo.ts`
- Test: `tests/calculo.test.ts`

**Interfaces:**
- Produces: `ClienteBase`, `ProdutoBase`, `UnidadeBase`, `BaseEmissor` (com `proximoNumero` adicional ao contrato), `ProdutoForm`, `EntregaForm`, `PedidoForm`, `ClonePayload`, `ResumoPedido` em `src/emissor/tipos.ts`.
- Produces: `ehEsc`, `categoriaDoProduto`, `categoriasDoPedido`, `rotuloCategorias`, `pesoEntrega`, `valorEntrega`, `pesoTotal`, `valorTotal`, `veiculoDoPeso`, `nfsRemessa`, `resumoPedido`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/calculo.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoriasDoPedido,
  ehEsc,
  nfsRemessa,
  pesoEntrega,
  pesoTotal,
  resumoPedido,
  valorEntrega,
  valorTotal,
  veiculoDoPeso,
} from '../src/emissor/calculo.ts';
import type { EntregaForm, PedidoForm } from '../src/emissor/tipos.ts';

const produto = (over: Partial<EntregaForm['produtos'][number]> = {}) => ({
  id: 'p1',
  codigo: '1000',
  descricao: 'PATINHO',
  qtd: 10,
  unidade: 'CX',
  peso: 15.5,
  preco: 19.5,
  prazo: '30',
  categoria: 'CXS',
  ...over,
});

const entrega = (over: Partial<EntregaForm> = {}): EntregaForm => ({
  id: 'e1',
  cliente: 'Cliente A',
  operacao: 3,
  destino: 'SEM DESTINO',
  pesoManual: null,
  produtos: [produto()],
  ...over,
});

const pedido = (entregas: EntregaForm[]): PedidoForm => ({
  numero: '3834',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: '',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  entregas,
});

test('ESC quando cliente ou destino começa com ESC', () => {
  assert.equal(ehEsc('ESC - NATAL'), true);
  assert.equal(ehEsc('esc 1'), true);
  assert.equal(ehEsc('ESCADA'), false);
  assert.equal(ehEsc('Cliente ESC'), false);
});

test('peso e valor por produto', () => {
  const e = entrega();
  assert.equal(pesoEntrega(e), 155);
  assert.equal(valorEntrega(e), 3022.5);
});

test('ESC usa peso manual e não soma produtos', () => {
  const e = entrega({ cliente: 'ESC - NATAL', pesoManual: 900, produtos: [] });
  assert.equal(pesoEntrega(e), 900);
  assert.equal(valorEntrega(e), 0);
});

test('totais e veículo', () => {
  const p = pedido([entrega(), entrega({ id: 'e2', produtos: [produto({ id: 'p2', qtd: 100 })] })]);
  assert.equal(pesoTotal(p), 1705);
  assert.equal(veiculoDoPeso(17000), 'Bi-truck');
  assert.equal(veiculoDoPeso(17001), 'Carreta');
});

test('categorias na ordem fixa e fallback PÇS', () => {
  const p = pedido([
    entrega({
      produtos: [
        produto({ id: 'a', categoria: 'SPG' }),
        produto({ id: 'b', categoria: 'CXS' }),
        produto({ id: 'c', categoria: '' }),
      ],
    }),
  ]);
  assert.deepEqual(categoriasDoPedido(p), ['CXS', 'SPG']);

  const semCategoria = pedido([entrega({ produtos: [produto({ categoria: 'outro' })] })]);
  assert.deepEqual(categoriasDoPedido(semCategoria), ['PÇS']);
});

test('NFs de remessa são as entregas fora da operação 9', () => {
  assert.equal(nfsRemessa(pedido([entrega(), entrega({ id: 'e2', operacao: 9 })])), 1);
});

test('resumo do pedido', () => {
  const r = resumoPedido(pedido([entrega()]));
  assert.equal(r.categorias, 'CXS');
  assert.equal(r.pesoTotal, 155);
  assert.equal(r.valor, 3022.5);
  assert.equal(r.veiculo, 'Bi-truck');
  assert.equal(r.entregas, 1);
  assert.equal(r.nfsRemessa, 1);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/calculo.test.ts
```

Esperado: erro de módulo inexistente.

- [ ] **Step 3: Criar os tipos**

`src/emissor/tipos.ts`:

```ts
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
```

- [ ] **Step 4: Implementar os cálculos**

`src/emissor/calculo.ts`:

```ts
import type { EntregaForm, PedidoForm, ResumoPedido } from './tipos';

export const CATEGORIAS = ['CXS', 'PÇS', 'CHQ', 'SPG'] as const;

/** Cliente ou destino de entrega ESC: não tem produtos, o peso é digitado. */
export function ehEsc(texto: string): boolean {
  return /^ESC(\s|$)/i.test(String(texto ?? '').trim());
}

/** Categoria do produto (comparação exata, como rotulo_categorias do Emissor); desconhecida fica de fora. */
export function categoriaDoProduto(categoria: string): string {
  const texto = String(categoria ?? '').trim().toUpperCase();
  return (CATEGORIAS as readonly string[]).includes(texto) ? texto : '';
}

export function categoriasDoPedido(pedido: PedidoForm): string[] {
  const presentes = new Set<string>();
  for (const entrega of pedido.entregas) {
    if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) continue;
    for (const produto of entrega.produtos) {
      const categoria = categoriaDoProduto(produto.categoria);
      if (categoria) presentes.add(categoria);
    }
  }
  if (presentes.size === 0) presentes.add('PÇS');
  return CATEGORIAS.filter((c) => presentes.has(c));
}

export function rotuloCategorias(pedido: PedidoForm): string {
  return categoriasDoPedido(pedido).join('-');
}

export function pesoEntrega(entrega: EntregaForm): number {
  if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) return Number(entrega.pesoManual ?? 0);
  return entrega.produtos.reduce((soma, p) => soma + p.qtd * p.peso, 0);
}

export function valorEntrega(entrega: EntregaForm): number {
  return entrega.produtos.reduce((soma, p) => soma + p.qtd * p.peso * p.preco, 0);
}

export function pesoTotal(pedido: PedidoForm): number {
  return pedido.entregas.reduce((soma, e) => soma + pesoEntrega(e), 0);
}

export function valorTotal(pedido: PedidoForm): number {
  return pedido.entregas.reduce((soma, e) => soma + valorEntrega(e), 0);
}

export function veiculoDoPeso(peso: number): 'Bi-truck' | 'Carreta' {
  return peso <= 17000 ? 'Bi-truck' : 'Carreta';
}

export function nfsRemessa(pedido: PedidoForm): number {
  return pedido.entregas.filter((e) => e.operacao !== 9).length;
}

export function resumoPedido(pedido: PedidoForm): ResumoPedido {
  const peso = pesoTotal(pedido);
  return {
    categorias: rotuloCategorias(pedido),
    pesoTotal: peso,
    valor: valorTotal(pedido),
    veiculo: veiculoDoPeso(peso),
    entregas: pedido.entregas.length,
    nfsRemessa: nfsRemessa(pedido),
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/calculo.test.ts
```

Esperado: `# pass 7`.

- [ ] **Step 6: Typecheck**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/emissor/tipos.ts src/emissor/calculo.ts tests/calculo.test.ts
git commit -m "feat: tipos e calculos do pedido no cliente"
```

### Task 4: API de leitura — base e carteira

**Files:**
- Create: `server/emissorCarteira.js`
- Create: `server/emissorPedidos.js` (rotas `/base` e `/carteira`)
- Modify: `tests/helpers.ts` (montar o novo router)
- Test: `tests/base.test.ts`
- Test: `tests/carteira.test.ts`

**Interfaces:**
- Consumes: `ler()`, `responderSemBanco()` de `server/emissorBanco.js`.
- Produces: `GET /api/emissor/base` → `{ revision, clientes, produtos, unidades, proximoNumero, destinos }`.
- Produces: `GET /api/emissor/carteira` → `{ disponivel: true, data, registros, media }` ou `{ disponivel: false }`.
- Produces: `server/emissorCarteira.js` → `export function carteira(): { disponivel: false } | { disponivel: true, data: string, registros: object, media: object }`.

- [ ] **Step 1: Montar o router novo no harness**

Em `tests/helpers.ts`, dentro de `montarApi`, o bloco de imports/montagem passa a ser exatamente:

```ts
  const { router: emissor } = await import('../server/emissor.js');
  const { router: emissorPedidos } = await import('../server/emissorPedidos.js');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/emissor', emissor);
  app.use('/api/emissor', emissorPedidos);
```

- [ ] **Step 2: Escrever o teste que falha (base)**

`tests/base.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('base traz clientes com limite e produtos com rótulo', async () => {
  const resposta = await api.get('/api/emissor/base');
  assert.equal(resposta.status, 200);
  const base = await resposta.json();

  assert.ok(base.clientes.length > 0);
  const cliente = base.clientes[0];
  for (const campo of ['codigo', 'nome', 'cnpj', 'cidade', 'uf', 'prazo', 'limite', 'disponivel']) {
    assert.ok(campo in cliente, `cliente sem ${campo}`);
  }

  assert.ok(base.produtos.length > 0);
  const produto = base.produtos[0];
  assert.equal(produto.rotulo, `${produto.codigo} - ${produto.descricao}`);
  assert.ok(produto.peso > 0);
  assert.equal(produto.unidade.length > 0, true);

  assert.ok(base.unidades.length > 0);
  assert.equal(base.unidades[0].rotulo, `${base.unidades[0].sigla} - ${base.unidades[0].nome}`);
  assert.match(base.revision, /^\d+(\.\d+)?$/);
  assert.match(base.proximoNumero, /^\d+$/);
  assert.equal(base.destinos[0], 'SEM DESTINO');
  assert.ok(base.destinos.includes(base.clientes[0].nome));
});
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/base.test.ts
```

Esperado: 404 (rota ainda não existe).

- [ ] **Step 4: Implementar o router com `/base`**

`server/emissorPedidos.js`:

```js
import fs from 'node:fs';
import express from 'express';
import { DB_FILE } from './config.js';
import { ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';

export const router = express.Router();

router.get('/base', (req, res) => {
  try {
    const db = ler();
    const clientes = db
      .prepare(
        `SELECT c.codigo, c.nome_formatado AS nome, COALESCE(c.cnpj,'') AS cnpj,
                COALESCE(c.prazo_padrao,'') AS prazo, COALESCE(c.cidade,'') AS cidade,
                COALESCE(c.uf,'') AS uf, COALESCE(c.status_cliente,'') AS statusCliente,
                COALESCE(c.codigo_centralizador,'') AS codigoCentralizador,
                COALESCE(l.centralizador,'') AS centralizador,
                COALESCE(l.limite,0) AS limite, COALESCE(l.disponivel,0) AS disponivel
           FROM emissor_clientes c
           LEFT JOIN emissor_limites_clientes l
             ON COALESCE(NULLIF(TRIM(c.codigo_centralizador),''), c.codigo) = l.codigo_centralizador
          ORDER BY c.nome_formatado COLLATE NOCASE`,
      )
      .all();

    const produtos = db
      .prepare(
        `SELECT codigo, descricao, COALESCE(unidade,'kg') AS unidade,
                COALESCE(peso,1) AS peso, COALESCE(categoria,'') AS categoria
           FROM emissor_produtos ORDER BY descricao COLLATE NOCASE`,
      )
      .all()
      .map((p) => ({ ...p, rotulo: `${p.codigo} - ${p.descricao}` }));

    const unidades = db
      .prepare('SELECT sigla, nome, COALESCE(critica,\'\') AS critica FROM emissor_unidades_carregamento ORDER BY sigla COLLATE NOCASE')
      .all()
      .map((u) => ({ ...u, rotulo: `${u.sigla} - ${u.nome}` }));

    const maior = db
      .prepare('SELECT MAX(CAST(numero AS INTEGER)) AS m FROM emissor_pedidos_semana')
      .get().m;

    // destinos da operação 3: todos os clientes, SEM DESTINO primeiro (listar_destinos_operacao_3)
    const destinos = ['SEM DESTINO', ...clientes.map((cliente) => cliente.nome)];

    const revision = String(fs.statSync(DB_FILE).mtimeMs);
    res.json({
      revision,
      clientes,
      produtos,
      unidades,
      proximoNumero: String((maior ?? 0) + 1),
      destinos,
    });
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});

router.get('/carteira', (req, res) => {
  try {
    res.json(carteira());
  } catch (erro) {
    res.status(500).json({ error: `não consegui ler a carteira: ${erro.message}` });
  }
});
```

- [ ] **Step 5: Implementar o leitor da carteira**

`server/emissorCarteira.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { CARTEIRA_DIR, CREDITO_JSON } from './config.js';

const TTL_MS = 60_000;
let cache = { chave: '', quando: 0, valor: null };

const normalizar = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const COLUNAS = {
  codigo: ['CODIGO', 'CODIGO CLIENTE', 'CODIGO CENTRALIZADOR', 'CENTRALIZADOR'],
  nome: ['NOME', 'CLIENTE', 'NOME CLIENTE', 'RAZAO SOCIAL', 'RAZAO SOCIAL PEDIDO'],
  limite: ['LIMITE', 'LIMITE DE CREDITO'],
  saldoFinanceiro: ['SALDO FINANCEIRO'],
  saldoCarteira: ['SALDO EM CARTEIRA', 'SALDO CARTEIRA'],
  saldoCredito: ['SALDO DE CREDITO', 'SALDO CREDITO', 'DISPONIVEL'],
  status: ['STATUS', 'STATUS DO CLIENTE'],
};

function arquivos() {
  try {
    return fs
      .readdirSync(CARTEIRA_DIR)
      .filter((nome) => /^CARTEIRA DE TERCEIRO.*\.xlsx$/i.test(nome))
      .map((nome) => {
        const caminho = path.join(CARTEIRA_DIR, nome);
        const info = fs.statSync(caminho);
        return { nome, caminho, mtime: info.mtimeMs, tamanho: info.size };
      });
  } catch {
    return [];
  }
}

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

/** Data mais recente escrita no nome do arquivo; 0 quando não há data válida. */
function dataDoNome(nome) {
  let melhor = 0;
  const marcar = (dia, mes, ano) => {
    const data = new Date(ano, mes - 1, dia);
    if (data.getDate() === dia && data.getMonth() === mes - 1 && data.getFullYear() === ano) {
      melhor = Math.max(melhor, data.getTime());
    }
  };
  for (const achado of nome.matchAll(/(\d{1,2})\s*([a-zç]{3,9})\s*(\d{4})/gi)) {
    const mes = MESES[achado[2].slice(0, 3).toLowerCase().replace('ç', 'c')];
    if (mes) marcar(Number(achado[1]), mes, Number(achado[3]));
  }
  for (const achado of nome.matchAll(/(\d{2})[./-](\d{2})[./-](\d{2,4})/g)) {
    let ano = Number(achado[3]);
    if (ano < 100) ano += 2000;
    marcar(Number(achado[1]), Number(achado[2]), ano);
  }
  return melhor;
}

const dd = (n) => String(n).padStart(2, '0');
const dataBr = (ms) => {
  const d = new Date(ms);
  return `${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** Código como na planilha: 100.0 e "100" viram "100". */
function codigoPlanilha(valor) {
  const numero = Number(valor);
  if (String(valor ?? '').trim() !== '' && Number.isFinite(numero)) return String(Math.trunc(numero));
  return String(valor ?? '').trim();
}

/** Acha a linha do cabeçalho e devolve o índice de cada coluna usada. */
function mapearCabecalho(linha) {
  const celulas = linha.map(normalizar);
  const achar = (aliases) => {
    for (const alias of aliases) {
      const indice = celulas.indexOf(alias);
      if (indice >= 0) return indice;
    }
    return -1;
  };
  const mapa = {};
  for (const [campo, aliases] of Object.entries(COLUNAS)) mapa[campo] = achar(aliases);
  return mapa;
}

function lerArquivo(arquivo, colecao) {
  const livro = XLSX.read(fs.readFileSync(arquivo.caminho), { type: 'buffer' });
  const aba = livro.SheetNames[0];
  if (!aba) return;
  const linhas = XLSX.utils.sheet_to_json(livro.Sheets[aba], { header: 1, raw: true, defval: '' });
  const cabecalho = linhas.findIndex((linha) => {
    const mapa = mapearCabecalho(linha);
    return mapa.codigo >= 0 && mapa.nome >= 0 && (mapa.saldoCredito >= 0 || mapa.limite >= 0);
  });
  if (cabecalho < 0) return;
  const mapa = mapearCabecalho(linhas[cabecalho]);
  for (const linha of linhas.slice(cabecalho + 1)) {
    const codigo = codigoPlanilha(linha[mapa.codigo]);
    if (!codigo || codigo === '0') continue;
    const numero = (campo) => {
      const indice = mapa[campo];
      if (indice < 0) return 0;
      const valor = Number(linha[indice]);
      return Number.isFinite(valor) ? valor : 0;
    };
    const texto = (campo) => (mapa[campo] >= 0 ? String(linha[mapa[campo]] ?? '').trim() : '');
    const itens = colecao.get(codigo) ?? [];
    itens.push({
      nome: texto('nome'),
      limite: numero('limite'),
      saldoFinanceiro: numero('saldoFinanceiro'),
      saldoCarteira: numero('saldoCarteira'),
      saldoCredito: numero('saldoCredito'),
      status: texto('status'),
    });
    colecao.set(codigo, itens);
  }
}

/** As divisões repetem o consolidado e trazem recortes parciais: prevalece o maior valor, e nome/status vêm da linha de maior limite. */
function consolidar(colecao) {
  const registros = {};
  for (const [codigo, itens] of colecao) {
    const base = itens.reduce((melhor, item) => (item.limite > melhor.limite ? item : melhor), itens[0]);
    registros[codigo] = {
      nome: base.nome,
      limite: Math.max(...itens.map((item) => item.limite)),
      saldoFinanceiro: Math.max(...itens.map((item) => item.saldoFinanceiro)),
      saldoCarteira: Math.max(...itens.map((item) => item.saldoCarteira)),
      saldoCredito: Math.max(...itens.map((item) => item.saldoCredito)),
      status: base.status || itens.find((item) => item.status)?.status || '',
    };
  }
  return registros;
}

function lerMedia() {
  const media = {};
  try {
    const bruto = JSON.parse(fs.readFileSync(CREDITO_JSON, 'utf8'));
    for (const cliente of Array.isArray(bruto.clientes) ? bruto.clientes : []) {
      const mensal = Number(cliente.media_mensal_compras_6m ?? 0);
      const informacao = {
        mediaMensal6m: Number.isFinite(mensal) ? mensal : 0,
        mediaSemana: (Number.isFinite(mensal) ? mensal : 0) * 12 / 52,
        statusCompra: String(cliente.status_compra ?? ''),
      };
      for (const codigo of Array.isArray(cliente.codigos) ? cliente.codigos : []) {
        media[codigoPlanilha(codigo)] = informacao;
      }
    }
  } catch {
    // sem JSON de média: o painel usa só a carteira
  }
  return media;
}

export function carteira() {
  const lista = arquivos();
  const chave = [
    ...lista.map((a) => `${a.nome}:${a.mtime}:${a.tamanho}`),
    fs.existsSync(CREDITO_JSON) ? String(fs.statSync(CREDITO_JSON).mtimeMs) : 'sem-media',
  ].join('|');

  if (cache.valor && cache.chave === chave && Date.now() - cache.quando < TTL_MS) {
    return cache.valor;
  }

  if (lista.length === 0) {
    const vazio = { disponivel: false };
    cache = { chave, quando: Date.now(), valor: vazio };
    return vazio;
  }

  const comData = lista.filter((arquivo) => dataDoNome(arquivo.nome) > 0);
  let grupo;
  let quando;
  if (comData.length > 0) {
    quando = Math.max(...comData.map((arquivo) => dataDoNome(arquivo.nome)));
    grupo = comData.filter((arquivo) => dataDoNome(arquivo.nome) === quando);
  } else {
    const escolhido = lista.reduce((melhor, atual) => (atual.mtime > melhor.mtime ? atual : melhor));
    grupo = [escolhido];
    quando = escolhido.mtime;
  }

  const colecao = new Map();
  for (const arquivo of [...grupo].sort((a, b) => a.nome.localeCompare(b.nome))) {
    lerArquivo(arquivo, colecao);
  }

  const valor = {
    disponivel: true,
    data: dataBr(quando),
    registros: consolidar(colecao),
    media: lerMedia(),
  };
  cache = { chave, quando: Date.now(), valor };
  return valor;
}
```

- [ ] **Step 6: Rodar o teste da base**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/base.test.ts
```

Esperado: `# pass 1`.

- [ ] **Step 7: Escrever o teste da carteira**

`tests/carteira.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import XLSX from 'xlsx';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

test('sem arquivos, a carteira fica indisponível', async () => {
  const resposta = await api.get('/api/emissor/carteira');
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { disponivel: false });
});

test('lê o arquivo mais recente e consolida o maior valor por cliente', async () => {
  const linhas = [
    ['Codigo', 'Nome', 'Limite', 'Saldo Financeiro', 'Saldo Carteira', 'Saldo de Credito', 'Status'],
    ['100', 'Cliente A', 50000, 1000, 2000, 47000, 'Liberado'],
    ['100', 'Cliente A', 60000, 9000, 2000, 50000, 'Liberado'],
    ['200', 'Cliente B', 10000, 0, 0, -50, 'Protesto'],
  ];
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), 'Carteira');
  XLSX.writeFile(livro, path.join(api.carteira, 'CARTEIRA DE TERCEIRO 26.11.2026.xlsx'));

  fs.writeFileSync(
    path.join(api.carteira, 'media_compras.json'),
    JSON.stringify({
      clientes: [{ media_mensal_compras_6m: 52000, status_compra: 'OK', codigos: [100] }],
    }),
  );

  const resposta = await api.get('/api/emissor/carteira');
  const corpo = await resposta.json();
  assert.equal(corpo.disponivel, true);
  assert.equal(corpo.data, '26/11/2026');
  assert.equal(corpo.registros['100'].limite, 60000);
  assert.equal(corpo.registros['100'].saldoCredito, 50000);
  assert.equal(corpo.registros['200'].status, 'Protesto');
  assert.equal(corpo.media['100'].mediaMensal6m, 52000);
  assert.equal(corpo.media['100'].mediaSemana, 12000);
  assert.equal(corpo.media['100'].statusCompra, 'OK');
});

test('lê o grupo de arquivos com a data mais recente no nome, inclusive mês por extenso', async () => {
  const escrever = (arquivo: string, limite: number) => {
    const linhas = [
      ['Codigo', 'Nome', 'Limite', 'Saldo Financeiro', 'Saldo em Carteira', 'Saldo de Credito', 'Status do Cliente'],
      ['300', 'Cliente Antigo', limite, 0, 0, limite, 'Liberado'],
    ];
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), 'Carteira');
    XLSX.writeFile(livro, path.join(api.carteira, arquivo));
  };
  escrever('CARTEIRA DE TERCEIRO - DIVISÃO 1 27nov2026.xlsx', 100000);
  escrever('CARTEIRA DE TERCEIRO - DIVISÃO 47 15dez2026.xlsx', 1000);

  const corpo = await (await api.get('/api/emissor/carteira')).json();
  assert.equal(corpo.data, '15/12/2026');
  assert.equal(corpo.registros['300'].limite, 1000);
});
```

- [ ] **Step 8: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/carteira.test.ts
```

Esperado: `# pass 3`. (52000 × 12 / 52 = 12000, inteiro.)

- [ ] **Step 9: Commit**

```bash
git add server/emissorPedidos.js server/emissorCarteira.js tests/helpers.ts tests/base.test.ts tests/carteira.test.ts
git commit -m "feat: API de base e carteira da digitacao de pedidos"
```

### Task 5: API de clonagem (leitura)

**Files:**
- Modify: `server/emissorPedidos.js` (imports e rota `/clones/:numero`)
- Test: `tests/clones.test.ts`

**Interfaces:**
- Consumes: `CLONES_DIR` de `config.js`.
- Produces: `GET /api/emissor/clones/:numero?tipo=CXS|PÇS` → `{ encontrado: true, fonte: 'banco'|'rede', payload }` ou `{ encontrado: false, outroTipo? }`.
- Produces: `nomeSeguro(texto)` interno (regex de nome de arquivo).

- [ ] **Step 1: Escrever o teste que falha**

`tests/clones.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const payload = (numero: string, cliente: string) => ({
  numero,
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: '',
  data_pedido: '27/11/2026',
  data_embarque: '27/11/2026',
  data_entrega: '01/12/2026',
  entregas: [
    {
      cliente,
      destino: 'SEM DESTINO',
      operacao: 3,
      produtos: [
        { codigo: '1000', descricao: 'PATINHO', qtd: 10, unidade: 'CX', peso: 15.5, preco: 19.5, prazo: '30' },
      ],
    },
  ],
});

test('clone do banco tem prioridade', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare('INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)')
    .run('9001', '2026-11-27T10:00:00', JSON.stringify(payload('9001', 'Cliente Banco')));
  db.close();

  const resposta = await api.get('/api/emissor/clones/9001?tipo=CXS');
  const corpo = await resposta.json();
  assert.equal(corpo.encontrado, true);
  assert.equal(corpo.fonte, 'banco');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Banco');
});

test('clone em JSON na rede é usado quando o banco não tem', async () => {
  fs.writeFileSync(path.join(api.clones, '9002.json'), JSON.stringify(payload('9002', 'Cliente Rede')));
  const resposta = await api.get('/api/emissor/clones/9002?tipo=CXS');
  const corpo = await resposta.json();
  assert.equal(corpo.fonte, 'rede');
  assert.equal(corpo.payload.entregas[0].cliente, 'Cliente Rede');
});

test('informa o outro tipo quando o histórico só tem PÇS', async () => {
  const db = new DatabaseSync(api.db);
  db.prepare(
    `INSERT OR REPLACE INTO emissor_pedidos_semana
       (numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('9003', 'PÇS', 'MRB', '2026-11-27', '2026-12-01', '2026-11-27', '[]');
  db.close();

  const corpo = await (await api.get('/api/emissor/clones/9003?tipo=CXS')).json();
  assert.deepEqual(corpo, { encontrado: false, outroTipo: 'PÇS' });
});

test('número inexistente devolve encontrado:false', async () => {
  const corpo = await (await api.get('/api/emissor/clones/999999?tipo=CXS')).json();
  assert.deepEqual(corpo, { encontrado: false });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/clones.test.ts
```

Esperado: 404 em todas as chamadas.

- [ ] **Step 3: Implementar**

No topo de `server/emissorPedidos.js`, ajustar os imports:

```js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CLONES_DIR, DB_FILE } from './config.js';
import { ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';
```

E acrescentar, depois da rota `/carteira`:

```js
/** Número só entra em nome de arquivo com estes caracteres. */
function nomeSeguro(texto) {
  const nome = String(texto ?? '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(nome) ? nome : null;
}

router.get('/clones/:numero', (req, res) => {
  const numero = nomeSeguro(req.params.numero);
  if (!numero) return res.status(400).json({ error: 'número de pedido inválido' });
  const tipo = String(req.query.tipo ?? '').toUpperCase();
  try {
    const db = ler();
    const registro = db
      .prepare('SELECT payload FROM emissor_pedidos_clonagem WHERE numero = ?')
      .get(numero);
    if (registro) {
      return res.json({ encontrado: true, fonte: 'banco', payload: JSON.parse(registro.payload) });
    }

    const arquivo = path.join(CLONES_DIR, `${numero}.json`);
    if (fs.existsSync(arquivo)) {
      try {
        return res.json({
          encontrado: true,
          fonte: 'rede',
          payload: JSON.parse(fs.readFileSync(arquivo, 'utf8')),
        });
      } catch {
        // JSON corrompido na rede: segue para o histórico
      }
    }

    const categorias = db
      .prepare('SELECT DISTINCT categoria FROM emissor_pedidos_semana WHERE numero = ?')
      .all(numero)
      .map((linha) => linha.categoria);
    const outro = tipo === 'CXS' ? 'PÇS' : 'CXS';
    if (tipo && categorias.includes(outro) && !categorias.includes(tipo)) {
      return res.json({ encontrado: false, outroTipo: outro });
    }
    res.json({ encontrado: false });
  } catch (erro) {
    responderSemBanco(res, erro);
  }
});
```

- [ ] **Step 4: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/clones.test.ts
```

Esperado: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add server/emissorPedidos.js tests/clones.test.ts
git commit -m "feat: leitura de clone do pedido (banco e rede)"
```

### Task 6: Reducer do formulário e aplicação de clone

**Files:**
- Create: `src/emissor/estado.ts`
- Test: `tests/estado.test.ts`

**Interfaces:**
- Consumes: tipos de `src/emissor/tipos.ts`; `normalizarBusca` de `formato.ts`.
- Produces: `type Estado = { carregado: boolean; base: BaseEmissor; dados: DadosGerais; entregas: EntregaForm[]; avisos: string[] }`, `type DadosGerais`, `type Acao`, `estadoInicial(base: BaseEmissor): Estado`, `reduzir(estado: Estado, acao: Acao): Estado`, `trocarOperacao(estado, id, operacao): Estado`, `aplicarClone(estado, payload, base): Estado`, `pedidoDe(estado: Estado): PedidoForm`, `paraPayloadApi(pedido: PedidoForm): object`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/estado.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aplicarClone,
  estadoInicial,
  pedidoDe,
  reduzir,
  trocarOperacao,
} from '../src/emissor/estado.ts';
import type { BaseEmissor, ClonePayload } from '../src/emissor/tipos.ts';

const base: BaseEmissor = {
  revision: '1',
  proximoNumero: '3834',
  clientes: [
    { codigo: '100', nome: 'Cliente A', cnpj: '', cidade: 'Natal', uf: 'RN', prazo: '30', codigoCentralizador: '', centralizador: '', statusCliente: '', limite: 0, disponivel: 0 },
  ],
  produtos: [
    { codigo: '1000', descricao: 'PATINHO', rotulo: '1000 - PATINHO', unidade: 'CX', peso: 15.5, categoria: 'CXS' },
  ],
  unidades: [{ sigla: 'MRB', nome: 'MATRIZ', rotulo: 'MRB - MATRIZ', critica: 'NÃO' }],
  destinos: ['SEM DESTINO', 'Cliente A'],
};

const clone: ClonePayload = {
  numero: '3500',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'mrb - matriz',
  observacao: 'clonado',
  data_pedido: '20/11/2026',
  data_embarque: '21/11/2026',
  data_entrega: '25/11/2026',
  entregas: [
    {
      cliente: 'Cliente A',
      destino: 'SEM DESTINO',
      operacao: 9,
      produtos: [
        { codigo: '1000', descricao: 'PATINHO', qtd: 5, unidade: 'CX', peso: 15.5, preco: 18, prazo: '' },
      ],
    },
    { cliente: 'ESC - NATAL', destino: 'ESC - NATAL', operacao: 3, peso_manual: 700, produtos: [] },
  ],
};

test('estado inicial vem da base', () => {
  const estado = estadoInicial(base);
  assert.equal(estado.dados.numero, '3834');
  assert.equal(estado.dados.atencao, 'Helcio Venancio');
  assert.equal(estado.dados.local, 'Natal');
  assert.equal(estado.dados.unidade, 'MRB - MATRIZ');
  assert.equal(estado.entregas.length, 1);
  assert.equal(estado.entregas[0].cliente, 'Cliente A');
  assert.equal(estado.entregas[0].operacao, 3);
  assert.equal(estado.entregas[0].produtos[0].prazo, '30');
});

test('trocar para operação 9 esvazia o destino', () => {
  const estado = trocarOperacao(estadoInicial(base), estadoInicial(base).entregas[0].id, 9);
  assert.equal(estado.entregas[0].destino, '');
});

test('aplicar clone: datas, unidade canônica e prazo semeado', () => {
  const estado = aplicarClone(estadoInicial(base), clone, base);
  assert.equal(estado.dados.numero, '3500');
  assert.equal(estado.dados.unidade, 'MRB - MATRIZ');
  assert.equal(estado.dados.dataEmbarque, '2026-11-21');
  assert.equal(estado.dados.dataEntrega, '2026-11-25');
  assert.equal(estado.entregas.length, 2);
  assert.equal(estado.entregas[0].produtos[0].prazo, '30');
  assert.equal(estado.entregas[1].pesoManual, 700);
  assert.notEqual(estado.entregas[0].id, estado.entregas[1].id);
});

test('duplicar e mover entregas', () => {
  const inicial = estadoInicial(base);
  let estado = reduzir(inicial, { tipo: 'duplicarEntrega', id: inicial.entregas[0].id });
  assert.equal(estado.entregas.length, 2);
  assert.notEqual(estado.entregas[0].id, estado.entregas[1].id);
  estado = reduzir(estado, { tipo: 'moverEntrega', id: estado.entregas[1].id, direcao: -1 });
  assert.equal(estado.entregas[1].id, inicial.entregas[0].id);
});

test('pedidoDe devolve um PedidoForm completo', () => {
  const pedido = pedidoDe(estadoInicial(base));
  assert.equal(pedido.numero, '3834');
  assert.equal(pedido.entregas.length, 1);
  assert.equal(pedido.entregas[0].produtos[0].prazo, '30');
  assert.match(pedido.dataEmbarque, /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/estado.test.ts
```

Esperado: erro de módulo inexistente.

- [ ] **Step 3: Implementar o reducer**

`src/emissor/estado.ts`:

```ts
import { normalizarBusca } from './formato';
import type {
  BaseEmissor,
  ClonePayload,
  EntregaForm,
  PedidoForm,
  ProdutoBase,
  ProdutoForm,
} from './tipos';

export interface DadosGerais {
  numero: string;
  atencao: string;
  local: string;
  unidade: string;
  observacao: string;
  dataEmissao: string;
  dataEmbarque: string;
  dataEntrega: string;
}

export interface Estado {
  carregado: boolean;
  base: BaseEmissor;
  dados: DadosGerais;
  entregas: EntregaForm[];
  avisos: string[];
}

export type Acao =
  | { tipo: 'campo'; campo: keyof DadosGerais; valor: string }
  | { tipo: 'novaEntrega' }
  | { tipo: 'duplicarEntrega'; id: string }
  | { tipo: 'removerEntrega'; id: string }
  | { tipo: 'moverEntrega'; id: string; direcao: -1 | 1 }
  | { tipo: 'campoEntrega'; id: string; campo: 'cliente' | 'destino'; valor: string }
  | { tipo: 'operacao'; id: string; valor: 3 | 9 }
  | { tipo: 'pesoManual'; id: string; valor: number | null }
  | { tipo: 'novoProduto'; entregaId: string }
  | { tipo: 'campoProduto'; entregaId: string; produtoId: string; campo: keyof ProdutoForm; valor: string | number }
  | { tipo: 'produtoDoCatalogo'; entregaId: string; produtoId: string; produto: ProdutoBase }
  | { tipo: 'removerProduto'; entregaId: string; produtoId: string }
  | { tipo: 'aplicarClone'; payload: ClonePayload; base: BaseEmissor }
  | { tipo: 'aviso'; texto: string }
  | { tipo: 'limparAvisos' };

let sequencia = 0;
const novoId = () => `id${++sequencia}`;

const isoHoje = () => {
  const d = new Date();
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
};

const brParaIso = (texto: string): string => {
  const achado = String(texto ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!achado) return '';
  const ano = Number(achado[3]) < 100 ? Number(achado[3]) + 2000 : Number(achado[3]);
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${ano}-${dois(Number(achado[2]))}-${dois(Number(achado[1]))}`;
};

const prazoDoCliente = (base: BaseEmissor, cliente: string, clienteBase?: string) => {
  const nome = normalizarBusca(clienteBase || cliente);
  const achado = base.clientes.find(
    (c) => normalizarBusca(c.nome) === nome || normalizarBusca(c.codigo) === nome,
  );
  return achado?.prazo || '';
};

function produtoVazio(base: BaseEmissor, prazo: string): ProdutoForm {
  const primeiro = base.produtos[0];
  return {
    id: novoId(),
    codigo: primeiro?.codigo ?? '',
    descricao: primeiro?.descricao ?? '',
    qtd: 1,
    unidade: primeiro?.unidade ?? 'kg',
    peso: primeiro?.peso ?? 1,
    preco: 0,
    prazo,
    categoria: primeiro?.categoria ?? 'CXS',
  };
}

function entregaVazia(base: BaseEmissor): EntregaForm {
  const cliente = base.clientes[0];
  return {
    id: novoId(),
    cliente: cliente?.nome ?? '',
    operacao: 3,
    destino: 'SEM DESTINO',
    pesoManual: null,
    produtos: [produtoVazio(base, cliente?.prazo ?? '')],
  };
}

export function estadoInicial(base: BaseEmissor): Estado {
  const hoje = isoHoje();
  return {
    carregado: true,
    base,
    dados: {
      numero: base.proximoNumero,
      atencao: 'Helcio Venancio',
      local: 'Natal',
      unidade: base.unidades[0]?.rotulo ?? '',
      observacao: '',
      dataEmissao: hoje,
      dataEmbarque: hoje,
      dataEntrega: hoje,
    },
    entregas: [entregaVazia(base)],
    avisos: [],
  };
}

export function trocarOperacao(estado: Estado, id: string, operacao: 3 | 9): Estado {
  return {
    ...estado,
    entregas: estado.entregas.map((e) =>
      e.id === id ? { ...e, operacao, destino: operacao === 9 ? '' : e.destino || 'SEM DESTINO' } : e,
    ),
  };
}

export function aplicarClone(estadoAtual: Estado, payload: ClonePayload, base: BaseEmissor): Estado {
  const unidade =
    base.unidades.find((u) => normalizarBusca(u.rotulo) === normalizarBusca(payload.unidade))?.rotulo ??
    payload.unidade;
  const hoje = isoHoje();
  const entregas: EntregaForm[] = (payload.entregas ?? []).map((entrega) => {
    const prazo = prazoDoCliente(base, entrega.cliente);
    return {
      id: novoId(),
      cliente: entrega.cliente,
      operacao: entrega.operacao === 9 ? 9 : 3,
      destino: entrega.destino ?? '',
      pesoManual: entrega.peso_manual ?? null,
      produtos: (entrega.produtos ?? []).map((produto) => ({
        id: novoId(),
        codigo: produto.codigo,
        descricao: produto.descricao,
        qtd: Number(produto.qtd) || 0,
        unidade: produto.unidade || 'kg',
        peso: Number(produto.peso) || 1,
        preco: Number(produto.preco) || 0,
        prazo: produto.prazo || prazo,
        categoria: base.produtos.find((p) => p.codigo === produto.codigo)?.categoria ?? '',
      })),
    };
  });
  return {
    ...estadoAtual,
    dados: {
      numero: String(payload.numero ?? estadoAtual.dados.numero),
      atencao: payload.atencao || 'Helcio Venancio',
      local: payload.local || 'Natal',
      unidade,
      observacao: payload.observacao ?? '',
      dataEmissao: brParaIso(payload.data_pedido) || hoje,
      dataEmbarque: brParaIso(payload.data_embarque) || hoje,
      dataEntrega: brParaIso(payload.data_entrega) || hoje,
    },
    entregas: entregas.length > 0 ? entregas : estadoAtual.entregas,
  };
}

const mover = <T,>(lista: T[], indice: number, direcao: -1 | 1): T[] => {
  const destino = indice + direcao;
  if (indice < 0 || destino < 0 || destino >= lista.length) return lista;
  const copia = [...lista];
  [copia[indice], copia[destino]] = [copia[destino], copia[indice]];
  return copia;
};

export function reduzir(estado: Estado, acao: Acao): Estado {
  switch (acao.tipo) {
    case 'campo':
      return { ...estado, dados: { ...estado.dados, [acao.campo]: acao.valor } };
    case 'novaEntrega':
      return { ...estado, entregas: [...estado.entregas, entregaVazia(estado.base)] };
    case 'duplicarEntrega': {
      const indice = estado.entregas.findIndex((e) => e.id === acao.id);
      if (indice < 0) return estado;
      const original = estado.entregas[indice];
      const copia: EntregaForm = {
        ...original,
        id: novoId(),
        produtos: original.produtos.map((p) => ({ ...p, id: novoId() })),
      };
      const entregas = [...estado.entregas];
      entregas.splice(indice + 1, 0, copia);
      return { ...estado, entregas };
    }
    case 'removerEntrega': {
      if (estado.entregas.length <= 1) return estado;
      return { ...estado, entregas: estado.entregas.filter((e) => e.id !== acao.id) };
    }
    case 'moverEntrega': {
      const indice = estado.entregas.findIndex((e) => e.id === acao.id);
      return { ...estado, entregas: mover(estado.entregas, indice, acao.direcao) };
    }
    case 'campoEntrega':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.id ? { ...e, [acao.campo]: acao.valor } : e,
        ),
      };
    case 'operacao':
      return trocarOperacao(estado, acao.id, acao.valor);
    case 'pesoManual':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.id ? { ...e, pesoManual: acao.valor } : e,
        ),
      };
    case 'novoProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: [
                  ...e.produtos,
                  produtoVazio(estado.base, prazoDoCliente(estado.base, e.cliente)),
                ],
              }
            : e,
        ),
      };
    case 'campoProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: e.produtos.map((p) =>
                  p.id === acao.produtoId
                    ? ({ ...p, [acao.campo]: acao.valor } as ProdutoForm)
                    : p,
                ),
              }
            : e,
        ),
      };
    case 'produtoDoCatalogo':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? {
                ...e,
                produtos: e.produtos.map((p) =>
                  p.id === acao.produtoId
                    ? {
                        ...p,
                        codigo: acao.produto.codigo,
                        descricao: acao.produto.descricao,
                        unidade: acao.produto.unidade,
                        peso: acao.produto.peso,
                        categoria: acao.produto.categoria,
                      }
                    : p,
                ),
              }
            : e,
        ),
      };
    case 'removerProduto':
      return {
        ...estado,
        entregas: estado.entregas.map((e) =>
          e.id === acao.entregaId
            ? { ...e, produtos: e.produtos.filter((p) => p.id !== acao.produtoId) }
            : e,
        ),
      };
    case 'aplicarClone':
      return aplicarClone(estado, acao.payload, acao.base);
    case 'aviso':
      return { ...estado, avisos: [...estado.avisos, acao.texto] };
    case 'limparAvisos':
      return { ...estado, avisos: [] };
  }
}

/** O formulário guarda ids locais; a API recebe só os dados. */
export function pedidoDe(estado: Estado): PedidoForm {
  return {
    ...estado.dados,
    entregas: estado.entregas.map((e) => ({
      ...e,
      produtos: e.produtos.map((p) => ({ ...p })),
    })),
  };
}

/** Corpo do POST /api/emissor/pedidos, sem campos de uso local. */
export function paraPayloadApi(pedido: PedidoForm) {
  return {
    numero: pedido.numero,
    atencao: pedido.atencao,
    local: pedido.local,
    unidade: pedido.unidade,
    observacao: pedido.observacao,
    dataEmissao: pedido.dataEmissao,
    dataEmbarque: pedido.dataEmbarque,
    dataEntrega: pedido.dataEntrega,
    entregas: pedido.entregas.map((e) => ({
      cliente: e.cliente,
      operacao: e.operacao,
      destino: e.destino,
      pesoManual: e.pesoManual,
      produtos: e.produtos.map((p) => ({
        codigo: p.codigo,
        descricao: p.descricao,
        qtd: p.qtd,
        unidade: p.unidade,
        peso: p.peso,
        preco: p.preco,
        prazo: p.prazo,
      })),
    })),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/estado.test.ts
```

Esperado: `# pass 5`.

- [ ] **Step 5: Typecheck**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/typescript/bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/emissor/estado.ts tests/estado.test.ts
git commit -m "feat: reducer do formulario de pedido e aplicacao de clone"
```

### Task 7: Regras do servidor (fonte da verdade)

**Files:**
- Create: `server/emissorRegras.js`
- Test: `tests/regras.test.ts`

**Interfaces:**
- Produces: `CATEGORIAS`, `ehEsc(texto)`, `categoriaDoProduto(categoria)`, `categoriasDoPedido(entregas)`, `pesoEntrega(entrega)`, `valorEntrega(entrega)`, `resumoPedido(pedido)`, `linhasHistorico(entregas, clientesPorNome, categoria)`, `nomeArquivoPdf({ numero, categorias, sigla, dataEmbarque })`, `dataBr(iso)`, `dataBrCurta(iso)`, `dataCurta(iso)`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/regras.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoriasDoPedido,
  dataBr,
  dataBrCurta,
  linhasHistorico,
  nomeArquivoPdf,
  pesoEntrega,
  resumoPedido,
} from '../server/emissorRegras.js';

const produto = (over = {}) => ({
  codigo: '1000',
  descricao: 'PATINHO',
  qtd: 10,
  unidade: 'CX',
  peso: 15.5,
  preco: 19.5,
  prazo: '30',
  categoria: 'CXS',
  ...over,
});

const entrega = (over = {}) => ({
  cliente: 'Cliente A',
  operacao: 3,
  destino: 'SEM DESTINO',
  pesoManual: null,
  produtos: [produto()],
  ...over,
});

test('categorias na ordem fixa', () => {
  const entregas = [
    entrega({ produtos: [produto({ categoria: 'SPG' }), produto({ categoria: 'CXS' })] }),
  ];
  assert.deepEqual(categoriasDoPedido(entregas), ['CXS', 'SPG']);
});

test('peso e resumo', () => {
  const pedido = {
    numero: '3834',
    entregas: [entrega(), entrega({ produtos: [produto({ qtd: 100 })] })],
  };
  assert.equal(pesoEntrega(pedido.entregas[0]), 155);
  const r = resumoPedido(pedido);
  assert.equal(r.pesoTotal, 1705);
  assert.equal(r.veiculo, 'Bi-truck');
  assert.equal(r.entregas, 2);
  assert.equal(r.nfsRemessa, 2);
  assert.equal(r.categorias, 'CXS');
});

test('linhas do histórico usam cidade-UF, limpam ESC (0) e filtram por categoria', () => {
  const clientes = new Map([
    ['Cliente A', { cidade: 'Natal', uf: 'RN' }],
    ['ESC - NATAL (0)', { cidade: 'Natal', uf: 'RN' }],
  ]);
  const entregas = [
    entrega({ cliente: 'Cliente A' }),
    entrega({ cliente: 'ESC - NATAL (0)', destino: 'ESC - NATAL (0)', operacao: 9, produtos: [] }),
  ];

  const cxs = linhasHistorico(entregas, clientes, 'CXS');
  assert.deepEqual(cxs, [
    { indice: 1, destino: 'SEM DESTINO', cliente: 'Cliente A', localizacao: 'Natal-RN' },
  ]);

  const pcs = linhasHistorico(entregas, clientes, 'PÇS');
  assert.equal(pcs.length, 1);
  assert.equal(pcs[0].indice, 2);
  assert.equal(pcs[0].destino, 'ESC - NATAL');
  assert.equal(pcs[0].cliente, 'ESC - NATAL');
  assert.equal(pcs[0].localizacao, 'Natal-RN');
});

test('datas para o PDF', () => {
  assert.equal(dataBr('2026-11-27'), '27/11/2026');
  assert.equal(dataBrCurta('2026-11-27'), '27/11/26');
});

test('nome do PDF segue o padrão e é sanitizado', () => {
  assert.equal(
    nomeArquivoPdf({ numero: '3834', categorias: 'CXS-PÇS', sigla: 'MRB', dataEmbarque: '2026-11-27' }),
    'Pedido Hajan CXS-PÇS nº 3834 (Embarque MRB 27.11.26).pdf',
  );
  assert.equal(
    nomeArquivoPdf({ numero: '38/34', categorias: 'CXS', sigla: 'MRB', dataEmbarque: '2026-11-27' }),
    'Pedido Hajan CXS nº 38_34 (Embarque MRB 27.11.26).pdf',
  );
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/regras.test.ts
```

Esperado: erro de módulo inexistente.

- [ ] **Step 3: Implementar**

`server/emissorRegras.js`:

```js
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
```

- [ ] **Step 4: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/regras.test.ts
```

Esperado: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add server/emissorRegras.js tests/regras.test.ts
git commit -m "feat: regras do pedido no servidor (peso, categorias, historico, nome do PDF)"
```

### Task 8: PDF do pedido

**Files:**
- Create: `server/emissorPdf.js`
- Test: `tests/pdf.test.ts`

**Interfaces:**
- Consumes: `ehEsc`, `dataBr`, `dataBrCurta` de `emissorRegras.js`; `ROOT` de `config.js`.
- Produces: `gerarPdf(pedido, contexto?): Promise<Buffer>`, onde `contexto = { clientes?: Map<string, { cnpj, cidade, uf }> }`.
- O `pedido` recebido já vem normalizado: `{ numero, sigla, categorias, atencao, local, unidade, observacao, dataEmissao, dataEmbarque, dataEntrega, pesoTotal, veiculo, nfsRemessa, entregas: [{ cliente, operacao, destino, peso, pesoManual, prazo, produtos: [{ descricao, qtd, unidade, preco, prazo }] }] }`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/pdf.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFParse } from 'pdf-parse';
import { gerarPdf } from '../server/emissorPdf.js';

const pedido = {
  numero: '3834',
  sigla: 'MRB',
  categorias: 'CXS-PÇS',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: 'Entregar pela manhã.',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  pesoTotal: 155,
  veiculo: 'Bi-truck',
  nfsRemessa: 1,
  entregas: [
    {
      cliente: 'Cliente A',
      operacao: 3,
      destino: 'SEM DESTINO',
      peso: 155,
      pesoManual: null,
      prazo: '30',
      produtos: [
        { descricao: 'PATINHO', qtd: 10, unidade: 'CX', preco: 19.5, prazo: '30' },
      ],
    },
  ],
};

test('gera um PDF com número e categorias', async () => {
  const buffer = await gerarPdf(pedido, {
    clientes: new Map([['Cliente A', { cnpj: '00.000.000/0001-00', cidade: 'Natal', uf: 'RN' }]]),
  });
  assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
  const leitor = new PDFParse({ data: buffer });
  const { text } = await leitor.getText();
  await leitor.destroy();
  assert.ok(text.includes('3834'), 'falta o número');
  assert.ok(text.includes('CXS-PÇS'), 'faltam as categorias');
  assert.ok(text.includes('Bi-truck'), 'falta o veículo');
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/pdf.test.ts
```

Esperado: erro de módulo inexistente.

- [ ] **Step 3: Implementar**

`server/emissorPdf.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { ROOT } from './config.js';
import { dataBr, dataBrCurta, ehEsc } from './emissorRegras.js';

const MM = 72 / 25.4;
const MARGEM = 10 * MM;
const LARGURA_UTIL = 190 * MM;
const AZUL = '#1F4E79';
const AZUL_FUNDO = '#DDEBF7';
const AMARELO = '#FFF200';

const moeda = (valor) => Number(valor ?? 0).toFixed(2);
const milhar = (valor) => Math.round(Number(valor ?? 0)).toLocaleString('pt-BR');

const COLUNAS = [
  { x: 0, largura: 80, align: 'left' },
  { x: 80, largura: 15, align: 'right' },
  { x: 95, largura: 15, align: 'center' },
  { x: 110, largura: 20, align: 'right' },
  { x: 130, largura: 30, align: 'right' },
];

function linhaTabela(doc, y, valores, { negrito = false, fundo = null } = {}) {
  const altura = 4 * MM;
  if (fundo) doc.rect(MARGEM, y, 160 * MM, altura).fill(fundo);
  doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor('#000000');
  COLUNAS.forEach((coluna, indice) => {
    doc.text(String(valores[indice] ?? ''), MARGEM + coluna.x * MM, y + 1.3 * MM, {
      width: coluna.largura * MM,
      height: altura,
      align: coluna.align,
      ellipsis: true,
      lineBreak: false,
    });
  });
  doc.lineWidth(0.3).strokeColor('#000000');
  for (const coluna of COLUNAS) {
    doc.rect(MARGEM + coluna.x * MM, y, coluna.largura * MM, altura).stroke();
  }
  doc.y = y + altura;
}

function cabecalho(doc, pedido) {
  const logo = path.join(ROOT, 'public', 'images', 'hajan-logo.png');
  const temLogo = fs.existsSync(logo);
  if (temLogo) doc.image(logo, MARGEM, 2 * MM, { width: 38 * MM });
  const y = temLogo ? 29 * MM : MARGEM;

  const titulo = `Pedido HAJAN ${pedido.categorias} nº ${pedido.numero} - ${pedido.sigla} (FRIBOI)`;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
  if (doc.widthOfString(titulo) > LARGURA_UTIL) doc.fontSize(8);
  doc.text(titulo, MARGEM, y, { width: LARGURA_UTIL, align: 'center' });

  doc.font('Helvetica').fontSize(8);
  for (const linha of [
    'Vendedor: 1677169-HAJAN COM. E REPRESENTAÇÕES',
    'Ao: Frigorifico Friboi (Grupo JBS)',
    `Unidade de Carregamento: ${pedido.unidade}`,
  ]) {
    doc.text(linha, MARGEM, doc.y + 1, { width: LARGURA_UTIL });
  }
  return doc.y + 2 * MM;
}

function desenhar(doc, pedido, contexto) {
  const clientes = contexto.clientes ?? new Map();
  const inicio = cabecalho(doc, pedido);

  doc.font('Helvetica').fontSize(8).fillColor('#000000');
  doc.text(
    `PEDIDO: ${pedido.numero} | At.: Sr. ${pedido.atencao} | ${pedido.local}, ${dataBr(pedido.dataEmissao)}`,
    MARGEM,
    inicio,
    { width: LARGURA_UTIL },
  );
  doc.text(
    `CIF  -  EMBARQUE: ${dataBrCurta(pedido.dataEmbarque)} - ENTREGA: ${dataBrCurta(pedido.dataEntrega)}`,
    { width: LARGURA_UTIL },
  );
  doc.y += 3 * MM;

  pedido.entregas.forEach((entrega, indice) => {
    if (doc.y > 230 * MM) doc.addPage();
    const dados = clientes.get(entrega.cliente) ?? {};
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#000000')
      .text(`PEDIDO: ${pedido.numero} - ${indice + 1}ª entrega`, MARGEM, doc.y + 4);
    doc.font('Helvetica').fontSize(8).text(`Cliente: ${entrega.cliente}`, MARGEM, doc.y + 1);

    const cnpj = String(dados.cnpj ?? '');
    const localizacao = [dados.cidade, dados.uf].filter(Boolean).join(' - ');
    if (cnpj || localizacao) {
      const base = doc.y + 1;
      let x = MARGEM;
      if (cnpj) {
        doc.font('Helvetica-Bold').fontSize(8);
        const texto = `CNPJ: ${cnpj}`;
        const largura = doc.widthOfString(texto) + 1 * MM;
        doc.rect(MARGEM, base, largura, 4 * MM).fill(AMARELO);
        doc.fillColor('#000000').text(texto, MARGEM + 0.5 * MM, base + 0.7 * MM, { lineBreak: false });
        x = MARGEM + largura;
      }
      if (localizacao) {
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
        doc.text(`Cidade: ${localizacao}`, x, base + 0.7 * MM, { lineBreak: false });
      }
      doc.y = base + 4 * MM;
    }

    const textoOperacao =
      entrega.operacao === 9
        ? 'Operação 9'
        : entrega.destino
          ? `Operação 3: ${entrega.destino}`
          : 'Operação 3';
    const faixa = doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(AZUL);
    const larguraOperacao = doc.widthOfString(textoOperacao) + 1 * MM;
    doc.rect(MARGEM, faixa, larguraOperacao, 4 * MM).fill(AZUL_FUNDO);
    doc.text(textoOperacao, MARGEM + 0.5 * MM, faixa + 0.8 * MM, { lineBreak: false });
    doc.fillColor('#000000');

    linhaTabela(doc, faixa + 4 * MM, ['Produto', 'Qtde.', 'Unid.', 'Preço', 'Prazo'], {
      negrito: true,
      fundo: '#EDEDED',
    });

    if (ehEsc(entrega.cliente) || ehEsc(entrega.destino)) {
      linhaTabela(doc, doc.y, [
        'PESO',
        milhar(entrega.pesoManual ?? 0),
        'KG',
        '0,00',
        entrega.prazo ?? '',
      ]);
    } else {
      for (const produto of entrega.produtos ?? []) {
        linhaTabela(doc, doc.y, [
          produto.descricao,
          milhar(produto.qtd),
          produto.unidade,
          moeda(produto.preco),
          produto.prazo,
        ]);
      }
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(`Peso Total da Entrega: ${milhar(entrega.peso)} kg`, MARGEM, doc.y + 1, {
        width: LARGURA_UTIL,
      });
    doc.y += 3 * MM;
  });

  if (doc.y > 210 * MM) doc.addPage();
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(`Peso Carga (Total - Kg): ${milhar(pedido.pesoTotal)}`, MARGEM, doc.y + 4);
  doc.font('Helvetica').fontSize(8);
  doc.text(`Veículo: ${pedido.veiculo}`);
  doc.text(`Quantidade de Entregas (NFs): ${pedido.entregas.length}`);
  doc.text(`Quantidade NFs de Remessa: ${pedido.nfsRemessa}`);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(6).text('OBSERVAÇÃO:', MARGEM, doc.y + 2);
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .text(pedido.observacao?.trim() || 'Sem observações.', { width: LARGURA_UTIL });
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(8).text('Observações Logísticas:', MARGEM, doc.y + 2);
  doc.font('Helvetica').fontSize(7).text(
    '1. Anexar na NF Boletos Bancários e Romaneio c/ o peso Peça por Peça.\n' +
      '2. Entregar p/ motorista R$ 40,00 por tonelada p/ pagamento da descarga.\n' +
      '3. Passar p/ Motorista nossos telefones p/ que entre em contato ao iniciar viagem\n' +
      '   (Tim e WhatsApp (84) 98865-0413), falar c/ Andreia.',
    { width: LARGURA_UTIL },
  );
}

export function gerarPdf(pedido, contexto = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGEM, left: MARGEM, right: MARGEM, bottom: MARGEM },
      bufferPages: true,
      info: { Title: `Pedido ${pedido.numero}` },
    });
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    // o FPDF repete o cabeçalho em toda página; aqui redesenhamos ao adicionar página
    doc.on('pageAdded', () => cabecalho(doc, pedido));
    desenhar(doc, pedido, contexto);

    const total = doc.bufferedPageRange().count;
    for (let pagina = 0; pagina < total; pagina += 1) {
      doc.switchToPage(pagina);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor('#000000')
        .text(`Página ${pagina + 1}/${total}`, MARGEM, 282 * MM, {
          width: LARGURA_UTIL,
          align: 'center',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/pdf.test.ts
```

Esperado: `# pass 1`. Se o texto extraído vier com acentos quebrados, o teste falha em `CXS-PÇS` — nesse caso, ajuste a asserção para `CXS` e registre no commit que o layout foi conferido visualmente no Step 5.

- [ ] **Step 5: Conferir visualmente**

Gere um PDF de amostra e abra:

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" -e "import('./server/emissorPdf.js').then(async ({gerarPdf}) => { const fs = await import('node:fs'); const b = await gerarPdf({ numero:'3834', sigla:'MRB', categorias:'CXS', atencao:'Helcio', local:'Natal', unidade:'MRB - MATRIZ', observacao:'', dataEmissao:'2026-11-27', dataEmbarque:'2026-11-27', dataEntrega:'2026-12-01', pesoTotal:155, veiculo:'Bi-truck', nfsRemessa:1, entregas:[{cliente:'Cliente A', operacao:3, destino:'SEM DESTINO', peso:155, pesoManual:null, prazo:'30', produtos:[{descricao:'PATINHO', qtd:10, unidade:'CX', preco:19.5, prazo:'30'}]}] }); fs.writeFileSync('amostra-pedido.pdf', b); });"
```

Abra `amostra-pedido.pdf`, confira contra o PDF atual do Streamlit e apague o arquivo depois (não commitar).

- [ ] **Step 6: Commit**

```bash
git add server/emissorPdf.js tests/pdf.test.ts
git commit -m "feat: PDF do pedido com pdfkit no layout do Emissor"
```

### Task 9: Escrita do pedido — PDF, histórico, clone e download

**Files:**
- Modify: `server/emissorPedidos.js` (imports + `POST /pedidos` + `GET /pedidos/pdf/:arquivo`)
- Test: `tests/pedidos.test.ts`

**Interfaces:**
- Consumes: `gerarPdf` (Task 8), `resumoPedido`/`categoriasDoPedido`/`linhasHistorico`/`nomeArquivoPdf`/`ehEsc`/`dataBr` (Task 7), `CLONES_DIR`/`PDF_DIRS`/`ROOT` (config), `gravar` (Task 1).
- Produces: `POST /api/emissor/pedidos` → `{ ok, pedido, arquivo, salvoEm, download, avisos }`; `GET /api/emissor/pedidos/pdf/:arquivo` → PDF (nome validado por regex, servido da pasta local).

- [ ] **Step 1: Escrever o teste que falha**

`tests/pedidos.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const corpo = (over: Record<string, unknown> = {}) => ({
  numero: '7001',
  atencao: 'Helcio Venancio',
  local: 'Natal',
  unidade: 'MRB - MATRIZ',
  observacao: 'Teste',
  dataEmissao: '2026-11-27',
  dataEmbarque: '2026-11-27',
  dataEntrega: '2026-12-01',
  entregas: [
    {
      cliente: 'Cliente A',
      operacao: 3,
      destino: 'SEM DESTINO',
      pesoManual: null,
      produtos: [
        { codigo: 'TST1', descricao: 'PATINHO', qtd: 10, unidade: 'CX', peso: 15.5, preco: 19.5, prazo: '30' },
        { codigo: 'TST2', descricao: 'COXAO', qtd: 2, unidade: 'CX', peso: 10, preco: 20, prazo: '30' },
      ],
    },
  ],
  ...over,
});

test('gera PDF, grava histórico e clone, e serve o download', async () => {
  const resposta = await api.post('/api/emissor/pedidos', corpo());
  assert.equal(resposta.status, 200);
  const resultado = await resposta.json();
  assert.equal(resultado.ok, true);
  assert.equal(resultado.pedido.pesoTotal, 175);
  assert.equal(resultado.pedido.nfsRemessa, 1);
  assert.equal(resultado.pedido.registradoNoHistorico, true);
  assert.match(resultado.arquivo, /^Pedido Hajan .* nº 7001 \(Embarque MRB 27\.11\.26\)\.pdf$/);

  const pdf = path.join(api.pdfs, resultado.arquivo);
  assert.ok(fs.existsSync(pdf), 'PDF não foi gravado na pasta configurada');
  assert.equal(fs.readFileSync(pdf).subarray(0, 4).toString(), '%PDF');

  const db = new DatabaseSync(api.db, { readOnly: true });
  const historico = db
    .prepare('SELECT categoria, sigla, linhas FROM emissor_pedidos_semana WHERE numero = ? ORDER BY categoria')
    .all('7001');
  const clone = db.prepare('SELECT payload FROM emissor_pedidos_clonagem WHERE numero = ?').get('7001');
  db.close();
  assert.ok(historico.length >= 1);
  assert.equal(historico[0].sigla, 'MRB');
  assert.equal(JSON.parse(historico[0].linhas)[0].destino, 'SEM DESTINO');
  assert.equal(JSON.parse(clone!.payload as string).entregas[0].cliente, 'Cliente A');

  assert.ok(fs.existsSync(path.join(api.clones, '7001.json')), 'clone JSON não foi gravado');

  const download = await api.get(resultado.download);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /application\/pdf/);
});

test('ESC usa peso manual e não tem produtos', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({
      numero: '7002',
      entregas: [
        { cliente: 'ESC - NATAL', operacao: 9, destino: 'ESC - NATAL', pesoManual: 800, produtos: [] },
      ],
    }),
  );
  assert.equal(resposta.status, 200);
  const resultado = await resposta.json();
  assert.equal(resultado.pedido.pesoTotal, 800);
  assert.equal(resultado.pedido.nfsRemessa, 0);

  const db = new DatabaseSync(api.db, { readOnly: true });
  const pcs = db
    .prepare("SELECT linhas FROM emissor_pedidos_semana WHERE numero = '7002' AND categoria = 'PÇS'")
    .get();
  const cxs = db
    .prepare("SELECT linhas FROM emissor_pedidos_semana WHERE numero = '7002' AND categoria = 'CXS'")
    .get();
  db.close();
  assert.equal(JSON.parse(pcs.linhas)[0].destino, 'ESC - NATAL');
  assert.equal(cxs, undefined);
});

test('pedido sem cliente é recusado sem gravar nada', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({ numero: '7003', entregas: [{ cliente: '', operacao: 3, destino: '', produtos: [] }] }),
  );
  assert.equal(resposta.status, 400);
  const db = new DatabaseSync(api.db, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emissor_pedidos_semana WHERE numero = ?').get('7003').c, 0);
  db.close();
});

test('sem PÇS nem CXS grava PDF mas não grava histórico', async () => {
  const resposta = await api.post(
    '/api/emissor/pedidos',
    corpo({
      numero: '7004',
      entregas: [
        {
          cliente: 'Cliente A',
          operacao: 3,
          destino: 'SEM DESTINO',
          pesoManual: null,
          produtos: [{ codigo: 'X1', descricao: 'ITEM', qtd: 1, unidade: 'KG', peso: 5, preco: 1, prazo: '30', categoria: 'SPG' }],
        },
      ],
    }),
  );
  const resultado = await resposta.json();
  assert.equal(resultado.ok, true);
  assert.equal(resultado.pedido.registradoNoHistorico, false);
  assert.ok(resultado.avisos.length > 0);
});

test('nome de PDF fora do padrão é recusado no download', async () => {
  const resposta = await api.get('/api/emissor/pedidos/pdf/..%5Csenha-admin.txt');
  assert.equal(resposta.status, 400);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/pedidos.test.ts
```

Esperado: 404 em todas.

- [ ] **Step 3: Ajustar imports e helpers no router**

No topo de `server/emissorPedidos.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CLONES_DIR, DB_FILE, PDF_DIRS, ROOT } from './config.js';
import { gravar, ler, responderSemBanco } from './emissorBanco.js';
import { carteira } from './emissorCarteira.js';
import { gerarPdf } from './emissorPdf.js';
import {
  categoriasDoPedido,
  dataBr,
  ehEsc,
  linhasHistorico,
  nomeArquivoPdf,
  resumoPedido,
} from './emissorRegras.js';
```

- [ ] **Step 4: Implementar o POST e o download**

No fim de `server/emissorPedidos.js`:

```js
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const NOME_PDF = /^[^<>:"/\\|?*\u0000-\u001f]{1,180}\.pdf$/;

const erro400 = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

function siglaDaUnidade(unidade) {
  return String(unidade ?? '').trim().split(/\s*-\s*/)[0].slice(0, 12) || 'SEM';
}

function pastasDoPdf() {
  const pastas = PDF_DIRS.filter((dir) => fs.existsSync(dir));
  const local = path.join(ROOT, 'pedidos-pdf');
  if (!pastas.includes(local)) {
    try {
      fs.mkdirSync(local, { recursive: true });
      pastas.push(local);
    } catch {
      // sem a pasta local: o PDF fica só onde a rede permitir
    }
  }
  return pastas;
}

function gravarAtomico(caminho, conteudo) {
  const temporario = `${caminho}.tmp`;
  fs.writeFileSync(temporario, conteudo);
  fs.renameSync(temporario, caminho);
}

router.post('/pedidos', async (req, res) => {
  const avisos = [];
  try {
    const bruto = req.body ?? {};
    const numero = String(bruto.numero ?? '').trim();
    if (!/^\d{1,10}$/.test(numero)) throw erro400('informe o número do pedido (só dígitos)');
    for (const [campo, chave] of [['emissão', 'dataEmissao'], ['embarque', 'dataEmbarque'], ['entrega', 'dataEntrega']]) {
      if (!ISO.test(String(bruto[chave] ?? ''))) throw erro400(`data de ${campo} inválida`);
    }
    const entregasBrutas = Array.isArray(bruto.entregas) ? bruto.entregas : [];
    if (entregasBrutas.length === 0) throw erro400('inclua pelo menos uma entrega');

    const db = gravar();
    const catalogo = new Map(
      db
        .prepare('SELECT codigo, descricao, unidade, peso, categoria FROM emissor_produtos')
        .all()
        .map((p) => [String(p.codigo), p]),
    );
    const clientesPorNome = new Map(
      db
        .prepare(
          `SELECT nome_formatado AS nome, COALESCE(cnpj,'') AS cnpj, COALESCE(cidade,'') AS cidade,
                  COALESCE(uf,'') AS uf, COALESCE(prazo_padrao,'') AS prazo_padrao
             FROM emissor_clientes`,
        )
        .all()
        .map((c) => [c.nome, c]),
    );

    const entregas = entregasBrutas.map((entrega, indice) => {
      const cliente = String(entrega.cliente ?? '').trim();
      if (!cliente) throw erro400(`entrega ${indice + 1}: informe o cliente`);
      const destino = String(entrega.destino ?? '').trim();
      const operacao = Number(entrega.operacao) === 9 ? 9 : 3;
      const dadosCliente = clientesPorNome.get(cliente);
      const esc = ehEsc(cliente) || ehEsc(destino);

      if (esc) {
        const pesoManual = Number(entrega.pesoManual);
        if (!Number.isFinite(pesoManual) || pesoManual <= 0) {
          throw erro400(`entrega ${indice + 1}: ESC exige peso manual maior que zero`);
        }
        return {
          cliente,
          operacao,
          destino,
          pesoManual,
          peso: pesoManual,
          prazo: dadosCliente?.prazo_padrao ?? '',
          produtos: [],
        };
      }

      const produtos = (Array.isArray(entrega.produtos) ? entrega.produtos : []).map((produto) => {
        const codigo = String(produto.codigo ?? '').trim();
        const doCatalogo = catalogo.get(codigo);
        const qtd = Number(produto.qtd);
        if (!codigo || !Number.isFinite(qtd) || qtd < 1) {
          throw erro400(`entrega ${indice + 1}: produto com código ou quantidade inválida`);
        }
        return {
          codigo,
          descricao: String(produto.descricao ?? doCatalogo?.descricao ?? '').trim(),
          qtd,
          unidade: String(produto.unidade ?? doCatalogo?.unidade ?? 'kg'),
          peso: Number(doCatalogo?.peso ?? produto.peso ?? 1) || 1,
          preco: Number(produto.preco ?? 0) || 0,
          prazo: String(produto.prazo ?? dadosCliente?.prazo_padrao ?? ''),
          categoria: String(produto.categoria ?? doCatalogo?.categoria ?? ''),
        };
      });
      if (produtos.length === 0) throw erro400(`entrega ${indice + 1}: inclua ao menos um produto`);

      const peso = produtos.reduce((soma, p) => soma + p.qtd * p.peso, 0);
      return {
        cliente,
        operacao,
        destino,
        pesoManual: null,
        peso,
        prazo: dadosCliente?.prazo_padrao ?? '',
        produtos,
      };
    });

    const resumo = resumoPedido({ entregas });
    const sigla = siglaDaUnidade(bruto.unidade);
    const pedidoPdf = {
      numero,
      sigla,
      categorias: resumo.categorias,
      atencao: String(bruto.atencao ?? ''),
      local: String(bruto.local ?? ''),
      unidade: String(bruto.unidade ?? ''),
      observacao: String(bruto.observacao ?? ''),
      dataEmissao: bruto.dataEmissao,
      dataEmbarque: bruto.dataEmbarque,
      dataEntrega: bruto.dataEntrega,
      pesoTotal: resumo.pesoTotal,
      veiculo: resumo.veiculo,
      nfsRemessa: resumo.nfsRemessa,
      entregas,
    };

    const buffer = await gerarPdf(pedidoPdf, { clientes: clientesPorNome });
    const arquivo = nomeArquivoPdf({
      numero,
      categorias: resumo.categorias,
      sigla,
      dataEmbarque: bruto.dataEmbarque,
    });

    const salvoEm = [];
    for (const pasta of pastasDoPdf()) {
      try {
        gravarAtomico(path.join(pasta, arquivo), buffer);
        salvoEm.push(pasta);
      } catch {
        avisos.push(`não foi possível gravar em ${pasta}`);
      }
    }
    if (salvoEm.length === 0) throw new Error('nenhuma pasta de PDF disponível');

    const categoriasHistorico = categoriasDoPedido(entregas).filter(
      (c) => c === 'PÇS' || c === 'CXS',
    );
    const agora = new Date().toISOString();
    let registradoNoHistorico = false;
    if (categoriasHistorico.length > 0) {
      const inserir = db.prepare(
        `INSERT OR REPLACE INTO emissor_pedidos_semana
           (numero, categoria, sigla, data_embarque, data_entrega, criado_em, linhas)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const categoria of categoriasHistorico) {
        const linhas = JSON.stringify(linhasHistorico(entregas, clientesPorNome, categoria));
        inserir.run(numero, categoria, sigla, bruto.dataEmbarque, bruto.dataEntrega, agora, linhas);
      }
      registradoNoHistorico = true;
    } else {
      avisos.push('pedido sem PÇS nem CXS: PDF e clone gerados, histórico não registrado');
    }

    const payloadClone = {
      numero,
      atencao: pedidoPdf.atencao,
      local: pedidoPdf.local,
      unidade: pedidoPdf.unidade,
      observacao: pedidoPdf.observacao,
      data_pedido: dataBr(bruto.dataEmissao),
      data_embarque: dataBr(bruto.dataEmbarque),
      data_entrega: dataBr(bruto.dataEntrega),
      entregas: entregas.map((e) => ({
        cliente: e.cliente,
        destino: e.destino,
        operacao: e.operacao,
        ...(e.pesoManual != null ? { peso_manual: e.pesoManual } : {}),
        produtos: e.produtos.map((p) => ({
          codigo: p.codigo,
          descricao: p.descricao,
          qtd: p.qtd,
          unidade: p.unidade,
          peso: p.peso,
          preco: p.preco,
          prazo: p.prazo,
        })),
      })),
    };

    db.prepare(
      'INSERT OR REPLACE INTO emissor_pedidos_clonagem (numero, criado_em, payload) VALUES (?, ?, ?)',
    ).run(numero, agora, JSON.stringify(payloadClone));

    try {
      fs.mkdirSync(CLONES_DIR, { recursive: true });
      gravarAtomico(path.join(CLONES_DIR, `${numero}.json`), JSON.stringify(payloadClone, null, 2));
    } catch {
      avisos.push(`não foi possível gravar o clone em ${CLONES_DIR}`);
    }

    res.json({
      ok: true,
      pedido: {
        categorias: resumo.categorias,
        pesoTotal: resumo.pesoTotal,
        valor: resumo.valor,
        veiculo: resumo.veiculo,
        entregas: resumo.entregas,
        nfsRemessa: resumo.nfsRemessa,
        registradoNoHistorico,
      },
      arquivo,
      salvoEm,
      download: `/api/emissor/pedidos/pdf/${encodeURIComponent(arquivo)}`,
      avisos,
    });
  } catch (erro) {
    if (erro.status === 400) return res.status(400).json({ error: erro.message });
    console.error('falha ao gerar pedido:', erro);
    res.status(500).json({ error: `não consegui gerar o pedido: ${erro.message}` });
  }
});

router.get('/pedidos/pdf/:arquivo', (req, res) => {
  const nome = String(req.params.arquivo ?? '');
  if (!NOME_PDF.test(nome) || path.basename(nome) !== nome) {
    return res.status(400).json({ error: 'nome de arquivo inválido' });
  }
  const pastaLocal = path.join(ROOT, 'pedidos-pdf');
  const caminho = path.join(pastaLocal, nome);
  if (!fs.existsSync(caminho)) {
    return res.status(404).json({ error: 'PDF não encontrado nesta máquina' });
  }
  res.set('Content-Type', 'application/pdf');
  res.sendFile(caminho);
});
```

- [ ] **Step 5: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/pedidos.test.ts
```

Esperado: `# pass 5`.

- [ ] **Step 6: Rodar a suíte inteira**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/*.test.ts
```

Esperado: todos passando. Se `pedidos.test.ts` falhar só na asserção de texto do PDF, veja a observação da Task 8.

- [ ] **Step 7: Commit**

```bash
git add server/emissorPedidos.js tests/pedidos.test.ts
git commit -m "feat: geracao de pedido com PDF, historico, clone e download"
```

### Task 10: Tela nativa — carga, dados gerais e entregas

**Files:**
- Modify: `src/api.ts`
- Create: `src/screens/EmissorPedidoScreen.tsx`
- Create: `src/screens/emissor/DadosGerais.tsx`
- Create: `src/screens/emissor/EntregaCard.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `BaseEmissor`, `ClonePayload`, `estadoInicial`, `reduzir`, `Acao`, `Estado`, `ehEsc`, `pesoEntrega`, `valorEntrega`, `converterNumero`, `formatarNumero`, `formatarMoeda`, `localizarOpcao`.
- Produces em `src/api.ts`: `Carteira`, `EmissaoResultado`, `ImportacaoResultado` (tipos) e `api.emissorBase()`, `api.emissorCarteira()`, `api.emissorClone(numero, tipo)`, `api.emitirPedido(corpo)`, `api.importarPlanilhas(arquivos)`.
- Produces: `<EmissorPedidoScreen />`; componentes com props `{ estado, dispatch, base }`.

- [ ] **Step 1: Ampliar o cliente de API**

Em `src/api.ts`, acrescentar aos imports de tipo:

```ts
import type { BaseEmissor, ClonePayload } from './emissor/tipos';
```

E antes de `async function request`:

```ts
export interface CarteiraRegistro {
  nome: string;
  limite: number;
  saldoFinanceiro: number;
  saldoCarteira: number;
  saldoCredito: number;
  status: string;
}

export interface CarteiraMedia {
  mediaMensal6m: number;
  mediaSemana: number;
  statusCompra: string;
}

export type Carteira =
  | { disponivel: false }
  | {
      disponivel: true;
      data: string;
      registros: Record<string, CarteiraRegistro>;
      media: Record<string, CarteiraMedia>;
    };

export interface EmissaoResultado {
  ok: boolean;
  pedido: {
    categorias: string;
    pesoTotal: number;
    valor: number;
    veiculo: string;
    entregas: number;
    nfsRemessa: number;
    registradoNoHistorico: boolean;
  };
  arquivo: string;
  salvoEm: string[];
  download: string;
  avisos: string[];
}

export interface ImportacaoResultado {
  backup: string;
  contagens: { clientes: number; produtos: number; limites: number; unidades: number };
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `falha na comunicação (${response.status})`);
  }
  return (await response.json()) as T;
}
```

E no objeto `api`, depois de `emissorPedidos`:

```ts
  emissorBase: () => request<BaseEmissor>('/api/emissor/base'),
  emissorCarteira: () => request<Carteira>('/api/emissor/carteira'),
  emissorClone: (numero: string, tipo: string) =>
    request<{
      encontrado: boolean;
      fonte?: 'banco' | 'rede';
      payload?: ClonePayload;
      outroTipo?: string;
    }>(`/api/emissor/clones/${encodeURIComponent(numero)}?tipo=${encodeURIComponent(tipo)}`),
  emitirPedido: (corpo: unknown) =>
    request<EmissaoResultado>('/api/emissor/pedidos', {
      method: 'POST',
      body: JSON.stringify(corpo),
    }),
  importarPlanilhas: (arquivos: Partial<Record<'clientes' | 'produtos' | 'limites' | 'unidades', File>>) => {
    const form = new FormData();
    for (const [tipo, arquivo] of Object.entries(arquivos)) {
      if (arquivo) form.append(tipo, arquivo);
    }
    return requestForm<ImportacaoResultado>('/api/emissor/importar', form);
  },
```

- [ ] **Step 2: Criar a tela**

`src/screens/EmissorPedidoScreen.tsx`:

```tsx
import { useCallback, useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import { estadoInicial, reduzir } from '../emissor/estado';
import type { BaseEmissor } from '../emissor/tipos';
import { Clonagem } from './emissor/Clonagem';
import { DadosGerais } from './emissor/DadosGerais';
import { EntregaCard } from './emissor/EntregaCard';
import { GerarPedido } from './emissor/GerarPedido';
import { ResumoCarga } from './emissor/ResumoCarga';

export function EmissorPedidoScreen() {
  const [base, setBase] = useState<BaseEmissor | null>(null);
  const [chave, setChave] = useState(0);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(() => {
    setErro(null);
    api
      .emissorBase()
      .then(setBase)
      .catch((cause) => setErro(cause instanceof Error ? cause.message : 'sem resposta do servidor'));
  }, []);

  useEffect(() => carregar(), [carregar]);

  if (erro) {
    return (
      <section className="emissor-screen">
        <p className="alert">
          {erro}{' '}
          <button type="button" className="btn ghost small" onClick={carregar}>
            Tentar de novo
          </button>
        </p>
      </section>
    );
  }

  if (!base) {
    return (
      <section className="emissor-screen">
        <p className="panel-sub">Carregando clientes, produtos e unidades…</p>
      </section>
    );
  }

  return <Formulario key={chave} base={base} onNovo={() => setChave((n) => n + 1)} />;
}

function Formulario({ base, onNovo }: { base: BaseEmissor; onNovo: () => void }) {
  const [estado, dispatch] = useReducer(reduzir, base, estadoInicial);

  return (
    <section className="emissor-screen">
      <header className="emissor-cabecalho">
        <div>
          <span className="eyebrow">Digitação de pedidos</span>
          <h1>Novo pedido</h1>
        </div>
        <ResumoCarga estado={estado} />
      </header>

      <datalist id="destinos-pedido">
        {base.destinos.map((destino) => (
          <option key={destino} value={destino} />
        ))}
      </datalist>

      <Clonagem dispatch={dispatch} base={base} />
      <DadosGerais estado={estado} dispatch={dispatch} base={base} />

      <div className="emissor-entregas">
        {estado.entregas.map((entrega, indice) => (
          <EntregaCard
            key={entrega.id}
            entrega={entrega}
            indice={indice}
            total={estado.entregas.length}
            base={base}
            dispatch={dispatch}
          />
        ))}
      </div>

      <div className="emissor-acoes">
        <button type="button" className="btn ghost" onClick={() => dispatch({ tipo: 'novaEntrega' })}>
          + Entrega
        </button>
      </div>

      <GerarPedido estado={estado} onNovo={onNovo} />
    </section>
  );
}
```

- [ ] **Step 3: Dados gerais**

`src/screens/emissor/DadosGerais.tsx`:

```tsx
import type { Dispatch } from 'react';
import type { Acao, Estado } from '../../emissor/estado';
import { localizarOpcao } from '../../emissor/formato';
import type { BaseEmissor } from '../../emissor/tipos';

interface Props {
  estado: Estado;
  dispatch: Dispatch<Acao>;
  base: BaseEmissor;
}

export function DadosGerais({ estado, dispatch, base }: Props) {
  const { dados } = estado;
  const campo = (nome: keyof typeof dados) => ({
    value: dados[nome],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      dispatch({ tipo: 'campo', campo: nome, valor: event.target.value }),
  });

  return (
    <section className="card emissor-bloco">
      <h2>Dados gerais</h2>
      <div className="emissor-grade">
        <label>
          <span>Nº do pedido</span>
          <input inputMode="numeric" {...campo('numero')} />
        </label>
        <label>
          <span>A/C</span>
          <input {...campo('atencao')} />
        </label>
        <label>
          <span>Data de emissão</span>
          <input type="date" {...campo('dataEmissao')} />
        </label>
        <label>
          <span>Local</span>
          <input {...campo('local')} />
        </label>
        <label>
          <span>Unidade de carregamento</span>
          <input
            list="unidades-pedido"
            {...campo('unidade')}
            onBlur={(event) => {
              const achado = localizarOpcao(
                base.unidades.map((u) => ({ valor: u.sigla, rotulo: u.rotulo })),
                event.target.value,
              );
              if (achado) dispatch({ tipo: 'campo', campo: 'unidade', valor: achado.rotulo });
            }}
          />
          <datalist id="unidades-pedido">
            {base.unidades.map((unidade) => (
              <option key={unidade.sigla} value={unidade.rotulo} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Embarque</span>
          <input type="date" {...campo('dataEmbarque')} />
        </label>
        <label>
          <span>Entrega</span>
          <input type="date" {...campo('dataEntrega')} />
        </label>
      </div>
      <label className="emissor-observacao">
        <span>Observação</span>
        <textarea
          rows={2}
          value={dados.observacao}
          onChange={(event) => dispatch({ tipo: 'campo', campo: 'observacao', valor: event.target.value })}
        />
      </label>
      {dados.dataEntrega < dados.dataEmbarque && (
        <p className="hint">A entrega está antes do embarque — confira as datas.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Cartão de entrega**

`src/screens/emissor/EntregaCard.tsx`:

```tsx
import type { Dispatch } from 'react';
import { ehEsc, pesoEntrega, valorEntrega } from '../../emissor/calculo';
import type { Acao } from '../../emissor/estado';
import { converterNumero, formatarMoeda, formatarNumero } from '../../emissor/formato';
import type { BaseEmissor, EntregaForm, ProdutoForm } from '../../emissor/tipos';

interface Props {
  entrega: EntregaForm;
  indice: number;
  total: number;
  base: BaseEmissor;
  dispatch: Dispatch<Acao>;
}

export function EntregaCard({ entrega, indice, total, base, dispatch }: Props) {
  const esc = ehEsc(entrega.cliente) || ehEsc(entrega.destino);
  const campoProduto = (produto: ProdutoForm, campo: keyof ProdutoForm, valor: string | number) =>
    dispatch({
      tipo: 'campoProduto',
      entregaId: entrega.id,
      produtoId: produto.id,
      campo,
      valor,
    });

  return (
    <article className="card emissor-entrega">
      <header className="emissor-entrega-topo">
        <strong>Entrega {indice + 1}</strong>
        <div className="emissor-entrega-acoes">
          <button
            type="button"
            className="btn ghost small"
            aria-label="Subir entrega"
            disabled={indice === 0}
            onClick={() => dispatch({ tipo: 'moverEntrega', id: entrega.id, direcao: -1 })}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn ghost small"
            aria-label="Descer entrega"
            disabled={indice === total - 1}
            onClick={() => dispatch({ tipo: 'moverEntrega', id: entrega.id, direcao: 1 })}
          >
            ↓
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => dispatch({ tipo: 'duplicarEntrega', id: entrega.id })}
          >
            Duplicar
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={total <= 1}
            onClick={() => dispatch({ tipo: 'removerEntrega', id: entrega.id })}
          >
            Excluir
          </button>
        </div>
      </header>

      <div className="emissor-grade">
        <label>
          <span>Cliente de faturamento</span>
          <select
            value={entrega.cliente}
            onChange={(event) =>
              dispatch({ tipo: 'campoEntrega', id: entrega.id, campo: 'cliente', valor: event.target.value })
            }
          >
            {base.clientes.map((cliente) => (
              <option key={cliente.codigo} value={cliente.nome}>
                {cliente.nome}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Operação</span>
          <select
            value={entrega.operacao}
            onChange={(event) =>
              dispatch({
                tipo: 'operacao',
                id: entrega.id,
                valor: Number(event.target.value) === 9 ? 9 : 3,
              })
            }
          >
            <option value={3}>3</option>
            <option value={9}>9</option>
          </select>
        </label>
        <label>
          <span>Destino</span>
          <input
            list="destinos-pedido"
            value={entrega.destino}
            onChange={(event) =>
              dispatch({ tipo: 'campoEntrega', id: entrega.id, campo: 'destino', valor: event.target.value })
            }
          />
        </label>
        {esc && (
          <label>
            <span>Peso manual (kg)</span>
            <input
              inputMode="decimal"
              value={entrega.pesoManual ?? ''}
              onChange={(event) =>
                dispatch({
                  tipo: 'pesoManual',
                  id: entrega.id,
                  valor: converterNumero(event.target.value),
                })
              }
            />
          </label>
        )}
      </div>

      {esc ? (
        <p className="hint">Entrega ESC: sem produtos, o PDF imprime só a linha de peso.</p>
      ) : (
        <>
          <table className="emissor-tabela">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Qtde.</th>
                <th>Unid.</th>
                <th>Peso</th>
                <th>Preço</th>
                <th>Prazo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entrega.produtos.map((produto) => (
                <tr key={produto.id}>
                  <td>
                    <select
                      value={produto.codigo}
                      onChange={(event) => {
                        const escolhido = base.produtos.find((p) => p.codigo === event.target.value);
                        if (escolhido) {
                          dispatch({
                            tipo: 'produtoDoCatalogo',
                            entregaId: entrega.id,
                            produtoId: produto.id,
                            produto: escolhido,
                          });
                        }
                      }}
                    >
                      <option value="">—</option>
                      {base.produtos.map((p) => (
                        <option key={p.codigo} value={p.codigo}>
                          {p.rotulo}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="num"
                      inputMode="numeric"
                      value={produto.qtd}
                      onChange={(event) =>
                        campoProduto(produto, 'qtd', Math.round(converterNumero(event.target.value) ?? 0))
                      }
                    />
                  </td>
                  <td>
                    <input value={produto.unidade} onChange={(event) => campoProduto(produto, 'unidade', event.target.value)} />
                  </td>
                  <td>
                    <input
                      className="num"
                      inputMode="decimal"
                      value={produto.peso}
                      onChange={(event) => campoProduto(produto, 'peso', converterNumero(event.target.value) ?? 1)}
                    />
                  </td>
                  <td>
                    <input
                      className="num"
                      inputMode="decimal"
                      value={produto.preco}
                      onChange={(event) => campoProduto(produto, 'preco', converterNumero(event.target.value) ?? 0)}
                    />
                  </td>
                  <td>
                    <input value={produto.prazo} onChange={(event) => campoProduto(produto, 'prazo', event.target.value)} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-label="Remover produto"
                      disabled={entrega.produtos.length <= 1}
                      onClick={() =>
                        dispatch({ tipo: 'removerProduto', entregaId: entrega.id, produtoId: produto.id })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="emissor-entrega-pe">
            <button
              type="button"
              className="btn ghost small"
              onClick={() => dispatch({ tipo: 'novoProduto', entregaId: entrega.id })}
            >
              + Produto
            </button>
            <span className="tabular">
              Peso {formatarNumero(pesoEntrega(entrega))} kg · Valor R$ {formatarMoeda(valorEntrega(entrega))}
            </span>
          </div>
        </>
      )}
    </article>
  );
}
```

- [ ] **Step 5: CSS da tela**

No fim de `src/styles.css`:

```css
.emissor-screen { display: flex; flex-direction: column; gap: 16px; padding: 20px 24px 48px; width: 100%; }
.emissor-cabecalho { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.emissor-cabecalho h1 { margin: 2px 0 0; font-size: 26px; }
.emissor-bloco h2 { margin: 0 0 12px; font-size: 17px; }
.emissor-grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.emissor-grade label, .emissor-observacao { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.emissor-grade input, .emissor-grade select, .emissor-observacao textarea { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: inherit; }
.emissor-observacao { margin-top: 12px; }
.emissor-entregas { display: flex; flex-direction: column; gap: 14px; }
.emissor-entrega-topo { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.emissor-entrega-acoes { display: flex; gap: 6px; flex-wrap: wrap; }
.emissor-tabela { width: 100%; border-collapse: collapse; margin-top: 12px; }
.emissor-tabela th, .emissor-tabela td { padding: 6px; border-bottom: 1px solid var(--border); text-align: left; font-size: 13px; }
.emissor-tabela select, .emissor-tabela input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; }
.emissor-tabela input.num { text-align: right; font-variant-numeric: tabular-nums; }
.emissor-entrega-pe { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.emissor-acoes { display: flex; gap: 8px; }
.tabular { font-variant-numeric: tabular-nums; }
```

A tela ainda não compila: `Clonagem`, `ResumoCarga` e `GerarPedido` nascem na Task 11, que termina com typecheck, build e um único commit das duas partes.

### Task 11: Tela nativa — resumo, crédito, clone, geração e corte do iframe

**Files:**
- Create: `src/screens/emissor/ResumoCarga.tsx`
- Create: `src/screens/emissor/PainelCredito.tsx`
- Create: `src/screens/emissor/Clonagem.tsx`
- Create: `src/screens/emissor/GerarPedido.tsx`
- Modify: `src/screens/EmissorPedidoScreen.tsx` (incluir `<PainelCredito />`)
- Modify: `src/App.tsx` (rota e remoção do iframe)
- Modify: `src/styles.css` (novas classes; remover `.content-emissor`/`.emissor-frame`)
- Create (temporário, não versionado): `harness-temp.mjs`

**Interfaces:**
- Consumes: `api.emissorCarteira`, `api.emissorClone`, `api.emitirPedido`; `resumoPedido`, `valorEntrega`, `ehEsc`; `pedidoDe`, `paraPayloadApi`; `entrar`, `syncNow`, `subscribeSync`, `syncSnapshot`.
- Produces: `<ResumoCarga estado />`, `<PainelCredito estado base />`, `<Clonagem estado dispatch base />`, `<GerarPedido estado onNovo />`.

- [ ] **Step 1: Resumo da carga**

`src/screens/emissor/ResumoCarga.tsx`:

```tsx
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
```

- [ ] **Step 2: Painel de crédito**

`src/screens/emissor/PainelCredito.tsx`:

```tsx
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
```

- [ ] **Step 3: Bloco de clonagem**

`src/screens/emissor/Clonagem.tsx`:

```tsx
import { useState } from 'react';
import type { Dispatch } from 'react';
import { api } from '../../api';
import type { Acao } from '../../emissor/estado';
import type { BaseEmissor } from '../../emissor/tipos';

interface Props {
  dispatch: Dispatch<Acao>;
  base: BaseEmissor;
}

export function Clonagem({ dispatch, base }: Props) {
  const [numero, setNumero] = useState('');
  const [tipo, setTipo] = useState<'CXS' | 'PÇS'>('CXS');
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);

  const buscar = async () => {
    const alvo = numero.trim();
    if (!alvo || buscando) return;
    setBuscando(true);
    setMensagem(null);
    try {
      const resultado = await api.emissorClone(alvo, tipo);
      if (resultado.encontrado && resultado.payload) {
        dispatch({ tipo: 'aplicarClone', payload: resultado.payload, base });
        setMensagem(
          `Clone de ${resultado.fonte === 'banco' ? 'banco' : 'rede'} aplicado — confira e ajuste o número.`,
        );
        setNumero('');
      } else if (resultado.outroTipo) {
        setMensagem(`Este pedido está em ${resultado.outroTipo}, não em ${tipo}.`);
      } else {
        setMensagem('Não encontrei clone para este número.');
      }
    } catch (cause) {
      setMensagem(cause instanceof Error ? cause.message : 'falha ao buscar o clone');
    } finally {
      setBuscando(false);
    }
  };

  return (
    <section className="card emissor-clonagem">
      <h2>Clonar pedido anterior</h2>
      <div className="emissor-grade">
        <label>
          <span>Nº do pedido</span>
          <input inputMode="numeric" value={numero} onChange={(event) => setNumero(event.target.value)} />
        </label>
        <label>
          <span>Tipo</span>
          <select value={tipo} onChange={(event) => setTipo(event.target.value === 'PÇS' ? 'PÇS' : 'CXS')}>
            <option value="CXS">CXS</option>
            <option value="PÇS">PÇS</option>
          </select>
        </label>
        <div className="emissor-clonagem-botao">
          <button type="button" className="btn ghost" onClick={() => void buscar()} disabled={!numero.trim() || buscando}>
            {buscando ? 'Buscando…' : 'Buscar clone'}
          </button>
        </div>
      </div>
      {mensagem && <p className="hint">{mensagem}</p>}
    </section>
  );
}
```

- [ ] **Step 4: Bloco de geração com gate de senha**

`src/screens/emissor/GerarPedido.tsx`:

```tsx
import { useState, useSyncExternalStore } from 'react';
import { api, type EmissaoResultado } from '../../api';
import { ehEsc } from '../../emissor/calculo';
import { paraPayloadApi, pedidoDe } from '../../emissor/estado';
import type { Estado } from '../../emissor/estado';
import { entrar, syncNow, syncSnapshot, subscribeSync } from '../../sync';

interface Props {
  estado: Estado;
  onNovo: () => void;
}

function problemasDoPedido(estado: Estado): string[] {
  const problemas: string[] = [];
  if (!/^\d{1,10}$/.test(estado.dados.numero.trim())) problemas.push('número do pedido inválido');
  if (!estado.dados.dataEmbarque || !estado.dados.dataEntrega) problemas.push('informe embarque e entrega');
  estado.entregas.forEach((entrega, indice) => {
    if (!entrega.cliente.trim()) problemas.push(`entrega ${indice + 1}: escolha o cliente`);
    const esc = ehEsc(entrega.cliente) || ehEsc(entrega.destino);
    if (esc && !(Number(entrega.pesoManual) > 0)) {
      problemas.push(`entrega ${indice + 1}: informe o peso manual`);
    }
    if (!esc) {
      if (entrega.produtos.every((p) => !p.codigo)) problemas.push(`entrega ${indice + 1}: escolha um produto`);
      if (entrega.produtos.some((p) => !(p.qtd >= 1))) problemas.push(`entrega ${indice + 1}: quantidade mínima 1`);
    }
  });
  return problemas;
}

export function GerarPedido({ estado, onNovo }: Props) {
  const sync = useSyncExternalStore(subscribeSync, syncSnapshot);
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<EmissaoResultado | null>(null);

  const liberar = async () => {
    if (!senha || busy) return;
    setBusy(true);
    setErro(null);
    try {
      await entrar(senha);
      await syncNow();
      setSenha('');
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui conferir a senha');
    } finally {
      setBusy(false);
    }
  };

  const gerar = async () => {
    const problemas = problemasDoPedido(estado);
    if (problemas.length > 0) {
      setErro(problemas.join(' · '));
      return;
    }
    setBusy(true);
    setErro(null);
    setResultado(null);
    try {
      const resposta = await api.emitirPedido(paraPayloadApi(pedidoDe(estado)));
      setResultado(resposta);
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui gerar o pedido');
    } finally {
      setBusy(false);
    }
  };

  if (sync.role !== 'administracao') {
    return (
      <section className="card emissor-gerar">
        <h2>Gerar pedido</h2>
        <p className="hint">A geração e a importação pedem a senha do escritório.</p>
        <form
          className="emissor-grade"
          onSubmit={(event) => {
            event.preventDefault();
            void liberar();
          }}
        >
          <label>
            <span>Senha do escritório</span>
            <input type="password" autoComplete="off" value={senha} onChange={(event) => setSenha(event.target.value)} />
          </label>
          <div className="emissor-clonagem-botao">
            <button type="submit" className="btn" disabled={!senha || busy}>
              {busy ? 'Confirmando…' : 'Entrar'}
            </button>
          </div>
        </form>
        {erro && <p className="alert">{erro}</p>}
      </section>
    );
  }

  return (
    <section className="card emissor-gerar">
      <h2>Gerar pedido</h2>
      {erro && <p className="alert">{erro}</p>}
      {resultado ? (
        <div className="emissor-resultado">
          <p>
            Pedido <strong>{estado.dados.numero}</strong> gerado. Baixe o PDF:{' '}
            <a href={resultado.download} target="_blank" rel="noreferrer">
              {resultado.arquivo}
            </a>
          </p>
          <p className="hint">
            {resultado.pedido.registradoNoHistorico
              ? 'Histórico atualizado — confira em Pedidos emitidos.'
              : 'Histórico não registrado (pedido sem PÇS nem CXS).'}{' '}
            Gravado em: {resultado.salvoEm.join(', ') || '—'}
          </p>
          {resultado.avisos.map((aviso) => (
            <p className="hint" key={aviso}>
              {aviso}
            </p>
          ))}
          <div className="emissor-acoes">
            <a className="btn ghost" href={resultado.download} target="_blank" rel="noreferrer">
              Abrir PDF
            </a>
            <button type="button" className="btn" onClick={onNovo}>
              Novo pedido
            </button>
          </div>
        </div>
      ) : (
        <div className="emissor-acoes">
          <button type="button" className="btn" onClick={() => void gerar()} disabled={busy}>
            {busy ? 'Gerando…' : 'Gerar pedido e PDF'}
          </button>
          <span className="hint">O servidor recalcula peso, valor e veículo antes de gravar.</span>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Incluir o painel de crédito na tela**

Em `src/screens/EmissorPedidoScreen.tsx`, importar `PainelCredito` e renderizar, depois do bloco de entregas e antes de `<GerarPedido …>`:

```tsx
      <div className="emissor-lateral">
        <PainelCredito estado={estado} base={base} />
      </div>
```

- [ ] **Step 6: Ligações no App e remoção do iframe**

Em `src/App.tsx`:

1. Importar a tela junto das outras telas:

```tsx
import { EmissorPedidoScreen } from './screens/EmissorPedidoScreen';
```

2. Trocar o `main` e o iframe (bloco atual começa em `<main className={rota === 'novo-pedido' …`):

```tsx
        <main className="content">
```

3. Onde hoje está:

```tsx
          <iframe
            className="emissor-frame"
            src="http://localhost:8501/?embedded=true"
            title="Emissor de pedidos HAJAN"
            hidden={rota !== 'novo-pedido'}
          />
```

passa a ser:

```tsx
          {rota === 'novo-pedido' && <EmissorPedidoScreen />}
```

4. Em `src/styles.css`, remover as três linhas:

```css
.content-emissor { display: flex; width: 100%; max-width: none; min-height: 0; padding: 0; }
.emissor-frame { display: block; width: 100%; min-height: calc(100vh - 64px); flex: 1; border: 0; background: var(--surface); }
.emissor-frame[hidden] { display: none; }
```

5. Conferir que nenhum outro ponto do app cita a porta 8501:

```bash
grep -rn "8501" src server vite.config.ts || echo "sem referências"
```

- [ ] **Step 7: Completar o CSS da tela**

Acrescentar ao fim de `src/styles.css`:

```css
.emissor-resumo { display: flex; gap: 22px; flex-wrap: wrap; }
.emissor-resumo span { display: flex; flex-direction: column; gap: 2px; }
.emissor-resumo small { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.emissor-resumo strong { font-size: 17px; }
.emissor-lateral { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.emissor-credito ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.credito-linha { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); flex-wrap: wrap; }
.credito-linha.erro { border-color: #b3261e; background: color-mix(in srgb, #b3261e 8%, transparent); }
.credito-linha.aviso { border-color: #a8730b; background: color-mix(in srgb, #a8730b 8%, transparent); }
.credito-linha div { display: flex; flex-direction: column; gap: 2px; }
.credito-linha small { color: var(--muted); font-variant-numeric: tabular-nums; }
.credito-msg { font-size: 12px; }
.credito-msg.erro { color: #b3261e; }
.credito-msg.aviso { color: #a8730b; }
.emissor-clonagem-botao { display: flex; align-items: flex-end; }
.emissor-gerar .emissor-acoes { align-items: center; }
.emissor-resultado { display: flex; flex-direction: column; gap: 8px; }
```

- [ ] **Step 8: Typecheck e build**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/typescript/bin/tsc --noEmit
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/vite/bin/vite.js build
```

Esperado: sem erros de tipo e `dist/` gerado.

- [ ] **Step 9: Harness temporário (não versionado)**

Criar `harness-temp.mjs` na raiz (não commitar). Se já existir um harness da verificação da Fase 1 (aponta para o banco real), substituir o conteúdo pelo abaixo:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajan-harness-'));
const db = path.join(dir, 'hajan.db');
fs.copyFileSync(path.resolve('data', 'hajan.db'), db);
const pdfs = path.join(dir, 'pdfs');
const clones = path.join(dir, 'clones');
const carteira = path.join(dir, 'carteira');
for (const pasta of [pdfs, clones, carteira]) fs.mkdirSync(pasta, { recursive: true });
process.env.FRIBOI_DB = db;
process.env.FRIBOI_PDF_DIRS = pdfs;
process.env.FRIBOI_CLONES_DIR = clones;
process.env.FRIBOI_CARTEIRA_DIR = carteira;
process.env.FRIBOI_CREDITO_JSON = path.join(carteira, 'media_compras.json');

const { router: emissor } = await import('./server/emissor.js');
const { router: pedidos } = await import('./server/emissorPedidos.js');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/api/emissor', emissor);
app.use('/api/emissor', pedidos);
// sessão simulada: só no harness, para a tela liberar a geração sem senha real
app.get('/api/sessao', (req, res) =>
  res.json({ role: 'administracao', senhaDefinida: true, revision: 0 }),
);
app.use(express.static('dist'));
app.get(/.*/, (req, res) => res.sendFile(path.resolve('dist', 'index.html')));
app.listen(8791, '127.0.0.1', () => console.log(`harness: http://127.0.0.1:8791 · banco ${db} · pdfs ${pdfs}`));
```

- [ ] **Step 10: Verificar no navegador**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" harness-temp.mjs
```

Em outra janela, abrir `http://127.0.0.1:8791` com viewport de 1440 px e conferir:

1. Logística → Novo pedido abre a tela nativa (sem iframe, sem porta 8501).
2. Dados gerais vêm preenchidos; o resumo no cabeçalho acompanha peso/valor/veículo.
3. Trocar o cliente e a operação atualiza o cartão; entrega ESC mostra peso manual.
4. Adicionar/duplicar/mover/excluir entregas funciona; "Limite por cliente" lista o grupo.
5. Gerar: no harness a sessão é simulada como administração, então o botão "Gerar pedido e PDF" aparece direto; no app real ele pede a senha.
6. Gerar um pedido de teste, abrir o PDF e conferir o layout; o banco temporário mostra a linha nova em `emissor_pedidos_semana` (o caminho aparece no console do harness).

- [ ] **Step 11: Encerrar o harness**

Parar o processo e apagar `harness-temp.mjs` (não versionado).

- [ ] **Step 12: Commit**

```bash
git add src/screens/EmissorPedidoScreen.tsx src/screens/emissor src/api.ts src/App.tsx src/styles.css src/emissor/estado.ts
git commit -m "feat: tela nativa de digitacao de pedidos no lugar do iframe"
```

### Task 12: Importação de planilhas (API)

**Files:**
- Modify: `server/config.js` (acrescentar `BACKUP_DIR`)
- Modify: `tests/helpers.ts` (montar o router de importação; env do backup)
- Create: `server/emissorImportar.js`
- Test: `tests/importar.test.ts`

**Interfaces:**
- Consumes: `gravar` (Task 1), `BACKUP_DIR` (config).
- Produces: `POST /api/emissor/importar` (multipart) → `{ backup: string, contagens: { clientes, produtos, limites, unidades } }`; erro 400 com `error` apontando arquivo/coluna.

- [ ] **Step 1: Pasta de backup configurável**

Em `server/config.js`, depois de `ANEXO_MAX_BYTES`:

```js
/** Snapshots do banco antes de cada importação (mantém os 10 mais recentes). */
export const BACKUP_DIR = process.env.FRIBOI_BACKUP_DIR ?? path.join(ROOT, 'data', 'backups');
```

Em `tests/helpers.ts`, junto dos outros `process.env`:

```ts
  process.env.FRIBOI_BACKUP_DIR = path.join(dir, 'backups');
```

E na montagem, depois do router de pedidos:

```ts
  const { router: emissorImportar } = await import('../server/emissorImportar.js');
  app.use('/api/emissor', emissorImportar);
```

- [ ] **Step 2: Escrever o teste que falha**

`tests/importar.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import XLSX from 'xlsx';
import { montarApi } from './helpers.ts';

const api = await montarApi();
after(() => api.fechar());

const livro = (aba: string, linhas: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), aba);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const arquivo = (nome: string, bytes: Buffer) =>
  new File([new Uint8Array(bytes)], nome, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

const clientes = () =>
  arquivo(
    'clientes.xlsx',
    livro('Infos Clientes', [
      [
        'CÓDIGO',
        'RAZÃO SOCIAL PEDIDO + CÓDIGO',
        'CNPJ',
        'PRAZO',
        'CIDADE',
        'UF',
        'OBS CLIENTES PED+',
        'CÓDIGO CENTRALIZADOR',
        'Status do Cliente',
      ],
      ['501', 'CLIENTE IMPORTADO 501', '11.111.111/0001-11', '28', 'Natal', 'RN', '', '501', 'Liberado'],
      ['501', 'CLIENTE IMPORTADO 501', '11.111.111/0001-11', '35', 'Natal', 'RN', '', '501', 'Liberado'],
    ]),
  );

const produtos = () =>
  arquivo(
    'produtos.xlsx',
    livro('Infos Produtos', [
      [
        'Código',
        'Produto Frigorífico',
        'Produto Pedido',
        'Unidade',
        'Peso',
        'Produto Frigorífico (Completo)',
        'Estado Físico (Grupo)',
        'F/S/A',
        'Linha (Marca)',
        'Categoria (Divisão)',
      ],
      ['TSTP1', 'PATINHO IMPORTADO', 'PATINHO', 'CX', '15,5', 'PATINHO COMPLETO', 'RESFRIADO', 'A', 'HAJAN', 'CXS'],
    ]),
  );

const limites = () =>
  arquivo(
    'limites.xlsx',
    livro('Limites', [
      ['Centralizador', 'Nome', 'Limite', 'Disponível'],
      ['501', 'CLIENTE IMPORTADO 501', 90000, 85000],
    ]),
  );

const unidades = () =>
  arquivo(
    'unidades.xlsx',
    livro('SiglasUnidades', [
      ['SIGLA', 'NOME', 'CRITICA'],
      ['zzz', 'UNIDADE IMPORTADA', 'não'],
    ]),
  );

test('importa as quatro planilhas e faz backup', async () => {
  const resposta = await api.postArquivos('/api/emissor/importar', {
    clientes: clientes(),
    produtos: produtos(),
    limites: limites(),
    unidades: unidades(),
  });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.deepEqual(corpo.contagens, { clientes: 1, produtos: 1, limites: 1, unidades: 1 });
  assert.ok(fs.existsSync(corpo.backup), 'backup não foi criado');

  const db = new DatabaseSync(api.db, { readOnly: true });
  const cliente = db.prepare('SELECT * FROM emissor_clientes WHERE codigo = ?').get('501') as any;
  const produto = db.prepare('SELECT * FROM emissor_produtos WHERE codigo = ?').get('TSTP1') as any;
  const unidade = db.prepare('SELECT * FROM emissor_unidades_carregamento WHERE sigla = ?').get('ZZZ') as any;
  const total = db.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c;
  db.close();

  assert.equal(cliente.prazo_padrao, '35', 'dedupe deve manter a última linha');
  assert.equal(produto.peso, 15.5);
  assert.equal(unidade.nome, 'UNIDADE IMPORTADA');
  assert.equal(unidade.critica, 'NÃO');
  assert.equal(total, 1, 'importação substitui a base de clientes');
});

test('cabeçalho errado rejeita sem alterar a base', async () => {
  const antes = new DatabaseSync(api.db, { readOnly: true });
  const totalAntes = antes.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c;
  antes.close();

  const ruim = arquivo('clientes.xlsx', livro('Infos Clientes', [['CODIGO'], ['999']]));
  const resposta = await api.postArquivos('/api/emissor/importar', { clientes: ruim });
  assert.equal(resposta.status, 400);
  const corpo = await resposta.json();
  assert.match(corpo.error, /clientes/);

  const depois = new DatabaseSync(api.db, { readOnly: true });
  assert.equal(depois.prepare('SELECT COUNT(*) c FROM emissor_clientes').get().c, totalAntes);
  depois.close();
});

test('arquivo que não é xlsx é recusado', async () => {
  const resposta = await api.postArquivos('/api/emissor/importar', {
    clientes: new File([new TextEncoder().encode('nada')], 'clientes.xlsx'),
  });
  assert.equal(resposta.status, 400);
});
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/importar.test.ts
```

Esperado: erro de módulo inexistente (`server/emissorImportar.js`).

- [ ] **Step 4: Implementar o importador**

`server/emissorImportar.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import XLSX from 'xlsx';
import { BACKUP_DIR } from './config.js';
import { gravar } from './emissorBanco.js';

export const router = express.Router();
const LIMITE = 4 * 25 * 1024 * 1024;

const erro400 = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

const chave = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const texto = (valor) => String(valor ?? '').trim();

function numero(valor, padrao = 0) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : padrao;
  const limpo = String(valor ?? '').trim();
  if (!limpo) return padrao;
  const normalizado = limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo.replace(/\.(?=\d{3}\b)/g, '');
  const achado = Number(normalizado);
  return Number.isFinite(achado) ? achado : padrao;
}

const COLUNAS = {
  clientes: {
    aba: 'Infos Clientes',
    campos: {
      codigo: ['CODIGO'],
      nome_formatado: ['RAZAO SOCIAL PEDIDO + CODIGO'],
      cnpj: ['CNPJ'],
      prazo_padrao: ['PRAZO'],
      cidade: ['CIDADE'],
      uf: ['UF'],
      observacao: ['OBS CLIENTES PED+'],
      codigo_centralizador: ['CODIGO CENTRALIZADOR', 'CENTRA-LIZADOR'],
      status_cliente: ['STATUS DO CLIENTE', 'STATUS'],
    },
    obrigatorias: [
      'codigo',
      'nome_formatado',
      'cnpj',
      'prazo_padrao',
      'cidade',
      'uf',
      'observacao',
      'codigo_centralizador',
    ],
  },
  produtos: {
    aba: 'Infos Produtos',
    campos: {
      codigo: ['CODIGO', 'CÓDIGO'],
      descricao: ['PRODUTO FRIGORIFICO'],
      produto_pedido: ['PRODUTO PEDIDO'],
      unidade: ['UNIDADE'],
      peso: ['PESO'],
      descricao_completa: ['PRODUTO FRIGORIFICO (COMPLETO)'],
      estado_fisico: ['ESTADO FISICO (GRUPO)'],
      f_s_a: ['F/S/A'],
      linha_marca: ['LINHA (MARCA)'],
      categoria: ['CATEGORIA (DIVISAO)'],
    },
    obrigatorias: [
      'codigo',
      'descricao',
      'produto_pedido',
      'unidade',
      'peso',
      'descricao_completa',
      'estado_fisico',
      'f_s_a',
      'linha_marca',
      'categoria',
    ],
  },
  limites: {
    aba: null,
    campos: {
      codigo_centralizador: ['CODIGO', 'CODIGO CENTRALIZADOR'],
      centralizador: ['NOME', 'CENTRALIZADOR'],
      limite: ['LIMITE'],
      disponivel: ['SALDO DE CREDITO', 'DISPONIVEL'],
    },
    obrigatorias: ['codigo_centralizador', 'centralizador', 'limite', 'disponivel'],
  },
  unidades: {
    aba: 'SiglasUnidades',
    campos: { sigla: ['SIGLA'], nome: ['NOME'], critica: ['CRITICA'] },
    obrigatorias: ['sigla', 'nome', 'critica'],
  },
};

function linhasDaAba(buffer, config, tipo) {
  const livro = XLSX.read(buffer, { type: 'buffer' });
  const aba = config.aba ?? livro.SheetNames[0];
  const planilha = livro.Sheets[aba];
  if (!planilha) throw erro400(`${tipo}: aba "${aba}" não encontrada`);
  const linhas = XLSX.utils.sheet_to_json(planilha, { header: 1, raw: true, defval: '' });

  const mapear = (linha) => {
    const celulas = linha.map(chave);
    const indice = {};
    for (const [campo, aliases] of Object.entries(config.campos)) {
      indice[campo] = aliases.map((alias) => celulas.indexOf(chave(alias))).find((i) => i >= 0) ?? -1;
    }
    return indice;
  };

  const inicio = linhas.findIndex((linha) => {
    const indice = mapear(linha);
    return config.obrigatorias.every((campo) => indice[campo] >= 0);
  });
  if (inicio < 0 || inicio > 5) {
    const indiceZero = mapear(linhas[0] ?? []);
    const faltando = config.obrigatorias
      .filter((campo) => indiceZero[campo] < 0)
      .map((campo) => config.campos[campo][0]);
    throw erro400(`${tipo}: cabeçalho sem ${faltando.join(', ') || 'as colunas esperadas'}`);
  }

  const indice = mapear(linhas[inicio]);
  return linhas
    .slice(inicio + 1)
    .map((linha) => {
      const registro = {};
      for (const [campo, posicao] of Object.entries(indice)) {
        registro[campo] = posicao >= 0 ? linha[posicao] : '';
      }
      return registro;
    });
}

function lerClientes(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.clientes, 'clientes')) {
    const codigo = texto(linha.codigo);
    if (!codigo) continue;
    const registro = {
      codigo,
      nome_formatado: texto(linha.nome_formatado),
      cnpj: texto(linha.cnpj),
      prazo_padrao: texto(linha.prazo_padrao),
      cidade: texto(linha.cidade),
      uf: texto(linha.uf).toUpperCase(),
      observacao: texto(linha.observacao),
      codigo_centralizador: texto(linha.codigo_centralizador),
      status_cliente: texto(linha.status_cliente),
    };
    if (!registro.nome_formatado) continue;
    mapa.set(codigo === '0' ? `0|${chave(registro.nome_formatado)}` : codigo, registro);
  }
  return [...mapa.values()];
}

function lerProdutos(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.produtos, 'produtos')) {
    const codigo = texto(linha.codigo);
    const descricao = texto(linha.descricao);
    if (!codigo || !descricao) continue;
    const peso = numero(linha.peso, 1);
    mapa.set(`${codigo}|${chave(descricao)}`, {
      codigo,
      descricao,
      produto_pedido: texto(linha.produto_pedido),
      unidade: texto(linha.unidade) || 'kg',
      peso: peso > 0 ? peso : 1,
      descricao_completa: texto(linha.descricao_completa),
      estado_fisico: texto(linha.estado_fisico),
      f_s_a: texto(linha.f_s_a),
      linha_marca: texto(linha.linha_marca),
      categoria: texto(linha.categoria),
    });
  }
  return [...mapa.values()];
}

function lerLimites(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.limites, 'limites')) {
    const codigo = texto(linha.codigo_centralizador);
    if (!codigo) continue;
    mapa.set(codigo, {
      codigo_centralizador: codigo,
      centralizador: texto(linha.centralizador),
      limite: numero(linha.limite, 0),
      disponivel: numero(linha.disponivel, 0),
    });
  }
  return [...mapa.values()];
}

function lerUnidades(buffer) {
  const mapa = new Map();
  for (const linha of linhasDaAba(buffer, COLUNAS.unidades, 'unidades')) {
    const sigla = texto(linha.sigla).toUpperCase();
    const nome = texto(linha.nome);
    if (!sigla || !nome) continue;
    mapa.set(sigla, { sigla, nome, critica: texto(linha.critica).toUpperCase() });
  }
  return [...mapa.values()];
}

const TABELAS = {
  clientes: {
    limpar: 'DELETE FROM emissor_clientes',
    inserir: `INSERT INTO emissor_clientes
      (codigo, nome_formatado, cnpj, prazo_padrao, cidade, uf, observacao, codigo_centralizador, status_cliente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valores: (r) => [r.codigo, r.nome_formatado, r.cnpj, r.prazo_padrao, r.cidade, r.uf, r.observacao, r.codigo_centralizador, r.status_cliente],
    ler: lerClientes,
  },
  produtos: {
    limpar: 'DELETE FROM emissor_produtos',
    inserir: `INSERT INTO emissor_produtos
      (codigo, descricao, produto_pedido, unidade, peso, descricao_completa, estado_fisico, f_s_a, linha_marca, categoria)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valores: (r) => [r.codigo, r.descricao, r.produto_pedido, r.unidade, r.peso, r.descricao_completa, r.estado_fisico, r.f_s_a, r.linha_marca, r.categoria],
    ler: lerProdutos,
  },
  limites: {
    limpar: 'DELETE FROM emissor_limites_clientes',
    inserir: `INSERT INTO emissor_limites_clientes
      (codigo_centralizador, centralizador, limite, disponivel) VALUES (?, ?, ?, ?)`,
    valores: (r) => [r.codigo_centralizador, r.centralizador, r.limite, r.disponivel],
    ler: lerLimites,
  },
  unidades: {
    limpar: 'DELETE FROM emissor_unidades_carregamento',
    inserir: `INSERT INTO emissor_unidades_carregamento (sigla, nome, critica) VALUES (?, ?, ?)`,
    valores: (r) => [r.sigla, r.nome, r.critica],
    ler: lerUnidades,
  },
};

function backupDoBanco(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(BACKUP_DIR, `hajan-${carimbo}.db`);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const antigos = fs
    .readdirSync(BACKUP_DIR)
    .filter((nome) => /^hajan-.*\.db$/.test(nome))
    .sort()
    .reverse();
  for (const nome of antigos.slice(10)) fs.unlinkSync(path.join(BACKUP_DIR, nome));
  return destino;
}

router.post('/importar', express.raw({ type: 'multipart/form-data', limit: LIMITE }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw erro400('envie as planilhas no corpo multipart/form-data');
    }
    const formulario = await new Request('http://local/importar', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body: req.body,
    }).formData();

    const planilhas = {};
    for (const tipo of Object.keys(TABELAS)) {
      const arquivo = formulario.get(tipo);
      if (!arquivo || typeof arquivo === 'string') continue;
      if (!/\.xlsx$/i.test(arquivo.name)) throw erro400(`${tipo}: envie um arquivo .xlsx`);
      if (arquivo.size > 25 * 1024 * 1024) throw erro400(`${tipo}: arquivo acima de 25 MB`);
      const bytes = Buffer.from(await arquivo.arrayBuffer());
      if (bytes.subarray(0, 2).toString() !== 'PK') throw erro400(`${tipo}: arquivo não é uma planilha xlsx válida`);
      let registros;
      try {
        registros = TABELAS[tipo].ler(bytes);
      } catch (erro) {
        if (erro.status === 400) throw erro;
        throw erro400(`${tipo}: não consegui ler a planilha (${erro.message})`);
      }
      if (registros.length === 0) throw erro400(`${tipo}: nenhuma linha válida na planilha`);
      planilhas[tipo] = registros;
    }

    if (Object.keys(planilhas).length === 0) throw erro400('envie pelo menos uma planilha');

    const db = gravar();
    const backup = backupDoBanco(db);
    const contagens = { clientes: 0, produtos: 0, limites: 0, unidades: 0 };

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [tipo, registros] of Object.entries(planilhas)) {
        const config = TABELAS[tipo];
        db.exec(config.limpar);
        const inserir = db.prepare(config.inserir);
        for (const registro of registros) inserir.run(...config.valores(registro));
        contagens[tipo] = registros.length;
      }
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    }

    res.json({ backup, contagens });
  } catch (erro) {
    if (erro.status === 400) return res.status(400).json({ error: erro.message });
    const mensagem = String(erro?.message ?? erro);
    if (/no such table|unable to open|no such file/.test(mensagem)) {
      return res.status(503).json({ error: 'banco de dados do emissor indisponível no servidor' });
    }
    console.error('falha na importação:', erro);
    res.status(500).json({ error: `não consegui importar: ${mensagem}` });
  }
});
```

- [ ] **Step 5: Rodar e ver passar**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/importar.test.ts
```

Esperado: `# pass 3`.

- [ ] **Step 6: Suíte completa**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/*.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add server/config.js server/emissorImportar.js tests/helpers.ts tests/importar.test.ts
git commit -m "feat: importacao transacional das planilhas da base"
```

### Task 13: Tela de importação, menu, verificação final e changelog

**Files:**
- Create: `src/screens/ImportarPlanilhasScreen.tsx`
- Modify: `src/App.tsx` (rota `importar-planilhas`)
- Create (temporário, não versionado): `harness-temp.mjs` (recriado com o router de importação)
- Create: `ATUALIZACOES.md`

**Interfaces:**
- Consumes: `api.importarPlanilhas`, `ImportacaoResultado`.
- Produces: rota `importar-planilhas` no menu "Digitação de pedidos".

- [ ] **Step 1: Criar a tela**

`src/screens/ImportarPlanilhasScreen.tsx`:

```tsx
import { useState } from 'react';
import { api, type ImportacaoResultado } from '../api';

type Tipo = 'clientes' | 'produtos' | 'limites' | 'unidades';

const ROTULOS: Record<Tipo, string> = {
  clientes: 'Clientes — aba Infos Clientes',
  produtos: 'Produtos — aba Infos Produtos',
  limites: 'Limites — 1ª aba',
  unidades: 'Unidades — aba SiglasUnidades',
};

export function ImportarPlanilhasScreen() {
  const [arquivos, setArquivos] = useState<Partial<Record<Tipo, File>>>({});
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ImportacaoResultado | null>(null);

  const escolher = (tipo: Tipo, arquivo: File | undefined) => {
    setArquivos((atual) => {
      const proximo = { ...atual };
      if (arquivo) proximo[tipo] = arquivo;
      else delete proximo[tipo];
      return proximo;
    });
  };

  const enviar = async () => {
    if (busy) return;
    if (Object.keys(arquivos).length === 0) {
      setErro('escolha pelo menos uma planilha');
      return;
    }
    setBusy(true);
    setErro(null);
    setResultado(null);
    try {
      setResultado(await api.importarPlanilhas(arquivos));
      setArquivos({});
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : 'não consegui importar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="emissor-screen">
      <header className="emissor-cabecalho">
        <div>
          <span className="eyebrow">Digitação de pedidos</span>
          <h1>Importar planilhas</h1>
        </div>
      </header>

      <section className="card">
        <p className="hint">
          A importação substitui a base do tipo enviado. Antes de gravar, o servidor cria um backup em{' '}
          <code>data/backups</code> e mantém os 10 mais recentes. Se qualquer planilha estiver inválida, nada
          é alterado.
        </p>
        <div className="emissor-grade">
          {(Object.keys(ROTULOS) as Tipo[]).map((tipo) => (
            <label key={tipo}>
              <span>{ROTULOS[tipo]}</span>
              <input
                type="file"
                accept=".xlsx"
                onChange={(event) => escolher(tipo, event.target.files?.[0])}
              />
            </label>
          ))}
        </div>
        <div className="emissor-acoes" style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => void enviar()} disabled={busy}>
            {busy ? 'Importando…' : 'Importar'}
          </button>
        </div>
        {erro && <p className="alert">{erro}</p>}
        {resultado && (
          <div className="emissor-resultado">
            <p>
              Importado:{' '}
              {Object.entries(resultado.contagens)
                .filter(([, total]) => total > 0)
                .map(([tipo, total]) => `${total} ${tipo}`)
                .join(' · ')}
            </p>
            <p className="hint">
              Backup: <code>{resultado.backup}</code>
            </p>
          </div>
        )}
      </section>
    </section>
  );
}
```

- [ ] **Step 2: Rota e menu**

Em `src/App.tsx`:

1. União de rotas: acrescentar `| 'importar-planilhas'` depois de `| 'novo-pedido'`.
2. No `MENU`, depois de `{ rota: 'novo-pedido', label: 'Novo pedido' },`:

```tsx
      { rota: 'importar-planilhas', label: 'Importar planilhas' },
```

3. Importar a tela junto das outras:

```tsx
import { ImportarPlanilhasScreen } from './screens/ImportarPlanilhasScreen';
```

4. No conteúdo do `main`, depois da linha da tela de novo pedido:

```tsx
          {rota === 'importar-planilhas' && <ImportarPlanilhasScreen />}
```

- [ ] **Step 3: Recriar o harness com a importação**

O harness foi apagado no fim do Task 11. Recriar o mesmo arquivo (banco temporário, `FRIBOI_*` apontando para pastas temporárias) e acrescentar o router de importação depois do de pedidos:

```js
const { router: importar } = await import('./server/emissorImportar.js');
app.use('/api/emissor', importar);
```

- [ ] **Step 4: Testes, tipos e build**

```bash
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" --test tests/*.test.ts
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/typescript/bin/tsc --noEmit
ELECTRON_RUN_AS_NODE=1 "/c/Users/Trabalho/AppData/Local/Programs/Qoder/Qoder.exe" node_modules/vite/bin/vite.js build
```

Esperado: suíte inteira verde, sem erros de tipo, build concluído.

- [ ] **Step 5: Verificação no navegador (harness, banco temporário)**

Subir `harness-temp.mjs` e abrir `http://127.0.0.1:8791` em 1440 px:

1. Menu mostra "Novo pedido" e "Importar planilhas" em Digitação de pedidos.
2. Importação: enviar uma planilha inválida (um `.xlsx` qualquer sem cabeçalho) → erro 400 com o nome do tipo e nenhuma alteração na base.
3. Importação válida: gerar em `/tmp` as planilhas do teste `tests/importar.test.ts` (mesmo conteúdo) e enviar as quatro → contagens e caminho do backup aparecem.
4. Novo pedido: gerar um pedido de teste, baixar o PDF, conferir o layout e a linha nova no histórico (via `sqlite` no banco temporário).
5. Nenhuma tela abre `localhost:8501`.

- [ ] **Step 6: Changelog**

O app React ainda não tem changelog. Criar `ATUALIZACOES.md` na raiz do repositório, usando o mesmo formato do `HAJAN-Emissor-Local - V6/ATUALIZACOES.md` (título com data e lista de bullets), com a entrada da Fase 2 no topo:

```markdown
## 2026-11-27 — Digitação de pedidos nativa (Fase 2)

- A tela "Novo pedido" agora é nativa no app, sem o iframe do Streamlit.
- Geração de pedido com PDF no servidor, histórico em "Pedidos emitidos", clonagem pelo banco ou pelo JSON da rede e painel de limite por cliente.
- Nova tela "Importar planilhas" (clientes, produtos, limites e unidades) com backup automático do banco antes de gravar.
```

- [ ] **Step 7: Limpeza**

Parar o harness e apagar `harness-temp.mjs`. Rodar `git status` e confirmar que não há `data/*.db`, PDFs, backups ou `senha-admin.txt` entre os arquivos modificados.

- [ ] **Step 8: Commit**

```bash
git add src/screens/ImportarPlanilhasScreen.tsx src/App.tsx ATUALIZACOES.md
git commit -m "feat: importacao de planilhas da base e menu da digitacao"
```

- [ ] **Step 9: Aceite com o usuário**

Pedir ao usuário um pedido real: gerar pela tela nova, abrir o PDF e comparar lado a lado com o PDF do Streamlit. Confirmar também que "Pedidos emitidos" mostra a linha recém-gerada e que o clone do mesmo número volta preenchido.

## Autoverificação do plano

- [x] **Cobertura da spec**: base/carteira (Task 4), clone (Task 5), regras (Task 7), PDF (Task 8), escrita/histórico/clone/download (Task 9), cálculo e reducer no cliente (Tasks 2, 3, 6), tela e remoção do iframe (Tasks 10, 11), importação (Tasks 12, 13), erros/estados no formulário (Tasks 10, 11), aceite e changelog (Task 13).
- [x] **Paridade da carteira com o `app.py`**: lê todas as planilhas do grupo com a data mais recente no nome (meses por extenso como `26nov2026`, e datas numéricas), consolida o maior valor com nome/status da linha de maior limite e lê a média no formato `{"clientes":[{"codigos":[…]}]}` de `credito/decisao_credito.json`.
- [x] **Sem placeholders**: todos os passos têm código, comandos e resultados esperados.
- [x] **Consistência de tipos**: `BaseEmissor` inclui `proximoNumero` e `destinos` (aditivos ao contrato); `Estado.base` é usado por `novaEntrega`/`novoProduto`; `Acao` cobre todas as ações usadas pelos componentes; `Carteira`/`EmissaoResultado`/`ImportacaoResultado` batem com as respostas do servidor.
- [x] **Adições ao contrato da spec (registradas)**: `proximoNumero` e `destinos` em `/base` (necessários ao formulário); `BACKUP_DIR` configurável por `FRIBOI_BACKUP_DIR` (testes sem tocar `data/backups`).

