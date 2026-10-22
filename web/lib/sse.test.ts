import test from "node:test";
import assert from "node:assert/strict";
import { parseSSE } from "./sse.ts";

test("parses complete events and keeps the partial tail", () => {
  const { events, rest } = parseSSE('event: token\ndata: "Hel"\n\nevent: token\ndata: "lo"\n\nevent: do');
  assert.deepEqual(events, [{ event: "token", data: "Hel" }, { event: "token", data: "lo" }]);
  assert.equal(rest, "event: do");
});

test("an event split across two network chunks is parsed once whole", () => {
  const a = parseSSE('event: done\ndata: {"provider":');
  const b = parseSSE(a.rest + '"groq","cited":[1]}\n\n');
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, [{ event: "done", data: { provider: "groq", cited: [1] } }]);
});
