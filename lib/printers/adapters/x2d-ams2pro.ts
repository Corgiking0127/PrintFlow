import { AmsTrayTelemetry, NozzleTelemetry, PrinterAdapter, PrinterState, PrinterTelemetry, X2D_AMS2_ADAPTER_ID } from "../types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstNumber(source: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = number(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeState(rawState: string): { state: PrinterState; label: string } {
  const normalized = rawState.trim().toUpperCase();
  if (["RUNNING", "PRINTING"].includes(normalized)) return { state: "printing", label: "打印中" };
  if (["PAUSE", "PAUSED"].includes(normalized)) return { state: "paused", label: "已暂停" };
  if (["FINISH", "FINISHED", "COMPLETE"].includes(normalized)) return { state: "complete", label: "已完成" };
  if (["FAILED", "FAIL", "ERROR"].includes(normalized)) return { state: "failed", label: "异常" };
  if (["PREPARE", "PREPARING", "SLICING"].includes(normalized)) return { state: "preparing", label: "准备中" };
  if (["IDLE", "READY", ""].includes(normalized)) return { state: "idle", label: "待机" };
  return { state: "unknown", label: rawState || "未知" };
}

function color(value: unknown): string {
  const hex = string(value).replace(/^#/, "").slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : "#b7b9b5";
}

function buildNozzles(print: JsonObject): NozzleTelemetry[] {
  const current = print.nozzle_temper;
  const target = print.nozzle_target_temper;
  if (Array.isArray(current) || Array.isArray(target)) {
    const currents = list(current);
    const targets = list(target);
    return [
      { id: "left", label: "左喷嘴", currentC: number(currents[0]), targetC: number(targets[0]) },
      { id: "right", label: "右喷嘴", currentC: number(currents[1]), targetC: number(targets[1]) },
    ];
  }

  const leftCurrent = firstNumber(print, ["nozzle_1_temper", "left_nozzle_temper", "nozzle_temper_left"]);
  const rightCurrent = firstNumber(print, ["nozzle_2_temper", "right_nozzle_temper", "nozzle_temper_right"]);
  const leftTarget = firstNumber(print, ["nozzle_1_target_temper", "left_nozzle_target_temper", "nozzle_target_temper_left"]);
  const rightTarget = firstNumber(print, ["nozzle_2_target_temper", "right_nozzle_target_temper", "nozzle_target_temper_right"]);
  if (leftCurrent !== null || rightCurrent !== null || leftTarget !== null || rightTarget !== null) {
    return [
      { id: "left", label: "左喷嘴", currentC: leftCurrent, targetC: leftTarget },
      { id: "right", label: "右喷嘴", currentC: rightCurrent, targetC: rightTarget },
    ];
  }

  return [{ id: "primary", label: "当前喷嘴", currentC: number(current), targetC: number(target) }];
}

function buildTray(trayValue: unknown, unitId: string, activeTrayId: string): AmsTrayTelemetry {
  const tray = object(trayValue);
  const slot = string(tray.id);
  const globalId = `${unitId}-${slot}`;
  const name = string(tray.tray_id_name) || `槽位 ${Number(slot || 0) + 1}`;
  return {
    id: globalId,
    name,
    material: string(tray.tray_type) || "未识别",
    subBrand: string(tray.tray_sub_brands),
    color: color(tray.tray_color || list(tray.cols)[0]),
    remainingPercent: number(tray.remain),
    active: activeTrayId === globalId,
  };
}

function buildErrors(print: JsonObject): string[] {
  const errors: string[] = [];
  const code = number(print.print_error);
  if (code && code !== 0) errors.push(`打印机错误 ${code}`);
  for (const item of list(print.hms)) {
    const hms = object(item);
    const attr = string(hms.attr);
    const sourceModule = string(hms.module);
    const text = string(hms.message || hms.msg);
    errors.push(text || [sourceModule, attr].filter(Boolean).join("-") || "设备告警");
  }
  return errors.slice(0, 8);
}

function normalizeX2dAms2Pro(payload: unknown): PrinterTelemetry {
  const root = object(payload);
  const print = object(root.print || root);
  const ams = object(print.ams);
  const activeRaw = string(ams.tray_now);
  const activeNumeric = /^\d+$/.test(activeRaw) ? Number(activeRaw) : null;
  const activeTrayId = activeRaw.includes("-") ? activeRaw : activeNumeric !== null && activeNumeric >= 0 && activeNumeric < 254
    ? `${Math.floor(activeNumeric / 4)}-${activeNumeric % 4}`
    : activeRaw;
  const mappedState = normalizeState(string(print.gcode_state));
  const amsUnits = list(ams.ams).map((unitValue, index) => {
    const unit = object(unitValue);
    const id = string(unit.id) || String(index);
    const dryingState = string(unit.drying_status || unit.dry_status || unit.state).toLowerCase();
    return {
      id,
      label: list(ams.ams).length > 1 ? `AMS 2 Pro ${index + 1}` : "AMS 2 Pro",
      humidityLevel: number(unit.humidity),
      humidityPercent: number(unit.humidity_raw),
      temperatureC: number(unit.temp),
      drying: ["1", "on", "drying", "running"].includes(dryingState) || Boolean(number(unit.dry_time) && number(unit.dry_time)! > 0),
      dryingTime: number(unit.dry_time),
      trays: list(unit.tray).map((tray) => buildTray(tray, id, activeTrayId)),
    };
  });

  return {
    state: mappedState.state,
    stateLabel: mappedState.label,
    progress: Math.max(0, Math.min(100, Math.round(number(print.mc_percent) || 0))),
    remainingMinutes: number(print.mc_remaining_time),
    taskName: string(print.subtask_name) || string(print.gcode_file) || (mappedState.state === "idle" ? "等待队列" : "当前打印任务"),
    gcodeFile: string(print.gcode_file),
    currentLayer: number(print.layer_num),
    totalLayers: number(print.total_layer_num),
    bedCurrentC: number(print.bed_temper),
    bedTargetC: number(print.bed_target_temper),
    chamberCurrentC: number(print.chamber_temper),
    wifiSignal: string(print.wifi_signal),
    speedLevel: number(print.spd_lvl),
    nozzles: buildNozzles(print),
    activeTrayId,
    amsUnits,
    errors: buildErrors(print),
    receivedAt: new Date().toISOString(),
  };
}

export const x2dAms2ProAdapter: PrinterAdapter = {
  id: X2D_AMS2_ADAPTER_ID,
  model: "Bambu Lab X2D + AMS 2 Pro",
  normalize: normalizeX2dAms2Pro,
};
