const $ = (selector) => document.querySelector(selector);
const state = { paused: false, history: [], networkHistory: [], historySeries: [], historyWindow: "session", snapshot: null, temperatureShowAll: false, expandedProcessGroups: new Set(), ecoMode: null };
const colors = { cpu: "#e86f51", memory: "#5b8def", grid: "#e5ebe6", text: "#819087" };

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  return days ? `${days}天` : hours ? `${hours}小时` : `${minutes}分钟`;
}
function formatRate(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "--";
  const rate = Math.max(0, Number(value));
  if (rate < 1024) return `${Math.round(rate)} B/s`;
  return `${formatBytes(rate)}/s`;
}
function percent(value) { return `${Math.round(value)}%`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}
function temperatureAssessment(celsius) {
  if (celsius >= 95) {
    return {
      level: "danger",
      label: "高风险过热",
      description: "当前温度已接近或达到多数硬件的高温保护区间。",
      impact: "可能触发降频、明显卡顿、风扇高速运转，严重时会出现程序退出或自动保护关机。长期持续高温也会增加硬件老化风险。",
      action: "立即降低游戏、渲染等负载，检查风道和风扇是否积尘；保持通风，待温度降下来后再继续使用。"
    };
  }
  if (celsius >= 85) {
    return {
      level: "warn",
      label: "温度偏高",
      description: "当前温度较高，是否异常要结合硬件型号和负载持续时间判断。",
      impact: "短时间高负载通常可以承受，但持续高温可能带来风扇噪声、性能降频和运行不稳定。",
      action: "先观察温度是否持续上升；减少高负载任务，检查散热口、风扇和环境温度。"
    };
  }
  if (celsius >= 70) {
    return {
      level: "warn",
      label: "温度升高",
      description: "当前温度处于需要关注的区间，暂未达到高风险过热。",
      impact: "在游戏、编译或视频处理等负载下通常仍可运行；如果低负载时也长期维持，可能影响噪声和性能。",
      action: "保持通风并继续观察；如果温度持续接近 85°C，建议检查风扇转速、散热口和后台高占用程序。"
    };
  }
  return {
    level: "good",
    label: "温度正常",
    description: "当前最高温度处于常见安全观察范围内，没有明显过热迹象。",
    impact: "目前不太会对日常使用造成明显影响。高负载时温度短暂升高是正常现象，重点关注是否长时间持续。",
    action: "保持设备通风，继续观察实时曲线；无需因为当前读数采取紧急处理。"
  };
}
function setHealth(id, badgeId, title, detail, level, badge) {
  const value = $(`#${id}`);
  const detailIdMap = {
    temperatureHealth: "temperatureDetail",
    diskHealth: "diskHealthDetail",
    batteryHealth: "batteryDetail",
    securityHealth: "securityDetail",
    uptimeHealth: "uptimeHealthDetail",
    systemDiskHealth: "systemDiskDetail"
  };
  const detailElement = $(`#${detailIdMap[id] || id.replace("Health", "Detail")}`);
  const chip = $(`#${badgeId}`);
  if (value) value.textContent = title;
  if (detailElement) detailElement.textContent = detail;
  if (chip) {
    chip.textContent = badge;
    chip.className = `health-badge ${level}`;
  }
}
function renderHardwareCheck(data) {
  const health = data.systemHealth || {};
  const hardware = data.hostInfo || data.hardware || {};
  const pending = data.detailsLoading ? "正在读取" : "未获取";
  const rows = [
    ["温度", health.temperatures?.length ? `${Math.round(Math.max(...health.temperatures))}°C` : "不支持", health.temperatures?.length ? `${health.temperatureSource || "本机传感器"} · ${health.temperatureSensors?.length || health.temperatures.length} 个传感器` : "请在 LibreHardwareMonitor 开启 Remote Web Server"],
    ["电池", health.battery?.length ? "已读取" : "不支持", health.battery?.length ? `${health.battery[0].charge}%` : "未检测到电池"],
    ["磁盘健康", health.physicalDisks?.length ? "已读取" : "不支持", health.physicalDisks?.length ? health.physicalDisks.map((item) => `${item.mediaType || "磁盘"} ${item.busType || ""} ${item.health}`).join("、") : "未返回物理磁盘状态"],
    ["安全防护", health.antivirus?.length ? "已读取" : "无法确认", health.antivirus?.length ? health.antivirus.map((item) => item.name).join("、") : "安全中心未返回防护产品"],
    ["主机", `${hardware.manufacturer || "未知厂商"} ${hardware.model || "未知型号"}`, `${hardware.windowsName || "Windows 设备"} · ${hardware.processor || "未知处理器"}`],
    ["内存", hardware.memoryBytes ? formatBytes(hardware.memoryBytes) : pending, hardware.memoryBytes ? "Node.js 系统内存" : "等待系统内存数据"],
    ["处理器", hardware.processor || "未知处理器", `${hardware.cores || "-"} 核 / ${hardware.logicalProcessors || "-"} 线程 · ${hardware.currentClockMHz ? (hardware.currentClockMHz / 1000).toFixed(2) + " GHz 实时频率" : hardware.maxClockMHz ? (hardware.maxClockMHz / 1000).toFixed(2) + " GHz 规格频率" : "频率未知"}`],
    ["BIOS", hardware.biosVersion && hardware.biosVersion !== "正在读取" ? hardware.biosVersion : pending, hardware.biosVersion && hardware.biosVersion !== "正在读取" ? "Windows 注册表" : "等待 BIOS 数据"]
  ];
  const panel = $("#hardwareCheckPanel");
  if (panel) panel.innerHTML = rows.map(([name, value, detail]) => `<div class="hardware-row"><strong>${name}</strong><span>${value}</span><small>${detail}</small></div>`).join("");
}
function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
const networkSourceLabels = {
  pdh: "Windows 性能计数器",
  netstat: "netstat 累计差值",
  lhm: "LibreHardwareMonitor"
};
function networkSourceLabel(value) {
  if (!value) return "未连接";
  return networkSourceLabels[value] || String(value);
}
function niceRateStep(value) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 1e-6)));
  for (const candidate of [1, 2, 2.5, 5, 10]) {
    if (candidate * magnitude >= value) return candidate * magnitude;
  }
  return 10 * magnitude;
}
// Rounds the vertical axis up to a readable value so the labels stay tidy.
function networkAxis(peakBytes) {
  const units = [
    { suffix: "B/s", scale: 1 },
    { suffix: "KB/s", scale: 1024 },
    { suffix: "MB/s", scale: 1024 ** 2 },
    { suffix: "GB/s", scale: 1024 ** 3 }
  ];
  const target = Math.max(2048, Number(peakBytes) || 0) * 1.05;
  let unit = units[0];
  for (const candidate of units) {
    if (target >= candidate.scale) unit = candidate;
  }
  const step = niceRateStep(target / 4 / unit.scale) * unit.scale;
  return {
    max: step * 4,
    label: (value) => {
      const scaled = value / unit.scale;
      const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `${rounded} ${unit.suffix}`;
    }
  };
}
function renderHardwareOverview(data) {
  const hardware = data.hostInfo || data.hardware || {};
  const health = data.systemHealth || {};
  const hardwareSpecs = data.hardwareSpecs || {};
  const disks = health.physicalDisks || [];
  const gpuName = hardware.gpuName || hardwareSpecs.gpuName || null;
  const gpuMemoryBytes = firstFinite(hardware.gpuMemoryBytes, hardwareSpecs.gpuMemoryBytes) || 0;
  const gpuDriverVersion = hardware.gpuDriverVersion || hardwareSpecs.gpuDriverVersion || null;
  const gpuDetails = [
    gpuMemoryBytes > 0 ? `${formatBytes(gpuMemoryBytes)} 显存` : "显存容量未提供",
    gpuDriverVersion ? `驱动 ${gpuDriverVersion}` : null
  ].filter(Boolean).join(" · ");
  const rows = [
    ["显卡", gpuName || "不支持/未读取", gpuName ? gpuDetails : "系统未返回显示适配器型号"],
    ["内存规格", hardware.memoryDataRateMTs ? `${hardware.memoryDataRateMTs} MT/s` : "不支持/未读取", `${hardware.memoryBytes ? formatBytes(hardware.memoryBytes) : "容量未知"} · ${hardware.memoryModuleCount ? `${hardware.memoryModuleCount} 条内存` : "条数未提供"} · ${hardware.memoryDataRateSource || "内存速率为规格推算，不是实时频率"}`],
    ...(disks.length ? disks : [{ name: "物理磁盘", smartRead: false, smartReason: "系统没有提供物理磁盘或可靠性计数器" }]).map((disk) => {
      const smartEntry = (hardwareSpecs.smartDisks || []).find((item) =>
        (item.name && disk.name && String(item.name).toLowerCase() === String(disk.name).toLowerCase()) ||
        (item.deviceId && disk.deviceId && String(item.deviceId).toLowerCase() === String(disk.deviceId).toLowerCase()) ||
        (item.serialNumber && disk.serialNumber && item.serialNumber === disk.serialNumber)
      );
      const temperature = firstFinite(disk.temperatureCelsius, smartEntry?.temperatureCelsius);
      const wear = firstFinite(disk.wearPercent, smartEntry?.wearPercent);
      const life = firstFinite(disk.life, smartEntry?.life, wear != null ? 100 - wear : null);
      const spare = firstFinite(disk.availableSpare, smartEntry?.availableSpare);
      const powerOnHours = firstFinite(disk.powerOnHours, smartEntry?.powerOnHours);
      const dataWritten = firstFinite(disk.dataWrittenBytes, smartEntry?.dataWrittenBytes);
      const smartErrors = (firstFinite(smartEntry?.readErrorsTotal) || 0) + (firstFinite(smartEntry?.writeErrorsTotal) || 0);
      const smartRead = disk.smartRead === true || smartEntry?.smartRead === true ||
        temperature != null || life != null || powerOnHours != null;
      const smartChecked = hardwareSpecs.smartChecked === true || smartRead;
      const smartIssue = (disk.health && !/^healthy$/i.test(disk.health)) || (wear != null && wear >= 80) ||
        (life != null && life < 20) || (temperature != null && temperature >= 70) || smartErrors > 0;
      const smartStatus = smartRead ? (smartIssue ? "需关注" : "SMART 正常") : smartChecked ? "SMART 未读取" : "等待采样";
      const smartReason = disk.smartReason || smartEntry?.reason || hardwareSpecs.smartReason ||
        (smartChecked ? "系统与设备都未返回可靠性计数器，可尝试以管理员身份运行" : "等待 S.M.A.R.T. 采样");
      const details = [disk.mediaType, disk.busType, disk.health ? `系统状态 ${disk.health}` : null,
        temperature != null ? `${temperature}°C` : null,
        life != null ? `寿命 ${Math.round(life)}%` : null,
        spare != null && spare < 100 ? `可用备用 ${Math.round(spare)}%` : null,
        wear != null && wear > 0 ? `磨损 ${wear}%` : null,
        powerOnHours != null ? `通电 ${Math.round(powerOnHours)} 小时` : null,
        dataWritten != null ? `累计写入 ${formatBytes(dataWritten)}` : null,
        smartRead ? null : smartReason].filter(Boolean).join(" · ");
      return [`磁盘 · ${disk.name || "物理磁盘"}`, smartStatus, details || (smartRead ? "已读取设备可靠性数据" : "设备/驱动未提供 S.M.A.R.T. 可靠性数据")];
    })
  ];
  const panel = $("#hardwareOverview");
  if (panel) panel.innerHTML = rows.map(([name, value, detail]) => {
    const statusClass = value === "需关注" ? " is-warning" : /^(不支持|不支持\/未读取|SMART 不支持|SMART 未读取|等待采样)$/.test(value) ? " is-unavailable" : "";
    return `<article class="hardware-spec-row${statusClass}"><strong>${escapeHtml(name)}</strong><span class="hardware-spec-value">${escapeHtml(value)}</span><small>${escapeHtml(detail)}</small></article>`;
  }).join("");
  const updated = $("#hardwareSpecsUpdated");
  if (updated) updated.textContent = data.detailsLoading ? "正在更新" : data.detailsUpdatedAt ? `采集于 ${new Date(data.detailsUpdatedAt).toLocaleTimeString()}` : "等待采集";
}
function renderTemperatureDetails(data) {
  const health = data.systemHealth || {};
  const sensors = (health.temperatureSensors || [])
    .filter((sensor) => Number.isFinite(Number(sensor.celsius)))
    .sort((a, b) => Number(b.celsius) - Number(a.celsius));
  const riskCard = $("#temperatureRiskCard");
  const liveState = $("#temperatureLiveState");
  const sensorList = $("#temperatureSensors");
  if (!sensors.length) {
    const availableSources = (health.temperatureSources || [])
      .filter((source) => source.available)
      .map((source) => source.name);
    const scanned = availableSources.length ? `已连接：${availableSources.join("、")}` : "尚未发现可用温度传感器";
    if (riskCard) riskCard.className = "temperature-risk-card is-unavailable";
    if (liveState) liveState.textContent = "暂无传感器数据";
    if ($("#temperatureRiskTitle")) $("#temperatureRiskTitle").textContent = "无法读取温度";
    if ($("#temperatureRiskDescription")) $("#temperatureRiskDescription").textContent = "平台不会用估算值代替真实温度，请先连接硬件监控数据源。";
    if ($("#temperatureHighest")) $("#temperatureHighest").textContent = "--";
    if ($("#temperatureAverage")) $("#temperatureAverage").textContent = "--";
    if ($("#temperatureSensorCount")) $("#temperatureSensorCount").textContent = "0";
    if ($("#temperatureSource")) $("#temperatureSource").textContent = "未连接";
    if ($("#temperatureImpact")) $("#temperatureImpact").textContent = "没有实时读数，暂时无法判断是否过热或评估对性能、稳定性的影响。";
    if ($("#temperatureAction")) $("#temperatureAction").textContent = "请在 LibreHardwareMonitor 中开启 Options → Remote Web Server → Run，然后点击重新检测。";
    if (sensorList) sensorList.innerHTML = '<p class="empty">未读取到实际温度传感器。</p>';
    if ($("#temperatureCheckedAt")) $("#temperatureCheckedAt").textContent = scanned;
    if ($("#temperatureSensorFilter")) $("#temperatureSensorFilter").textContent = "暂无可用传感器";
    if ($("#temperatureSensorToggle")) {
      $("#temperatureSensorToggle").disabled = true;
      $("#temperatureSensorToggle").textContent = "显示全部";
    }
    if ($("#temperatureSourceNote")) $("#temperatureSourceNote").textContent = `${scanned}。温度阈值不会被当作当前温度显示。`;
    return;
  }

  const values = sensors.map((sensor) => Number(sensor.celsius));
  const highest = Math.max(...values);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const assessment = temperatureAssessment(highest);
  const sourceNames = [...new Set(sensors.map((sensor) => sensor.source).filter(Boolean))];
  const hotSensors = sensors.filter((sensor) => temperatureAssessment(Number(sensor.celsius)).level !== "good");
  const visibleSensors = state.temperatureShowAll ? sensors : hotSensors;
  const sensorToggle = $("#temperatureSensorToggle");
  if (sensorToggle) {
    sensorToggle.disabled = false;
    sensorToggle.textContent = state.temperatureShowAll ? "仅显示需关注" : `显示全部 (${sensors.length})`;
  }
  if ($("#temperatureSensorFilter")) {
    $("#temperatureSensorFilter").textContent = hotSensors.length && !state.temperatureShowAll
      ? `默认显示 ${hotSensors.length} 个高温项`
      : state.temperatureShowAll ? `已显示全部 ${sensors.length} 个传感器` : `当前无高温项 · 默认隐藏 ${sensors.length} 个传感器`;
  }
  if (riskCard) riskCard.className = `temperature-risk-card ${assessment.level}`;
  if (liveState) liveState.textContent = "实时读取中 · 每 3 秒更新";
  if ($("#temperatureRiskTitle")) $("#temperatureRiskTitle").textContent = assessment.label;
  if ($("#temperatureRiskDescription")) $("#temperatureRiskDescription").textContent = assessment.description;
  if ($("#temperatureHighest")) $("#temperatureHighest").textContent = `${highest.toFixed(1)}°C`;
  if ($("#temperatureAverage")) $("#temperatureAverage").textContent = `${average.toFixed(1)}°C`;
  if ($("#temperatureSensorCount")) $("#temperatureSensorCount").textContent = `${sensors.length} 个`;
  if ($("#temperatureSource")) $("#temperatureSource").textContent = sourceNames.join("、") || "本机传感器";
  if ($("#temperatureImpact")) $("#temperatureImpact").textContent = assessment.impact;
  if ($("#temperatureAction")) $("#temperatureAction").textContent = assessment.action;
  if ($("#temperatureCheckedAt")) {
    const checkedAt = health.temperatureCheckedAt ? new Date(health.temperatureCheckedAt) : null;
    $("#temperatureCheckedAt").textContent = checkedAt && !Number.isNaN(checkedAt.getTime())
      ? `最近采样 ${checkedAt.toLocaleTimeString()}`
      : "实时采样";
  }
  if (sensorList) {
    sensorList.innerHTML = visibleSensors.length ? visibleSensors.map((sensor) => {
      const value = Number(sensor.celsius);
      const sensorAssessment = temperatureAssessment(value);
      const peak = Number(sensor.maxCelsius);
      const peakText = Number.isFinite(peak) && peak > 0 ? `历史峰值 ${peak.toFixed(1)}°C` : "实时读数";
      const isHot = sensorAssessment.level !== "good";
      return `<details class="temperature-sensor-row ${isHot ? "is-hot" : ""}"${isHot ? " open" : ""}>
        <summary class="temperature-sensor-summary">
          <div class="temperature-sensor-name"><strong>${escapeHtml(sensor.name)}</strong><small>${escapeHtml(sensor.category || "硬件")}</small></div>
          <div class="temperature-bar"><i class="${sensorAssessment.level}" style="width:${Math.min(100, Math.max(0, value))}%"></i></div>
          <div class="temperature-reading"><strong>${value.toFixed(1)}°C</strong><span class="temperature-tag ${sensorAssessment.level}">${sensorAssessment.label}</span></div>
        </summary>
        <div class="temperature-sensor-detail"><span>数据来源</span><strong>${escapeHtml(sensor.source || "本机传感器")}</strong><span>历史峰值</span><strong>${escapeHtml(peakText)}</strong></div>
      </details>`;
    }).join("") : '<p class="empty temperature-empty">当前没有超温或高温项，温度状态正常。点击“显示全部”查看完整传感器列表。</p>';
  }
  if ($("#temperatureSourceNote")) {
    $("#temperatureSourceNote").textContent = `数据来源：${sourceNames.join("、") || "本机传感器"}。当前最高值按实际温度传感器计算，已排除 Warning/Critical 阈值和 Distance to TjMax 等非实时温度项。`;
  }
}
function setHealthWaiting(message, failed = false) {
  const label = failed ? "检测失败" : "等待读取";
  const detail = failed ? "可点击重新检测，其他实时数据不受影响" : message;
  for (const [valueId, detailId, badgeId] of [
    ["temperatureHealth", "temperatureDetail", "temperatureBadge"],
    ["diskHealth", "diskHealthDetail", "diskHealthBadge"],
    ["batteryHealth", "batteryDetail", "batteryBadge"],
    ["securityHealth", "securityDetail", "securityBadge"],
    ["systemDiskHealth", "systemDiskDetail", "systemDiskBadge"]
  ]) {
    if (!["不可用", "不支持", "不适用", "正常", "已启用"].includes($("#" + valueId).textContent)) {
      $("#" + valueId).textContent = label;
      $("#" + detailId).textContent = detail;
      $("#" + badgeId).textContent = failed ? "失败" : "检测中";
      $("#" + badgeId).className = `health-badge ${failed ? "warn" : ""}`;
    }
  }
}
function renderHealth(data) {
  const health = data.systemHealth || {};
  const alerts = [];
  let checked = 0;
  const detailsReady = Boolean(data.detailsUpdatedAt);
  const temperatures = health.temperatures || [];
  const temperatureSensors = health.temperatureSensors || [];
  if (temperatures.length) {
    checked++;
    const hottest = Math.max(...temperatures);
    const assessment = temperatureAssessment(hottest);
    setHealth("temperatureHealth", "temperatureBadge", `${Math.round(hottest)}°C`, `${temperatureSensors.length || temperatures.length} 个传感器 · ${health.temperatureSource || "本机传感器"}`, assessment.level, assessment.label);
    if (hottest >= 85) alerts.push(hottest >= 95 ? "硬件温度高风险" : "硬件温度偏高");
    else if (hottest >= 70) alerts.push("硬件温度升高");
  } else {
    const availableSources = (health.temperatureSources || []).filter((item) => item.available).map((item) => item.name);
    const sourceText = availableSources.length ? `来源：${availableSources.join("、")}` : "已扫描 4 种来源，未发现传感器";
    setHealth("temperatureHealth", "temperatureBadge", "不支持", `${sourceText} · 请开启 LibreHardwareMonitor 的 Remote Web Server`, "", "未连接");
  }

  const physicalDisks = health.physicalDisks || [];
  if (physicalDisks.length) {
    checked++;
    const unhealthy = physicalDisks.filter((disk) => !/^healthy$/i.test(disk.health || "") ||
      disk.status?.some((status) => !/^ok$/i.test(status || "")));
    const level = unhealthy.length ? "warn" : "good";
    setHealth("diskHealth", "diskHealthBadge", unhealthy.length ? "需要留意" : "正常", `${physicalDisks.length} 块物理磁盘 · ${unhealthy.length ? unhealthy.map((disk) => disk.health || "状态异常").join("、") : "运行状态良好"}`, level, unhealthy.length ? "检查" : "良好");
    if (unhealthy.length) alerts.push("磁盘报告异常状态");
  } else {
    setHealth("diskHealth", "diskHealthBadge", "不可用", "设备未提供物理磁盘健康数据", "", "未支持");
    if (!detailsReady) setHealth("diskHealth", "diskHealthBadge", "检测中", "正在读取磁盘健康状态", "", "检测中");
  }

  const batteries = health.battery || [];
  if (batteries.length) {
    checked++;
    const charge = Math.min(...batteries.map((battery) => battery.charge));
    const low = charge <= 20;
    const level = low ? "warn" : "good";
    setHealth("batteryHealth", "batteryBadge", `${charge}%`, `${batteries.length} 块电池 · 当前剩余电量`, level, low ? "电量低" : "正常");
    if (low) alerts.push("电池电量偏低");
  } else {
    setHealth("batteryHealth", "batteryBadge", "不支持", "未检测到电池，通常为台式机", "", "不支持");
  }

  const antivirus = health.antivirus || [];
  if (antivirus.length) {
    checked++;
    const level = "good";
    setHealth("securityHealth", "securityBadge", "已启用", antivirus.map((item) => item.name).join("、"), level, `${antivirus.length} 项防护`);
  } else {
    setHealth("securityHealth", "securityBadge", "无法确认", "安全中心未返回防病毒产品信息", "warn", "请检查");
    alerts.push("无法确认防病毒防护状态");
    if (!detailsReady) setHealth("securityHealth", "securityBadge", "检测中", "正在读取安全防护状态", "", "检测中");
  }

  const uptimeHours = data.uptime / 3600;
  const uptimeLevel = uptimeHours > 24 * 14 ? "warn" : "good";
  setHealth("uptimeHealth", "uptimeBadge", formatUptime(data.uptime), uptimeHours > 24 * 14 ? "长时间未重启，可考虑重新启动" : "系统运行时间正常", uptimeLevel, uptimeLevel === "good" ? "正常" : "建议重启");
  checked++;
  if (uptimeLevel !== "good") alerts.push("系统已连续运行较长时间");

  const free = health.systemDriveFree;
  if (free != null) {
    checked++;
    const freeGB = free / 1024 ** 3;
    const level = freeGB < 10 ? "danger" : freeGB < 25 ? "warn" : "good";
    setHealth("systemDiskHealth", "systemDiskBadge", `${freeGB.toFixed(1)} GB`, "系统盘剩余空间", level, level === "good" ? "充足" : level === "warn" ? "偏少" : "不足");
    if (level !== "good") alerts.push("系统盘剩余空间偏少");
  } else {
    setHealth("systemDiskHealth", "systemDiskBadge", "暂不可用", "暂时无法读取系统盘空间", "warn", "重试");
    if (!detailsReady) setHealth("systemDiskHealth", "systemDiskBadge", "检测中", "正在读取系统盘空间", "", "检测中");
  }

  const summary = $("#healthSummary");
  const detail = $("#healthDetail");
  const dot = $("#healthDot");
  if (!detailsReady && data.detailsLoading) {
    summary.textContent = "正在检测";
    detail.textContent = data.detailsLoading ? "正在重新读取设备状态" : "首次检查可能需要几秒";
    dot.style.background = "#e6b94f";
    return;
  }
  if (alerts.length) {
    summary.textContent = `${alerts.length} 项需要留意`;
    detail.textContent = alerts[0];
    dot.style.background = alerts.some((alert) => alert.includes("过热") || alert.includes("空间")) ? "#e86f51" : "#e6b94f";
  } else {
    summary.textContent = "状态良好";
    detail.textContent = `${checked} 项状态正常`;
    dot.style.background = "#79ad68";
  }
}

