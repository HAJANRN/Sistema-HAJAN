# Digitação de pedidos nativa — Fase 2

Data: 2026-11-27
Status: aprovado para planejamento
Contexto: unificação do Emissor (Streamlit) com o Acompanhamento (React). A Fase 1 já entregou o banco unificado (`data/hajan.db` com tabelas `emissor_*`), a API de leitura `/api/emissor` e o shell com menu lateral.

## Objetivo

Portar a digitação de pedidos do Streamlit para telas nativas em React, removendo o iframe da rota "Novo pedido", com paridade operacional: formulário completo, cálculo, carteira de crédito, clonagem, PDF no servidor Node e histórico. A importação de planilhas da base (clientes, produtos, limites, unidades) também entra neste corte. Clonagem por reconstrução do PDF fica de fora.

## Fora do escopo

- Reconstrução de clone lendo o PDF (o banco e o índice JSON cobrem o caso real).
- Alterar o aplicativo Streamlit em si; ele permanece no repositório como referência, sem ponto de entrada no app web.
- Financeiro real (contas a pagar) e outras fases do roadmap.
- Migração de usuários: a autenticação continua a do Acompanhamento (cookie HttpOnly assinado, papel operação/administração).

## Arquitetura

Fluxo: tela React → `GET /api/emissor/base`, `GET /api/emissor/carteira`, `GET /api/emissor/clones/:numero` → `POST /api/emissor/pedidos` → servidor grava histórico, clone e PDF → resposta com link de download.

Novos módulos do servidor:

| Módulo | Responsabilidade |
|---|---|
| `server/emissorPedidos.js` | Rotas de base, carteira, clone, criação de pedido, download do PDF. |
| `server/emissorPdf.js` | Geração do PDF com `pdfkit` no layout atual. |
| `server/emissorCarteira.js` | Leitura do XLSX da carteira e do JSON de média de compras, com cache de 60 s. |
| `server/emissorImportar.js` | Validação e importação transacional das 4 planilhas. |
| `server/config.js` | Novas variáveis: `FRIBOI_CARTEIRA_DIR`, `FRIBOI_CLONES_DIR`, `FRIBOI_CREDITO_JSON`. Reutiliza `PDF_DIRS`. |

Novos módulos do cliente:

| Arquivo | Responsabilidade |
|---|---|
| `src/screens/EmissorPedidoScreen.tsx` | Tela "Novo pedido". |
| `src/screens/emissor/` | Componentes: dados gerais, cartão de entrega, linha de produto, painel de crédito, resumo, bloco de clonagem e de geração. |
| `src/emissor/calculo.ts` | Cálculos puros (peso, valor, veículo, categorias, NFs de remessa). |
| `src/emissor/formato.ts` | Parsing/formatação pt-BR de números e datas. |
| `src/emissor/estado.ts` | Reducer do formulário e canonicalização de seleções coladas. |

Escrita exige sessão administrativa (mesmo gate da Importação). Leitura da base exige sessão ativa.

## Contratos de API

### `GET /api/emissor/base`

```json
{
  "revision": "2026-11-27T12:00:00",
  "clientes": [{ "codigo": "…", "nome": "…", "cnpj": "…", "cidade": "…", "uf": "RN",
                 "prazo": "…", "codigoCentralizador": "…", "centralizador": "…",
                 "statusCliente": "…", "limite": 0, "disponivel": 0 }],
  "produtos": [{ "codigo": "…", "descricao": "…", "rotulo": "…", "unidade": "…",
                 "peso": 1.0, "categoria": "…" }],
  "unidades": [{ "sigla": "…", "nome": "…", "rotulo": "…", "critica": "…" }]
}
```

Clientes usam o mesmo join de `limites_clientes` do Streamlit: `COALESCE(NULLIF(TRIM(codigo_centralizador),''), codigo) = limites_clientes.codigo_centralizador`.

### `GET /api/emissor/carteira`

