import { execFileSync } from "node:child_process";

const env = { ...process.env, DATABASE_URL: "postgresql://localhost:5433/gitguru_test" };

// Empty the e2e DB first (pytest shares it and can leave eval rows behind), then index the tiny
// fixture repo from disk so the tests never touch GitHub.
export default function globalSetup() {
  execFileSync(
    "uv",
    [
      "run",
      "python",
      "-c",
      "from gitguru.db import connect\n"
        + "with connect() as c: c.execute('TRUNCATE repos, jobs RESTART IDENTITY CASCADE')",
    ],
    { cwd: "../backend", env, stdio: "inherit" },
  );
  execFileSync("uv", ["run", "gitguru", "index", "tests/fixtures/tiny_repo"], { cwd: "../backend", env, stdio: "inherit" });
}
