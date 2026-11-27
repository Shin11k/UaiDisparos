# Finalizar UAI Disparos TESTE, sem modificar o Worker de producao.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$gw = Join-Path $root "services\sql-gateway"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$dump = "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
$envPath = Join-Path $gw ".env"
$secPath = Join-Path $gw ".worker-secrets.json"
$cfg = Join-Path $root "wrangler.teste.jsonc"
$expectedAccount = "cc0e0dfa790748f45c047138c9fb7da3"
$tid = "2539d848-e8d9-435e-9957-6ba67dbfb991"
$nl = [Environment]::NewLine

function Assert-Exit([string]$name) {
  if ($LASTEXITCODE -ne 0) { throw ($name + " falhou: codigo " + $LASTEXITCODE) }
}
function Secure-Text([Security.SecureString]$s) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function New-Secret {
  $bytes = New-Object byte[] 48
  $g = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $g.GetBytes($bytes) } finally { $g.Dispose() }
  return [BitConverter]::ToString($bytes).Replace("-","").ToLowerInvariant()
}
function Save-Private([string]$path,[string]$value) {
  [IO.File]::WriteAllText($path,$value,(New-Object Text.UTF8Encoding($false)))
}
function Step([string]$s) {
  Write-Host ""
  Write-Host ("==> "+$s) -ForegroundColor Cyan
}
function Gateway-Health([string]$token) {
  for($i=0;$i -lt 10;$i++){
    try {
      return Invoke-RestMethod -Uri "http://127.0.0.1:3107/health" -Headers @{Authorization=("Bearer "+$token)} -TimeoutSec 3
    } catch { Start-Sleep -Seconds 2 }
  }
  throw "Gateway nao respondeu. Verifique a nova janela PowerShell."
}