```json
{
  "disponivel": true,
  "data": "dd/mm/yyyy",
  "registros": { "<codigo>": { "nome": "…", "limite": 0, "saldoFinanceiro": 0,
                                "saldoCarteira": 0, "saldoCredito": 0, "status": "…" } },
  "media": { "<codigo>": { "mediaMensal6m": 0, "mediaSemana": 0, "statusCompra": "…" } }
}
```

Sem arquivos na pasta: `{ "disponivel": false }`. Cache de 60 s por assinatura `(nome, mtime, tamanho)`.

### `GET /api/emissor/clones/:numero?tipo=CXS|PÇS`

```json
{ "encontrado": true, "fonte": "banco|rede", "payload": { … } }
```

Não encontrado: `{ "encontrado": false, "outroTipo": "PÇS" }` quando existir no outro tipo. Payload idêntico ao JSON de clonagem atual: `numero, atencao, local, unidade, observacao, data_pedido, data_embarque, data_entrega, entregas[{ cliente, destino, operacao, peso_manual?, produtos[{ codigo, descricao, qtd, unidade, peso, preco, prazo }] }]`.

### `POST /api/emissor/pedidos`

Corpo:

```json
{
  "numero": "3834", "atencao": "…", "local": "Natal", "unidade": "MRB - …",
  "observacao": "…",
  "dataEmissao": "2026-11-27", "dataEmbarque": "2026-11-27", "dataEntrega": "2026-12-01",
  "entregas": [{
    "cliente": "…", "operacao": 3, "destino": "…", "pesoManual": null,
    "produtos": [{ "codigo": "…", "descricao": "…", "qtd": 10, "unidade": "CX",
                   "peso": 15.5, "preco": 19.5, "prazo": "…" }]
  }]
}
```

Resposta:

```json
{
  "ok": true,
  "pedido": { "categorias": "CXS-PÇS", "pesoTotal": 0, "valor": 0, "veiculo": "Carreta",
              "entregas": 0, "nfsRemessa": 0, "registradoNoHistorico": true },
  "arquivo": "Pedido Hajan CXS-PÇS nº 3834 (Embarque MRB 27.11.26).pdf",
  "salvoEm": ["S:\\…", "…\\pedidos-pdf"],
  "download": "/api/emissor/pedidos/pdf/<arquivo>",
  "avisos": ["não foi possível gravar em S:\\…"]
}
```

O servidor recalcula peso e valor a partir de `qtd × peso × preço` (peso do catálogo quando o código existir; senão o peso informado). Se o pedido não tiver PÇS nem CXS, grava o PDF e o clone, mas não o histórico, devolvendo aviso — igual ao comportamento atual. Falha de escrita em uma pasta de rede vira aviso, nunca erro; a cópia local e o download permanecem.

### `POST /api/emissor/importar`

`multipart/form-data` com até 4 arquivos `clientes`, `produtos`, `limites`, `unidades` (`.xlsx`, até 25 MB cada). Resposta com contagens por tipo e caminho do backup. Erro 400 aponta o arquivo e o cabeçalho ausente; nada é gravado.

## Regras de negócio

