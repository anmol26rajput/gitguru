import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { saveSettings } from "./helpers";

// Phone layout (< 900px) with the iPhone 13 profile (390 x 664, touch, mobile viewport). Its default browser is WebKit,
// which the e2e suite does not install, so it runs in Chromium like the rest.
test.use({ ...devices["iPhone 13"], defaultBrowserType: "chromium" });

// No sideways page scroll: the page is never wider than the screen.
async function expectNoSideScroll(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
}

// Nothing inside `el` runs wider than `el` (Chat clips the page sideways, so the page check alone would miss it).
// Overflow inside a scrolling child (code lines, the tab strip, a diagram pane) stays in that child and doesn't count.
async function expectNoOverflow(el: Locator) {
  await expect.poll(() => el.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
}

async function openChat(page: Page) {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).tap();
  await expect(page.getByPlaceholder("Ask about this repo…")).toBeVisible();
}

async function askAndOpenSource(page: Page) {
  await openChat(page);
  await page.getByPlaceholder("Ask about this repo…").fill("How are passwords hashed?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  const chip = page.getByRole("button", { name: /^Source 1: / });
  await chip.tap();
  await expect(page.locator(".hl").first()).toBeVisible();
  return chip;
}

test("phone: Home renders without sideways scroll", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Understand any codebase." })).toBeVisible();
  await expect(page.getByRole("link", { name: /tiny_repo/ })).toBeVisible();
  await expectNoSideScroll(page);
});

test("phone: a source opens as a bottom sheet over the lower part of the screen", async ({ page }) => {
  await askAndOpenSource(page);
  const vp = page.viewportSize()!;
  const viewer = page.getByRole("complementary");
  // Reaches the bottom edge once the 200ms slide-up has finished.
  await expect.poll(async () => {
    const b = await viewer.boundingBox();
    return b ? Math.abs(b.y + b.height - vp.height) : Infinity;
  }).toBeLessThanOrEqual(1);
  const { x, y, width, height } = (await viewer.boundingBox())!;
  expect(x).toBeLessThanOrEqual(1);
  expect(width).toBeGreaterThanOrEqual(vp.width - 2); // full width
  expect(y).toBeGreaterThan(vp.height * 0.2); // the top of the page still shows above it
  expect(height).toBeGreaterThan(vp.height * 0.6);
  await expect(page.getByRole("button", { name: "Close viewer" })).toBeInViewport({ ratio: 1 });
  // Everything behind the sheet is inert, the question box included.
  await expect.poll(() => page.getByPlaceholder("Ask about this repo…").evaluate((e) => !!e.closest("[inert]"))).toBe(true);
  await expectNoSideScroll(page);
  await expectNoOverflow(page.locator("main"));
  await expectNoOverflow(viewer);
});

test("phone: Close returns focus to the source that opened the sheet", async ({ page }) => {
  const chip = await askAndOpenSource(page);
  const close = page.getByRole("button", { name: "Close viewer" });
  await expect(close).toBeFocused();
  await close.tap();
  await expect(close).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expectNoSideScroll(page);
  await expectNoOverflow(page.locator("main"));
});

// An answer with two citations side by side, "[1][2]" (the ask stream is mocked).
const SSE = [
  ["sources", [
    { n: 1, path: "auth.py", start_line: 8, end_line: 10, symbol: null },
    { n: 2, path: "retry.py", start_line: 1, end_line: 5, symbol: null },
  ]],
  ["token", "Passwords are hashed in one place[1][2] and checked again at login, which keeps the stored value safe."],
  ["done", { provider: "fake" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

test("phone: side-by-side citation chips are 44px wide and each tap opens its own source", async ({ page }) => {
  await page.route("**/repos/*/ask", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: SSE }));
  await openChat(page);
  await page.getByPlaceholder("Ask about this repo…").fill("Where are passwords hashed?");
  await page.keyboard.press("Enter");
  const one = page.getByRole("button", { name: "1", exact: true });
  const two = page.getByRole("button", { name: "2", exact: true });
  await expect(two).toBeVisible();
  const a = (await one.boundingBox())!;
  const b = (await two.boundingBox())!;
  expect(a.width).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(a.x + a.width).toBeLessThan(b.x); // real space between them
  // Left half, centre and right edge of chip 1 all open source 1; the left edge of chip 2 opens source 2.
  const taps: [number, string][] = [
    [a.x + a.width * 0.25, "auth.py"],
    [a.x + a.width / 2, "auth.py"],
    [a.x + a.width - 2, "auth.py"],
    [b.x + 2, "retry.py"],
  ];
  for (const [x, path] of taps) {
    await page.touchscreen.tap(x, a.y + a.height / 2);
    await expect(page.getByText(path, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close viewer" })).toHaveCount(0);
  }
  await expectNoOverflow(page.locator("main"));
});

const STEPS = [
  { path: "auth.py", start_line: 1, end_line: 10, narration: "First, passwords are hashed here. ".repeat(30) },
  { path: "retry.py", start_line: 1, end_line: 10, narration: "Then retries back off." },
  { path: "auth.py", start_line: 11, end_line: 20, narration: "Finally the check happens." },
];

test("phone: the walkthrough controls stay inside the screen", async ({ page }) => {
  // A voice that never finishes, so the player stays on step 1 with Pause showing.
  await page.route("**/tts", (route) => route.fulfill({ status: 503, body: "no voice" }));
  await page.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak() {}, cancel() {}, pause() {}, resume() {}, getVoices: () => [] },
    });
  });
  await page.route("**/walkthrough", (route) => route.fulfill({ json: { steps: STEPS } }));
  await openChat(page);
  await page.getByRole("link", { name: "Walkthrough", exact: true }).tap();
  await page.getByRole("button", { name: "Start walkthrough" }).tap();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  for (const scroll of ["top", "bottom"] as const) {
    await page.evaluate((s) => window.scrollTo(0, s === "top" ? 0 : document.documentElement.scrollHeight), scroll);
    for (const name of ["Back", "Pause", "Next"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
  }
  await expectNoSideScroll(page);
});

