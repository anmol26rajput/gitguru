import test from "node:test";
import assert from "node:assert/strict";
import { acceptPageMessage, acceptPing, MAX_PAGE_TEXT, MAX_TITLE, MAX_URL } from "./embed.ts";

const parent = {};
const good = { type: "gitguru:page", url: "https://example.com/a", title: "A", text: "hello" };
const ev = (o: Partial<{ origin: string; source: unknown; data: unknown }> = {}) =>
  ({ origin: "chrome-extension://abcdef", source: parent, data: good, ...o });

test("accepts a well-formed message from the extension's parent window", () => {
  assert.deepEqual(acceptPageMessage(ev(), parent), { url: good.url, title: good.title, text: "hello" });
});

test("rejects a web origin, even with the right shape", () => {
  for (const origin of ["https://evil.example", "http://localhost:3000", "", "null", "moz-extension://x"]) {
    assert.equal(acceptPageMessage(ev({ origin }), parent), null);
  }
});

test("rejects a message whose source is not the parent window", () => {
  assert.equal(acceptPageMessage(ev({ source: {} }), parent), null);
  assert.equal(acceptPageMessage(ev({ source: null }), null), null);
});

test("rejects other types, missing or extra fields and wrong field types", () => {
  const bad: unknown[] = [
    null, "gitguru:page", 5, [], {},
    { ...good, type: "gitguru:other" },
    { url: good.url, title: good.title, text: good.text },
    { ...good, extra: 1 },
    { ...good, text: 5 },
    { ...good, title: null },
    { ...good, url: undefined },
  ];
  for (const data of bad) assert.equal(acceptPageMessage(ev({ data }), parent), null);
});

test("caps the text at 200,000 characters", () => {
  const out = acceptPageMessage(ev({ data: { ...good, text: "x".repeat(MAX_PAGE_TEXT + 500) } }), parent);
  assert.equal(out?.text.length, 200_000);
});

test("clamps the title to 300 characters", () => {
  const out = acceptPageMessage(ev({ data: { ...good, title: "t".repeat(MAX_TITLE + 50) } }), parent);
  assert.equal(out?.title.length, 300);
});

test("rejects a url over 2000 characters, keeps one at the limit", () => {
  const url = (n: number) => "https://example.com/" + "a".repeat(n - 20);
  assert.equal(acceptPageMessage(ev({ data: { ...good, url: url(MAX_URL + 1) } }), parent), null);
  assert.equal(acceptPageMessage(ev({ data: { ...good, url: url(MAX_URL) } }), parent)?.url.length, MAX_URL);
});

test("the text cut never leaves half of a surrogate pair", () => {
  const emoji = "\u{1F600}"; // 2 code units
  const cut = acceptPageMessage(ev({ data: { ...good, text: "x".repeat(MAX_PAGE_TEXT - 1) + emoji } }), parent);
  assert.equal(cut?.text, "x".repeat(MAX_PAGE_TEXT - 1));
  const whole = acceptPageMessage(ev({ data: { ...good, text: "x".repeat(MAX_PAGE_TEXT - 2) + emoji } }), parent);
  assert.equal(whole?.text.length, MAX_PAGE_TEXT);
});

test("the title never ends on a lone high surrogate, cut or not", () => {
  const short = acceptPageMessage(ev({ data: { ...good, title: "Hi \uD83D" } }), parent);
  assert.equal(short?.title, "Hi ");
  const cut = acceptPageMessage(ev({ data: { ...good, title: "t".repeat(MAX_TITLE - 1) + "\u{1F600}" } }), parent);
  assert.equal(cut?.title, "t".repeat(MAX_TITLE - 1));
});

test("acceptPing: only {type:'gitguru:ping'} from a chrome-extension parent", () => {
  const ping = { type: "gitguru:ping" };
  assert.equal(acceptPing(ev({ data: ping }), parent), true);
  assert.equal(acceptPing(ev({ data: ping, origin: "https://evil.example" }), parent), false);
  assert.equal(acceptPing(ev({ data: ping, source: {} }), parent), false);
  assert.equal(acceptPing(ev({ data: ping, source: null }), null), false);
  for (const data of [null, "gitguru:ping", [], {}, { type: "gitguru:ready" }, { ...ping, extra: 1 }, good]) {
    assert.equal(acceptPing(ev({ data }), parent), false);
  }
});
