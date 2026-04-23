import { EventEmitter } from "events";

export type PitchStatus = "recording" | "summarizing" | "ready";
export type PollStatus = "draft" | "open" | "closed" | "results";

export interface Pitch {
  id: string;
  title: string;
  description: string;
  status: PitchStatus;
  createdAt: number;
}

export interface PollState {
  pitches: Pitch[];
  pollStatus: PollStatus;
  votes: Record<string, string[]>; // voterId -> array of pitch ids
  voterCount: number;
}

type Store = {
  state: PollState;
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
    },
    emitter,
  };
}

export const store: Store = g.__pollStore!;

export function publicState(): PollState {
  return store.state;
}

export function emitUpdate() {
  store.emitter.emit("update", store.state);
}

export function setState(mutator: (s: PollState) => void) {
  mutator(store.state);
  emitUpdate();
}

export function genId() {
  return Math.random().toString(36).slice(2, 10);
}