test.describe("375px wide", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("phone: the finished walkthrough still fits the width", async ({ page }) => {
    // A voice that finishes at once, so the tour plays through to "Step 3 of 3 — tour finished".
    await page.route("**/tts", (route) => route.fulfill({ status: 503, body: "no voice" }));
    await page.addInitScript(() => {
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          speak(u: { onend?: (() => void) | null }) {
            setTimeout(() => u.onend?.(), 20);
          },
          cancel() {}, pause() {}, resume() {}, getVoices: () => [],
        },
      });
    });
    await page.route("**/walkthrough", (route) => route.fulfill({ json: { steps: STEPS } }));
    await openChat(page);
    await page.getByRole("link", { name: "Walkthrough", exact: true }).tap();
    await page.getByRole("button", { name: "Start walkthrough" }).tap();
    await expect(page.getByText("Step 3 of 3 — tour finished")).toBeVisible();
    const explanation = page.getByRole("region", { name: "Explanation" });
    await expectNoOverflow(explanation);
    // The label wraps instead of squeezing the progress bar away (it fits only by a hair in Chromium's font metrics).
    const bar = (await explanation.locator('div[aria-hidden="true"]').first().boundingBox())!;
    expect(bar.width).toBeGreaterThanOrEqual(40);
    await expectNoOverflow(page.locator("main"));
    await expectNoSideScroll(page);
  });
});

// The fake LLM cannot build an overview, so the Diagram data is mocked (as in smoke.spec.ts).
// The module graph is wide (one module imports eight others, drawn top-down), so on a phone it starts at 50%, above Fit.
const MODULES = ["auth", "retry", "session", "storage", "server", "router", "config", "cache"];
const OVERVIEW = {
  mermaid: `graph TD\n${MODULES.map((m, i) => ` app --> m${i}["${m}.py"]`).join("\n")}\n${MODULES.map((m, i) => ` m${i} --> util["util.py"]`).join("\n")}`,
  overview: {
    summary: "A tiny demo project that checks passwords.",
    flow_mermaid: 'graph LR\n s0["Read the password"] --> s1["Hash it"] --> s2["Compare"] --> s3["Answer"]',
    how_it_works: [{ label: "Read", detail: "It reads the password." }],
    parts: [{ name: "Auth", path: "src/very/long/path/to/the/authentication/module/auth.py", what: "Hashes passwords." }],
    glossary: [{ term: "Hash", meaning: "A one-way scramble." }],
  },
};

test("phone: Diagram, Quality and Settings fit the width, with 44px zoom keys", async ({ page }) => {
  await page.route("**/repos/*/diagram", (route) => route.fulfill({ json: OVERVIEW }));
  await openChat(page);
  await page.getByRole("link", { name: "Diagram", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Zoom in" }).first()).toBeVisible();
  const zoom = await page.getByRole("button", { name: "Zoom in" }).first().boundingBox();
  expect(Math.min(zoom!.width, zoom!.height)).toBeGreaterThanOrEqual(44);
  // The flow is drawn top-down on a phone (taller than wide), though its source says LR.
  const flow = page.getByRole("img", { name: "How it works diagram" }).locator("svg");
  await expect(flow).toBeVisible();
  const f = (await flow.boundingBox())!;
  expect(f.height).toBeGreaterThan(f.width);
  // The module graph starts at no less than 50% and scrolls sideways inside its own pane, never the page.
  const modules = page.getByRole("group", { name: "Module dependency diagram viewer" });
  await expect(modules.getByTestId("zoom-percent")).toHaveText("50%");
  const pane = modules.locator("[tabindex='0']");
  expect(await pane.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await expectNoOverflow(page.locator("main"));
  await expectNoSideScroll(page);
  await page.getByRole("link", { name: "Quality", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Run eval" })).toBeVisible();
  await expectNoSideScroll(page);
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Test connection" })).toBeVisible();
  await expectNoSideScroll(page);
});
