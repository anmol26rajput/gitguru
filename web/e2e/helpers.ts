import type { Page } from "@playwright/test";

export async function saveSettings(page: Page) {
  await page.goto("/settings");
  await page.getByLabel("API URL").fill("http://localhost:8001");
  await page.getByLabel("Token").fill("e2e-token");
  await page.getByRole("button", { name: "Save" }).click();
}
