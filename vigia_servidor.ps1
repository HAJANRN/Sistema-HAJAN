param(
  [int[]]$Portas = @(8501, 8502),
  [int]$IntervaloSegundos = 15,
  [int]$FalhasParaReiniciar = 3
)
$ErrorActionPreference = 'SilentlyContinue'

$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $raiz 'portable_python\python.exe'
$app = Join-Path $raiz 'app.py'
$pastaLog = Join-Path $raiz 'logs'
if (-not (Test-Path $pastaLog)) { New-Item -ItemType Directory -Path $pastaLog | Out-Null }
$arquivoLog = Join-Path $pastaLog 'vigia_servidor.log'

function Escrever-Log([string]$mensagem) {
  if ((Test-Path $arquivoLog) -and ((Get-Item $arquivoLog).Length -gt 5MB)) {
    Move-Item -Force $arquivoLog ($arquivoLog -replace '\.log$', '.old.log')
  }
  Add-Content -Path $arquivoLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $mensagem) -Encoding UTF8
}

function Endereco-Porta([int]$porta) {
  if ($porta -eq 8501) { return '127.0.0.1' }
  return '0.0.0.0'
}

function Testar-Saude([int]$porta) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ("http://127.0.0.1:$porta/_stcore/health")
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Porta-Ocupada([int]$porta) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $porta -ErrorAction SilentlyContinue)
}

function Encerrar-Dono([int]$porta) {
  $con = Get-NetTCPConnection -State Listen -LocalPort $porta -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($con -and $con.OwningProcess -gt 0) {
    try {
      Stop-Process -Id $con.OwningProcess -Force -ErrorAction Stop
      Escrever-Log ("Porta {0}: processo {1} encerrado" -f $porta, $con.OwningProcess)
    } catch { }
  }
}

function Iniciar-Servidor([int]$porta) {
  $end = Endereco-Porta $porta
  $argumentos = @(
    '-m', 'streamlit', 'run', 'app.py',
    '--server.address', $end,
    '--server.port', $porta,
    '--server.headless', 'true',
    '--server.enableCORS', 'true',
    '--server.enableXsrfProtection', 'true',
    '--server.maxUploadSize', '5',
    '--server.maxMessageSize', '8',
    '--server.fileWatcherType', 'none',
    '--client.toolbarMode', 'minimal',
    '--runner.magicEnabled', 'false'
  )
  $env:STREAMLIT_BROWSER_GATHER_USAGE_STATS = 'false'
  Start-Process -FilePath $python -ArgumentList $argumentos -WorkingDirectory $raiz -WindowStyle Hidden
  Escrever-Log ("Porta {0}: servidor iniciado em {1}" -f $porta, $end)
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\HAJANEmissorVigia')
$temLock = $false
try { $temLock = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $temLock = $true }
if (-not $temLock) { exit 0 }

if (-not (Test-Path $python) -or -not (Test-Path $app)) {
  Escrever-Log 'Vigia abortado: python portatil ou app.py nao encontrado'
  exit 1
}

Escrever-Log 'Vigia iniciado'
$falhas = @{}
foreach ($p in $Portas) { $falhas[$p] = 0 }

while ($true) {
  foreach ($p in $Portas) {
    if (Testar-Saude $p) {
      $falhas[$p] = 0
      continue
    }
    $falhas[$p] = $falhas[$p] + 1
    if ($falhas[$p] -lt $FalhasParaReiniciar) { continue }

    Escrever-Log ("Porta {0}: sem resposta ha {1} verificacoes, reiniciando" -f $p, $falhas[$p])
    if (Porta-Ocupada $p) {
      Encerrar-Dono $p
      Start-Sleep -Seconds 2
    }
    Iniciar-Servidor $p
    $falhas[$p] = 0

    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 2
      if (Testar-Saude $p) { break }
    }
    if (Testar-Saude $p) {
      Escrever-Log ("Porta {0}: respondendo normalmente" -f $p)
    } else {
      Escrever-Log ("Porta {0}: ainda sem resposta apos reinicio" -f $p)
      $falhas[$p] = $FalhasParaReiniciar - 1
    }
  }
  Start-Sleep -Seconds $IntervaloSegundos
}
