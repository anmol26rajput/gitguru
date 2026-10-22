"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { speechText, voiceError } from "./speech.ts";

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
const detectSpeak = () => "speechSynthesis" in window;

// ponytail: module-level "current utterance" is shared by all hook users; fine with a single chat on screen.
let current: SpeechSynthesisUtterance | null = null;

export function useVoice() {
  const canListen = useSyncExternalStore(noop, detectListen, () => false);
  const canSpeak = useSyncExternalStore(noop, detectSpeak, () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);

  useEffect(
    () => () => {
      rec.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    [],
  );

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

  // onEnd fires when this utterance finishes; onError (with the SpeechSynthesisErrorEvent code) when it fails.
  // Neither fires when it is replaced or cancelled.
  // speak/cancel only touch window and the module-level `current`, so they are stable (safe in effect deps).
  const speak = useCallback((text: string, onEnd?: () => void, onError?: (code: string) => void) => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(speechText(text));
    u.lang = "en-US";
    const done = () => {
      if (current === u) onEnd?.();
    };
    u.onend = done;
    u.onerror = (e) => {
      if (current !== u || e.error === "interrupted" || e.error === "canceled") return;
      current = null;
      onError?.(e.error);
    };
    current = u;
    synth.speak(u);
  }, []);

  const cancel = useCallback(() => {
    current = null;
    window.speechSynthesis.cancel();
  }, []);

  return { canListen, canSpeak, listening, error, listen, stop, speak, cancel };
}
