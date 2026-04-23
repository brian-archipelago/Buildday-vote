"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import confetti from "canvas-confetti";
import { useLiveState } from "@/lib/useLiveState";
import type { Pitch, PollState } from "@/lib/store";

export default function DisplayPage() {
  const state = useLiveState();
  const [voteUrl, setVoteUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = `${window.location.origin}/vote`;
    setVoteUrl(url);
    QRCode.toDataURL(url, {
      width: 520,
      margin: 1,
      color: { dark: "#0b0b15", light: "#ffffffff" },
      errorCorrectionLevel: "M",
    }).then(setQrDataUrl).catch(() => {});
  }, []);

  // Confetti on pitch additions + on results reveal.
  const prevCount = useRef(0);
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const count = state.pitches.length;
    if (count > prevCount.current && prevCount.current !== 0) {
      confetti({
        particleCount: 60,
        spread: 70,
        origin: { y: 0.35 },
        colors: ["#f472b6", "#c084fc", "#22d3ee", "#facc15"],
      });
    }
    prevCount.current = count;

    if (state.pollStatus === "results" && prevStatus.current !== "results") {
      bigConfetti();
    }
    prevStatus.current = state.pollStatus;
  }, [state]);

  if (!state) {
    return (
      <main className="min-h-screen bg-aurora flex items-center justify-center">
        <div className="text-white/60 text-xl">Connecting…</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-aurora overflow-hidden">
      {state.pollStatus === "results" ? (
        <ResultsView state={state} />
      ) : (
        <IntakeView
          state={state}
          voteUrl={voteUrl}
          qrDataUrl={qrDataUrl}
        />
      )}
    </main>
  );
}

/* ------------------------------- Intake/open ------------------------------- */

