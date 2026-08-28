import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("production UI does not seed demo projects or fake printer records", () => {
  for (const marker of ["seedProjects", "demo-helmet", "demo-dragon", "P1S-01", "A1 mini", "X1C-01"]) {
    assert.equal(pageSource.includes(marker), false, `unexpected mock marker: ${marker}`);
  }
});
