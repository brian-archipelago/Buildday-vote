import { EventEmitter } from "events";

export type PitchStatus = "in_progress" | "completed";
export type PollStatus = "draft" | "open" | "closed" | "results";

export interface Pitch {
  id: string;
  title: string;
  description: string;
  status: PitchStatus;
  // Single emoji chosen by the analyzer to represent the pitch concept.
  // Optional: existing pitches and pre-emoji clients fall back to a default.
  emoji?: string;
  // Monotonic order; the analyzer should preserve this.
  order: number;
  // Server-set timestamps for first/last transcript chunk assigned to the pitch.
  startedAt: number;
  endedAt?: number;
  // Locked = admin edited; the analyzer can't change it anymore.
  locked?: boolean;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  // ms timestamps from Date.now() when the segment started / ended.
  startedAt: number;
  endedAt: number;
}

export interface PollState {
  pitches: Pitch[];
  pollStatus: PollStatus;
  votes: Record<string, string[]>; // voterId -> array of pitch ids
  voterCount: number;
  // Lightweight analyzer status for the admin UI.
  analyzing: boolean;
  // The current live/partial transcript from the most recent segment
  // (not yet flushed into a completed TranscriptSegment).
  liveTranscript: string;
  // When admin's mic session is active.
  recording: boolean;
  // --- Staged results reveal ---
  // How many of the top results to feature on the reveal screen. The rest
  // stay hidden behind a "Show remaining" toggle so low-vote pitches don't
  // get put on blast. Admin-controlled; default 3.
  revealLimit: number;
  // How many of those top-N have been revealed so far (top-down: rank 1
  // first, then 2, ...). Reset to 1 each time the poll enters results.
  revealedCount: number;
  // True once admin opts to surface the remaining (rank > revealLimit) tally.
  showAllResults: boolean;
  // --- Pitch undo history (broadcast only as a count + last label) ---
  // How many snapshots are available to undo. Lets the admin UI render
  // an undo button without shipping the full history payload.
  historyCount: number;
  // Label + timestamp of the most recent snapshot, so the admin can see
  // *what* an undo would revert ("analyzer pass", "admin delete: Foo App").
  lastSnapshot: { label: string; at: number } | null;
}

// A point-in-time copy of the pitch-related state so an admin can undo a
// destructive change (typically a bad analyzer merge that consolidated 15
// pitches down to 5). Captures pitches + votes because DELETE /api/pitch
// strips the deleted id from every voter ballot -- restoring pitches alone
// would leave ballots silently inconsistent. _deletedTitles is intentionally
// NOT rolled back: it's a monotonic forward set, and un-tombstoning a title
// during undo would let the analyzer re-create a pitch the admin just
// removed (the leftover transcript audio is still in the rolling window).
export interface PitchSnapshot {
  at: number;
  label: string;
  pitches: Pitch[];
  votes: Record<string, string[]>;
  voterCount: number;
}

interface InternalState extends PollState {
  // Not broadcast to clients -- server-only memory.
  _segments: TranscriptSegment[];
  _lastAnalyzedAt: number;
  _transcriptSinceLastAnalyze: number; // characters
  // Titles of pitches the admin has explicitly deleted. Passed to the
  // analyzer as a "do not re-create" tombstone list, since the underlying
  // transcript segments stay in the rolling window for ~5 min.
  _deletedTitles: string[];
  // Ring buffer of pitch-state snapshots for the admin "Undo" affordance.
  // Pushed before every pitch-mutating change (analyzer pass, manual
  // add/edit/delete, lock-on-stage-transition). Capped to keep memory
  // bounded; oldest is dropped on overflow.
  _history: PitchSnapshot[];
}

type Store = {
  state: InternalState;
  emitter: EventEmitter;
};

const g = globalThis as unknown as { __pollStore?: Store };

if (!g.__pollStore) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(500);
  g.__pollStore = {
    state: {
      pitches: [],
      pollStatus: "draft",
      votes: {},
      voterCount: 0,
      analyzing: false,
      liveTranscript: "",
      recording: false,
      revealLimit: 3,
      revealedCount: 0,
      showAllResults: false,
      historyCount: 0,
      lastSnapshot: null,
      _segments: [],
      _lastAnalyzedAt: 0,
      _transcriptSinceLastAnalyze: 0,
      _deletedTitles: [],
      _history: [],
    },
    emitter,
  };
} else {
  // Backfill: in dev, the store on globalThis survives hot reloads. If a
  // previous version of the schema is still in memory (e.g. before reveal
  // staging existed), populate the new fields with safe defaults so callers
  // never see `undefined` and the staged-reveal UI behaves as if freshly
  // initialized.
  const s = g.__pollStore.state as Partial<InternalState>;
  if (typeof s.revealLimit !== "number") s.revealLimit = 3;
  if (typeof s.revealedCount !== "number") s.revealedCount = 0;
  if (typeof s.showAllResults !== "boolean") s.showAllResults = false;
  if (!Array.isArray(s._history)) s._history = [];
  if (typeof s.historyCount !== "number") s.historyCount = s._history?.length ?? 0;
  if (s.lastSnapshot === undefined) s.lastSnapshot = null;
}

