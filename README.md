# Hajan

## Configuração

### Windows

1. Extraia as pastas `Acompanhamento de entregas` e `HAJAN-Emissor-Local - V6` lado a lado, em uma pasta local no Windows 64 bits.
2. Dê dois cliques em `iniciar_hajan.exe` dentro da pasta do Emissor. O launcher inicia os dois sistemas e abre o painel unificado no navegador.
3. Entre com o usuário `admin` e a senha compartilhada do escritório. A autenticação libera tanto o Acompanhamento quanto o Emissor.

O banco `hajan_pedidos.db` já preenchido é necessário para carregar os dados. Não é preciso ter planilhas Excel para executar o app. Para atualizar dados, abra **Atualizar base local** no fim da página e envie somente as planilhas alteradas. O app valida os arquivos, atualiza apenas as tabelas correspondentes, cria uma cópia de segurança do banco e recarrega os dados. Os limites e saldos disponíveis vêm das colunas `Limite` e `Saldo de Crédito` de `CARTEIRA DE TERCEIRO - DIVISÃO 1.xlsx`; a primeira linha contém grupos de cabeçalho e a segunda, os nomes das colunas. Também é aceito o layout `Infos Limite Disponível.xlsx` (colunas `CENTRALIZADOR`, `LIMITE`, `DISPONÍVEL` e `CÓDIGO CENTRALIZADOR`): como essa planilha lista apenas centralizadores ativos, ela é mesclada com os limites existentes em vez de substituí-los; o layout da carteira substitui a tabela inteira.

Para criar os resumos Excel, informe as datas de embarque CIF e entrega e clique em **Gerar e salvar Excel CXS / PÇS**. Os arquivos são separados pela categoria dos produtos: CXS vai para `S:\FRIBOI\zzz Gestão Pedidos\@ Acompanhamento Pedido CXS` e PÇS para `S:\FRIBOI\zzz Gestão Pedidos\@@ ResumoSemanal PÇS`. A unidade `S:` precisa estar acessível no Windows; se não estiver, o app oferece os botões para baixar cada planilha.

Os PDFs gerados são salvos em `C:\CT-PC16\pdf pedidos`. O app cria essa pasta se necessário; a conta do Windows precisa ter permissão de gravação. Se não for possível salvar, o botão de download permanece disponível.

Como alternativa, coloque as quatro planilhas (`Infos Clientes.xlsx`, `Infos Produtos.xlsx`, `Infos Unidades.xlsx` e `CARTEIRA DE TERCEIRO - DIVISÃO 1.xlsx`) na pasta do projeto e execute `python setup_db.py` para importar todas de uma vez.

### Linux/macOS

Instale as dependências com `python3 -m pip install -r requirements.txt` e inicie com `streamlit run app.py`.

### VPS privada com Docker

O deploy em VPS executa uma única instância Streamlit em container. O SQLite, os logs e os arquivos gerados ficam no volume persistente `./data`; o arquivo original do banco nunca é incluído na imagem. A aplicação grava as saídas em `/data/exports` e continua oferecendo os botões de download. Pastas locais `S:` e `C:` não existem na VPS; para ler a carteira de crédito, coloque uma cópia autorizada em `data/import/carteira` no volume (ou configure `FRIBOI_CARTEIRA_DIR`) e, se necessário, configure também `FRIBOI_CREDITO_JSON`.

1. Instale Docker Engine e Docker Compose no VPS. Restrinja o firewall à VPN/rede privada e instale um proxy reverso TLS no host.
2. No computador Windows, feche o emissor para fazer uma cópia consistente do SQLite, sem alterar o banco original:

   ```powershell
   New-Item -ItemType Directory -Force .\data, .\secrets
   python .\deploy\backup_db.py .\hajan_pedidos.db .\data\hajan_pedidos.db
   Copy-Item "..\Acompanhamento de entregas\data\senha-admin.txt" ".\secrets\senha-admin.txt"
   ```

   O script cria um novo arquivo, copia o banco e o WAL para uma área temporária, valida a cópia e nunca abre o original com escrita. Feche o emissor antes da cópia para impedir alterações simultâneas. O script falha se o destino já existir; não remove nem sobrescreve o original.