function IntakeView({
  state,
  voteUrl,
  qrDataUrl,
}: {
  state: PollState;
  voteUrl: string;
  qrDataUrl: string | null;
}) {
  const sorted = useMemo(
    () => [...state.pitches].sort((a, b) => a.order - b.order),
    [state.pitches],
  );
  const showQR = state.pollStatus === "open";
  const statusLabel: Record<string, string> = {
    draft: "Collecting pitches…",
    open: "Vote now!",
    closed: "Voting closed",
    results: "Results",
  };

  return (
    <div className="min-h-screen grid grid-rows-[auto_1fr_auto] p-10 gap-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-white/50">
            AI Hackathon · Live Poll
          </div>
          <h1 className="mt-1 text-6xl font-black tracking-tight bg-gradient-to-r from-fuchsia-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
            {statusLabel[state.pollStatus] ?? "Live"}
          </h1>
        </div>
        <div className="text-right">
          {state.recording && (
            <div className="pulse-dot text-red-300 text-xl font-bold">
              LIVE MIC
            </div>
          )}
          <div className="text-white/60 text-sm mt-1">
            {sorted.length} pitch{sorted.length === 1 ? "" : "es"} ·{" "}
            {state.voterCount} vote{state.voterCount === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-8 min-h-0">
        <section className="col-span-8 overflow-hidden">
          <div className="h-full overflow-y-auto scrollbar-thin pr-2">
            {sorted.length === 0 ? (
              <EmptyHero />
            ) : (
              <ul className="space-y-4">
                {sorted.map((p, i) => (
                  <PitchCard key={p.id} index={i + 1} pitch={p} />
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="col-span-4 flex flex-col items-center justify-start gap-6">
          {showQR && qrDataUrl ? (
            <div className="card p-6 flex flex-col items-center animate-float">
              <div className="text-xs uppercase tracking-[0.3em] text-white/50">
                Scan to vote
              </div>
              <img
                src={qrDataUrl}
                alt="Vote QR"
                className="w-[380px] h-[380px] rounded-xl mt-3"
              />
              <div className="text-white/70 text-sm mt-2 break-all">
                {voteUrl}
              </div>
            </div>
          ) : (
            <div className="card p-6 text-center w-full">
              <div className="text-xs uppercase tracking-[0.3em] text-white/50">
                Status
              </div>
              <div className="text-3xl font-bold mt-2">
                {state.pollStatus === "draft"
                  ? "Listening for pitches…"
                  : state.pollStatus === "closed"
                    ? "Tallying votes…"
                    : "Stand by"}
              </div>
              {state.pollStatus === "draft" && (
                <div className="text-white/50 text-sm mt-2">
                  The QR code appears when voting opens.
                </div>
              )}
            </div>
          )}

          {state.pollStatus === "open" && (
            <div className="text-center">
              <div className="text-6xl font-black text-white">
                {state.voterCount}
              </div>
              <div className="text-white/60 uppercase tracking-[0.3em] text-xs mt-1">
                ballots in
              </div>
            </div>
          )}
        </aside>
      </div>

      <footer className="text-center text-white/30 text-xs">
        Powered by Claude + OpenAI Realtime · pitches summarized from live audio
      </footer>
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-xl">
        <div className="text-8xl mb-6 animate-pulse-slow">🎤</div>
        <div className="text-4xl font-black text-white/80">
          Ready when you are.
        </div>
        <p className="mt-3 text-white/50">
          Start pitching — each idea will appear here the moment the AI
          recognizes it.
        </p>
      </div>
    </div>
  );
}

function PitchCard({ index, pitch }: { index: number; pitch: Pitch }) {
  return (
    <li className="card flex gap-4 items-start transition-all">
      <div className="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center text-2xl font-black shadow-lg shadow-fuchsia-500/30">
        {index}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <div className="text-3xl font-bold truncate">{pitch.title}</div>
          {pitch.status === "in_progress" && (
            <span className="pulse-dot text-amber-200 text-xs uppercase tracking-[0.2em] font-bold">
              live
            </span>
          )}
        </div>
        <div className="text-white/70 text-lg mt-1">{pitch.description}</div>
      </div>
    </li>
  );
}

/* --------------------------------- Results --------------------------------- */

function ResultsView({ state }: { state: PollState }) {
  const tally = useMemo(() => computeTally(state), [state]);
  const winnerId = tally[0]?.pitch.id;
  return (
    <div className="min-h-screen p-10 flex flex-col">
      <header className="text-center">
        <div className="text-sm uppercase tracking-[0.4em] text-white/60">
          And the crowd says…
        </div>
        <h1 className="mt-2 text-7xl font-black tracking-tight bg-gradient-to-r from-yellow-300 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
          Results
        </h1>
        <div className="text-white/50 mt-2 text-sm">
          {state.voterCount} ballot{state.voterCount === 1 ? "" : "s"} · multi-select
        </div>
      </header>

      <div className="flex-1 flex flex-col justify-center mt-10">
        <ul className="space-y-5 max-w-5xl mx-auto w-full">
          {tally.map((row, i) => (
            <ResultRow
              key={row.pitch.id}
              rank={i + 1}
              row={row}
              isWinner={row.pitch.id === winnerId && row.count > 0}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ResultRow({
  rank,
  row,
  isWinner,
}: {
  rank: number;
  row: TallyRow;
  isWinner: boolean;
}) {
  const pct = row.maxCount > 0 ? (row.count / row.maxCount) * 100 : 0;
  const pctLabel =
    row.voterCount > 0 ? Math.round((row.count / row.voterCount) * 100) : 0;
  return (
    <li
      className={`card !p-5 ${
        isWinner ? "ring-2 ring-yellow-300/70 shadow-xl shadow-yellow-400/20" : ""
      }`}
    >
      <div className="flex items-center gap-4">
        <div
          className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center text-3xl font-black ${
            isWinner
              ? "bg-gradient-to-br from-yellow-300 to-amber-500 text-black"
              : "bg-white/10"
          }`}
        >
          {isWinner ? "🏆" : rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <div className="text-2xl font-bold truncate">{row.pitch.title}</div>
            <div className="text-right">
              <div className="text-3xl font-black tabular-nums">
                {row.count}
              </div>
              <div className="text-xs text-white/50 uppercase tracking-widest">
                {pctLabel}%
              </div>
            </div>
          </div>
          <div className="text-white/60 text-sm truncate">
            {row.pitch.description}
          </div>
          <div className="mt-3 h-3 rounded-full bg-white/10 overflow-hidden">
            <div
              className="bar-fill h-full rounded-full bg-gradient-to-r from-fuchsia-400 via-violet-400 to-cyan-400"
              style={{ ["--tw-bar" as any]: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </li>
  );
}

interface TallyRow {
  pitch: Pitch;
  count: number;
  maxCount: number;
  voterCount: number;
}

function computeTally(state: PollState): TallyRow[] {
  const counts: Record<string, number> = {};
  for (const sel of Object.values(state.votes)) {
    for (const id of sel) counts[id] = (counts[id] ?? 0) + 1;
  }
  const maxCount = Math.max(0, ...Object.values(counts));
  return state.pitches
    .map((p) => ({
      pitch: p,
      count: counts[p.id] ?? 0,
      maxCount,
      voterCount: state.voterCount,
    }))
    .sort((a, b) => b.count - a.count || a.pitch.order - b.pitch.order);
}

function bigConfetti() {
  const colors = ["#facc15", "#f472b6", "#c084fc", "#22d3ee", "#34d399"];
  const burst = (origin: { x: number; y: number }) =>
    confetti({
      particleCount: 180,
      spread: 100,
      startVelocity: 55,
      origin,
      colors,
    });
  burst({ x: 0.15, y: 0.35 });
  burst({ x: 0.5, y: 0.2 });
  burst({ x: 0.85, y: 0.35 });
  setTimeout(() => burst({ x: 0.5, y: 0.5 }), 350);
}
