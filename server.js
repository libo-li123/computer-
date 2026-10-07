const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { execFile } = require("child_process");

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const healthCachePath = path.join(root, "health-cache.json");
let lastCpu = null;
let temperatureRefreshRunning = false;
let cachedDetails = {
  disks: [],
  processes: [],
  hardware: {
    manufacturer: "正在读取",
    model: "正在读取",
    memoryBytes: os.totalmem()
  },
  hostInfo: {
    manufacturer: "正在读取",
    model: "正在读取",
    memoryBytes: os.totalmem(),
    processor: os.cpus()[0]?.model || "正在读取",
    cores: os.cpus().length,
    logicalProcessors: os.cpus().length,
    maxClockMHz: 0,
    currentClockMHz: 0,
    windowsName: `${os.type()} ${os.release()}`,
    windowsVersion: os.release(),
    biosVersion: "正在读取",
    diskSpecs: []
  },
  systemHealth: {
    bootTime: null,
    battery: [],
    temperatures: [],
    antivirus: [],
    physicalDisks: [],
    systemDriveFree: null
  },
  detailsUpdatedAt: null,
  detailsLoading: false,
  detailsError: null
};

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout.trim());
    });
  });
}

function cpuSample() {
  const cpus = os.cpus();
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
  const total = cpus.reduce((sum, cpu) =>
    sum + Object.values(cpu.times).reduce((a, value) => a + value, 0), 0);
  return { idle, total };
}

