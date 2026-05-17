"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import confetti from "canvas-confetti";
import { useLiveState } from "@/lib/useLiveState";
import type { Pitch, PollState, TwinkleEvent } from "@/lib/store";
import { computeTally, effectiveTopLimit, type TallyRow } from "@/lib/tally";

// Tracks one concurrent twinkle event per pitch; used to drive the card's
// halo glow intensity and to flash/kick the most recent event. Confetti
// is fired imperatively (canvas-based) so it doesn't live in this list.
interface ActiveTwinkle {
  id: string;
  pitchId: string;
  kind: "select" | "deselect";
}

// Fallback emoji palette for pitches the analyzer hasn't yet annotated.
// Hashed off the pitch id so the same pitch always gets the same fallback.
const FALLBACK_EMOJIS = [
  "🤖", "🚀", "✨", "🧠", "🔮", "💡", "⚡", "🎯", "🛠️", "🔧",
  "🦾", "🛸", "🧩", "🪄", "🌐", "📡", "🎨", "🎮", "🧪", "🔭",
  "🦉", "🐙", "🐝", "🌟", "🍀", "🌈", "🔥", "🎲", "🧬", "🌀",
];

function emojiForPitch(p: Pitch): string {
  if (p.emoji && p.emoji.trim()) return p.emoji;
  let hash = 0;
  for (let i = 0; i < p.id.length; i++) {
    hash = (hash * 31 + p.id.charCodeAt(i)) | 0;
  }
  return FALLBACK_EMOJIS[Math.abs(hash) % FALLBACK_EMOJIS.length];
}

// "Current" = the most recently started pitch that's still in_progress.
// If everything is completed, the last pitch in chronological order.
function currentPitchId(pitches: Pitch[]): string | null {
  if (pitches.length === 0) return null;
  const sorted = [...pitches].sort((a, b) => a.order - b.order);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].status === "in_progress") return sorted[i].id;
  }
  return sorted[sorted.length - 1].id;
}

const TWINKLE_LIFETIME_MS = 2200;

// Archipelago palette: primary blue, mint accent, subtle blue, teal, white.
const CONFETTI_COLORS_SELECT = [
  "#38F5A3", // brand mint
  "#2E68FF", // brand blue
  "#5B8AFF", // subtle blue
  "#00BDA5", // brand teal
  "#FFFFFF", // white
];
const CONFETTI_COLORS_DESELECT = ["#64748B", "#E2E8F0"]; // slate light, border gray

// Compute viewport-fraction origin for a card so confetti shoots from its
// location across the screen instead of being trapped inside its bounds.
function originFromElement(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2) / window.innerWidth,
    y: (rect.top + rect.height / 2) / window.innerHeight,
  };
}

