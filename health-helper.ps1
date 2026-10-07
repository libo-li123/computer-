$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cachePath = Join-Path $appDir "health-cache.json"
$temporaryPath = "$cachePath.tmp"
$mutex = New-Object System.Threading.Mutex($false, "Local\PCObserverHealthHelper")

try {
  if (-not $mutex.WaitOne(0, $false)) {
    exit 0
  }

  $previousProcessCpu = @{}
  $previousProcessSampleAt = [DateTime]::UtcNow

  while ($true) {
    $processSampleAt = [DateTime]::UtcNow
    $logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
    $currentProcessCpu = @{}
    $batteryRead = $true
    $physicalDisksRead = $true
    $securityRead = $true
    $hardwareRead = $true

    try {
      $battery = @(Get-CimInstance Win32_Battery -ErrorAction Stop | ForEach-Object {
        [ordered]@{
          charge = [int]$_.EstimatedChargeRemaining
          status = [int]$_.BatteryStatus
        }
      })
    } catch {
      $batteryRead = $false
      $battery = @()
    }

    try {
      $physicalDisks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
        [ordered]@{
          name = [string]$_.FriendlyName
          health = [string]$_.HealthStatus
          status = @($_.OperationalStatus | ForEach-Object { [string]$_ })
          mediaType = [string]$_.MediaType
          busType = [string]$_.BusType
          size = [double]$_.Size
        }
      })
    } catch {
      $physicalDisksRead = $false
      $physicalDisks = @()
    }

    try {
      $antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop | ForEach-Object {
        [ordered]@{
          name = [string]$_.displayName
          state = [int]$_.productState
        }
      })
    } catch {
      try {
        $securityServices = @(Get-Service -Name WinDefend,SecurityHealthService,wscsvc,mpssvc -ErrorAction Stop |
          Where-Object { $_.Status -eq "Running" })
        $antivirus = @($securityServices | ForEach-Object {
          [ordered]@{
            name = [string]$_.DisplayName
            state = 1
            source = "Windows service"
          }
        })
        $securityRead = $antivirus.Count -gt 0
      } catch {
        $securityRead = $false
        $antivirus = @()
      }
    }

    try {
      $bios = Get-ItemProperty "HKLM:\HARDWARE\DESCRIPTION\System\BIOS" -ErrorAction Stop
      $hardware = [ordered]@{
        manufacturer = [string]$bios.SystemManufacturer
        model = [string]$bios.SystemProductName
        biosVersion = [string]$bios.BIOSVersion
        memoryBytes = 0
      }
    } catch {
      $hardwareRead = $false
      $hardware = [ordered]@{}
    }

    $processes = @(
      Get-Process -ErrorAction SilentlyContinue |
        ForEach-Object {
          $cpuTime = 0
          $memory = 0
          try { $cpuTime = [double]$_.CPU } catch {}
          try { $memory = [long]$_.WorkingSet64 } catch {}
          if ($memory -gt 0) {
            $cpuPercent = $null
            $previous = $previousProcessCpu[[int]$_.Id]
            if ($null -ne $previous) {
              $elapsed = ($processSampleAt - $previous.sampleAt).TotalSeconds
              $delta = $cpuTime - $previous.cpuTime
              if ($elapsed -gt 0.2 -and $delta -ge 0) {
                $cpuPercent = [Math]::Round([Math]::Max(0, [Math]::Min(100, ($delta / $elapsed / $logicalProcessors) * 100)), 1)
              }
            }
            $currentProcessCpu[[int]$_.Id] = [ordered]@{
              cpuTime = $cpuTime
              sampleAt = $processSampleAt
            }
            [PSCustomObject]@{
              name = [string]$_.ProcessName
              pid = [int]$_.Id
              cpuTime = $cpuTime
              cpuPercent = $cpuPercent
              memory = $memory
            }
          }
        } |
        Sort-Object @{ Expression = "cpuTime"; Descending = $true }, @{ Expression = "memory"; Descending = $true } |
        Select-Object -First 12
    )

    $payload = [ordered]@{
      checkedAt = [DateTime]::UtcNow.ToString("o")
      batteryRead = $batteryRead
      battery = $battery
      physicalDisksRead = $physicalDisksRead
      physicalDisks = $physicalDisks
      securityRead = $securityRead
      antivirus = $antivirus
      hardwareRead = $hardwareRead
      hardware = $hardware
      processes = $processes
    }

    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $cachePath -Force
    $previousProcessCpu = $currentProcessCpu
    $previousProcessSampleAt = $processSampleAt
    Start-Sleep -Seconds 30
  }
} catch {
  exit 1
} finally {
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
}
