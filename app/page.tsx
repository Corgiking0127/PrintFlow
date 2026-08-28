"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { buildSchedule, durationLabel, Project, ScheduledPlate, ScheduleSettings, timeLabel } from "../lib/scheduler";
import type { SavedPrinter } from "../lib/printers/types";
import { X2D_AMS2_ADAPTER_ID } from "../lib/printers/types";

const defaultSettings: ScheduleSettings = {
  weekdayMorning: "08:00-08:30",
  weekdayNoon: "12:00-13:30",
  weekdayEvening: "18:00-23:30",
  weekend: "08:00-23:30",
  reminderMinutes: 10,
  overdueMinutes: 20,
  autoReschedule: true,
  failureBuffer: 8,
  barkKey: "",
};

type View = "schedule" | "projects" | "printers" | "rules" | "notifications";
type Draft = Omit<Project, "id" | "status">;

const emptyDraft: Draft = { name: "", sourceUrl: "", plates: 1, durationMinutes: 60, plateDurations: [], plateNames: [], splitByPlate: false, urgent: false, deadline: null, material: "PLA", color: "自然色" };

function postState(payload: Record<string, unknown>) {
  return fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

function isPrinterOnline(printer?: SavedPrinter | null) {
  return Boolean(printer?.lastSeen && Date.now() - new Date(printer.lastSeen).getTime() < 90000);
}

function remainingLabel(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return "等待实时数据";
  return minutes < 60 ? `约 ${Math.max(0, Math.round(minutes))} 分钟` : `约 ${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
}

function temperatureLabel(current: number | null | undefined, target?: number | null) {
  if (current === null || current === undefined) return "—";
  return target !== null && target !== undefined ? `${Math.round(current)}° / ${Math.round(target)}°` : `${Math.round(current)}°C`;
}

export default function Home() {
  const [view, setView] = useState<View>("schedule");
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<ScheduleSettings>(defaultSettings);
  const [now, setNow] = useState(() => new Date());
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [importProfile, setImportProfile] = useState<{ id: number | null; printer: string; title: string } | null>(null);
  const [toast, setToast] = useState("");
  const [queueMode, setQueueMode] = useState<"timeline" | "list">("timeline");
  const [activeStarted, setActiveStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [printers, setPrinters] = useState<SavedPrinter[]>([]);
  const reminded = useRef(new Set<string>());

  useEffect(() => {
    fetch("/api/state").then((response) => response.ok ? response.json() : Promise.reject()).then((data) => {
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      if (data.settings) setSettings((current) => ({ ...current, ...data.settings }));
    }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    const loadPrinters = () => fetch("/api/printers")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { if (active) setPrinters(data.printers || []); })
      .catch(() => undefined);
    void loadPrinters();
    const timer = window.setInterval(loadPrinters, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const schedule = useMemo(() => buildSchedule(projects, settings, now), [projects, settings, now]);
  const totalMinutes = schedule.reduce((sum, item) => sum + item.durationMinutes, 0);
  const idleMinutes = schedule.reduce((sum, item) => sum + item.idleMinutes, 0);
  const utilization = Math.max(0, Math.min(99, Math.round(totalMinutes / Math.max(1, totalMinutes + idleMinutes) * 100)));
  const nextTask = schedule[0];
  const primaryPrinter = printers[0];
  const printerOnline = isPrinterOnline(primaryPrinter);
  const telemetry = primaryPrinter?.telemetry;
  const primaryAms = telemetry?.amsUnits?.[0];
  const deviceCards = [
    {
      name: primaryPrinter?.name || "X2D 工作站",
      state: primaryPrinter ? (printerOnline ? telemetry?.stateLabel || "已连接" : "桥接离线") : "待配置",
      task: telemetry?.taskName || (primaryPrinter ? "等待 MQTT 数据" : "前往打印机设置完成接入"),
      progress: telemetry?.progress || 0,
      eta: remainingLabel(telemetry?.remainingMinutes),
      meta: telemetry?.currentLayer !== null && telemetry?.currentLayer !== undefined ? `层 ${telemetry.currentLayer} / ${telemetry.totalLayers || "—"}` : "X2D · 双喷嘴",
      color: "#6f7eff",
      idle: telemetry?.state === "idle" || !printerOnline,
    },
    {
      name: "AMS 2 Pro",
      state: printerOnline ? (primaryAms?.drying ? "干燥中" : "已连接") : "等待桥接",
      task: primaryAms ? `${primaryAms.trays.length} 个槽位 · 湿度等级 ${primaryAms.humidityLevel ?? "—"}` : "耗材、湿度与干燥状态",
      progress: primaryAms?.trays.length ? Math.round(primaryAms.trays.reduce((sum, tray) => sum + (tray.remainingPercent || 0), 0) / primaryAms.trays.length) : 0,
      eta: primaryAms ? `舱温 ${temperatureLabel(primaryAms.temperatureC)}` : "连接后自动读取",
      meta: primaryAms?.humidityPercent !== null && primaryAms?.humidityPercent !== undefined ? `湿度 ${primaryAms.humidityPercent}%` : "AMS 2 Pro 适配器",
      color: "#35bd87",
      idle: !printerOnline,
    },
    {
      name: "MQTT 局域网桥接",
      state: printerOnline ? "同步中" : primaryPrinter ? "未收到数据" : "未配置",
      task: primaryPrinter ? `${primaryPrinter.localIp}:8883 · ${primaryPrinter.serial}` : "本地读取，安全转发",
      progress: printerOnline ? 100 : 0,
      eta: primaryPrinter?.lastSeen ? `最后同步 ${new Date(primaryPrinter.lastSeen).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "等待首次同步",
      meta: "只读 MQTT",
      color: "#f2a65a",
      idle: !printerOnline,
    },
  ];

  useEffect(() => {
    if (!settings.barkKey || !nextTask || reminded.current.has(nextTask.id)) return;
    const until = nextTask.start.getTime() - Date.now();
    if (until <= settings.reminderMinutes * 60000 && until > -settings.overdueMinutes * 60000) {
      reminded.current.add(nextTask.id);
      fetch("/api/bark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: settings.barkKey, title: "PrintFlow · 该换盘了", body: nextTask.planningUnit === "plate" ? `${nextTask.projectName} · 第 ${nextTask.plate}/${nextTask.plateCount} 盘` : `${nextTask.projectName} · 整项目（${nextTask.plateCount} 盘）` }) }).catch(() => undefined);
    }
  }, [nextTask, settings]);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }

  async function fetchMakerWorld(event: FormEvent) {
    event.preventDefault();
    if (!draft.sourceUrl) return flash("请先粘贴 MakerWorld 链接");
    setImporting(true);
    try {
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: draft.sourceUrl }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取失败");
      setDraft((current) => ({ ...current, ...data.project }));
      setImportProfile(data.profile || null);
      setImported(true);
      flash("已读取网页，请核对打印配置");
    } catch (error) {
      flash(error instanceof Error ? error.message : "读取失败，可手动录入");
      setImported(true);
    } finally {
      setImporting(false);
    }
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return flash("请填写项目名称");
    const plateCount = Math.max(1, Number(draft.plates));
    const plateDurations = draft.splitByPlate
      ? Array.from({ length: plateCount }, (_, index) => Math.max(15, Number(draft.plateDurations?.[index]) || Math.ceil(draft.durationMinutes / plateCount)))
      : draft.plateDurations || [];
    const project: Project = {
      ...draft,
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      plates: plateCount,
      durationMinutes: draft.splitByPlate ? plateDurations.reduce((sum, minutes) => sum + minutes, 0) : Math.max(15, Number(draft.durationMinutes)),
      plateDurations,
      plateNames: Array.from({ length: plateCount }, (_, index) => draft.plateNames?.[index] || `打印盘 ${index + 1}`),
      splitByPlate: Boolean(draft.splitByPlate),
      status: "queued",
    };
    setProjects((current) => [project, ...current]);
    setImportOpen(false);
    setImported(false);
    setImportProfile(null);
    setDraft(emptyDraft);
    const response = await postState({ action: "save_project", project }).catch(() => null);
    flash(response?.ok ? "项目已加入队列，排产已自动更新" : "项目已加入当前队列");
  }

  function updateProject(id: string, patch: Partial<Project>) {
    setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch } : project));
    const project = projects.find((item) => item.id === id);
    if (project) postState({ action: "save_project", project: { ...project, ...patch } }).catch(() => undefined);
  }

  function setPlanningUnit(splitByPlate: boolean) {
    const plateCount = Math.max(1, Number(draft.plates));
    const durations = Array.from({ length: plateCount }, (_, index) => draft.plateDurations?.[index] || Math.ceil(draft.durationMinutes / plateCount));
    const names = Array.from({ length: plateCount }, (_, index) => draft.plateNames?.[index] || `打印盘 ${index + 1}`);
    setDraft({ ...draft, splitByPlate, plateDurations: durations, plateNames: names, durationMinutes: splitByPlate ? durations.reduce((sum, minutes) => sum + minutes, 0) : draft.durationMinutes });
  }

  function updatePlateDuration(index: number, minutes: number) {
    const durations = Array.from({ length: draft.plates }, (_, plateIndex) => plateIndex === index ? Math.max(1, minutes) : draft.plateDurations?.[plateIndex] || Math.ceil(draft.durationMinutes / draft.plates));
    setDraft({ ...draft, plateDurations: durations, durationMinutes: durations.reduce((sum, value) => sum + value, 0) });
  }

  function deleteProject(id: string) {
    setProjects((current) => current.filter((project) => project.id !== id));
    postState({ action: "delete_project", id }).catch(() => undefined);
    flash("项目已移出队列");
  }

  async function saveRules() {
    const response = await postState({ action: "save_settings", settings }).catch(() => null);
    flash(response?.ok ? "换盘与通知规则已保存，队列已重排" : "规则已应用到当前队列");
  }

  async function testBark() {
    if (!settings.barkKey) return flash("请先填写 Bark Key");
    const response = await fetch("/api/bark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: settings.barkKey }) }).catch(() => null);
    flash(response?.ok ? "测试通知已发送，请查看手机" : "发送失败，请检查 Bark Key");
  }

  function markStarted() {
    setActiveStarted(true);
    if (nextTask) postState({ action: "log_event", type: "print_started", projectId: nextTask.projectId, detail: nextTask.planningUnit === "plate" ? `${nextTask.projectName} 第 ${nextTask.plate} 盘已开始` : `${nextTask.projectName} 整项目已开始` }).catch(() => undefined);
    flash("已记录开始时间，完成前 10 分钟会提醒换盘");
  }

  function reportDelay() {
    const delayed = new Date(now.getTime() + 30 * 60000);
    setNow(delayed);
    setActiveStarted(false);
    postState({ action: "log_event", type: "start_delayed", projectId: nextTask?.projectId, detail: "延后 30 分钟并重新排产" }).catch(() => undefined);
    flash("已延后 30 分钟，并重新计算最优队列");
  }

  function exportQueue() {
    const rows = [["开始", "完成", "项目", "规划单元", "耗时", "材料"], ...schedule.map((item) => [timeLabel(item.start), timeLabel(item.end), item.projectName, item.planningUnit === "plate" ? `${item.plateName}（${item.plate}/${item.plateCount}）` : `整项目（${item.plateCount}盘）`, durationLabel(item.durationMinutes), item.material])];
    const blob = new Blob(["\ufeff" + rows.map((row) => row.join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "PrintFlow-排产队列.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const nav = [
    { id: "schedule" as View, icon: "⌁", label: "排产中心" },
    { id: "projects" as View, icon: "◫", label: "项目库", count: projects.length },
    { id: "printers" as View, icon: "▣", label: "打印机" },
    { id: "rules" as View, icon: "⌇", label: "换盘规则" },
    { id: "notifications" as View, icon: "◌", label: "通知设置" },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>PrintFlow</span></div>
        <nav aria-label="主导航">
          {nav.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}><span>{item.icon}</span>{item.label}{item.count !== undefined && <b>{item.count}</b>}</button>)}
        </nav>
        <div className="side-footer"><div className="avatar">PF</div><div><strong>我的工作室</strong><span>{printerOnline ? "X2D 实时在线" : printers.length ? "X2D 等待桥接" : "打印机待配置"}</span></div><button aria-label="打开打印机设置" onClick={() => setView("printers")}>···</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</p><h1>{view === "schedule" ? schedule.length ? "打印队列已为你优化" : "开始规划你的打印队列" : nav.find((item) => item.id === view)?.label}</h1></div>
          <div className="top-actions"><button className="icon-button" aria-label="通知" onClick={() => setView("notifications")}>♧{settings.barkKey && <i />}</button><button className="primary-button" onClick={() => setImportOpen(true)}>＋ 导入项目</button></div>
        </header>

        {view === "schedule" && <>
          <section className="notice-card">
            <div className="notice-icon">✦</div>
            <div><strong>{schedule.length ? `智能排产已减少 ${durationLabel(idleMinutes)} 的等待` : "还没有排产任务"}</strong><p>{schedule.length ? "已拆分项目按每盘真实时长穿插排产；整项目仍作为一个连续任务，并为加急与 DDL 保留缓冲。" : "导入真实 MakerWorld 项目后，系统会根据换盘时间、加急和 DDL 自动生成队列。"}</p></div>
            <button onClick={() => setView("rules")}>调整排产逻辑 →</button>
          </section>

          <div className="section-heading"><div><h2>设备状态</h2><p>实时掌握工作室产能</p></div><button className="text-button" onClick={() => setView("printers")}>管理设备</button></div>
          <section className="machine-grid">
            {deviceCards.map((machine) => <article className="machine-card" key={machine.name}>
              <div className="machine-head"><span className="printer-glyph">▱</span><div><strong>{machine.name}</strong><span><i className={machine.idle ? "idle" : ""} />{machine.state}</span></div><button aria-label={`${machine.name}设置`} onClick={() => setView("printers")}>•••</button></div>
              <div className="machine-task"><span>{machine.task}</span><b>{machine.progress}%</b></div><div className="progress"><i style={{ width: `${machine.progress || 3}%`, background: machine.color }} /></div>
              <div className="machine-meta"><span>{machine.eta}</span><span>{machine.meta}</span></div>
            </article>)}
          </section>

          <div className="schedule-layout">
            <section className="queue-panel">
              <div className="panel-head"><div><h2>智能排产队列</h2><p>{primaryPrinter?.name || "未绑定打印机"} · {schedule.length} 个排产单元</p></div><div className="panel-actions"><button className="export-button" onClick={exportQueue}>导出</button><div className="segmented"><button className={queueMode === "timeline" ? "selected" : ""} onClick={() => setQueueMode("timeline")}>时间轴</button><button className={queueMode === "list" ? "selected" : ""} onClick={() => setQueueMode("list")}>列表</button></div></div></div>
              <div className={`queue-list ${queueMode === "list" ? "compact" : ""}`}>
                {schedule.slice(0, queueMode === "timeline" ? 8 : 20).map((item, index) => <article className="queue-item" key={item.id}>
                  <div className="queue-time">{timeLabel(item.start)} — {timeLabel(item.end)}</div>
                  <div className="timeline"><i className={item.tone} />{index < schedule.length - 1 && <span />}</div>
                  <div className="queue-content"><div><strong>{item.projectName}</strong><span className={`unit-tag ${item.planningUnit}`}>{item.planningUnit === "plate" ? "逐盘" : "整项目"}</span><span className={`tag ${item.tone}`}>{item.urgent ? "加急" : item.tone === "night" ? "夜间长任务" : item.deadline ? "DDL 优先" : index === 0 ? "下一项" : "已优化"}</span></div><p>{item.planningUnit === "plate" ? `${item.plateName} · 盘 ${item.plate}/${item.plateCount}` : `整项目 · ${item.plateCount} 盘`} · {durationLabel(item.durationMinutes)} · {item.material}{item.idleMinutes ? ` · 完成后等待 ${durationLabel(item.idleMinutes)} 换盘` : ""}</p></div>
                  {index === 0 ? <span className="next-dot">NEXT</span> : <button className="drag" aria-label="调整顺序">⠿</button>}
                </article>)}
                {!schedule.length && <div className="empty-state"><span>◎</span><strong>队列是空的</strong><p>导入 MakerWorld 项目后，系统会自动安排最佳打印时段。</p><button onClick={() => setImportOpen(true)}>导入第一个项目</button></div>}
              </div>
            </section>

            <aside className="right-rail">
              <section className="day-card">
                <div className="day-card-head"><span>未来队列</span><b>产能概览</b></div><div className="donut" style={{ background: `conic-gradient(#6f7eff 0 ${utilization}%, #ecece8 ${utilization}%)` }}><div><strong>{utilization}%</strong><span>利用率</span></div></div>
                <div className="stats"><div><span>已排产</span><strong>{durationLabel(totalMinutes)}</strong></div><div><span>空闲等待</span><strong>{durationLabel(idleMinutes)}</strong></div><div><span>排产颗粒</span><strong>{schedule.filter((item) => item.planningUnit === "plate").length} 盘 / {schedule.filter((item) => item.planningUnit === "project").length} 项</strong></div></div>
              </section>
              {nextTask && <section className="action-card"><span>下一次操作</span><strong>{nextTask.projectName}</strong><p>{timeLabel(nextTask.start)} · {nextTask.planningUnit === "plate" ? `${nextTask.plateName}（${nextTask.plate}/${nextTask.plateCount}）` : `整项目（${nextTask.plateCount}盘）`}</p><button className="start-button" onClick={markStarted} disabled={activeStarted}>{activeStarted ? "✓ 已开始" : "开始打印"}</button><button className="delay-button" onClick={reportDelay}>未能按时开始 · 重排</button><small>逾期 {settings.overdueMinutes} 分钟后建议自动重排</small></section>}
            </aside>
          </div>
        </>}

        {view === "projects" && <ProjectsView projects={projects} onUpdate={updateProject} onDelete={deleteProject} onImport={() => setImportOpen(true)} />}
        {view === "printers" && <PrintersView printers={printers} onRefresh={(next) => setPrinters(next)} onToast={flash} />}
        {view === "rules" && <RulesView settings={settings} onChange={setSettings} onSave={saveRules} scheduleCount={schedule.length} idleMinutes={idleMinutes} />}
        {view === "notifications" && <NotificationsView settings={settings} onChange={setSettings} onSave={saveRules} onTest={testBark} nextTask={nextTask} printerName={primaryPrinter?.name || "未绑定打印机"} />}
      </section>

      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setImportOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <div className="modal-head"><div><span>MAKERWORLD IMPORT</span><h2 id="import-title">导入打印项目</h2></div><button onClick={() => setImportOpen(false)} aria-label="关闭">×</button></div>
          {!imported ? <form onSubmit={fetchMakerWorld} className="import-step">
            <label>MakerWorld 网页链接<input type="url" placeholder="https://makerworld.com/zh/models/...#profileId-..." value={draft.sourceUrl} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })} /></label>
            <div className="import-hint"><b>系统将自动获取</b><div><span>✓ 项目名称</span><span>✓ 打印盘数</span><span>✓ 每盘打印时间</span><span>✓ 对应打印 Profile</span></div><p>带 #profileId 的链接会读取对应设备配置，排产时间更准确。</p></div>
            <button className="modal-primary" disabled={importing}>{importing ? "正在读取每盘数据…" : "读取网页并继续 →"}</button>
            <button type="button" className="modal-secondary" onClick={() => { setImportProfile(null); setImported(true); }}>暂时手动录入</button>
          </form>
          : <form onSubmit={saveProject} className="import-step form-grid">
            {importProfile && <div className="profile-banner wide"><span>已匹配 Profile</span><strong>{importProfile.printer}</strong><p>{importProfile.title}</p></div>}
            <label className="wide">项目名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>打印盘数<input type="number" min="1" max="99" value={draft.plates} onChange={(event) => { const plates = Math.max(1, Number(event.target.value)); setDraft({ ...draft, plates, plateDurations: Array.from({ length: plates }, (_, index) => draft.plateDurations?.[index] || Math.ceil(draft.durationMinutes / plates)), plateNames: Array.from({ length: plates }, (_, index) => draft.plateNames?.[index] || `打印盘 ${index + 1}`) }); }} /></label>
            <label>总打印时间（分钟）<input type="number" min="15" value={draft.durationMinutes} readOnly={draft.splitByPlate} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label>
            <div className="planning-choice wide"><span>排产颗粒度</span><div><button type="button" className={!draft.splitByPlate ? "selected" : ""} onClick={() => setPlanningUnit(false)}><b>整项目排产</b><small>{draft.plates} 个盘作为连续项目</small></button><button type="button" className={draft.splitByPlate ? "selected" : ""} onClick={() => setPlanningUnit(true)}><b>拆分到每盘</b><small>每盘独立穿插到最佳时段</small></button></div></div>
            {draft.splitByPlate && <div className="plate-editor wide"><div className="plate-editor-head"><strong>逐盘打印时间</strong><span>合计 {durationLabel(draft.durationMinutes)}</span></div>{Array.from({ length: draft.plates }, (_, index) => <label key={index}><span><b>盘 {index + 1}</b>{draft.plateNames?.[index] || `打印盘 ${index + 1}`}</span><div><input type="number" min="1" value={draft.plateDurations?.[index] || Math.ceil(draft.durationMinutes / draft.plates)} onChange={(event) => updatePlateDuration(index, Number(event.target.value))} /><i>分钟</i></div></label>)}</div>}
            <label>材料<select value={draft.material} onChange={(event) => setDraft({ ...draft, material: event.target.value })}><option>PLA</option><option>PETG</option><option>ABS</option><option>ASA</option><option>TPU</option></select></label>
            <label>颜色<input value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label>
            <label className="wide">交付时间（可选）<input type="datetime-local" value={draft.deadline || ""} onChange={(event) => setDraft({ ...draft, deadline: event.target.value || null })} /></label>
            <div className="check-row wide"><input id="urgent-project" aria-label="设为加急" type="checkbox" checked={draft.urgent} onChange={(event) => setDraft({ ...draft, urgent: event.target.checked })} /><span><b>设为加急</b><small>加急项目会抢占普通队列，但仍尽量避免无人换盘时段。</small></span></div>
            <div className={`verification wide ${draft.plateDurations?.length === draft.plates ? "verified" : ""}`}>{draft.splitByPlate ? `已启用逐盘规划：队列会生成 ${draft.plates} 个独立任务，并使用每盘实际时长。` : `当前按整项目规划：${draft.plates} 个盘合并为一个 ${durationLabel(draft.durationMinutes)} 的连续任务。`}</div>
            <button className="modal-primary wide">加入队列并自动排产</button>
          </form>}
        </section>
      </div>}
      {toast && <div className="toast">✓ {toast}</div>}
      {loading && <div className="sync-pill">正在同步工作室数据…</div>}
    </main>
  );
}

