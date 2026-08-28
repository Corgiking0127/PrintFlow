export const X2D_AMS2_ADAPTER_ID = "bambu-x2d-ams2pro" as const;

export type PrinterState = "printing" | "paused" | "complete" | "failed" | "idle" | "preparing" | "unknown";

export interface NozzleTelemetry {
  id: "left" | "right" | "primary";
  label: string;
  currentC: number | null;
  targetC: number | null;
}

export interface AmsTrayTelemetry {
  id: string;
  name: string;
  material: string;
  subBrand: string;
  color: string;
  remainingPercent: number | null;
  active: boolean;
}

export interface AmsUnitTelemetry {
  id: string;
  label: string;
  humidityLevel: number | null;
  humidityPercent: number | null;
  temperatureC: number | null;
  drying: boolean;
  dryingTime: number | null;
  trays: AmsTrayTelemetry[];
}

export interface PrinterTelemetry {
  state: PrinterState;
  stateLabel: string;
  progress: number;
  remainingMinutes: number | null;
  taskName: string;
  gcodeFile: string;
  currentLayer: number | null;
  totalLayers: number | null;
  bedCurrentC: number | null;
  bedTargetC: number | null;
  chamberCurrentC: number | null;
  wifiSignal: string;
  speedLevel: number | null;
  nozzles: NozzleTelemetry[];
  activeTrayId: string;
  amsUnits: AmsUnitTelemetry[];
  errors: string[];
  stateUpdatedAt?: string;
  receivedAt: string;
}

export function isUnconfirmedPlaceholderTelemetry(telemetry: PrinterTelemetry | null | undefined): boolean {
  return Boolean(
    telemetry
    && !telemetry.stateUpdatedAt
    && telemetry.state === "idle"
    && telemetry.progress === 0
    && telemetry.remainingMinutes === null
    && telemetry.taskName === "等待队列"
    && !telemetry.gcodeFile
    && telemetry.totalLayers === null
    && telemetry.bedCurrentC === null
    && telemetry.bedTargetC === null
    && !telemetry.wifiSignal
    && telemetry.amsUnits.length === 0
    && telemetry.nozzles.every((nozzle) => nozzle.currentC === null && nozzle.targetC === null),
  );
}

export interface PrinterAdapter {
  id: string;
  model: string;
  normalize(payload: unknown, previous?: PrinterTelemetry | null): PrinterTelemetry | null;
}

export interface SavedPrinter {
  id: string;
  name: string;
  model: string;
  adapter: string;
  serial: string;
  localIp: string;
  telemetry: PrinterTelemetry | null;
  dataUpdatedAt: string | null;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}
