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
let processRefreshRunning = false;
let processSamples = new Map();
let processDataUpdatedAt = 0;
let ecoModeState = { active: false, startedAt: null, adjusted: [] };
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

function normalizeProcessSnapshot(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => ({
    name: String(item.Name ?? item.name ?? "未知进程"),
    pid: Number(item.Id ?? item.pid),
    cpuTime: Number(item.CPU ?? item.cpuTime ?? 0),
    memory: Number(item.WorkingSet64 ?? item.memory ?? 0),
    directCpuPercent: Number(item.CpuPercent ?? item.cpuPercent)
  })).filter((item) => Number.isInteger(item.pid) && item.pid > 0 && Number.isFinite(item.cpuTime));
}

function applyProcessCpuUsage(processes) {
  const now = Date.now();
  const logicalProcessors = Math.max(1, os.cpus().length);
  const nextSamples = new Map();
  const measured = processes.map((item) => {
    const previous = processSamples.get(item.pid);
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    const delta = previous ? item.cpuTime - previous.cpuTime : 0;
    const directCpu = Number(item.directCpuPercent);
    const normalizedDirectCpu = Number.isFinite(directCpu)
      ? (directCpu > 100 ? directCpu / logicalProcessors : directCpu)
      : null;
    const cpuPercent = normalizedDirectCpu != null
      ? Math.max(0, Math.min(100, normalizedDirectCpu))
      : elapsed > 0.2 && delta >= 0
      ? Math.max(0, Math.min(100, delta / elapsed / logicalProcessors * 100))
      : null;
    nextSamples.set(item.pid, { cpuTime: item.cpuTime, at: now });
    return { ...item, cpuPercent };
  });
  processSamples = nextSamples;
  return measured;
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
  const cachedProcesses = Array.isArray(cache.processes) ? cache.processes : [];
  let processes = details.processes;
  if (cache.batteryRead === true) systemHealth.battery = Array.isArray(cache.battery) ? cache.battery : [];
  if (cache.physicalDisksRead === true) {
    systemHealth.physicalDisks = Array.isArray(cache.physicalDisks) ? cache.physicalDisks : [];
  } else if (cache.physicalDisksSampled === true && Array.isArray(cache.physicalDisks)) {
    const liveByName = new Map((systemHealth.physicalDisks || []).map((disk) => [String(disk.name || "").toLowerCase(), disk]));
    systemHealth.physicalDisks = cache.physicalDisks.map((disk) => ({ ...liveByName.get(String(disk.name || "").toLowerCase()), ...disk }));
  }
  if (cache.securityRead === true) systemHealth.antivirus = Array.isArray(cache.antivirus) ? cache.antivirus : [];
  if (!processes?.length && cachedProcesses.length) {
    processes = cachedProcesses;
  } else if (processes?.length && cachedProcesses.length) {
    const cachedCpuByPid = new Map(cachedProcesses.map((item) => [Number(item.pid), item.cpuPercent]));
    processes = processes.map((item) => {
      const cachedCpu = cachedCpuByPid.get(Number(item.pid));
      const hasLiveCpu = item.cpuPercent !== null && item.cpuPercent !== undefined && Number.isFinite(Number(item.cpuPercent));
      const hasCachedCpu = cachedCpu !== null && cachedCpu !== undefined && Number.isFinite(Number(cachedCpu));
      return !hasLiveCpu && hasCachedCpu ? { ...item, cpuPercent: Number(cachedCpu) } : item;
    });
  }
  systemHealth.healthCacheCheckedAt = cache.checkedAt || null;
  let hardware = details.hardware;
  let hostInfo = details.hostInfo;
  if (cache.hardwareRead === true && cache.hardware) {
    hardware = {
      ...hardware,
      manufacturer: cache.hardware.manufacturer || hardware.manufacturer,
      model: cache.hardware.model || hardware.model,
      memoryBytes: Number(cache.hardware.memoryBytes || hardware.memoryBytes || os.totalmem()),
      gpuName: cache.hardware.gpuName || hardware.gpuName || null,
      gpuMemoryBytes: Number(cache.hardware.gpuMemoryBytes || hardware.gpuMemoryBytes || 0),
      gpuDriverVersion: cache.hardware.gpuDriverVersion || hardware.gpuDriverVersion || null,
      memorySpeedMHz: Number(cache.hardware.memorySpeedMHz || hardware.memorySpeedMHz || 0),
      memoryDataRateMTs: Number(cache.hardware.memorySpeedMHz || hardware.memoryDataRateMTs || 0),
      memoryDataRateSource: Number(cache.hardware.memorySpeedMHz) > 0 ? "Windows WMI 配置值" : hardware.memoryDataRateSource || null,
      memoryModuleCount: Number(cache.hardware.memoryModuleCount || hardware.memoryModuleCount || 0)
    };
    hostInfo = {
      ...hostInfo,
      manufacturer: hardware.manufacturer,
      model: hardware.model,
      memoryBytes: hardware.memoryBytes,
      gpuName: hardware.gpuName,
      gpuMemoryBytes: hardware.gpuMemoryBytes,
      gpuDriverVersion: hardware.gpuDriverVersion,
      memorySpeedMHz: hardware.memorySpeedMHz,
      memoryDataRateMTs: hardware.memoryDataRateMTs,
      memoryDataRateSource: hardware.memoryDataRateSource,
      memoryModuleCount: hardware.memoryModuleCount,
      biosVersion: cache.hardware.biosVersion || hostInfo.biosVersion,
      source: "Windows registry + Node.js"
    };
  }
  return { ...details, processes, hardware, hostInfo, systemHealth };
}