function drawChart() {
  const chart = $("#chart"), grid = $("#chartGrid"), width = 900, height = 300, pad = { top: 14, right: 8, bottom: 25, left: 40 };
  if (!chart || !grid) return;
  grid.innerHTML = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (height - pad.top - pad.bottom) * i / 4;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right); line.setAttribute("y1", y); line.setAttribute("y2", y); line.setAttribute("stroke", colors.grid);
    grid.appendChild(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", 4); label.setAttribute("y", y + 4); label.setAttribute("fill", colors.text); label.setAttribute("font-size", "11"); label.textContent = `${100 - i * 25}`;
    grid.appendChild(label);
  }
  const points = state.history.slice(-40);
  if (!points.length) {
    $("#chartSummary").textContent = "正在读取实时数据...";
    return;
  }
  const latest = points[points.length - 1];
  $("#chartSummary").textContent = `当前：处理器 ${Math.round(latest.cpu)}% · 内存 ${Math.round(latest.memory)}% · 已采样 ${points.length} 次`;
  for (const [key, lineId, pointId] of [["cpu", "cpuLine", "cpuPoint"], ["memory", "memoryLine", "memoryPoint"]]) {
    const coords = points.map((item, index) => {
      const x = pad.left + index * (width - pad.left - pad.right) / Math.max(points.length - 1, 1);
      const y = pad.top + (100 - item[key]) * (height - pad.top - pad.bottom) / 100;
      return `${x},${y}`;
    }).join(" ");
    const line = $(`#${lineId}`);
    const point = $(`#${pointId}`);
    if (!line || !point) return;
    line.setAttribute("points", coords);
    const [x, y] = coords.split(" ").slice(-1)[0].split(",");
    point.setAttribute("cx", x); point.setAttribute("cy", y);
  }
}
function drawSparkline(lineId, pointId, key) {
  const line = $(`#${lineId}`), point = $(`#${pointId}`);
  if (!line || !point) return;
  const points = state.history.slice(-40);
  if (!points.length) {
    line.setAttribute("points", "");
    point.setAttribute("cx", "0");
    point.setAttribute("cy", "0");
    return;
  }
  const width = 240;
  const height = 58;
  const inset = 4;
  const coords = points.map((item, index) => {
    const value = Math.max(0, Math.min(100, Number(item[key]) || 0));
    const x = inset + index * (width - inset * 2) / Math.max(points.length - 1, 1);
    const y = inset + (100 - value) * (height - inset * 2) / 100;
    return `${x},${y}`;
  });
  if (coords.length === 1) coords.push(`${width - inset},${coords[0].split(",")[1]}`);
  line.setAttribute("points", coords.join(" "));
  const [x, y] = coords[coords.length - 1].split(",");
  point.setAttribute("cx", x);
  point.setAttribute("cy", y);
}
function drawSparklines() {
  drawSparkline("cpuSparklineLine", "cpuSparklinePoint", "cpu");
  drawSparkline("memorySparklineLine", "memorySparklinePoint", "memory");
}
function drawNetworkMiniChart() {
  const history = state.networkHistory.slice(-40);
  const width = 240, height = 58, inset = 3;
  const max = Math.max(1, ...history.map((item) => Math.max(Number(item.download) || 0, Number(item.upload) || 0)));
  for (const [key, id] of [["download", "networkMiniDownLine"], ["upload", "networkMiniUpLine"]]) {
    const line = $(`#${id}`);
    if (!line) continue;
    const points = history.map((item, index) => {
      const x = inset + index * (width - inset * 2) / Math.max(1, history.length - 1);
      const y = inset + (1 - Math.min(1, (Number(item[key]) || 0) / max)) * (height - inset * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    line.setAttribute("points", points.length === 1 ? `${points[0]} ${width - inset},${points[0].split(",")[1]}` : points.join(" "));
  }
}
function networkGroupLookup(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const name = String(group?.name || "").trim().toLowerCase();
    if (name) map.set(name, group);
  }
  return map;
}
function renderNetwork(data) {
  const network = data.network || {};
  const adapters = Array.isArray(network.adapters) ? network.adapters : [];
  const download = firstFinite(network.downloadBytesPerSecond);
  const upload = firstFinite(network.uploadBytesPerSecond);
  if (download != null || upload != null) {
    state.networkHistory.push({ download: download || 0, upload: upload || 0 });
    if (state.networkHistory.length > 40) state.networkHistory.shift();
  }
  const history = state.networkHistory;
  const peakDownload = history.length ? Math.max(...history.map((item) => item.download)) : 0;
  const peakUpload = history.length ? Math.max(...history.map((item) => item.upload)) : 0;
  if ($("#networkDownload")) $("#networkDownload").textContent = formatRate(download);
  if ($("#networkUpload")) $("#networkUpload").textContent = formatRate(upload);
  if ($("#networkDownloadMeta")) $("#networkDownloadMeta").textContent = history.length ? `本轮峰值 ${formatRate(peakDownload)}` : "等待采样";
  if ($("#networkUploadMeta")) $("#networkUploadMeta").textContent = history.length ? `本轮峰值 ${formatRate(peakUpload)}` : "等待采样";
  if ($("#networkMiniDownload")) $("#networkMiniDownload").textContent = formatRate(download);
  if ($("#networkMiniUpload")) $("#networkMiniUpload").textContent = formatRate(upload);
  if ($("#networkMiniMeta")) $("#networkMiniMeta").textContent = history.length ? `最近 ${history.length} 次采样` : "等待采样";
  if ($("#networkLiveState")) {
    const stamp = network.checkedAt ? `采样于 ${new Date(network.checkedAt).toLocaleTimeString()}` : "等待采样";
    $("#networkLiveState").innerHTML = `<i></i>${escapeHtml(stamp)}`;
  }
  const visibleAdapters = adapters.slice(0, 8);
  const maxAdapterTotal = Math.max(1, ...visibleAdapters.map((adapter) => (adapter.downloadBytesPerSecond || 0) + (adapter.uploadBytesPerSecond || 0)));
  const adapterBox = $("#networkAdapters");
  if (adapterBox) {
    adapterBox.innerHTML = visibleAdapters.length ? visibleAdapters.map((adapter) => {
      const down = Number(adapter.downloadBytesPerSecond) || 0;
      const up = Number(adapter.uploadBytesPerSecond) || 0;
      const share = Math.round(Math.min(1, (down + up) / maxAdapterTotal) * 100);
      const note = adapter.virtual ? "虚拟 / VPN 接口，未计入总量" : "物理网卡";
      return `<div class="network-adapter${adapter.virtual ? " is-virtual" : ""}">
        <div class="network-adapter-name"><strong>${escapeHtml(adapter.displayName || adapter.name || "网卡")}</strong><small>${note}${adapter.source === "LibreHardwareMonitor" ? " · LibreHardwareMonitor" : ""}</small></div>
        <div class="network-adapter-bar"><i style="width:${share}%"></i></div>
        <div class="network-adapter-reading"><span>↓ ${formatRate(down)}</span><span>↑ ${formatRate(up)}</span></div>
      </div>`;
    }).join("") : '<p class="empty">未读取到网卡速率，请确认 Windows 性能计数器或 LibreHardwareMonitor 可用。</p>';
  }
  if ($("#networkSourceNote")) {
    const hasRate = download != null || upload != null;
    const window = network.sampledSeconds ? ` · 采样窗口约 ${Number(network.sampledSeconds).toFixed(1)} 秒` : "";
    if (!hasRate) {
      $("#networkSourceNote").textContent = network.error
        ? `网络速率暂不可用：${network.error}`
        : "正在读取网络速率，速率与连接只在本机统计。";
    } else {
      $("#networkSourceNote").textContent = `数据来源：${networkSourceLabel(network.source)}${window}。下载/上传为整机合计，虚拟网卡（VPN、代理、虚拟交换机）不计入总量。` +
        (network.error ? ` 程序级流量统计暂不可用：${network.error}` : "");
    }
  }
  drawNetworkChart();
  drawNetworkMiniChart();
  renderNetworkProcesses(network);
}
function drawNetworkChart() {
  const chart = $("#networkChart"), grid = $("#networkChartGrid");
  if (!chart || !grid) return;
  const width = 900, height = 220, pad = { top: 16, right: 16, bottom: 16, left: 86 };
  const history = state.networkHistory.slice(-40);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const axis = networkAxis(Math.max(0, ...history.map((item) => Math.max(item.download, item.upload))));
  grid.innerHTML = "";
  for (let index = 0; index <= 4; index++) {
    const y = pad.top + plotHeight * index / 4;
    const zeroLine = index === 4;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right);
    line.setAttribute("y1", y); line.setAttribute("y2", y);
    line.setAttribute("stroke", zeroLine ? "#d8e2da" : colors.grid);
    if (!zeroLine) line.setAttribute("stroke-dasharray", "3 6");
    grid.appendChild(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", pad.left - 12); label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end"); label.setAttribute("fill", colors.text); label.setAttribute("font-size", "11");
    label.textContent = axis.label(axis.max * (1 - index / 4));
    grid.appendChild(label);
  }
  const summary = $("#networkChartSummary");
  const series = [
    ["download", "networkDownLine", "networkDownPoint", "networkDownArea"],
    ["upload", "networkUpLine", "networkUpPoint", "networkUpArea"]
  ];
  if (history.length < 2) {
    for (const [, lineId, , areaId] of series) {
      $(`#${lineId}`)?.setAttribute("points", "");
      $(`#${areaId}`)?.setAttribute("points", "");
    }
    if (summary) summary.textContent = "正在积累采样数据...";
    return;
  }
  const xFor = (index) => pad.left + index * plotWidth / (history.length - 1);
  const yFor = (value) => pad.top + (1 - Math.min(1, Math.max(0, Number(value) || 0) / axis.max)) * plotHeight;
  const baseline = (pad.top + plotHeight).toFixed(1);
  const latest = history[history.length - 1];
  if (summary) {
    summary.textContent = `当前 ↓ ${formatRate(latest.download)} · ↑ ${formatRate(latest.upload)} · 已采样 ${history.length} 次`;
  }
  for (const [key, lineId, pointId, areaId] of series) {
    const coords = history.map((item, index) => `${xFor(index).toFixed(1)},${yFor(item[key]).toFixed(1)}`);
    $(`#${lineId}`)?.setAttribute("points", coords.join(" "));
    $(`#${areaId}`)?.setAttribute("points", [`${xFor(0).toFixed(1)},${baseline}`, ...coords, `${xFor(history.length - 1).toFixed(1)},${baseline}`].join(" "));
    const [x, y] = coords[coords.length - 1].split(",");
    const point = $(`#${pointId}`);
    point?.setAttribute("cx", x);
    point?.setAttribute("cy", y);
  }
}
function renderNetworkProcesses(network) {
  const container = $("#networkProcesses");
  if (!container) return;
  const perProcessAvailable = Boolean(network?.processRateSource);
  const groups = (network?.groups || []).filter((group) => (group.bytesPerSecond || 0) > 0 || (group.connections || 0) > 0);
  if ($("#networkProcessCount")) {
    $("#networkProcessCount").textContent = groups.length ? `${groups.length} 个程序占用网络` : "--";
  }
  if (!groups.length) {
    const message = !perProcessAvailable
      ? "程序级网络统计暂不可用：Windows 性能计数器读取失败，可尝试以管理员身份运行观察器。"
      : "当前没有检测到程序占用网络。";
    container.innerHTML = `<tr><td colspan="4" class="empty">${message}</td></tr>`;
  } else {
    const top = groups.slice(0, 12);
    const maxRate = Math.max(1, ...top.map((group) => group.bytesPerSecond || 0));
    container.innerHTML = top.map((group) => {
      const rate = Number(group.bytesPerSecond) || 0;
      const share = perProcessAvailable ? Math.round(Math.min(1, rate / maxRate) * 100) : 0;
      const peers = (group.peers || []).length ? group.peers.join("、") : "无外部连接";
      const pids = (group.pids || []).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
      const action = pids.length ? processActionButton(pids, processDisplayName(group.name)) : "";
      const connectionText = group.connections
        ? `${group.connections} 个${group.established ? ` · 已建立 ${group.established}` : ""}`
        : "—";
      return `<tr class="network-rank-row">
        <td class="process-name process-name-cell"><span>${escapeHtml(processDisplayName(group.name))}</span><span class="process-inline-actions">${action}</span></td>
        <td><div class="network-rate"><span class="network-rate-bar"><i style="width:${share}%"></i></span><strong>${perProcessAvailable ? formatRate(rate) : "—"}</strong></div></td>
        <td>${connectionText}</td>
        <td class="network-peers" title="${escapeHtml(peers)}">${escapeHtml(peers)}</td>
      </tr>`;
    }).join("");
  }
  if ($("#networkProcessNote")) {
    $("#networkProcessNote").textContent = perProcessAvailable
      ? `速率按每个程序的“其他 I/O”计数器估算（覆盖网络套接字，同时包含管道等其他设备 I/O），观察器自身不计入；连接信息来自 netstat，后台自动采样。来源：${networkSourceLabel(network.processRateSource)}。`
      : `程序级流量需要 Windows 性能计数器（PDH），当前不可用；表格中的连接与端口信息仍来自 netstat。`;
  }
}
function renderDisks(disks) {
  $("#disks").innerHTML = disks.length ? disks.map((disk) => {
    const used = disk.total ? (disk.total - disk.free) / disk.total * 100 : 0;
    return `<div class="disk-row"><div class="disk-label"><strong>${disk.name}</strong><span>${formatBytes(disk.free)} 可用</span></div><div class="disk-bar"><i style="width:${used}%"></i></div></div>`;
  }).join("") : '<p class="empty">未读取到本地磁盘</p>';
}
function processDisplayName(name) {
  const cleanName = String(name || "未知进程").replace(/\.exe$/i, "");
  const knownNames = { chrome: "Chrome", doubao: "Doubao" };
  return knownNames[cleanName.toLowerCase()] || cleanName;
}
function groupProcesses(processes) {
  const groups = new Map();
  for (const process of processes || []) {
    const label = processDisplayName(process.name);
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, label, items: [], memory: 0, cpuValues: [] });
    const group = groups.get(key);
    group.items.push(process);
    group.memory += Number(process.memory) || 0;
    if (Number.isFinite(Number(process.cpuPercent))) group.cpuValues.push(Number(process.cpuPercent));
  }
  return [...groups.values()].map((group) => ({
    ...group,
    cpuPercent: group.cpuValues.length === group.items.length
      ? group.cpuValues.reduce((sum, value) => sum + value, 0)
      : null
  })).sort((a, b) => {
    const aCpu = Number.isFinite(a.cpuPercent) ? a.cpuPercent : -1;
    const bCpu = Number.isFinite(b.cpuPercent) ? b.cpuPercent : -1;
    return bCpu - aCpu || b.memory - a.memory;
  });
}
function formatProcessCpu(value) {
  if (!Number.isFinite(Number(value))) return "采样中";
  const cpu = Number(value);
  return cpu > 0 && cpu < 0.1 ? "<0.1%" : `${cpu.toFixed(1)}%`;
}
function processActionButton(pids, label) {
  const pidList = pids.filter((pid) => Number.isInteger(Number(pid))).join(",");
  const description = pids.length > 1 ? `结束 ${label} 中的 ${pids.length} 个进程` : `结束 ${label}`;
  return `<button class="process-kill" type="button" data-process-kill data-pids="${escapeHtml(pidList)}" data-process-label="${escapeHtml(label)}" title="${escapeHtml(description)}">结束进程</button>`;
}
function renderProcessRow(process, label, groupKey, index, child = false, networkRate = null) {
  const name = child ? `${label} 子进程 ${index + 1}` : label;
  return `<tr class="process-child-row" data-process-child-of="${escapeHtml(groupKey)}">
    <td class="process-name process-name-cell ${child ? "process-child-name" : ""}"><span>${escapeHtml(name)}</span><span class="process-inline-actions">${processActionButton([process.pid], `${label} 子进程`)}</span></td>
    <td>${formatProcessCpu(process.cpuPercent)}</td>
    <td>${formatBytes(process.memory)}</td>
    <td class="process-network">${networkRate == null ? "—" : formatRate(networkRate)}</td>
  </tr>`;
}
function renderProcesses(processes, networkGroups) {
  const groups = groupProcesses(processes);
  const networkByName = networkGroupLookup(networkGroups);
  const rateForGroup = (key) => {
    const group = networkByName.get(String(key || "").toLowerCase());
    return group ? Number(group.bytesPerSecond) || 0 : null;
  };
  const rateForPid = (key, pid) => {
    const group = networkByName.get(String(key || "").toLowerCase());
    if (!group) return null;
    const entry = (group.rates || []).find((item) => Number(item.pid) === Number(pid));
    return entry ? Number(entry.bytesPerSecond) : null;
  };
  const total = (processes || []).length;
  $("#processCount").textContent = `${groups.length} 个程序 · ${total} 个进程`;
  if (!groups.length) {
    $("#processes").innerHTML = '<tr><td colspan="4" class="empty">未读取到进程</td></tr>';
    return;
  }
  $("#processes").innerHTML = groups.map((group) => {
    const expanded = state.expandedProcessGroups.has(group.key);
    const hasChildren = group.items.length > 1;
    const name = hasChildren ? `${group.label} (${group.items.length} 个进程)` : group.label;
    const toggle = hasChildren
      ? `<button class="process-group-toggle" type="button" data-process-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded}" title="展开或收起子进程"><span class="process-chevron">${expanded ? "▾" : "▸"}</span><span>${escapeHtml(name)}</span></button>`
      : `<span class="process-single-name">${escapeHtml(name)}</span>`;
    const groupRate = rateForGroup(group.key);
    const groupRow = `<tr class="process-group-row" data-process-group-row="${escapeHtml(group.key)}">
      <td class="process-name process-name-cell">${toggle}<span class="process-inline-actions">${processActionButton(group.items.map((item) => item.pid), name)}</span></td>
      <td>${formatProcessCpu(group.cpuPercent)}</td>
      <td>${formatBytes(group.memory)}</td>
      <td class="process-network">${groupRate == null ? "—" : formatRate(groupRate)}</td>
    </tr>`;
    const childRows = hasChildren ? group.items.map((process, index) => renderProcessRow(process, group.label, group.key, index, true, rateForPid(group.key, process.pid))).join("") : "";
    return groupRow + childRows.replace(/<tr /g, `<tr${expanded ? "" : " hidden"} `);
  }).join("");
}

