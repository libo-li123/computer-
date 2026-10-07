$ErrorActionPreference = "Stop"

$ruleName = "PC Observer TCP 5173"
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run Allow LAN Access.bat as administrator."
  exit 1
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 5173 `
  -Action Allow `
  -Profile Any `
  -Description "Allow PC Observer on trusted networks" |
  Out-Null

$addresses = @(
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.IPAddress -notlike "198.18.*" -and
      $_.AddressState -eq "Preferred"
    } |
    ForEach-Object { "http://$($_.IPAddress):5173/" }
)

Write-Host ""
Write-Host "Firewall rule created."
Write-Host "Open one of these addresses from another computer:"
if ($addresses.Count) {
  $addresses | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "No LAN IPv4 address was detected."
}
