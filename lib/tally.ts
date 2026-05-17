import type { Pitch, PollState } from "./store";

export interface TallyRow {
  pitch: Pitch;
  count: number;
  // The highest count in the tally; used by the bar widget to scale fills.
  maxCount: number;
  // Snapshot of state.voterCount so consumers can compute %.
  voterCount: number;
  // Standard competition rank (1, 2, 2, 4) -- pitches with the same vote
  // count share a rank, then the next available rank skips over the tie.
  rank: number;
}

// Single source of truth for results computation. Used by both the display
// presentation and the voter mobile view so they can't drift in how ties
// or rankings are presented.
export function computeTally(state: PollState): TallyRow[] {
  const counts: Record<string, number> = {};
  for (const sel of Object.values(state.votes)) {
    for (const id of sel) counts[id] = (counts[id] ?? 0) + 1;
  }
  const maxCount = Math.max(0, ...Object.values(counts));
  const sorted = state.pitches
    .map((p) => ({
      pitch: p,
      count: counts[p.id] ?? 0,
      maxCount,
      voterCount: state.voterCount,
    }))
    .sort((a, b) => b.count - a.count || a.pitch.order - b.pitch.order);

  let prevCount = Number.POSITIVE_INFINITY;
  let prevRank = 0;
  return sorted.map((row, i) => {
    if (row.count !== prevCount) {
      prevCount = row.count;
      prevRank = i + 1;
    }
    return { ...row, rank: prevRank };
  });
}

// Expands the admin's "show top N" cutoff so tied entries at the boundary
// stay together. Example: revealLimit=2 against tally [10, 8, 8, 5] would
// split the two rank-2 entries -- one shown as a featured top result, one
// demoted to "remaining". Returning 3 instead keeps both rank-2 entries
// in the same group, so the audience never sees the same rank appear on
// both sides of the divide.
//
// Defensive against undefined / non-finite revealLimit (which can happen
// if a stale SSE state arrives before the default propagates).
export function effectiveTopLimit(
  tally: TallyRow[],
  revealLimit: number | undefined,
): number {
  const limit =
    typeof revealLimit === "number" && Number.isFinite(revealLimit)
      ? Math.max(0, Math.floor(revealLimit))
      : 0;
  let n = Math.min(limit, tally.length);
  if (n <= 0 || n >= tally.length) return n;
  const boundary = tally[n - 1].count;
  while (n < tally.length && tally[n].count === boundary) n++;
  return n;
}
