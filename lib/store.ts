import { EventEmitter } from "events";

export type PitchStatus = "in_progress" | "completed";
export type PollStatus = "draft" | "open" | "closed" | "results";

export interface Pitch {
  id: string;
  title: string;
  description: string;
  status: PitchStatus;
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
}

interface InternalState extends PollState {
  // Not broadcast to clients -- server-only memory.
  _segments: TranscriptSegment[];
  _lastAnalyzedAt: number;
  _transcriptSinceLastAnalyze: number; // characters
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
      _segments: [],
      _lastAnalyzedAt: 0,
      _transcriptSinceLastAnalyze: 0,
    },
    emitter,
  };
}

export const store: Store = g.__pollStore!;

export const ANALYZER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const ANALYZER_MIN_INTERVAL_MS = 8_000; // don't hammer Claude
export const ANALYZER_MAX_INTERVAL_MS = 30_000; // periodic check even when quiet

export function publicState(): PollState {
  const {
    _segments,
    _lastAnalyzedAt,
    _transcriptSinceLastAnalyze,
    ...pub
  } = store.state;
  return pub;
}

export function emitUpdate() {
  store.emitter.emit("update", publicState());
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
