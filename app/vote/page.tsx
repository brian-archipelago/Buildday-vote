"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveState } from "@/lib/useLiveState";
import { getVoterId } from "@/lib/client";
import type { Pitch } from "@/lib/store";

export default function VotePage() {
  const state = useLiveState();
  const [voterId, setVoterId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);
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

  // Reset acknowledgement after 2s so the UI shows live status again.
  useEffect(() => {
    if (!justSubmitted) return;
    const t = setTimeout(() => setJustSubmitted(false), 2200);
    return () => clearTimeout(t);
  }, [justSubmitted]);

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
  if (state.pollStatus === "closed" || state.pollStatus === "results") {
    return (
      <Waiting
        message={
          state.pollStatus === "closed"
            ? "Voting is closed. Results coming up!"
            : "Voting is closed. Watch the screen!"
        }
        pitches={state.pitches}
      />
    );
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
      setJustSubmitted(true);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
          <h1 className="text-3xl font-black mt-1 bg-gradient-to-r from-fuchsia-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
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

      <div className="fixed inset-x-0 bottom-0 p-4 bg-gradient-to-t from-[#0b0b15] via-[#0b0b15]/90 to-transparent">
        <div className="max-w-md mx-auto">
          <button
            onClick={submit}
            disabled={submitting || sorted.length === 0}
            className="btn-primary w-full !py-4 text-lg"
          >
            {submitting
              ? "Submitting…"
              : justSubmitted
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
            ? "!bg-gradient-to-r from-fuchsia-500/30 to-violet-500/30 !border-fuchsia-300/40"
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
              <span className="pulse-dot text-amber-200 text-[10px] uppercase tracking-widest font-bold">
                live
              </span>
            )}
          </div>
          <div className="text-sm text-white/70 mt-0.5">{pitch.description}</div>
        </div>
        <div
          className={`shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition ${
            checked
              ? "bg-fuchsia-400 border-fuchsia-300"
              : "bg-white/5 border-white/30"
          }`}
        >
          {checked && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12.5l4 4 10-10"
                stroke="#0b0b15"
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
