import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ZOOM, MIN_ZOOM, clampZoom, fitZoom, scrollShift, stepZoom, wheelZoom } from "./zoom.ts";

test("clampZoom keeps zoom within 10%-400%", () => {
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(1.5), 1.5);
});

test("stepZoom multiplies by 1.25 and stops at the limits", () => {
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1.25, -1), 1);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
});

test("fitZoom shrinks wide diagrams, never enlarges, clamps and tolerates bad input", () => {
  assert.equal(fitZoom(500, 1000), 0.5);
  assert.equal(fitZoom(500, 100), 1);
  assert.equal(fitZoom(100, 10000), MIN_ZOOM);
  assert.equal(fitZoom(846, 4468), 846 / 4468); // a very wide diagram still fits the width
  assert.equal(fitZoom(0, 100), 1);
  assert.equal(fitZoom(100, 0), 1);
});

test("wheelZoom: a full notch is one step, small pinch deltas are small, direction and clamp hold", () => {
  assert.ok(Math.abs(wheelZoom(1, -100) - 1.25) < 1e-9);
  assert.ok(Math.abs(wheelZoom(1.25, 100) - 1) < 1e-9);
  const small = wheelZoom(1, -2);
  assert.ok(small > 1 && small < 1.02);
  assert.equal(wheelZoom(MAX_ZOOM, -100), MAX_ZOOM);
  assert.equal(wheelZoom(1, 0), 1);
});

test("scrollShift keeps the point under the pointer fixed", () => {
  // diagram edge at x=10, pointer at x=110 (100px into the diagram), zoom x2: the point is now 200px in.
  // wanted edge = 110 - 200 = -90; layout left the edge at 10, so scroll by 100.
  assert.equal(scrollShift(110, 10, 10, 2), 100);
  assert.equal(scrollShift(110, 10, 10, 1), 0);
});
