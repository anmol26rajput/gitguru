// What the voice should read: no code blocks, no [n] citation markers.
export function speechText(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " code omitted ").replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
}

// SpeechRecognition error codes -> short messages for the user.
export function voiceError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access was blocked. Allow it in the browser's site settings.";
  if (code === "audio-capture") return "No microphone found.";
  if (code === "network") return "Speech recognition needs a network connection.";
  if (code === "no-speech") return "Didn't catch that — try again.";
  return `Voice input failed (${code}).`;
}

// The server voice takes at most this many characters per request.
export const TTS_MAX = 1500;

// Split text into pieces of at most `max` chars, breaking at sentence ends (else at a space, else hard).
export function splitSpeech(text: string, max = TTS_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (s: string) => {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${s}` : s;
  };
  for (const sentence of text.trim().split(/(?<=[.!?])\s+/)) {
    let s = sentence;
    while (s.length > max) {
      const at = s.lastIndexOf(" ", max);
      const cut = at > 0 ? at : max;
      push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) push(s);
  }
  if (cur) out.push(cur);
  return out;
}

// Pieces for the server voice: a short first piece (the first sentence or two) so audio starts soon, then up to `max`
// chars each (fetched while the previous piece plays).
export function ttsPieces(text: string, first = 150, max = 500): string[] {
  const [head, ...rest] = splitSpeech(text, first);
  return head ? [head, ...splitSpeech(rest.join(" "), max)] : [];
}

// Browser fallback voice, English only: a clear female en-US voice, else a named female voice in another English,
// else any English voice. List order alone would pick Karen (en-AU) over Samantha (en-US) on macOS.
export function pickVoice<T extends { name: string; lang: string }>(voices: readonly T[]): T | undefined {
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const named = english.filter((v) => /Samantha|Ava|Allison|Zoe|Karen|Google US English|Female/i.test(v.name));
  return named.find((v) => /^en[-_]US$/i.test(v.lang)) ?? named[0] ?? english[0];
}