function enrichHardwareFromCache(details) {
  const cache = readHealthCache();
  if (!cache) return details;
  const cachedHardware = cache.hardware && typeof cache.hardware === "object" ? cache.hardware : {};
  const cachedSpecs = cache.hardwareSpecs && typeof cache.hardwareSpecs === "object" ? cache.hardwareSpecs : {};
  const hardware = { ...details.hardware };
  const hostInfo = { ...details.hostInfo };
  if (cachedHardware.gpuName) {
    hardware.gpuName = cachedHardware.gpuName;
    hostInfo.gpuName = cachedHardware.gpuName;
    hardware.gpuMemoryBytes = Number(cachedHardware.gpuMemoryBytes || hardware.gpuMemoryBytes || 0);
    hardware.gpuDriverVersion = cachedHardware.gpuDriverVersion || hardware.gpuDriverVersion || null;
    hostInfo.gpuMemoryBytes = hardware.gpuMemoryBytes;
    hostInfo.gpuDriverVersion = hardware.gpuDriverVersion;
  }
  if (Number(cachedHardware.memorySpeedMHz) > 0) {
    hardware.memorySpeedMHz = Number(cachedHardware.memorySpeedMHz);
    hostInfo.memorySpeedMHz = Number(cachedHardware.memorySpeedMHz);
    hardware.memoryDataRateMTs = Number(cachedHardware.memorySpeedMHz);
    hostInfo.memoryDataRateMTs = Number(cachedHardware.memorySpeedMHz);
    hardware.memoryDataRateSource = "Windows WMI 配置值";
    hostInfo.memoryDataRateSource = "Windows WMI 配置值";
  }
  if (Number(cachedSpecs.memorySpeedMHz) > 0 && !hardware.memorySpeedMHz) {
    hardware.memorySpeedMHz = Number(cachedSpecs.memorySpeedMHz);
    hostInfo.memorySpeedMHz = Number(cachedSpecs.memorySpeedMHz);
    hardware.memoryDataRateMTs = Number(cachedSpecs.memorySpeedMHz);
    hostInfo.memoryDataRateMTs = Number(cachedSpecs.memorySpeedMHz);
    hardware.memoryDataRateSource = "Windows WMI 配置值";
    hostInfo.memoryDataRateSource = "Windows WMI 配置值";
  }
  if (Number(cachedHardware.memoryModuleCount) > 0) {
    hardware.memoryModuleCount = Number(cachedHardware.memoryModuleCount);
    hostInfo.memoryModuleCount = Number(cachedHardware.memoryModuleCount);
  }
  if (Number(cachedSpecs.memoryModuleCount) > 0 && !hardware.memoryModuleCount) {
    hardware.memoryModuleCount = Number(cachedSpecs.memoryModuleCount);
    hostInfo.memoryModuleCount = Number(cachedSpecs.memoryModuleCount);
  }
  if (cachedSpecs.memoryModules?.length) {
    hardware.memoryModules = cachedSpecs.memoryModules;
    hostInfo.memoryModules = cachedSpecs.memoryModules;
  }
  if (Number(cachedSpecs.memoryDataRateMTs) > 0 && !hardware.memoryDataRateMTs) {
    hardware.memoryDataRateMTs = Number(cachedSpecs.memoryDataRateMTs);
    hostInfo.memoryDataRateMTs = Number(cachedSpecs.memoryDataRateMTs);
    hardware.memoryDataRateSource = cachedSpecs.memoryDataRateSource || "LibreHardwareMonitor SPD 时序推算";
    hostInfo.memoryDataRateSource = hardware.memoryDataRateSource;
  }
  if (Array.isArray(cachedSpecs.smartDisks)) {
    const physicalDisks = (details.systemHealth.physicalDisks || []).map((disk) => {
      const smart = (cachedSpecs.smartDisks || []).find((item) => {
        if (!item.smartRead) return false;
        const hasSerial = item.serialNumber && disk.serialNumber;
        const hasDeviceId = item.deviceId && disk.deviceId;
        return (item.identity && disk.name && String(item.identity).startsWith("name:") && String(item.name).toLowerCase() === String(disk.name).toLowerCase()) ||
          (hasSerial && String(item.serialNumber) === String(disk.serialNumber)) ||
          (hasDeviceId && String(item.deviceId).toLowerCase() === String(disk.deviceId).toLowerCase()) ||
          (item.name && disk.name && String(item.name).toLowerCase() === String(disk.name).toLowerCase());
      });
      return smart ? { ...disk, ...smart, life: smart.wearPercent != null ? Math.max(0, 100 - Number(smart.wearPercent)) : disk.life } : disk;
    });
    details = { ...details, systemHealth: { ...details.systemHealth, physicalDisks } };
  }
  return { ...details, hardware, hostInfo };
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

function extractMonitorSpecs(node, result = { gpuName: null, memoryModules: [] }) {
  if (!node || typeof node !== "object") return result;
  const hardwareId = String(node.HardwareId || "").toLowerCase();
  if (/^\/gpu-(nvidia|amd|intel)\//.test(hardwareId) && node.Text) result.gpuName = node.Text;
  if (/^\/memory\/dimm\//.test(hardwareId)) {
    const timings = [];
    const collectTimings = (child) => {
      if (!child || typeof child !== "object") return;
      if (/tckavgmin/i.test(String(child.Text || ""))) {
        const cycleNs = Number(String(child.Value || child.RawValue || "").match(/(\d+(?:\.\d+)?)\s*ns/i)?.[1]);
        if (Number.isFinite(cycleNs) && cycleNs > 0) timings.push(cycleNs);
      }
      if (Array.isArray(child.Children)) child.Children.forEach(collectTimings);
    };
    collectTimings(node);
    const minCycleNs = timings.length ? Math.min(...timings) : null;
    result.memoryModules.push({
      name: String(node.Text || "内存模块"),
      hardwareId,
      dataRateMTs: minCycleNs ? Math.round(2000 / minCycleNs) : null
    });
  }
  if (Array.isArray(node.Children)) node.Children.forEach((child) => extractMonitorSpecs(child, result));
  const rates = result.memoryModules.map((item) => Number(item.dataRateMTs)).filter((value) => Number.isFinite(value) && value > 0);
  result.memoryDataRateMTs = rates.length ? Math.max(...rates) : null;
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
    const monitorSpecs = extractMonitorSpecs(tree);
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
    if (monitorSpecs.gpuName || monitorSpecs.memoryModules.length) {
      const hardwareSpecs = {
        ...(monitorSpecs.gpuName ? { gpuName: monitorSpecs.gpuName } : {}),
        ...(monitorSpecs.memoryModules.length ? {
          memoryModules: monitorSpecs.memoryModules,
          memoryModuleCount: monitorSpecs.memoryModules.length,
          memoryModuleNames: monitorSpecs.memoryModules.map((item) => item.name),
          ...(monitorSpecs.memoryDataRateMTs ? {
            memoryDataRateMTs: monitorSpecs.memoryDataRateMTs,
            memoryDataRateSource: "LibreHardwareMonitor SPD 时序推算",
            memorySpeedMHz: monitorSpecs.memoryDataRateMTs
          } : {})
        } : {})
      };
      if (hardwareSpecs.gpuName) {
        hardwareSpecs.gpuMemoryBytes = cachedDetails.hardware.gpuMemoryBytes || 0;
        hardwareSpecs.gpuDriverVersion = cachedDetails.hardware.gpuDriverVersion || null;
      }
      cachedDetails.hardware = { ...cachedDetails.hardware, ...hardwareSpecs };
      cachedDetails.hostInfo = { ...cachedDetails.hostInfo, ...hardwareSpecs };
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
      Select-Object FriendlyName,HealthStatus,OperationalStatus,MediaType,BusType,Size,SerialNumber,UniqueId,DeviceId;
    $hardware = Get-CimInstance Win32_ComputerSystem |
      Select-Object Manufacturer,Model,TotalPhysicalMemory;
    $bios = Get-CimInstance Win32_BIOS |
      Select-Object SMBIOSBIOSVersion,ReleaseDate;
    $processor = Get-CimInstance Win32_Processor |
      Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed;
    $gpu = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -and $_.Name -notmatch 'Basic Display|Remote Display|Indirect Display' } |
      Select-Object -First 1 Name,AdapterRAM,DriverVersion;
    $memoryModules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue |
      Where-Object { [double]$_.Speed -gt 0 } |
      Select-Object Speed,ConfiguredClockSpeed,Manufacturer,PartNumber);
    $memorySpeedMHz = ($memoryModules | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum;
    $processes = Get-Process |
      Where-Object { $_.CPU -ne $null } |
      Sort-Object CPU -Descending |
      Select-Object -First 40 Name,Id,CPU,WorkingSet64;
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
      gpu = $gpu;
      memoryModule = [PSCustomObject]@{ ConfiguredClockSpeed = $memorySpeedMHz; Speed = ($memoryModules | Measure-Object -Property Speed -Maximum).Maximum; ModuleCount = $memoryModules.Count };
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
  const processes = applyProcessCpuUsage(normalizeProcessSnapshot(data.processes));
  const processSnapshotAt = Date.now();
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
      size: Number(item.Size || 0),
      serialNumber: item.SerialNumber || null,
      uniqueId: item.UniqueId || null,
      deviceId: item.DeviceId || null,
      smartRead: item.smartRead === true,
      temperatureCelsius: item.temperatureCelsius != null ? Number(item.temperatureCelsius) : null,
      wearPercent: item.wearPercent != null ? Number(item.wearPercent) : null,
      powerOnHours: item.powerOnHours != null ? Number(item.powerOnHours) : null,
      smartReason: item.smartReason || null
    }));
  const hardware = data.hardware ? {
    manufacturer: data.hardware.Manufacturer || data.hardware.manufacturer || "未知厂商",
    model: data.hardware.Model || data.hardware.model || "未知型号",
    memoryBytes: Number(data.hardware.TotalPhysicalMemory || data.hardware.memoryBytes || 0)
  } : { manufacturer: "未知厂商", model: "未知型号", memoryBytes: 0 };
  const bios = data.bios || {};
  const processor = data.processor || {};
  const gpu = data.gpu || {};
  const memoryModule = data.memoryModule || {};
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
      gpuName: gpu.Name || null,
      gpuMemoryBytes: Number(gpu.AdapterRAM || 0),
      gpuDriverVersion: gpu.DriverVersion || null,
      memorySpeedMHz: Number(memoryModule.ConfiguredClockSpeed || memoryModule.Speed || 0),
      memoryDataRateMTs: Number(memoryModule.ConfiguredClockSpeed || memoryModule.Speed || 0),
      memoryDataRateSource: Number(memoryModule.ConfiguredClockSpeed || memoryModule.Speed) > 0 ? "Windows WMI 配置值" : null,
      memoryModuleCount: Number(memoryModule.ModuleCount || 0),
      diskSpecs: physicalDisks.map((disk) => ({
        name: disk.name,
        mediaType: disk.mediaType,
        busType: disk.busType,
        size: disk.size,
        health: disk.health,
        serialNumber: disk.serialNumber,
        uniqueId: disk.uniqueId,
        deviceId: disk.deviceId
      })),
      source: "Windows CIM"
    },
    detailsUpdatedAt: new Date().toISOString(),
    detailsLoading: false,
    detailsError: null
  };
  cachedDetails = {
    ...completed,
    hardware: { ...completed.hardware, ...cachedDetails.hardware },
    hostInfo: { ...completed.hostInfo, ...cachedDetails.hostInfo },
    systemHealth: {
      ...completed.systemHealth,
      ...cachedDetails.systemHealth,
      physicalDisks: cachedDetails.systemHealth.physicalDisks?.length
        ? cachedDetails.systemHealth.physicalDisks
        : completed.systemHealth.physicalDisks
    },
    processes: processDataUpdatedAt > processSnapshotAt ? cachedDetails.processes : processes
  };
}

