import assert from "node:assert/strict";
import test from "node:test";
import { getPrinterAdapter, getSupportedAdapters } from "../lib/printers/registry";
import { isUnconfirmedPlaceholderTelemetry, X2D_AMS2_ADAPTER_ID } from "../lib/printers/types";

const sample = {
  print: {
    gcode_state: "RUNNING",
    mc_percent: 42,
    mc_remaining_time: 95,
    subtask_name: "双色收纳盒",
    layer_num: 120,
    total_layer_num: 300,
    nozzle_1_temper: 214.8,
    nozzle_1_target_temper: 220,
    nozzle_2_temper: 34.2,
    nozzle_2_target_temper: 0,
    bed_temper: 55.3,
    bed_target_temper: 55,
    chamber_temper: 37.8,
    wifi_signal: "-52dBm",
    ams: {
      tray_now: "0",
      ams: [{
        id: "0",
        humidity: "3",
        humidity_raw: "28",
        temp: "34.1",
        dry_time: 2,
        tray: [
          { id: "0", tray_id_name: "A1", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "FF3B30FF", remain: 82 },
          { id: "1", tray_id_name: "A2", tray_type: "PETG", tray_color: "3578E5FF", remain: 61 },
        ],
      }],
    },
  },
};

test("registry only exposes the requested X2D + AMS 2 Pro adapter", () => {
  assert.deepEqual(getSupportedAdapters(), [{ id: X2D_AMS2_ADAPTER_ID, model: "Bambu Lab X2D + AMS 2 Pro" }]);
});

test("X2D adapter normalizes print, dual-nozzle and AMS 2 Pro telemetry", () => {
  const adapter = getPrinterAdapter(X2D_AMS2_ADAPTER_ID);
  assert.ok(adapter);
  const telemetry = adapter.normalize(sample);
  assert.ok(telemetry);
  assert.equal(telemetry.state, "printing");
  assert.equal(telemetry.progress, 42);
  assert.equal(telemetry.remainingMinutes, 95);
  assert.equal(telemetry.taskName, "双色收纳盒");
  assert.deepEqual(telemetry.nozzles.map(({ id, currentC, targetC }) => ({ id, currentC, targetC })), [
    { id: "left", currentC: 214.8, targetC: 220 },
    { id: "right", currentC: 34.2, targetC: 0 },
  ]);
  assert.equal(telemetry.amsUnits[0].humidityPercent, 28);
  assert.equal(telemetry.amsUnits[0].drying, true);
  assert.equal(telemetry.amsUnits[0].trays[0].active, true);
  assert.equal(telemetry.amsUnits[0].trays[0].color, "#FF3B30");
  assert.equal(telemetry.amsUnits[0].trays[1].remainingPercent, 61);
});

test("X2D adapter preserves the last real state when an MQTT delta omits gcode_state", () => {
  const adapter = getPrinterAdapter(X2D_AMS2_ADAPTER_ID);
  assert.ok(adapter);
  const initial = adapter.normalize(sample);
  assert.ok(initial);
  const cached = { ...initial, receivedAt: "2026-08-28T18:06:50.313Z" };

  const telemetry = adapter.normalize({ print: { layer_num: 121 } }, cached);
  assert.ok(telemetry);
  assert.equal(telemetry.state, "printing");
  assert.equal(telemetry.stateLabel, "打印中");
  assert.equal(telemetry.progress, 42);
  assert.equal(telemetry.currentLayer, 121);
  assert.equal(telemetry.totalLayers, 300);
  assert.equal(telemetry.amsUnits[0].trays.length, 2);
  assert.notEqual(telemetry.receivedAt, cached.receivedAt);
  assert.equal(telemetry.stateUpdatedAt, cached.stateUpdatedAt);
});

test("X2D adapter ignores empty deltas and does not invent an initial idle state", () => {
  const adapter = getPrinterAdapter(X2D_AMS2_ADAPTER_ID);
  assert.ok(adapter);
  const cached = adapter.normalize(sample);
  assert.ok(cached);

  assert.equal(adapter.normalize({ print: { sequence_id: "123" } }), null);
  assert.strictEqual(adapter.normalize({ print: { sequence_id: "124" } }, cached), cached);
});

test("X2D adapter still accepts an explicit real idle state", () => {
  const adapter = getPrinterAdapter(X2D_AMS2_ADAPTER_ID);
  assert.ok(adapter);
  const cached = adapter.normalize(sample);
  assert.ok(cached);

  const telemetry = adapter.normalize({ print: { gcode_state: "IDLE" } }, cached);
  assert.ok(telemetry);
  assert.equal(telemetry.state, "idle");
  assert.equal(telemetry.stateLabel, "待机");
  assert.equal(telemetry.progress, 0);
  assert.equal(telemetry.taskName, "等待队列");
  assert.equal(telemetry.currentLayer, null);
  assert.equal(telemetry.stateUpdatedAt, telemetry.receivedAt);
});

test("legacy unconfirmed idle placeholders are hidden until a real state arrives", () => {
  const adapter = getPrinterAdapter(X2D_AMS2_ADAPTER_ID);
  assert.ok(adapter);
  const confirmedIdle = adapter.normalize({ print: { gcode_state: "IDLE" } });
  assert.ok(confirmedIdle);
  const { stateUpdatedAt: _stateUpdatedAt, ...legacyPlaceholder } = confirmedIdle;
  void _stateUpdatedAt;

  assert.equal(isUnconfirmedPlaceholderTelemetry(legacyPlaceholder), true);
  assert.equal(isUnconfirmedPlaceholderTelemetry(confirmedIdle), false);
});
