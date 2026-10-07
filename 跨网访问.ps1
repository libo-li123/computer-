$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$addressFile = Join-Path $appDir "cross-network-address.txt"
$tailscaleCandidates = @(
  (Get-Command tailscale.exe -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
  "$env:ProgramFiles\Tailscale\tailscale.exe",
  "$env:LOCALAPPDATA\Tailscale\tailscale.exe"
) |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -Unique

$listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  $launcher = Join-Path $appDir "启动观察器.bat"
  if (Test-Path -LiteralPath $launcher) {
    Start-Process -FilePath $launcher -WorkingDirectory $appDir
    Start-Sleep -Seconds 3
  }
}

$lines = @("PC Observer cross-network access", "")
if ($tailscaleCandidates.Count) {
  $tailscale = $tailscaleCandidates[0]
  $tailnetIps = @(
    & $tailscale ip -4 2>$null |
      Where-Object { $_ -match "^\d+\.\d+\.\d+\.\d+$" }
  )

  if ($tailnetIps.Count) {
    $lines += "Open one of these addresses on another computer in the same Tailscale network:"
    $lines += ($tailnetIps | ForEach-Object { "http://$_`:5173/" })
    $lines += ""
    $lines += "This uses the encrypted Tailscale network."
  } else {
    $lines += "Tailscale was found, but no usable IPv4 address is available."
    $lines += "Sign in to Tailscale and make sure its service is running."
  }
} else {
  $lines += "Tailscale was not found."
  $lines += "Cross-network access requires a VPN or tunnel."
  $lines += "Install Tailscale on both computers and sign in to the same network."
  $lines += "Do not expose port 5173 directly to the public Internet."
}

Set-Content -LiteralPath $addressFile -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
Get-Content -LiteralPath $addressFile
