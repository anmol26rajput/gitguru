"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Repo } from "@/lib/api";
import { readSSE } from "@/lib/sse";

const BADGE: Record<Repo["status"], string> = {
  pending: "bg-gray-100 text-gray-700",
  indexing: "bg-blue-100 text-blue-800",
  ready: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

type Failure = { status?: number; message: string };
type Progress = { pct: number; message: string };

export default function RepoList() {
  const source = useSearchParams().get("source") ?? "";
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [url, setUrl] = useState(source);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const autoStarted = useRef(false);

  const fail = useCallback(
    (e: unknown) =>
      setError(e instanceof ApiError ? { status: e.status, message: e.message } : { message: String(e) }),
    [],
  );

  const load = useCallback(
    () => api("/repos").then((r) => r.json()).then(setRepos).catch(fail),
    [fail],
  );

  const add = useCallback(async (src: string) => {
    setError(null);
    setProgress({ pct: 0, message: "Starting..." });
    let outcome: "done" | "error" | null = null;
    try {
      const post = await api("/repos", { method: "POST", body: JSON.stringify({ source: src }) });
      const { job_id } = await post.json();
      await readSSE(await api(`/jobs/${job_id}/events`), ({ event, data }) => {
        const d = data as { pct?: number; message?: string };
        if (event === "progress") setProgress({ pct: d.pct ?? 0, message: d.message ?? "" });
        else if (event === "done") outcome = "done";
        else if (event === "error") {
          outcome = "error";
          setError({ message: d.message ?? "Indexing failed." });
        }
      });
      if (outcome === "done") setUrl("");
      else if (!outcome) setError({ message: "Connection closed before indexing finished." });
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      await load();
    }
  }, [load, fail]);

  useEffect(() => {
    void load();
    // ?source= (share target / extension): index it once, even under StrictMode's double effect.
    if (source && !autoStarted.current) {
      autoStarted.current = true;
      void add(source);
    }
  }, [load, add, source]);

  const busy = progress !== null;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Repos</h1>

      {error && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error.message}{" "}
          {error.status === 401 && (
            <Link href="/settings" className="font-medium underline">Open Settings</Link>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && !busy) void add(url.trim());
        }}
        className="flex gap-2"
      >
        <input
          aria-label="GitHub URL"
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        >
          Add repo
        </button>
      </form>

      {progress && (
        <div className="space-y-1" role="status">
          <div className="h-2 overflow-hidden rounded bg-foreground/10">
            <div className="h-full bg-foreground transition-all" style={{ width: `${Math.min(100, progress.pct)}%` }} />
          </div>
          <p className="text-sm text-gray-600">{progress.pct}% - {progress.message}</p>
        </div>
      )}

      {repos === null ? (
        !error && <p className="text-sm text-gray-500">Loading...</p>
      ) : repos.length === 0 ? (
        <p className="text-sm text-gray-500">No repos yet. Add a GitHub URL above.</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200">
          {repos.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-3 text-sm">
              {r.status === "ready" ? (
                <Link href={`/r/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
              ) : (
                <span className="font-medium">{r.title}</span>
              )}
              <span className={`rounded px-2 py-0.5 text-xs ${BADGE[r.status]}`}>{r.status}</span>
              {typeof r.stats.chunks === "number" && (
                <span className="ml-auto text-gray-500">{r.stats.chunks} chunks</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
