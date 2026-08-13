import assert from "node:assert/strict";
import test from "node:test";
import { planJustifiedRows } from "../public/justified-rows.js";

test("packs justified rows without losing order or leaving full-row gaps", () => {
  const ratios = [1.5, 2 / 3, 1.2, 1.8, 0.75, 4 / 3, 2.1, 0.6, 1.4];
  for (const width of [320, 390, 768, 1440, 2560]) {
    const rows = planJustifiedRows(ratios, width, 300, 5);
    assert.deepEqual(rows.flatMap((row) => row.items.map((item) => item.index)), ratios.map((_, index) => index));
    for (const row of rows) {
      const used = row.items.reduce((sum, item) => sum + item.ratio * row.height, 0) + 5 * Math.max(0, row.items.length - 1);
      if (row.partial) assert.ok(used < width);
      else assert.ok(Math.abs(used - width) < 0.001, `row at ${width}px leaves ${width - used}px`);
    }
  }
});

test("keeps a final photo with its neighbor and caps a sparse final row", () => {
  const rows = planJustifiedRows([2, 2, 2, 0.5], 1000, 200, 5);
  assert.deepEqual(rows.map((row) => row.items.map((item) => item.index)), [[0, 1], [2, 3]]);
  assert.equal(rows.at(-1).partial, true);
  assert.equal(rows.at(-1).height, 200);
});
