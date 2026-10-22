export type SSEEvent = { event: string; data: unknown };

// Splits on blank lines; an incomplete trailing block is returned in `rest`.
export function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: SSEEvent[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return { events, rest };
}

export async function readSSE(res: Response, onEvent: (e: SSEEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const { events, rest } = parseSSE(buffer);
    buffer = rest;
    events.forEach(onEvent);
    if (done) return;
  }
}
