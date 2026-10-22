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