try {
  if (!(Test-Path $psql) -or !(Test-Path $dump)) { throw "PostgreSQL 18 nao encontrado." }
  if (!(Test-Path $cfg)) { throw "Atualize a branch; wrangler.teste.jsonc ausente." }
  foreach($command in @("node.exe","npm.cmd","npx.cmd")) {
    if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw ("Falta "+$command+" no PATH.") }
  }
  $node = [int](([string](& node.exe --version)).TrimStart("v").Split(".")[0])
  if ($node -lt 20) { throw "Node.js precisa ser versao 20 ou superior." }

  Step "Verificando PostgreSQL uaidisparos"
  $dbpass = Secure-Text (Read-Host "Senha local do usuario uai_app (oculta)" -AsSecureString)
  if (!$dbpass) { throw "Senha do banco vazia." }
  $env:PGPASSWORD = $dbpass
  & $psql -h 127.0.0.1 -p 5432 -U uai_app -d uaidisparos -v ON_ERROR_STOP=1 -tA -c "SELECT current_database(), count(*) FROM public.leads GROUP BY current_database();"
  Assert-Exit "Verificacao do banco"

  Step "Salvando backup ANTES de modificar as tabelas"
  $backupDir = Join-Path $env:USERPROFILE "UaiDisparos-Backups"
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backup = Join-Path $backupDir ("uaidisparos_before_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".backup")
  & $dump -h 127.0.0.1 -p 5432 -U uai_app -d uaidisparos -Fc -f $backup
  Assert-Exit "Backup"
  if (!(Test-Path $backup) -or (Get-Item $backup).Length -lt 1000) { throw "Backup nao foi gravado." }
  Write-Host ("Backup salvo: "+$backup) -ForegroundColor Green

  Step "Aplicando ponte para contas locais e preservando filas pausadas"
  & $psql -h 127.0.0.1 -p 5432 -U uai_app -d uaidisparos -v ON_ERROR_STOP=1 -f (Join-Path $root "db\migrations\001_local_postgres_legacy_bridge.sql")
  Assert-Exit "Migracao SQL"

  Step "Instalando dependencias"
  Set-Location -LiteralPath $root
  & npm.cmd install --no-audit --no-fund
  Assert-Exit "npm da UAI"
  Set-Location -LiteralPath $gw
  & npm.cmd install --no-audit --no-fund
  Assert-Exit "npm do gateway"

  Step "Criando seu login novo"
  $email = (Read-Host "Email de login na UAI").Trim().ToLowerInvariant()
  $name = (Read-Host "Seu nome para exibir no painel").Trim()
  if (!$name) { $name = "Administrador UAI" }
  $password = Secure-Text (Read-Host "NOVA senha de login (12 caracteres ou mais)" -AsSecureString)
  $again = Secure-Text (Read-Host "Repita a NOVA senha" -AsSecureString)
  if ($password.Length -lt 12 -or $again -ne $password) { throw "Senha curta ou confirmacao incorreta." }
  $env:UAI_ADMIN_EMAIL=$email
  $env:UAI_ADMIN_NAME=$name
  $env:UAI_ADMIN_PASSWORD=$password
  Set-Location -LiteralPath $root
  & node.exe (Join-Path $root "scripts\bootstrap-admin-env.mjs")
  Assert-Exit "Cadastro do administrador"
  Remove-Item Env:\UAI_ADMIN_PASSWORD -ErrorAction SilentlyContinue

  Step "Criando conexao privada e segredos"
  if (Test-Path $secPath) { $secrets = Get-Content -LiteralPath $secPath -Raw | ConvertFrom-Json }
  else {
    $secrets=[pscustomobject]@{
      UAI_GATEWAY_TOKEN=(New-Secret)
      UAI_AUTH_SECRET=(New-Secret)
      UAI_QUEUE_SECRET=(New-Secret)
      UAZAPI_WEBHOOK_SECRET=(New-Secret)
    }
    Save-Private $secPath ($secrets | ConvertTo-Json -Compress)
  }
  foreach($key in @("UAI_GATEWAY_TOKEN","UAI_AUTH_SECRET","UAI_QUEUE_SECRET","UAZAPI_WEBHOOK_SECRET")) {
    if (!$secrets.$key -or $secrets.$key.Length -lt 32) { throw ("Segredo incompleto: "+$key) }
  }
  $envText=@(
    "PGHOST=127.0.0.1","PGPORT=5432","PGDATABASE=uaidisparos","PGUSER=uai_app",
    ("PGPASSWORD="+(ConvertTo-Json -InputObject $dbpass -Compress)),
    "PGSSL=false","UAI_GATEWAY_HOST=127.0.0.1","UAI_GATEWAY_PORT=3107",
    ("UAI_GATEWAY_TOKEN="+$secrets.UAI_GATEWAY_TOKEN)
  ) -join $nl
  Save-Private $envPath ($envText+$nl)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

  Step "Ligando SQL Gateway em 127.0.0.1:3107"
  $live=$false
  try {
    $h=Invoke-RestMethod -Uri "http://127.0.0.1:3107/health" -Headers @{Authorization=("Bearer "+$secrets.UAI_GATEWAY_TOKEN)} -TimeoutSec 3
    if($h.ok) { $live=$true }
  } catch {}
  if (!$live) {
    $start="Set-Location -LiteralPath '"+$gw+"'; node.exe --env-file=.env server.mjs"
    Start-Process powershell.exe -ArgumentList @("-NoProfile","-NoExit","-Command",$start) -WorkingDirectory $gw
  }
  $health=Gateway-Health ([string]$secrets.UAI_GATEWAY_TOKEN)
  if (!$health.ok -or $health.database -ne "uaidisparos") { throw "Gateway conectado ao banco errado." }

  Step "Conferindo a conta Cloudflare certa"
  Set-Location -LiteralPath $root
  $pref=$ErrorActionPreference; $ErrorActionPreference="Continue"
  $who=(& npx.cmd --yes wrangler@latest whoami 2>&1) -join $nl
  Assert-Exit "Login Cloudflare"
  if (!$who.Contains($expectedAccount)) { throw "Wrangler nao esta logado na conta Nuvix." }
  $tun=(& npx.cmd --yes wrangler@latest tunnel info $tid 2>&1) -join $nl
  $running=($LASTEXITCODE -eq 0 -and $tun -match "Status:\s*healthy")
  $ErrorActionPreference=$pref
  if (!$running) {
    $command="Set-Location -LiteralPath '"+$root+"'; npx.cmd --yes wrangler@latest tunnel run "+$tid
    Start-Process powershell.exe -ArgumentList @("-NoProfile","-NoExit","-Command",$command) -WorkingDirectory $root
    Start-Sleep -Seconds 12
  }

  Step "Construindo e publicando SOMENTE uai-disparos-teste"
  & npm.cmd run cf:build
  Assert-Exit "Build Cloudflare"
  $pref=$ErrorActionPreference; $ErrorActionPreference="Continue"
  $out=(& npx.cmd --yes wrangler@latest deploy --config $cfg --secrets-file $secPath 2>&1) -join $nl
  $deployCode=$LASTEXITCODE
  $ErrorActionPreference=$pref
  Write-Host $out
  if ($deployCode -ne 0) { throw "Deploy de teste falhou; producao intacta." }
  $m=[regex]::Match($out,"https://[a-zA-Z0-9._-]+\.workers\.dev")
  if (!$m.Success) { throw "Worker publicado; pegue URL em Cloudflare -> uai-disparos-teste." }
  $url=$m.Value

  Step "Testando Worker, PostgreSQL e login"
  $check=Invoke-RestMethod -Uri ($url+"/api/health/postgres") -TimeoutSec 25
  if (!$check.ok) { throw "Worker nao acessou PostgreSQL." }
  $browser=New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $payload=@{email=$email;password=$password} | ConvertTo-Json -Compress
  $login=Invoke-RestMethod -Uri ($url+"/api/auth/login") -Method POST -WebSession $browser -ContentType "application/json" -Body $payload -TimeoutSec 25
  if (!$login.ok) { throw "Login novo falhou." }
  $me=Invoke-RestMethod -Uri ($url+"/api/me") -Method GET -WebSession $browser -TimeoutSec 25
  if (!$me.ok) { throw "Painel nao leu o perfil." }
  Write-Host ""
  Write-Host "UAI DISPAROS TESTE FUNCIONANDO" -ForegroundColor Green
  Write-Host ("LINK: "+$url) -ForegroundColor Green
  Write-Host ("EMAIL: "+$email)
  Write-Host "SENHA: a senha que voce acabou de cadastrar."
  Write-Host "Disparos antigos continuam pausados para evitar duplicados."
}
catch {
  Write-Host ""
  Write-Host ("INSTALACAO PAROU: "+$_.Exception.Message) -ForegroundColor Red
  Write-Host "Producao antiga intacta. Envie o erro, nunca as senhas."
}
finally {
  foreach($key in @("PGPASSWORD","UAI_ADMIN_PASSWORD","UAI_ADMIN_EMAIL","UAI_ADMIN_NAME")) {
    Remove-Item ("Env:\"+$key) -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $root
}
