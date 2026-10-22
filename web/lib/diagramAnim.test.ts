import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_MS, dotTiming, litAnimation, litKeyframes } from "./diagramAnim.ts";

test("step i lights at i slots and the loop is one slot per step", () => {
  assert.equal(litAnimation(4, 0), "diagram-lit-4 4800ms ease-in-out 0ms infinite");
  assert.equal(litAnimation(4, 3), "diagram-lit-4 4800ms ease-in-out 3600ms infinite");
  assert.equal(litAnimation(3, 2), `diagram-lit-3 ${3 * STEP_MS}ms ease-in-out 2400ms infinite`); // no 3.5999999 floats
});

test("lit window sits inside the step's slot and the fade ends by the loop's end", () => {
  assert.equal(
    litKeyframes(4),
    "@keyframes diagram-lit-4{0%,40%,100%{stroke:var(--border);stroke-width:1px}6.25%,21.25%{stroke:var(--accent);stroke-width:2px}}",
  );
  assert.match(litKeyframes(1), /0%,100%,100%/); // one step: the fade is clamped to the loop
  assert.match(litKeyframes(3), /8\.33%,28\.33%/);
});

test("the dot on edge i starts as step i lights and moves for one slot of the loop", () => {
  assert.deepEqual(dotTiming(4, 0), { begin: "0ms", dur: "4800ms", move: 0.25 });
  assert.deepEqual(dotTiming(4, 2), { begin: "2400ms", dur: "4800ms", move: 0.25 });
  assert.deepEqual(dotTiming(3, 1), { begin: "1200ms", dur: "3600ms", move: 0.3333 });
});
