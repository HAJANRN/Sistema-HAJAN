# Migração para Firebase — Design (Fase 3)

**Objetivo:** publicar o sistema HAJAN (Acompanhamento de entregas + Emissor) em `hajan.com.br` sobre Firebase, substituindo o servidor Windows local, mantendo o contrato da API e as regras de negócio já validadas na Fase 2.

**Arquitetura:** PWA no Firebase Hosting → Function `api` (Express portado, região São Paulo) → Firestore + Cloud Storage + Firebase Auth. Um agente de sincronização no Windows da empresa lê as pastas `S:\FRIBOI` com os parsers atuais e envia os dados via Admin SDK.

**Stack:** Node 22 (Functions 2nd gen), Express 5, Firestore (modo nativo, `southamerica-east1`), Cloud Storage (bucket regional privado), Firebase Auth (e-mail/senha + custom claims), React 19 PWA (inalterado salvo login/API client).

**Decisões já tomadas:** ingestão por agente de sincronização; contas individuais com papéis admin/operador; substituição do sistema local (sem espelho); banco Firestore com uma única Function Express.

---

## 1. Contexto

Hoje o sistema roda em Windows com SQLite (`data/hajan.db`), lê planilhas das pastas SMB (`S:\FRIBOI\...`) por watchers, grava PDFs/anexos na rede e autentica com uma senha compartilhada. A migração precisa preservar: dashboards e entregas, emissão de pedido com PDF e histórico, crédito/carteira, clonagem, importação de planilhas, anexos e resumos de anomalia.

O código atual relevante: `server/index.js` (rotas), `server/store.js` (SQL com joins), `server/attachments.js` (anexos em `ANEXO_ROOT`), `server/billing.js` (faturamento), `server/parsers/*` (planilhas), `server/emissor*.js` (Emissor), `src/api.ts` (cliente HTTP), `src/screens/LoginScreen.tsx`.

## 2. Arquitetura

```
Navegador (PWA React) ── https://hajan.com.br ──> Firebase Hosting
        │  /api/**  (rewrite)                        │ estático + service worker
        └──> Function `api` (Express, southamerica-east1)
                  ├─ Firebase Auth: verifica ID token; papel por custom claim
                  ├─ Firestore: orders, deliveries, billing, anexos, catálogos, histórico, clones
                  ├─ Cloud Storage: PDFs, anexos, resumos, clones, planilhas brutas, backups
                  └─ Admin SDK ← Agente de sincronização (Windows, on-prem, somente leitura em S:)
```

- **Hosting**: serve `dist/` (SPA fallback) e reescreve `/api/**` para a Function `api`. Domínios: `hajan.com.br` e `www.hajan.com.br`.
- **Function `api`**: única function HTTPS (2nd gen) que monta o Express atual; sem estado entre requisições; `/tmp` apenas para PDFs antes do upload.
- **Firestore**: todo acesso pelo servidor (regras negam cliente); localização `southamerica-east1` (irreversível após criação).
- **Storage**: bucket regional privado `hajan-<env>-arquivos`; acesso apenas por URLs assinadas curtas (5–10 min) geradas pela API.
- **Auth**: login por e-mail/senha no app; papéis em custom claim (`papel: "admin" | "operador"`); sem token de visita.

## 3. Autenticação e papéis

- Front usa o SDK JS do Firebase para login/logout/recuperação de senha; `src/api.ts` passa a enviar `Authorization: Bearer <idToken>` em toda chamada.
- A Function verifica o token (Admin SDK) em todo `/api/**`, exceto `/api/health`; rotas administrativas exigem `papel === "admin"`.
- **Papéis**: `admin` — tudo (importar planilhas, usuários, rescan, emitir, anexos); `operador` — leitura, emissão de pedidos, entregas e anexos.
- `GET /api/sessao` continua existindo e devolve o usuário e o papel extraídos do token (o front usa para montar o menu).
- **Gestão de usuários no app** (tela nova, só admin): listar, criar (e-mail + senha temporária), definir papel, desativar, redefinir senha. Endpoints `GET/POST/PATCH /api/usuarios` usam Admin SDK. Alteração de papel exige novo login (claims só atualizam no próximo token).
- **Bootstrap**: a primeira conta admin é criada por script único local (Admin SDK) informando e-mail; sem senha padrão no código.
- Saem: `/api/visita`, `/api/entrada`, `/api/saida`, `/api/senha`, `/api/servidor/reiniciar`.

