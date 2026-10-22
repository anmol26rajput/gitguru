import { expect, test, type Page, type Route } from "@playwright/test";
import { saveSettings } from "./helpers";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

type Utt = { text: string; onend: (() => void) | null };
type VoiceWindow = Window & {
  __spoken: string[];
  __endDelay: number;
  __utterances: Utt[];
  __synthError?: string;
  __played: number;
  __audio: object | null; // the FakeAudio that is playing right now, if any
};

// Stand-ins for the Web Speech API (headless Chromium has no microphone or voice), installed before the page loads.
// Recognition "hears" a scripted sentence; synthesis records what it was asked to say.
// POST /tts is refused (503) so these tests exercise the browser-voice fallback; the audio test overrides the route.
async function installVoice(page: Page, recError?: string, synthError?: string) {
  await page.route("**/tts", (route) => route.fulfill({ status: 503, headers: CORS, body: "no voice" }));
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

    // "<overlap>" is recorded when speak() starts while another utterance (or server audio) is still active: two
    // voices at once.
    let active: { u: Utterance; timer: number } | null = null;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak(u: Utterance) {
          if (active || w.__audio) w.__spoken.push("<overlap>");
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

// The stub MP3 is not decodable (a real <audio> would fire `error`), so Audio is replaced by a player that records
// play() and reports `ended` a moment later: the exact surface useVoice touches.
async function installAudio(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as VoiceWindow;
    w.__played = 0;
    w.__audio = null;
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play() {
        w.__played++;
        w.__audio = this;
        setTimeout(() => {
          if (w.__audio === this) w.__audio = null;
          this.onended?.();
        }, 30);
        return Promise.resolve();
      }
      pause() {
        if (w.__audio === this) w.__audio = null;
      }
      removeAttribute() {}
    }
    (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  });
}

// A tiny MP3 body for /tts (the CORS preflight gets these headers too).
const MP3 = { status: 200, headers: { ...CORS, "content-type": "audio/mpeg" }, body: Buffer.from([0xff, 0xfb, 0x90, 0x00]) };

const played = (page: Page) => page.evaluate(() => (window as unknown as VoiceWindow).__played);
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

test("walkthrough: with the server voice, every narration plays as audio and the browser voice stays silent", async ({ page }) => {
  await installVoice(page);
  await installAudio(page);
  await mockWalkthrough(page);
  // Later routes win. The next step's narration is also prefetched, so a text may be posted twice.
  const posted = new Set<string>();
  await page.route("**/tts", (route) => {
    if (route.request().method() === "POST") posted.add(route.request().postDataJSON().text);
    return route.fulfill(MP3);
  });
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.getByText(/Step 3 of 3 — tour finished/)).toBeVisible();
  expect(posted).toEqual(new Set(STEPS.map((s) => s.narration)));
  expect(await played(page)).toBe(STEPS.length);
  expect(await narrations(page)).toEqual([]); // speechSynthesis.speak was never called
  expect(await spoken(page)).not.toContain("<overlap>");
});

const step = (narration: string) => ({ path: "auth.py", start_line: 1, end_line: 10, narration });

test("server voice: piece 1 plays as audio, piece 2's /tts fails, and the browser voice reads the rest exactly once", async ({ page }) => {
  // The first piece is the first sentence or two (at most 150 chars), so audio starts soon; the rest is piece 2.
  const piece1 = "First, the app reads the settings file and checks every value. Then it opens a connection to the database so later steps can store results.";
  const rest = "After that, a worker picks up each job in turn and reports progress on the screen.";
  await installVoice(page);
  await installAudio(page);
  await page.route("**/walkthrough", (route) => route.fulfill({ json: { steps: [step(`${piece1} ${rest}`)] } }));
  await page.route("**/tts", (route) => {
    const ok = route.request().method() !== "POST" || route.request().postDataJSON().text === piece1;
    return route.fulfill(ok ? MP3 : { status: 503, headers: CORS, body: "no voice" });
  });
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.getByText(/Step 1 of 1 — tour finished/)).toBeVisible();
  expect(await played(page)).toBe(1);
  expect(await narrations(page)).toEqual([rest]);
  expect(await spoken(page)).not.toContain("<overlap>");
});

test("server voice: Next while /tts is still pending, then the late reply arrives: the old step never plays", async ({ page }) => {
  await installVoice(page);
  await installAudio(page);
  await mockWalkthrough(page);
  const held: Route[] = [];
  let heldNow!: () => void;
  const isHeld = new Promise<void>((resolve) => (heldNow = resolve));
  await page.route("**/tts", (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.postDataJSON().text === STEPS[0].narration) {
      held.push(route); // step 1's voice never arrives in time
      heldNow();
      return;
    }
    return route.fulfill(MP3);
  });
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await isHeld;
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/Step 3 of 3 — tour finished/)).toBeVisible();
  for (const r of held) await r.fulfill(MP3).catch(() => {}); // the late reply (the page may have aborted it already)
  await page.waitForTimeout(300);
  expect(await played(page)).toBe(2); // steps 2 and 3 only
  expect(await narrations(page)).toEqual([]);
  expect(await spoken(page)).not.toContain("<overlap>");
  await expect(page.getByText(/Step 3 of 3 — tour finished/)).toBeVisible();
});

test("browser voice: a long narration is read as several short utterances and still advances", async ({ page }) => {
  // Chrome's Google voices stop after ~15 s and never fire `end`; short utterances keep each one well inside that.
  const long = Array.from({ length: 6 }, (_, k) => `Part ${k + 1} of the flow hands its result to the next part, which checks it carefully.`).join(" ");
  await installVoice(page);
  await page.route("**/walkthrough", (route) => route.fulfill({ json: { steps: [step(long), STEPS[1]] } }));
  await openRepo(page, "Walkthrough");
  await page.getByRole("button", { name: "Start walkthrough" }).click();
  await expect(page.getByText(/Step 2 of 2 — tour finished/)).toBeVisible();
  const said = await narrations(page);
  const parts = said.slice(0, -1);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((t) => t.length <= 180)).toBe(true);
  expect(parts.join(" ")).toBe(long);
  expect(said.at(-1)).toBe(STEPS[1].narration);
  expect(await spoken(page)).not.toContain("<overlap>");
});
