"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Repo, type Source, type Turn } from "@/lib/api";
import { linkCitations } from "@/lib/citations";
import { readSSE } from "@/lib/sse";
import { SafeLink, SafeMarkdown } from "@/lib/markdown";
import { useVoice } from "@/lib/useVoice";
import CodeViewer from "./CodeViewer";
import ErrorBox, { fail, type Failure } from "./ErrorBox";
import { Chip, Key, Pill } from "./ui";

const STARTERS = [
  "What does this project do?",
  "How does it work, step by step?",
  "Explain it like I'm 12",
  "What are the main parts?",
  "How do I run it?",
];

// Make every element outside `el` inert (each ancestor's siblings); returns the undo.
function inertOutside(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    for (const sib of Array.from(n.parentElement?.children ?? [])) {
      if (sib !== n && sib instanceof HTMLElement && !sib.inert) {
        sib.inert = true;
        changed.push(sib);
      }
    }
  }
  return () => changed.forEach((sib) => (sib.inert = false));
}

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  provider?: string | null;
  error?: Failure;
};

const icon = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;

type OpenSource = (s: Source, opener: HTMLElement) => void;

// The markdown link renderer must be one stable component: an inline one is a new type on every render, so React
// would remount each citation button (losing the node the code panel returns focus to). It reads its answer's
// sources from context instead.
const Cites = createContext<{ sources: Source[]; onOpen: OpenSource }>({ sources: [], onOpen: () => {} });

function CiteLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { sources, onOpen } = useContext(Cites);
  const n = href?.startsWith("#cite-") ? Number(href.slice(6)) : NaN;
  if (Number.isNaN(n)) return <SafeLink href={href}>{children}</SafeLink>;
  const source = sources.find((s) => s.n === n);
  if (!source) return <span>{n}</span>;
  return <Chip onClick={(e) => onOpen(source, e.currentTarget)} className="mx-0.5">{n}</Chip>;
}
const MARKDOWN = { a: CiteLink };