export default function DisplayPage() {
  const [twinkles, setTwinkles] = useState<ActiveTwinkle[]>([]);

  // DOM lookup by data-pitch-id avoids the ref-passing dance through three
  // component layers. Refs would be cleaner but this is reliable and fast
  // since we're not in a render hot path -- only on incoming twinkle events.
  const fireFromCard = useCallback((pitchId: string, kind: "select" | "deselect") => {
    const el = document.querySelector<HTMLElement>(
      `[data-pitch-id="${pitchId}"]`,
    );
    if (!el) return;
    const origin = originFromElement(el);
    if (kind === "select") {
      confetti({
        particleCount: 70,
        spread: 75,
        startVelocity: 42,
        ticks: 220,
        gravity: 0.85,
        scalar: 0.95,
        origin,
        colors: CONFETTI_COLORS_SELECT,
        disableForReducedMotion: true,
      });
    } else {
      confetti({
        particleCount: 14,
        spread: 50,
        startVelocity: 22,
        ticks: 130,
        gravity: 1.1,
        scalar: 0.7,
        origin,
        colors: CONFETTI_COLORS_DESELECT,
        disableForReducedMotion: true,
      });
    }
  }, []);

  const handleTwinkle = useCallback(
    (ev: TwinkleEvent) => {
      const t: ActiveTwinkle = {
        id: `${ev.at}-${Math.random().toString(36).slice(2, 6)}`,
        pitchId: ev.pitchId,
        kind: ev.kind,
      };
      setTwinkles((prev) => [...prev, t]);
      setTimeout(() => {
        setTwinkles((prev) => prev.filter((x) => x.id !== t.id));
      }, TWINKLE_LIFETIME_MS);
      // Defer to next frame so a freshly-spawned card has been laid out
      // before we measure its bounding rect for the confetti origin.
      requestAnimationFrame(() => fireFromCard(ev.pitchId, ev.kind));
    },
    [fireFromCard],
  );

  const state = useLiveState({ onTwinkle: handleTwinkle });
  const [voteUrl, setVoteUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = `${window.location.origin}/vote`;
    setVoteUrl(url);
    QRCode.toDataURL(url, {
      width: 520,
      margin: 1,
      color: { dark: "#103468", light: "#ffffffff" },
      errorCorrectionLevel: "M",
    }).then(setQrDataUrl).catch(() => {});
  }, []);

  // Confetti on pitch additions only. The results-stage transition used to
  // fire a big burst, but with the staged reveal flow that fired before any
  // result was actually shown -- now confetti is reserved for the per-card
  // reveals (and the "show remaining" cascade) so each burst means something.
  const prevCount = useRef(0);
  useEffect(() => {
    if (!state) return;
    const count = state.pitches.length;
    if (count > prevCount.current && prevCount.current !== 0) {
      confetti({
        particleCount: 60,
        spread: 70,
        origin: { y: 0.35 },
        colors: CONFETTI_COLORS_SELECT,
      });
    }
    prevCount.current = count;
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
          twinkles={twinkles}
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
  twinkles,
}: {
  state: PollState;
  voteUrl: string;
  qrDataUrl: string | null;
  twinkles: ActiveTwinkle[];
}) {
  const sorted = useMemo(
    () => [...state.pitches].sort((a, b) => a.order - b.order),
    [state.pitches],
  );
  const activeId = useMemo(() => currentPitchId(state.pitches), [state.pitches]);
  const twinklesByPitch = useMemo(() => {
    const m = new Map<string, ActiveTwinkle[]>();
    for (const t of twinkles) {
      const arr = m.get(t.pitchId);
      if (arr) arr.push(t);
      else m.set(t.pitchId, [t]);
    }
    return m;
  }, [twinkles]);
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
          <h1 className="mt-1 font-display text-6xl font-bold tracking-tight leading-[1.15] pb-1 bg-gradient-to-r from-brand-mint via-white to-brand-subtle-blue bg-clip-text text-transparent">
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
                  <PitchCard
                    key={p.id}
                    index={i + 1}
                    pitch={p}
                    twinkles={twinklesByPitch.get(p.id) ?? []}
                    isCurrent={p.id === activeId}
                  />
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
              <div className="font-display text-6xl font-bold text-white">
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
        Powered by OpenAI Realtime + GPT-5.4-mini · pitches summarized from live audio
      </footer>
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-xl">
        <div className="text-8xl mb-6 animate-pulse-slow">🎤</div>
        <div className="font-display text-4xl font-bold text-white/80">
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

function PitchCard({
  index,
  pitch,
  twinkles,
  isCurrent,
}: {
  index: number;
  pitch: Pitch;
  twinkles: ActiveTwinkle[];
  isCurrent: boolean;
}) {
  const ref = useRef<HTMLLIElement | null>(null);

  // When this card becomes the current pitch, scroll it into the visible
  // area. "nearest" avoids unnecessary jumps if it's already on screen.
  useEffect(() => {
    if (!isCurrent || !ref.current) return;
    ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isCurrent]);

  // Glow strength compounds as concurrent voter clicks accumulate. Capped so
  // the card can't blow out — but with enough simultaneous clicks the halo
  // gets noticeably brighter than a single click.
  const selectActive = twinkles.filter((t) => t.kind === "select").length;
  const glowStrength = Math.min(0.95, 0.35 + selectActive * 0.12);

  // Drive a brief scale "kick" when the most recent twinkle changes. We key
  // the kick wrapper by the latest twinkle id so React replays the animation
  // every time a new event lands, even at high cadence.
  const latest = twinkles[twinkles.length - 1];
  const kickKey = latest?.id ?? "idle";
  const emoji = emojiForPitch(pitch);

  return (
    <li ref={ref} data-pitch-id={pitch.id} className="relative">
      {selectActive > 0 && (
        <div
          className="twinkle-glow"
          style={{ ["--glow-strength" as any]: glowStrength }}
        />
      )}
      <div
        key={kickKey}
        className={`card relative overflow-visible flex gap-4 items-start transition-all ${
          latest ? "twinkle-kick" : ""
        } ${isCurrent ? "ring-2 ring-brand-blue/70 shadow-lg shadow-brand-blue/30" : ""}`}
      >
        {latest && (
          <div key={latest.id} className={`twinkle-flash ${latest.kind}`} />
        )}
        <div className="shrink-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-blue/30 to-brand-deep-navy/40 border border-white/10 flex items-center justify-center text-4xl shadow-lg shadow-brand-blue/20 relative z-10">
          {emoji}
        </div>
        <div className="flex-1 min-w-0 relative z-10">
          <div className="flex items-baseline gap-3 flex-wrap">
            <div className="text-xs font-bold text-white/40 tabular-nums">
              #{index}
            </div>
            <div className="font-display text-3xl font-bold truncate">{pitch.title}</div>
            {pitch.status === "in_progress" && (
              <span className="pulse-dot text-brand-mint text-xs uppercase tracking-[0.2em] font-bold">
                live
              </span>
            )}
          </div>
          <div className="text-white/70 text-lg mt-1">{pitch.description}</div>
        </div>
      </div>
    </li>
  );
}

/* --------------------------------- Results --------------------------------- */

function ResultsView({ state }: { state: PollState }) {
  const tally = useMemo(() => computeTally(state), [state]);
  // effectiveLimit = how many slots the top section reserves. Capped at the
  // actual pitch count so a stale "Show top 5 of 3 pitches" admin setting
  // doesn't render two ghost placeholders below the real ones. Expanded to
  // include any rows tied with the boundary so co-2nds (etc.) never appear
  // on both sides of the top/remaining divide.
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

  // Confetti per reveal: when revealedCount ticks up, fire from the just-
  // revealed card. Same when the admin opens the floodgates with "Show all".
  const prevRevealed = useRef(revealed);
  const prevShowAll = useRef(showAll);
  useEffect(() => {
    if (revealed > prevRevealed.current) {
      // Newly revealed rank in the top section is `revealed` (1-indexed).
      const newlyRevealedPitchId = top[revealed - 1]?.pitch.id;
      if (newlyRevealedPitchId) {
        requestAnimationFrame(() => fireResultConfetti(newlyRevealedPitchId));
      }
    }
    prevRevealed.current = revealed;
  }, [revealed, top]);
  useEffect(() => {
    if (showAll && !prevShowAll.current && rest.length > 0) {
      // Smaller cascading bursts across the newly-shown rows.
      requestAnimationFrame(() => {
        rest.forEach((row, i) => {
          setTimeout(() => fireResultConfetti(row.pitch.id, "soft"), i * 180);
        });
      });
    }
    prevShowAll.current = showAll;
  }, [showAll, rest]);

  return (
    <div className="min-h-screen p-10 flex flex-col">
      <header className="text-center">
        <div className="text-sm uppercase tracking-[0.4em] text-white/60">
          And the crowd says…
        </div>
        <h1 className="mt-2 font-display text-7xl font-bold tracking-tight leading-[1.15] pb-1 bg-gradient-to-r from-brand-mint via-white to-brand-subtle-blue bg-clip-text text-transparent">
          Results
        </h1>
        <div className="text-white/50 mt-2 text-sm">
          {state.voterCount} ballot{state.voterCount === 1 ? "" : "s"} · multi-select
          {effectiveLimit > 0 && (
            <>
              {" · "}
              <span className="text-white/40">
                top {effectiveLimit} · {revealed} revealed
              </span>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex flex-col justify-center mt-10">
        <ul className="space-y-5 max-w-5xl mx-auto w-full">
          {top.map((row, i) => {
            // Reveal cursor stays row-based (one click reveals one row) so
            // tied entries reveal individually. Rank uses the with-ties
            // value from computeTally so co-2nds both display "2".
            const isRevealed = i + 1 <= revealed;
            const isWinner = isRevealed && row.rank === 1 && row.count > 0;
            return isRevealed ? (
              <ResultRow
                key={row.pitch.id}
                rank={row.rank}
                row={row}
                isWinner={isWinner}
              />
            ) : (
              <PlaceholderRow key={`placeholder-${i}`} />
            );
          })}
          {showAll &&
            rest.map((row) => (
              <ResultRow
                key={row.pitch.id}
                rank={row.rank}
                row={row}
                isWinner={false}
              />
            ))}
        </ul>
      </div>
    </div>
  );
}

// Placeholder row masks rank, title, description, and count so the audience
// can't infer ties from the unrevealed slots. They can still count *how many*
// reveals are coming because each placeholder is a row, but they won't see
// e.g. "1, 1" before the trophies appear and spoil a co-winner.
function PlaceholderRow() {
  return (
    <li className="card !p-5 opacity-70">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center font-display text-3xl font-bold bg-white/10 text-white/40">
          ?
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <div className="font-display text-2xl font-bold truncate text-white/40 tracking-[0.3em] animate-pulse-slow">
              • • •
            </div>
            <div className="text-right">
              <div className="font-display text-3xl font-bold tabular-nums text-white/30">
                ?
              </div>
              <div className="text-xs text-white/30 uppercase tracking-widest">
                pending
              </div>
            </div>
          </div>
          <div className="mt-3 h-3 rounded-full bg-white/10 overflow-hidden" />
        </div>
      </div>
    </li>
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
      data-pitch-id={row.pitch.id}
      className={`card !p-5 ${
        isWinner ? "ring-2 ring-brand-mint/70 shadow-xl shadow-brand-mint/30" : ""
      }`}
    >
      <div className="flex items-center gap-4">
        <div
          className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center font-display text-3xl font-bold ${
            isWinner
              ? "bg-gradient-to-br from-brand-mint to-brand-teal text-brand-navy"
              : "bg-white/10"
          }`}
        >
          {isWinner ? "🏆" : rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <div className="font-display text-2xl font-bold truncate">{row.pitch.title}</div>
            <div className="text-right">
              <div className="font-display text-3xl font-bold tabular-nums">
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
              className="bar-fill h-full rounded-full bg-gradient-to-r from-brand-blue via-brand-subtle-blue to-brand-mint"
              style={{ ["--tw-bar" as any]: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </li>
  );
}

// Targeted confetti for a result row. Falls back to a generic top-of-screen
// burst if the row hasn't laid out yet (e.g. race with the same-frame mount).
function fireResultConfetti(pitchId: string, intensity: "full" | "soft" = "full") {
  const el = document.querySelector<HTMLElement>(`[data-pitch-id="${pitchId}"]`);
  const origin = el ? originFromElement(el) : { x: 0.5, y: 0.45 };
  const isFull = intensity === "full";
  confetti({
    particleCount: isFull ? 110 : 40,
    spread: isFull ? 85 : 60,
    startVelocity: isFull ? 48 : 30,
    ticks: isFull ? 240 : 160,
    gravity: 0.85,
    scalar: isFull ? 1.0 : 0.8,
    origin,
    colors: CONFETTI_COLORS_SELECT,
    disableForReducedMotion: true,
  });
}

// Tally types and computeTally moved to lib/tally.ts so the voter mobile
// view stays in lockstep with the display presentation.
