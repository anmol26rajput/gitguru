import test from "node:test";
import assert from "node:assert/strict";
import { countRuns } from "./evalRuns.ts";

const PAIRS = ["ast", "line"].flatMap((strategy) => ["keyword", "vector", "hybrid", "hybrid_rerank"].map((mode) => ({ strategy, mode })));
const run = (start: number, n = 8) => PAIRS.slice(0, n).map((p, i) => ({ id: start + i, ...p }));
const newestFirst = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => b.id - a.id);

test("two full runs count as 2", () => {
  assert.equal(countRuns(newestFirst([...run(1), ...run(9)])), 2);
});

test("a partial second run still counts as 2", () => {
  assert.equal(countRuns(newestFirst([...run(1), ...run(9, 3)])), 2);
});

test("one run is 1 and no rows is 0", () => {
  assert.equal(countRuns(newestFirst(run(1))), 1);
  assert.equal(countRuns([]), 0);
});
