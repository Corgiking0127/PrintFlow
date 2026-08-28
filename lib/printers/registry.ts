import { x2dAms2ProAdapter } from "./adapters/x2d-ams2pro";
import { PrinterAdapter, X2D_AMS2_ADAPTER_ID } from "./types";

const adapters: Record<string, PrinterAdapter> = {
  [X2D_AMS2_ADAPTER_ID]: x2dAms2ProAdapter,
};

export function getPrinterAdapter(id: string): PrinterAdapter | null {
  return adapters[id] || null;
}

export function getSupportedAdapters(): Pick<PrinterAdapter, "id" | "model">[] {
  return Object.values(adapters).map(({ id, model }) => ({ id, model }));
}
