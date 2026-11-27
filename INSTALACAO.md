# Sistema HAJAN — Instalação e implantação

Guia operacional do Emissor de Pedidos: como montar o pacote, iniciar no escritório (Windows), manter o servidor da rede no ar e publicar na VPS com Docker. A descrição do produto está no [README](README.md) e o histórico de mudanças em [ATUALIZACOES.md](ATUALIZACOES.md).

## Visão geral

| Ambiente | Como inicia | Porta | Quem acessa |
| --- | --- | --- | --- |
| Estação do escritório | `iniciar_hajan.exe` (launcher C#) ou `iniciar_hajan.bat` | 8501 em `127.0.0.1` | só a própria máquina |
| Servidor do escritório | `iniciar_servidor.ps1` / `iniciar_rede.bat` → `vigia_servidor.ps1` | 8501 em `127.0.0.1` e 8502 em `0.0.0.0` | a máquina e a rede interna |
| VPS | `docker compose up -d` atrás do Caddy | 8501 em `127.0.0.1` no host, publicada pelo Caddy via VPN | dispositivos na VPN |

## O que não está no Git

O repositório guarda apenas o código. Para rodar, a pasta do emissor também precisa de:

- `portable_python\` — Python portátil do Windows com as dependências de `requirements.txt` instaladas. Os scripts chamam sempre `portable_python\python.exe`.
- `hajan_pedidos.db` — banco SQLite já preenchido (clientes, produtos, unidades e limites).
- A pasta irmã `..\Acompanhamento de entregas\`, com `iniciar.cmd` e `data\senha-admin.txt` (hash da senha compartilhada).
- `iniciar_hajan.exe` — gerado a partir de `HajanLauncher.cs` (ver abaixo).

O `.gitignore` exclui bancos, planilhas de origem, executáveis, `portable_python/`, `offline_wheels/`, `.env`, `data/` e `secrets/`. Nunca publique esses itens no repositório ou na imagem Docker.

Estrutura esperada no Windows:

```
<pasta local>\
├── Acompanhamento de entregas\
│   ├── iniciar.cmd
│   └── data\senha-admin.txt
└── HAJAN-Emissor-Local - V6\      (esta pasta; o nome não é obrigatório)
    ├── app.py, setup_db.py, ...
    ├── hajan_pedidos.db
    ├── portable_python\python.exe
    └── iniciar_hajan.exe
```

### Preparar o Python portátil

Instale as dependências fixadas no Python portátil (com internet):

```powershell
.\portable_python\python.exe -m pip install -r requirements.txt
```

Para uma máquina sem internet, baixe antes os pacotes numa pasta `offline_wheels` e instale a partir dela com `--no-index --find-links .\offline_wheels`.

### Montar o banco do zero

Se não houver um `hajan_pedidos.db` pronto, coloque as planilhas `Infos Clientes.xlsx`, `Infos Produtos.xlsx`, `Infos Unidades.xlsx` e `CARTEIRA DE TERCEIRO - DIVISÃO 1.xlsx` na pasta do emissor e rode:

```powershell
.\portable_python\python.exe setup_db.py
```

O script grava num banco temporário, faz uma cópia `hajan_pedidos.db.backup-<data>` do banco anterior e só então substitui o arquivo. No Windows, em disco local, o banco e o backup recebem ACL restrita (usuário atual, SYSTEM e Administradores); em unidade de rede a ACL não é aplicada.

No uso diário, a base é atualizada pela tela **Atualizar base local**, enviando só as planilhas alteradas.

## Escritório: estação de trabalho

### Launcher `iniciar_hajan.exe`

`HajanLauncher.cs` gera o `iniciar_hajan.exe`. Ele não inicia o emissor diretamente: procura `..\Acompanhamento de entregas\iniciar.cmd`, executa esse arquivo com o Acompanhamento como pasta de trabalho e espera ele terminar. É o `iniciar.cmd` do Acompanhamento que sobe os dois sistemas e abre o painel unificado. Se o `iniciar.cmd` não existir, o launcher mostra o erro e espera uma tecla.

Para compilar (precisa do .NET SDK 10):

```powershell
dotnet publish .\HajanLauncher.csproj -c Release
```

O `.csproj` gera um único executável `win-x64` autocontido e comprimido, com o ícone `hajan.ico`. Copie o `iniciar_hajan.exe` de `bin\Release\net10.0\win-x64\publish\` para a pasta do emissor.

### Início direto com `iniciar_hajan.bat`

Inicia só o emissor, sem o Acompanhamento. Confere se `hajan_pedidos.db` e `portable_python\python.exe` existem e roda o Streamlit em `127.0.0.1:8501` com CORS e XSRF ativos, upload de até 5 MB e sem file watcher. Abra `http://127.0.0.1:8501`.

### Login

O usuário padrão é `admin` (mude com a variável `FRIBOI_USUARIO`). A senha é a mesma do Acompanhamento: o emissor lê o hash em `..\Acompanhamento de entregas\data\senha-admin.txt`, ou no caminho de `FRIBOI_SENHA_ARQUIVO`. Sem hash, o primeiro acesso cria a senha. `FRIBOI_SENHA` permite fornecer a senha direto pelo ambiente. A sessão dura 12 horas e termina pelo botão **Sair**.

## Escritório: servidor da rede com vigia

Na máquina que atende a rede, o emissor roda em duas instâncias vigiadas: 8501 só para a própria máquina (`127.0.0.1`) e 8502 para a rede (`0.0.0.0`).

### `iniciar_servidor.ps1`

Script de inicialização da máquina servidora. Ele:

1. Espera até 10 minutos a unidade `S:` responder, conferindo `S:\FRIBOI\financeiro\carteira clientes` e `S:\FRIBOI\Pedidos\CHQ`. Se `S:` não estiver mapeada, mapeia `\\hajanserver\dadoshajan` a cada 15 s.
2. Se ainda falhar, apaga e recria o mapeamento uma vez.
3. Se a porta 8501 já responde em `/_stcore/health`, termina sem fazer nada.
4. Senão, executa `vigia_servidor.ps1` e fica preso nele.

Registra tudo em `logs\inicio_servidor.log` (rotaciona em 1 MB). Para só testar a rede e a porta, sem iniciar nada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\iniciar_servidor.ps1 -Verificar
```

O repositório não cria a tarefa de inicialização. Uma forma comum é uma tarefa agendada no logon do usuário que tem a unidade `S:` mapeada, rodando `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<pasta>\iniciar_servidor.ps1"`. Use a sessão desse usuário, pois o mapeamento de `S:` é por usuário.

### `iniciar_rede.bat`

Atalho manual: abre `vigia_servidor.ps1` numa janela oculta e sai na hora. Use para religar o vigia sem esperar a checagem de rede.

### `vigia_servidor.ps1`

Mantém as portas no ar. Parâmetros padrão: `-Portas 8501,8502`, `-IntervaloSegundos 15`, `-FalhasParaReiniciar 3`.

- A cada 15 s testa `http://127.0.0.1:<porta>/_stcore/health`.
- Após 3 falhas seguidas, encerra o processo que ocupa a porta, inicia o Streamlit de novo (oculto, headless, mesmas opções do `.bat`) e espera até 60 s pela resposta.
- Um mutex (`Local\HAJANEmissorVigia`) impede dois vigias na mesma sessão; um segundo vigia sai sem fazer nada.
- Sai com erro se `portable_python\python.exe` ou `app.py` não existirem.
- Log em `logs\vigia_servidor.log` (rotaciona em 5 MB).

Para parar o servidor, encerre o processo `powershell` do vigia e depois os `python.exe` das portas 8501 e 8502; se só os `python.exe` forem encerrados, o vigia os reinicia.

Atenção: a 8502 escuta em todas as interfaces. Libere essa porta no firewall do Windows somente para a rede interna do escritório.

### Pastas usadas no Windows

Sem `HAJAN_EXPORT_DIR`, o emissor usa as pastas fixas do escritório:

| Uso | Caminho | Variável para mudar |
| --- | --- | --- |
| PDFs (local) | `D:\Dados Hajan\pedidos fornecedores\FRIBOI e SEARA\Pedidos\FRIBOI\Pedidos Ped+` | `HAJAN_PDF_DIR` |
| PDFs (rede) | `S:\FRIBOI\zzz Gestão Pedidos\Pedidos Ped+` | `HAJAN_PDF_SHARED_DIR` |
| Dados para clonar pedidos | `<PDFs rede>\_clone_data` | `HAJAN_CLONES_DIR` |
| Carteira de crédito | `S:\FRIBOI\financeiro\carteira clientes` | `FRIBOI_CARTEIRA_DIR` |
| Média de compras | `credito\decisao_credito.json` na pasta do app | `FRIBOI_CREDITO_JSON` |
| Banco | `hajan_pedidos.db` na pasta do app | `HAJAN_DATA_DIR` / `HAJAN_DATABASE_PATH` |
| Log do app | `%LOCALAPPDATA%\HAJAN\emissor.log` | `HAJAN_LOG_DIR` |

Se uma pasta de PDF não puder ser gravada, o botão de download continua disponível.

## VPS com Docker Compose e Caddy

Na VPS roda uma única instância em container. Banco, logs e arquivos gerados ficam no volume `./data`; o banco nunca entra na imagem. As pastas `S:` e `D:` não existem lá: os PDFs e os dados de clonagem vão para `/data/exports`.

### 1. Preparar a VPS

Instale Docker Engine e o plugin Docker Compose. Deixe o firewall aceitar só SSH e a VPN, e instale o Caddy no host.

### 2. Copiar o banco no Windows

Feche o emissor (e o vigia, no servidor) para não haver escrita durante a cópia. Na pasta do emissor:

```powershell
New-Item -ItemType Directory -Force .\data, .\secrets
.\portable_python\python.exe .\deploy\backup_db.py .\hajan_pedidos.db .\data\hajan_pedidos.db
Copy-Item "..\Acompanhamento de entregas\data\senha-admin.txt" ".\secrets\senha-admin.txt"
```

O `deploy/backup_db.py` copia o banco e o `-wal` para uma pasta temporária, abre essa cópia só para leitura, gera o backup com a API do SQLite, roda `PRAGMA integrity_check` e só então cria o destino. Ele falha se o destino já existir e nunca abre o original para escrita. Serve também como backup avulso:

```powershell
.\portable_python\python.exe .\deploy\backup_db.py .\hajan_pedidos.db "D:\Backups\hajan_pedidos-2026-11-27.db"
```

### 3. Configurar o `.env`

```sh
cp .env.example .env
```

Defina `FRIBOI_USUARIO` (o compose não sobe sem ela). Opcionais: `FRIBOI_CARTEIRA_DIR` (padrão `/data/import/carteira`) e `FRIBOI_CREDITO_JSON` (padrão `/data/import/decisao_credito.json`). A senha não vai no `.env`: o hash de `secrets/senha-admin.txt` é montado como secret em `/run/secrets/senha-compartilhada`.

### 4. Enviar para a VPS

Envie o código por `git clone` ou `scp`. Envie `data/`, `secrets/` e `.env` separadamente por SSH/SCP. Para ler a carteira de crédito, coloque uma cópia autorizada em `data/import/carteira/`.

### 5. Subir o container

```sh
mkdir -p data secrets
chmod 700 data secrets
sudo chown -R 10001:10001 data
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 emissor
```

O container roda como o usuário `hajan` (UID/GID `10001`). Antes de iniciar o Streamlit, o `docker/entrypoint.sh` para com erro se:

- `FRIBOI_USUARIO` estiver vazio ou o secret não existir;
- o secret não começar com `scrypt$` (formato do `senha-admin.txt`);
- `/data/hajan_pedidos.db` não existir, falhar no `integrity_check` ou não tiver as tabelas `clientes`, `produtos` e `unidades_carregamento`;
- o banco ou `/data/exports` não puderem ser gravados.

O healthcheck consulta `/_stcore/health` a cada 30 s e o `restart: unless-stopped` religa o container. Na VPS o upload aceita até 25 MB (5 MB no Windows). A porta 8501 só é publicada em `127.0.0.1`; não a abra no firewall.

### 6. Publicar pelo Caddy só na VPN

Use `deploy/Caddyfile.example` como base, em `/etc/caddy/Caddyfile`:

```
hajan.intra.example {
	@fora_da_vpn not remote_ip 10.8.0.0/24
	respond @fora_da_vpn "Acesso permitido somente pela VPN." 403
	tls internal
	reverse_proxy 127.0.0.1:8501
}
```

Troque `hajan.intra.example` pelo nome DNS interno real e `10.8.0.0/24` pela faixa real da VPN. `tls internal` usa a CA própria do Caddy, que precisa ser instalada como confiável só nos dispositivos autorizados. Depois rode `sudo systemctl reload caddy`.

### Atualizar a versão na VPS

```sh
git pull
docker compose up -d --build
docker compose logs --tail=100 emissor
```

O volume `data/` é mantido entre versões.

### Backup na VPS

Pare o container para ter uma cópia consistente e use o mesmo script. O `sudo` é necessário porque `data/` pertence ao UID `10001`:

```sh
docker compose stop emissor
sudo python3 deploy/backup_db.py data/hajan_pedidos.db "backups/hajan_pedidos-$(date +%F).db"
docker compose start emissor
```

Guarde o backup criptografado fora da VPS e teste a restauração. Não monte o mesmo SQLite em mais de uma instância; para réplicas, migre antes para um banco compartilhado.

## Migração dos SQLite para MySQL

`deploy/migrate_sqlite_to_mysql.py` copia `hajan_pedidos.db` e `..\Acompanhamento de entregas\data\expedicao.db` para uma base MySQL vazia, em tabelas com prefixo `emissor_` e `expedicao_`. A cópia valida contagens e checksums e não altera os originais. O emissor e o Acompanhamento continuam usando SQLite; a migração só copia os dados.

```powershell
python -m venv .venv-migracao
.\.venv-migracao\Scripts\python.exe -m pip install -r .\deploy\mysql-migration-requirements.txt
.\.venv-migracao\Scripts\python.exe .\deploy\migrate_sqlite_to_mysql.py --dry-run
```

O `--dry-run` lista tabelas e linhas sem conectar ao MySQL. Para a cópia real, defina no ambiente `MYSQL_HOST`, `MYSQL_PORT` (padrão 3306), `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` e, para host remoto, `MYSQL_SSL_CA` (obrigatório). Rode sem `--dry-run`, uma única vez, com os dois apps fechados. Os caminhos de origem podem ser trocados com `--emissor-db` e `--expedicao-db`.

## Problemas comuns

| Sintoma | Onde olhar |
| --- | --- |
| Launcher diz que `iniciar.cmd` não foi encontrado | As pastas do emissor e do Acompanhamento precisam estar lado a lado. |
| `.bat` diz que falta o banco ou o runtime | Extraia o pacote completo, com `hajan_pedidos.db` e `portable_python\`. |
| Rede não abre na 8502 | `logs\vigia_servidor.log` e o firewall do Windows. |
| Servidor não sobe após reiniciar a máquina | `logs\inicio_servidor.log`: verifique se `S:` apareceu. |
| Container reinicia em loop | `docker compose logs emissor`: a mensagem do entrypoint diz o que falta. |
| Caddy responde 403 | O IP do cliente não está na faixa da VPN configurada. |