## 4. Modelo de dados (Firestore)

Conversão das tabelas atuais (IDs determinísticos para reprocessamento idempotente):

| Hoje (SQLite) | Firestore | ID do documento |
|---|---|---|
| `orders` | `orders/{id}` | id atual |
| `deliveries` | `deliveries/{orderId}__{seq}` (campos desnormalizados: `orderNumber`, `client`, `scheduledAt`, `status`) | `orderId__seq` |
| `files` | `arquivos_processados/{hashArquivo}` | hash do arquivo |
| `meta` | `meta/config` (ETA, versões do catálogo), `contadores/proximoNumero` | fixo |
| `distances` | `distancias/{chave}` | chave origem/destino |
| `attachments` | `anexos/{id}` (com `storagePath`) | id atual |
| `billing` | `faturamento/{id}` | id atual |
| `emissor_clientes` | `clientes/{codigo}` | código |
| `emissor_limites_clientes` | `limites/{codigo}` | código |
| `emissor_produtos` | `produtos/{codigo}` | código |
| `emissor_unidades_carregamento` | `unidades/{codigo}` | código |
| `emissor_pedidos_semana` | `historico_emissor/{docId}` | `numero\|categoria\|sigla\|embarque\|entrega` (preserva `INSERT OR REPLACE`) |
| `emissor_pedidos_clonagem` | `clones/{numero}` | número |

Documentos de consolidação (escritos pelo agente):
- `consolidados/carteira` — carteira consolidada por cliente (limite, pedidos da semana, disponível, média semanal).
- `consolidados/credito` — conteúdo do `decisao_credito.json` atual.
- `sistema/agente` — heartbeat: última execução, contagens, erros.
- `sistema/comandos` — pedido de rescan (`rescanEm`) consumido pelo agente.

**Catálogos e importação atômica:** a importação grava uma nova versão em `catalogo_v<N>/{clientes|limites|produtos|unidades}` e, ao final, atualiza `meta/config.catalogoVersao` em uma única escrita (troca de ponteiro). Leituras resolvem a versão corrente pelo ponteiro; versões antigas são apagadas em sequência. Isso preserva o "tudo ou nada" sem transação multi-coleção.
- **Número do pedido**: `contadores/proximoNumero` incrementado em transação no POST; `GET /api/base` devolve o valor atual.
- **Índices**: só os necessários às consultas (`deliveries` por `scheduledAt`/`status`, `deliveries`/`anexos`/`faturamento` por `orderId`), versionados em `firebase/firestore.indexes.json`.
- **Anexos e resumos**: metadados em `anexos/{id}` (`kind: "arquivo" | "resumo"`, `storagePath`, `mime`, `name`); resumo de anomalia continua gerado por pdfkit no servidor.

## 5. Cloud Storage

```
pdfs/<numero>-<...>.pdf            PDFs emitidos pelo Emissor
anexos/<ano>/<orderId>/<seq>/<id>-<nome>   anexos enviados
anexos/<ano>/<orderId>/<seq>/resumo-<...>.pdf  resumos de anomalia
clones/<numero>.json               payload de clonagem
planilhas/<tipo>/<aaaammdd-hhmm>-<hash>.<ext>  cópias brutas (auditoria do agente)
backups/<ts>-<hex>.json            backups lógicos da importação (retenção 10)
```

