"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { countRuns } from "@/lib/evalRuns";
import { readSSE } from "@/lib/sse";
import ErrorBox, { fail, type Failure } from "./ErrorBox";
import { Key, Sheet } from "./ui";

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
    setProgress({ pct: 0, message: "Starting…" });
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
  // The chat searches by meaning (vector) over whole functions and classes (ast): the headline reports that setting.
  const chat = rows.find((r) => r.strategy === "ast" && r.mode === "vector");
  const total = countRuns(runs ?? []);
  const busy = progress !== null;

  return (
    <main className="mx-auto w-full max-w-[760px] min-w-0 flex-1 space-y-6 px-6 pt-6 pb-12">
      {error && <ErrorBox error={error} />}

      {/* The verdict first, on a sheet card. */}
      <Sheet>
        <h2 className="section-label">Latest result</h2>
        {runs === null ? (
          <p className="mt-2 text-muted">{error ? "Couldn't load the results." : "Loading…"}</p>
        ) : runs.length === 0 ? (
          <p className="mt-2 text-muted">No eval runs yet.</p>
        ) : (
          <>
            {chat && (
              <p className="mt-2 text-[17px] leading-snug font-[650]">
                With the search the chat uses, GitGuru found the right code for {Math.round(chat.hit_at_5 * chat.n)} of{" "}
                {chat.n} test questions.
              </p>
            )}
            <p className="mt-2 text-[13px] text-muted">
              Last run {new Date(runs[0].created_at).toLocaleString()} · {runs[0].n} questions · {total}{" "}
              {total === 1 ? "run" : "runs"} in total
            </p>
          </>
        )}
      </Sheet>

      <p className="leading-relaxed">
        This page checks how good GitGuru is at finding the right code. We ask it test questions whose answers we
        already know, and count how often the right code appears in its top 5 results. You don&apos;t need this to
        use GitGuru — it&apos;s proof that answers come from real code.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Key onClick={() => void start()} disabled={busy}>
          Run eval
        </Key>
        <p className="text-muted">Generates ~50 questions with the LLM the first time; takes a few minutes.</p>
      </div>

      {progress && (
        <div className="space-y-1" role="status">
          <div className="h-1.5 rounded-full bg-border">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, progress.pct)}%` }} />
          </div>
          <p className="text-muted">{progress.pct}% - {progress.message}</p>
        </div>
      )}

      {runs && runs.length > 0 && (
        <details className="space-y-3">
          <summary className="cursor-pointer rounded-md font-medium">Show the detailed numbers</summary>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-2 font-medium">Strategy</th>
                  <th className="p-2 font-medium">Mode</th>
                  <th className="p-2 font-medium">Hit@5</th>
                  <th className="p-2 font-medium">MRR@10</th>
                  <th className="p-2 text-right font-medium">p50 ms</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[13px]">
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="p-2">{r.strategy}</td>
                    <td className="p-2">{r.mode}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 rounded-full bg-border" aria-hidden>
                          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, r.hit_at_5 * 100)}%` }} />
                        </div>
                        <span>{r.hit_at_5.toFixed(2)}</span>
                        {r === best && <span className="rounded-full bg-accent-soft px-1.5 font-sans text-xs font-[650] text-accent-text">best</span>}
                      </div>
                    </td>
                    <td className="p-2">{r.mrr_at_10.toFixed(2)}</td>
                    <td className="p-2 text-right">{Math.round(r.p50_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1">
            <p className="font-medium">What these columns mean</p>
            <ul className="ml-5 list-disc space-y-1 text-muted">
              <li><b>Hit@5</b>: how often the right code was in the top 5 results (1.00 means every time).</li>
              <li><b>MRR@10</b>: how close to the top the right code was. Closer to 1.00 is better.</li>
              <li><b>p50 ms</b>: the typical time to search, in thousandths of a second. Smaller is faster.</li>
              <li><b>keyword</b>: matches exact words. <b>vector</b>: matches meaning. <b>hybrid</b>: both together. <b>rerank</b>: hybrid, then a second look to put the best result first.</li>
              <li><b>AST</b>: the code was cut into pieces along its natural structure (functions, classes). <b>line</b>: cut into fixed blocks of lines.</li>
            </ul>
          </div>
        </details>
      )}
    </main>
  );
}