function reportItem(level, title, detail) {
  const label = { danger: "高风险", warn: "需关注", good: "正常", info: "信息" }[level] || "信息";
  return `<article class="report-item ${level}">
    <div class="report-item-mark">${level === "danger" ? "!" : level === "warn" ? "!" : level === "good" ? "✓" : "i"}</div>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>
    <span class="report-tag">${label}</span>
  </article>`;
}

function reportSuggestion(title, detail) {
  return `<article class="report-item suggestion">
    <div class="report-item-mark">→</div>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>
  </article>`;
}

function buildAnalysis(data) {
  const health = data.systemHealth || {};
  const memoryTotal = Number(data.memory?.total || 0);
  const memoryUsed = Number(data.memory?.used || 0);
  const memoryPercent = memoryTotal ? memoryUsed / memoryTotal * 100 : null;
  const cpu = Number(data.cpu);
  const temperatures = (health.temperatures || []).map(Number).filter(Number.isFinite);
  const highestTemperature = temperatures.length ? Math.max(...temperatures) : null;
  const physicalDisks = health.physicalDisks || [];
  const batteries = health.battery || [];
  const findings = [];
  const suggestions = [];

  if (highestTemperature == null) {
    findings.push({ level: "info", title: "温度数据未获取", detail: "当前没有可用的实时温度传感器读数，无法判断是否过热。" });
    suggestions.push(["补充温度数据", "在 LibreHardwareMonitor 中开启 Remote Web Server，然后重新检测，避免遗漏过热风险。"]);
  } else if (highestTemperature >= 95) {
    findings.push({ level: "danger", title: `最高温度 ${highestTemperature.toFixed(1)}°C`, detail: "已进入高风险区间，可能触发降频、卡顿或自动保护。" });
    suggestions.push(["立即降低负载", "暂停游戏、渲染或大型计算任务，检查散热口和风扇积尘，待温度下降后再继续使用。"]);
  } else if (highestTemperature >= 70) {
    findings.push({ level: "warn", title: `最高温度 ${highestTemperature.toFixed(1)}°C`, detail: "温度处于需要观察的区间，持续高温可能影响性能和稳定性。" });
    suggestions.push(["观察散热状态", "保持通风并观察温度曲线；如果低负载时仍长期偏高，建议清理风道并检查风扇。"]);
  } else {
    findings.push({ level: "good", title: `温度正常，最高 ${highestTemperature.toFixed(1)}°C`, detail: `${health.temperatureSensors?.length || temperatures.length} 个传感器当前没有明显过热迹象。` });
  }

  if (Number.isFinite(cpu)) {
    if (cpu >= 90) {
      findings.push({ level: "danger", title: `CPU 当前占用 ${Math.round(cpu)}%`, detail: "处理器接近满载，可能造成响应变慢或风扇持续高速运行。" });
      suggestions.push(["检查高负载程序", "查看活动进程列表，优先关闭不必要的渲染、同步或后台任务，并观察占用是否持续。"]);
    } else if (cpu >= 75) {
      findings.push({ level: "warn", title: `CPU 当前占用 ${Math.round(cpu)}%`, detail: "当前负载偏高，短时峰值通常可接受，持续偏高需要进一步排查。" });
      suggestions.push(["持续观察 CPU 曲线", "先观察 1 至 3 分钟；如果持续高于 75%，再根据活动进程定位具体程序。"]);
    } else {
      findings.push({ level: "good", title: `CPU 当前占用 ${Math.round(cpu)}%`, detail: "当前处理器负载处于日常使用范围。" });
    }
  }

  if (memoryPercent == null) {
    findings.push({ level: "info", title: "内存数据未获取", detail: "当前无法计算内存使用比例。" });
  } else if (memoryPercent >= 90) {
    findings.push({ level: "danger", title: `内存使用 ${Math.round(memoryPercent)}%`, detail: "可用内存很少，可能出现卡顿、换页或程序无响应。" });
    suggestions.push(["释放内存压力", "关闭暂时不用的大型程序和浏览器标签；如果经常达到此水平，建议增加内存或减少开机自启项。"]);
  } else if (memoryPercent >= 80) {
    findings.push({ level: "warn", title: `内存使用 ${Math.round(memoryPercent)}%`, detail: "内存占用偏高，继续运行大型程序时可能影响响应速度。" });
    suggestions.push(["减少后台占用", "检查活动进程中的内存占用，关闭暂时不用的程序并观察内存曲线是否回落。"]);
  } else {
    findings.push({ level: "good", title: `内存使用 ${Math.round(memoryPercent)}%`, detail: `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}，当前余量正常。` });
  }

  if (!physicalDisks.length) {
    findings.push({ level: "info", title: "磁盘健康数据未获取", detail: "当前没有返回物理磁盘健康状态，无法判断 SSD/HDD 的寿命信息。" });
    suggestions.push(["补充磁盘健康数据", "保持 LibreHardwareMonitor 数据源运行；重要文件应保持备份，避免只依赖当前健康状态。"]);
  } else {
    const unhealthy = physicalDisks.filter((disk) => !/^healthy$/i.test(disk.health || "") || disk.status?.some((status) => !/^ok$/i.test(status || "")));
    const lowLife = physicalDisks.filter((disk) => Number.isFinite(Number(disk.life)) && Number(disk.life) < 80);
    if (unhealthy.length || lowLife.length) {
      findings.push({ level: lowLife.some((disk) => Number(disk.life) < 20) ? "danger" : "warn", title: "磁盘健康需要关注", detail: physicalDisks.map((disk) => `${disk.name || "磁盘"}：${disk.health || "未知"}${disk.life != null ? `，寿命 ${disk.life}%` : ""}`).join("；") });
      suggestions.push(["优先备份重要文件", "对健康异常或寿命下降的磁盘做完整备份，并使用厂商工具进一步检查 SMART 状态。"]);
    } else {
      findings.push({ level: "good", title: "磁盘健康正常", detail: `${physicalDisks.length} 块物理磁盘状态良好。` });
    }
  }

  const systemFree = Number(health.systemDriveFree);
  if (Number.isFinite(systemFree)) {
    const freeGB = systemFree / 1024 ** 3;
    if (freeGB < 10) {
      findings.push({ level: "danger", title: `系统盘仅剩 ${freeGB.toFixed(1)} GB`, detail: "系统盘空间不足可能影响更新、缓存和虚拟内存。" });
      suggestions.push(["立即清理系统盘", "清理临时文件、回收站和下载目录，或将大型文件迁移到其他磁盘，尽量保留 25 GB 以上空间。"]);
    } else if (freeGB < 25) {
      findings.push({ level: "warn", title: `系统盘剩余 ${freeGB.toFixed(1)} GB`, detail: "空间偏少，继续使用可能逐渐影响系统更新和程序运行。" });
      suggestions.push(["规划系统盘清理", "删除不需要的临时文件和大型安装包，建议将系统盘可用空间恢复到 25 GB 以上。"]);
    } else {
      findings.push({ level: "good", title: `系统盘剩余 ${freeGB.toFixed(1)} GB`, detail: "当前空间能够满足日常系统运行。" });
    }
  }

  if (!health.antivirus?.length) {
    findings.push({ level: "danger", title: "安全防护状态无法确认", detail: "安全中心没有返回正在运行的防护服务。" });
    suggestions.push(["检查系统防护", "确认 Microsoft Defender、防火墙和 Windows 安全中心服务处于运行状态，并及时更新病毒库。"]);
  } else {
    findings.push({ level: "good", title: "安全防护服务已读取", detail: `${health.antivirus.length} 项 Windows 防护服务处于运行状态。` });
  }

  if (batteries.length) {
    const lowestCharge = Math.min(...batteries.map((battery) => Number(battery.charge)).filter(Number.isFinite));
    const highestDegradation = Math.max(...batteries.map((battery) => Number(battery.degradation)).filter(Number.isFinite));
    if (Number.isFinite(highestDegradation) && highestDegradation >= 35) {
      findings.push({ level: "danger", title: `电池损耗约 ${highestDegradation.toFixed(1)}%`, detail: "电池容量明显衰减，续航时间和断电稳定性可能已经受到影响。" });
      suggestions.push(["评估更换电池", "优先查看电池设计容量与当前满充容量；如果续航明显下降或出现鼓包，应停止使用并更换电池。"]);
    } else if (Number.isFinite(highestDegradation) && highestDegradation >= 20) {
      findings.push({ level: "warn", title: `电池损耗约 ${highestDegradation.toFixed(1)}%`, detail: `当前电量 ${Number.isFinite(lowestCharge) ? lowestCharge : "--"}%，电池已有可观察的容量衰减。` });
      suggestions.push(["关注电池续航", "减少长期高温和满电插电使用，观察满充容量变化；续航明显下降时考虑更换电池。"]);
    } else {
      findings.push({ level: "good", title: `电池状态正常，当前 ${Number.isFinite(lowestCharge) ? lowestCharge : "--"}%`, detail: Number.isFinite(highestDegradation) ? `检测到的容量损耗约 ${highestDegradation.toFixed(1)}%。` : "当前读取到电池电量，未获取损耗率。" });
    }
  }

  const uptimeDays = Number(data.uptime || 0) / 86400;
  if (uptimeDays > 14) {
    findings.push({ level: "warn", title: `系统已连续运行 ${Math.floor(uptimeDays)} 天`, detail: "长时间不重启可能积累更新、缓存和驱动状态问题。" });
    suggestions.push(["安排一次重启", "在方便时保存工作并重启电脑，让系统完成挂起的更新并释放长期占用的资源。"]);
  }

  const topMemoryProcess = (data.processes || []).slice().sort((a, b) => Number(b.memory || 0) - Number(a.memory || 0))[0];
  if (topMemoryProcess && memoryTotal && Number(topMemoryProcess.memory) / memoryTotal >= 0.15) {
    const share = Number(topMemoryProcess.memory) / memoryTotal * 100;
    findings.push({ level: "warn", title: `${topMemoryProcess.name} 占用内存 ${share.toFixed(1)}%`, detail: `进程 ID ${topMemoryProcess.pid} 当前占用约 ${formatBytes(topMemoryProcess.memory)}，值得结合使用场景观察。` });
    suggestions.push(["检查高内存进程", `如果 ${topMemoryProcess.name} 并非当前必要程序，建议关闭后观察内存曲线；不要直接结束不明系统进程。`]);
  }

  const concernCount = findings.filter((item) => item.level === "warn" || item.level === "danger").length;
  const dataGapCount = findings.filter((item) => item.level === "info").length;
  const attentionCount = concernCount + dataGapCount;
  const dangerCount = findings.filter((item) => item.level === "danger").length;
  const score = Math.max(0, 100 - dangerCount * 24 - Math.max(0, concernCount - dangerCount) * 10 - dataGapCount * 5);
  const scoreLabel = dangerCount ? "需要尽快处理" : concernCount ? "建议持续关注" : dataGapCount ? "数据不完整" : "当前状态良好";
  const summary = concernCount
    ? `本次分析发现 ${concernCount} 项需要关注${dangerCount ? `，其中 ${dangerCount} 项属于高风险` : ""}${dataGapCount ? `，另有 ${dataGapCount} 项数据不完整` : ""}。建议优先处理高风险项目，再观察实时曲线是否恢复。`
    : dataGapCount
      ? `当前已读取到的指标没有明显异常，但有 ${dataGapCount} 项数据不完整，暂时不能对对应硬件做出完整判断。`
      : "当前已读取到的关键指标没有明显异常，建议保持实时观察并按建议维护设备。";
  const evidence = [
    health.temperatureSource ? `温度来源：${health.temperatureSource}` : "温度来源：未连接",
    health.physicalDisks?.length ? `物理磁盘：${health.physicalDisks.length} 块` : "物理磁盘：未获取",
    data.processes?.length ? `活动进程：${data.processes.length} 个` : "活动进程：未获取",
    data.timestamp ? `采样时间：${new Date(data.timestamp).toLocaleTimeString()}` : "采样时间：未知"
  ].join(" · ");

  return {
    score,
    scoreLabel,
    scoreLevel: dangerCount ? "danger" : concernCount ? "warn" : dataGapCount ? "info" : "good",
    summary,
    evidence,
    findings,
    suggestions,
    attentionCount,
    concernCount,
    dangerCount,
    dataGapCount,
    memoryTotal,
    memoryUsed,
    memoryPercent,
    cpu,
    highestTemperature,
    physicalDisks,
    batteries
  };
}

