const DEFAULT_URL = "http://localhost:3000";
const input = document.getElementById("url");
const status = document.getElementById("status");

function say(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("err", isError);
}

chrome.storage.sync.get({ webUrl: DEFAULT_URL }).then(({ webUrl }) => (input.value = webUrl));

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let u;
  try {
    u = new URL(input.value.trim());
  } catch {}
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return say("Use an http:// or https:// address.", true);
  await chrome.storage.sync.set({ webUrl: u.origin }); // only the origin matters: that is what the panel posts to
  input.value = u.origin;
  say("Saved.");
});
