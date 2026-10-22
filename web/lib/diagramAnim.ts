// Pure timing for the "How it works" animation (components/Diagram.tsx). Each step owns one 1.2 s slot:
// step i lights up at i slots, the dot runs along edge i (step i -> i+1) during slot i and so arrives as
// step i+1 lights, and the whole loop lasts one slot per step. Times are whole milliseconds.
export const STEP_MS = 1200;

const pct = (x: number) => +x.toFixed(2);

// Keyframes for `steps` steps (the stops depend on the count): a step's border turns accent early in its slot,
// holds, then fades back during the next slot.
export function litKeyframes(steps: number): string {
  const slot = 100 / steps;
  const [on, hold, off] = [pct(slot * 0.25), pct(slot * 0.85), pct(Math.min(100, slot * 1.6))];
  return (
    `@keyframes diagram-lit-${steps}{0%,${off}%,100%{stroke:var(--border);stroke-width:1px}` +
    `${on}%,${hold}%{stroke:var(--accent);stroke-width:2px}}`
  );
}

// The CSS `animation` value for step i of `steps`.
export function litAnimation(steps: number, i: number): string {
  return `diagram-lit-${steps} ${steps * STEP_MS}ms ease-in-out ${i * STEP_MS}ms infinite`;
}

// SMIL timing for the dot on edge i: it moves during the first slot of each loop (keyTimes 0..move), then hides.
export function dotTiming(steps: number, i: number) {
  return { begin: `${i * STEP_MS}ms`, dur: `${steps * STEP_MS}ms`, move: +(1 / steps).toFixed(4) };
}
