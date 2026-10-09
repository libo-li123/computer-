const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const healthCachePath = path.join(root, "health-cache.json");
const authConfigPath = path.join(root, "auth-config.json");
const loginInfoPath = path.join(root, "登录信息.txt");
const sessionCookieName = "pc_observer_session";
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function updateLoginInfoAddress() {
  try {
    const current = fs.readFileSync(loginInfoPath, "utf8");
    const updated = current.replace(/登录地址：[^\r\n]+/, `登录地址：http://127.0.0.1:${port}/`);
    if (updated !== current) fs.writeFileSync(loginInfoPath, updated, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

function loadOrCreateAuthConfig() {
  const environmentPassword = String(process.env.PC_OBSERVER_PASSWORD || "");
  const environmentUsername = String(process.env.PC_OBSERVER_USERNAME || "admin").trim() || "admin";
  if (environmentPassword) {
    const salt = crypto.randomBytes(16).toString("hex");
    return { username: environmentUsername, salt, passwordHash: passwordHash(environmentPassword, salt) };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(authConfigPath, "utf8"));
    if (saved.username && saved.salt && saved.passwordHash) {
      updateLoginInfoAddress();
      return saved;
    }
  } catch {}
  const username = "admin";
  const password = crypto.randomBytes(12).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const config = { username, salt, passwordHash: passwordHash(password, salt) };
  fs.writeFileSync(authConfigPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(loginInfoPath, `电脑健康检测平台登录信息\r\n\r\n账号：${username}\r\n密码：${password}\r\n\r\n登录地址：http://127.0.0.1:${port}/\r\n`, { encoding: "utf8", mode: 0o600 });
  return config;
}

const authConfig = loadOrCreateAuthConfig();

function requestCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((item) => {
    const index = item.indexOf("=");
    if (index < 0) return ["", ""];
    const raw = item.slice(index + 1).trim();
    try { return [item.slice(0, index).trim(), decodeURIComponent(raw)]; }
    catch { return [item.slice(0, index).trim(), raw]; }
  }).filter(([name]) => name));
}

function requestSession(request) {
  const token = requestCookies(request)[sessionCookieName];
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function credentialsMatch(username, password) {
  if (String(username) !== authConfig.username || typeof password !== "string") return false;
  const expected = Buffer.from(authConfig.passwordHash, "hex");
  const actual = Buffer.from(passwordHash(password, authConfig.salt), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function loginAttemptState(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { key, count: 0, resetAt: now + 10 * 60 * 1000 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return { key, ...current };
}

function sendRedirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}
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

async function readBiosVersion() {
  const script = `
    $version = '';
    try {
      $biosKey = Get-ItemProperty -LiteralPath 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\BIOS' -ErrorAction Stop;
      if ($biosKey.BIOSVersion) { $version = [string]$biosKey.BIOSVersion }
    } catch {}
    if (-not $version) {
      try {
        $legacySystem = Get-ItemProperty -LiteralPath 'HKLM:\\HARDWARE\\DESCRIPTION\\System' -ErrorAction Stop;
        $legacyVersion = @($legacySystem.SystemBiosVersion) | Where-Object { $_ -match '^[A-Za-z0-9._-]{4,}$' } | Select-Object -First 1;
        if ($legacyVersion) { $version = [string]$legacyVersion }
      } catch {}
    }
    if (-not $version) {
      try {
        $systemInformation = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation' -ErrorAction Stop;
        if ($systemInformation.BIOSVersion) { $version = [string]$systemInformation.BIOSVersion }
      } catch {}
    }
    Write-Output $version;
  `;
  try {
    return (await powershell(script)).trim();
  } catch {
    return "";
  }
}

// Runs a PowerShell script whose result is written to a file. Nothing is captured through
// stdout, so the result is never affected by the console code page.
function powershellToFile(script, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: "ignore"
    });
    const timer = setTimeout(() => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
      reject(new Error("采样超时"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PowerShell 退出码 ${code}`));
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

const DISK_SMART_NUMERIC_FIELDS = [
  "temperatureCelsius", "wearPercent", "powerOnHours", "life", "availableSpare",
  "dataWrittenBytes", "powerOnCount"
];

function diskKeyOf(disk) {
  if (!disk) return null;
  const serial = disk.serialNumber && String(disk.serialNumber).trim();
  if (serial) return `serial:${serial.toLowerCase()}`;
  const name = disk.name && String(disk.name).trim();
  if (name) return `name:${name.toLowerCase()}`;
  const deviceId = disk.deviceId && String(disk.deviceId).trim();
  return deviceId ? `device:${deviceId.toLowerCase()}` : null;
}

function sameDisk(left, right) {
  if (!left || !right) return false;
  const leftKey = diskKeyOf(left);
  const rightKey = diskKeyOf(right);
  if (leftKey && rightKey && leftKey === rightKey) return true;
  const leftName = left.name && String(left.name).trim().toLowerCase();
  const rightName = right.name && String(right.name).trim().toLowerCase();
  return Boolean(leftName && rightName && (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName)));
}

// Merge one disk record into another without letting an empty reading erase real data.
function mergeDiskRecords(live = {}, extra = {}) {
  const merged = { ...live, ...extra };
  for (const key of DISK_SMART_NUMERIC_FIELDS) {
    const value = extra[key] != null && extra[key] !== "" ? extra[key] : live[key];
    merged[key] = value != null && value !== "" ? value : null;
  }
  // Identity/health fields: whatever the operating system reports stays authoritative.
  for (const key of ["name", "health", "status", "mediaType", "busType", "size", "serialNumber", "deviceId", "uniqueId"]) {
    const liveValue = live[key];
    const liveEmpty = liveValue == null || liveValue === "" || (Array.isArray(liveValue) && !liveValue.length);
    if (!liveEmpty) merged[key] = liveValue;
  }
  merged.smartRead = live.smartRead === true || extra.smartRead === true;
  merged.smartSource = extra.smartSource || live.smartSource || null;
  merged.smartReason = merged.smartRead
    ? null
    : (extra.smartReason && !extra.smartRead ? extra.smartReason : null) || live.smartReason || null;
  return merged;
}

function mergeDiskLists(liveList, extraList) {
  const live = Array.isArray(liveList) ? liveList.filter(Boolean) : [];
  const extra = Array.isArray(extraList) ? extraList.filter(Boolean) : [];
  if (!live.length) return extra;
  if (!extra.length) return live;
  const used = new Set();
  const merged = live.map((disk) => {
    const index = extra.findIndex((item, position) => !used.has(position) && sameDisk(disk, item));
    if (index < 0) return disk;
    used.add(index);
    return mergeDiskRecords(disk, extra[index]);
  });
  extra.forEach((item, position) => {
    if (!used.has(position)) merged.push(item);
  });
  return merged;
}

function matchSmartEntry(smartDisks, disk) {
  const list = Array.isArray(smartDisks) ? smartDisks : [];
  return list.find((item) => item && sameDisk(disk, item)) || null;
}

function mergeHealthCache(details) {
  const cache = readHealthCache();
  if (!cache) return details;
  const systemHealth = { ...details.systemHealth };
  const cachedProcesses = Array.isArray(cache.processes) ? cache.processes : [];
  let processes = details.processes;
  if (cache.batteryRead === true) systemHealth.battery = Array.isArray(cache.battery) ? cache.battery : [];
  const cachedDisks = Array.isArray(cache.physicalDisks) ? cache.physicalDisks.filter(Boolean) : [];
  if (cachedDisks.length) {
    // The health helper may only be able to read part of the reliability data, so merge
    // instead of replacing: live sensor readings must survive a partial cache write.
    systemHealth.physicalDisks = mergeDiskLists(systemHealth.physicalDisks, cachedDisks);
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
  const cachedBiosVersion = String(cache.hardware?.biosVersion || "").trim();
  if (cachedBiosVersion && cachedBiosVersion !== "正在读取") {
    hardware = { ...hardware, biosVersion: cachedBiosVersion };
    hostInfo = { ...hostInfo, biosVersion: cachedBiosVersion };
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
  const cachedSmartDisks = Array.isArray(cachedSpecs.smartDisks) ? cachedSpecs.smartDisks.filter(Boolean) : [];
  if (cachedSmartDisks.length) {
    const physicalDisks = (details.systemHealth.physicalDisks || []).map((disk) => {
      const smart = matchSmartEntry(cachedSmartDisks, disk);
      if (!smart) return disk;
      const merged = mergeDiskRecords(disk, smart);
      if (merged.life == null && merged.wearPercent != null) {
        merged.life = Math.max(0, 100 - Number(merged.wearPercent));
      }
      return merged;
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
      const usedPercent = parseMetric(metrics["Percentage Used"], "%");
      const temperature = parseMetric(metrics["Composite Temperature"], "°C") ?? parseMetric(metrics.Temperature, "°C");
      const powerOnHours = parseMetric(metrics["Power On Hours"], "");
      const powerOnCount = parseMetric(metrics["Power On Count"], "");
      const dataWrittenGB = parseMetric(metrics["Data Written"], "GB");
      const totalSpaceGB = parseMetric(metrics["Total Space"], "GB");
      const readable = [life, spare, usedPercent, temperature, powerOnHours].some((value) => Number.isFinite(value));
      if (readable) {
        const healthValue = Number.isFinite(life) ? life : Number.isFinite(spare) ? spare : 100;
        const wearPercent = Number.isFinite(usedPercent)
          ? usedPercent
          : Number.isFinite(life) ? Math.max(0, 100 - life) : null;
        result.physicalDisks.push({
          name: node.Text || "存储设备",
          health: healthValue >= 80 ? "Healthy" : healthValue >= 20 ? "Warning" : "Critical",
          status: [healthValue >= 80 ? "OK" : "Degraded"],
          mediaType: "SSD",
          busType: hardwareId.startsWith("/nvme/") ? "NVMe" : "未知接口",
          size: Number.isFinite(totalSpaceGB) ? totalSpaceGB * 1024 ** 3 : null,
          life: Number.isFinite(life) ? life : null,
          availableSpare: Number.isFinite(spare) ? spare : null,
          wearPercent,
          temperatureCelsius: Number.isFinite(temperature) ? temperature : null,
          powerOnHours: Number.isFinite(powerOnHours) ? powerOnHours : null,
          powerOnCount: Number.isFinite(powerOnCount) ? powerOnCount : null,
          dataWrittenBytes: Number.isFinite(dataWrittenGB) ? dataWrittenGB * 1024 ** 3 : null,
          smartRead: true,
          smartSource: "LibreHardwareMonitor",
          smartReason: null,
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

function findGpuMemoryBytes(node) {
  if (!node || typeof node !== "object") return null;
  let total = null;
  const walk = (current) => {
    if (!current || typeof current !== "object") return;
    if (/^gpu memory total$/i.test(String(current.Text || ""))) {
      const megabytes = parseMetric(current.Value, "MB");
      if (Number.isFinite(megabytes) && megabytes > 0) {
        total = Math.max(total ?? 0, megabytes * 1024 ** 2);
      }
    }
    if (Array.isArray(current.Children)) current.Children.forEach(walk);
  };
  walk(node);
  return total;
}

function extractMonitorSpecs(node, result = { gpuName: null, gpuMemoryBytes: null, memoryModules: [] }) {
  if (!node || typeof node !== "object") return result;
  const hardwareId = String(node.HardwareId || "").toLowerCase();
  if (/^\/gpu-(nvidia|amd|intel)\//.test(hardwareId) && node.Text) {
    result.gpuName = node.Text;
    const memoryBytes = findGpuMemoryBytes(node);
    if (Number.isFinite(memoryBytes) && memoryBytes > 0) result.gpuMemoryBytes = memoryBytes;
  }
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
    const monitorNetworkAdapters = readMonitorNetworkAdapters(tree);
    const measuredClockMHz = monitorClock.values.length
      ? monitorClock.values.reduce((sum, value) => sum + value, 0) / monitorClock.values.length
      : 0;
    const currentClockMHz = Number.isFinite(measuredClockMHz) && measuredClockMHz > 0
      ? measuredClockMHz
      : 0;
    const temperatures = sensors.map((sensor) => sensor.celsius);
    const liveMonitorDisks = monitorHealth.physicalDisks.length
      ? mergeDiskLists(cachedDetails.systemHealth.physicalDisks || [], monitorHealth.physicalDisks)
      : null;
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
      ...(liveMonitorDisks ? {
        physicalDisks: liveMonitorDisks,
        smartCheckedAt: new Date().toISOString(),
        smartSource: "LibreHardwareMonitor"
      } : {}),
      ...(monitorNetworkAdapters.length ? {
        networkAdapters: monitorNetworkAdapters,
        networkCheckedAt: new Date().toISOString()
      } : {})
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
        hardwareSpecs.gpuMemoryBytes = monitorSpecs.gpuMemoryBytes || cachedDetails.hardware.gpuMemoryBytes || 0;
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

// ---------------------------------------------------------------------------
// Network bandwidth monitoring
// Rates come from the Windows performance counters (PDH, no WMI required) and
// per-process attribution uses the process "other I/O" counter, which covers
// socket traffic (plus pipes and other device I/O) without needing elevation.
// The sampler script stays pure ASCII and writes its result as UTF-8 to a file,
// so no text ever depends on the console code page.
// ---------------------------------------------------------------------------
const NETWORK_SAMPLE_INTERVAL_MS = 6000;
const NETWORK_CACHE_FILE = "network-cache.json";
const VIRTUAL_INTERFACE_PATTERN = /loopback|pseudo|isatap|teredo|6to4|tunnel|vethernet|hyper-v|vmware|virtualbox|virtual|tap-|wintun|wireguard|openvpn|tailscale|zerotier|clash|proxy|npcap|docker|wsl|bluetooth|direct|本地连接|蓝牙/i;
const NETWORK_PS = `
  $counters = @(
    '\\Network Interface(*)\\Bytes Received/sec',
    '\\Network Interface(*)\\Bytes Sent/sec',
    '\\Process(*)\\IO Other Bytes/sec',
    '\\Process(*)\\ID Process'
  );
  $source = 'pdh';
  $counterError = $null;
  $network = @();
  $processes = @();
  try {
    # A single collection is normally enough because Windows keeps the previous raw
    # sample for every counter; fall back to two samples when that is unavailable.
    $samples = @(Get-Counter -Counter $counters -MaxSamples 1 -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty CounterSamples -ErrorAction SilentlyContinue);
    $networkReady = @($samples | Where-Object { $_.Status -eq 0 -and $_.Path -like '*Network Interface*' }).Count -gt 0;
    if (-not $networkReady) {
      $samples = @(Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples 2 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty CounterSamples -ErrorAction SilentlyContinue);
    }
    $latest = @{};
    foreach ($item in $samples) {
      if ($item.Status -ne 0) { continue }
      $latest[$item.Path] = $item
    }
    $pidByInstance = @{};
    foreach ($item in $latest.Values) {
      if ($item.Path -match '\\\\process\\((.+)\\)\\\\id process$') { $pidByInstance[$matches[1]] = [int]$item.CookedValue }
    }
    foreach ($item in $latest.Values) {
      if ($item.Path -like '*Network Interface*') {
        if ($item.Path -like '*Bytes Received/sec*') {
          $network += [PSCustomObject]@{ instance = $item.InstanceName; metric = 'received'; bytesPerSecond = [double]$item.CookedValue }
        } elseif ($item.Path -like '*Bytes Sent/sec*') {
          $network += [PSCustomObject]@{ instance = $item.InstanceName; metric = 'sent'; bytesPerSecond = [double]$item.CookedValue }
        }
      } elseif ($item.Path -like '*IO Other Bytes/sec*') {
        $instanceKey = $null;
        if ($item.Path -match '\\\\process\\((.+)\\)\\\\io other bytes/sec$') { $instanceKey = $matches[1] }
        $processId = if ($instanceKey -and $pidByInstance.ContainsKey($instanceKey)) { [int]$pidByInstance[$instanceKey] } else { 0 }
        if ($processId -eq $PID) { continue }
        $processes += [PSCustomObject]@{ instance = $item.InstanceName; pid = $processId; bytesPerSecond = [double]$item.CookedValue }
      }
    }
  } catch { $source = $null; $counterError = $_.Exception.Message }
  if (-not $network.Count) { $source = $null }
  $receivedBytes = $null;
  $sentBytes = $null;
  try {
    $stats = @(netstat -e 2>$null | Where-Object { $_ -match '^\\s*Bytes\\s+(\\d+)\\s+(\\d+)\\s*$' });
    if ($stats.Count) {
      $null = $stats[0] -match '^\\s*Bytes\\s+(\\d+)\\s+(\\d+)\\s*$';
      $receivedBytes = [double]$matches[1];
      $sentBytes = [double]$matches[2];
    }
  } catch {}
  $connections = @();
  try {
    $connections += @(netstat -ano -p TCP 2>$null | ForEach-Object {
      if ($_ -match '^\\s*TCP\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\d+)\\s*$') {
        [PSCustomObject]@{ proto = 'TCP'; local = $matches[1]; remote = $matches[2]; state = $matches[3]; pid = [int]$matches[4] }
      }
    })
  } catch {}
  try {
    $connections += @(netstat -ano -p UDP 2>$null | ForEach-Object {
      if ($_ -match '^\\s*UDP\\s+(\\S+)\\s+(\\S+)\\s+(\\d+)\\s*$') {
        [PSCustomObject]@{ proto = 'UDP'; local = $matches[1]; remote = $matches[2]; state = '-'; pid = [int]$matches[3] }
      }
    })
  } catch {}
  $names = @();
  try {
    $names = @(Get-Process -ErrorAction Stop | ForEach-Object { [PSCustomObject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName } })
  } catch {}
  $payload = [PSCustomObject]@{
    sampledAt = [DateTime]::UtcNow.ToString('o');
    source = $source;
    selfPid = $PID;
    counterError = $counterError;
    network = @($network);
    processes = @($processes);
    connections = @($connections);
    names = @($names);
    totals = [PSCustomObject]@{ receivedBytes = $receivedBytes; sentBytes = $sentBytes };
  };
  Set-Content -LiteralPath '__OUTPUT_FILE__' -Value ($payload | ConvertTo-Json -Depth 4 -Compress) -Encoding UTF8;
`;
let networkRefreshRunning = false;
let networkTotals = null;
let networkTotalsAt = 0;
const networkState = {
  checkedAt: null,
  sampledSeconds: null,
  source: null,
  processRateSource: null,
  error: null,
  downloadBytesPerSecond: null,
  uploadBytesPerSecond: null,
  adapters: [],
  groups: []
};

function titleCaseInterfaceName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|\s)([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function isExternalRemote(remote) {
  const text = String(remote || "").trim();
  if (!text || text === "*:*" || text === "*") return false;
  if (/^0\.0\.0\.0:0$/.test(text) || /^\[::\]:0$/.test(text)) return false;
  const host = text.replace(/:\d+$/, "");
  if (/^(127\.|::1$|\[::1\])/.test(host)) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    // Private peers are still worth listing, they just are not internet endpoints.
    return true;
  }
  return true;
}

function processNameFromInstance(instance) {
  return String(instance || "").replace(/#\d+$/, "").trim();
}

function buildNetworkSample(raw = {}) {
  const entries = Array.isArray(raw.network) ? raw.network : [];
  const adapterMap = new Map();
  for (const entry of entries) {
    const name = String(entry.instance || "").trim();
    if (!name) continue;
    const current = adapterMap.get(name) || {
      name,
      displayName: titleCaseInterfaceName(name),
      virtual: VIRTUAL_INTERFACE_PATTERN.test(name),
      downloadBytesPerSecond: 0,
      uploadBytesPerSecond: 0
    };
    if (entry.metric === "received") current.downloadBytesPerSecond = Math.max(0, Number(entry.bytesPerSecond) || 0);
    if (entry.metric === "sent") current.uploadBytesPerSecond = Math.max(0, Number(entry.bytesPerSecond) || 0);
    adapterMap.set(name, current);
  }
  const adapters = [...adapterMap.values()]
    .sort((left, right) => (right.downloadBytesPerSecond + right.uploadBytesPerSecond) - (left.downloadBytesPerSecond + left.uploadBytesPerSecond));
  const physicalAdapters = adapters.filter((adapter) => !adapter.virtual);
  const physicalActive = physicalAdapters.some((adapter) => adapter.downloadBytesPerSecond + adapter.uploadBytesPerSecond > 0);
  const countedAdapters = physicalActive || !physicalAdapters.length ? physicalAdapters : adapters;
  const downloadBytesPerSecond = countedAdapters.length
    ? countedAdapters.reduce((sum, adapter) => sum + adapter.downloadBytesPerSecond, 0)
    : null;
  const uploadBytesPerSecond = countedAdapters.length
    ? countedAdapters.reduce((sum, adapter) => sum + adapter.uploadBytesPerSecond, 0)
    : null;

  const nameByPid = new Map();
  for (const item of (Array.isArray(raw.names) ? raw.names : [])) {
    const pid = Number(item?.pid);
    if (Number.isInteger(pid) && pid > 0) nameByPid.set(pid, String(item.name || ""));
  }
  const groups = new Map();
  const ensureGroup = (name) => {
    const label = String(name || "").trim() || "未知进程";
    const key = label.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { name: label, bytesPerSecond: 0, connections: 0, established: 0, pids: [], rates: new Map(), peers: new Map() });
    }
    return groups.get(key);
  };
  const selfPid = Number(raw.selfPid);
  const observerPid = process.pid;
  for (const item of (Array.isArray(raw.processes) ? raw.processes : [])) {
    const name = processNameFromInstance(item?.instance);
    if (!name || /^(_total|idle|memory compression)$/i.test(name)) continue;
    const pid = Number(item?.pid);
    // The sampler itself (while it reads its own output) and the observer's own process
    // only generate local dashboard traffic, so they are skipped.
    if (Number.isInteger(pid) && pid > 0 && (pid === selfPid || pid === observerPid)) continue;
    const bytes = Math.max(0, Number(item.bytesPerSecond) || 0);
    if (!bytes) continue;
    const group = ensureGroup(name);
    group.bytesPerSecond += bytes;
    if (Number.isInteger(pid) && pid > 0) {
      group.rates.set(pid, (group.rates.get(pid) || 0) + bytes);
      if (!group.pids.includes(pid)) group.pids.push(pid);
    }
  }
  for (const connection of (Array.isArray(raw.connections) ? raw.connections : [])) {
    const pid = Number(connection?.pid);
    const name = nameByPid.get(pid);
    if (!name) continue;
    const group = ensureGroup(name);
    if (!group.pids.includes(pid)) group.pids.push(pid);
    if (!isExternalRemote(connection.remote)) continue;
    const remote = String(connection.remote);
    group.connections += 1;
    if (/^established$/i.test(String(connection.state || ""))) group.established += 1;
    group.peers.set(remote, (group.peers.get(remote) || 0) + 1);
  }
  const groupList = [...groups.values()]
    .map((group) => ({
      name: group.name,
      bytesPerSecond: Math.round(group.bytesPerSecond),
      connections: group.connections,
      established: group.established,
      pids: group.pids.slice(0, 12),
      rates: [...group.rates.entries()]
        .map(([pid, bytesPerSecond]) => ({ pid, bytesPerSecond: Math.round(bytesPerSecond) }))
        .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
        .slice(0, 12),
      peers: [...group.peers.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([address]) => address)
    }))
    .filter((group) => group.bytesPerSecond > 0 || group.connections > 0)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond || right.connections - left.connections)
    .slice(0, 40);

  return {
    source: raw.source || null,
    processRateSource: raw.source && (Array.isArray(raw.processes) ? raw.processes.length : 0) ? raw.source : null,
    adapters,
    downloadBytesPerSecond,
    uploadBytesPerSecond,
    groups: groupList
  };
}

function readMonitorNetworkAdapters(tree) {
  const adapters = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const hardwareId = String(node.HardwareId || "");
    if (/^\/nic\//i.test(hardwareId)) {
      const metrics = {};
      const collect = (child) => {
        if (!child || typeof child !== "object") return;
        if (child.Text && child.Value) metrics[child.Text] = child.Value;
        if (Array.isArray(child.Children)) child.Children.forEach(collect);
      };
      collect(node);
      const download = (parseMetric(metrics["Download Speed"], "KB/s") || 0) * 1024;
      const upload = (parseMetric(metrics["Upload Speed"], "KB/s") || 0) * 1024;
      const downloadedBytes = (parseMetric(metrics["Data Downloaded"], "GB") || 0) * 1024 ** 3;
      const uploadedBytes = (parseMetric(metrics["Data Uploaded"], "GB") || 0) * 1024 ** 3;
      if (node.Text && (download || upload || downloadedBytes || uploadedBytes)) {
        adapters.push({
          name: String(node.Text),
          displayName: String(node.Text),
          virtual: VIRTUAL_INTERFACE_PATTERN.test(String(node.Text)),
          downloadBytesPerSecond: download,
          uploadBytesPerSecond: upload,
          downloadedBytes,
          uploadedBytes,
          source: "LibreHardwareMonitor"
        });
      }
    }
    if (Array.isArray(node.Children)) node.Children.forEach(walk);
  };
  walk(tree);
  return adapters;
}

function networkScript(outputPath) {
  return NETWORK_PS.replace("__OUTPUT_FILE__", String(outputPath).replace(/'/g, "''"));
}

async function refreshNetwork() {
  if (networkRefreshRunning) return;
  networkRefreshRunning = true;
  const startedAt = Date.now();
  const outputPath = path.join(root, NETWORK_CACHE_FILE);
  try {
    let parsed = null;
    let parseError = null;
    try {
      await powershellToFile(networkScript(outputPath));
      const text = fs.readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "");
      const sample = JSON.parse(text);
      const sampledAt = Date.parse(sample.sampledAt || "");
      if (!Number.isFinite(sampledAt) || Date.now() - sampledAt > 90_000) {
        parseError = "网络采样结果已过期";
      } else {
        parsed = sample;
      }
    } catch (error) {
      parseError = error.message;
    }
    const previousTotals = networkTotals;
    const previousTotalsAt = networkTotalsAt;
    if (parsed) {
      const totals = parsed.totals || {};
      const receivedBytes = Number(totals.receivedBytes);
      const sentBytes = Number(totals.sentBytes);
      if (Number.isFinite(receivedBytes) && Number.isFinite(sentBytes)) {
        networkTotals = { receivedBytes, sentBytes };
        networkTotalsAt = Date.now();
      }
      const sample = buildNetworkSample(parsed);
      let download = sample.downloadBytesPerSecond;
      let upload = sample.uploadBytesPerSecond;
      let source = sample.source;
      // Fall back to the cumulative netstat totals when the performance counters are unavailable.
      if (download == null && networkTotals && previousTotals && networkTotalsAt > previousTotalsAt) {
        const elapsed = (networkTotalsAt - previousTotalsAt) / 1000;
        const receivedDelta = networkTotals.receivedBytes - previousTotals.receivedBytes;
        const sentDelta = networkTotals.sentBytes - previousTotals.sentBytes;
        if (elapsed >= 1 && receivedDelta >= 0 && sentDelta >= 0) {
          download = receivedDelta / elapsed;
          upload = sentDelta / elapsed;
          source = "netstat";
        }
      }
      networkState.adapters = sample.adapters;
      networkState.downloadBytesPerSecond = download;
      networkState.uploadBytesPerSecond = upload;
      networkState.groups = sample.groups;
      networkState.source = source || null;
      networkState.processRateSource = sample.processRateSource || null;
      networkState.error = source ? null : (parsed.counterError || null);
      networkState.checkedAt = new Date().toISOString();
      networkState.sampledSeconds = Math.max(0.2, (Date.now() - startedAt) / 1000);
    } else {
      networkState.error = parseError;
      networkState.source = null;
    }
  } finally {
    networkRefreshRunning = false;
  }
}

function networkPublicState() {
  const adapters = networkState.adapters.length
    ? networkState.adapters
    : (cachedDetails.systemHealth.networkAdapters || []);
  const physical = adapters.filter((adapter) => !adapter.virtual);
  const counted = physical.some((adapter) => adapter.downloadBytesPerSecond + adapter.uploadBytesPerSecond > 0) || !physical.length
    ? physical
    : adapters;
  const download = networkState.downloadBytesPerSecond ??
    (counted.length ? counted.reduce((sum, adapter) => sum + (adapter.downloadBytesPerSecond || 0), 0) : null);
  const upload = networkState.uploadBytesPerSecond ??
    (counted.length ? counted.reduce((sum, adapter) => sum + (adapter.uploadBytesPerSecond || 0), 0) : null);
  return {
    checkedAt: networkState.checkedAt || cachedDetails.systemHealth.networkCheckedAt || null,
    sampledSeconds: networkState.sampledSeconds,
    source: networkState.source || (adapters.some((adapter) => adapter.source === "LibreHardwareMonitor") ? "lhm" : null),
    processRateSource: networkState.processRateSource,
    error: networkState.error,
    downloadBytesPerSecond: download,
    uploadBytesPerSecond: upload,
    adapters: adapters.slice(0, 12),
    groups: networkState.groups
  };
}

// ---------------------------------------------------------------------------
// History, peaks and abnormal-load events (last 24 hours, persisted to disk so
// a restart does not lose the window that explains a sudden freeze)
// ---------------------------------------------------------------------------
const HISTORY_SAMPLE_INTERVAL_MS = 5000;
const HISTORY_BUCKET_MS = 60 * 1000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_SERIES_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_SERIES_BUCKET_MS = 30 * 1000;
const HISTORY_MAX_SAMPLES = 18000;
const HISTORY_FILE = "history-cache.json";
const HISTORY_THRESHOLDS = {
  cpu: [{ level: "danger", value: 90 }, { level: "warn", value: 75 }],
  memory: [{ level: "danger", value: 90 }, { level: "warn", value: 80 }],
  temperature: [{ level: "danger", value: 95 }, { level: "warn", value: 85 }]
};
const HISTORY_METRICS = {
  cpu: { label: "CPU", unit: "%" },
  memory: { label: "内存", unit: "%" },
  temperature: { label: "温度", unit: "°C" }
};
const historySamples = [];
const historyBootAt = Date.now() - os.uptime() * 1000;
let historySavedAt = null;
let historyCpuBaseline = null;
let historyPublicCache = null;

function finiteOrNull(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

function humanBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// Independent CPU measurement so the history sampler never disturbs the live chart value.
function sampledCpuPercent() {
  const current = cpuSample();
  if (!historyCpuBaseline) {
    historyCpuBaseline = current;
    return null;
  }
  const idle = current.idle - historyCpuBaseline.idle;
  const total = current.total - historyCpuBaseline.total;
  historyCpuBaseline = current;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function topProcessBy(processes, valueOf) {
  let best = null;
  for (const item of processes || []) {
    const value = valueOf(item);
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) best = { value, name: String(item.name || "未知进程") };
  }
  return best ? { name: best.name, value: Math.round(best.value * 10) / 10 } : null;
}

// The live process list needs the PowerShell sampler; fall back to the health cache so a
// restricted session can still attribute a peak to the busiest process.
function processListForHistory() {
  if (cachedDetails.processes?.length) return cachedDetails.processes;
  const cache = readHealthCache();
  return Array.isArray(cache?.processes) ? cache.processes : [];
}

function collectHistorySample() {
  const cpu = sampledCpuPercent();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const memory = totalMemory > 0 ? (totalMemory - freeMemory) / totalMemory * 100 : null;
  const temperatures = (cachedDetails.systemHealth.temperatures || []).map(Number).filter(Number.isFinite);
  const processes = processListForHistory();
  const topCpu = topProcessBy(processes, (item) => Number(item.cpuPercent));
  const topMemory = topProcessBy(processes, (item) => Number(item.memory));
  return {
    at: Date.now(),
    cpu,
    memory,
    temperature: temperatures.length ? Math.max(...temperatures) : null,
    topCpu: topCpu ? { name: topCpu.name, cpuPercent: topCpu.value } : null,
    topMemory: topMemory ? { name: topMemory.name, memoryBytes: Math.round(topMemory.value) } : null
  };
}

function pruneHistory(now = Date.now()) {
  const cutoff = now - HISTORY_WINDOW_MS;
  let index = 0;
  while (index < historySamples.length && historySamples[index].at < cutoff) index++;
  if (index) historySamples.splice(0, index);
  if (historySamples.length > HISTORY_MAX_SAMPLES) {
    historySamples.splice(0, historySamples.length - HISTORY_MAX_SAMPLES);
  }
}

function refreshHistory() {
  const sample = collectHistorySample();
  if (sample.cpu == null) return;
  historySamples.push(sample);
  pruneHistory(sample.at);
  historyPublicCache = null;
}

function historyBuckets() {
  const buckets = new Map();
  for (const sample of historySamples) {
    const key = Math.floor(sample.at / HISTORY_BUCKET_MS);
    const bucket = buckets.get(key) || { at: key * HISTORY_BUCKET_MS, cpu: null, memory: null, temperature: null, topCpu: null, topMemory: null };
    if (sample.cpu != null && (bucket.cpu == null || sample.cpu > bucket.cpu)) {
      bucket.cpu = Math.round(sample.cpu * 10) / 10;
      if (sample.topCpu) bucket.topCpu = sample.topCpu;
    }
    if (sample.memory != null && (bucket.memory == null || sample.memory > bucket.memory)) {
      bucket.memory = Math.round(sample.memory * 10) / 10;
      if (sample.topMemory) bucket.topMemory = sample.topMemory;
    }
    if (sample.temperature != null && (bucket.temperature == null || sample.temperature > bucket.temperature)) {
      bucket.temperature = Math.round(sample.temperature * 10) / 10;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.at - right.at);
}

function loadHistoryFromDisk() {
  try {
    const text = fs.readFileSync(path.join(root, HISTORY_FILE), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text);
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    for (const bucket of (Array.isArray(parsed.buckets) ? parsed.buckets : [])) {
      const at = Number(bucket?.at);
      if (!Number.isFinite(at) || at < cutoff) continue;
      historySamples.push({
        at,
        cpu: finiteOrNull(bucket.cpu),
        memory: finiteOrNull(bucket.memory),
        temperature: finiteOrNull(bucket.temperature),
        topCpu: bucket.topCpu && typeof bucket.topCpu === "object" ? bucket.topCpu : null,
        topMemory: bucket.topMemory && typeof bucket.topMemory === "object" ? bucket.topMemory : null,
        restored: true
      });
    }
    historySamples.sort((left, right) => left.at - right.at);
    historySavedAt = parsed.savedAt || null;
  } catch {
    // A missing or unreadable history file simply starts a new window.
  }
}

function saveHistoryToDisk() {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      bootAt: new Date(historyBootAt).toISOString(),
      buckets: historyBuckets()
    };
    const target = path.join(root, HISTORY_FILE);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload));
    fs.renameSync(temporary, target);
    historySavedAt = payload.savedAt;
  } catch {
    // History persistence is best effort.
  }
}

function maxHistorySample(samples, metric) {
  let best = null;
  for (const sample of samples) {
    const value = finiteOrNull(sample[metric]);
    if (value == null) continue;
    if (!best || value > best.value) best = { value, sample };
  }
  if (!best) return null;
  const peak = {
    metric,
    label: HISTORY_METRICS[metric]?.label || metric,
    unit: HISTORY_METRICS[metric]?.unit || "",
    value: Math.round(best.value * 10) / 10,
    at: new Date(best.sample.at).toISOString(),
    restored: best.sample.restored === true
  };
  if (metric === "cpu" && best.sample.topCpu?.name) {
    peak.process = best.sample.topCpu.name;
    peak.processDetail = `${HISTORY_METRICS.cpu.label} ${finiteOrNull(best.sample.topCpu.cpuPercent) ?? "-"}%`;
  }
  if (metric === "memory" && best.sample.topMemory?.name) {
    peak.process = best.sample.topMemory.name;
    peak.processDetail = `占用 ${humanBytes(finiteOrNull(best.sample.topMemory.memoryBytes) || 0)}`;
  }
  return peak;
}

function buildHistoryEvents(samples) {
  const events = [];
  for (const [metric, thresholds] of Object.entries(HISTORY_THRESHOLDS)) {
    const warn = Math.min(...thresholds.map((item) => item.value));
    let current = null;
    let quiet = 0;
    const close = () => {
      if (!current) return;
      events.push(current);
      current = null;
    };
    for (const sample of samples) {
      const value = finiteOrNull(sample[metric]);
      if (value != null && value >= warn) {
        quiet = 0;
        const level = thresholds.find((item) => value >= item.value)?.level || "warn";
        const process = sample.topCpu?.name || sample.topMemory?.name || null;
        if (!current) {
          current = { metric, level, startAt: sample.at, lastAt: sample.at, peak: value, peakAt: sample.at, process };
        } else {
          current.lastAt = sample.at;
          if (value > current.peak) {
            current.peak = value;
            current.peakAt = sample.at;
            current.process = process || current.process;
          }
          if (level === "danger") current.level = "danger";
        }
      } else if (current) {
        // Two quiet samples close an event so a single dip does not split it in two.
        quiet += 1;
        if (quiet >= 2) close();
      }
    }
    close();
  }
  return events
    .map((event) => ({
      metric: event.metric,
      metricLabel: HISTORY_METRICS[event.metric]?.label || event.metric,
      unit: HISTORY_METRICS[event.metric]?.unit || "",
      level: event.level,
      startAt: new Date(event.startAt).toISOString(),
      endAt: new Date(event.lastAt).toISOString(),
      durationSeconds: Math.max(0, Math.round((event.lastAt - event.startAt) / 1000)),
      peak: Math.round(event.peak * 10) / 10,
      peakAt: new Date(event.peakAt).toISOString(),
      process: event.process || null
    }))
    .sort((left, right) => Date.parse(right.peakAt) - Date.parse(left.peakAt))
    .slice(0, 20);
}

function historySeries(since) {
  const buckets = new Map();
  for (const sample of historySamples) {
    if (sample.at < since) continue;
    const key = Math.floor(sample.at / HISTORY_SERIES_BUCKET_MS);
    const bucket = buckets.get(key) || { at: key * HISTORY_BUCKET_MS, cpu: null, memory: null, temperature: null };
    for (const metric of ["cpu", "memory", "temperature"]) {
      const value = finiteOrNull(sample[metric]);
      if (value == null) continue;
      if (bucket[metric] == null || value > bucket[metric]) bucket[metric] = Math.round(value * 10) / 10;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.at - right.at);
}

function historyPublicState() {
  if (historyPublicCache) return historyPublicCache;
  const now = Date.now();
  const sessionSamples = historySamples.filter((sample) => sample.at >= historyBootAt);
  const daySamples = historySamples;
  const windowPeaks = (samples, label, since) => ({
    label,
    since: new Date(since).toISOString(),
    cpu: maxHistorySample(samples, "cpu"),
    memory: maxHistorySample(samples, "memory"),
    temperature: maxHistorySample(samples, "temperature")
  });
  historyPublicCache = {
    bootAt: new Date(historyBootAt).toISOString(),
    savedAt: historySavedAt,
    sampleIntervalMs: HISTORY_SAMPLE_INTERVAL_MS,
    retentionHours: Math.round(HISTORY_WINDOW_MS / 3600000),
    sampleCount: historySamples.length,
    seriesSince: new Date(now - HISTORY_SERIES_WINDOW_MS).toISOString(),
    peaks: {
      session: windowPeaks(sessionSamples, "本次开机以来", historyBootAt),
      day: windowPeaks(daySamples, "最近 24 小时", now - HISTORY_WINDOW_MS)
    },
    events: buildHistoryEvents(historySamples),
    series: historySeries(now - HISTORY_SERIES_WINDOW_MS)
  };
  return historyPublicCache;
}

async function refreshDetails() {
  if (cachedDetails.detailsLoading) return;
  cachedDetails = { ...cachedDetails, detailsLoading: true, detailsError: null };
  const biosVersionPromise = readBiosVersion();
  const ps = `
    # BIOS is read from the registry because Win32_BIOS needs WMI, which is often denied.
    $biosVersion = '';
    try {
      $biosKey = Get-ItemProperty -LiteralPath 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\BIOS' -ErrorAction Stop;
      if ($biosKey.BIOSVersion) { $biosVersion = [string]$biosKey.BIOSVersion }
    } catch {}
    if (-not $biosVersion) {
      try {
        $legacySystem = Get-ItemProperty -LiteralPath 'HKLM:\\HARDWARE\\DESCRIPTION\\System' -ErrorAction Stop;
        $legacyVersion = @($legacySystem.SystemBiosVersion) | Where-Object { $_ -match '^[A-Za-z0-9._-]{4,}$' } | Select-Object -First 1;
        if ($legacyVersion) { $biosVersion = [string]$legacyVersion }
      } catch {}
    }
    if (-not $biosVersion) {
      try {
        $systemInformation = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation' -ErrorAction Stop;
        if ($systemInformation.BIOSVersion) { $biosVersion = [string]$systemInformation.BIOSVersion }
      } catch {}
    }
    $gpuRegistry = @();
    try {
      $displayClass = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
      $gpuRegistry = @(Get-ChildItem -LiteralPath $displayClass -ErrorAction Stop |
        Where-Object { $_.PSChildName -match '^\\d{4}$' } |
        ForEach-Object {
          $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue;
          $raw = $entry.'HardwareInformation.qwMemorySize';
          $bytes = 0;
          if ($raw -is [byte[]]) {
            if ($raw.Length -ge 8) { $bytes = [BitConverter]::ToUInt64($raw, 0) }
          } elseif ($null -ne $raw) {
            $bytes = [uint64]$raw
          }
          [PSCustomObject]@{
            Name = [string]$entry.DriverDesc;
            DriverVersion = [string]$entry.DriverVersion;
            MemoryBytes = $bytes;
          }
        } | Where-Object { $_.Name })
    } catch { $gpuRegistry = @() }
    $disks = @();
    try {
      $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop |
        Select-Object DeviceID,Size,FreeSpace)
    } catch {}
    $system = $null;
    try {
      $system = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop |
        Select-Object LastBootUpTime,Version
    } catch {}
    $battery = @();
    try {
      $battery = @(Get-CimInstance Win32_Battery -ErrorAction Stop |
        Select-Object EstimatedChargeRemaining,BatteryStatus)
    } catch {}
    $temperature = @();
    try {
      $temperature = @(Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction Stop |
        ForEach-Object {
          $celsius = ([double]$_.CurrentTemperature / 10) - 273.15;
          if ($celsius -gt 0 -and $celsius -lt 120) {
            [PSCustomObject]@{ Name = $_.InstanceName; Celsius = $celsius; Source = "Windows ACPI" }
          }
        })
    } catch {}
    $perfTemperature = @();
    try {
      $perfTemperature = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop |
        ForEach-Object {
          $celsius = ([double]$_.Temperature / 10) - 273.15;
          if ($celsius -gt 0 -and $celsius -lt 120) {
            [PSCustomObject]@{ Name = $_.Name; Celsius = $celsius; Source = "Windows Thermal Zone" }
          }
        })
    } catch {}
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
    $security = @();
    try {
      $security = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop |
        Select-Object displayName,productState)
    } catch {}
    $physicalDisks = @();
    try {
      $physicalDisks = @(Get-PhysicalDisk -ErrorAction Stop |
        Select-Object FriendlyName,HealthStatus,OperationalStatus,MediaType,BusType,Size,SerialNumber,UniqueId,DeviceId)
    } catch {
      try {
        $physicalDisks = @(Get-Disk -ErrorAction Stop | ForEach-Object {
          [PSCustomObject]@{
            FriendlyName = [string]$_.FriendlyName
            HealthStatus = [string]$_.HealthStatus
            OperationalStatus = @($_.OperationalStatus | ForEach-Object { [string]$_ })
            MediaType = [string]$_.MediaType
            BusType = [string]$_.BusType
            Size = [double]$_.Size
            SerialNumber = [string]$_.SerialNumber
            UniqueId = [string]$_.UniqueId
            DeviceId = [string]$_.Number
          }
        })
      } catch { $physicalDisks = @() }
    }
    $hardware = $null;
    try {
      $hardware = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop |
        Select-Object Manufacturer,Model,TotalPhysicalMemory
    } catch {}
    $bios = $null;
    try {
      $bios = Get-CimInstance Win32_BIOS -ErrorAction Stop | Select-Object SMBIOSBIOSVersion,ReleaseDate
    } catch {}
    $processor = $null;
    try {
      $processor = Get-CimInstance Win32_Processor -ErrorAction Stop |
        Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed
    } catch {}
    $gpu = $null;
    try {
      $gpu = Get-CimInstance Win32_VideoController -ErrorAction Stop |
        Where-Object { $_.Name -and $_.Name -notmatch 'Basic Display|Remote Display|Indirect Display' } |
        Select-Object -First 1 Name,AdapterRAM,DriverVersion
    } catch {}
    $memoryModules = @();
    try {
      $memoryModules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop |
        Where-Object { [double]$_.Speed -gt 0 } |
        Select-Object Speed,ConfiguredClockSpeed,Manufacturer,PartNumber)
    } catch {}
    $memorySpeedMHz = ($memoryModules | Measure-Object -Property ConfiguredClockSpeed -Maximum).Maximum;
    $processes = @();
    try {
      $processes = @(Get-Process -ErrorAction Stop |
        Where-Object { $_.CPU -ne $null } |
        Sort-Object CPU -Descending |
        Select-Object -First 40 Name,Id,CPU,WorkingSet64)
    } catch {}
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
      gpuRegistry = @($gpuRegistry);
      biosVersion = $biosVersion;
      memoryModule = [PSCustomObject]@{ ConfiguredClockSpeed = $memorySpeedMHz; Speed = ($memoryModules | Measure-Object -Property Speed -Maximum).Maximum; ModuleCount = $memoryModules.Count };
      processes = @($processes);
    } | ConvertTo-Json -Depth 4 -Compress
  `;
  let data = { disks: [], processes: [], battery: [], temperature: [], security: [], physicalDisks: [], gpuRegistry: [] };
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
    // LibreHardwareMonitor keeps sampling while the WMI query is unavailable, so the card
    // should report a live timestamp instead of the older health-cache sample time.
    const liveMonitor = (cachedDetails.systemHealth.temperatureSensors || []).length > 0 ||
      (cachedDetails.systemHealth.physicalDisks || []).some((disk) => disk.smartRead === true);
    cachedDetails = {
      ...cachedDetails,
      disks: fallbackDisks.length ? fallbackDisks : cachedDetails.disks,
      systemHealth: {
        ...cachedDetails.systemHealth,
        systemDriveFree: systemDisk?.free ?? cachedDetails.systemHealth.systemDriveFree ?? null
      },
      detailsLoading: false,
      detailsError: cacheReady ? null : error.message,
      detailsUpdatedAt: liveMonitor || !cacheReady
        ? new Date().toISOString()
        : (healthCache.checkedAt || new Date().toISOString())
    };
    return;
  }
  const registryBiosVersion = await biosVersionPromise;
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
  // Win32_BIOS needs WMI; the registry copy is used whenever WMI is unavailable.
  const biosVersion = String(registryBiosVersion || data.biosVersion || bios.SMBIOSBIOSVersion || "").trim() || "未知";
  // Win32_VideoController.AdapterRAM is a 32-bit value and reports 0 on many Optimus/hybrid
  // laptops, so the display class registry (REG_QWORD qwMemorySize) is the primary source.
  const gpuRegistry = (Array.isArray(data.gpuRegistry) ? data.gpuRegistry : [data.gpuRegistry]).filter(Boolean);
  const registryGpu = gpuRegistry
    .map((item) => ({ ...item, memoryBytes: Number(item.MemoryBytes || 0) }))
    .filter((item) => item.name)
    .sort((left, right) => right.memoryBytes - left.memoryBytes)[0] || null;
  const registryGpuName = registryGpu?.name || null;
  const registryGpuMemoryBytes = Number(registryGpu?.memoryBytes || 0);
  const registryGpuDriverVersion = registryGpu?.driverVersion ? String(registryGpu.driverVersion) : null;
  const gpuMemoryBytes = registryGpuMemoryBytes > 0 ? registryGpuMemoryBytes : Number(gpu.AdapterRAM || 0);
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
      biosVersion,
      gpuName: gpu.Name || registryGpuName || null,
      gpuMemoryBytes,
      gpuDriverVersion: gpu.DriverVersion || registryGpuDriverVersion || null,
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
    hardware: {
      ...completed.hardware,
      ...cachedDetails.hardware,
      ...(registryGpuMemoryBytes > 0 ? { gpuMemoryBytes: registryGpuMemoryBytes } : {})
    },
    hostInfo: {
      ...completed.hostInfo,
      ...cachedDetails.hostInfo,
      ...(biosVersion && biosVersion !== "未知" ? { biosVersion } : {}),
      ...(registryGpuMemoryBytes > 0 ? { gpuMemoryBytes: registryGpuMemoryBytes } : {}),
      ...(registryGpuDriverVersion ? { gpuDriverVersion: registryGpuDriverVersion } : {})
    },
    systemHealth: {
      ...completed.systemHealth,
      ...cachedDetails.systemHealth,
      physicalDisks: mergeDiskLists(completed.systemHealth.physicalDisks, cachedDetails.systemHealth.physicalDisks)
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
    network: networkPublicState(),
    history: historyPublicState(),
    hardwareSpecs: (() => {
      const cache = readHealthCache();
      const cachedSpecs = cache?.hardwareSpecs && typeof cache.hardwareSpecs === "object" ? cache.hardwareSpecs : {};
      const liveSmartDisks = (details.systemHealth.physicalDisks || [])
        .filter((disk) => disk.smartRead === true)
        .map((disk) => ({
          name: disk.name,
          serialNumber: disk.serialNumber || null,
          deviceId: disk.deviceId || null,
          smartRead: true,
          smartSource: disk.smartSource || disk.source || "本机传感器",
          life: disk.life ?? null,
          availableSpare: disk.availableSpare ?? null,
          wearPercent: disk.wearPercent ?? null,
          temperatureCelsius: disk.temperatureCelsius ?? null,
          powerOnHours: disk.powerOnHours ?? null,
          dataWrittenBytes: disk.dataWrittenBytes ?? null
        }));
      const cachedSmart = Array.isArray(cachedSpecs.smartDisks) ? cachedSpecs.smartDisks.filter(Boolean) : [];
      const smartDisks = cachedSmart.some((disk) => disk.smartRead === true) ? cachedSmart : liveSmartDisks;
      const smartChecked = cachedSpecs.smartChecked === true || liveSmartDisks.length > 0 ||
        Boolean(details.systemHealth.smartCheckedAt);
      if (!Object.keys(cachedSpecs).length && !smartChecked) return null;
      return {
        ...cachedSpecs,
        smartDisks,
        smartChecked,
        smartSource: cachedSpecs.smartSource || details.systemHealth.smartSource ||
          (liveSmartDisks.length ? "LibreHardwareMonitor" : null)
      };
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

// The process list is ranked by CPU, so a quiet background downloader may not be in it.
// Network ranking entries (rates and TCP/UDP connections) are tracked as well, otherwise
// the "结束进程" button in the network ranking would be rejected.
function trackedProcessMap() {
  const tracked = new Map(cachedDetails.processes.map((item) => [Number(item.pid), item]));
  for (const group of networkState.groups) {
    const pids = [
      ...(Array.isArray(group.pids) ? group.pids : []),
      ...((Array.isArray(group.rates) ? group.rates : []).map((item) => item.pid))
    ];
    for (const value of pids) {
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0 || tracked.has(pid)) continue;
      tracked.set(pid, { pid, name: group.name });
    }
  }
  return tracked;
}

async function terminateObservedProcesses(pids) {
  const requested = [...new Set((Array.isArray(pids) ? pids : []).map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!requested.length || requested.length > 40) {
    return { status: 400, body: { ok: false, message: "请选择有效的进程" } };
  }
  const tracked = trackedProcessMap();
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
  const tracked = trackedProcessMap();
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
  const session = requestSession(request);
  if ((url.pathname === "/login" || url.pathname === "/login.html") && request.method === "GET") {
    if (session) return sendRedirect(response, "/");
    const file = path.join(root, "login.html");
    return fs.readFile(file, (error, content) => {
      if (error) return sendJson(response, { error: "登录页不可用" }, 500);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(content);
    });
  }
  if (url.pathname === "/login.css" && request.method === "GET") {
    const file = path.join(root, "login.css");
    return fs.readFile(file, (error, content) => {
      if (error) return sendJson(response, { error: "Not found" }, 404);
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
      response.end(content);
    });
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    const attempt = loginAttemptState(request);
    if (attempt.count >= 5) return sendJson(response, { ok: false, message: "登录失败次数过多，请 10 分钟后再试" }, 429);
    try {
      const payload = await readJson(request);
      if (!credentialsMatch(payload.username, payload.password)) {
        loginAttempts.set(attempt.key, { count: attempt.count + 1, resetAt: attempt.resetAt });
        return sendJson(response, { ok: false, message: "账号或密码错误" }, 401);
      }
      loginAttempts.delete(attempt.key);
      const token = crypto.randomBytes(32).toString("base64url");
      sessions.set(token, { username: authConfig.username, expiresAt: Date.now() + sessionLifetimeMs });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}`
      });
      return response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      return sendJson(response, { ok: false, message: error.message }, 400);
    }
  }
  if (!session) {
    if (url.pathname.startsWith("/api/")) return sendJson(response, { ok: false, message: "请先登录" }, 401);
    return sendRedirect(response, "/login");
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    sessions.delete(session.token);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
    });
    return response.end(JSON.stringify({ ok: true }));
  }
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
  if (["/auth-config.json", "/登录信息.txt", "/.gitignore"].includes(requested)) {
    return sendJson(response, { error: "Not found" }, 404);
  }
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
  loadHistoryFromDisk();
  refreshDetails();
  refreshProcesses();
  refreshTemperatureFromMonitor();
  setInterval(refreshDetails, 60_000);
  setInterval(refreshProcesses, 3_000);
  setInterval(refreshTemperatureFromMonitor, 3_000);
  // Sampling takes a couple of seconds, so schedule the next run after the previous one
  // finished instead of using a fixed interval that could overlap.
  const networkLoop = async () => {
    try {
      await refreshNetwork();
    } finally {
      setTimeout(networkLoop, NETWORK_SAMPLE_INTERVAL_MS);
    }
  };
  networkLoop();
  refreshHistory();
  setInterval(refreshHistory, HISTORY_SAMPLE_INTERVAL_MS);
  setInterval(saveHistoryToDisk, 60_000);
});

process.on("exit", () => {
  saveHistoryToDisk();
});
