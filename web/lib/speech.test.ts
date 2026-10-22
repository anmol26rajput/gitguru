import assert from "node:assert/strict";
import { test } from "node:test";
import { pickVoice, speechText, splitSpeech, ttsPieces, voiceError } from "./speech.ts";

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

test("splitSpeech keeps short text whole and empty text empty", () => {
  assert.deepEqual(splitSpeech("One. Two."), ["One. Two."]);
  assert.deepEqual(splitSpeech("  "), []);
});

test("splitSpeech packs sentences into pieces of at most max, in order", () => {
  const parts = splitSpeech("Aaaa. Bbbb. Cccc. Dddd.", 12);
  assert.deepEqual(parts, ["Aaaa. Bbbb.", "Cccc. Dddd."]);
  const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(" ");
  const pieces = splitSpeech(long);
  assert.ok(pieces.length > 1 && pieces.every((p) => p.length <= 1500));
  assert.equal(pieces.join(" "), long);
});

test("splitSpeech breaks an over-long sentence at spaces, then hard", () => {
  assert.deepEqual(splitSpeech("aaa bbb ccc ddd", 7), ["aaa bbb", "ccc ddd"]);
  assert.deepEqual(splitSpeech("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("pickVoice prefers a named female voice, else the first English one", () => {
  const v = (name: string, lang = "en-US") => ({ name, lang });
  assert.equal(pickVoice([v("Daniel", "en-GB"), v("Samantha"), v("Karen")])?.name, "Samantha");
  assert.equal(pickVoice([v("Amelie", "fr-FR"), v("Daniel", "en-GB")])?.name, "Daniel");
  assert.equal(pickVoice([v("Amelie", "fr-FR")]), undefined);
  assert.equal(pickVoice([]), undefined);
});

test("pickVoice considers only English voices and prefers an en-US match over list order", () => {
  const v = (name: string, lang = "en-US") => ({ name, lang });
  // macOS lists Karen (en-AU) before Samantha (en-US).
  assert.equal(pickVoice([v("Karen", "en-AU"), v("Samantha")])?.name, "Samantha");
  assert.equal(pickVoice([v("Karen", "en_AU"), v("Daniel", "en-GB"), v("Google US English", "en_US")])?.name, "Google US English");
  // A matching name in another language never wins.
  assert.equal(pickVoice([v("Female", "fr-FR"), v("Daniel", "en-GB")])?.name, "Daniel");
  assert.equal(pickVoice([v("Ava", "de-DE")]), undefined);
  // No en-US match: another English match beats a plain English voice.
  assert.equal(pickVoice([v("Daniel", "en-GB"), v("Karen", "en-AU")])?.name, "Karen");
});

test("ttsPieces: a short first piece (the first sentence or two), then pieces of at most 500", () => {
  assert.deepEqual(ttsPieces(""), []);
  assert.deepEqual(ttsPieces("One. Two."), ["One. Two."]);
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const [first, ...rest] = ttsPieces(long);
  assert.ok(first.length <= 150 && first.length > 100);
  assert.ok(rest.length > 1 && rest.every((p) => p.length <= 500) && rest[0].length > 400);
  assert.equal([first, ...rest].join(" "), long);
});
