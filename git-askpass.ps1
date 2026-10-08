param([string]$Prompt)
if ($Prompt -match 'Username') { [Console]::Write('libo-li123'); exit 0 }
$secret = Read-Host 'GitHub Personal Access Token' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