3. Crie `.env` a partir de `.env.example` e informe `FRIBOI_USUARIO`. O hash de senha existente é montado como segredo somente leitura; não coloque a senha em comandos, no Git ou na imagem Docker.
4. Transfira o código de deploy e os dados por SSH/SCP para o VPS. Copie a pasta `data` e o segredo separadamente em canal protegido; confirme que `.env`, `data` e `secrets` não foram publicados em repositório ou imagem.
5. No VPS, torne o volume acessível apenas ao usuário do container (UID/GID `10001`) e inicie:

   ```sh
   mkdir -p data secrets
   chmod 700 data secrets
   sudo chown -R 10001:10001 data
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 emissor
   ```

   O container falha fechado se o banco não existir, o hash compartilhado estiver ausente/incorreto ou o volume não permitir escrita. A porta `8501` fica publicada apenas em `127.0.0.1`; não a exponha no firewall.
6. Configure o proxy reverso do host usando `deploy/Caddyfile.example` como modelo: troque o hostname e a faixa pela VPN real, habilite TLS e faça o proxy apontar para `127.0.0.1:8501`. O exemplo usa CA interna do Caddy, que deve ser confiada apenas pelos dispositivos autorizados. Restrinja também o firewall; não assuma que um endereço de exemplo representa sua rede.

O upload de planilhas de atualização permanece disponível, e os relatórios gerados podem ser baixados ou ficam no volume persistente. A leitura automática de `S:` e a publicação automática nas pastas de rede Windows não são realizadas pela VPS. Para HA/replicas, migre antes o SQLite para um banco compartilhado suportado: não monte o mesmo SQLite em múltiplas instâncias. Faça backup criptografado do volume `data` e teste a restauração. Não use Streamlit Community Cloud para este banco com dados comerciais.

### Cópia dos bancos SQLite para MySQL hospedado

O script `deploy/migrate_sqlite_to_mysql.py` copia as tabelas atuais de `hajan_pedidos.db` e `Acompanhamento de entregas/data/expedicao.db` para uma base MySQL já criada. Cria tabelas isoladas com prefixos `emissor_` e `expedicao_`, para não colidir com as tabelas `clientes` e outras da plataforma financeira. Preserva colunas, chaves primárias/estrangeiras, índices e linhas; valida contagem e checksum após a cópia. O destino deve estar vazio para esses nomes; nenhuma tabela existente é sobrescrita. Não inclui os próprios arquivos anexados referenciados pelo banco de expedição.

1. Feche os dois aplicativos no Windows antes de copiar. Instale o conector numa virtualenv separada, sem alterar as dependências do emissor:

   ```powershell
   python -m venv .venv-migracao
   .\.venv-migracao\Scripts\python.exe -m pip install -r .\deploy\mysql-migration-requirements.txt
   ```

2. Faça primeiro a simulação local, sem conexão MySQL:

   ```powershell
   .\.venv-migracao\Scripts\python.exe .\deploy\migrate_sqlite_to_mysql.py --dry-run
   ```

3. Crie no provedor MySQL uma base vazia e um usuário exclusivo com permissões apenas nessa base para criar tabelas, índices, inserir e consultar dados. Autorize no firewall o IP de saída do computador que fará a cópia. Baixe o certificado CA de TLS do próprio provedor.
4. Configure `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` e `MYSQL_SSL_CA` no ambiente local do processo; não salve senha em scripts, não cole a senha no chat e não a inclua na linha de comando. Para host remoto, o script exige CA e valida o certificado e a identidade do servidor.
5. Execute uma única vez:

   ```powershell
   .\.venv-migracao\Scripts\python.exe .\deploy\migrate_sqlite_to_mysql.py
   ```

   O script cria snapshots temporários dos originais e verifica se os arquivos de origem mudaram durante a cópia. Se houver conflito no MySQL ou alteração simultânea nos originais, ele para em vez de sobrescrever dados. Se a conexão cair depois de criar tabelas no destino, não use essas tabelas parcialmente copiadas: valide e remova apenas os nomes `emissor_*`/`expedicao_*` criados pela tentativa antes de uma nova execução.

