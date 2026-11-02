// Embedded mode: the Chrome extension shows this app in an iframe (/?embed=1) and posts the current page's text in.
export type PageMessage = { url: string; title: string; text: string };

export const MAX_PAGE_TEXT = 200_000;
export const MAX_TITLE = 300; // the backend's limits (AddPage): title 300, url 2000
export const MAX_URL = 2000;

// Accept only the extension's own side panel: a chrome-extension:// origin, sent by our parent window, exactly shaped.
// `parent` is injected (window.parent in the app) so this stays a pure function.
type Incoming = { origin: string; source: unknown; data: unknown };
const fromExtensionParent = (event: Incoming, parent: unknown) =>
  event.origin.startsWith("chrome-extension://") && !!parent && event.source === parent;
// Never end on half of a surrogate pair (a cut, or a sender that sent one).
const dropLoneHigh = (s: string) => {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
};

// The panel asks "are you listening?" after the iframe loads; the app answers with gitguru:ready (same checks).
export function acceptPing(event: Incoming, parent: unknown): boolean {
  if (!fromExtensionParent(event, parent)) return false;
  const d = event.data as Record<string, unknown> | null;
  return !!d && typeof d === "object" && !Array.isArray(d) && Object.keys(d).length === 1 && d.type === "gitguru:ping";
}

export function acceptPageMessage(event: Incoming, parent: unknown): PageMessage | null {
  if (!fromExtensionParent(event, parent)) return null;
  const d = event.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const keys = Object.keys(d);
  if (keys.length !== 4 || !["type", "url", "title", "text"].every((k) => keys.includes(k))) return null;
  if (d.type !== "gitguru:page" || typeof d.url !== "string" || typeof d.title !== "string" || typeof d.text !== "string") return null;
  if (d.url.length > MAX_URL) return null;
  return { url: d.url, title: dropLoneHigh(d.title.slice(0, MAX_TITLE)), text: dropLoneHigh(d.text.slice(0, MAX_PAGE_TEXT)) };
}

// A page accepted anywhere in the app waits here until the Home screen (which shows the indexing progress) takes it.
let pending: PageMessage | null = null;
const listeners = new Set<() => void>();
export function offerPage(p: PageMessage): void {
  pending = p;
  listeners.forEach((f) => f());
}
export function takePage(): PageMessage | null {
  const p = pending;
  pending = null;
  return p;
}
export function subscribePage(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
