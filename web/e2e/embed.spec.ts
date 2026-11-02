import { expect, test, type Page } from "@playwright/test";
import { saveSettings } from "./helpers";

// The extension's side panel loads the app as /?embed=1. Its postMessages are simulated below with synthetic
// MessageEvents (a chrome-extension:// origin, source = window); lib/embed.test.ts covers the checks themselves.
test("embed home: no hero, no top Nav; URL box, Settings and repos show", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/?embed=1");
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
  await expect(page.getByRole("link", { name: /tiny_repo/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Understand any codebase." })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings?embed=1");
});

test("the embed flag survives a repo card, its tabs and Settings", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/?embed=1");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await expect(page).toHaveURL(/\/r\/\d+\?embed=1$/);
  await page.getByRole("link", { name: "Diagram" }).click();
  await expect(page).toHaveURL(/\/r\/\d+\/diagram\?embed=1$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\?embed=1$/);
  await expect(page.getByLabel("API URL")).toBeVisible();
  await page.getByRole("link", { name: "← Back" }).click();
  await expect(page).toHaveURL(/\/\?embed=1$/);
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
});

test("embed with no token lists the repos; a 401 hint links to Settings in embed mode", async ({ page }) => {
  await page.goto("/?embed=1");
  await expect(page.getByRole("link", { name: /tiny_repo/ })).toBeVisible();
  // Only DELETE can answer 401 now; mocked here so the hint and its embed link are still covered.
  await page.route("**/repos", (route) =>
    route.fulfill({ status: 401, json: { detail: "missing or invalid token" }, headers: { "access-control-allow-origin": "*" } }));
  await page.reload();
  await expect(page.getByText("Only the owner can do this. Check the owner token in Settings.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings?embed=1");
});

test("normal mode is unchanged: hero and top Nav, plain links", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand any codebase." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await expect(page).toHaveURL(/\/r\/\d+$/);
});

test("embed ?source= opens the repo's Chat when indexing finishes", async ({ page }) => {
  // Mocked: the API only indexes GitHub URLs. Repo 1 is the real tiny_repo, so its Chat loads for real.
  const cors = { "access-control-allow-origin": "*" };
  await page.route("**/repos", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { repo_id: 1, job_id: 7 }, headers: cors }) : route.continue());
  await page.route("**/jobs/7/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", headers: cors, body: 'event: progress\ndata: {"pct":50,"message":"Reading"}\n\nevent: done\ndata: {}\n\n' }));
  await saveSettings(page);
  await page.goto("/?embed=1&source=https://github.com/a/b");
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
  await expect(page).toHaveURL(/\/r\/1\?embed=1$/);
});

const READY_REPO = { id: 1, kind: "github", source: "https://github.com/a/b", title: "tiny_repo", status: "ready", stats: {}, last_used_at: "2026-10-22T00:00:00Z", summary: null, progress: 100, message: "done" };

test("embed ?source= of a repo that is already ready opens its Chat without a job", async ({ page }) => {
  let posts = 0;
  await page.route("**/repos", (route) => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ json: route.request().method() === "POST" ? { repo_id: 1, job_id: 7 } : [READY_REPO], headers: { "access-control-allow-origin": "*" } });
  });
  await saveSettings(page);
  await page.goto("/?embed=1&source=https://github.com/a/b");
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
  await expect(page).toHaveURL(/\/r\/1\?embed=1$/);
  expect(posts).toBe(0);
});

test("outside embed, ?source= only fills the URL box", async ({ page }) => {
  let posts = 0;
  await page.route("**/repos", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    return route.abort();
  });
  await saveSettings(page);
  await page.goto("/?source=https://github.com/a/b");
  await expect(page.getByLabel("GitHub URL")).toHaveValue("https://github.com/a/b");
  await expect(page.getByRole("link", { name: /tiny_repo/ })).toBeVisible(); // the list loaded; nothing started
  expect(posts).toBe(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

// Page text from the extension. In a top-level page window.parent === window, so a MessageEvent whose source is
// `window` passes the real "sent by my parent" check; only the origin is faked.
type Posted = { url: string; title: string; text: string };
async function mockPages(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  const posted: Posted[] = [];
  await page.route("**/pages", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { repo_id: 1, job_id: 8 }, headers: cors });
  });
  await page.route("**/jobs/8/events", async (route) => {
    await new Promise((r) => setTimeout(r, 800)); // long enough to see the progress card
    await route.fulfill({ contentType: "text/event-stream", headers: cors, body: 'event: progress\ndata: {"pct":50,"message":"Reading"}\n\nevent: done\ndata: {}\n\n' });
  });
  return posted;
}
const send = (page: Page, data: unknown, origin = "chrome-extension://test", fromParent = true) =>
  page.evaluate(
    ([d, o, p]) => window.dispatchEvent(new MessageEvent("message", { origin: o as string, source: p ? window : null, data: d })),
    [data, origin, fromParent] as const,
  );
