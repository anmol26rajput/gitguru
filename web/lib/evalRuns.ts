// Each eval run writes every (strategy, mode) pair once, so a repeated pair (walking oldest -> newest) starts a new run.
// `rows` is the API order: newest first.
export function countRuns(rows: { id: number; strategy: string; mode: string }[]): number {
  if (!rows.length) return 0;
  let runs = 1;
  let seen = new Set<string>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const key = `${r.strategy}/${r.mode}`;
    if (seen.has(key)) {
      runs++;
      seen = new Set();
    }
    seen.add(key);
  }
  return runs;
}
