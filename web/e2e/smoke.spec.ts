import { expect, test } from "@playwright/test";
import { saveSettings } from "./helpers";

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
});

test("no token shows the settings hint", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /settings/i }).last()).toBeVisible();
  await expect(page.getByText("Check your API URL and token in Settings.")).toBeVisible();
});

test("diagram tab shows the empty-graph note and the tour", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByRole("link", { name: "Diagram", exact: true }).click();
  await expect(page.getByText("No internal imports found")).toBeVisible();
  await expect(page.getByText("Fake answer citing")).toBeVisible();
});

test("eval tab shows the empty state and the run button", async ({ page }) => {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  await page.getByRole("link", { name: "Eval", exact: true }).click();
  await expect(page.getByText("No eval runs yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run eval" })).toBeVisible();
});
