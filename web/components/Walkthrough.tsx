"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useVoice } from "@/lib/useVoice";
import CodeViewer from "./CodeViewer";
import ErrorBox, { fail, type Failure } from "./ErrorBox";
import { Key } from "./ui";

type Step = { path: string; start_line: number; end_line: number; narration: string };

export default function Walkthrough({ repoId }: { repoId: number }) {
  const { canSpeak, speak, prefetch, cancel } = useVoice();
  const [topic, setTopic] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const cap = useRef<HTMLParagraphElement>(null);
  const token = useRef(0); // bumped for every utterance; a late `end` from an old one carries a stale token

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const res = await api(`/repos/${repoId}/walkthrough`, {
        method: "POST",
        body: JSON.stringify(topic.trim() ? { topic: topic.trim() } : {}),
      });
      const data: { steps: Step[] } = await res.json();
      setI(0);
      setPaused(false);
      setFinished(false);
      setSteps(data.steps);
    } catch (e) {
      setError(fail(e));
    } finally {
      setLoading(false);
    }
  }

  const last = steps ? steps.length - 1 : 0;

  // Speak the current step and warm the server voice for the next one, so it starts without a wait.
  // The cleanup cancels, so every step change / pause / unmount stops the old voice (and the prefetch) first.
  useEffect(() => {
    if (!steps || !canSpeak || paused) return;
    const mine = ++token.current;
    speak(steps[i].narration, () => {
      if (token.current !== mine) return;
      if (i < last) setI(i + 1);
      else setFinished(true);
    }, () => {
      if (token.current !== mine) return;
      setPaused(true);
      setError({ message: "Couldn't play the narration — read the captions and use Next/Back, or press Resume." });
    });
    if (i < last) prefetch(steps[i + 1].narration); // after speak(), which would abort it
    return cancel;
  }, [steps, i, last, paused, canSpeak, speak, prefetch, cancel]);

  useEffect(() => {
    cap.current?.scrollTo(0, 0);
  }, [i]); // a new step starts at the top of its caption

  const go = (n: number) => {
    setFinished(false);
    setI(n);
  };
  const step = steps?.[i];

  if (!steps || !step)
    return (
      <main className="mx-auto w-full max-w-[720px] min-w-0 flex-1 space-y-4 px-6 pt-6 pb-12">
        <div>
          <h1 className="text-[20px] leading-snug font-[650] tracking-[-0.01em]">Walkthrough</h1>
          <p className="mt-1 text-muted">A guided tour: GitGuru picks the important code and explains it step by step.</p>
        </div>
        {error && <ErrorBox error={error} />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading) void start();
          }}
          className="flex items-center gap-2 rounded-card border border-border bg-surface py-1.5 pr-1.5 pl-3.5 shadow-[var(--shadow-ghost)]"
        >
          <input
            aria-label="Topic"
            placeholder="Topic (optional), e.g. how login works"
            value={topic}
            maxLength={200}
            disabled={loading}
            onChange={(e) => setTopic(e.target.value)}
            className="min-w-0 flex-1 rounded-md bg-transparent py-1.5 placeholder:text-muted disabled:opacity-60"
          />
          <Key type="submit" disabled={loading}>Start walkthrough</Key>
        </form>
        {loading && <p className="text-muted">Building the walkthrough… (a few seconds)</p>}
      </main>
    );

  // Player: code left, explanation right from 900px; stacked (code on top) when narrow. The code pane is part of
  // the layout, not an overlay, so it never covers the controls and has no Close that would end the tour.
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col min-[900px]:flex-row">
      <h1 className="sr-only">Walkthrough</h1>
      <div className="h-[40dvh] shrink-0 border-b border-border min-[900px]:sticky min-[900px]:top-[var(--repo-header-h)] min-[900px]:h-[calc(100dvh-var(--repo-header-h))] min-[900px]:min-w-0 min-[900px]:flex-[1.1] min-[900px]:border-r min-[900px]:border-b-0">
        <CodeViewer
          key={`${i}:${step.path}:${step.start_line}-${step.end_line}`}
          repoId={repoId}
          path={step.path}
          startLine={step.start_line}
          endLine={step.end_line}
        />
      </div>
      <section aria-label="Explanation" className="flex min-w-0 flex-1 flex-col gap-4 px-6 pt-5 pb-8">
        <div className="flex items-center gap-3">
          <p className="shrink-0 text-[13px] text-muted">
            Step {i + 1} of {steps.length}
            {finished && " — tour finished"}
          </p>
          <div aria-hidden="true" className="h-1 flex-1 rounded-full bg-border">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${((i + 1) / steps.length) * 100}%` }} />
          </div>
        </div>
        {error && <ErrorBox error={error} />}
        <p ref={cap} tabIndex={0} aria-live="polite" className="max-h-[45vh] overflow-y-auto text-[15px] leading-relaxed">{step.narration}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Key variant="ghost" onClick={() => go(i - 1)} disabled={i === 0}>
            <span aria-hidden="true">←</span> Back
          </Key>
          {canSpeak && (
            <Key
              onClick={() => {
                setFinished(false);
                setError(null);
                setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </Key>
          )}
          <Key variant="ghost" onClick={() => go(i + 1)} disabled={i === last}>
            Next <span aria-hidden="true">→</span>
          </Key>
          <Key variant="ghost" size="sm" onClick={() => setSteps(null)} className="ml-auto">New walkthrough</Key>
        </div>
      </section>
    </main>
  );
}