function Answer({ m, live, onOpen, reading, onRead }: { m: Message; live: boolean; onOpen: OpenSource; reading: boolean; onRead?: () => void }) {
  const sources = m.sources ?? [];
  return (
    <div className="mt-3 space-y-3">
      {sources.length > 0 && (
        <ul aria-label="Sources" className="flex flex-wrap gap-x-2 gap-y-2.5">
          {sources.map((s) => (
            <li key={s.n} className="max-w-full">
              <Chip
                onClick={(e) => onOpen(s, e.currentTarget)}
                aria-label={`Source ${s.n}: ${s.path}:${s.start_line}-${s.end_line}`}
                className="max-w-full break-all text-left"
              >
                {s.path}:{s.start_line}-{s.end_line}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {live && !m.content && !m.error && <p className="text-muted">Reading the code…</p>}
      <div className="answer">
        <Cites.Provider value={{ sources, onOpen }}>
          <SafeMarkdown components={MARKDOWN}>{linkCitations(m.content)}</SafeMarkdown>
        </Cites.Provider>
      </div>
      {(onRead || m.provider) && (
        <div className="flex items-center gap-3">
          {onRead && (
            <Pill onClick={onRead} className="bg-bg-subtle text-[13px]">
              {reading ? (
                <svg {...icon}><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
              ) : (
                <svg {...icon}><path d="M2.5 6v4H5l3.5 3V3L5 6z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5" /></svg>
              )}
              {reading ? "Stop reading" : "Read aloud"}
            </Pill>
          )}
          {m.provider && <span className="ml-auto font-mono text-xs text-muted">{m.provider}</span>}
        </div>
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
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null); // the chip that opened the code panel gets focus back on close
  const open = viewing !== null;

  // While the panel is open: below 900px it covers the page, so everything behind it is inert.
  // On close, focus goes back to the chip that opened it.
  useEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const narrow = matchMedia("(max-width: 899.98px)");
    let undo = () => {};
    const apply = () => {
      undo();
      undo = narrow.matches ? inertOutside(el) : () => {};
    };
    apply();
    narrow.addEventListener("change", apply);
    return () => {
      narrow.removeEventListener("change", apply);
      undo();
      opener.current?.focus();
    };
  }, [open]);

  const openSource = (s: Source, from: HTMLElement) => {
    opener.current = from;
    setViewing(s);
  };

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
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-6 pt-6">
          <h1 className="sr-only">{repo?.title ?? "Repo"}</h1>
          {loadError && <ErrorBox error={loadError} />}
          <div className="flex-1 pb-6">
            {messages.length === 0 && (
              <div className="pt-6">
                <h2 className="text-[20px] leading-snug font-[650] tracking-[-0.01em]">What would you like to know?</h2>
                <p className="mt-1 text-muted">Not sure where to start? Try one of these.</p>
                <div className="mt-5 flex flex-wrap gap-x-2 gap-y-3">
                  {STARTERS.map((q) => (
                    <Key key={q} variant="ghost" onClick={() => void ask(q)} disabled={streaming}>
                      {q}
                    </Key>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <h2 key={i} className={`text-[20px] leading-snug font-[650] tracking-[-0.01em] break-words ${i > 0 ? "mt-10" : ""}`}>
                  {m.content}
                </h2>
              ) : (
                <Answer
                  key={i}
                  m={m}
                  live={streaming && i === messages.length - 1}
                  onOpen={openSource}
                  reading={reading === i}
                  onRead={voice.canSpeak && m.content && !m.error && !(streaming && i === messages.length - 1) ? () => toggleRead(i, m.content) : undefined}
                />
              ),
            )}
            <div ref={end} />
          </div>
          {/* Solid page colour behind the sticky box so scrolled text never shows through. */}
          <div className="sticky bottom-0 space-y-3 bg-bg pt-2 pb-5">
            {voice.error && <ErrorBox error={{ message: voice.error }} />}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim() && !streaming) void ask(question.trim());
              }}
              className="flex items-center gap-1.5 rounded-card border border-border bg-surface py-1.5 pr-1.5 pl-3.5 shadow-[var(--shadow-ghost)]"
            >
              <input
                aria-label="Question"
                placeholder="Ask about this repo…"
                value={question}
                maxLength={1000}
                disabled={streaming || voice.listening}
                onChange={(e) => setQuestion(e.target.value)}
                className="min-w-0 flex-1 rounded-md bg-transparent py-1.5 placeholder:text-muted disabled:opacity-60"
              />
              {voice.canListen && (
                <button
                  type="button"
                  onClick={() => (voice.listening ? voice.stop() : voice.listen((t) => void ask(t.slice(0, 1000))))}
                  disabled={streaming}
                  aria-label={voice.listening ? "Stop listening" : "Speak your question"}
                  aria-pressed={voice.listening}
                  className="inline-flex items-center gap-1.5 rounded-key px-2.5 py-2 text-muted active:translate-y-px disabled:opacity-50 aria-pressed:bg-accent-soft aria-pressed:text-accent-text"
                >
                  <svg {...icon} width={16} height={16}><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" /><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" /></svg>
                  {voice.listening && <span className="text-[13px]">Listening…</span>}
                </button>
              )}
              <Key type="submit" disabled={streaming || voice.listening || !question.trim()}>
                Ask
              </Key>
            </form>
          </div>
        </div>
      </main>
      {viewing && (
        // Not keyed: it slides in once and stays while you switch sources; the viewer inside is keyed.
        <div
          ref={panel}
          className="code-panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") setViewing(null);
          }}
        >
          <CodeViewer
            autoFocus
            key={`${viewing.path}:${viewing.start_line}-${viewing.end_line}`}
            repoId={repoId}
            path={viewing.path}
            startLine={viewing.start_line}
            endLine={viewing.end_line}
            onClose={() => setViewing(null)}
          />
        </div>
      )}
    </div>
  );
}