- **Datas** aceitam `dd/mm/yyyy`, `dd/mm/yy`, `dd-mm-yyyy`, `dd.mm.yyyy`, `ddmmyyyy`, `ddmmyy`; inválidas geram mensagem e mantêm o último valor válido. Datas incoerentes (entrega antes do embarque) geram aviso, não bloqueio.
- **Números** pt-BR: milhar com ponto, decimal com vírgula; qtd inteira ≥ 1; preço ≥ 0.
- **Peso**: por produto `qtd × peso`; por entrega soma dos produtos ou `pesoManual` quando o cliente **ou o destino** começa com `ESC `; no total soma das entregas.
- **Valor**: `qtd × peso × preço`, por entrega e por pedido.
- **Veículo**: ≤ 17.000 kg → `Bi-truck`; acima → `Carreta`.
- **Categorias**: presentes no pedido na ordem `CXS, PÇS, CHQ, SPG`; rótulo vazio vira `PÇS`.
- **NFs de remessa**: entregas cuja operação não é 9.
- **Histórico** (`emissor_pedidos_semana`): uma linha por categoria PÇS/CXS presente, chave única `(numero, categoria, sigla, data_embarque, data_entrega)` com `INSERT OR REPLACE`; `linhas` = `[{ indice, destino, cliente, localizacao: "cidade-UF" }]`. Entrega ESC usa o nome do cliente sem sufixo ` (0)` como destino.
- **ESC**: cliente/destino ESC não tem produtos e exige peso manual; o PDF imprime uma linha "PESO".
- **Crédito** (painel): agrupa por `codigo_centralizador` (ou por cliente quando ausente); saldo de crédito ≤ 0 → erro visual; valor do pedido acima do saldo → aviso; status bloqueantes/protesto/jurídico → erro; observação/encargos → aviso; média semanal de compras abaixo do saldo → aviso. Sem carteira, cai em `limites_clientes` com as mesmas mensagens do Streamlit. O painel informa, não bloqueia a geração (paridade).

## PDF

Layout replicado do `fpdf2`: logo no topo, título `Pedido HAJAN {CATEGORIAS} nº {numero} - {SIGLA} (FRIBOI)`, vendedor, destinatário JBS, unidade de carregamento, linha `PEDIDO/At./Local, data`, linha CIF, por entrega o cabeçalho com cliente, CNPJ em faixa amarela e cidade-UF, faixa azul com a operação, tabela Produto (80) / Qtde (15) / Unid (15) / Preço (20) / Prazo (30) mm, peso total da entrega, totais (peso carga, veículo, NFs, NFs de remessa), observação e as três observações logísticas fixas, com rodapé de páginas.

Arquivo: `Pedido Hajan {categorias} nº {numero} (Embarque {sigla} {dd.mm.yy}).pdf`, sanitizado. Gravação atômica (`.tmp` + rename) em cada pasta existente de `PDF_DIRS` (padrão: `S:\FRIBOI\zzz Gestão Pedidos\Pedidos Ped+` e `pedidos-pdf` local). O download é servido por `GET /api/emissor/pedidos/pdf/:arquivo` a partir da pasta local, com nome validado por regex.

## Clone

Ordem: banco (`emissor_pedidos_clonagem`) e depois JSON em `CLONES_DIR` (padrão `S:\FRIBOI\zzz Gestão Pedidos\Pedidos Ped+\_clone_data`). Ao gerar, grava-se o payload nas duas fontes (banco sempre; JSON best-effort). Aplicação no formulário: dados gerais, unidade quando existir na base, datas e entregas com novos identificadores locais; semeia o prazo do cliente em cada produto.

## Importação de planilhas

| Tipo | Aba | Colunas (cabeçalho normalizado) |
|---|---|---|
| clientes | `Infos Clientes` | CÓDIGO, RAZÃO SOCIAL PEDIDO + CÓDIGO, CNPJ, PRAZO, CIDADE, UF, OBS CLIENTES PED+, CÓDIGO CENTRALIZADOR (aceitar `CENTRA-LIZADOR`), Status do Cliente (opcional) |
| produtos | `Infos Produtos` | Código, Produto Frigorífico, Produto Pedido, Unidade, Peso, Produto Frigorífico (Completo), Estado Físico (Grupo), F/S/A, Linha (Marca), Categoria (Divisão) |
| limites | 1ª aba | Código, Nome, Limite, Saldo de Crédito (aliases `CÓDIGO CENTRALIZADOR`, `CENTRALIZADOR`, `DISPONÍVEL`); cabeçalho na linha 1 ou 2 |
| unidades | `SiglasUnidades` | SIGLA, NOME, CRITICA |

