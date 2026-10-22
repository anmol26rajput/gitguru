"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { pickVoice, speechText, splitSpeech, ttsPieces, voiceError } from "./speech.ts";

// The DOM lib types SpeechSynthesis but not SpeechRecognition (still prefixed in Chrome).
type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;
type SpeechWindow = Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };

const recognitionCtor = () => {
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

// window only exists in the browser: false on the server and first client render, then the real answer.
const noop = () => () => {};
const detectListen = () => !!recognitionCtor();
const detectSpeak = () => "Audio" in window || "speechSynthesis" in window;

// The server can take ~15 s to refuse a voice: the user waits at most this long for a piece before the browser voice
// takes over. Text goes to /tts in pieces (ttsPieces: a short first one so audio starts soon, then ≤ 500 chars, as
// ~1,500 chars takes ~9 s to synthesize); the next piece is fetched while the current one plays, so there is no gap.
const TTS_WAIT_MS = 8000;
// A fetch nobody is waiting on yet (the next piece, the next walkthrough step) has the whole playback to finish.
const TTS_FETCH_MS = 20000;
// Chrome's Google voices stop after ~15 s of speech and never fire `end`, so the browser voice reads short utterances.
const UTTERANCE_CHARS = 180;

// ponytail: module-level state is shared by all hook users; fine with a single chat on screen.
// `current` identifies the live speak() call (server audio or browser voice); a late event from any older one is ignored.
let current: object | null = null;
let audio: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
const fetching = new Set<AbortController>();

// Stop and release everything that might be speaking. Detached handlers mean a late event cannot fire.
function stopAll() {
  current = null;
  fetching.forEach((c) => c.abort());
  fetching.clear();
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

// getVoices() is empty until the browser has loaded them (`voiceschanged`), so prime the list early.
let voices: SpeechSynthesisVoice[] = [];
function primeVoices() {
  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const load = () => (voices = synth.getVoices());
  load();
  synth.addEventListener?.("voiceschanged", load);
  return () => synth.removeEventListener?.("voiceschanged", load);
}

// Fetch the server voice (MP3) for one piece of text. Rejects on any failure, including the timeout.
async function fetchVoice(text: string): Promise<Blob> {
  const ctl = new AbortController();
  fetching.add(ctl);
  const timer = setTimeout(() => ctl.abort(), TTS_FETCH_MS);
  try {
    const res = await api("/tts", { method: "POST", body: JSON.stringify({ text }), signal: ctl.signal });
    return await res.blob();
  } finally {
    clearTimeout(timer);
    fetching.delete(ctl);
  }
}

// Rejects if `p` has not settled within `ms` (the fetch itself keeps its own, longer timeout).
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// Warm the server's voice cache for text that will be spoken soon (its first piece, the one the user waits on).
// The result and any error are ignored; cancel() aborts it like any other fetch.
function prefetch(text: string) {
  const [first] = ttsPieces(speechText(text));
  if (first) fetchVoice(first).catch(() => {});
}

// Play an MP3 to the end. Rejects on an audio error or a refused play().
async function playBlob(blob: Blob) {
  const url = (audioUrl = URL.createObjectURL(blob));
  const a = (audio = new Audio(url));
  await new Promise<void>((resolve, reject) => {
    a.onended = () => resolve();
    a.onerror = () => reject(new Error("audio error"));
    a.play().catch(reject);
  });
  if (audioUrl === url) {
    URL.revokeObjectURL(url);
    audioUrl = null;
  }
}

export function useVoice() {
  const canListen = useSyncExternalStore(noop, detectListen, () => false);
  const canSpeak = useSyncExternalStore(noop, detectSpeak, () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);

  useEffect(
    () => () => {
      rec.current?.abort();
      stopAll();
    },
    [],
  );

  useEffect(primeVoices, []);

  function listen(onText: (text: string) => void) {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript.trim();
      if (text) onText(text);
    };
    r.onerror = (e) => setError(voiceError(e.error));
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setError(null);
    setListening(true);
    r.start();
  }

  function stop() {
    rec.current?.stop();
  }

  // onEnd fires when the text has been read to the end; onError (with a SpeechSynthesisErrorEvent code) when the
  // browser voice fails. Neither fires when it is replaced or cancelled.
  // Tries the server voice (/tts) piece by piece; on any failure the rest is read by the browser voice.
  // speak/cancel only touch window and module-level state, so they are stable (safe in effect deps).
  const speak = useCallback((text: string, onEnd?: () => void, onError?: (code: string) => void) => {
    stopAll();
    const me = {};
    current = me;

    // Reads `rest` as a queue of short utterances, each started by the previous one's `end`; only the last one's
    // `end` is the end of the text.
    const browserVoice = (rest: string) => {
      fetching.forEach((c) => c.abort()); // the server voice is done for this text: drop its in-flight fetches
      fetching.clear();
      const parts = splitSpeech(rest, UTTERANCE_CHARS);
      if (!parts.length) return onEnd?.(); // nothing to say: an empty utterance may never fire `end`
      if (!("speechSynthesis" in window)) return onError?.("not-supported");
      const synth = window.speechSynthesis;
      synth.cancel();
      const v = pickVoice(voices.length ? voices : synth.getVoices());
      const say = (k: number) => {
        const u = new SpeechSynthesisUtterance(parts[k]);
        u.lang = "en-US";
        if (v) u.voice = v;
        u.onend = () => {
          if (current !== me) return;
          if (k + 1 < parts.length) say(k + 1);
          else onEnd?.();
        };
        u.onerror = (e) => {
          if (current !== me || e.error === "interrupted" || e.error === "canceled") return;
          current = null;
          onError?.(e.error);
        };
        synth.speak(u);
      };
      say(0);
    };

    const pieces = ttsPieces(speechText(text));
    let next: Promise<Blob> | undefined = pieces.length ? fetchVoice(pieces[0]) : undefined;
    const play = async (i: number) => {
      if (i >= pieces.length) return onEnd?.();
      let ok = true;
      try {
        const blob = await within(next!, TTS_WAIT_MS); // the user is waiting on this piece now
        if (current !== me) return;
        if (i + 1 < pieces.length) {
          next = fetchVoice(pieces[i + 1]);
          next.catch(() => {}); // a failure surfaces when that piece is awaited
        }
        await playBlob(blob);
      } catch {
        ok = false;
      }
      if (current !== me) return; // cancelled or replaced meanwhile
      if (ok) void play(i + 1);
      else browserVoice(pieces.slice(i).join(" "));
    };
    if (pieces.length) void play(0);
    else browserVoice("");
  }, []);

  return { canListen, canSpeak, listening, error, listen, stop, speak, prefetch, cancel: stopAll };
}
