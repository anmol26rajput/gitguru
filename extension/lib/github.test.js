import { test } from "node:test";
import assert from "node:assert/strict";
import { repoFromUrl } from "./github.js";

const R = "https://github.com/psf/requests";

test("repo pages map to the repo", () => {
  for (const u of [
    R,
    R + "/",
    "http://github.com/psf/requests",
    "https://www.github.com/psf/requests",
    R + ".git",
    R + "/tree/main/src/requests",
    R + "/blob/main/README.md#L10-L20",
    R + "/issues/42",
    R + "/pull/7/files",
    R + "?tab=readme-ov-file",
    R + "#readme",
    R + "/tree/main?foo=bar#baz",
  ]) {
    assert.equal(repoFromUrl(u), R, u);
  }
});

test("dots, dashes and case are kept", () => {
  assert.equal(repoFromUrl("https://github.com/Vercel/next.js/tree/canary"), "https://github.com/Vercel/next.js");
  assert.equal(repoFromUrl("https://github.com/a-b/c_d.e.git"), "https://github.com/a-b/c_d.e");
});

test("non-repo pages give null", () => {
  for (const u of [
    "https://github.com",
    "https://github.com/",
    "https://github.com/settings",
    "https://github.com/settings/profile",
    "https://github.com/orgs/vercel",
    "https://github.com/orgs/vercel/people",
    "https://github.com/psf",
    "https://github.com/psf/",
    "https://gist.github.com/psf/abc123",
    "https://github.com/features",
    "https://github.com/features/copilot",
    "https://github.com/marketplace/actions",
    "https://github.com/topics/python",
    "https://github.com/explore",
    "https://github.com/notifications",
    "https://github.com/pulls",
    "https://github.com/issues",
    "https://github.com/login",
    "https://github.com/new",
    "https://github.com/sponsors/psf",
    "https://example.com/psf/requests",
    "https://github.com.evil.com/psf/requests",
    "https://evil.com/github.com/psf/requests",
    "ftp://github.com/psf/requests",
    "chrome://extensions",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(repoFromUrl(u), null, String(u));
  }
});
