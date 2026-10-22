import { expect, test, type Page } from "@playwright/test";
import { saveSettings } from "./helpers";

type Utt = { text: string; onend: (() => void) | null };
type VoiceWindow = Window & { __spoken: string[]; __endDelay: number; __utterances: Utt[]; __synthError?: string };

// Stand-ins for the Web Speech API (headless Chromium has no microphone or voice), installed before the page loads.
// Recognition "hears" a scripted sentence; synthesis records what it was asked to say.
async function installVoice(page: Page, recError?: string, synthError?: string) {
  await page.addInitScript(([err, synthErr]) => {
    const w = window as unknown as VoiceWindow & Record<string, unknown>;
    w.__spoken = [];
    w.__endDelay = 50;
    w.__synthError = synthErr; // when set, speak() fails with this SpeechSynthesisErrorEvent code instead of ending
    w.__utterances = []; // every utterance, so a test can fire a stale `end` by hand

    class Recognition {
      lang = "";
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      start() {
        setTimeout(() => {
          if (err) this.onerror?.({ error: err });
          else this.onresult?.({ results: [[{ transcript: "How are passwords hashed?" }]] });
          this.onend?.();
        }, 20);
      }
      stop() {}
      abort() {}
    }
    w.SpeechRecognition = Recognition;
    w.webkitSpeechRecognition = Recognition;

    class Utterance {
      lang = "";
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    w.SpeechSynthesisUtterance = Utterance;

    // "<overlap>" is recorded when speak() starts while another utterance is still active: two voices at once.
    let active: { u: Utterance; timer: number } | null = null;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak(u: Utterance) {
          if (active) w.__spoken.push("<overlap>");
          w.__spoken.push(u.text);
          w.__utterances.push(u);
          const timer = window.setTimeout(() => {
            active = null;
            if (w.__synthError) u.onerror?.({ error: w.__synthError });
            else u.onend?.();
          }, w.__endDelay);
          active = { u, timer };
        },
        cancel() {
          w.__spoken.push("<cancel>");
          if (active) clearTimeout(active.timer);
          active = null;
        },
        getVoices: () => [],
      },
    });
  }, [recError, synthError] as const);
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as VoiceWindow).__spoken);
const narrations = async (page: Page) => (await spoken(page)).filter((s) => s !== "<cancel>");

async function openRepo(page: Page, tab?: string) {
  await saveSettings(page);
  await page.goto("/");
  await page.getByRole("link", { name: /tiny_repo/ }).click();
  if (tab) await page.getByRole("link", { name: tab, exact: true }).click();
}

test("mic: the spoken question is submitted and answered", async ({ page }) => {
  await installVoice(page);
  await openRepo(page);
  await page.getByRole("button", { name: "Speak your question" }).click();
  await expect(page.getByText("How are passwords hashed?")).toBeVisible();
  await expect(page.getByText("Fake answer citing")).toBeVisible();
});

test("mic: a blocked microphone shows the permission message", async ({ page }) => {
  await installVoice(page, "not-allowed");
  await openRepo(page);
  await page.getByRole("button", { name: "Speak your question" }).click();
  await expect(page.getByText("Microphone access was blocked")).toBeVisible();
});

test("read aloud speaks the answer without citation markers", async ({ page }) => {
  await installVoice(page);
  await openRepo(page);
  await page.getByPlaceholder("Ask about this repo…").fill("How are passwords hashed?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  await page.getByRole("button", { name: "Read aloud" }).click();
  await expect.poll(async () => (await narrations(page)).length).toBe(1);
  expect(await spoken(page)).not.toContain("<overlap>");
  const [text] = await narrations(page);
  expect(text).toContain("Fake answer citing");
  expect(text).not.toContain("[1]");
});

const STEPS = [
  { path: "auth.py", start_line: 1, end_line: 10, narration: "First, passwords are hashed here." },
  { path: "retry.py", start_line: 1, end_line: 10, narration: "Then retries back off." },
  { path: "auth.py", start_line: 11, end_line: 20, narration: "Finally the check happens." },
];

async function mockWalkthrough(page: Page) {
  await page.route("**/walkthrough", (route) => route.fulfill({ json: { steps: STEPS } }));
}

test("walkthrough: steps auto-advance and each narration is spoken once, in order", async ({ page }) => {
  await installVoice(page);
  await mockWalkthrough(page);
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.getByText(/Step 3 of 3 — tour finished/)).toBeVisible();
  expect(await narrations(page)).toEqual(STEPS.map((s) => s.narration));
  expect(await spoken(page)).not.toContain("<overlap>");
});

test("walkthrough: Next stops the old voice first, and a stale end from a cancelled utterance does not advance the player", async ({ page }) => {
  await installVoice(page);
  await mockWalkthrough(page);
  await openRepo(page, "Walkthrough");
  // No utterance ever ends by itself: this test fires `end` by hand, so there is no timing race.
  await page.evaluate(() => ((window as unknown as VoiceWindow).__endDelay = 60_000));
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect.poll(() => narrations(page)).toEqual([STEPS[0].narration]);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => narrations(page)).toHaveLength(2);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // Step 1 is current again with a NEW utterance (#3); utterance #1 was cancelled long ago.
  await expect.poll(() => narrations(page)).toHaveLength(3);
  await expect(page.getByText(/^Step 1 of 3/)).toBeVisible();
  // Collapse repeated "<cancel>" (effect cleanup + speak both cancel): every speak() is preceded by a cancel.
  const sequence = (await spoken(page)).filter((t, k, a) => !(t === "<cancel>" && a[k - 1] === "<cancel>"));
  expect(sequence).toEqual([
    "<cancel>", STEPS[0].narration, "<cancel>", STEPS[1].narration, "<cancel>", STEPS[0].narration,
  ]);
  // The stale utterance #1 reports `end` late: an unguarded player would jump to step 2.
  await page.evaluate(() => (window as unknown as VoiceWindow).__utterances[0].onend?.());
  await expect(page.getByText(/^Step 1 of 3/)).toBeVisible();
  await page.waitForTimeout(200); // let a wrongly scheduled React update flush before checking again
  await expect(page.getByText(/^Step 1 of 3/)).toBeVisible();
  expect(await spoken(page)).not.toContain("<overlap>");
  expect(await narrations(page)).toHaveLength(3);
});

test("walkthrough: a speech error pauses the player on the same step and says so", async ({ page }) => {
  await installVoice(page, undefined, "synthesis-failed");
  await mockWalkthrough(page);
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.getByText(/Couldn't play the narration/)).toBeVisible();
  await page.waitForTimeout(300); // an error treated as "end" would have finished the tour by now
  await expect(page.getByText(/^Step 1 of 3/)).toBeVisible();
  await expect(page.getByText(/tour finished/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
});

test("read aloud: a speech error puts the button back to Read aloud", async ({ page }) => {
  await installVoice(page, undefined, "synthesis-failed");
  await openRepo(page);
  await page.getByPlaceholder("Ask about this repo…").fill("How are passwords hashed?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Fake answer citing")).toBeVisible();
  await page.getByRole("button", { name: "Read aloud" }).click();
  await expect.poll(async () => (await narrations(page)).length).toBe(1);
  await expect(page.getByRole("button", { name: "Read aloud" })).toBeVisible();
});