function ProjectsView({ projects, onUpdate, onDelete, onImport }: { projects: Project[]; onUpdate: (id: string, patch: Partial<Project>) => void; onDelete: (id: string) => void; onImport: () => void }) {
  return <section className="content-card">
    <div className="content-head"><div><h2>打印项目库</h2><p>可随时切换整项目或逐盘规划，队列会立即重新计算。</p></div><button className="primary-button" onClick={onImport}>＋ 导入项目</button></div>
    <div className="project-table"><div className="table-row table-title"><span>项目</span><span>配置</span><span>材料</span><span>交付 / 优先级</span><span>操作</span></div>{projects.map((project) => <div className="table-row" key={project.id}>
      <div className="project-name"><span className="cube">◆</span><div><strong>{project.name}</strong><a href={project.sourceUrl} target="_blank" rel="noreferrer">查看来源 ↗</a></div></div>
      <div className="project-config"><span>{project.plates} 盘 · {durationLabel(project.durationMinutes)}</span><button className={project.splitByPlate ? "split" : ""} onClick={() => onUpdate(project.id, { splitByPlate: !project.splitByPlate })}>{project.splitByPlate ? "逐盘规划" : "整项目"}</button></div>
      <span>{project.material} · {project.color}</span>
      <div className="priority-cell"><label><input type="checkbox" checked={project.urgent} onChange={(event) => onUpdate(project.id, { urgent: event.target.checked })} /> 加急</label><input type="datetime-local" value={project.deadline || ""} onChange={(event) => onUpdate(project.id, { deadline: event.target.value || null })} /></div>
      <button className="delete-button" onClick={() => onDelete(project.id)}>移除</button>
    </div>)}</div>
  </section>;
}

