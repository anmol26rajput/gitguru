import { repoFromUrl } from "./lib/github.js";

const DEFAULT_URL = "http://localhost:3000";
const MAX_TEXT = 200000; // the web app's limits: text 200,000, title 300, url 2000
const MAX_TITLE = 300;
const MAX_URL = 2000;
const READY_TIMEOUT = 15000;
const $ = (id) => document.getElementById(id);
const frame = $("app");
const msg = $("msg");
const repoBtn = $("repo");
const pageBtn = $("page");

let origin = DEFAULT_URL; // the web app's origin: the only one we post to or accept ready from
let lastUrl = ""; // the active tab's URL as last seen ("" while Chrome hides it)
const NEED_ACCESS = "GitGuru needs permission to read this page. You can also click the GitGuru toolbar icon on the page.";
const NO_READ =
  "Couldn't read this tab. Browser pages like chrome:// can't be read; on a normal page, allow access or click the GitGuru toolbar icon.";
let declined = false; // the user refused the host-access prompt this session
let waiting = null; // { page, armed, timer }: a page to send once the reloaded app says it is ready

function say(text, isError = false) {
  msg.textContent = text;
  msg.classList.toggle("err", isError);
}

async function loadOrigin() {
  const { webUrl } = await chrome.storage.sync.get({ webUrl: DEFAULT_URL });
  try {
    const u = new URL(webUrl);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
  } catch {}
  return DEFAULT_URL;
}

function open(query = "") {
  frame.src = `${origin}/?embed=1${query}`;
}

// Pages we can never script: browser pages, other schemes, the Web Store.
function unreadable(url) {
  if (!/^https?:\/\//i.test(url)) return true;
  const u = new URL(url);
  return u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Without the tabs permission the URL can be missing; then we offer the page button and find out on click.
async function refresh() {
  const url = (lastUrl = (await activeTab())?.url ?? "");
  const repo = repoFromUrl(url);
  const blocked = url !== "" && unreadable(url);
  repoBtn.hidden = !repo;
  pageBtn.hidden = !!repo || blocked;
  if (!waiting) say(blocked ? "GitGuru can't read this kind of page." : "");
}

// Optional host access. Asked on a click (so Chrome shows its own prompt); request() resolves true without a
// prompt when access is already granted. With it, tab URLs are visible. Declining is fine: the toolbar-icon
// (activeTab) grant still lets us read a page. One refusal is remembered until access is added.
async function ask() {
  if (declined) return false;
  const ok = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
  if (!ok) declined = true;
  return ok;
}

repoBtn.addEventListener("click", async () => {
  repoBtn.disabled = true;
  try {
    try {
      await ask(); // not needed to index a repo by URL; asked so tab switches show the right button
    } catch (err) {
      console.warn("GitGuru: permission request failed", err); // the repo opens anyway: no page access needed
    }
    const repo = repoFromUrl((await activeTab())?.url ?? "");
    if (!repo) return refresh();
    cancelWaiting();
    say("");
    open(`&source=${encodeURIComponent(repo)}`);
  } finally {
    repoBtn.disabled = false;
  }
});

// A tab URL the web app will accept: up to 2000 chars, else origin + path, else nothing.
function shortUrl(href) {
  if (href.length <= MAX_URL) return href;
  const u = new URL(href);
  const bare = u.origin + u.pathname;
  return bare.length <= MAX_URL ? bare : null;
}

function cancelWaiting() {
  clearTimeout(waiting?.timer);
  waiting = null;
}

// Reload the app, and only listen for its "ready" once the NEW document has loaded (then ping it): a ready from
// the dying document is ignored. The page is sent once, on the first ready after arming; later ones are ignored.
function sendWhenReady(page) {
  cancelWaiting();
  const mine = { page, armed: false, timer: 0 };
  const giveUp = () => {
    if (waiting !== mine) return;
    waiting = null;
    say(`The GitGuru app didn't answer. Is it running at ${origin}?`, true);
  };
  mine.timer = setTimeout(giveUp, 3 * READY_TIMEOUT); // the load itself never finished
  waiting = mine;
  frame.addEventListener(
    "load",
    () => {
      if (waiting !== mine) return;
      mine.armed = true;
      clearTimeout(mine.timer);
      mine.timer = setTimeout(giveUp, READY_TIMEOUT);
      // Ask the new document directly: its own once-per-load ready may have fired before this load event.
      frame.contentWindow.postMessage({ type: "gitguru:ping" }, origin);
    },
    { once: true },
  );
  open(); // a fresh load, so the app says "ready" once
}

pageBtn.addEventListener("click", async () => {
  pageBtn.disabled = true;
  try {
    let granted = false;
    let failed = false;
    try {
      granted = await ask();
    } catch (err) {
      console.warn("GitGuru: permission request failed", err);
      failed = true;
      say(NEED_ACCESS, true);
    }
    const tab = await activeTab();
    if (!tab?.id) return;
    if (!failed) say("Reading the page…");
    let r;
    try {
      [{ result: r }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (max) => ({ href: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, max) }),
        args: [MAX_TEXT],
      });
    } catch {
      if (!tab.url) return say(NO_READ, true); // URL hidden from us: could be a browser page
      return say(granted ? "Couldn't read this tab." : NEED_ACCESS, true);
    }
    if (!r) return say("Couldn't read this tab.", true);
    if (unreadable(r.href)) return say("GitGuru can't read this kind of page.", true);
    const repo = repoFromUrl(r.href); // the tab URL was hidden from us, but this one is a repo: index the repo
    if (repo) {
      cancelWaiting();
      say("");
      return open(`&source=${encodeURIComponent(repo)}`);
    }
    if (!r.text.trim()) return say("This page has no readable text.", true);
    const url = shortUrl(r.href);
    if (!url) return say("This page's address is too long for GitGuru.", true);
    sendWhenReady({ url, title: (r.title || new URL(url).hostname).slice(0, MAX_TITLE), text: r.text.slice(0, MAX_TEXT) });
    say("Sending the page to GitGuru…");
  } finally {
    pageBtn.disabled = false;
  }
});

window.addEventListener("message", (e) => {
  if (!waiting?.armed || e.origin !== origin || e.source !== frame.contentWindow) return;
  if (e.data?.type !== "gitguru:ready") return;
  const { page, timer } = waiting;
  clearTimeout(timer);
  waiting = null;
  say("");
  frame.contentWindow.postMessage({ type: "gitguru:page", url: page.url, title: page.title, text: page.text }, origin);
});

$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.tabs.onActivated.addListener(refresh);
chrome.permissions.onAdded.addListener(() => {
  declined = false;
  refresh();
});
chrome.permissions.onRemoved.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === "complete")) refresh();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.webUrl) init();
});

async function init() {
  origin = await loadOrigin();
  cancelWaiting();
  open();
  refresh();
}
init();