Fluxo: recebe → valida tamanho/extensão/cabeçalhos → normaliza e deduplica em memória (clientes por código; produtos por código+descrição; limites por código; unidades por sigla) → snapshot consistente do banco via `VACUUM INTO data/backups/hajan-<timestamp>.db` (mantém os 10 mais recentes) → transação única `DELETE` + `INSERT` nas tabelas `emissor_*` → retorna contagens. Falha em qualquer etapa desfaz tudo.

## UI

Ordem da tela, igual à operação atual: clonagem → dados gerais → entregas → gerar. Estado num reducer; tabelas e pills reaproveitam o design existente.

- **Dados gerais**: nº (sugerido = maior histórico + 1), A/C, data de emissão, local, unidade (busca com canonicalização), observação, embarque e entrega.
- **Entregas**: adicionar/duplicar/excluir, ordenar por número da entrega, cliente de faturamento, operação 3/9, destino da operação 3 (com `SEM DESTINO` primeiro), produtos com categoria, produto, qtde, unidade, preço e prazo; ESC mostra apenas peso manual. Seta para cima/baixo no lugar do arrastar do Streamlit.
- **Impressão em tela**: peso, veículo, valor e quantidade de entregas no cabeçalho; painel "Limite por cliente" por grupo; resumo da carga.
- **Gerar**: exige administração (reaproveita o diálogo de senha da Importação); mostra progresso, depois download, aviso de histórico e botão "Novo pedido".
- **Importação**: nova tela dentro de "Digitação de pedidos" com os 4 seletores, resultado por tipo e aviso de backup.
- Formatação pt-BR, `tabular-nums`, mensagens de erro junto ao campo.

## Remoção do iframe

Em `src/App.tsx`, a rota `novo-pedido` passa a renderizar `EmissorPedidoScreen`; saem o `iframe` do Streamlit e o estilo `content-emissor` se não tiver outro uso. Nenhum outro ponto do app referencia a porta 8501.

## Erros e estados

- Base/carteira carregando: esqueletos; erro de rede: aviso com "Tentar de novo" sem perder o formulário.
- Geração: botão bloqueado durante o envio; falha → mensagem com o motivo do servidor; sucesso parcial (rede) → download + avisos.
- Importação: erro por arquivo, nada gravado; sucesso → contagens + caminho do backup.
- Offline: gerar e importar exigem servidor; mensagem clara.

## Testes e verificação

- `node:test` para: cálculos (peso/valor/veículo/rótulo/NFs), parsing de datas e números, montagem das linhas de histórico, merge do clone, leitura da carteira (fixtures XLSX gerados no teste), validação de importação (cabeçalho errado rejeita sem escrever), PDF (buffer começa com `%PDF`, contém número e categorias).
- Testes de escrita usam cópia temporária do banco (`FRIBOI_DB`) e pasta de PDF temporária; nenhum dado real é tocado.
- Verificação manual no navegador embutido com o harness temporário (não versionado), incluindo geração de um pedido em banco temporário e conferência do PDF e do histórico.
- Aceite final pelo usuário com um pedido real.

## Ordem de implementação

1. **API de leitura**: base, carteira, clone + testes de parsing e cálculo no servidor.
2. **Escrita**: criação de pedido, PDF, clone e download + testes.
3. **Tela nativa** e remoção do iframe.
4. **Importação de planilhas** (API + tela) + testes.
5. **Verificação completa**, changelog e limpeza do harness.

Critérios de aceite: formulário gera pedido igual ao Streamlit (PDF conferido lado a lado), histórico atualiza em Pedidos emitidos, clone pelo banco e pelo JSON funciona, painel de crédito mostra os mesmos números da carteira atual, importação rejeita planilha inválida sem alterar a base, e nenhum ponto do app abre a porta 8501.

Rollback: antes do corte, a rota antiga permanece no commit anterior; depois, revert do commit que troca a tela reativa o iframe sem tocar em dados.