const PAGE = { type: "gitguru:page", url: "https://example.com/post", title: "A post", text: "Some readable text." };

test("every ping from the extension parent is answered with ready, posted to its origin", async ({ page }) => {
  // Record postMessage calls. Top level: window.parent === window, so the reply lands on this spy (and the
  // unsolicited once-per-load ready, which only goes to a real parent, is not sent).
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: unknown[][] };
    w.__posted = [];
    const real = window.postMessage.bind(window);
    window.postMessage = ((...args: Parameters<typeof window.postMessage>) => {
      w.__posted.push(args);
      return real(...args);
    }) as typeof window.postMessage;
  });
  await saveSettings(page);
  await page.goto("/?embed=1");
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
  const posted = () => page.evaluate(() => (window as unknown as { __posted: unknown[][] }).__posted);
  await send(page, { type: "gitguru:ping" }, "https://evil.example"); // wrong origin: no answer
  await send(page, { type: "gitguru:ping", extra: 1 }); // wrong shape: no answer
  await send(page, { type: "gitguru:ping" });
  await send(page, { type: "gitguru:ping" });
  const ready = [{ type: "gitguru:ready" }, "chrome-extension://test"];
  await expect.poll(posted).toEqual([ready, ready]);
});

test("accepted page text: POST /pages, progress card, then Chat", async ({ page }) => {
  const posted = await mockPages(page);
  await saveSettings(page);
  await page.goto("/?embed=1");
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
  await send(page, PAGE);
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
  await expect(page).toHaveURL(/\/r\/1\?embed=1$/);
  expect(posted).toEqual([{ url: PAGE.url, title: PAGE.title, text: PAGE.text }]);
});

test("rejected messages (web origin, other source, bad shape) never POST", async ({ page }) => {
  const posted = await mockPages(page);
  await saveSettings(page);
  await page.goto("/?embed=1");
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
  await send(page, PAGE, "https://evil.example");
  await send(page, PAGE, "chrome-extension://test", false);
  await send(page, { ...PAGE, extra: 1 });
  await send(page, { ...PAGE, text: 5 });
  await send(page, { ...PAGE, title: "Control" }, "chrome-extension://test"); // the only good one
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
  expect(posted.map((p) => p.title)).toEqual(["Control"]);
});

test("page text sent while on a repo page goes to Home and runs", async ({ page }) => {
  const posted = await mockPages(page);
  await saveSettings(page);
  await page.goto("/r/1/diagram?embed=1");
  await expect(page.getByRole("link", { name: "Chat" })).toBeVisible();
  await send(page, PAGE);
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
  await expect(page).toHaveURL(/\/r\/1\?embed=1$/);
  expect(posted).toHaveLength(1);
});

test("a page repo shows only Chat and Diagram; code repos get all four tabs", async ({ page }) => {
  const pageRepo = { id: 1, kind: "page", source: "https://example.com/post", title: "A page", status: "ready", stats: {}, last_used_at: "2026-10-22T00:00:00Z", summary: null, progress: 100, message: "done" };
  await page.route("**/repos/1", (route) => route.fulfill({ json: pageRepo, headers: { "access-control-allow-origin": "*" } }));
  await saveSettings(page);
  await page.goto("/r/1?embed=1");
  await expect(page.getByText("A page", { exact: true })).toBeVisible(); // the mocked repo has loaded
  await expect(page.getByRole("link", { name: "Diagram" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Walkthrough" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Quality" })).toHaveCount(0);
  await page.unroute("**/repos/1"); // back to the real tiny_repo (a code repo)
  await page.goto("/r/1");
  await expect(page.getByRole("link", { name: "Walkthrough" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quality" })).toBeVisible();
});
