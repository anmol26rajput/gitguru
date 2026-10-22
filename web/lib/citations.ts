// Turn [n] into a markdown link to #cite-n, but never inside code (fenced blocks, inline spans).
// An unterminated fence (answer still streaming) counts as code to the end.
export function linkCitations(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\[(\d+)\]/g, "[[$1]](#cite-$1)")))
    .join("");
}