export const store: Store = g.__pollStore!;

export const ANALYZER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const ANALYZER_MIN_INTERVAL_MS = 8_000; // don't hammer the analyzer model
export const ANALYZER_MAX_INTERVAL_MS = 30_000; // periodic check even when quiet

export function publicState(): PollState {
  const {
    _segments,
    _lastAnalyzedAt,
    _transcriptSinceLastAnalyze,
    _deletedTitles,
    _history,
    ...pub
  } = store.state;
  return pub;
}

export function emitUpdate() {
  store.emitter.emit("update", publicState());
}

// Maximum number of pitch snapshots to retain. Each snapshot is small (a few
// pitches + ballot dict), so 50 covers a long event without runaway memory.
const HISTORY_CAP = 50;

// Push a snapshot of the current pitch state onto the undo stack. Caller is
// expected to call this *immediately before* the setState() that mutates
// pitches/votes -- never at function entry of an async handler, since the
// store can change under us during awaits.
//
// No SSE emit here; the following setState() will emit publicState (which
// now includes historyCount/lastSnapshot). The dedup check skips a snapshot
// if pitches+votes are byte-identical to the previous snapshot, so back-to-
// back analyzer passes that produce the same merged state don't bloat the
// stack with no-op entries.
export function snapshotPitches(label: string) {
  const s = store.state;
  const pitchesCopy: Pitch[] = s.pitches.map((p) => ({ ...p }));
  const votesCopy: Record<string, string[]> = {};
  for (const [voterId, sel] of Object.entries(s.votes)) {
    votesCopy[voterId] = [...sel];
  }
  const sig = signature(pitchesCopy, votesCopy);
  const last = s._history[s._history.length - 1];
  if (last && signature(last.pitches, last.votes) === sig) return;
  s._history.push({
    at: Date.now(),
    label,
    pitches: pitchesCopy,
    votes: votesCopy,
    voterCount: s.voterCount,
  });
  if (s._history.length > HISTORY_CAP) {
    s._history.splice(0, s._history.length - HISTORY_CAP);
  }
  s.historyCount = s._history.length;
  s.lastSnapshot = { label, at: s._history[s._history.length - 1].at };
}

function signature(pitches: Pitch[], votes: Record<string, string[]>): string {
  // Stable enough at this scale; pitches and ballot lists are bounded.
  return JSON.stringify({ p: pitches, v: votes });
}

// Pop the latest snapshot and restore pitches + votes + voterCount. Emits
// SSE so all clients re-render. Returns the restored snapshot's label/at
// for the admin UI's confirmation toast. Returns null when the history is
// empty.
//
// Intentionally does NOT roll back _deletedTitles: that set is monotonic
// forward. Un-tombstoning a title during undo would let the analyzer
// re-create the same pitch from leftover transcript audio still inside
// the rolling window.
export function undoLastPitchChange(): { label: string; at: number } | null {
  const s = store.state;
  const snap = s._history.pop();
  if (!snap) return null;
  s.pitches = snap.pitches;
  s.votes = snap.votes;
  s.voterCount = snap.voterCount;
  s.historyCount = s._history.length;
  s.lastSnapshot =
    s._history.length > 0
      ? {
          label: s._history[s._history.length - 1].label,
          at: s._history[s._history.length - 1].at,
        }
      : null;
  emitUpdate();
  return { label: snap.label, at: snap.at };
}

export interface TwinkleEvent {
  pitchId: string;
  kind: "select" | "deselect";
  at: number;
}

export function emitTwinkle(ev: TwinkleEvent) {
  store.emitter.emit("twinkle", ev);
}

export function setState(mutator: (s: InternalState) => void) {
  mutator(store.state);
  emitUpdate();
}

export function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export function pruneWindow(now: number) {
  const cutoff = now - ANALYZER_WINDOW_MS;
  store.state._segments = store.state._segments.filter(
    (s) => s.endedAt >= cutoff,
  );
}

export function windowTranscript(): {
  text: string;
  firstStartedAt: number;
  lastEndedAt: number;
  segmentCount: number;
} {
  const segs = store.state._segments;
  if (segs.length === 0) {
    return { text: "", firstStartedAt: 0, lastEndedAt: 0, segmentCount: 0 };
  }
  const text = segs
    .map(
      (s) =>
        `[t=${Math.round((s.startedAt - segs[0].startedAt) / 1000)}s] ${s.text}`,
    )
    .join("\n");
  return {
    text,
    firstStartedAt: segs[0].startedAt,
    lastEndedAt: segs[segs.length - 1].endedAt,
    segmentCount: segs.length,
  };
}
