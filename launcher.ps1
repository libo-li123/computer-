$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverFile = Join-Path $appDir "server.js"
$healthHelper = Join-Path $appDir "health-helper.ps1"
$logPath = Join-Path $appDir "startup.log"
$addressPath = Join-Path $appDir "access-addresses.txt"
$powershellExe = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"

function Test-LocalPort {
  param(
    [int]$Port
  )

  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    return $null -ne $connection
  } catch {
    return $false
  }
}

try {
  $nodeCandidates = @(
    (Join-Path $appDir "node.exe"),
    (Join-Path $appDir "runtime\node.exe"),
    "D:\Document installation\node.exe"
  )

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode) {
    $nodeCandidates += $systemNode.Source
  }

  $nodeExe = $nodeCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1

  if (-not $nodeExe) {
    throw "Node runtime was not found."
  }

  if (-not (Test-Path -LiteralPath $serverFile)) {
    throw "server.js was not found."
  }

  $env:HOST = "0.0.0.0"
  $env:PORT = "5173"

  if (Test-Path -LiteralPath $healthHelper) {
    Start-Process `
      -FilePath $powershellExe `
      -ArgumentList @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $healthHelper
      ) `
      -WorkingDirectory $appDir `
      -WindowStyle Hidden
  }

  $monitorExe = Join-Path $appDir "tools\LibreHardwareMonitor\app\LibreHardwareMonitor.exe"
  $monitorReady = Test-LocalPort -Port 8085
  if ((Test-Path -LiteralPath $monitorExe) -and -not $monitorReady) {
    Start-Process `
      -FilePath $monitorExe `
      -WorkingDirectory (Split-Path -Parent $monitorExe) `
      -WindowStyle Hidden
  }

  if (-not (Test-LocalPort -Port 5173)) {
    Start-Process `
      -FilePath $nodeExe `
      -ArgumentList @($serverFile) `
      -WorkingDirectory $appDir `
      -WindowStyle Hidden
  }

  $apiUrl = "http://127.0.0.1:5173/api/stats"
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $apiUrl
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $ready) {
    throw "The local web service did not become ready on port 5173."
  }

  $localUrl = "http://127.0.0.1:5173/"
  $lanAddresses = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.IPAddress -notlike "198.18.*" -and
        $_.AddressState -eq "Preferred"
      } |
      Sort-Object InterfaceIndex |
      ForEach-Object { "http://$($_.IPAddress):5173/" }
  )

  $addressLines = @(
    "PC Observer is running."
    "Local: $localUrl"
    "LAN:"
  )
  if ($lanAddresses.Count) {
    $addressLines += $lanAddresses
  } else {
    $addressLines += "No LAN IPv4 address was detected."
  }
  $addressLines += ""
  $addressLines += "If another computer cannot connect, run Allow LAN Access.bat as administrator."

  Set-Content -LiteralPath $addressPath -Value ($addressLines -join [Environment]::NewLine) -Encoding UTF8
  Start-Process $localUrl
} catch {
  $message = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($_.Exception.Message)"
  Set-Content -LiteralPath $logPath -Value $message -Encoding UTF8
  exit 1
}