async function refreshProcesses() {
  if (processRefreshRunning) return;
  processRefreshRunning = true;
  const ps = `
    $perfByPid = @{};
    try {
      Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop |
        ForEach-Object { $perfByPid[[int]$_.IDProcess] = [double]$_.PercentProcessorTime }
    } catch {}
    $processes = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CPU -ne $null } |
      Sort-Object CPU -Descending |
      Select-Object -First 40 |
      ForEach-Object {
        $cpuPercent = if ($perfByPid.ContainsKey($_.Id)) { $perfByPid[$_.Id] } else { $null };
        [PSCustomObject]@{ Name = $_.Name; Id = $_.Id; CPU = $_.CPU; WorkingSet64 = $_.WorkingSet64; CpuPercent = $cpuPercent }
      };
    @($processes) | ConvertTo-Json -Depth 3 -Compress
  `;
  try {
    const raw = await powershell(ps);
    const processes = applyProcessCpuUsage(normalizeProcessSnapshot(JSON.parse(raw)));
    if (processes.length) {
      processDataUpdatedAt = Date.now();
      cachedDetails = { ...cachedDetails, processes };
    }
  } catch {
    // Keep the previous process snapshot when a transient process query fails.
  } finally {
    processRefreshRunning = false;
  }
}

function getStats() {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const details = enrichHardwareFromCache(mergeHealthCache(cachedDetails));
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
    hardwareSpecs: (() => {
      const cache = readHealthCache();
      return cache?.hardwareSpecs ? { ...cache.hardwareSpecs, smartChecked: cache.hardwareSpecs.smartChecked === true } : null;
    })(),
    ecoMode: { ...ecoModeState },
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

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 32 * 1024) reject(new Error("请求内容过大"));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("请求数据格式错误")); }
    });
    request.on("error", reject);
  });
}