A migração copia dados; ela não muda automaticamente o emissor Streamlit nem o Acompanhamento Node para consultar MySQL — ambos continuam usando SQLite até uma adaptação separada. No banco de expedição, os registros de anexos são migrados, mas os arquivos apontados pelas colunas de caminho precisam de cópia própria e reconfiguração do armazenamento.

O app lê clientes, produtos, limites e unidades de carregamento de `hajan_pedidos.db`. A unidade de carregamento é escolhida uma vez para o pedido inteiro e aparece no resumo do PDF. Os limites são associados aos clientes pelo código centralizador. O app avisa quando não há limite sincronizado, o saldo está zerado/negativo ou o valor estimado do pedido excede o disponível. O status importado da coluna `Status do Cliente` da planilha de clientes é mostrado logo abaixo do resumo/aviso do limite; se a coluna não existir ou estiver vazia, aparece como “Não informado”. O valor estimado usa quantidade × peso × preço dos itens; os avisos não bloqueiam a emissão. Ao importar novamente, as tabelas são substituídas pelos dados atuais das planilhas.

O catálogo mantém descrições, unidades, pesos e classificações. Um código pode aparecer em mais de um produto; a identidade usa código e descrição. Os códigos negativos identificam variantes por peça. Os preços continuam editáveis no pedido, pois a planilha de produtos não fornece uma coluna de preço.

## Segurança

O launcher Windows escuta somente em `127.0.0.1`; não publique a porta do app na rede. CORS e proteção XSRF ficam ativos. Toda planilha enviada é validada antes da importação: limite de 25 MB, até 100 MB expandidos, no máximo 1.000 componentes, taxa de compactação máxima de 200:1, rejeição de arquivos criptografados e de planilhas com macros. O XML é lido com `defusedxml` e a aplicação consulta o banco em modo somente leitura; atualizações usam cópia temporária, verificação de integridade e backup antes da troca. No Windows, o banco e cada backup em disco local recebem ACL restrita (usuário atual, SYSTEM e Administradores), reaplicada automaticamente após cada atualização; em unidades de rede a ACL não é aplicada, pois o SID local não é reconhecido pelo servidor e a restrição cortaria o próprio acesso. Erros detalhados ficam apenas no console local.

O sistema exige login antes de liberar qualquer dado do Acompanhamento ou do Emissor. O usuário padrão é `admin` (pode ser alterado pela variável `FRIBOI_USUARIO` nos dois processos). A senha fica compartilhada com o Acompanhamento: por padrão, o Emissor lê o hash em `Acompanhamento de entregas\data\senha-admin.txt`. Se ainda não houver senha, o primeiro acesso permite criá-la; nos acessos seguintes, informe usuário e senha. A sessão expira após 12 horas e pode ser encerrada pelo botão **Sair**. Se as pastas estiverem em outro local, configure `FRIBOI_SENHA_ARQUIVO` apontando para o hash; a variável `FRIBOI_SENHA` pode fornecer a senha diretamente.

Bloqueie a sessão do Windows ao se ausentar. O banco, os backups e os arquivos gerados contêm dados comerciais e de clientes; restrinja as permissões de pasta (ACL) e distribua o pacote apenas a pessoas autorizadas. Mantenha uma cópia protegida do banco e atualize as dependências fixadas com auditorias periódicas (`pip-audit`).