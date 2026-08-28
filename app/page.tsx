"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { buildSchedule, durationLabel, Project, ScheduleSettings, timeLabel } from "../lib/scheduler";

const seedProjects: Project[] = [
  { id: "demo-helmet", name: "星际骑士头盔", sourceUrl: "https://makerworld.com/", plates: 4, durationMinutes: 1360, urgent: false, deadline: null, material: "PLA", color: "银灰", status: "queued" },
  { id: "demo-dragon", name: "机械龙翼组件", sourceUrl: "https://makerworld.com/", plates: 3, durationMinutes: 1098, urgent: false, deadline: null, material: "PETG", color: "黑色", status: "queued" },
  { id: "demo-softbox", name: "摄影灯柔光罩", sourceUrl: "https://makerworld.com/", plates: 1, durationMinutes: 162, urgent: true, deadline: "2026-08-29T20:00", material: "PLA", color: "白色", status: "queued" },
  { id: "demo-drone", name: "无人机壁挂支架", sourceUrl: "https://makerworld.com/", plates: 2, durationMinutes: 270, urgent: false, deadline: "2026-09-01T18:00", material: "PETG", color: "深灰", status: "queued" },
];

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

const machines = [
  { name: "P1S-01", state: "打印中", task: "星际骑士头盔", progress: 68, eta: "02:18 完成", color: "#6f7eff" },
  { name: "A1 mini", state: "待机", task: "等待队列", progress: 0, eta: "可立即开始", color: "#3ac28f" },
  { name: "X1C-01", state: "打印中", task: "桌面收纳盒", progress: 24, eta: "明日 08:35", color: "#f2a65a" },
];

type View = "schedule" | "projects" | "printers" | "rules" | "notifications";
type Draft = Omit<Project, "id" | "status">;

const emptyDraft: Draft = { name: "", sourceUrl: "", plates: 1, durationMinutes: 60, urgent: false, deadline: null, material: "PLA", color: "自然色" };

