# GitGuru Chrome extension

A side panel that shows the GitGuru web app next to the page you are reading. No build step, no dependencies.

## Load it

1. Start GitGuru: the backend on :8000 and the web app on :3000 (`next dev`).
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Pin GitGuru from the puzzle-piece menu. Clicking its icon opens the side panel.

## Try it

- **A repo.** Go to `https://github.com/psf/requests`, open the panel, click **Ask about this repo**. It indexes the repo, then opens Chat.
- **A docs page.** Go to `https://docs.python.org/3/tutorial/`, open the panel, click **Ask about this page**. It reads the page text, indexes it, then opens Chat. Answers cite the page text.
- **Settings.** You do not need a token to use the panel. The panel has its own storage, so if you are the owner, open Settings inside the panel and enter your owner token there. It is only for deleting repos and skipping the daily limits.
- **Another app address.** The panel's **Options** button sets the web app URL (default `http://localhost:3000`).

## Notes

- Chrome never lets an extension read its own browser pages (`chrome://...`) or the Chrome Web Store, and `file://` pages are blocked unless you allow it for the extension. On those, GitGuru shows a short message instead of a button, or says it couldn't read the tab.
- Chrome may ask once for permission to read web pages. That is so GitGuru can read the page you ask about and show the right button when you switch tabs. It only reads a page when you click "Ask about this page".
- If you say no, it still works: click the GitGuru icon in the toolbar while that tab is in front, then try again.
- Voice input may be blocked inside a side panel. Typing always works.
- Tests: `node --test extension/lib/github.test.js`.
