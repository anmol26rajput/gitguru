"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { codeToHtml, type BundledLanguage, type ShikiTransformer } from "shiki";
import { api, ApiError } from "@/lib/api";
import { Key } from "./ui";

type Props = { repoId: number; path: string; startLine: number; endLine: number; onClose?: () => void; autoFocus?: boolean };
type File = { path: string; lang: string | null; content: string };

// Render with the highlighted range; retry as plain text if Shiki doesn't know the language.
async function highlight(file: File, startLine: number, endLine: number, dark: boolean): Promise<string> {
  const highlightRange: ShikiTransformer = {
    // regular function: Shiki binds `this` to its transformer context
    line(node, line) {
      if (line >= startLine && line <= endLine) this.addClassToHast(node, "hl");
    },
  };
  const options = (lang: string) => ({ lang: lang as BundledLanguage, theme: dark ? "github-dark" : "github-light", transformers: [highlightRange] });
  try {
    return await codeToHtml(file.content, options(file.lang ?? "text"));
  } catch {
    return await codeToHtml(file.content, options("text"));
  }
}

// Follow the OS colour scheme (server snapshot: light; the code is highlighted client-side anyway).
const DARK = "(prefers-color-scheme: dark)";
const subscribeScheme = (onChange: () => void) => {
  const mq = matchMedia(DARK);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const isDark = () => matchMedia(DARK).matches;

// Parent passes a `key` of path+range, so state starts fresh for each opened citation.
export default function CodeViewer({ repoId, path, startLine, endLine, onClose, autoFocus }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const dark = useSyncExternalStore(subscribeScheme, isDark, () => false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api(`/repos/${repoId}/file?path=${encodeURIComponent(path)}`);
      const out = await highlight(await res.json(), startLine, endLine, dark);
      if (!cancelled) setHtml(out);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, path, startLine, endLine, dark]);

  // Centre the cited lines inside the pane only (scrollIntoView would scroll the page too).
  useEffect(() => {
    const pane = body.current;
    const hl = pane?.querySelector<HTMLElement>(".hl");
    if (pane && hl) pane.scrollTop = hl.offsetTop - (pane.clientHeight - hl.offsetHeight) / 2;
  }, [html]);

  return (
    // Fills its parent; the parent places it (Chat: the sliding .code-panel; Walkthrough: its left column). No onClose, no Close.
    <aside className="flex h-full min-h-0 w-full flex-col bg-bg-subtle">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="min-w-0 truncate font-mono font-[650]">{path}</span>
        <span className="shrink-0 font-mono text-xs text-muted">{startLine}-{endLine}</span>
        {onClose && (
          <Key variant="ghost" size="sm" onClick={onClose} autoFocus={autoFocus} aria-label="Close viewer" className="ml-auto shrink-0">
            Close
          </Key>
        )}
      </header>
      <div ref={body} className="viewer relative min-h-0 flex-1 overflow-auto text-xs">
        {error ? (
          <p role="alert" className="p-4 text-danger-text">{error}</p>
        ) : html === null ? (
          <p className="p-4 text-muted">Loading…</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </aside>
  );
}