- Bucket privado (sem leitura pública); `GET /api/attachments/:id/raw` e download de PDF respondem **302** para URL assinada de 5–10 min (o front continua usando `src`/link).
- O agente **nunca escreve** em `S:\`; a pasta `S:\FRIBOI\infos relatorios` e `Pedidos Ped+` deixam de receber arquivos novos.

## 6. Fluxos

- **Emissão** (`POST /api/emissor/pedidos`): autentica → valida (mesmas regras da Fase 2) → transação no contador → grava `historico_emissor` e `clones` → gera PDF em `/tmp` → sobe para `pdfs/` → responde o mesmo JSON atual (`{ok, pedido, arquivo, download, avisos, ...}`) com URL assinada.
- **Base** (`GET /api/emissor/base`): versão corrente do catálogo + `proximoNumero` + destinos.
- **Clone** (`GET /api/emissor/clones/:numero`): Firestore → JSON sincronizado em `clones/` (Storage) → histórico. O agente copia os JSONs de `_clone_data` para `clones/`.
- **Carteira/crédito**: `GET /api/emissor/carteira` lê `consolidados/carteira`; crédito usa `consolidados/credito` (a média semanal passa a vir do consolidado, mesma fórmula `mensal*12/52`).
- **Importação** (`POST /api/emissor/importar`): upload multipart → valida cabeçalhos → export lógico dos catálogos atuais para `backups/` (retenção 10) → grava `catalogo_v<N+1>` em batches → troca `catalogoVersao` → responde `{backup, contagens, ignoradas}`.
- **Anexos**: upload bruto → Storage + metadado; exclusão remove metadado e objeto; resumo de anomalia é regenerado e substituído.
- **Acompanhamento**: `GET /api/orders`, `GET /api/orders/:id`, dashboards e status leem Firestore com consultas por `orderId`/`scheduledAt`; `/api/status` passa a mostrar heartbeat do agente e última sincronização.
- **Rescan**: `POST /api/rescan` (admin) grava `sistema/comandos.rescanEm`; o agente verifica a cada execução e reprocessa.

## 7. Agente de sincronização

- Programa Node ESM no repositório (`agente/`), reutilizando `server/parsers/*` e a lógica de `billing.js`; roda como Tarefa Agendada do Windows a cada 10 minutos (carteira consolidada: 1×/dia, configurável).
- Credenciais: conta de serviço com Admin SDK; arquivo JSON fora do repositório, indicado por variável de ambiente.
- Lê `XLSX_DIRS`, `PEDIDOS_ROOT`, `FATURAMENTO_DIRS`, `CARTEIRA_DIR`, `CLONES_DIR`, `CREDITO_JSON` (mesmas variáveis de hoje). **Somente leitura** na rede.
- Escritas idempotentes por ID determinístico (reprocessar o mesmo arquivo não duplica nada); registra planilhas processadas em `arquivos_processados` e arquiva a cópia bruta em `planilhas/`.
- Publica `sistema/agente` (última execução, contagens, erros) a cada rodada; modo `--dry-run` valida e loga sem gravar.
- Falha de rede/pasta não derruba a rodada anterior: heartbeat mantém o último sucesso e o status mostra o atraso.

## 8. Migração de dados (execução única)

Script local `scripts/migrar-firebase.mjs` (Node, Admin SDK):
1. Lê `data/hajan.db` em modo somente leitura.
2. Escreve as coleções na tabela de conversão acima, em batches, com IDs determinísticos (reexecução é segura).
3. Sobe para o Storage: PDFs de `pedidos-pdf/`, clones de `_clone_data`, anexos e resumos referenciados no banco (de `S:\FRIBOI\infos relatorios`).
4. Confere contagens origem × destino (`orders`, `deliveries`, `anexos`, `faturamento`, catálogos, `historico_emissor`) e aborta com relatório se divergir.
5. Não apaga nem altera `hajan.db`.

## 9. Segurança

- Firestore/Storage: regras negam todo acesso de cliente; toda leitura/escrita passa pela Function ou pelo agente (Admin SDK).
- URLs assinadas curtas; nomes de arquivo sanitizados (reuso do código atual); sem caminho absoluto em respostas de erro (JSON uniforme).
- Segredos: conta de serviço do agente/migração só na máquina da empresa (fora do repo, `.gitignore`); nenhuma senha no código; primeira conta admin por script.
- Rate limiting de login fica a cargo do Firebase Auth; App Check adiado (avaliar após o corte).
- Logs sem dados sensíveis; erros internos viram mensagem genérica.

## 10. Custos e limites

- Plano **Blaze** obrigatório (Functions/Storage), com alerta de orçamento (sugestão: US$ 20/mês) e limite de gastos no console.
- Estimativa para este volume: Firestore < US$ 5, Functions < US$ 5, Storage centavos; total esperado abaixo de US$ 10/mês.
- Limites que afetam o desenho: 500 operações por batch (importação usa troca de ponteiro), cold start de 1–3 s com `min instances = 0`, localização do Firestore imutável.

## 11. Testes

- Suíte atual (70 testes) migra para o emulador (Firestore/Auth/Storage/Functions): os testes de regras/parsers/PDF continuam; os de rota ganham repositórios Firestore e autenticação.
- Novos testes: transação do contador sob concorrência; importação com troca de ponteiro (versão nova visível só após a escrita final); sincronização idempotente do agente (rodar duas vezes não duplica); heartbeat atrasado no `/api/status`; 401/403 por papel; upload/download de anexo com URL assinada.
- Aceite manual: login de admin/operador, emissão real com PDF, clone, importação das planilhas reais, anexo e resumo, dashboards, acesso externo.

## 12. Corte e rollback

1. Pré-requisitos manuais: projeto Firebase (Blaze, Firestore em `southamerica-east1`, bucket regional), DNS do `hajan.com.br`, `firebase login` no navegador, conta de serviço do agente.
2. Deploy da Function/Hosting em ambiente de teste; validação em leitura com dados migrados.
3. Agente em `--dry-run` na empresa; depois ativo. Cloud conferido contra o local por alguns dias.
4. Virada: usuários criados, servidor Windows desligado, planilhas continuam chegando pela rede (agente).
5. Rollback até a virada: o sistema local (branch `acompanhamento`) continua intacto e `hajan.db` não é alterado; basta voltar a usá-lo. Depois da virada, rollback = restaurar o snapshot da migração.

## 13. Mudanças no repositório

- Novo diretório `firebase/`: `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `functions/` (empacota `server/`).
- `server/`: `store.js` (SQLite) sai do caminho cloud; entra `server/repositorios/firestore.js` com a mesma interface usada pelas rotas. Parsers, regras do Emissor e geração de PDF são reaproveitados sem mudança de comportamento.
- `agente/`: sincronização, dry-run e heartbeat (reusa `server/parsers`).
- `scripts/migrar-firebase.mjs`: migração única.
- Front: SDK do Firebase, `src/api.ts` com Bearer token, tela de login via Auth, tela de usuários (admin), remoção do link de visita e do botão de reiniciar servidor.
- Desenvolvimento em branch própria (`firebase`); `master`/`acompanhamento` permanecem com o sistema local funcionando até a virada.

## 14. Fora de escopo

- Migrar o app Streamlit legado.
- Listeners em tempo real (o app continua por requisição).
- App Check, multi-região, offline de escrita.

## 15. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Reescrita das consultas de `store.js` alterar regras | Testes de contrato no emulador; migração comparando respostas com o sistema local |
| Cold start | `min instances = 0` no início; subir para 1 se incomodar |
| Agente parado (PC desligado) | Heartbeat + alerta no status; rodada idempotente ao voltar |
| Localização do Firestore imutável | `southamerica-east1` decidido antes da criação |
| Custo acima do previsto | Alerta de orçamento + consolidações para reduzir leituras |
| Emulador exige Node 22+ e Java | Instalar Node portátil 22+ no PATH e JRE 11+ na máquina de desenvolvimento (pré-requisito) |

## 16. Pré-requisitos manuais (você)

- Conta Google dona do projeto e plano Blaze com cartão.
- Criar o projeto Firebase e o Firestore em São Paulo (localização não muda depois).
- Acesso ao DNS do `hajan.com.br`.
- Instalar Node 22+ no PATH e Java 11+ na máquina de desenvolvimento; autenticar o Firebase CLI no navegador quando solicitado.
- Gerar a conta de serviço do agente/migração e guardá-la fora do repositório.
