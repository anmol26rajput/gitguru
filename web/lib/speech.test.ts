import assert from "node:assert/strict";
import { test } from "node:test";
import { speechText, voiceError } from "./speech.ts";

test("drops citation markers", () => {
  assert.equal(speechText("Cookies live in a jar [1] and are sent [2]."), "Cookies live in a jar and are sent .");
});

test("replaces code blocks, including an unterminated one", () => {
  assert.equal(speechText("Use:\n```py\nx = a[1]\n```\nDone [1]"), "Use: code omitted Done");
  assert.equal(speechText("Use:\n```py\nx = 1"), "Use: code omitted");
});

test("voiceError maps known codes and falls back to the code", () => {
  assert.match(voiceError("not-allowed"), /blocked/);
  assert.equal(voiceError("service-not-allowed"), voiceError("not-allowed"));
  assert.equal(voiceError("audio-capture"), "No microphone found.");
  assert.equal(voiceError("weird"), "Voice input failed (weird).");
});