function cpuPercent() {
  const current = cpuSample();
  if (!lastCpu) {
    lastCpu = current;
    return 0;
  }
  const idle = current.idle - lastCpu.idle;
  const total = current.total - lastCpu.total;
  lastCpu = current;
  return total ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

function readLocalDisks() {
  if (typeof fs.statfsSync !== "function") return [];
  const disks = [];
  for (let code = 65; code <= 90; code++) {
    const name = `${String.fromCharCode(code)}:`;
    try {
      const stats = fs.statfsSync(`${name}\\`);
      const blockSize = Number(stats.frsize || stats.bsize || 0);
      const total = Number(stats.blocks || 0) * blockSize;
      const free = Number(stats.bavail ?? stats.bfree ?? 0) * blockSize;
      if (total > 0) disks.push({ name, total, free });
    } catch {}
  }
  return disks;
}

function readHealthCache() {
  try {
    const text = fs.readFileSync(healthCachePath, "utf8").replace(/^\uFEFF/, "");
    const cache = JSON.parse(text);
    return cache && typeof cache === "object" ? cache : null;
  } catch {
    return null;
  }
}

function mergeHealthCache(details) {
  const cache = readHealthCache();
  if (!cache) return details;
  const systemHealth = { ...details.systemHealth };
  if (cache.batteryRead === true) systemHealth.battery = Array.isArray(cache.battery) ? cache.battery : [];
  if (cache.physicalDisksRead === true) {
    systemHealth.physicalDisks = Array.isArray(cache.physicalDisks) ? cache.physicalDisks : [];
  }
  if (cache.securityRead === true) systemHealth.antivirus = Array.isArray(cache.antivirus) ? cache.antivirus : [];
  if (Array.isArray(cache.processes) && cache.processes.length) {
    details.processes = cache.processes;
  }
  systemHealth.healthCacheCheckedAt = cache.checkedAt || null;
  let hardware = details.hardware;
  let hostInfo = details.hostInfo;
  if (cache.hardwareRead === true && cache.hardware) {
    hardware = {
      ...hardware,
      manufacturer: cache.hardware.manufacturer || hardware.manufacturer,
      model: cache.hardware.model || hardware.model,
      memoryBytes: Number(cache.hardware.memoryBytes || hardware.memoryBytes || os.totalmem())
    };
    hostInfo = {
      ...hostInfo,
      manufacturer: hardware.manufacturer,
      model: hardware.model,
      memoryBytes: hardware.memoryBytes,
      biosVersion: cache.hardware.biosVersion || hostInfo.biosVersion,
      source: "Windows registry + Node.js"
    };
  }
  return { ...details, hardware, hostInfo, systemHealth };
}

function readLocalJson(url) {
  return new Promise((resolve) => {
    const request = net.connect({ host: "127.0.0.1", port: 8085, timeout: 700 }, () => {
      request.write(`GET /data.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const payload = body.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      try { resolve(JSON.parse(payload)); } catch { resolve(null); }
    });
    request.on("timeout", () => { request.destroy(); resolve(null); });
    request.on("error", () => resolve(null));
  });
}

function classifyTemperature(name, sensorPath = "") {
  const text = `${name} ${sensorPath}`.toLowerCase();
  if (/gpu|nvidia|radeon|graphics/.test(text)) return "GPU";
  if (/ssd|disk|nvme|hfs|composite temperature|temperature #/.test(text)) return "存储";
  if (/cpu|core|package|processor|intel|amd|ryzen/.test(text)) return "CPU";
  return "其他";
}

function isActualTemperature(name, type) {
  if (type && type.toLowerCase() !== "temperature") return false;
  return !/distance to tjmax|warning temperature|critical temperature|tjmax|threshold|limit/i.test(name);
}

function normalizeTemperatureSensor(item) {
  if (!item) return null;
  const name = String(item.name ?? item.Name ?? "温度传感器");
  if (!isActualTemperature(name, item.type ?? item.Type)) return null;
  const celsius = Number(item.celsius ?? item.Celsius);
  if (!Number.isFinite(celsius) || celsius <= 0 || celsius >= 120) return null;
  const maxCelsius = Number(item.maxCelsius ?? item.MaxCelsius);
  const sensorPath = String(item.path ?? item.Path ?? "");
  return {
    name,
    celsius,
    maxCelsius: Number.isFinite(maxCelsius) && maxCelsius > 0 && maxCelsius < 120 ? maxCelsius : null,
    category: item.category || classifyTemperature(name, sensorPath),
    source: item.source || item.Source || "Windows sensor"
  };
}

function extractTemperatures(node, result = [], parentPath = []) {
  if (!node || typeof node !== "object") return result;
  const currentPath = [...parentPath, node.Text].filter(Boolean);
  const value = typeof node.Value === "string" ? node.Value : "";
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*°?C/i);
  if (match && node.Text && isActualTemperature(node.Text, node.Type)) {
    const sensor = normalizeTemperatureSensor({
      name: node.Text,
      celsius: Number(match[1]),
      maxCelsius: String(node.Max || "").match(/(-?\d+(?:\.\d+)?)\s*°?C/i)?.[1],
      path: currentPath.join(" / "),
      type: node.Type,
      source: "LibreHardwareMonitor"
    });
    if (sensor) result.push(sensor);
  }
  if (Array.isArray(node.Children)) {
    node.Children.forEach((child) => extractTemperatures(child, result, currentPath));
  }
  return result;
}

function parseMetric(value, unitPattern = "") {
  const match = String(value || "").match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, "i"));
  return match ? Number(match[1]) : null;
}

function extractMonitorHealth(node, result = { battery: [], physicalDisks: [] }) {
  if (!node || typeof node !== "object") return result;
  const hardwareId = String(node.HardwareId || "").toLowerCase();
  const isBattery = hardwareId.startsWith("/battery/");
  const isDisk = /^\/(nvme|ata|storage|hdd)\//.test(hardwareId);
  if (isBattery || isDisk) {
    const metrics = {};
    const collect = (child) => {
      if (!child || typeof child !== "object") return;
      if (child.Text && child.Value) metrics[child.Text] = child.Value;
      if (Array.isArray(child.Children)) child.Children.forEach(collect);
    };
    collect(node);
    if (isBattery) {
      const charge = parseMetric(metrics["Charge Level"], "%");
      if (Number.isFinite(charge)) {
        result.battery.push({
          charge: Math.max(0, Math.min(100, charge)),
          status: 2,
          source: "LibreHardwareMonitor",
          degradation: parseMetric(metrics["Degradation Level"], "%"),
          remainingCapacity: parseMetric(metrics["Remaining Capacity"], "mWh"),
          fullCapacity: parseMetric(metrics["Fully-Charged Capacity"], "mWh"),
          designedCapacity: parseMetric(metrics["Designed Capacity"], "mWh")
        });
      }
    }
    if (isDisk) {
      const life = parseMetric(metrics.Life, "%");
      const spare = parseMetric(metrics["Available Spare"], "%");
      if (Number.isFinite(life) || Number.isFinite(spare)) {
        const healthValue = Number.isFinite(life) ? life : spare;
        result.physicalDisks.push({
          name: node.Text || "存储设备",
          health: healthValue >= 80 ? "Healthy" : healthValue >= 20 ? "Warning" : "Critical",
          status: [healthValue >= 80 ? "OK" : "Degraded"],
          mediaType: "SSD",
          busType: hardwareId.startsWith("/nvme/") ? "NVMe" : "未知接口",
          size: (parseMetric(metrics["Total Space"], "GB") || 0) * 1024 ** 3,
          life: Number.isFinite(life) ? life : null,
          availableSpare: Number.isFinite(spare) ? spare : null,
          source: "LibreHardwareMonitor"
        });
      }
    }
  }
  if (Array.isArray(node.Children)) {
    node.Children.forEach((child) => extractMonitorHealth(child, result));
  }
  return result;
}

function extractMonitorHardware(node, result = null) {
  if (!node || typeof node !== "object") return result;
  const hardwareId = String(node.HardwareId || "").toLowerCase();
  if (hardwareId === "/motherboard" && node.Text) {
    const parts = String(node.Text).trim().split(/\s+/);
    return {
      manufacturer: parts.shift() || "未知厂商",
      model: parts.join(" ") || node.Text
    };
  }
  if (Array.isArray(node.Children)) {
    for (const child of node.Children) {
      const hardware = extractMonitorHardware(child, result);
      if (hardware) return hardware;
    }
  }
  return result;
}

function extractMonitorClock(node, result = { values: [] }, inCpu = false) {
  if (!node || typeof node !== "object") return result;
  const hardwareId = String(node.HardwareId || "").toLowerCase();
  const text = String(node.Text || "");
  const cpuNode = /^\/(intelcpu|amdcpu)\//.test(hardwareId);
  const currentInCpu = inCpu || cpuNode;
  if (currentInCpu && /^cpu core #/i.test(text)) {
    const value = Number(String(node.Value || "").match(/(-?\d+(?:\.\d+)?)\s*MHz/i)?.[1]);
    if (Number.isFinite(value) && value > 0) result.values.push(value);
  }
  if (Array.isArray(node.Children)) {
    node.Children.forEach((child) => extractMonitorClock(child, result, currentInCpu));
  }
  return result;
}

async function refreshTemperatureFromMonitor() {
  if (temperatureRefreshRunning) return;
  temperatureRefreshRunning = true;
  try {
    const tree = await readLocalJson("http://127.0.0.1:8085/data.json");
    const sensors = extractTemperatures(tree);
    const monitorHealth = extractMonitorHealth(tree);
    const monitorHardware = extractMonitorHardware(tree);
    const monitorClock = extractMonitorClock(tree);
    const measuredClockMHz = monitorClock.values.length
      ? monitorClock.values.reduce((sum, value) => sum + value, 0) / monitorClock.values.length
      : 0;
    const currentClockMHz = Number.isFinite(measuredClockMHz) && measuredClockMHz > 0
      ? measuredClockMHz
      : 0;
    const temperatures = sensors.map((sensor) => sensor.celsius);
    cachedDetails.systemHealth = {
      ...cachedDetails.systemHealth,
      ...(sensors.length ? {
        temperatures,
        temperatureSensors: sensors,
        temperatureSources: [
          { name: "LibreHardwareMonitor", available: true },
          { name: "Windows ACPI", available: false },
          { name: "Windows Thermal Zone", available: false },
          { name: "OpenHardwareMonitor", available: false }
        ],
        temperatureSource: "LibreHardwareMonitor",
        temperatureSupported: true,
        temperatureCheckedAt: new Date().toISOString()
      } : {}),
      ...(monitorHealth.battery.length ? { battery: monitorHealth.battery } : {}),
      ...(monitorHealth.physicalDisks.length ? { physicalDisks: monitorHealth.physicalDisks } : {})
    };
    if (monitorHardware) {
      cachedDetails.hardware = {
        ...cachedDetails.hardware,
        ...monitorHardware,
        memoryBytes: cachedDetails.hardware.memoryBytes || os.totalmem()
      };
      cachedDetails.hostInfo = {
        ...cachedDetails.hostInfo,
        ...monitorHardware,
        memoryBytes: cachedDetails.hardware.memoryBytes,
        ...(currentClockMHz > 0 ? { currentClockMHz } : {}),
        source: "LibreHardwareMonitor + Node.js"
      };
    }
    if (currentClockMHz > 0) {
      cachedDetails.hostInfo = { ...cachedDetails.hostInfo, currentClockMHz };
    }
  } finally {
    temperatureRefreshRunning = false;
  }
}

async function refreshDetails() {
  if (cachedDetails.detailsLoading) return;
  cachedDetails = { ...cachedDetails, detailsLoading: true, detailsError: null };
  const ps = `
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
      Select-Object DeviceID,Size,FreeSpace;
    $system = Get-CimInstance Win32_OperatingSystem |
      Select-Object LastBootUpTime,Version;
    $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue |
      Select-Object EstimatedChargeRemaining,BatteryStatus;
    $temperature = @(
      Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction SilentlyContinue |
        ForEach-Object {
          $celsius = ([double]$_.CurrentTemperature / 10) - 273.15;
          if ($celsius -gt 0 -and $celsius -lt 120) {
            [PSCustomObject]@{ Name = $_.InstanceName; Celsius = $celsius; Source = "Windows ACPI" }
          }
        }
    );
    $perfTemperature = @(
      Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue |
        ForEach-Object {
          $celsius = ([double]$_.Temperature / 10) - 273.15;
          if ($celsius -gt 0 -and $celsius -lt 120) {
            [PSCustomObject]@{ Name = $_.Name; Celsius = $celsius; Source = "Windows Thermal Zone" }
          }
        }
    );
    $openHardwareTemperature = @();
    try {
      $openHardwareTemperature = @(Get-CimInstance -Namespace root/OpenHardwareMonitor -ClassName Sensor -ErrorAction Stop |
        Where-Object { $_.SensorType -eq "Temperature" } |
        ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Celsius = [double]$_.Value; Source = "OpenHardwareMonitor" } })
    } catch {}
    $libreHardwareTemperature = @();
    try {
      $libreHardwareTemperature = @(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop |
        Where-Object { $_.SensorType -eq "Temperature" } |
        ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Celsius = [double]$_.Value; Source = "LibreHardwareMonitor" } })
    } catch {}
    $allTemperature = @($temperature + $perfTemperature + $openHardwareTemperature + $libreHardwareTemperature);
    $security = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction SilentlyContinue |
      Select-Object displayName,productState;
    $physicalDisks = Get-PhysicalDisk -ErrorAction SilentlyContinue |
      Select-Object FriendlyName,HealthStatus,OperationalStatus,MediaType,BusType,Size;
    $hardware = Get-CimInstance Win32_ComputerSystem |
      Select-Object Manufacturer,Model,TotalPhysicalMemory;
    $bios = Get-CimInstance Win32_BIOS |
      Select-Object SMBIOSBIOSVersion,ReleaseDate;
    $processor = Get-CimInstance Win32_Processor |
      Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed;
    $processes = Get-Process |
      Where-Object { $_.CPU -ne $null } |
      Sort-Object CPU -Descending |
      Select-Object -First 12 Name,Id,CPU,WorkingSet64;
    [PSCustomObject]@{
      disks = @($disks);
      system = $system;
      battery = @($battery);
      temperature = $allTemperature;
      security = @($security);
      physicalDisks = @($physicalDisks);
      hardware = $hardware;
      bios = $bios;
      processor = $processor;
      processes = @($processes);
    } | ConvertTo-Json -Depth 4 -Compress
  `;
  let data = { disks: [], processes: [], battery: [], temperature: [], security: [], physicalDisks: [] };
  try {
    data = JSON.parse(await powershell(ps));
  } catch (error) {
    const fallbackDisks = readLocalDisks();
    const systemDisk = fallbackDisks.find((disk) =>
      disk.name.toUpperCase() === (process.env.SystemDrive || "C:").toUpperCase()
    );
    const healthCache = readHealthCache();
    const cacheReady = healthCache &&
      (healthCache.hardwareRead === true || healthCache.securityRead === true);
    cachedDetails = {
      ...cachedDetails,
      disks: fallbackDisks.length ? fallbackDisks : cachedDetails.disks,
      systemHealth: {
        ...cachedDetails.systemHealth,
        systemDriveFree: systemDisk?.free ?? cachedDetails.systemHealth.systemDriveFree ?? null
      },
      detailsLoading: false,
      detailsError: cacheReady ? null : error.message,
      detailsUpdatedAt: cacheReady
        ? (healthCache.checkedAt || new Date().toISOString())
        : new Date().toISOString()
    };
    return;
  }
  const disks = (Array.isArray(data.disks) ? data.disks : [data.disks]).filter(Boolean)
    .map((disk) => ({
      name: disk.DeviceID,
      total: Number(disk.Size || 0),
      free: Number(disk.FreeSpace || 0)
    }));
  const processes = (Array.isArray(data.processes) ? data.processes : [data.processes]).filter(Boolean)
    .map((process) => ({
      name: process.Name,
      pid: process.Id,
      cpuTime: Number(process.CPU || 0),
      memory: Number(process.WorkingSet64 || 0)
    }));
  const battery = (Array.isArray(data.battery) ? data.battery : [data.battery]).filter(Boolean)
    .map((item) => ({
      charge: Number(item.EstimatedChargeRemaining),
      status: Number(item.BatteryStatus)
    }));
  const temperatureSensors = (Array.isArray(data.temperature) ? data.temperature : [data.temperature])
    .map((item) => normalizeTemperatureSensor(item))
    .filter(Boolean);
  const temperatures = temperatureSensors.map((item) => item.celsius);
  const temperatureSources = [
    "Windows ACPI",
    "Windows Thermal Zone",
    "OpenHardwareMonitor",
    "LibreHardwareMonitor"
  ].map((source) => ({
    name: source,
    available: temperatureSensors.some((item) => item.source === source)
  }));
  const security = (Array.isArray(data.security) ? data.security : [data.security]).filter(Boolean)
    .map((item) => ({ name: item.displayName, state: Number(item.productState) }));
  const physicalDisks = (Array.isArray(data.physicalDisks) ? data.physicalDisks : [data.physicalDisks]).filter(Boolean)
    .map((item) => ({
      name: item.FriendlyName,
      health: item.HealthStatus,
      status: Array.isArray(item.OperationalStatus) ? item.OperationalStatus : [item.OperationalStatus],
      mediaType: item.MediaType || "未知介质",
      busType: item.BusType || "未知接口",
      size: Number(item.Size || 0)
    }));
  const hardware = data.hardware ? {
    manufacturer: data.hardware.Manufacturer || data.hardware.manufacturer || "未知厂商",
    model: data.hardware.Model || data.hardware.model || "未知型号",
    memoryBytes: Number(data.hardware.TotalPhysicalMemory || data.hardware.memoryBytes || 0)
  } : { manufacturer: "未知厂商", model: "未知型号", memoryBytes: 0 };
  const bios = data.bios || {};
  const processor = data.processor || {};
  const operatingSystem = data.system || {};
  const systemDrive = disks.find((disk) => disk.name.toUpperCase() === (process.env.SystemDrive || "C:").toUpperCase());
  const systemHealth = {
    bootTime: data.system?.LastBootUpTime || null,
    battery,
    temperatures,
    temperatureSensors,
    temperatureSources,
    temperatureSource: temperatureSensors[0]?.source || null,
    temperatureSupported: temperatureSensors.length > 0,
    temperatureCheckedAt: new Date().toISOString(),
    antivirus: security,
    physicalDisks,
    systemDriveFree: systemDrive?.free ?? null
  };
  const completed = {
    disks,
    processes,
    systemHealth,
    hardware,
    hostInfo: {
      manufacturer: hardware.manufacturer,
      model: hardware.model,
      memoryBytes: hardware.memoryBytes,
      processor: processor.Name || os.cpus()[0]?.model || "未知处理器",
      cores: Number(processor.NumberOfCores || os.cpus().length),
      logicalProcessors: Number(processor.NumberOfLogicalProcessors || os.cpus().length),
      maxClockMHz: Number(processor.MaxClockSpeed || 0),
      currentClockMHz: 0,
      windowsName: `Windows ${operatingSystem.Version || os.release()}`,
      windowsVersion: operatingSystem.Version || os.release(),
      biosVersion: bios.SMBIOSBIOSVersion || "未知",
      diskSpecs: physicalDisks.map((disk) => ({
        name: disk.name,
        mediaType: disk.mediaType,
        busType: disk.busType,
        size: disk.size,
        health: disk.health
      })),
      source: "Windows CIM"
    },
    detailsUpdatedAt: new Date().toISOString(),
    detailsLoading: false,
    detailsError: null
  };
  cachedDetails = completed;
}

function getStats() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const details = mergeHealthCache(cachedDetails);
  const quickSystemHealth = {
    ...details.systemHealth,
    systemDriveFree: details.disks.find((disk) => disk.name.toUpperCase() === "C:")?.free ?? null
  };
  return {
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
    cpu: cpuPercent(),
    memory: {
      total: memoryTotal,
      used: memoryTotal - memoryFree,
      free: memoryFree
    },
    disks: details.disks,
    processes: details.processes,
    hardware: details.hardware,
    hostInfo: details.hostInfo,
    systemHealth: quickSystemHealth,
    detailsUpdatedAt: details.detailsUpdatedAt,
    detailsLoading: details.detailsLoading,
    detailsError: details.detailsError,
    logicalCores: os.cpus().length,
    networkAdapters: Object.values(os.networkInterfaces()).flat().filter(Boolean)
      .filter((item) => !item.internal).length
  };
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/stats") {
    return sendJson(response, getStats());
  }
  if (url.pathname === "/api/health/refresh" && request.method === "POST") {
    refreshDetails();
    return sendJson(response, { ok: true, message: "检测已启动" });
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) return sendJson(response, { error: "Not found" }, 404);
  fs.readFile(file, (error, content) => {
    if (error) return sendJson(response, { error: "Not found" }, 404);
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
    response.writeHead(200, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`PC Observer running at http://${host}:${port}`);
  refreshDetails();
  refreshTemperatureFromMonitor();
  setInterval(refreshDetails, 60_000);
  setInterval(refreshTemperatureFromMonitor, 3_000);
});
