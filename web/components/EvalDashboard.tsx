"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { countRuns } from "@/lib/evalRuns";
import { readSSE } from "@/lib/sse";
import ErrorBox, { fail, type Failure } from "./ErrorBox";

type Run = {
  id: number;
  mode: string;
  strategy: string;
  n: number;
  hit_at_5: number;
  mrr_at_10: number;
  p50_ms: number;
  created_at: string;
};
type Progress = { pct: number; message: string };

const STRATEGIES = ["ast", "line"];
const MODES = ["keyword", "vector", "hybrid", "hybrid_rerank"];

export default function EvalDashboard({ repoId }: { repoId: number }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<Failure | null>(null);

  const load = useCallback(
    () =>
      api(`/repos/${repoId}/evals`)
        .then((r) => r.json())
        .then(setRuns)
        .catch((e) => setError(fail(e))),
    [repoId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    setError(null);
    setProgress({ pct: 0, message: "Starting..." });
    let outcome: "done" | "error" | null = null;
    try {
      const post = await api(`/repos/${repoId}/evals`, { method: "POST", body: "{}" });
      const { job_id } = await post.json();
      await readSSE(await api(`/jobs/${job_id}/events`), ({ event, data }) => {
        const d = data as { pct?: number; message?: string };
        if (event === "progress") setProgress({ pct: d.pct ?? 0, message: d.message ?? "" });
        else if (event === "done") outcome = "done";
        else if (event === "error") {
          outcome = "error";
          setError({ message: d.message ?? "Eval failed." });
        }
      });
      if (!outcome) setError({ message: "Connection closed before the eval finished." });
    } catch (e) {
      setError(fail(e));
    } finally {
      setProgress(null);
      await load();
    }
  }

  // Rows arrive newest first, so the first row seen per (strategy, mode) is its latest.
  const latest = (runs ?? []).filter(
    (r, i, all) => all.findIndex((x) => x.strategy === r.strategy && x.mode === r.mode) === i,
  );
  const rows = STRATEGIES.flatMap((s) =>
    MODES.flatMap((m) => latest.filter((r) => r.strategy === s && r.mode === m)),
  );
  const best = rows.reduce<Run | null>(
    (b, r) => (!b || r.hit_at_5 > b.hit_at_5 || (r.hit_at_5 === b.hit_at_5 && r.mrr_at_10 > b.mrr_at_10) ? r : b),
    null,
  );
  const total = countRuns(runs ?? []);
  const busy = progress !== null;

  return (
    <main className="mx-auto w-full min-w-0 flex-1 space-y-6 p-6 md:max-w-4xl">
      {error && <ErrorBox error={error} />}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void start()}
          disabled={busy}
          className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        >
          Run eval
        </button>
        <p className="text-sm text-foreground/70">
          Generates ~50 questions with the LLM the first time; takes a few minutes.
        </p>
      </div>

      {progress && (
        <div className="space-y-1" role="status">
          <div className="h-2 overflow-hidden rounded bg-foreground/10">
            <div className="h-full bg-foreground transition-all" style={{ width: `${Math.min(100, progress.pct)}%` }} />
          </div>
          <p className="text-sm text-foreground/70">{progress.pct}% - {progress.message}</p>
        </div>
      )}

      {runs === null ? (
        !error && <p className="text-sm text-foreground/70">Loading...</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-foreground/70">No eval runs yet.</p>
      ) : (
        <>
          <p className="text-sm text-foreground/70">
            Last run {new Date(runs[0].created_at).toLocaleString()} · {runs[0].n} questions · {total}{" "}
            {total === 1 ? "run" : "runs"} in total
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-foreground/20">
                  <th className="p-2 font-medium">Strategy</th>
                  <th className="p-2 font-medium">Mode</th>
                  <th className="p-2 font-medium">Hit@5</th>
                  <th className="p-2 font-medium">MRR@10</th>
                  <th className="p-2 text-right font-medium">p50 ms</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-foreground/10">
                    <td className="p-2">{r.strategy}</td>
                    <td className="p-2">{r.mode}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded bg-foreground/10" aria-hidden>
                          <div className="h-full bg-foreground" style={{ width: `${Math.min(100, r.hit_at_5 * 100)}%` }} />
                        </div>
                        <span>{r.hit_at_5.toFixed(2)}</span>
                        {r === best && <span className="rounded border border-foreground/40 px-1.5 text-xs font-medium">best</span>}
                      </div>
                    </td>
                    <td className="p-2">{r.mrr_at_10.toFixed(2)}</td>
                    <td className="p-2 text-right">{Math.round(r.p50_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
