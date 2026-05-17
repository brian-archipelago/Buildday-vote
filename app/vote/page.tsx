"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveState } from "@/lib/useLiveState";
import { getVoterId } from "@/lib/client";
import type { Pitch, PollState } from "@/lib/store";
import { computeTally, effectiveTopLimit, type TallyRow } from "@/lib/tally";

export default function VotePage() {
  const state = useLiveState();
  const [voterId, setVoterId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  // Tracks the selection set from the most recent successful submit, encoded
  // as a sorted-id key for cheap equality. "" = never submitted yet. The
  // button stays in "Saved" mode until the user actually changes something
  // (which makes selectionKey diverge from lastSavedKey). Replaces a previous
  // 2s flash that confusingly reverted to "Submit" while the vote was still
  // saved on the server.
  const [lastSavedKey, setLastSavedKey] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVoterId(getVoterId());
  }, []);

  // Keep the selected set in sync with the available pitches (drop deleted ids).
  useEffect(() => {
    if (!state) return;
    const valid = new Set(state.pitches.map((p) => p.id));
    setSelected((prev) => {
      const filtered = new Set<string>();
      prev.forEach((id) => {
        if (valid.has(id)) filtered.add(id);
      });
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [state?.pitches]);

  const selectionKey = useMemo(
    () => Array.from(selected).sort().join(","),
    [selected],
  );
  const isSaved = lastSavedKey !== "" && selectionKey === lastSavedKey;

  if (!state) {
    return (
      <main className="min-h-screen bg-aurora flex items-center justify-center p-6">
        <div className="text-white/60">Connecting…</div>
      </main>
    );
  }

  if (state.pollStatus === "draft") {
    return <Waiting message="Voting hasn't opened yet." pitches={state.pitches} />;
  }
  if (state.pollStatus === "closed") {
    return <ClosedView state={state} voterId={voterId} />;
  }
  if (state.pollStatus === "results") {
    return <ResultsView state={state} voterId={voterId} />;
  }

  const sorted = [...state.pitches].sort((a, b) => a.order - b.order);

  async function submit() {
    if (!voterId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voterId,
          selections: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Vote failed");
      }
      setLastSavedKey(selectionKey);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const wasSelected = next.has(id);
      if (wasSelected) next.delete(id);
      else next.add(id);
      // Fire-and-forget twinkle ping for the display.
      if (state?.pollStatus === "open") {
        fetch("/api/twinkle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pitchId: id,
            kind: wasSelected ? "deselect" : "select",
            voterId,
          }),
          keepalive: true,
        }).catch(() => {});
      }
      return next;
    });
  }

  return (
    <main className="min-h-screen bg-aurora">
      <div className="max-w-md mx-auto p-5 pb-36">
        <header className="pt-4 pb-2">
          <div className="text-xs uppercase tracking-[0.3em] text-white/50">
            Live Hackathon Vote
          </div>
          <h1 className="font-display text-3xl font-bold mt-1 leading-[1.15] pb-1 bg-gradient-to-r from-brand-mint via-white to-brand-subtle-blue bg-clip-text text-transparent">
            Pick your favorites
          </h1>
          <p className="text-sm text-white/60 mt-1">
            Tap as many as you like. You can change your choices until voting closes.
          </p>
        </header>

        <ul className="mt-4 space-y-2">
          {sorted.length === 0 && (
            <li className="card text-white/50 italic">
              Pitches will appear here as they happen. Stay on this page — no
              refresh needed.
            </li>
          )}
          {sorted.map((p, i) => (
            <VoteRow
              key={p.id}
              index={i + 1}
              pitch={p}
              checked={selected.has(p.id)}
              onToggle={() => toggle(p.id)}
            />
          ))}
        </ul>

        {error && (
          <div className="mt-4 text-sm text-red-300 bg-red-500/10 rounded-lg p-2 border border-red-500/30">
            {error}
          </div>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 p-4 bg-gradient-to-t from-brand-deep-navy via-brand-deep-navy/90 to-transparent">
        <div className="max-w-md mx-auto">
          <button
            onClick={submit}
            disabled={submitting || sorted.length === 0}
            className="btn-primary w-full !py-4 text-lg"
          >
            {submitting
              ? "Submitting…"
              : isSaved
                ? "✓ Saved — tap again to update"
                : `Submit ${selected.size} pick${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </main>
  );
}

function VoteRow({
  index,
  pitch,
  checked,
  onToggle,
}: {
  index: number;
  pitch: Pitch;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        onClick={onToggle}
        className={`w-full text-left card !p-3 flex gap-3 items-start transition ${
          checked
            ? "!bg-gradient-to-r from-brand-mint/20 to-brand-blue/30 !border-brand-mint/50"
            : ""
        }`}
      >
        <div className="shrink-0 w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center font-bold">
          {index}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="font-semibold truncate">{pitch.title}</div>
            {pitch.status === "in_progress" && (
              <span className="pulse-dot text-brand-mint text-[10px] uppercase tracking-widest font-bold">
                live
              </span>
            )}
          </div>
          <div className="text-sm text-white/70 mt-0.5">{pitch.description}</div>
        </div>
        <div
          className={`shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition ${
            checked
              ? "bg-brand-mint border-brand-mint"
              : "bg-white/5 border-white/30"
          }`}
        >
          {checked && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12.5l4 4 10-10"
                stroke="#103468"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </button>
    </li>
  );
}

function Waiting({
  message,
  pitches,
}: {
  message: string;
  pitches: Pitch[];
}) {
  const sorted = useMemo(
    () => [...pitches].sort((a, b) => a.order - b.order),
    [pitches],
  );
  return (
    <main className="min-h-screen bg-aurora p-6">
      <div className="max-w-md mx-auto pt-16 text-center">
        <div className="text-7xl animate-pulse-slow">🗳️</div>
        <div className="mt-5 text-2xl font-bold">{message}</div>
        <div className="text-white/50 text-sm mt-2">
          Stay on this page — it will update automatically.
        </div>
        {sorted.length > 0 && (
          <div className="mt-8 text-left">
            <div className="text-xs uppercase tracking-[0.3em] text-white/50 mb-2">
              Pitches so far
            </div>
            <ul className="space-y-2">
              {sorted.map((p, i) => (
                <li key={p.id} className="card !p-3">
                  <div className="font-semibold">
                    {i + 1}. {p.title}
                  </div>
                  <div className="text-sm text-white/60">{p.description}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}

function ClosedView({
  state,
  voterId,
}: {
  state: PollState;
  voterId: string;
}) {
  const myPicks = voterId ? state.votes[voterId] ?? null : null;
  const sorted = useMemo(
    () => [...state.pitches].sort((a, b) => a.order - b.order),
    [state.pitches],
  );
  const myPickIds = useMemo(() => new Set(myPicks ?? []), [myPicks]);

  return (
    <main className="min-h-screen bg-aurora p-6">
      <div className="max-w-md mx-auto pt-10">
        <div className="text-center">
          <div className="text-6xl animate-pulse-slow">🗳️</div>
          <div className="mt-4 text-2xl font-bold">Voting is closed</div>
          <div className="text-white/60 text-sm mt-1">
            Results will appear here the moment they're revealed.
          </div>
        </div>

        <div className="mt-8">
          <div className="text-xs uppercase tracking-[0.3em] text-white/50 mb-2">
            Your picks
          </div>
          {myPicks === null ? (
            <div className="card text-white/50 italic">
              You didn't submit a vote.
            </div>
          ) : myPicks.length === 0 ? (
            <div className="card text-white/50 italic">
              You submitted an empty ballot.
            </div>
          ) : (
            <ul className="space-y-2">
              {sorted
                .filter((p) => myPickIds.has(p.id))
                .map((p) => (
                  <li
                    key={p.id}
                    className="card !p-3 !bg-gradient-to-r from-brand-mint/20 to-brand-blue/30 !border-brand-mint/50"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-brand-mint mt-0.5">✓</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{p.title}</div>
                        <div className="text-sm text-white/70 mt-0.5">
                          {p.description}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

// computeTally + TallyRow live in lib/tally.ts so this view stays in
// lockstep with the display presentation.

function ResultsView({
  state,
  voterId,
}: {
  state: PollState;
  voterId: string;
}) {
  const tally = useMemo(() => computeTally(state), [state]);
  const myPicks = voterId ? state.votes[voterId] ?? null : null;
  const myPickIds = useMemo(() => new Set(myPicks ?? []), [myPicks]);

  // Mirror the display reveal pacing: only show the revealed top-N (with
  // placeholders for unrevealed slots), and only show the rest once the
  // admin opens the floodgates with "Show remaining". effectiveTopLimit
  // expands the cutoff to keep tied entries on the same side of the divide.
  const effectiveLimit = useMemo(
    () => effectiveTopLimit(tally, state.revealLimit),
    [tally, state.revealLimit],
  );
  const revealed = Math.max(
    0,
    Math.min(
      Number.isFinite(state.revealedCount) ? state.revealedCount : 0,
      effectiveLimit,
    ),
  );
  const showAll = state.showAllResults === true;
  const top = tally.slice(0, effectiveLimit);
  const rest = tally.slice(effectiveLimit);

  // Did the (top-1) co-winners include any of the voter's picks?
  const winnerInMyPicks = tally
    .filter((r) => r.rank === 1 && r.count > 0)
    .some((r) => myPickIds.has(r.pitch.id));

  return (
    <main className="min-h-screen bg-aurora p-5 pb-12">
      <div className="max-w-md mx-auto">
        <header className="text-center pt-4">
          <div className="text-xs uppercase tracking-[0.3em] text-white/50">
            And the crowd says…
          </div>
          <h1 className="mt-2 font-display text-4xl font-bold leading-[1.15] pb-1 bg-gradient-to-r from-brand-mint via-white to-brand-subtle-blue bg-clip-text text-transparent">
            Results
          </h1>
          <div className="text-white/50 text-xs mt-2">
            {state.voterCount} ballot{state.voterCount === 1 ? "" : "s"}
            {myPicks !== null && revealed >= effectiveLimit && effectiveLimit > 0 && (
              <>
                {" · "}
                {winnerInMyPicks ? "you picked the winner 🎉" : "your picks marked below"}
              </>
            )}
          </div>
        </header>

        <ul className="mt-6 space-y-3">
          {top.map((row, i) => {
            const isRevealed = i + 1 <= revealed;
            const isWinner = isRevealed && row.rank === 1 && row.count > 0;
            const isMyPick = myPickIds.has(row.pitch.id);
            return isRevealed ? (
              <ResultRowMobile
                key={row.pitch.id}
                row={row}
                isWinner={isWinner}
                isMyPick={isMyPick}
              />
            ) : (
              <PlaceholderRowMobile key={`placeholder-${i}`} />
            );
          })}
          {showAll &&
            rest.map((row) => (
              <ResultRowMobile
                key={row.pitch.id}
                row={row}
                isWinner={false}
                isMyPick={myPickIds.has(row.pitch.id)}
              />
            ))}
        </ul>

        {myPicks === null && (
          <div className="mt-6 text-center text-xs text-white/40 italic">
            You didn't submit a vote.
          </div>
        )}
      </div>
    </main>
  );
}

// Mobile placeholder mirrors the display version: rank, title, count, and
// any "your pick" affordance are all masked. Showing the pick badge on a
// placeholder would tell the voter exactly which unrevealed slot is theirs
// (and therefore where in the ranking they landed), spoiling the reveal.
function PlaceholderRowMobile() {
  return (
    <li className="card !p-3 opacity-70">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center font-display text-lg font-bold bg-white/10 text-white/40">
          ?
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 break-words">
              <span className="text-white/40 tracking-[0.3em] animate-pulse-slow">
                • • •
              </span>
            </div>
            <div className="text-right shrink-0">
              <div className="font-display text-xl font-bold tabular-nums leading-none text-white/30">
                ?
              </div>
              <div className="text-[10px] text-white/30 uppercase tracking-widest">
                pending
              </div>
            </div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden" />
        </div>
      </div>
    </li>
  );
}

function ResultRowMobile({
  row,
  isWinner,
  isMyPick,
}: {
  row: TallyRow;
  isWinner: boolean;
  isMyPick: boolean;
}) {
  const pct = row.maxCount > 0 ? (row.count / row.maxCount) * 100 : 0;
  const pctLabel =
    row.voterCount > 0 ? Math.round((row.count / row.voterCount) * 100) : 0;
  return (
    <li
      className={`card !p-3 ${
        isWinner ? "ring-2 ring-brand-mint/70 shadow-lg shadow-brand-mint/30" : ""
      } ${isMyPick ? "!border-brand-mint/50" : ""}`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center font-display text-lg font-bold ${
            isWinner
              ? "bg-gradient-to-br from-brand-mint to-brand-teal text-brand-navy"
              : "bg-white/10"
          }`}
        >
          {isWinner ? "🏆" : row.rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 break-words">
              <span>{row.pitch.title}</span>
              {isMyPick && (
                <span
                  className="text-[10px] uppercase tracking-widest rounded-full px-1.5 py-0.5 bg-brand-mint/20 text-brand-mint border border-brand-mint/40 shrink-0"
                  title="You voted for this"
                >
                  your pick
                </span>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="font-display text-xl font-bold tabular-nums leading-none">
                {row.count}
              </div>
              <div className="text-[10px] text-white/50 uppercase tracking-widest">
                {pctLabel}%
              </div>
            </div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className="bar-fill h-full rounded-full bg-gradient-to-r from-brand-blue via-brand-subtle-blue to-brand-mint"
              style={{ ["--tw-bar" as any]: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </li>
  );
}
