"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ErrorBox, { fail, type Failure } from "@/components/ErrorBox";
import { Key } from "@/components/ui";
import { api, type Repo } from "@/lib/api";
import { readSSE } from "@/lib/sse";

// The repo being added right now: its card shows this SSE progress instead of the list's snapshot.
type Live = { repoId: number | null; pct: number; message: string };

// Home: hero (title, URL box, tilted code window) above the repos as stacked sheet cards.
export default function RepoList() {
  const source = useSearchParams().get("source") ?? "";
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [url, setUrl] = useState(source);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const autoStarted = useRef(false);

  const load = useCallback(
    () => api("/repos").then((r) => r.json()).then(setRepos).catch((e) => setError(fail(e))),
    [],
  );

  const add = useCallback(async (src: string) => {
    setError(null);
    setLive({ repoId: null, pct: 0, message: "Starting…" });
    let outcome: "done" | "error" | null = null;
    try {
      const post = await api("/repos", { method: "POST", body: JSON.stringify({ source: src }) });
      const { repo_id, job_id } = await post.json();
      setLive({ repoId: repo_id, pct: 0, message: "Queued" });
      void load(); // the new card appears now and follows the live progress
      await readSSE(await api(`/jobs/${job_id}/events`), ({ event, data }) => {
        const d = data as { pct?: number; message?: string };
        if (event === "progress") setLive({ repoId: repo_id, pct: d.pct ?? 0, message: d.message ?? "" });
        else if (event === "done") outcome = "done";
        else if (event === "error") {
          outcome = "error";
          setError({ message: d.message ?? "Indexing failed." });
        }
      });
      if (outcome === "done") setUrl("");
      else if (!outcome) setError({ message: "Connection closed before indexing finished." });
    } catch (e) {
      setError(fail(e));
    } finally {
      await load();
      setLive(null);
    }
  }, [load]);

  useEffect(() => {
    void load();
    // ?source= (share target / extension): index it once, even under StrictMode's double effect.
    if (source && !autoStarted.current) {
      autoStarted.current = true;
      void add(source);
    }
  }, [load, add, source]);

  const busy = live !== null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-20">
      <section className="grid items-center gap-10 pt-8 pb-12 min-[900px]:grid-cols-[1.05fr_1fr] min-[900px]:gap-14 min-[900px]:pt-14 min-[900px]:pb-16">
        <div>
          <h1 className="text-[30px] leading-[1.15] font-[750] tracking-[-0.025em]">
            Understand any <br />
            codebase.
          </h1>
          <p className="mt-2.5 mb-5 text-[15px] text-muted">
            Paste a GitHub link and ask anything, <br className="max-sm:hidden" />
            in simple words or in full detail.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim() && !busy) void add(url.trim());
            }}
            className="flex items-center gap-2 rounded-card border border-border bg-surface py-1.5 pr-1.5 pl-3.5 shadow-[var(--shadow-ghost)]"
          >
            <input
              aria-label="GitHub URL"
              placeholder="github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              spellCheck={false}
              autoCapitalize="off"
              className="min-w-0 flex-1 rounded-md bg-transparent py-1.5 font-mono text-[13px] placeholder:text-muted"
            />
            <Key type="submit" disabled={busy}>Explore</Key>
          </form>
          {error && <div className="mt-4"><ErrorBox error={error} /></div>}
        </div>
        <CodeWindow />
      </section>

      {/* On a failed load the error box above says it all: no empty "Your repos" label. */}
      {(repos !== null || !error) && <section aria-labelledby="repos-heading">
        <h2 id="repos-heading" className="section-label mb-4">Your repos</h2>
        {repos === null ? (
          <p className="text-muted">Loading…</p>
        ) : repos.length === 0 ? (
          <p className="text-muted">No repos yet. Paste a GitHub link above to add the first one.</p>
        ) : (
          // gap-y leaves room for each sheet's under-sheet, which hangs ~7px below the card
          <ul className="grid grid-cols-1 gap-x-4 gap-y-6 min-[600px]:grid-cols-2 min-[900px]:grid-cols-3">
            {repos.map((r) => (
              <li key={r.id} className="grid grid-cols-1">
                <RepoCard repo={r} live={live?.repoId === r.id ? live : null} />
              </li>
            ))}
          </ul>
        )}
      </section>}
    </main>
  );
}

function RepoCard({ repo, live }: { repo: Repo; live: Live | null }) {
  const status = live ? "indexing" : repo.status;
  const files = typeof repo.stats.files === "number" ? `${repo.stats.files} ${repo.stats.files === 1 ? "file" : "files"}` : null;
  const name = <span className="min-w-0 truncate font-mono font-[650]">{repo.title}</span>;

  if (status === "ready") {
    return (
      <Link href={`/r/${repo.id}`} className="sheet">
        <span className="flex items-baseline gap-3">
          {name}
          <span className="ml-auto shrink-0 font-mono text-xs text-accent-text">
            <span aria-hidden="true">●</span> ready
          </span>
        </span>
        <span className="mt-1 block text-[13px] text-muted">{repo.summary || files}</span>
      </Link>
    );
  }

  if (status === "failed") {
    return (
      <div className="sheet">
        <div className="flex items-baseline gap-3">
          {name}
          <span className="ml-auto shrink-0 font-mono text-xs text-danger-text">failed</span>
        </div>
        <p className="mt-1 text-[13px] text-danger-text">{repo.message || "Indexing failed."}</p>
      </div>
    );
  }

  // pending / indexing
  const pct = Math.max(0, Math.min(100, live ? live.pct : (repo.progress ?? 0)));
  const message = live ? live.message : repo.message;
  return (
    <div className="sheet">
      <div className="flex items-baseline gap-3">
        {name}
        <span className="ml-auto shrink-0 font-mono text-xs text-muted tabular-nums">{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Indexing ${repo.title}`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-2.5 h-1 rounded-full bg-border"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 truncate text-[13px] text-muted">{message || "Waiting to start…"}</p>
    </div>
  );
}

// Decorative: a hand-written requests snippet, tilted in 3D. Hidden below 900px.
function CodeWindow() {
  return (
    <div aria-hidden="true" className="tilt-stage hidden min-[900px]:block">
      <div className="tilt-window">
        <div className="mb-2 flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-[var(--win-border)]" />
          <span className="size-2.5 rounded-full bg-[var(--win-border)]" />
          <span className="size-2.5 rounded-full bg-[var(--win-border)]" />
          <span className="ml-1.5 font-mono text-[11px] text-[var(--win-muted)]">sessions.py · 590</span>
        </div>
        <pre>
          <span className="tok-k">def</span> <span className="tok-f">send</span>(self, request):{"\n"}
          {"    "}adapter = self.get_adapter(request.url){"\n"}
          <span className="tilt-hl">{"    "}r = adapter.send(request)</span>
          {"    "}<span className="tok-k">return</span> r
        </pre>
        <p className="mt-2.5 border-t border-[var(--win-rule)] pt-2 text-[13px]">
          ↳ “This is where your request actually leaves the computer.”
        </p>
      </div>
    </div>
  );
}
