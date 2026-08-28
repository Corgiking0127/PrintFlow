import assert from "node:assert/strict";
import test from "node:test";
import { MakerWorldDesign, MakerWorldProfileNotFoundError, makerWorldApiHost, parseMakerWorldDesign } from "../lib/makerworld";

const design: MakerWorldDesign = {
  title: "多盘测试模型",
  defaultInstanceId: 222,
  instances: [
    {
      id: 111,
      profileId: 9001,
      title: "单盘配置",
      extention: {
        modelInfo: {
          compatibility: { devProductName: "P1S" },
          plates: [{ index: 1, name: "单盘", prediction: 3601, filaments: [{ type: "PLA" }] }],
        },
      },
    },
    {
      id: 222,
      profileId: 9002,
      title: "三盘配置",
      extention: {
        modelInfo: {
          compatibility: { devProductName: "X2D" },
          plates: [
            { index: 1, name: "底座", prediction: 1201 },
            { index: 2, name: "外壳", prediction: 1800 },
            { index: 3, name: "配件", prediction: 2399 },
          ],
        },
        otherCompatibilityModelInfo: [{
          id: 333,
          profileId: 9102,
          modelInfo: {
            compatibility: { devProductName: "A1" },
            plates: [{ index: 1, name: "A1 合盘", prediction: 5400 }],
          },
        }],
      },
    },
  ],
};

test("global and China MakerWorld links use their matching official API", () => {
  assert.equal(makerWorldApiHost(new URL("https://makerworld.com/en/models/123")), "api.bambulab.com");
  assert.equal(makerWorldApiHost(new URL("https://makerworld.com.cn/zh/models/123")), "api.bambulab.cn");
  assert.equal(makerWorldApiHost(new URL("https://example.com/models/123")), null);
});

test("shared profileId fragment selects MakerWorld instance.id instead of the first profile", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com.cn/zh/models/123#profileId-222"));
  assert.ok(result);
  assert.equal(result.project.plates, 3);
  assert.deepEqual(result.project.plateDurations, [20, 30, 40]);
  assert.equal(result.project.durationMinutes, 90);
  assert.equal(result.profile.instanceId, 222);
  assert.equal(result.profile.id, 9002);
});

test("API profileId and compatibility profileId links remain supported", () => {
  const primary = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123?profileId=9001"));
  const compatible = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-9102"));
  assert.equal(primary?.project.plates, 1);
  assert.equal(primary?.project.durationMinutes, 60);
  assert.equal(compatible?.project.plates, 1);
  assert.equal(compatible?.project.durationMinutes, 90);
  assert.equal(compatible?.profile.printer, "A1");
});

test("model-only links select defaultInstanceId rather than array order", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123"));
  assert.equal(result?.profile.instanceId, 222);
  assert.equal(result?.project.plates, 3);
});

test("unknown requested profile is rejected instead of silently using another profile", () => {
  assert.throws(
    () => parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-999999")),
    MakerWorldProfileNotFoundError,
  );
});

test("plate seconds are rounded to the nearest minute instead of always rounded up", () => {
  const result = parseMakerWorldDesign(design, new URL("https://makerworld.com/en/models/123#profileId-111"));
  assert.equal(result?.project.durationMinutes, 60);
});

test("Spring Gun V5 shared link selects its 4.3 hour, 2-plate default profile", () => {
  const springGun: MakerWorldDesign = {
    title: "Spring Gun V5 - Shoots fake bullets with magazine",
    defaultInstanceId: 1613981,
    instances: [
      {
        id: 1613981,
        profileId: 334226728,
        title: "Spring Gun V5",
        extention: {
          modelInfo: {
            compatibility: { devProductName: "P1S" },
            plates: [{ index: 1, prediction: 8075 }, { index: 2, prediction: 7391 }],
          },
        },
      },
      { id: 1614029, profileId: 332853185, title: "3x Bullets Bicolor", extention: { modelInfo: { plates: [{ index: 1, prediction: 1483 }] } } },
      { id: 1613990, profileId: 332843999, title: "Target with points", extention: { modelInfo: { plates: [{ index: 1, prediction: 4818 }, { index: 2, prediction: 3588 }] } } },
      { id: 2613719, profileId: 646582634, title: "PETG · A1 Mini", extention: { modelInfo: { plates: [{ index: 1, prediction: 8089 }, { index: 2, prediction: 7129 }] } } },
    ],
  };
  const result = parseMakerWorldDesign(
    springGun,
    new URL("https://makerworld.com/zh/models/1538231-spring-gun-v5-shoots-fake-bullets-with-magazine?from=search#profileId-1613981"),
  );
  assert.equal(springGun.instances?.length, 4);
  assert.equal(result?.profile.instanceId, 1613981);
  assert.equal(result?.project.plates, 2);
  assert.deepEqual(result?.project.plateDurations, [135, 123]);
  assert.equal(result?.project.durationMinutes, 258);
});