async function terminateObservedProcesses(pids) {
  const requested = [...new Set((Array.isArray(pids) ? pids : []).map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!requested.length || requested.length > 40) {
    return { status: 400, body: { ok: false, message: "请选择有效的进程" } };
  }
  const tracked = new Map(cachedDetails.processes.map((item) => [Number(item.pid), item]));
  const untracked = requested.filter((pid) => !tracked.has(pid));
  if (untracked.length) {
    return { status: 400, body: { ok: false, message: "进程已不在当前观察列表，请刷新后重试" } };
  }
  const protectedNames = /^(idle|system|registry|smss|csrss|wininit|services|lsass|svchost|dwm|winlogon)$/i;
  const blocked = requested.filter((pid) => pid === process.pid || protectedNames.test(tracked.get(pid)?.name || ""));
  if (blocked.length) {
    return { status: 403, body: { ok: false, message: "系统进程或观察器进程不能通过此按钮结束" } };
  }
  const idList = requested.join(",");
  const script = `
    $ids = @(${idList});
    $results = foreach ($id in $ids) {
      try {
        $item = Get-Process -Id $id -ErrorAction Stop;
        $name = $item.ProcessName;
        Stop-Process -Id $id -Force -ErrorAction Stop;
        [PSCustomObject]@{ pid = $id; name = $name; ok = $true; message = "已结束" }
      } catch {
        [PSCustomObject]@{ pid = $id; name = ""; ok = $false; message = $_.Exception.Message }
      }
    };
    @($results) | ConvertTo-Json -Depth 3 -Compress
  `;
  try {
    const parsed = JSON.parse(await powershell(script));
    const results = Array.isArray(parsed) ? parsed : [parsed];
    const terminated = results.filter((item) => item && item.ok).map((item) => Number(item.pid));
    if (terminated.length) {
      cachedDetails = { ...cachedDetails, processes: cachedDetails.processes.filter((item) => !terminated.includes(Number(item.pid))) };
      terminated.forEach((pid) => processSamples.delete(pid));
      setTimeout(refreshProcesses, 150);
    }
    return {
      status: 200,
      body: {
        ok: terminated.length > 0,
        terminated,
        failed: results.filter((item) => item && !item.ok).map((item) => ({ pid: Number(item.pid), message: item.message })),
        message: terminated.length ? `已结束 ${terminated.length} 个进程` : "进程未结束，可能权限不足或已退出"
      }
    };
  } catch (error) {
    return { status: 500, body: { ok: false, message: `结束进程失败：${error.message}` } };
  }
}

async function setEcoMode(enabled, pids, limitProcesses = true) {
  if (!enabled) {
    const adjusted = ecoModeState.adjusted;
    if (!adjusted.length) {
      ecoModeState = { active: false, startedAt: null, adjusted: [] };
      return { status: 200, body: { ok: true, message: "节能模式已退出", ecoMode: ecoModeState } };
    }
    const script = `
      $items = ConvertFrom-Json -InputObject '${JSON.stringify(adjusted).replace(/'/g, "''")}';
      $results = foreach ($entry in @($items)) {
        try {
          $process = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop;
          if ($process.ProcessName -ne [string]$entry.name) { throw '进程标识已变化' }
          $process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]([int]$entry.previousPriority);
          [PSCustomObject]@{ pid = [int]$entry.pid; ok = $true }
        } catch { [PSCustomObject]@{ pid = [int]$entry.pid; ok = $false; message = $_.Exception.Message } }
      };
      @($results) | ConvertTo-Json -Compress
    `;
    try {
      const results = JSON.parse(await powershell(script));
      const list = Array.isArray(results) ? results : [results];
      const failedPids = new Set(list.filter((item) => !item.ok).map((item) => Number(item.pid)));
      ecoModeState = {
        active: failedPids.size > 0,
        startedAt: failedPids.size ? ecoModeState.startedAt : null,
        adjusted: adjusted.filter((item) => failedPids.has(Number(item.pid)))
      };
      const failed = list.filter((item) => !item.ok);
      return { status: 200, body: { ok: failed.length === 0, message: failed.length ? `已恢復 ${list.length - failed.length} 個進程，${failed.length} 個進程無法恢復` : "節能模式已退出，進程优先级已恢复", ecoMode: ecoModeState, failed } };
    } catch (error) {
      return { status: 500, body: { ok: false, message: `恢复进程优先级失败：${error.message}`, ecoMode: ecoModeState } };
    }
  }

  if (ecoModeState.active) {
    return { status: 409, body: { ok: false, message: "节能模式已经启用", ecoMode: ecoModeState } };
  }
  const requested = limitProcesses
    ? [...new Set((Array.isArray(pids) ? pids : []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
    : [];
  if (requested.length > 40) return { status: 400, body: { ok: false, message: "一次最多选择 40 个进程" } };
  const tracked = new Map(cachedDetails.processes.map((item) => [Number(item.pid), item]));
  const missing = requested.filter((pid) => !tracked.has(pid));
  if (missing.length) return { status: 400, body: { ok: false, message: "部分进程已退出，请刷新列表后重试" } };
  const protectedNames = /^(idle|system|registry|smss|csrss|wininit|services|lsass|svchost|dwm|winlogon|explorer)$/i;
  const unsafe = requested.filter((pid) => pid === process.pid || protectedNames.test(tracked.get(pid)?.name || ""));
  if (unsafe.length) return { status: 403, body: { ok: false, message: "系统关键进程不能设置为节能目标" } };
  if (!requested.length) {
    ecoModeState = { active: true, startedAt: new Date().toISOString(), adjusted: [] };
    return { status: 200, body: { ok: true, message: "节能模式已启用；未选择高耗能进程，本次未调整进程优先级", ecoMode: ecoModeState } };
  }
  const idList = requested.join(",");
  const script = `
    $ids = @(${idList});
    $results = foreach ($id in $ids) {
      try {
        $item = Get-Process -Id $id -ErrorAction Stop;
        $name = $item.ProcessName;
        $previousPriority = [int]$item.PriorityClass;
        if ($previousPriority -eq [int][System.Diagnostics.ProcessPriorityClass]::Idle) { throw '进程已处于最低优先级' }
        $item.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal;
        [PSCustomObject]@{ pid = $id; name = $name; previousPriority = $previousPriority; ok = $true }
      } catch { [PSCustomObject]@{ pid = $id; name = ''; ok = $false; message = $_.Exception.Message } }
    };
    @($results) | ConvertTo-Json -Depth 4 -Compress
  `;
  try {
    const result = JSON.parse(await powershell(script));
    const list = Array.isArray(result) ? result : [result];
    const adjusted = list.filter((item) => item && item.ok).map(({ pid, name, previousPriority }) => ({ pid: Number(pid), name: String(name), previousPriority: Number(previousPriority) }));
    const failed = list.filter((item) => item && !item.ok);
    if (failed.length && adjusted.length) {
      const restore = `
        $items = ConvertFrom-Json -InputObject '${JSON.stringify(adjusted).replace(/'/g, "''")}';
        foreach ($entry in @($items)) {
          try {
            $item = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop;
            if ($item.ProcessName -eq [string]$entry.name) { $item.PriorityClass = [System.Diagnostics.ProcessPriorityClass]([int]$entry.previousPriority) }
          } catch {}
        }
      `;
      await powershell(restore);
      return { status: 500, body: { ok: false, message: `部分进程无法限制，已回滚本次调整：${failed.map((item) => item.message).join("；")}`, ecoMode: ecoModeState, failed } };
    }
    ecoModeState = { active: adjusted.length > 0, startedAt: adjusted.length ? new Date().toISOString() : null, adjusted };
    return {
      status: adjusted.length ? 200 : 500,
      body: {
        ok: adjusted.length > 0,
        message: adjusted.length ? `节能模式已启用，已限制 ${adjusted.length} 个进程；进程未关闭` : "未能调整进程优先级，可能需要以管理员身份运行",
        ecoMode: ecoModeState,
        failed
      }
    };
  } catch (error) {
    return { status: 500, body: { ok: false, message: `启用节能模式失败：${error.message}`, ecoMode: ecoModeState } };
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/stats") {
    return sendJson(response, getStats());
  }
  if (url.pathname === "/api/process/terminate" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const result = await terminateObservedProcesses(payload.pids);
      return sendJson(response, result.body, result.status);
    } catch (error) {
      return sendJson(response, { ok: false, message: error.message }, 400);
    }
  }
  if (url.pathname === "/api/eco-mode" && request.method === "POST") {
    try {
      const payload = await readJson(request);
      const result = await setEcoMode(payload.enabled === true, payload.pids, payload.limitProcesses !== false);
      return sendJson(response, result.body, result.status);
    } catch (error) {
      return sendJson(response, { ok: false, message: error.message }, 400);
    }
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
  refreshProcesses();
  refreshTemperatureFromMonitor();
  setInterval(refreshDetails, 60_000);
  setInterval(refreshProcesses, 3_000);
  setInterval(refreshTemperatureFromMonitor, 3_000);
});
