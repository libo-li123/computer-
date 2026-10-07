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
    $specsRead = $true

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
          serialNumber = [string]$_.SerialNumber
          deviceId = [string]$_.DeviceId
          smartRead = $false
          temperatureCelsius = $null
          wearPercent = $null
          powerOnHours = $null
          smartReason = "正在读取可靠性数据"
          status = @($_.OperationalStatus | ForEach-Object { [string]$_ })
          mediaType = [string]$_.MediaType
          busType = [string]$_.BusType
          size = [double]$_.Size
        }
      })
      $physicalDisksRead = $false
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
      $gpu = $null
      try {
        $gpu = Get-CimInstance Win32_VideoController -ErrorAction Stop |
          Where-Object { $_.Name -and $_.Name -notmatch 'Basic Display|Remote Display|Indirect Display' } |
          Select-Object -First 1 Name,AdapterRAM,DriverVersion
      } catch {}
      $memoryModules = @()
      try { $memoryModules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
        [ordered]@{
          deviceLocator = [string]$_.DeviceLocator
          manufacturer = [string]$_.Manufacturer
          partNumber = [string]$_.PartNumber
          capacityBytes = [long]$_.Capacity
          speedMHz = [int]$_.Speed
          configuredSpeedMHz = [int]$_.ConfiguredClockSpeed
        }
      }) } catch {}
      $hardware = [ordered]@{
        manufacturer = [string]$bios.SystemManufacturer
        model = [string]$bios.SystemProductName
        biosVersion = [string]$bios.BIOSVersion
        memoryBytes = 0
        gpuName = [string]$gpu.Name
        gpuMemoryBytes = [long]$gpu.AdapterRAM
        gpuDriverVersion = [string]$gpu.DriverVersion
        memorySpeedMHz = [int](($memoryModules | Measure-Object -Property configuredSpeedMHz -Maximum).Maximum)
        memoryModuleCount = [int]$memoryModules.Count
      }
      $hardwareSpecs = [ordered]@{
        memorySpeedMHz = [int](($memoryModules | Measure-Object -Property configuredSpeedMHz -Maximum).Maximum)
        memoryModuleCount = [int]$memoryModules.Count
        memoryModules = $memoryModules
        smartRead = $false
        smartDisks = @()
      }
    } catch {
      $hardwareRead = $false
      $hardware = [ordered]@{}
      $hardwareSpecs = [ordered]@{ smartRead = $false; smartDisks = @(); memoryModules = @() }
    }

    try {
      $smartDisks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
        $disk = $_
        $reliability = @()
        try {
          $reliability = @(Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction Stop)
        } catch {}
        $counter = $reliability | Select-Object -First 1
        $wear = if ($null -ne $counter.Wear -and [double]$counter.Wear -ge 0) { [double]$counter.Wear } else { $null }
        $identity = if ($disk.SerialNumber) { "serial:$($disk.SerialNumber.Trim())" } elseif ($disk.DeviceId) { "device:$($disk.DeviceId)" } else { "name:$($disk.FriendlyName)" }
        [ordered]@{
          identity = $identity
          name = [string]$disk.FriendlyName
          serialNumber = [string]$disk.SerialNumber
          deviceId = [string]$disk.DeviceId
          smartRead = ($null -ne $counter) -and (@($counter.PSObject.Properties | Where-Object { $_.Name -in @("Temperature", "Wear", "PowerOnHours", "ReadErrorsTotal", "WriteErrorsTotal") -and $null -ne $_.Value }).Count -gt 0)
          temperatureCelsius = if ($null -ne $counter.Temperature) { [double]$counter.Temperature } else { $null }
          wearPercent = $wear
          powerOnHours = if ($null -ne $counter.PowerOnHours) { [long]$counter.PowerOnHours } else { $null }
          readErrorsTotal = if ($null -ne $counter.ReadErrorsTotal) { [long]$counter.ReadErrorsTotal } else { $null }
          writeErrorsTotal = if ($null -ne $counter.WriteErrorsTotal) { [long]$counter.WriteErrorsTotal } else { $null }
          reason = if ($null -eq $counter -or @($counter.PSObject.Properties | Where-Object { $_.Name -in @("Temperature", "Wear", "PowerOnHours", "ReadErrorsTotal", "WriteErrorsTotal") -and $null -ne $_.Value }).Count -eq 0) { "存储设备未提供 SMART 可靠性属性" } else { $null }
        }
      })
      $hardwareSpecs.smartRead = $smartDisks.Count -gt 0 -and @($smartDisks | Where-Object { $_.smartRead }).Count -gt 0
      $hardwareSpecs.smartDisks = $smartDisks
    } catch {
      $hardwareSpecs.smartRead = $false
      $hardwareSpecs.smartDisks = @()
    }
    $hardwareSpecs.smartChecked = $true
    $hardwareSpecs.diskReliabilityRead = $true
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
      physicalDisksSampled = $true
      securityRead = $securityRead
      antivirus = $antivirus
      hardwareRead = $hardwareRead
      hardware = $hardware
      hardwareSpecs = $hardwareSpecs
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
