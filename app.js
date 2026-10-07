const $ = (selector) => document.querySelector(selector);
const state = { paused: false, history: [], snapshot: null, temperatureShowAll: false };
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
  const height = 76;
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
function renderDisks(disks) {
  $("#disks").innerHTML = disks.length ? disks.map((disk) => {
    const used = disk.total ? (disk.total - disk.free) / disk.total * 100 : 0;
    return `<div class="disk-row"><div class="disk-label"><strong>${disk.name}</strong><span>${formatBytes(disk.free)} 可用</span></div><div class="disk-bar"><i style="width:${used}%"></i></div></div>`;
  }).join("") : '<p class="empty">未读取到本地磁盘</p>';
}
function renderProcesses(processes) {
  $("#processCount").textContent = `${processes.length} 个进程`;
  $("#processes").innerHTML = processes.length ? processes.map((process) =>
    `<tr><td class="process-name">${process.name}</td><td>${process.pid}</td><td>${process.cpuTime.toFixed(1)} 秒</td><td>${formatBytes(process.memory)}</td></tr>`
  ).join("") : '<tr><td colspan="4" class="empty">未读取到进程</td></tr>';
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

function renderAnalysisReport(data) {
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

  const scoreElement = $("#reportScore");
  if (scoreElement) scoreElement.textContent = `${score}`;
  if (scoreElement?.parentElement) {
    scoreElement.parentElement.className = `report-score ${dangerCount ? "danger" : concernCount ? "warn" : dataGapCount ? "info" : "good"}`;
  }
  if ($("#reportScoreLabel")) $("#reportScoreLabel").textContent = scoreLabel;
  if ($("#reportGenerated")) $("#reportGenerated").textContent = `基于本机实时快照 · ${data.timestamp ? new Date(data.timestamp).toLocaleString() : "等待时间"}`;
  if ($("#reportSummary")) $("#reportSummary").textContent = summary;
  if ($("#reportAttentionCount")) $("#reportAttentionCount").textContent = `${attentionCount} 项`;
  if ($("#reportSuggestionCount")) $("#reportSuggestionCount").textContent = `${suggestions.length} 条`;
  if ($("#reportEvidence")) $("#reportEvidence").textContent = evidence;
  if ($("#reportFindings")) $("#reportFindings").innerHTML = findings.map((item) => reportItem(item.level, item.title, item.detail)).join("");
  if ($("#reportSuggestions")) $("#reportSuggestions").innerHTML = suggestions.length
    ? suggestions.map(([title, detail]) => reportSuggestion(title, detail)).join("")
    : reportSuggestion("保持当前状态", "继续保持通风、及时更新系统，并定期查看本报告。");
}

function render(data) {
  state.snapshot = data;
  const memory = data.memory.used / data.memory.total * 100;
  $("#host").textContent = `${data.host} · ${data.platform}`;
  $("#updated").textContent = `更新于 ${new Date(data.timestamp).toLocaleTimeString()}`;
  $("#cpuValue").textContent = Math.round(data.cpu); $("#cpuBar").style.width = `${data.cpu}%`;
  $("#cpuMeta").textContent = `${data.logicalCores} 个逻辑处理器`;
  $("#memoryValue").textContent = Math.round(memory); $("#memoryBar").style.width = `${memory}%`;
  $("#memoryMeta").textContent = `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`;
  $("#uptimeValue").textContent = formatUptime(data.uptime);
  const disk = data.disks[0];
  const systemDisk = data.disks.find((item) => item.name.toUpperCase() === "C:") || disk;
  $("#diskValue").textContent = systemDisk ? formatBytes(systemDisk.free) : "--";
  $("#diskMeta").textContent = systemDisk ? `${systemDisk.name} 可用空间` : "等待读取磁盘";
  state.history.push({ cpu: data.cpu, memory }); if (state.history.length > 40) state.history.shift();
  renderHealth(data);
  renderHardwareCheck(data);
  renderAnalysisReport(data);
  renderTemperatureDetails(data);
  if (data.disks?.length) {
    renderDisks(data.disks);
  } else {
    $("#disks").innerHTML = '<p class="empty">正在读取磁盘...</p>';
  }
  if (data.processes?.length) {
    renderProcesses(data.processes);
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
function bindControls() {
  bindDashboardTabs();
  bindHealthCards();
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
  $("#export")?.addEventListener("click", () => {
  if (!state.snapshot) return;
  const blob = new Blob([JSON.stringify(state.snapshot, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `pc-observer-${new Date().toISOString().replaceAll(":", "-")}.json`; link.click(); URL.revokeObjectURL(link.href);
  });
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
    if (willOpen && state.snapshot) renderAnalysisReport(state.snapshot);
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
