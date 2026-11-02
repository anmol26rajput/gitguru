import { expect, test, type Page } from "@playwright/test";

const CORS = { "access-control-allow-origin": "*" };
const BANNER = "Waking up the server… the free tier sleeps when idle, this can take a minute.";

// A sleeping free-tier server: /health is held until the test releases it, so there is no timing window. The banner
// shows after 3 s and goes away on the answer; the page itself is never blocked. Every other spec has a fast
// /health, so the banner never shows there.
async function holdHealth(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route("**/health", async (route) => {
    await released;
    await route.fulfill({ json: { ok: true, owner: false }, headers: CORS }).catch(() => {}); // page may be gone
  });
  return release;
}

for (const path of ["/", "/?embed=1"]) {
  test(`waking banner shows while /health is slow, then hides (${path})`, async ({ page }) => {
    const release = await holdHealth(page);
    await page.goto(path);
    await expect(page.getByLabel("GitHub URL")).toBeVisible(); // not blocked
    await expect(page.getByRole("status")).toHaveText(BANNER, { timeout: 10_000 });
    release();
    await expect(page.getByRole("status")).toHaveText("");
  });
}

test("Home reloads its repos once the sleeping server wakes", async ({ page }) => {
  const release = await holdHealth(page);
  let awake = false;
  await page.route("**/repos", (route) => (awake ? route.continue() : route.abort()));
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "Cannot reach the API" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(BANNER, { timeout: 10_000 });
  awake = true;
  release();
  await expect(page.getByRole("link", { name: /tiny_repo/ })).toBeVisible(); // no reload
  await expect(page.getByRole("alert").filter({ hasText: "Cannot reach the API" })).toHaveCount(0);
});

test("no banner when /health answers quickly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("GitHub URL")).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.getByRole("status")).toHaveText("");
});
