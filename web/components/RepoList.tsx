"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { embedHref, useEmbed } from "@/components/Embed";
import ErrorBox, { fail, type Failure } from "@/components/ErrorBox";
import { Key, KeyLink } from "@/components/ui";
import { api, type Repo } from "@/lib/api";
import { subscribePage, takePage, type PageMessage } from "@/lib/embed";
import { readSSE } from "@/lib/sse";

// The repo being added right now: its card shows this SSE progress instead of the list's snapshot.
type Live = { repoId: number | null; pct: number; message: string };

// Home: hero (title, URL box, tilted code window) above the repos as stacked sheet cards.
// Embedded (the extension's side panel): no hero, no top Nav; a Settings link, the URL box and the repos. Whatever
// finishes indexing there (a URL, ?source=, or page text from the extension) opens its Chat.
export default function RepoList() {
  const source = useSearchParams().get("source") ?? "";
  const embed = useEmbed();
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [url, setUrl] = useState(source);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const autoStarted = useRef(false);
  const busyRef = useRef(false);
  const mounted = useRef(true); // a job that finishes after the user left Home must not pull them into its Chat
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

  const load = useCallback(
    (): Promise<Repo[] | null> =>
      api("/repos")
        .then((r) => r.json())
        .then((list: Repo[]) => {
          setRepos(list);
          return list;
        })
        .catch((e) => {
          setError(fail(e));
          return null;
        }),
    [],
  );

  // The server was asleep when the list first loaded (see Waking): now it answers, so clear the error and retry.
  useEffect(() => {
    const awake = () => {
      setError(null);
      void load();
    };
    window.addEventListener("gitguru:awake", awake);
    return () => window.removeEventListener("gitguru:awake", awake);
  }, [load]);

  // Start an index job (POST /repos or /pages), follow its progress, and in embed mode open the repo's Chat when done.
  const run = useCallback(async (path: string, body: object): Promise<boolean> => {
    if (busyRef.current) {
      setError({ message: "Still indexing another item. Try again when it finishes." });
      return false;
    }
    busyRef.current = true;
    setError(null);
    setLive({ repoId: null, pct: 0, message: "Starting…" });
    let outcome: "done" | "error" | null = null;
    let openId: number | null = null;
    try {
      const post = await api(path, { method: "POST", body: JSON.stringify(body) });
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
      if (outcome === "done") openId = repo_id;
      else if (!outcome) setError({ message: "Connection closed before indexing finished." });
    } catch (e) {
      setError(fail(e));
    } finally {
      await load();
      setLive(null);
      busyRef.current = false;
    }
    if (openId === null) return false;
    if (embed && mounted.current) router.push(embedHref(`/r/${openId}`, true));
    return true;
  }, [load, embed, router]);

  const add = useCallback(async (src: string) => {
    if (await run("/repos", { source: src })) setUrl("");
  }, [run]);

  const addPage = useCallback((p: PageMessage) => void run("/pages", p), [run]);

  useEffect(() => {
    const loaded = load();
    // ?source= (the extension's repo button): in embed mode only, once even under StrictMode's double effect. A repo
    // that is already ready opens its Chat without a job (jobs count toward the daily cap). Outside embed the
    // URL box is only pre-filled.
    if (!source || !embed || autoStarted.current) return;
    autoStarted.current = true;
    void loaded.then((list) => {
      const ready = list?.find((r) => r.source === source && r.status === "ready");
      if (!ready) void add(source);
      else if (mounted.current) router.push(embedHref(`/r/${ready.id}`, true));
    });
  }, [load, add, source, embed, router]);

  // Page text from the extension (see components/Embed.tsx): take what is waiting, and anything that arrives later.
  useEffect(() => {
    if (!embed) return;
    const take = () => {
      const p = takePage();
      if (p) addPage(p);
    };
    take();
    return subscribePage(take);
  }, [embed, addPage]);

  const busy = live !== null;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-20">
      {embed && (
        <div className="flex justify-end pt-2">
          <KeyLink href={embedHref("/settings", true)} variant="ghost" size="sm">Settings</KeyLink>
        </div>
      )}
      <section className={embed ? "pt-2 pb-6" : "grid items-center gap-10 pt-8 pb-12 min-[900px]:grid-cols-[1.05fr_1fr] min-[900px]:gap-14 min-[900px]:pt-14 min-[900px]:pb-16"}>
        <div>
          {!embed && <>
          <h1 className="text-[30px] leading-[1.15] font-[750] tracking-[-0.025em]">
            Understand any <br />
            codebase.
          </h1>
          <p className="mt-2.5 mb-5 text-[15px] text-muted">
            Paste a GitHub link and ask anything, <br className="max-sm:hidden" />
            in simple words or in full detail.
          </p>
          </>}
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
        {!embed && <CodeWindow />}
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
          <ul className={embed ? "grid grid-cols-1 gap-y-6" : "grid grid-cols-1 gap-x-4 gap-y-6 min-[600px]:grid-cols-2 min-[900px]:grid-cols-3"}>
            {repos.map((r) => (
              <li key={r.id} className="grid grid-cols-1">
                <RepoCard repo={r} live={live?.repoId === r.id ? live : null} embed={embed} />
              </li>
            ))}
          </ul>
        )}
      </section>}
    </main>
  );
}

function RepoCard({ repo, live, embed }: { repo: Repo; live: Live | null; embed: boolean }) {
  const status = live ? "indexing" : repo.status;
  const files = typeof repo.stats.files === "number" ? `${repo.stats.files} ${repo.stats.files === 1 ? "file" : "files"}` : null;
  const name = <span className="min-w-0 truncate font-mono font-[650]">{repo.title}</span>;

  if (status === "ready") {
    return (
      <Link href={embedHref(`/r/${repo.id}`, embed)} className="sheet">
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