function PrintersView({ printers, onRefresh, onToast }: { printers: SavedPrinter[]; onRefresh: (printers: SavedPrinter[]) => void; onToast: (message: string) => void }) {
  const printer = printers[0];
  const telemetry = printer?.telemetry;
  const online = isPrinterOnline(printer);
  const loadedId = useRef("");
  const [name, setName] = useState("X2D 工作站");
  const [serial, setSerial] = useState("");
  const [localIp, setLocalIp] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!printer || printer.id === loadedId.current) return;
    const timer = window.setTimeout(() => {
      loadedId.current = printer.id;
      setName(printer.name);
      setSerial(printer.serial);
      setLocalIp(printer.localIp);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [printer]);

  async function savePrinter(event: FormEvent) {
    event.preventDefault();
    if (!serial.trim() || !localIp.trim()) return onToast("请填写序列号和局域网地址");
    if (!accessCode.trim()) return onToast("请输入打印机 LAN Access Code；它只在本浏览器中使用");
    setSaving(true);
    try {
      const response = await fetch("/api/printers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", id: printer?.id, name, serial, localIp, adapter: X2D_AMS2_ADAPTER_ID, rotateToken: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setBridgeToken(data.bridgeToken || "");
      loadedId.current = data.printer.id;
      onRefresh([data.printer, ...printers.filter((item) => item.id !== data.printer.id)]);
      onToast("打印机已保存，桥接配置已生成");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function downloadBridgeConfig() {
    if (!bridgeToken || !accessCode.trim()) return onToast("请先保存打印机并生成一次性桥接凭证");
    const clean = (value: string) => value.replace(/[\r\n"]/g, "");
    const contents = [
      `PRINTER_NAME="${clean(name)}"`,
      `PRINTER_MODEL="Bambu Lab X2D + AMS 2 Pro"`,
      `PRINTER_HOST="${clean(localIp)}"`,
      `PRINTER_MQTT_PORT="8883"`,
      `PRINTER_SERIAL="${clean(serial.toUpperCase())}"`,
      `PRINTER_ACCESS_CODE="${clean(accessCode)}"`,
      `PRINTER_ADAPTER="${X2D_AMS2_ADAPTER_ID}"`,
      `PRINTFLOW_SITE_URL="${window.location.origin}"`,
      `PRINTFLOW_PRINTER_ID="${printer?.id || loadedId.current}"`,
      `PRINTFLOW_BRIDGE_TOKEN="${bridgeToken}"`,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "printflow-x2d.env";
    link.click();
    URL.revokeObjectURL(url);
    onToast("桥接配置已下载，请妥善保存");
  }

  const nozzleSummary = telemetry?.nozzles || [];
  const amsUnits = telemetry?.amsUnits || [];

  return <>
    <section className={`notice-card printer-connection-notice ${online ? "online" : "neutral"}`}>
      <div className="notice-icon">{online ? "↯" : "▣"}</div>
      <div><strong>{online ? "X2D MQTT 状态正在实时同步" : printer ? "设备已配置，等待局域网桥接器上线" : "配置 X2D + AMS 2 Pro 的 MQTT 读取"}</strong><p>云端页面不直接访问家庭局域网；本地桥接器只读订阅打印机状态，再通过加密连接同步到 PrintFlow。</p></div>
      <span className={`live-badge ${online ? "connected" : ""}`}>{online ? "实时在线" : "离线"}</span>
    </section>

    <div className="printer-settings-layout">
      <section className="content-card printer-live-panel">
        <div className="content-head"><div><h2>{printer?.name || "X2D 实时状态"}</h2><p>{printer ? `${printer.model} · ${printer.serial}` : "完成右侧设置后，这里会显示打印机和 AMS 状态。"}</p></div><span className={`connection ${online ? "connected" : ""}`}>{online ? telemetry?.stateLabel || "已连接" : "未连接"}</span></div>

        {telemetry ? <>
          <div className="printer-progress-hero">
            <div><span>当前任务</span><strong>{telemetry.taskName}</strong><p>{remainingLabel(telemetry.remainingMinutes)}{telemetry.currentLayer !== null ? ` · 层 ${telemetry.currentLayer}/${telemetry.totalLayers || "—"}` : ""}</p></div>
            <div className="radial-progress" style={{ background: `conic-gradient(#6f7eff ${telemetry.progress}%, #eceee9 0)` }}><i><b>{telemetry.progress}%</b><span>{telemetry.stateLabel}</span></i></div>
          </div>

          <div className="telemetry-grid">
            {nozzleSummary.map((nozzle) => <div key={nozzle.id}><span>{nozzle.label}</span><strong>{temperatureLabel(nozzle.currentC, nozzle.targetC)}</strong><small>当前 / 目标</small></div>)}
            <div><span>热床</span><strong>{temperatureLabel(telemetry.bedCurrentC, telemetry.bedTargetC)}</strong><small>当前 / 目标</small></div>
            <div><span>腔温</span><strong>{temperatureLabel(telemetry.chamberCurrentC)}</strong><small>实时温度</small></div>
            <div><span>Wi-Fi</span><strong>{telemetry.wifiSignal || "—"}</strong><small>打印机信号</small></div>
          </div>

          <div className="ams-section-head"><div><h3>AMS 2 Pro</h3><p>温湿度、干燥状态与槽位余量</p></div><span>{amsUnits.length ? `${amsUnits.length} 台已识别` : "等待数据"}</span></div>
          <div className="ams-units">{amsUnits.map((unit) => <article className="ams-unit" key={unit.id}>
            <div className="ams-unit-head"><div><strong>{unit.label}</strong><span>{unit.drying ? "◌ 干燥中" : "密封存储"}</span></div><div><b>{temperatureLabel(unit.temperatureC)}</b><small>{unit.humidityPercent !== null ? `湿度 ${unit.humidityPercent}%` : `湿度等级 ${unit.humidityLevel ?? "—"}`}</small></div></div>
            <div className="tray-grid">{unit.trays.map((tray) => <div className={`tray-card ${tray.active ? "active" : ""}`} key={tray.id}><i style={{ background: tray.color }} /><span>{tray.name}</span><strong>{tray.material}</strong><small>{tray.remainingPercent === null ? "余量未知" : `剩余 ${tray.remainingPercent}%`}</small>{tray.active && <b>正在使用</b>}</div>)}</div>
          </article>)}</div>
          {telemetry.errors.length > 0 && <div className="printer-errors"><strong>设备告警</strong>{telemetry.errors.map((error) => <span key={error}>{error}</span>)}</div>}
        </> : <div className="printer-empty"><span>↯</span><strong>等待第一条 MQTT 状态</strong><p>保存设置并运行本地桥接器后，打印进度、双喷嘴温度和 AMS 2 Pro 数据会自动出现。</p></div>}
      </section>

      <aside className="content-card printer-config-card">
        <div className="content-head"><div><h2>打印机设置</h2><p>当前仅开放一个适配器，后续型号可独立扩展。</p></div><span className="adapter-version">ADAPTER V1</span></div>
        <form onSubmit={savePrinter} className="printer-form">
          <label><span>设备名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：X2D 工作站" /></label>
          <label><span>打印机型号</span><input value="Bambu Lab X2D + AMS 2 Pro" readOnly /></label>
          <label><span>设备序列号</span><input value={serial} onChange={(event) => setSerial(event.target.value.toUpperCase())} placeholder="打印机设置页中的序列号" autoCapitalize="characters" /></label>
          <label><span>局域网地址</span><input value={localIp} onChange={(event) => setLocalIp(event.target.value)} placeholder="例如：192.168.1.86" inputMode="decimal" /></label>
          <label><span>LAN Access Code</span><input type="password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="仅用于生成本地配置" autoComplete="off" /><small>不会发送到云端，也不会写入 PrintFlow 数据库。</small></label>
          <label><span>数据适配器</span><select value={X2D_AMS2_ADAPTER_ID} disabled><option value={X2D_AMS2_ADAPTER_ID}>X2D + AMS 2 Pro · MQTT</option></select></label>
          <button className="primary-button config-save" disabled={saving}>{saving ? "正在生成安全凭证…" : printer ? "保存并更新桥接凭证" : "保存并生成桥接配置"}</button>
        </form>

        <div className={`bridge-download ${bridgeToken ? "ready" : ""}`}>
          <div><span>局域网桥接器</span><strong>{bridgeToken ? "配置已就绪" : "保存后可下载"}</strong></div>
          <p>凭证只显示这一次。若遗失，可重新保存并生成新凭证。</p>
          <div className="download-actions"><button onClick={downloadBridgeConfig} disabled={!bridgeToken}>下载 .env 配置</button><a href="/printflow-x2d-bridge.mjs" download>下载桥接器</a></div>
        </div>

        <ol className="bridge-steps">
          <li><b>1</b><span><strong>下载两个文件</strong><small>将 .env 与桥接器放在同一文件夹。</small></span></li>
          <li><b>2</b><span><strong>安装 MQTT 组件</strong><small>在该文件夹运行 npm install mqtt。</small></span></li>
          <li><b>3</b><span><strong>保持本地运行</strong><small>运行 node --env-file=printflow-x2d.env printflow-x2d-bridge.mjs。</small></span></li>
        </ol>
      </aside>
    </div>

    <section className="adapter-note"><div><span>适配器架构</span><strong>MQTT 原始数据 → X2D / AMS 2 Pro Adapter → 统一设备状态 → 排产与通知</strong></div><p>新增打印机型号时，只需增加对应适配器，不会改动排产页面和数据结构。</p></section>
  </>;
}

function RulesView({ settings, onChange, onSave, scheduleCount, idleMinutes }: { settings: ScheduleSettings; onChange: (value: ScheduleSettings) => void; onSave: () => void; scheduleCount: number; idleMinutes: number }) {
  const field = (key: keyof ScheduleSettings, value: string | number | boolean) => onChange({ ...settings, [key]: value });
  return <div className="settings-layout"><section className="content-card"><div className="content-head"><div><h2>可换盘时间</h2><p>系统会选择让打印恰好在这些时间附近结束的任务。</p></div></div><div className="rules-grid"><label><span>工作日 · 早晨</span><input value={settings.weekdayMorning} onChange={(event) => field("weekdayMorning", event.target.value)} /><small>默认上班前可换一次</small></label><label><span>工作日 · 中午</span><input value={settings.weekdayNoon} onChange={(event) => field("weekdayNoon", event.target.value)} /><small>默认午休可换一次</small></label><label><span>工作日 · 晚间</span><input value={settings.weekdayEvening} onChange={(event) => field("weekdayEvening", event.target.value)} /><small>长任务会优先占用夜间</small></label><label><span>休息日</span><input value={settings.weekend} onChange={(event) => field("weekend", event.target.value)} /><small>默认白天随时可换盘</small></label></div><div className="rule-divider" /><div className="slider-row"><div><strong>失败与准备缓冲</strong><p>在 DDL 前预留切片、冷却、失败重打时间。</p></div><input type="range" min="0" max="30" value={settings.failureBuffer} onChange={(event) => field("failureBuffer", Number(event.target.value))} /><b>{settings.failureBuffer}%</b></div><div className="switch-row"><span><strong>未按时开始时自动重排</strong><small>超过阈值后，优先安排最能利用当前空档的项目。</small></span><input id="auto-reschedule" aria-label="未按时开始时自动重排" type="checkbox" checked={settings.autoReschedule} onChange={(event) => field("autoReschedule", event.target.checked)} /></div><button className="primary-button save-rules" onClick={onSave}>保存并重新计算队列</button></section><aside className="rule-preview"><span>规则影响预览</span><strong>{scheduleCount}</strong><p>个排产单元已自动编排</p><div><span>预计空闲</span><b>{durationLabel(idleMinutes)}</b></div><div><span>夜间策略</span><b>长任务优先</b></div><div><span>工作日换盘</span><b>3 个窗口</b></div></aside></div>;
}

function NotificationsView({ settings, onChange, onSave, onTest, nextTask, printerName }: { settings: ScheduleSettings; onChange: (value: ScheduleSettings) => void; onSave: () => void; onTest: () => void; nextTask?: ScheduledPlate; printerName: string }) {
  const taskLabel = nextTask ? nextTask.planningUnit === "plate" ? `${nextTask.projectName} · 第 ${nextTask.plate}/${nextTask.plateCount} 盘` : `${nextTask.projectName} · 整项目` : "暂无待执行任务";
  const detailLabel = nextTask ? `${printerName} · 预计打印 ${durationLabel(nextTask.durationMinutes)}` : `${printerName} · 导入项目后显示提醒内容`;
  return <div className="settings-layout"><section className="content-card"><div className="content-head"><div><h2>Bark 通知</h2><p>在 iPhone 上安装 Bark，复制 Key 即可接收换盘提醒。</p></div><span className={`connection ${settings.barkKey ? "connected" : ""}`}>{settings.barkKey ? "已配置" : "未连接"}</span></div><label className="settings-field"><span>Bark Key</span><div className="input-action"><input type="password" placeholder="例如：AbCdEf123456" value={settings.barkKey} onChange={(event) => onChange({ ...settings, barkKey: event.target.value })} /><button onClick={onTest}>发送测试</button></div><small>Key 仅用于向 api.day.app 发送你的打印提醒。</small></label><div className="rule-divider" /><div className="rules-grid"><label><span>提前提醒</span><input type="number" min="1" max="120" value={settings.reminderMinutes} onChange={(event) => onChange({ ...settings, reminderMinutes: Number(event.target.value) })} /><small>分钟</small></label><label><span>逾期阈值</span><input type="number" min="5" max="180" value={settings.overdueMinutes} onChange={(event) => onChange({ ...settings, overdueMinutes: Number(event.target.value) })} /><small>超过后建议重排</small></label></div><div className="notification-samples"><div><span>即将换盘</span><p>下一盘开始前提醒，并显示项目、盘号和设备。</p><i>开启</i></div><div><span>任务逾期</span><p>未确认开始时提醒，页面打开时自动重排。</p><i>开启</i></div><div><span>DDL 风险</span><p>失败缓冲不足或预计延期时立即提醒。</p><i>开启</i></div></div><button className="primary-button save-rules" onClick={onSave}>保存通知设置</button></section><aside className="phone-preview"><div className="phone-notch" /><span>现在</span><div className="bark-preview"><b>PRINTFLOW</b><strong>该换盘了</strong><p>{taskLabel}<br />{detailLabel}</p></div><small>提前 {settings.reminderMinutes} 分钟提醒</small></aside></div>;
}