function renderAnalysisReport(data) {
  const model = buildAnalysis(data);
  const scoreElement = $("#reportScore");
  if (scoreElement) scoreElement.textContent = `${model.score}`;
  if (scoreElement?.parentElement) scoreElement.parentElement.className = `report-score ${model.scoreLevel}`;
  if ($("#reportScoreLabel")) $("#reportScoreLabel").textContent = model.scoreLabel;
  if ($("#reportGenerated")) $("#reportGenerated").textContent = `基于本机实时快照 · ${data.timestamp ? new Date(data.timestamp).toLocaleString() : "等待时间"}`;
  if ($("#reportSummary")) $("#reportSummary").textContent = model.summary;
  if ($("#reportAttentionCount")) $("#reportAttentionCount").textContent = `${model.attentionCount} 项`;
  if ($("#reportSuggestionCount")) $("#reportSuggestionCount").textContent = `${model.suggestions.length} 条`;
  if ($("#reportEvidence")) $("#reportEvidence").textContent = model.evidence;
  if ($("#reportFindings")) $("#reportFindings").innerHTML = model.findings.map((item) => reportItem(item.level, item.title, item.detail)).join("");
  if ($("#reportSuggestions")) {
    $("#reportSuggestions").innerHTML = model.suggestions.length
      ? model.suggestions.map(([title, detail]) => reportSuggestion(title, detail)).join("")
      : reportSuggestion("保持当前状态", "继续保持通风、及时更新系统，并定期查看本报告。");
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return sameDay ? time : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}
function formatStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
function formatEventDuration(seconds) {
  const value = Number(seconds) || 0;
  if (value >= 3600) return `${Math.floor(value / 3600)} 小时 ${Math.round((value % 3600) / 60)} 分`;
  if (value >= 60) return `${Math.round(value / 60)} 分钟`;
  if (value >= 5) return `${value} 秒`;
  return "瞬时";
}
const historyPeakTones = {
  cpu: [{ level: "danger", value: 90 }, { level: "warn", value: 75 }],
  memory: [{ level: "danger", value: 90 }, { level: "warn", value: 80 }],
  temperature: [{ level: "danger", value: 95 }, { level: "warn", value: 85 }]
};
function peakTone(metric, value) {
  const thresholds = historyPeakTones[metric] || [];
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (thresholds.find((item) => number >= item.value)?.level === "danger") return "is-danger";
  if (thresholds.find((item) => number >= item.value)?.level === "warn") return "is-warn";
  return "is-good";
}
function activeHistoryWindow(history) {
  const key = state.historyWindow === "day" ? "day" : "session";
  const window = history?.peaks?.[key] || null;
  return { key, window };
}
function renderHistory(data) {
  const history = data.history || {};
  const { key, window: current } = activeHistoryWindow(history);
  const tiles = [
    { metric: "cpu", tileId: "historyPeakCpu", valueId: "historyCpuValue", metaId: "historyCpuMeta", peak: current?.cpu, unit: "%" },
    { metric: "memory", tileId: "historyPeakMemory", valueId: "historyMemoryValue", metaId: "historyMemoryMeta", peak: current?.memory, unit: "%" },
    { metric: "temperature", tileId: "historyPeakTemperature", valueId: "historyTemperatureValue", metaId: "historyTemperatureMeta", peak: current?.temperature, unit: "°C" }
  ];
  for (const tile of tiles) {
    const valueElement = $(`#${tile.valueId}`);
    const metaElement = $(`#${tile.metaId}`);
    const tileElement = $(`#${tile.tileId}`);
    if (valueElement) valueElement.textContent = tile.peak ? `${tile.peak.value}${tile.unit}` : "--";
    if (tileElement) {
      tileElement.className = `history-peak ${tile.peak ? peakTone(tile.metric, tile.peak.value) : "is-empty"}`;
    }
    if (metaElement) {
      if (!tile.peak) {
        metaElement.textContent = "暂无采样数据";
      } else {
        const parts = [`发生在 ${formatClock(tile.peak.at)}`];
        if (tile.peak.process) {
          const detail = tile.peak.processDetail ? `（${tile.peak.processDetail}）` : "";
          parts.push(`当时最高：${processDisplayName(tile.peak.process)}${detail}`);
        }
        if (tile.peak.restored) parts.push("来自持久化历史");
        metaElement.textContent = parts.join(" · ");
      }
    }
  }
  for (const button of document.querySelectorAll("[data-history-window]")) {
    const active = button.dataset.historyWindow === key;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const events = history.events || [];
  if ($("#historyEventCount")) $("#historyEventCount").textContent = events.length ? `${events.length} 条` : "--";
  const container = $("#historyEvents");
  if (container) {
    container.innerHTML = events.length ? events.map((event) => {
      const level = event.level === "danger" ? "danger" : "warn";
      const process = event.process ? ` · 当时最高：${escapeHtml(processDisplayName(event.process))}` : "";
      return `<article class="history-event ${level}">
        <span class="history-event-time">${escapeHtml(formatClock(event.peakAt))}</span>
        <strong>${escapeHtml(event.metricLabel)} 峰值 ${event.peak}${escapeHtml(event.unit)}</strong>
        <small>持续约 ${escapeHtml(formatEventDuration(event.durationSeconds))}${process}</small>
      </article>`;
    }).join("") : '<p class="empty">最近没有明显异常峰值。</p>';
  }
  state.historySeries = Array.isArray(history.series) ? history.series : [];
  drawHistoryChart();
  if ($("#historySampleNote")) {
    $("#historySampleNote").textContent = `最近一小时 · ${state.historySeries.length} 个数据点（每 30 秒取峰值）`;
  }
  if ($("#historySourceNote")) {
    const label = current?.label || (key === "day" ? "最近 24 小时" : "本次开机以来");
    const interval = Math.round((Number(history.sampleIntervalMs) || 5000) / 1000);
    const saved = history.savedAt ? `上次写入磁盘 ${formatClock(history.savedAt)}` : "尚未写入磁盘";
    $("#historySourceNote").textContent = `${label} · 每 ${interval} 秒采样 · 保留 ${history.retentionHours || 24} 小时 · 已记录 ${history.sampleCount || 0} 个采样点 · ${saved}。关闭或重启观察器后历史仍然保留。`;
  }
}
function drawHistoryChart() {
  const grid = $("#historyChartGrid");
  if (!grid) return;
  const width = 900, height = 200, pad = { top: 14, right: 14, bottom: 14, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const series = (state.historySeries || []).filter((item) => Number.isFinite(Number(item.at)));
  grid.innerHTML = "";
  for (let index = 0; index <= 4; index++) {
    const y = pad.top + plotHeight * index / 4;
    const zeroLine = index === 4;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right);
    line.setAttribute("y1", y); line.setAttribute("y2", y);
    line.setAttribute("stroke", zeroLine ? "#d8e2da" : colors.grid);
    if (!zeroLine) line.setAttribute("stroke-dasharray", "3 6");
    grid.appendChild(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", pad.left - 10); label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end"); label.setAttribute("fill", colors.text); label.setAttribute("font-size", "11");
    label.textContent = `${100 - index * 25}%`;
    grid.appendChild(label);
  }
  const seriesDefs = [["cpu", "historyCpuLine", "historyCpuPoint"], ["memory", "historyMemoryLine", "historyMemoryPoint"]];
  if (series.length < 2) {
    for (const [, lineId] of seriesDefs) {
      $(`#${lineId}`)?.setAttribute("points", "");
      const point = $(`#${lineId.replace("Line", "Point")}`);
      point?.setAttribute("cx", "0");
      point?.setAttribute("cy", "0");
    }
    return;
  }
  const xFor = (index) => pad.left + index * plotWidth / (series.length - 1);
  const yFor = (value) => pad.top + (1 - Math.min(1, Math.max(0, Number(value) || 0) / 100)) * plotHeight;
  for (const [metric, lineId, pointId] of seriesDefs) {
    const available = series.map((item, index) => ({ index, value: Number(item[metric]) })).filter((item) => Number.isFinite(item.value));
    if (available.length < 2) {
      $(`#${lineId}`)?.setAttribute("points", "");
      continue;
    }
    const coords = available.map((item) => `${xFor(item.index).toFixed(1)},${yFor(item.value).toFixed(1)}`);
    $(`#${lineId}`)?.setAttribute("points", coords.join(" "));
    const [x, y] = coords[coords.length - 1].split(",");
    const point = $(`#${pointId}`);
    point?.setAttribute("cx", x);
    point?.setAttribute("cy", y);
  }
}
function reportFileName(prefix, extension) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${prefix}-${stamp}.${extension}`;
}
function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
function levelLabel(level) {
  return { danger: "高风险", warn: "需关注", good: "正常", info: "信息" }[level] || "信息";
}
function metricRows(data) {
  const analysis = buildAnalysis(data);
  const hardware = data.hostInfo || data.hardware || {};
  const health = data.systemHealth || {};
  const disks = data.disks || [];
  const systemDisk = disks.find((disk) => String(disk.name).toUpperCase() === "C:") || disks[0];
  const diskDetail = analysis.physicalDisks
    .map((disk) => `${disk.name || "磁盘"} ${disk.health || "状态未知"}${disk.life != null ? ` · 寿命 ${Math.round(disk.life)}%` : ""}${disk.temperatureCelsius != null ? ` · ${disk.temperatureCelsius}°C` : ""}`)
    .join("；");
  return [
    ["处理器", `${Math.round(Number(data.cpu) || 0)}%`, `${data.logicalCores || "-"} 个逻辑处理器 · ${hardware.processor || "未知处理器"}`],
    ["内存", analysis.memoryPercent == null ? "--" : `${Math.round(analysis.memoryPercent)}%`, `${formatBytes(analysis.memoryUsed)} / ${formatBytes(analysis.memoryTotal)}${hardware.memoryDataRateMTs ? ` · ${hardware.memoryDataRateMTs} MT/s` : ""}`],
    ["温度", analysis.highestTemperature == null ? "未获取" : `${analysis.highestTemperature.toFixed(1)}°C`, health.temperatureSource ? `来源 ${health.temperatureSource} · ${(health.temperatureSensors || []).length} 个传感器` : "未连接温度数据源"],
    ["系统盘", systemDisk ? `${formatBytes(systemDisk.free)} 可用` : "未读取", systemDisk ? `${systemDisk.name} 共 ${formatBytes(systemDisk.total)}` : "—"],
    ["磁盘健康", analysis.physicalDisks.length ? `${analysis.physicalDisks.length} 块物理磁盘` : "未获取", diskDetail || "未返回可靠性数据"],
    ["网络", `${formatRate(data.network?.downloadBytesPerSecond)} 下载 / ${formatRate(data.network?.uploadBytesPerSecond)} 上传`, `来源 ${networkSourceLabel(data.network?.source)}`],
    ["电池", analysis.batteries.length ? `${analysis.batteries[0].charge}%` : "未检测到", analysis.batteries.length ? "已读取电池信息" : "台式机或未提供电池"],
    ["运行时间", formatUptime(data.uptime || 0), `开机于 ${formatStamp(Date.now() - (data.uptime || 0) * 1000)}`],
    ["整机", `${hardware.manufacturer || "未知厂商"} ${hardware.model || ""}`.trim(), `${hardware.gpuName || "未知显卡"}${hardware.gpuMemoryBytes ? ` · ${formatBytes(hardware.gpuMemoryBytes)} 显存` : ""}`]
  ];
}
function osLabel(data, hardware) {
  const name = String(hardware?.windowsName || data?.platform || "").replace(/_NT\b/, "").trim();
  return name || "未知系统";
}
function buildReportModel(data) {
  return {
    data,
    analysis: buildAnalysis(data),
    history: data.history || {},
    network: data.network || {},
    hardware: data.hostInfo || data.hardware || {},
    generatedAt: new Date()
  };
}
function reportToMarkdown(model) {
  const { data, analysis, history, network } = model;
  const hardware = model.hardware;
  const lines = [
    "# 电脑健康诊断报告",
    "",
    `- 生成时间：${formatStamp(model.generatedAt)}`,
    `- 设备：${`${hardware.manufacturer || "未知厂商"} ${hardware.model || ""}`.trim()}（${data.host} · ${data.platform}）`,
    `- 操作系统：${osLabel(data, hardware)}`,
    `- 处理器：${hardware.processor || "未知"}（${data.logicalCores || "-"} 个逻辑处理器）`,
    `- 已连续运行：${formatUptime(data.uptime || 0)}`,
    `- 健康评分：${analysis.score} / 100（${analysis.scoreLabel}）`,
    "",
    analysis.summary,
    "",
    "## 一、关键指标",
    "",
    "| 项目 | 当前值 | 说明 |",
    "| --- | --- | --- |"
  ];
  for (const [name, value, detail] of metricRows(data)) {
    lines.push(`| ${name} | ${value} | ${detail} |`);
  }
  lines.push("", "## 二、异常峰值回溯", "");
  for (const [key, label] of [["session", "本次开机以来"], ["day", "最近 24 小时"]]) {
    const window = history.peaks?.[key];
    lines.push(`### ${label}`, "", "| 指标 | 峰值 | 发生时间 | 当时占用最高的程序 |", "| --- | --- | --- | --- |");
    for (const [metric, name] of [["cpu", "CPU"], ["memory", "内存"], ["temperature", "温度"]]) {
      const peak = window?.[metric];
      const process = peak?.process ? `${processDisplayName(peak.process)}${peak.processDetail ? `（${peak.processDetail}）` : ""}` : "—";
      lines.push(`| ${name} | ${peak ? `${peak.value}${peak.unit}` : "未记录"} | ${peak ? formatStamp(peak.at) : "—"} | ${process} |`);
    }
    lines.push("");
  }
  const events = history.events || [];
  lines.push(`### 异常峰值事件（最近 ${events.length} 条）`, "");
  if (events.length) {
    lines.push("| 峰值时间 | 指标 | 峰值 | 持续 | 当时占用最高的程序 |", "| --- | --- | --- | --- | --- |");
    for (const event of events) {
      lines.push(`| ${formatStamp(event.peakAt)} | ${event.metricLabel} | ${event.peak}${event.unit} | ${formatEventDuration(event.durationSeconds)} | ${event.process ? processDisplayName(event.process) : "—"} |`);
    }
  } else {
    lines.push("没有记录到超过阈值的异常峰值。");
  }
  const groups = (network.groups || []).slice(0, 5);
  lines.push("", "## 三、网络与带宽", "");
  lines.push(`- 当前速率：下载 ${formatRate(network.downloadBytesPerSecond)} · 上传 ${formatRate(network.uploadBytesPerSecond)}（来源：${networkSourceLabel(network.source)}）`);
  const adapters = (network.adapters || []).filter((adapter) => !adapter.virtual);
  if (adapters.length) {
    lines.push(`- 物理网卡：${adapters.map((adapter) => `${adapter.displayName || adapter.name}（↓ ${formatRate(adapter.downloadBytesPerSecond)} / ↑ ${formatRate(adapter.uploadBytesPerSecond)}）`).join("；")}`);
  }
  if (groups.length) {
    lines.push("", "| 程序 | 网络速率 | 连接数 | 主要远端 |", "| --- | --- | --- | --- |");
    for (const group of groups) {
      lines.push(`| ${processDisplayName(group.name)} | ${formatRate(group.bytesPerSecond)} | ${group.connections || 0} | ${(group.peers || []).join("、") || "—"} |`);
    }
  }
  lines.push("", "## 四、分析发现", "");
  for (const finding of analysis.findings) {
    lines.push(`- 【${levelLabel(finding.level)}】${finding.title}：${finding.detail}`);
  }
  lines.push("", "## 五、处理建议", "");
  if (analysis.suggestions.length) {
    analysis.suggestions.forEach(([title, detail], index) => lines.push(`${index + 1}. **${title}**：${detail}`));
  } else {
    lines.push("1. 继续保持当前使用习惯，并定期查看本报告。");
  }
  lines.push("", "## 六、数据依据", "", `- ${analysis.evidence}`);
  lines.push(`- 历史记录：${history.sampleCount || 0} 个采样点，保留 ${history.retentionHours || 24} 小时，每 ${Math.round((Number(history.sampleIntervalMs) || 5000) / 1000)} 秒采样一次`);
  lines.push("- 所有数据只在本机读取，不会上传到网络。");
  return `${lines.join("\n")}\n`;
}
function svgSnapshot(selector) {
  const element = $(selector);
  return element?.outerHTML || "";
}
function reportToHtml(model) {
  const { data, analysis, history, network } = model;
  const hardware = model.hardware;
  const escape = (value) => escapeHtml(String(value ?? ""));
  const rows = metricRows(data)
    .map(([name, value, detail]) => `<tr><th>${escape(name)}</th><td class="value">${escape(value)}</td><td>${escape(detail)}</td></tr>`)
    .join("");
  const peakWindow = (key, label) => {
    const window = history.peaks?.[key];
    const cells = [["cpu", "CPU"], ["memory", "内存"], ["temperature", "温度"]].map(([metric, name]) => {
      const peak = window?.[metric];
      const process = peak?.process ? `${processDisplayName(peak.process)}${peak.processDetail ? `（${peak.processDetail}）` : ""}` : "—";
      return `<tr><th>${name}</th><td class="value">${peak ? `${escape(peak.value)}${escape(peak.unit)}` : "未记录"}</td><td>${peak ? escape(formatStamp(peak.at)) : "—"}</td><td>${escape(process)}</td></tr>`;
    }).join("");
    return `<h3>${escape(label)}</h3><table class="grid"><thead><tr><th>指标</th><th>峰值</th><th>发生时间</th><th>当时占用最高的程序</th></tr></thead><tbody>${cells}</tbody></table>`;
  };
  const events = (history.events || []).map((event) => `<tr class="${event.level === "danger" ? "danger" : "warn"}">
      <td>${escape(formatStamp(event.peakAt))}</td><td>${escape(event.metricLabel)}</td><td class="value">${escape(event.peak)}${escape(event.unit)}</td>
      <td>${escape(formatEventDuration(event.durationSeconds))}</td><td>${escape(event.process ? processDisplayName(event.process) : "—")}</td></tr>`).join("");
  const findings = analysis.findings.map((finding) => `<li class="${finding.level}"><strong>${escape(finding.title)}</strong><span>${escape(finding.detail)}</span><em>${escape(levelLabel(finding.level))}</em></li>`).join("");
  const suggestions = (analysis.suggestions.length
    ? analysis.suggestions.map(([title, detail]) => `<li class="suggestion"><strong>${escape(title)}</strong><span>${escape(detail)}</span></li>`)
    : ['<li class="suggestion"><strong>保持当前状态</strong><span>继续保持通风、及时更新系统，并定期查看本报告。</span></li>']).join("");
  const networkGroups = (network.groups || []).slice(0, 5).map((group) => `<tr><td>${escape(processDisplayName(group.name))}</td><td class="value">${escape(formatRate(group.bytesPerSecond))}</td><td>${escape(group.connections || 0)}</td><td>${escape((group.peers || []).join("、") || "—")}</td></tr>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>电脑健康诊断报告 · ${escape(formatStamp(model.generatedAt))}</title>
<style>
:root { --ink:#1f2a23; --muted:#7d8b82; --line:#e5ebe6; --blue:#5b8def; --coral:#e86f51; --lime:#9bbb5d; --yellow:#e0a44b; --paper:#f4f7f4; }
* { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 28px 22px 48px; }
main { background: #fff; border: 1px solid var(--line); border-radius: 10px; margin: 0 auto; max-width: 980px; padding: 30px 32px 36px; }
.eyebrow { color: #87938a; font-size: 11px; font-weight: 800; letter-spacing: .14em; margin: 0 0 6px; }
h1 { font-size: 27px; margin: 0 0 8px; }
h2 { border-bottom: 1px solid var(--line); font-size: 18px; margin: 30px 0 14px; padding-bottom: 8px; }
h3 { color: var(--muted); font-size: 13px; margin: 18px 0 8px; }
.meta { color: var(--muted); font-size: 12px; line-height: 1.8; margin: 0; }
.score { align-items: center; background: #eaf4e6; border-radius: 8px; display: flex; gap: 16px; margin: 18px 0 6px; padding: 14px 18px; }
.score strong { font-size: 32px; line-height: 1; }
.score span { color: #4c8a4f; font-size: 12px; font-weight: 700; }
.score p { color: #52615a; font-size: 13px; line-height: 1.6; margin: 0; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: 11px; font-weight: 800; }
td.value { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
table.grid tbody th, table.grid tbody td:first-child { width: 150px; }
ul { list-style: none; margin: 0; padding: 0; }
li { background: #fafcf9; border-left: 3px solid var(--lime); border-radius: 6px; display: grid; gap: 4px; margin-bottom: 8px; padding: 10px 12px; position: relative; }
li.warn { background: #fffaf0; border-left-color: var(--yellow); }
li.danger { background: #fff7f4; border-left-color: var(--coral); }
li.info { background: #f6f8fc; border-left-color: var(--blue); }
li.suggestion { border-left-color: #8ba894; }
li strong { font-size: 13px; }
li span { color: #66736a; font-size: 12px; line-height: 1.55; }
li em { color: var(--muted); font-size: 10px; font-style: normal; position: absolute; right: 10px; top: 10px; }
.charts { display: grid; gap: 14px; }
.chart { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 6px; }
.chart h3 { margin: 0 0 6px; }
svg { display: block; height: auto; overflow: visible; width: 100%; }
.trend-line, .sparkline-line { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.5; }
.cpu-line, .cpu-point, .accent-coral .sparkline-line, .accent-coral .sparkline-point { stroke: var(--coral); fill: var(--coral); }
.memory-line, .memory-point, .accent-lime .sparkline-line, .accent-lime .sparkline-point { stroke: var(--blue); fill: var(--blue); }
.network-line { fill: none; stroke-width: 2.5; }
.network-down-line { stroke: var(--blue); } .network-up-line { stroke: #dea03f; }
.network-down-area { fill: var(--blue); fill-opacity: .1; stroke: none; } .network-up-area { fill: #e0a44b; fill-opacity: .12; stroke: none; }
.network-point, .trend-point { stroke: #fff; stroke-width: 2; }
.network-down-point { fill: var(--blue); } .network-up-point { fill: #dea03f; }
.history-cpu-line { fill: none; stroke: var(--coral); stroke-width: 2.5; } .history-memory-line { fill: none; stroke: var(--blue); stroke-width: 2.5; }
.history-cpu-point { fill: var(--coral); stroke: #fff; stroke-width: 2; } .history-memory-point { fill: var(--blue); stroke: #fff; stroke-width: 2; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; line-height: 1.7; margin-top: 26px; padding-top: 12px; }
</style>
</head>
<body>
<main>
  <p class="eyebrow">PC HEALTH REPORT</p>
  <h1>电脑健康诊断报告</h1>
  <p class="meta">
    生成时间：${escape(formatStamp(model.generatedAt))}<br>
    设备：${escape(`${hardware.manufacturer || "未知厂商"} ${hardware.model || ""}`.trim())}（${escape(data.host)} · ${escape(data.platform)}）<br>
    操作系统：${escape(osLabel(data, hardware))} · 处理器：${escape(hardware.processor || "未知")} · 已运行 ${escape(formatUptime(data.uptime || 0))}
  </p>
  <div class="score">
    <strong>${escape(analysis.score)}</strong>
    <div><span>${escape(analysis.scoreLabel)}</span><p>${escape(analysis.summary)}</p></div>
  </div>

  <h2>一、关键指标</h2>
  <table><tbody>${rows}</tbody></table>

  <h2>二、异常峰值回溯</h2>
  ${peakWindow("session", "本次开机以来")}
  ${peakWindow("day", "最近 24 小时")}
  <h3>异常峰值事件（最近 ${(history.events || []).length} 条）</h3>
  ${events
    ? `<table class="grid"><thead><tr><th>峰值时间</th><th>指标</th><th>峰值</th><th>持续</th><th>当时占用最高的程序</th></tr></thead><tbody>${events}</tbody></table>`
    : "<p>没有记录到超过阈值的异常峰值。</p>"}

  <h2>三、实时趋势快照</h2>
  <div class="charts">
    <div class="chart"><h3>处理器与内存（最近约 2 分钟）</h3>${svgSnapshot("#chart")}</div>
    <div class="chart"><h3>网络上下行（最近约 40 次采样）</h3>${svgSnapshot("#networkChart")}</div>
    <div class="chart"><h3>历史峰值曲线（最近一小时）</h3>${svgSnapshot("#historyChart")}</div>
  </div>

  <h2>四、网络与带宽</h2>
  <table><tbody>
    <tr><th>当前速率</th><td class="value">↓ ${escape(formatRate(network.downloadBytesPerSecond))} · ↑ ${escape(formatRate(network.uploadBytesPerSecond))}</td><td>来源 ${escape(networkSourceLabel(network.source))}</td></tr>
  </tbody></table>
  ${networkGroups
    ? `<h3>程序网络占用前 ${(network.groups || []).slice(0, 5).length} 名</h3><table class="grid"><thead><tr><th>程序</th><th>网络速率</th><th>连接数</th><th>主要远端</th></tr></thead><tbody>${networkGroups}</tbody></table>`
    : ""}

  <h2>五、分析发现</h2>
  <ul>${findings}</ul>

  <h2>六、处理建议</h2>
  <ul>${suggestions}</ul>

  <footer>
    数据依据：${escape(analysis.evidence)}<br>
    历史记录：${escape(history.sampleCount || 0)} 个采样点 · 保留 ${escape(history.retentionHours || 24)} 小时 · 每 ${escape(Math.round((Number(history.sampleIntervalMs) || 5000) / 1000))} 秒采样一次<br>
    所有数据只在本机读取，不会上传到网络。本报告由电脑使用观察器生成。
  </footer>
</main>
</body>
</html>
`;
}
function exportStatus(message) {
  const status = $("#status");
  if (status) status.textContent = message;
}
function exportMarkdownReport() {
  if (!state.snapshot) {
    exportStatus("暂无可导出的数据");
    return;
  }
  const model = buildReportModel(state.snapshot);
  downloadTextFile(reportFileName("电脑健康报告", "md"), reportToMarkdown(model), "text/markdown;charset=utf-8");
  exportStatus(`已导出 Markdown 诊断报告（${formatStamp(model.generatedAt)}）`);
}
function exportHtmlReport() {
  if (!state.snapshot) {
    exportStatus("暂无可导出的数据");
    return;
  }
  const model = buildReportModel(state.snapshot);
  downloadTextFile(reportFileName("电脑健康报告", "html"), reportToHtml(model), "text/html;charset=utf-8");
  exportStatus(`已导出 HTML 网页快照（${formatStamp(model.generatedAt)}）`);
}
function exportJsonSnapshot() {
  if (!state.snapshot) {
    exportStatus("暂无可导出的数据");
    return;
  }
  downloadTextFile(reportFileName("pc-observer", "json"), JSON.stringify(state.snapshot, null, 2), "application/json");
  exportStatus("已导出原始 JSON 快照");
}
async function copyMarkdownReport(button) {
  if (!state.snapshot) {
    exportStatus("暂无可导出的数据");
    return;
  }
  const text = reportToMarkdown(buildReportModel(state.snapshot));
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }
  if (!copied) {
    downloadTextFile(reportFileName("电脑健康报告", "md"), text, "text/markdown;charset=utf-8");
    exportStatus("剪贴板不可用，已改为下载 Markdown 报告");
    return;
  }
  if (button) {
    const original = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = original; }, 1600);
  }
  exportStatus("诊断报告已复制为 Markdown");
}
function render(data) {
  state.snapshot = data;
  if (data.ecoMode) state.ecoMode = data.ecoMode;
  updateEcoModeButton();
  const memory = data.memory.used / data.memory.total * 100;
  $("#host").textContent = `${data.host} · ${data.platform}`;
  $("#updated").textContent = `更新于 ${new Date(data.timestamp).toLocaleTimeString()}`;
  $("#cpuValue").textContent = Math.round(data.cpu);
  $("#cpuMeta").textContent = `${data.logicalCores} 个逻辑处理器`;
  $("#memoryValue").textContent = Math.round(memory);
  $("#memoryMeta").textContent = `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`;
  $("#uptimeValue").textContent = formatUptime(data.uptime);
  const disk = data.disks[0];
  const systemDisk = data.disks.find((item) => item.name.toUpperCase() === "C:") || disk;
  $("#diskValue").textContent = systemDisk ? formatBytes(systemDisk.free) : "--";
  $("#diskMeta").textContent = systemDisk ? `${systemDisk.name} 可用空间` : "等待读取磁盘";
  state.history.push({ cpu: data.cpu, memory }); if (state.history.length > 40) state.history.shift();
  renderHealth(data);
  renderHardwareCheck(data);
  renderHardwareOverview(data);
  renderAnalysisReport(data);
  renderTemperatureDetails(data);
  renderNetwork(data);
  renderHistory(data);
  if (data.disks?.length) {
    renderDisks(data.disks);
  } else {
    $("#disks").innerHTML = '<p class="empty">正在读取磁盘...</p>';
  }
  if (data.processes?.length) {
    renderProcesses(data.processes, data.network?.groups);
  }
  drawChart();
  drawSparklines();
  $("#status").textContent = "已连接";
}
async function refresh() {
  if (state.paused) return;
  try {
    const response = await fetch(`/api/stats?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    const data = await response.json();
    render(data);
  } catch (error) {
    $("#status").textContent = `数据读取失败：${error.message}`;
    $("#updated").textContent = "请确认本机观察器服务正在运行";
  }
}
function selectDashboardTab(tabId) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.id === tabId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}
function bindDashboardTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => selectDashboardTab(button.dataset.tab));
  });
}
function bindHealthCards() {
  document.querySelectorAll("[data-health-card]").forEach((card) => {
    const toggle = () => {
      const expanded = card.classList.toggle("is-expanded");
      card.setAttribute("aria-expanded", String(expanded));
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  });
}
async function terminateProcessFromButton(button) {
  const pids = String(button.dataset.pids || "").split(",").map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  const label = button.dataset.processLabel || "选中的进程";
  if (!pids.length) return;
  const warning = pids.length > 1
    ? `确定要结束 ${label} 吗？这会同时结束 ${pids.length} 个子进程，未保存的数据可能丢失。`
    : `确定要结束 ${label} 吗？未保存的数据可能丢失。`;
  if (!window.confirm(warning)) return;
  button.disabled = true;
  button.textContent = "结束中";
  try {
    const response = await fetch("/api/process/terminate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pids })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || `接口返回 ${response.status}`);
    $("#status").textContent = result.message || "进程已结束";
    await refresh();
  } catch (error) {
    button.disabled = false;
    button.textContent = "结束进程";
    $("#status").textContent = `结束失败：${error.message}`;
  }
}
function bindProcessControls() {
  $("#processes")?.addEventListener("click", (event) => {
    const killButton = event.target.closest("[data-process-kill]");
    if (killButton) {
      event.stopPropagation();
      terminateProcessFromButton(killButton);
      return;
    }
    const toggle = event.target.closest("[data-process-group-toggle]");
    if (toggle) {
      const key = toggle.dataset.processGroupToggle;
      if (state.expandedProcessGroups.has(key)) state.expandedProcessGroups.delete(key);
      else state.expandedProcessGroups.add(key);
      renderProcesses(state.snapshot?.processes || [], state.snapshot?.network?.groups);
    }
  });
  $("#networkProcesses")?.addEventListener("click", (event) => {
    const killButton = event.target.closest("[data-process-kill]");
    if (!killButton) return;
    event.stopPropagation();
    terminateProcessFromButton(killButton);
  });
}
function ecoCandidateProcesses() {
  const processes = state.snapshot?.processes || [];
  return groupProcesses(processes)
    .map((group) => ({ ...group, score: Number(group.cpuPercent) || 0 }))
    .filter((group) => group.score >= 5 && group.items.every((item) => !/^(system|registry|smss|csrss|wininit|services|lsass|svchost|dwm|winlogon|explorer|pc-observer)$/i.test(item.name)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}
function renderEcoCandidates() {
  const container = $("#ecoProcessCandidates");
  if (!container) return;
  const candidates = ecoCandidateProcesses();
  container.innerHTML = candidates.length ? candidates.map((group) => `
    <label class="eco-candidate"><input type="checkbox" value="${escapeHtml(group.key)}" checked>
      <span><strong>${escapeHtml(group.label)}${group.items.length > 1 ? ` (${group.items.length} 个进程)` : ""}</strong><small>CPU ${formatProcessCpu(group.cpuPercent)} · 内存 ${formatBytes(group.memory)}</small></span>
    </label>`).join("") : '<p class="empty">当前没有 CPU 占用较高且适合限制的进程。</p>';
}
function updateEcoModeButton() {
  const button = $("#ecoModeToggle");
  if (!button) return;
  const active = Boolean(state.ecoMode?.active);
  const health = state.snapshot?.systemHealth || {};
  const highest = Math.max(0, ...(health.temperatures || []).map(Number).filter(Number.isFinite));
  const onBattery = (health.battery || []).some((item) => [1, 4].includes(Number(item.status)));
  const recommended = highest >= 85 || onBattery;
  button.textContent = active ? "退出节能模式" : recommended ? "建议节能模式" : "节能模式";
  button.classList.toggle("is-eco-active", active);
  button.classList.toggle("is-eco-recommended", !active && recommended);
  button.setAttribute("aria-pressed", String(active));
}
function openEcoModeDialog() {
  const active = Boolean(state.ecoMode?.active);
  const health = state.snapshot?.systemHealth || {};
  const highest = Math.max(0, ...(health.temperatures || []).map(Number).filter(Number.isFinite));
  const battery = (health.battery || []).find((item) => Number(item.status) === 1 || Number(item.status) === 4);
  $("#ecoDialogTitle").textContent = active ? "退出节能模式？" : "启用节能模式？";
  $("#ecoDialogDescription").textContent = active
    ? "将恢复本次节能操作调整过的进程优先级。"
    : `当前最高温度 ${highest ? `${highest.toFixed(1)}°C` : "未读取"}${battery ? " · 当前为电池供电" : ""}。启用后只会降低勾选程序的 CPU 调度优先级，不会结束进程；个别程序响应速度可能下降。`;
  $("#ecoLimitProcesses").checked = true;
  $("#ecoLimitProcesses").closest(".eco-setting").hidden = active;
  $("#ecoProcessCandidates").hidden = active;
  $("#ecoConfirm").textContent = active ? "退出并恢复" : "启用节能模式";
  renderEcoCandidates();
  $("#ecoModeDialog")?.showModal();
}
async function toggleEcoMode() {
  const enabling = !state.ecoMode?.active;
  const limitProcesses = !$("#ecoLimitProcesses").closest(".eco-setting").hidden && $("#ecoLimitProcesses").checked;
  const selectedGroups = [...document.querySelectorAll("#ecoProcessCandidates input:checked")].map((input) => input.value);
  const pids = (state.snapshot?.processes || []).filter((item) => selectedGroups.includes(processDisplayName(item.name).toLowerCase())).map((item) => item.pid);
  const button = $("#ecoConfirm");
  button.disabled = true;
  try {
    const response = await fetch("/api/eco-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabling, limitProcesses, pids })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || `接口返回 ${response.status}`);
    state.ecoMode = result.ecoMode;
    updateEcoModeButton();
    $("#status").textContent = result.message;
    $("#ecoModeDialog").close();
    await refresh();
  } catch (error) {
    $("#status").textContent = `节能模式操作失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}
function bindControls() {
  bindDashboardTabs();
  bindHealthCards();
  bindProcessControls();
  $("#logout")?.addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    window.location.replace("/login");
  });
  $("#historyToggle")?.addEventListener("click", () => {
    const body = $("#historyCollapseBody");
    const button = $("#historyToggle");
    if (!body || !button) return;
    const expanded = body.hidden;
    body.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    const label = button.querySelector(".collapse-chevron");
    if (label) label.textContent = expanded ? "收起" : "展开";
  });
  $("#ecoModeToggle")?.addEventListener("click", openEcoModeDialog);
  $("#ecoConfirm")?.addEventListener("click", (event) => {
    event.preventDefault();
    toggleEcoMode();
  });
$("#healthRefresh")?.addEventListener("click", async () => {
  const button = $("#healthRefresh");
  button.disabled = true;
  try {
    await fetch("/api/health/refresh", { method: "POST" });
    $("#healthSummary").textContent = "正在检测";
    $("#healthDetail").textContent = "正在重新读取设备状态";
    setHealthWaiting("正在重新检测");
  } catch {
    $("#healthSummary").textContent = "无法连接";
    $("#healthDetail").textContent = "确认本地观察器正在运行";
  } finally {
    setTimeout(() => { button.disabled = false; }, 2500);
  }
});
$("#pause")?.addEventListener("click", () => { state.paused = !state.paused; $("#pause").textContent = state.paused ? "继续" : "暂停"; $("#status").textContent = state.paused ? "已暂停" : "已连接"; });
  $("#export")?.addEventListener("click", () => exportMarkdownReport());
  $("#reportCopyMarkdown")?.addEventListener("click", (event) => copyMarkdownReport(event.currentTarget));
  $("#reportDownloadMarkdown")?.addEventListener("click", () => exportMarkdownReport());
  $("#reportDownloadHtml")?.addEventListener("click", () => exportHtmlReport());
  $("#reportDownloadJson")?.addEventListener("click", () => exportJsonSnapshot());
  for (const button of document.querySelectorAll("[data-history-window]")) {
    button.addEventListener("click", () => {
      state.historyWindow = button.dataset.historyWindow === "day" ? "day" : "session";
      if (state.snapshot) renderHistory(state.snapshot);
    });
  }
  $("#hardwareCheck")?.addEventListener("click", () => {
    const panel = $("#hardwareCheckPanel");
    if (panel) panel.classList.toggle("is-visible");
    if (state.snapshot) renderHardwareCheck(state.snapshot);
  });
  $("#temperatureSensorToggle")?.addEventListener("click", () => {
    state.temperatureShowAll = !state.temperatureShowAll;
    if (state.snapshot) renderTemperatureDetails(state.snapshot);
  });
  $("#analysisReportToggle")?.addEventListener("click", () => {
    const panel = $("#analysisReportPanel");
    const button = $("#analysisReportToggle");
    if (!panel || !button) return;
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    button.textContent = willOpen ? "收起报告" : "分析报告";
    if (willOpen) {
      if (state.snapshot) renderAnalysisReport(state.snapshot);
      try {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {}
    }
  });
}
async function start() {
  bindControls();
  $("#status").textContent = "正在连接本机数据服务...";
  await refresh();
  setInterval(refresh, 3000);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
