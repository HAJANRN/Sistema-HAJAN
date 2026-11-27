# Sistema HAJAN — Atualizações

Registro das alterações do sistema, uma entrada por atualização publicada. Entradas mais recentes no topo.

## 2026-11-26 — README com descrição do produto

**Tipo:** documentação

- `README.md` passa a descrever o produto (recursos, ambientes e uso), sem instruções de instalação.
- O histórico de atualizações fica neste arquivo.

## 2026-11-26 — Pedidos acompanhados no próprio sistema

**Tipo:** melhoria

- Removida a geração de planilhas CXS/PÇS/CHQ/SPG, a gravação nas pastas `S:\` e os botões de download de Excel.
- Removidos o resumo semanal em Excel, a importação de resumos da pasta e o campo "Instrução (SPG)".
- Nova seção **Pedidos**: lista os pedidos registrados ao gerar o PDF (número, tipo, unidade, datas e clientes) com filtro por período de entrega.
- O upload de planilhas de clientes, produtos, limites e unidades continua disponível em **Atualizar base local**.

## 2026-11-26 — Versão inicial no GitHub

**Tipo:** infraestrutura

- Código do Emissor Local versionado pela primeira vez no repositório `HAJANRN/Sistema-HAJAN`.
- `.gitignore` passa a excluir bancos `*.db`, executáveis `*.exe`, backups `app.py.backup-*` e `*.bat.backup*`, credenciais e ambiente virtual.
- Histórico de atualizações centralizado neste arquivo. A documentação operacional (instalação, VPS com Docker, segurança e migração para MySQL) fica no `README.md`.

## Modelo de entrada

```markdown
## AAAA-MM-DD — Título curto

**Tipo:** correção | melhoria | infraestrutura | documentação

- O que mudou e por quê.
```
