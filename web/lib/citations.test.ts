import assert from "node:assert/strict";
import { test } from "node:test";
import { linkCitations } from "./citations.ts";

test("rewrites plain citations", () => {
  assert.equal(linkCitations("see [1] and [2]"), "see [[1]](#cite-1) and [[2]](#cite-2)");
});

test("leaves inline code alone", () => {
  assert.equal(linkCitations("`arr[0]`"), "`arr[0]`");
  assert.equal(linkCitations("`a[1]` then [2]"), "`a[1]` then [[2]](#cite-2)");
});

test("leaves fenced blocks alone, rewrites after the fence", () => {
  const src = "```py\nx[1]\n```\nsee [1]";
  assert.equal(linkCitations(src), "```py\nx[1]\n```\nsee [[1]](#cite-1)");
  assert.equal(linkCitations("```py\nx[1]"), "```py\nx[1]");
});
