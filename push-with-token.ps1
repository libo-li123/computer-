$ErrorActionPreference = 'Stop'
$tokenSecure = Read-Host 'GitHub Personal Access Token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(('libo-li123:' + $token)))
  $env:HTTP_PROXY = $null
  $env:HTTPS_PROXY = $null
  $env:ALL_PROXY = $null
  $env:GIT_HTTP_PROXY = $null
  $env:GIT_HTTPS_PROXY = $null
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = 'http.extraHeader'
  $env:GIT_CONFIG_VALUE_0 = ('Authorization: Basic ' + $basic)
  git -c http.sslBackend=openssl -c credential.helper= push https://github.com/libo-li123/computer-.git main:main
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $token = $null
  $basic = $null
  $env:GIT_CONFIG_VALUE_0 = $null
}
