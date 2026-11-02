import { expect, test } from "@playwright/test";
import { saveSettings } from "./helpers";

// GET /repos is mocked: the fake LLM never builds an overview, so no fixture repo has a summary.
const REPOS = [
  { id: 1, kind: "local", source: "tiny_repo", title: "tiny_repo", status: "ready", stats: { files: 3 }, last_used_at: "2026-10-22T00:00:00Z",
    summary: "A tiny demo project that checks passwords.", progress: 100, message: "done" },
  { id: 2, kind: "github", source: "https://github.com/psf/requests", title: "psf/requests", status: "indexing", stats: {},
    last_used_at: "2026-10-22T00:00:00Z", summary: null, progress: 40, message: "Reading files" },
  { id: 3, kind: "github", source: "https://github.com/a/b", title: "a/b", status: "failed", stats: {},
    last_used_at: "2026-10-22T00:00:00Z", summary: null, progress: 0, message: "Repository not found" },
];

test("home shows the hero and repo cards with their line and status", async ({ page }) => {
  await page.route("**/repos", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: REPOS }) : route.continue());
  await saveSettings(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand any codebase." })).toBeVisible();
  const card = page.getByRole("link", { name: /tiny_repo/ });
  await expect(card).toContainText("A tiny demo project that checks passwords.");
  await expect(card).toContainText("ready");
  await expect(page.getByText("40%", { exact: true })).toBeVisible();
  await expect(page.getByText("Repository not found")).toBeVisible();
  await expect(page.getByRole("link", { name: /psf\/requests/ })).toHaveCount(0);
});

test("ask → cited answer → code viewer", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByPlaceholder("Ask about this repo…").fill("How are passwords hashed?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  await page.getByRole("button", { name: "1", exact: true }).click();
  await expect(page.locator(".hl").first()).toBeVisible();
  await expect(page.getByText("auth.py", { exact: true })).toBeVisible();
  // Focus moves into the panel; Escape closes it and returns focus to the citation that opened it.
  const close = page.getByRole("button", { name: "Close viewer" });
  await expect(close).toBeFocused();
  // Focusing Close while the panel slides in from off-screen must not scroll the page sideways.
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1", exact: true })).toBeFocused();
});

test("no token: Home lists the repo and Chat answers, and no token header is sent", async ({ page }) => {
  const sent: (string | undefined)[] = [];
  page.on("request", (r) => void (r.url().startsWith("http://localhost:8001") && sent.push(r.headers()["x-gitguru-token"])));
  await page.goto("/"); // nothing saved: the default API URL, no token
  expect(await page.evaluate(() => localStorage.getItem("gitguru.token"))).toBeNull();
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByPlaceholder("Ask about this repo…").fill("How are passwords hashed?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /token/i })).toHaveCount(0); // (Next's route announcer is an alert too)
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((t) => t === undefined)).toBe(true);
});

test("settings: the owner token is optional and only for deleting", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByLabel("Owner token (optional)")).toHaveAccessibleDescription("Only needed to delete repos and to skip the daily limits.");
});

test("settings: Test connection says whether the token is the owner's", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("API URL").fill("http://localhost:8001");
  const test = page.getByRole("button", { name: "Test connection" });
  const status = page.getByRole("status").filter({ hasText: /^Connected/ });
  await test.click();
  await expect(status).toHaveText("Connected");
  await page.getByLabel("Owner token (optional)").fill("e2e-token");
  await test.click();
  await expect(status).toHaveText("Connected as the owner.");
  await page.getByLabel("Owner token (optional)").fill("wrong");
  await test.click();
  await expect(status).toHaveText("Connected. This token is not the owner token, so you are a guest.");
});

test("chat starter button submits its question", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByRole("button", { name: "What does this project do?" }).click();
  await expect(page.getByText("What does this project do?")).toBeVisible();
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  await expect(page.getByText("Not sure where to start?")).toHaveCount(0);
});

// The fake LLM cannot build an overview (GET /diagram would be 503), so the page's data is mocked.
const OVERVIEW = {
  mermaid: "",
  overview: {
    summary: "A tiny demo project that checks passwords.",
    flow_mermaid: 'graph TD\n s0["Read"] --> s1["Answer"]',
    how_it_works: [{ label: "Read", detail: "It reads the password." }],
    parts: [{ name: "Auth", path: "auth.py", what: "Hashes passwords." }],
    glossary: [{ term: "Hash", meaning: "A one-way scramble." }],
  },
};

test("diagram tab shows the overview sections and the empty-graph note", async ({ page }) => {
  await page.route("**/repos/*/diagram", (route) => route.fulfill({ json: OVERVIEW }));
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByRole("link", { name: "Diagram", exact: true }).click();
  for (const h of ["What it does", "How it works", "The main parts", "Key words"]) {
    await expect(page.getByRole("heading", { name: h })).toBeVisible();
  }
  await expect(page.getByText("A tiny demo project that checks passwords.")).toBeVisible();
  await expect(page.getByText("No internal imports found")).toBeVisible();

  // The "How it works" diagram is zoomable: starts at Fit, Zoom in raises the percentage, Fit brings it back.
  const percent = page.getByTestId("zoom-percent");
  await expect(page.getByRole("img", { name: "How it works diagram" }).locator("svg")).toBeVisible();
  const svg = page.getByRole("img", { name: "How it works diagram" }).locator("svg");
  const width = async () => parseFloat((await svg.getAttribute("width")) ?? "0");
  const start = await percent.innerText();
  const startWidth = await width();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(async () => parseInt(await percent.innerText())).toBeGreaterThan(parseInt(start));
  expect(await width()).toBeGreaterThan(startWidth);
  await page.getByRole("button", { name: "Fit" }).click();
  await expect(percent).toHaveText(start);
  expect(await width()).toBeCloseTo(startWidth, 1);
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Full screen" })).toBeVisible();

  // The flow animates: marching dashes on the edge, steps lighting up, a travelling dot (SMIL).
  await expect(svg.locator(".diagram-flow")).toHaveCount(1);
  await expect(svg.locator(".diagram-step")).toHaveCount(2);
  await expect(svg.locator("animateMotion")).toHaveCount(1);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the diagram has no animation at all", async ({ page }) => {
    await page.route("**/repos/*/diagram", (route) => route.fulfill({ json: OVERVIEW }));
    await saveSettings(page);
    await page.goto("/");
    await page.getByRole("link", { name: /tiny_repo/ }).click();
    await page.getByRole("link", { name: "Diagram", exact: true }).click();
    const svg = page.getByRole("img", { name: "How it works diagram" }).locator("svg");
    await expect(svg.locator("path.flowchart-link")).toHaveCount(1); // rendered
    await expect(svg.locator("animateMotion")).toHaveCount(0);
    await expect(svg.locator(".diagram-flow, .diagram-step, .diagram-dot")).toHaveCount(0);
  });
});

test("quality tab shows the empty state and the run button", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByRole("link", { name: "Quality", exact: true }).click();
  await expect(page.getByText("No eval runs yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run eval" })).toBeVisible();
});
