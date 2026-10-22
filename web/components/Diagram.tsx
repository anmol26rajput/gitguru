"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { SafeMarkdown } from "@/lib/markdown";
import ErrorBox, { fail, type Failure } from "./ErrorBox";

type Data = { mermaid: string; tour_md: string };
let renderCount = 0; // mermaid needs a unique element id per render

export default function Diagram({ repoId }: { repoId: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const graph = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stale = false;
    api(`/repos/${repoId}/diagram`)
      .then((r) => r.json())
      .then((d: Data) => !stale && setData(d))
      .catch((e) => !stale && setError(fail(e)));
    return () => {
      stale = true;
    };
  }, [repoId]);

  const code = data?.mermaid;
  useEffect(() => {
    if (!code) return;
    let stale = false;
    (async () => {
      try {
        const m = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await m.render(`repo-diagram-${++renderCount}`, code);
        if (!stale && graph.current) graph.current.innerHTML = svg; // svg is sanitized by mermaid's strict mode
      } catch (e) {
        if (!stale) setError(fail(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [code]);

  return (
    <main className="mx-auto w-full min-w-0 flex-1 space-y-6 p-6 md:max-w-4xl">
      {error && <ErrorBox error={error} />}
      {!data && !error && <p className="text-sm text-foreground/70">Building the diagram and tour… (the first time takes a few seconds)</p>}
      {data && (
        <>
          {code ? (
            <div ref={graph} aria-label="Module dependency diagram" className="overflow-x-auto rounded border border-foreground/20 p-4" />
          ) : (
            <p className="text-sm text-foreground/70">No internal imports found — the tour below still describes the repo.</p>
          )}
          <div className="space-y-2 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
            <SafeMarkdown>{data.tour_md}</SafeMarkdown>
          </div>
        </>
      )}
    </main>
  );
}
