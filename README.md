# Hajan — Emissor de Pedidos

Sistema interno da HAJAN para emissão e acompanhamento de pedidos de carne à JBS/Friboi, usado no escritório e no servidor da empresa.

## O que é

O Emissor concentra num único painel o trabalho de montar um pedido: escolher a unidade de carregamento, cadastrar as entregas com seus destinos e produtos, conferir limite de crédito de cada cliente e gerar o PDF do pedido. Os pedidos emitidos ficam registrados no próprio sistema, que também serve de consulta para o time.

## Principais recursos

- **Emissão de pedidos** com número, data de emissão, local, unidade de carregamento, datas de embarque CIF e entrega, observações e responsável (A/C Sr.).
- **Entregas e produtos** por pedido, com quantidade, peso, preço editável, cálculo de peso total, valor estimado e sugestão de tipo de veículo.
- **Limite de crédito por cliente**, lido da carteira de crédito da Friboi: limites, saldo disponível, status do cliente e média mensal de compras. O sistema avisa quando o limite está estourado, zerado ou fora de sincronia sem bloquear a emissão.
- **PDF do pedido** com identidade visual HAJAN, salvo nas pastas de trabalho e disponível para download.
- **Histórico de pedidos** na seção Pedidos: número, tipo (caixas ou peças), unidade, datas de embarque e entrega, quantidade de destinos e clientes, com filtro por período.
- **Clonagem de pedido** a partir de um número já emitido, mantendo clientes, produtos, quantidades e preços.
- **Base local de clientes, produtos, unidades e limites** em SQLite, atualizada pela tela de importação a partir das planilhas oficiais do escritório.
- **Login compartilhado** com o sistema Acompanhamento de entregas, com sessão de 12 horas.

## Como funciona no dia a dia

O pedido é montado na tela e finalizado em **Gerar pedido**. O PDF é produzido e arquivado, e o pedido entra automaticamente no histórico para consulta. A base de dados acompanha as planilhas do escritório: quando clientes, produtos, limites ou unidades mudam, os arquivos alterados são enviados pela própria tela e o sistema valida, cria cópia de segurança e atualiza as tabelas.

## Ambientes

- **Escritório (Windows):** o emissor roda localmente na máquina e na rede interna do escritório.
- **Servidor (VPS):** a mesma aplicação roda em container, com a base, os logs e os arquivos gerados em volume persistente.

O sistema é feito para uso interno e trabalha apenas com dados comerciais da empresa e de seus clientes.

## Armazenamento no Firebase

PDFs dos pedidos, dados de clonagem, carteira de crédito e média de compras ficam no Firebase (projeto `sistema-hajan`), sem depender das pastas `D:\` e `S:\`.

| Onde | O quê |
| --- | --- |
| Storage `pedidos/pdf/` | PDFs gerados |
| Storage `credito/carteira/` | Planilhas CARTEIRA DE TERCEIRO, enviadas em **Atualizar base local › Crédito no Firebase** |
| Storage `credito/decisao_credito.json` | Média de compras, enviada na mesma tela |
| Firestore `pedidos_clonagem` | Um documento por pedido, para clonar pelo número |

**Configuração no Windows:** copie `hajan.env.example` para `hajan.env` ao lado do `app.py` e informe o caminho do `.json` da conta de serviço em `FIREBASE_CREDENTIALS`. O `hajan.env` e a chave nunca vão para o repositório.

**Configuração no servidor:** defina `FIREBASE_STORAGE_BUCKET` e `FIREBASE_PROJECT_ID` no `.env` e salve a chave em `secrets/firebase-conta-servico.json`.

Pastas locais continuam opcionais: `HAJAN_PDF_DIR`, `HAJAN_PDF_SHARED_DIR`, `HAJAN_CLONES_DIR`, `FRIBOI_CARTEIRA_DIR` e `FRIBOI_CREDITO_JSON` só são usadas quando definidas.

## Atualizações

O histórico de versões e o que mudou em cada atualização ficam em [ATUALIZACOES.md](ATUALIZACOES.md).
