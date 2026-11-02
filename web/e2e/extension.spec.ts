import { chromium, expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Loads the unpacked extension (../extension) in a real Chromium and opens its side-panel page directly.
// Only the iframe's src attribute is checked, so this does not need the web app (or the backend) to be up.
// A real side panel, the toolbar click and the permission prompt cannot be driven from Playwright.
const EXTENSION = path.resolve(__dirname, "../../extension");

test("side panel page loads the app in an iframe with ?embed=1", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gitguru-ext-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, // extensions need the new headless mode, passed as an arg
    args: ["--headless=new", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 5000 }).catch(() => null));
    test.skip(!worker, "Chromium did not load the extension (no service worker within 5 s) in this environment");
    const id = new URL(worker!.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(page.locator("#app")).toHaveAttribute("src", "http://localhost:3000/?embed=1");
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
