"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useVoice } from "@/lib/useVoice";
import CodeViewer from "./CodeViewer";
import ErrorBox, { fail, type Failure } from "./ErrorBox";

type Step = { path: string; start_line: number; end_line: number; narration: string };

const button = "rounded border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/10 disabled:opacity-50";

export default function Walkthrough({ repoId }: { repoId: number }) {
  const { canSpeak, speak, cancel } = useVoice();
  const [topic, setTopic] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
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

  // Speak the current step. The cleanup cancels, so every step change / pause / unmount stops the old voice first.
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
    return cancel;
  }, [steps, i, last, paused, canSpeak, speak, cancel]);

  const go = (n: number) => {
    setFinished(false);
    setI(n);
  };
  const step = steps?.[i];

  return (
    <div className="flex min-h-0 flex-1">
      <main className="mx-auto flex min-w-0 flex-1 flex-col gap-4 p-6 md:max-w-3xl">
        <h1 className="text-2xl font-bold">Walkthrough</h1>
        {error && <ErrorBox error={error} />}
        {!steps || !step ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!loading) void start();
            }}
            className="flex gap-2"
          >
            <input
              aria-label="Topic"
              placeholder="Topic (optional), e.g. how login works"
              value={topic}
              maxLength={200}
              disabled={loading}
              onChange={(e) => setTopic(e.target.value)}
              className="flex-1 rounded border border-foreground/20 bg-transparent px-3 py-2 text-sm"
            />
            <button type="submit" disabled={loading} className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50">
              Start walkthrough
            </button>
          </form>
        ) : (
          <>
            <p className="text-sm text-foreground/70">
              Step {i + 1} of {steps.length}
              {finished && " — tour finished"}
            </p>
            <p aria-live="polite" className="text-base leading-relaxed">{step.narration}</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => go(i - 1)} disabled={i === 0} className={button}>Back</button>
              {canSpeak && (
                <button
                  onClick={() => {
                    setFinished(false);
                    setError(null);
                    setPaused(!paused);
                  }}
                  className={button}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
              )}
              <button onClick={() => go(i + 1)} disabled={i === last} className={button}>Next</button>
              <button onClick={() => setSteps(null)} className={`${button} ml-auto`}>New walkthrough</button>
            </div>
          </>
        )}
        {loading && <p className="text-sm text-foreground/70">Building the walkthrough… (a few seconds)</p>}
      </main>
      {step && (
        <CodeViewer
          key={`${i}:${step.path}:${step.start_line}-${step.end_line}`}
          repoId={repoId}
          path={step.path}
          startLine={step.start_line}
          endLine={step.end_line}
          onClose={() => setSteps(null)}
        />
      )}
    </div>
  );
}