function postState(payload: Record<string, unknown>) {
  return fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

export default function Home() {
  const [view, setView] = useState<View>("schedule");
  const [projects, setProjects] = useState<Project[]>(seedProjects);
  const [settings, setSettings] = useState<ScheduleSettings>(defaultSettings);
  const [now, setNow] = useState(new Date(2026, 7, 28, 21, 30));
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [toast, setToast] = useState("");
  const [queueMode, setQueueMode] = useState<"timeline" | "list">("timeline");
  const [activeStarted, setActiveStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const reminded = useRef(new Set<string>());

  useEffect(() => {
    setNow(new Date());
    fetch("/api/state").then((response) => response.ok ? response.json() : Promise.reject()).then((data) => {
      if (data.projects?.length) setProjects(data.projects);
      if (data.settings) setSettings((current) => ({ ...current, ...data.settings }));
    }).catch(() => undefined).finally(() => setLoading(false));
  }, []);

  const schedule = useMemo(() => buildSchedule(projects, settings, now), [projects, settings, now]);
  const totalMinutes = schedule.reduce((sum, item) => sum + item.durationMinutes, 0);
  const idleMinutes = schedule.reduce((sum, item) => sum + item.idleMinutes, 0);
  const utilization = Math.max(0, Math.min(99, Math.round(totalMinutes / Math.max(1, totalMinutes + idleMinutes) * 100)));
  const nextTask = schedule[0];

  useEffect(() => {
    if (!settings.barkKey || !nextTask || reminded.current.has(nextTask.id)) return;
    const until = nextTask.start.getTime() - Date.now();
    if (until <= settings.reminderMinutes * 60000 && until > -settings.overdueMinutes * 60000) {
      reminded.current.add(nextTask.id);
      fetch("/api/bark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: settings.barkKey, title: "PrintFlow · 该换盘了", body: `${nextTask.projectName} · 第 ${nextTask.plate}/${nextTask.plateCount} 盘` }) }).catch(() => undefined);
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
    const project: Project = { ...draft, id: crypto.randomUUID(), name: draft.name.trim(), plates: Math.max(1, Number(draft.plates)), durationMinutes: Math.max(15, Number(draft.durationMinutes)), status: "queued" };
    setProjects((current) => [project, ...current]);
    setImportOpen(false);
    setImported(false);
    setDraft(emptyDraft);
    const response = await postState({ action: "save_project", project }).catch(() => null);
    flash(response?.ok ? "项目已加入队列，排产已自动更新" : "项目已加入当前队列");
  }

  function updateProject(id: string, patch: Partial<Project>) {
    setProjects((current) => current.map((project) => project.id === id ? { ...project, ...patch } : project));
    const project = projects.find((item) => item.id === id);
    if (project) postState({ action: "save_project", project: { ...project, ...patch } }).catch(() => undefined);
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
    if (nextTask) postState({ action: "log_event", type: "print_started", projectId: nextTask.projectId, detail: `${nextTask.projectName} 第 ${nextTask.plate} 盘已开始` }).catch(() => undefined);
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
    const rows = [["开始", "完成", "项目", "盘", "耗时", "材料"], ...schedule.map((item) => [timeLabel(item.start), timeLabel(item.end), item.projectName, `${item.plate}/${item.plateCount}`, durationLabel(item.durationMinutes), item.material])];
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
        <div className="side-footer"><div className="avatar">YF</div><div><strong>我的工作室</strong><span>3 台设备在线</span></div><button aria-label="打开设置">···</button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</p><h1>{view === "schedule" ? "打印队列已为你优化" : nav.find((item) => item.id === view)?.label}</h1></div>
          <div className="top-actions"><button className="icon-button" aria-label="通知" onClick={() => setView("notifications")}>♧{settings.barkKey && <i />}</button><button className="primary-button" onClick={() => setImportOpen(true)}>＋ 导入项目</button></div>
        </header>

        {view === "schedule" && <>
          <section className="notice-card">
            <div className="notice-icon">✦</div>
            <div><strong>智能排产已减少 {durationLabel(idleMinutes)} 的等待</strong><p>长任务优先进入夜间，无人可换盘时自动选择更合适的盘，并为加急与 DDL 保留缓冲。</p></div>
            <button onClick={() => setView("rules")}>调整排产逻辑 →</button>
          </section>

          <div className="section-heading"><div><h2>设备状态</h2><p>实时掌握工作室产能</p></div><button className="text-button" onClick={() => setView("printers")}>管理设备</button></div>
          <section className="machine-grid">
            {machines.map((machine) => <article className="machine-card" key={machine.name}>
              <div className="machine-head"><span className="printer-glyph">▱</span><div><strong>{machine.name}</strong><span><i className={machine.state === "待机" ? "idle" : ""} />{machine.state}</span></div><button aria-label={`${machine.name}菜单`}>•••</button></div>
              <div className="machine-task"><span>{machine.task}</span><b>{machine.progress}%</b></div><div className="progress"><i style={{ width: `${machine.progress || 3}%`, background: machine.color }} /></div>
              <div className="machine-meta"><span>{machine.eta}</span><span>{machine.state === "待机" ? `队列 ${projects.length} 项` : "PLA · 0.20mm"}</span></div>
            </article>)}
          </section>

          <div className="schedule-layout">
            <section className="queue-panel">
              <div className="panel-head"><div><h2>智能排产队列</h2><p>P1S-01 · {schedule.length} 个打印盘</p></div><div className="panel-actions"><button className="export-button" onClick={exportQueue}>导出</button><div className="segmented"><button className={queueMode === "timeline" ? "selected" : ""} onClick={() => setQueueMode("timeline")}>时间轴</button><button className={queueMode === "list" ? "selected" : ""} onClick={() => setQueueMode("list")}>列表</button></div></div></div>
              <div className={`queue-list ${queueMode === "list" ? "compact" : ""}`}>
                {schedule.slice(0, queueMode === "timeline" ? 8 : 20).map((item, index) => <article className="queue-item" key={item.id}>
                  <div className="queue-time">{timeLabel(item.start)} — {timeLabel(item.end)}</div>
                  <div className="timeline"><i className={item.tone} />{index < schedule.length - 1 && <span />}</div>
                  <div className="queue-content"><div><strong>{item.projectName}</strong><span className={`tag ${item.tone}`}>{item.urgent ? "加急" : item.tone === "night" ? "夜间长任务" : item.deadline ? "DDL 优先" : index === 0 ? "下一项" : "已优化"}</span></div><p>盘 {item.plate}/{item.plateCount} · {durationLabel(item.durationMinutes)} · {item.material}{item.idleMinutes ? ` · 完成后等待 ${durationLabel(item.idleMinutes)} 换盘` : ""}</p></div>
                  {index === 0 ? <span className="next-dot">NEXT</span> : <button className="drag" aria-label="调整顺序">⠿</button>}
                </article>)}
                {!schedule.length && <div className="empty-state"><span>◎</span><strong>队列是空的</strong><p>导入 MakerWorld 项目后，系统会自动安排最佳打印时段。</p><button onClick={() => setImportOpen(true)}>导入第一个项目</button></div>}
              </div>
            </section>

            <aside className="right-rail">
              <section className="day-card">
                <div className="day-card-head"><span>未来队列</span><b>产能概览</b></div><div className="donut" style={{ background: `conic-gradient(#6f7eff 0 ${utilization}%, #ecece8 ${utilization}%)` }}><div><strong>{utilization}%</strong><span>利用率</span></div></div>
                <div className="stats"><div><span>已排产</span><strong>{durationLabel(totalMinutes)}</strong></div><div><span>空闲等待</span><strong>{durationLabel(idleMinutes)}</strong></div><div><span>预计换盘</span><strong>{schedule.length} 次</strong></div></div>
              </section>
              {nextTask && <section className="action-card"><span>下一次操作</span><strong>{nextTask.projectName}</strong><p>{timeLabel(nextTask.start)} · 第 {nextTask.plate}/{nextTask.plateCount} 盘</p><button className="start-button" onClick={markStarted} disabled={activeStarted}>{activeStarted ? "✓ 已开始" : "开始打印"}</button><button className="delay-button" onClick={reportDelay}>未能按时开始 · 重排</button><small>逾期 {settings.overdueMinutes} 分钟后建议自动重排</small></section>}
            </aside>
          </div>
        </>}

        {view === "projects" && <ProjectsView projects={projects} onUpdate={updateProject} onDelete={deleteProject} onImport={() => setImportOpen(true)} />}
        {view === "printers" && <PrintersView />}
        {view === "rules" && <RulesView settings={settings} onChange={setSettings} onSave={saveRules} scheduleCount={schedule.length} idleMinutes={idleMinutes} />}
        {view === "notifications" && <NotificationsView settings={settings} onChange={setSettings} onSave={saveRules} onTest={testBark} />}
      </section>

      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setImportOpen(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <div className="modal-head"><div><span>MAKERWORLD IMPORT</span><h2 id="import-title">导入打印项目</h2></div><button onClick={() => setImportOpen(false)} aria-label="关闭">×</button></div>
          {!imported ? <form onSubmit={fetchMakerWorld} className="import-step"><label>MakerWorld 网页链接<input type="url" placeholder="https://makerworld.com/zh/models/..." value={draft.sourceUrl} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })} autoFocus /></label><div className="import-hint"><b>系统将自动获取</b><div><span>✓ 项目名称</span><span>✓ 打印盘数</span><span>✓ 总打印时间</span><span>✓ 原始链接</span></div><p>若网页有多个打印配置，导入后可手动校对。</p></div><button className="modal-primary" disabled={importing}>{importing ? "正在读取 MakerWorld…" : "读取网页并继续 →"}</button><button type="button" className="modal-secondary" onClick={() => setImported(true)}>暂时手动录入</button></form>
          : <form onSubmit={saveProject} className="import-step form-grid"><label className="wide">项目名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>打印盘数<input type="number" min="1" max="99" value={draft.plates} onChange={(event) => setDraft({ ...draft, plates: Number(event.target.value) })} /></label><label>总打印时间（分钟）<input type="number" min="15" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label><label>材料<select value={draft.material} onChange={(event) => setDraft({ ...draft, material: event.target.value })}><option>PLA</option><option>PETG</option><option>ABS</option><option>ASA</option><option>TPU</option></select></label><label>颜色<input value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></label><label className="wide">交付时间（可选）<input type="datetime-local" value={draft.deadline || ""} onChange={(event) => setDraft({ ...draft, deadline: event.target.value || null })} /></label><label className="check-row wide"><input type="checkbox" checked={draft.urgent} onChange={(event) => setDraft({ ...draft, urgent: event.target.checked })} /><span><b>设为加急</b><small>加急项目会抢占普通队列，但仍尽量避免无人换盘时段。</small></span></label><div className="verification wide">请确认盘数与时间对应你要打印的 Profile；系统会按每盘平均时长初排。</div><button className="modal-primary wide">加入队列并自动排产</button></form>}
        </section>
      </div>}
      {toast && <div className="toast">✓ {toast}</div>}
      {loading && <div className="sync-pill">正在同步工作室数据…</div>}
    </main>
  );
}

function ProjectsView({ projects, onUpdate, onDelete, onImport }: { projects: Project[]; onUpdate: (id: string, patch: Partial<Project>) => void; onDelete: (id: string) => void; onImport: () => void }) {
  return <section className="content-card"><div className="content-head"><div><h2>打印项目库</h2><p>修改加急或 DDL 后，队列会立即重新计算。</p></div><button className="primary-button" onClick={onImport}>＋ 导入项目</button></div><div className="project-table"><div className="table-row table-title"><span>项目</span><span>配置</span><span>材料</span><span>交付 / 优先级</span><span>操作</span></div>{projects.map((project) => <div className="table-row" key={project.id}><div className="project-name"><span className="cube">◆</span><div><strong>{project.name}</strong><a href={project.sourceUrl} target="_blank" rel="noreferrer">查看来源 ↗</a></div></div><span>{project.plates} 盘 · {durationLabel(project.durationMinutes)}</span><span>{project.material} · {project.color}</span><div className="priority-cell"><label><input type="checkbox" checked={project.urgent} onChange={(event) => onUpdate(project.id, { urgent: event.target.checked })} /> 加急</label><input type="datetime-local" value={project.deadline || ""} onChange={(event) => onUpdate(project.id, { deadline: event.target.value || null })} /></div><button className="delete-button" onClick={() => onDelete(project.id)}>移除</button></div>)}</div></section>;
}

function PrintersView() {
  return <><section className="notice-card neutral"><div className="notice-icon">▣</div><div><strong>可接入 Bambu Lab 设备状态</strong><p>当前版本先按设备可用时间排产；接入 MQTT 或局域网接口后，可自动同步完成、暂停、失败和耗材状态。</p></div><button>查看接入说明 →</button></section><section className="printer-manage-grid">{machines.map((machine, index) => <article className="printer-manage-card" key={machine.name}><div className="printer-visual"><span>▱</span><i className={machine.state === "待机" ? "idle" : ""} /></div><h2>{machine.name}</h2><p>{index === 0 ? "Bambu Lab P1S · 0.4mm 喷嘴" : index === 1 ? "Bambu Lab A1 mini · 0.4mm 喷嘴" : "Bambu Lab X1 Carbon · 0.4mm 喷嘴"}</p><div><span>状态</span><strong>{machine.state}</strong></div><div><span>维护提醒</span><strong>{index === 1 ? "喷嘴清洁" : "状态良好"}</strong></div><button>编辑设备</button></article>)}</section></>;
}

function RulesView({ settings, onChange, onSave, scheduleCount, idleMinutes }: { settings: ScheduleSettings; onChange: (value: ScheduleSettings) => void; onSave: () => void; scheduleCount: number; idleMinutes: number }) {
  const field = (key: keyof ScheduleSettings, value: string | number | boolean) => onChange({ ...settings, [key]: value });
  return <div className="settings-layout"><section className="content-card"><div className="content-head"><div><h2>可换盘时间</h2><p>系统会选择让打印恰好在这些时间附近结束的任务。</p></div></div><div className="rules-grid"><label><span>工作日 · 早晨</span><input value={settings.weekdayMorning} onChange={(event) => field("weekdayMorning", event.target.value)} /><small>默认上班前可换一次</small></label><label><span>工作日 · 中午</span><input value={settings.weekdayNoon} onChange={(event) => field("weekdayNoon", event.target.value)} /><small>默认午休可换一次</small></label><label><span>工作日 · 晚间</span><input value={settings.weekdayEvening} onChange={(event) => field("weekdayEvening", event.target.value)} /><small>长任务会优先占用夜间</small></label><label><span>休息日</span><input value={settings.weekend} onChange={(event) => field("weekend", event.target.value)} /><small>默认白天随时可换盘</small></label></div><div className="rule-divider" /><div className="slider-row"><div><strong>失败与准备缓冲</strong><p>在 DDL 前预留切片、冷却、失败重打时间。</p></div><input type="range" min="0" max="30" value={settings.failureBuffer} onChange={(event) => field("failureBuffer", Number(event.target.value))} /><b>{settings.failureBuffer}%</b></div><label className="switch-row"><span><strong>未按时开始时自动重排</strong><small>超过阈值后，优先安排最能利用当前空档的项目。</small></span><input type="checkbox" checked={settings.autoReschedule} onChange={(event) => field("autoReschedule", event.target.checked)} /></label><button className="primary-button save-rules" onClick={onSave}>保存并重新计算队列</button></section><aside className="rule-preview"><span>规则影响预览</span><strong>{scheduleCount}</strong><p>个打印盘已自动编排</p><div><span>预计空闲</span><b>{durationLabel(idleMinutes)}</b></div><div><span>夜间策略</span><b>长任务优先</b></div><div><span>工作日换盘</span><b>3 个窗口</b></div></aside></div>;
}

function NotificationsView({ settings, onChange, onSave, onTest }: { settings: ScheduleSettings; onChange: (value: ScheduleSettings) => void; onSave: () => void; onTest: () => void }) {
  return <div className="settings-layout"><section className="content-card"><div className="content-head"><div><h2>Bark 通知</h2><p>在 iPhone 上安装 Bark，复制 Key 即可接收换盘提醒。</p></div><span className={`connection ${settings.barkKey ? "connected" : ""}`}>{settings.barkKey ? "已配置" : "未连接"}</span></div><label className="settings-field"><span>Bark Key</span><div className="input-action"><input type="password" placeholder="例如：AbCdEf123456" value={settings.barkKey} onChange={(event) => onChange({ ...settings, barkKey: event.target.value })} /><button onClick={onTest}>发送测试</button></div><small>Key 仅用于向 api.day.app 发送你的打印提醒。</small></label><div className="rule-divider" /><div className="rules-grid"><label><span>提前提醒</span><input type="number" min="1" max="120" value={settings.reminderMinutes} onChange={(event) => onChange({ ...settings, reminderMinutes: Number(event.target.value) })} /><small>分钟</small></label><label><span>逾期阈值</span><input type="number" min="5" max="180" value={settings.overdueMinutes} onChange={(event) => onChange({ ...settings, overdueMinutes: Number(event.target.value) })} /><small>超过后建议重排</small></label></div><div className="notification-samples"><div><span>即将换盘</span><p>下一盘开始前提醒，并显示项目、盘号和设备。</p><i>开启</i></div><div><span>任务逾期</span><p>未确认开始时提醒，页面打开时自动重排。</p><i>开启</i></div><div><span>DDL 风险</span><p>失败缓冲不足或预计延期时立即提醒。</p><i>开启</i></div></div><button className="primary-button save-rules" onClick={onSave}>保存通知设置</button></section><aside className="phone-preview"><div className="phone-notch" /><span>现在</span><div className="bark-preview"><b>PRINTFLOW</b><strong>该换盘了</strong><p>机械龙翼组件 · 第 2/3 盘<br />P1S-01 · 预计打印 6h 06m</p></div><small>提前 {settings.reminderMinutes} 分钟提醒</small></aside></div>;
}
