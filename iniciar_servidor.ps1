param(
  [switch]$Verificar
)

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$pastaLog = Join-Path $raiz 'logs'
if (-not (Test-Path $pastaLog)) { New-Item -ItemType Directory -Path $pastaLog | Out-Null }
$arquivoLog = Join-Path $pastaLog 'inicio_servidor.log'
if ((Test-Path $arquivoLog) -and ((Get-Item $arquivoLog).Length -gt 1MB)) {
  Move-Item -Force $arquivoLog ($arquivoLog -replace '\.log$', '.old.log')
}

function Escrever-Log([string]$mensagem) {
  $linha = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $mensagem
  Add-Content -Path $arquivoLog -Value $linha -Encoding UTF8
  if ($Verificar) { Write-Host $linha }
}

$mapeamento = '\\hajanserver\dadoshajan'
# Pastas usadas pelo emissor; a primeira que responde prova que a rede subiu.
$pastasCriticas = @(
  'S:\FRIBOI\financeiro\carteira clientes',
  'S:\FRIBOI\Pedidos\CHQ'
)
$limiteAguardar = (Get-Date).AddMinutes(10)

function Compartilhamento-Disponivel {
  foreach ($pasta in $pastasCriticas) {
    if (-not (Test-Path -LiteralPath $pasta)) { return $false }
  }
  return $true
}

function Servidor-Respondendo {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:8501/_stcore/health'
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

$sessao = (Get-Process -Id $PID).SessionId
Escrever-Log ("Inicio: usuario {0}, sessao {1}, modo {2}" -f $env:USERNAME, $sessao, $(if ($Verificar) { 'verificacao' } else { 'servidor' }))

while (-not (Compartilhamento-Disponivel) -and (Get-Date) -lt $limiteAguardar) {
  if (-not (Get-PSDrive -Name S -ErrorAction SilentlyContinue)) {
    cmd /c "net use S: $mapeamento /persistent:yes" | Out-Null
  }
  Start-Sleep -Seconds 15
}

if (-not (Compartilhamento-Disponivel)) {
  # Unidade em estado inconsistente: recria o mapeamento uma vez.
  cmd /c "net use S: /delete /y" | Out-Null
  cmd /c "net use S: $mapeamento /persistent:yes" | Out-Null
  Start-Sleep -Seconds 5
}

$disponivel = Compartilhamento-Disponivel
$status = (Get-SmbMapping -LocalPath 'S:' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Status)
Escrever-Log ("Compartilhamento disponivel: {0}; status S: {1}" -f $disponivel, $(if ($status) { $status } else { 'sem mapeamento' }))

if ($Verificar) {
  Escrever-Log ("Verificacao concluida: servidor respondendo {0}" -f (Servidor-Respondendo))
  exit 0
}

if (Servidor-Respondendo) {
  Escrever-Log 'Servidor ja respondendo em 8501; vigia nao iniciado'
  exit 0
}

$vigia = Join-Path $raiz 'vigia_servidor.ps1'
if (-not (Test-Path -LiteralPath $vigia)) {
  Escrever-Log 'ERRO: vigia_servidor.ps1 nao encontrado'
  exit 1
}

Escrever-Log 'Iniciando vigia_servidor.ps1'
& $vigia
Escrever-Log 'Vigia encerrado'
