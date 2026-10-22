"use client";

import { useEffect, useRef, useState } from "react";
import { api, type Repo, type Source, type Turn } from "@/lib/api";
import { linkCitations } from "@/lib/citations";
import { readSSE } from "@/lib/sse";
import { SafeLink, SafeMarkdown } from "@/lib/markdown";
import { useVoice } from "@/lib/useVoice";
import CodeViewer from "./CodeViewer";
import ErrorBox, { fail, type Failure } from "./ErrorBox";

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  provider?: string | null;
  error?: Failure;
};

function Answer({ m, onOpen, reading, onRead }: { m: Message; onOpen: (s: Source) => void; reading: boolean; onRead?: () => void }) {
  const sources = m.sources ?? [];
  return (
    <div className="space-y-2">
      <div className="space-y-2 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/10 [&_pre]:p-2">
        <SafeMarkdown
          components={{
            a: ({ href, children }) => {
              const n = href?.startsWith("#cite-") ? Number(href.slice(6)) : NaN;
              if (Number.isNaN(n)) return <SafeLink href={href}>{children}</SafeLink>;
              const source = sources.find((s) => s.n === n);
              if (!source) return <span>{n}</span>;
              return (
                <button
                  onClick={() => onOpen(source)}
                  className="mx-0.5 rounded bg-foreground/10 px-1.5 text-xs font-medium hover:bg-foreground/20"
                >
                  {n}
                </button>
              );
            },
          }}
        >
          {linkCitations(m.content)}
        </SafeMarkdown>
      </div>
      {sources.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {sources.map((s) => (
            <li key={s.n}>
              <button onClick={() => onOpen(s)} className="font-mono text-foreground/70 hover:underline">
                {s.path}:{s.start_line}-{s.end_line}
              </button>
            </li>
          ))}
        </ul>
      )}
      {m.provider && <span className="inline-block rounded bg-foreground/10 px-2 py-0.5 text-xs">{m.provider}</span>}
      {onRead && (
        <button
          onClick={onRead}
          aria-label={reading ? "Stop reading" : "Read aloud"}
          className="ml-2 rounded border border-foreground/20 px-2 py-0.5 text-xs hover:bg-foreground/10"
        >
          {reading ? "Stop" : "Read aloud"}
        </button>
      )}
      {m.error && <ErrorBox error={m.error} />}
    </div>
  );
}

export default function Chat({ repoId }: { repoId: number }) {
  const [repo, setRepo] = useState<Repo | null>(null);
  const [loadError, setLoadError] = useState<Failure | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [viewing, setViewing] = useState<Source | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const voice = useVoice();
  const end = useRef<HTMLDivElement>(null);
  const busy = useRef(false); // guards against a second ask (e.g. a stale voice callback) mid-stream

  useEffect(() => {
    api(`/repos/${repoId}`).then((r) => r.json()).then(setRepo).catch((e) => setLoadError(fail(e)));
  }, [repoId]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  // Patch the live (last) message.
  const patch = (fn: (m: Message) => Message) =>
    setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

  async function ask(q: string) {
    if (busy.current) return;
    busy.current = true;
    const history: Turn[] = messages
      .filter((m) => m.content && !m.error)
      .slice(-6)
      .map(({ role, content }) => ({ role, content: content.slice(0, 4000) })); // API caps history content at 4,000
    voice.cancel();
    setReading(null);
    setMessages((ms) => [...ms, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setQuestion("");
    setStreaming(true);
    let finished = false;
    try {
      const res = await api(`/repos/${repoId}/ask`, { method: "POST", body: JSON.stringify({ question: q, history }) });
      await readSSE(res, ({ event, data }) => {
        if (event === "sources") patch((m) => ({ ...m, sources: data as Source[] }));
        else if (event === "token") patch((m) => ({ ...m, content: m.content + (data as string) }));
        else if (event === "done") {
          finished = true;
          patch((m) => ({ ...m, provider: (data as { provider: string | null }).provider }));
        } else if (event === "error") {
          finished = true;
          patch((m) => ({ ...m, error: { message: (data as { message?: string }).message ?? "Something went wrong." } }));
        }
      });
      if (!finished) patch((m) => ({ ...m, error: { message: "Connection closed before the answer finished." } }));
    } catch (e) {
      patch((m) => ({ ...m, error: fail(e) }));
    } finally {
      busy.current = false;
      setStreaming(false);
    }
  }

  function toggleRead(i: number, text: string) {
    if (reading === i) {
      voice.cancel();
      setReading(null);
    } else {
      setReading(i);
      voice.speak(text, () => setReading(null), () => setReading(null));
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <main className="mx-auto flex min-w-0 flex-1 flex-col p-6 md:max-w-3xl">
        <h1 className="mb-4 text-2xl font-bold">{repo?.title ?? "Repo"}</h1>
        {loadError && <ErrorBox error={loadError} />}
        <div className="flex-1 space-y-4">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <p key={i} className="ml-auto w-fit max-w-[80%] rounded bg-foreground/10 px-3 py-2 text-sm">{m.content}</p>
            ) : (
              <Answer
                key={i}
                m={m}
                onOpen={setViewing}
                reading={reading === i}
                onRead={voice.canSpeak && m.content && !m.error && !(streaming && i === messages.length - 1) ? () => toggleRead(i, m.content) : undefined}
              />
            ),
          )}
          <div ref={end} />
        </div>
        {voice.error && <ErrorBox error={{ message: voice.error }} />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim() && !streaming) void ask(question.trim());
          }}
          className="sticky bottom-0 mt-4 flex gap-2 bg-background pt-2"
        >
          <input
            aria-label="Question"
            placeholder="Ask about this repo…"
            value={question}
            maxLength={1000}
            disabled={streaming || voice.listening}
            onChange={(e) => setQuestion(e.target.value)}
            className="flex-1 rounded border border-foreground/20 bg-transparent px-3 py-2 text-sm"
          />
          {voice.canListen && (
            <button
              type="button"
              onClick={() => (voice.listening ? voice.stop() : voice.listen((t) => void ask(t.slice(0, 1000))))}
              disabled={streaming}
              aria-label={voice.listening ? "Stop listening" : "Speak your question"}
              aria-pressed={voice.listening}
              className="rounded border border-foreground/20 px-3 py-2 text-sm disabled:opacity-50 aria-pressed:bg-foreground aria-pressed:text-background"
            >
              {voice.listening ? "Listening…" : "Mic"}
            </button>
          )}
          <button
            type="submit"
            disabled={streaming || voice.listening || !question.trim()}
            className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
          >
            Ask
          </button>
        </form>
      </main>
      {viewing && (
        <CodeViewer
          key={`${viewing.path}:${viewing.start_line}-${viewing.end_line}`}
          repoId={repoId}
          path={viewing.path}
          startLine={viewing.start_line}
          endLine={viewing.end_line}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
