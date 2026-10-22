"use client";

import { useEffect, useRef, useState } from "react";
import { codeToHtml, type BundledLanguage, type ShikiTransformer } from "shiki";
import { api, ApiError } from "@/lib/api";

type Props = { repoId: number; path: string; startLine: number; endLine: number; onClose: () => void };
type File = { path: string; lang: string | null; content: string };

// Render with the highlighted range; retry as plain text if Shiki doesn't know the language.
async function highlight(file: File, startLine: number, endLine: number): Promise<string> {
  const highlightRange: ShikiTransformer = {
    // regular function: Shiki binds `this` to its transformer context
    line(node, line) {
      if (line >= startLine && line <= endLine) this.addClassToHast(node, "hl");
    },
  };
  const options = (lang: string) => ({ lang: lang as BundledLanguage, theme: "github-dark", transformers: [highlightRange] });
  try {
    return await codeToHtml(file.content, options(file.lang ?? "text"));
  } catch {
    return await codeToHtml(file.content, options("text"));
  }
}

// Parent passes a `key` of path+range, so state starts fresh for each opened citation.
export default function CodeViewer({ repoId, path, startLine, endLine, onClose }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await api(`/repos/${repoId}/file?path=${encodeURIComponent(path)}`);
      const out = await highlight(await res.json(), startLine, endLine);
      if (!cancelled) setHtml(out);
    })().catch((e) => {
      if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, path, startLine, endLine]);

  useEffect(() => {
    body.current?.querySelector(".hl")?.scrollIntoView({ block: "center" });
  }, [html]);

  return (
    <aside className="fixed inset-0 z-10 flex flex-col bg-background md:sticky md:top-0 md:z-auto md:h-screen md:w-1/2 md:self-start md:border-l md:border-foreground/20">
      <header className="flex items-center gap-3 border-b border-foreground/20 p-3 text-sm">
        <span className="font-mono font-medium">{path}</span>
        <span className="text-foreground/60">{startLine}-{endLine}</span>
        <button onClick={onClose} aria-label="Close viewer" className="ml-auto rounded border border-foreground/20 px-2 py-0.5">
          Close
        </button>
      </header>
      <div ref={body} className="viewer flex-1 overflow-auto text-xs">
        {error ? (
          <p role="alert" className="p-3 text-red-600">{error}</p>
        ) : html === null ? (
          <p className="p-3 text-foreground/60">Loading...</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </aside>
  );
}
