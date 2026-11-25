param(
  [int]$Port = 5432
)

Write-Host "=== UAI DISPAROS / DIAGNOSTICO POSTGRESQL ===" -ForegroundColor Cyan
Write-Host ("Computador: " + $env:COMPUTERNAME)
Write-Host ("Windows: " + [Environment]::OSVersion.VersionString)

$services = @(Get-Service -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match "postgres|pgsql" -or $_.DisplayName -match "PostgreSQL"
})
if ($services.Count -eq 0) {
  Write-Host "Servicos PostgreSQL: NAO ENCONTRADOS" -ForegroundColor Yellow
} else {
  foreach ($service in $services) {
    Write-Host ("Servico: " + $service.Name + " / " + $service.Status)
  }
}

foreach ($name in @("psql", "pg_restore", "pg_dump", "cloudflared", "node")) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Host ("Ferramenta: " + $name + " / " + $cmd.Source)
  } else {
    Write-Host ("Ferramenta: " + $name + " / NAO ENCONTRADA NO PATH")
  }
}

$client = [System.Net.Sockets.TcpClient]::new()
try {
  $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
  if ($result.AsyncWaitHandle.WaitOne(2500)) {
    $client.EndConnect($result)
    Write-Host ("TCP localhost:" + $Port + " / ABERTA") -ForegroundColor Green
  } else {
    Write-Host ("TCP localhost:" + $Port + " / TIMEOUT") -ForegroundColor Yellow
  }
} catch {
  Write-Host ("TCP localhost:" + $Port + " / FECHADA OU INDISPONIVEL") -ForegroundColor Yellow
} finally {
  $client.Dispose()
}

Write-Host ""
Write-Host "Este diagnostico NAO altera o banco e NAO mostra senhas."
