import { defineConfig, devices } from "@playwright/test";

// Test DB is shared with pytest: never run `npm run e2e` and pytest at the same time. CI overrides it.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://localhost:5433/gitguru_test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3001" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "uv run uvicorn gitguru.api:app --port 8001",
      cwd: "../backend",
      env: { DATABASE_URL, APP_TOKEN: "e2e-token", LLM_CHAIN: "fake", CORS_ORIGINS: "http://localhost:3001" },
      url: "http://localhost:8001/health",
      reuseExistingServer: false,
    },
    {
      // CI uses a production build: `next dev` compiles each route on first visit, which outran the 5 s
      // expect timeout on cold runners (embed.spec.ts). Locally dev mode is faster to start.
      command: process.env.CI ? "npm run build && npm run start -- --port 3001" : "npm run dev -- --port 3001",
      env: { NEXT_PUBLIC_API_URL: "http://localhost:8001" },
      url: "http://localhost:3001",
      reuseExistingServer: false,
      timeout: process.env.CI ? 300_000 : 120_000,
    },
  ],
});
