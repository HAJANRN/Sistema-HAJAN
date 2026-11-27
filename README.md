# HAJAN — Acompanhamento de entregas e Emissor de pedidos

Aplicação web (PWA instalável) que reúne, num só lugar, o acompanhamento das entregas da operação de carnes e a emissão dos pedidos semanais. Roda na rede da empresa e pode ser acessada de fora por um link privado de visita.

## O que o sistema faz

- **Acompanhamento de entregas** — painel com a situação das entregas do dia, lista de pedidos com detalhe, anexos (notas e comprovantes) e importação das planilhas que chegam da operação.
- **Emissão de pedidos** — tela "Novo pedido" nativa: cliente, destino, produtos com categoria (CXS, PÇS, CHQ, SPG), entregas com data de embarque e entrega, operação (normal ou remessa) e observações. Ao emitir, o pedido vira PDF, entra no histórico de "Pedidos emitidos" e alimenta o painel de limite de crédito por cliente.
- **Crédito e carteira** — limite disponível por cliente calculado a partir dos pedidos da semana e da carteira consolidada; média semanal de embarques por cliente.
- **Clonagem de pedidos** — repete um pedido anterior a partir do banco, do JSON publicado na rede ou do histórico.
- **Importação de planilhas da base** — atualiza clientes, produtos, limites e unidades de carga a partir das planilhas padrão, com backup automático do banco antes de gravar.
- **Financeiro e logística** — telas de contas a pagar e a receber e de acompanhamento logístico.

## Como está organizado

- `src/` — interface React (telas, estado do formulário de pedido, cliente HTTP).
- `server/` — API Express: leitura das planilhas, banco SQLite, geração de PDF, regras de crédito e importação.
- `tests/` — suíte automatizada das regras de cálculo e da API.
- `docs/` — especificações e planos das fases do produto.
- `ATUALIZACOES.md` — registro das versões publicadas.

## Dados

O sistema trabalha com bancos SQLite locais e com as pastas compartilhadas da empresa (notas, carteira de clientes, base do Emissor). Esses dados, os PDFs gerados e os backups ficam fora do controle de versão.
