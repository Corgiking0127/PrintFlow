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
  receivedAt: string;
}

export interface PrinterAdapter {
  id: string;
  model: string;
  normalize(payload: unknown): PrinterTelemetry;
}

export interface SavedPrinter {
  id: string;
  name: string;
  model: string;
  adapter: string;
  serial: string;
  localIp: string;
  telemetry: PrinterTelemetry | null;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}
