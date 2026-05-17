"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveState } from "@/lib/useLiveState";
import {
  adminFetch,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from "@/lib/client";
import type { Pitch, PollState, PollStatus } from "@/lib/store";
import { computeTally, effectiveTopLimit } from "@/lib/tally";

export default function AdminPage() {
  const state = useLiveState();
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(true);

  useEffect(() => {
    const t = getAdminToken();
    if (!t) {
      setVerifying(false);
      return;
    }
    setToken(t);
    fetch("/api/admin/verify", {
      method: "POST",
      headers: { "x-admin-token": t },
    })
      .then((res) => {
        if (res.ok) setAuthed(true);
        else clearAdminToken();
      })
      .catch(() => clearAdminToken())
      .finally(() => setVerifying(false));
  }, []);

  async function tryUnlock() {
    const trimmed = token.trim();
    if (!trimmed) {
      setAuthError("Enter a token.");
      return;
    }
    setAuthError(null);
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "x-admin-token": trimmed },
      });
      if (res.ok) {
        setAdminToken(trimmed);
        setAuthed(true);
      } else if (res.status === 401) {
        setAuthError("Invalid token.");
      } else {
        setAuthError(`Server error (${res.status}).`);
      }
    } catch (e: any) {
      setAuthError(e?.message ?? "Network error");
    }
  }

  if (verifying) {
    return (
      <div className="min-h-screen bg-aurora flex items-center justify-center p-6">
        <div className="text-white/50 text-sm">Checking session…</div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-aurora flex items-center justify-center p-6">
        <div className="card max-w-sm w-full">
          <h1 className="text-xl font-bold">Admin Login</h1>
          <p className="text-sm text-white/60 mt-1">
            Enter the admin token set on the server.
          </p>
          <input
            className="input mt-4"
            placeholder="ADMIN_TOKEN"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void tryUnlock();
            }}
            autoFocus
          />
          {authError && (
            <div className="mt-3 text-sm text-red-300 bg-red-500/10 rounded-lg p-2 border border-red-500/30">
              {authError}
            </div>
          )}
          <button className="btn-primary mt-4 w-full" onClick={() => void tryUnlock()}>
            Unlock
          </button>
        </div>
      </div>
    );
  }

  return <AdminConsole state={state} onSignOut={() => {
    clearAdminToken();
    setAuthed(false);
    setToken("");
  }} />;
}

function AdminConsole({
  state,
  onSignOut,
}: {
  state: ReturnType<typeof useLiveState>;
  onSignOut: () => void;
}) {
  return (
    <main className="min-h-screen bg-aurora">
      <div className="max-w-3xl mx-auto px-4 pt-6 pb-24 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold">Admin Console</h1>
            <p className="text-xs text-white/50">
              Mic operator · poll controls · manual overrides
            </p>
          </div>
          <button className="btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </header>

        <MicSection recording={!!state?.recording} liveTranscript={state?.liveTranscript ?? ""} analyzing={!!state?.analyzing} />
        <PitchesSection
          pitches={state?.pitches ?? []}
          historyCount={state?.historyCount ?? 0}
          lastSnapshot={state?.lastSnapshot ?? null}
        />
        <PollControls
          status={state?.pollStatus ?? "draft"}
          voterCount={state?.voterCount ?? 0}
          hasPitches={(state?.pitches?.length ?? 0) > 0}
        />
        <ResultsRevealSection
          status={state?.pollStatus ?? "draft"}
          state={state}
          revealLimit={state?.revealLimit ?? 3}
          revealedCount={state?.revealedCount ?? 0}
          showAllResults={state?.showAllResults ?? false}
        />
        <LinksSection />
      </div>
    </main>
  );
}

/* -------------------------- Mic / Transcription -------------------------- */

function MicSection({
  recording,
  liveTranscript,
  analyzing,
}: {
  recording: boolean;
  liveTranscript: string;
  analyzing: boolean;
}) {
  const [localRec, setLocalRec] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Mirror of `starting` for synchronous re-entrancy checks. State is
  // batched, so two clicks in the same tick would both see starting=false.
  const startingRef = useRef(false);
  // Bumped on every stop()/cleanup. start() captures its generation and
  // bails out of the rest of the SDP/track wiring if it changes mid-flight,
  // so a Stop click during the SDP exchange actually wins.
  const sessionGen = useRef(0);
  const segmentStartedAt = useRef<number>(0);
  // Cumulative partial transcript for the in-progress utterance. Resets on
  // each speech_started; replaced by the committed text on completed.
  const partialBufferRef = useRef<string>("");

  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the server signals recording=false (e.g. someone opened voting and the
  // /api/poll handler flipped recording off) while we're still locally
  // recording, tear the WebRTC peer down. Otherwise the mic would keep
  // streaming even though the rest of the app considers the session over.
  useEffect(() => {
    if (!recording && localRec) {
      cleanup();
      setLocalRec(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // Each step is independent so a throw in one doesn't skip the rest. Stop
  // tracks via every reference we have -- some browsers won't release the
  // OS-level mic indicator until every holder of the track has called stop().
  function cleanup() {
    sessionGen.current++;
    startingRef.current = false;
    const pc = pcRef.current;
    const dc = dcRef.current;
    const stream = streamRef.current;
    pcRef.current = null;
    dcRef.current = null;
    streamRef.current = null;
    try { dc?.close(); } catch {}
    try { pc?.getSenders().forEach((s) => s.track?.stop()); } catch {}
    try { pc?.getReceivers().forEach((r) => r.track?.stop()); } catch {}
    try { pc?.getTransceivers().forEach((t) => { try { t.stop(); } catch {} }); } catch {}
    try { pc?.close(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  }

  async function start() {
    // Re-entrancy guard. Without this, an impatient operator double-clicking
    // Start during the SDP exchange would orphan the first stream (refs get
    // overwritten by the second call) and the mic would stay on forever
    // even after Stop.
    if (startingRef.current || pcRef.current || streamRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setErr(null);
    const myGen = ++sessionGen.current;
    let stream: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    try {
      // 1. Mint an ephemeral session token from our server.
      const session = await adminFetch("/api/realtime-session", {
        method: "POST",
      });
      if (myGen !== sessionGen.current) return; // cancelled
      const ephemeralKey: string | undefined =
        session?.client_secret?.value ??
        session?.client_secret ??
        undefined;
      if (!ephemeralKey) throw new Error("No ephemeral key in session response");

      // 2. Get the mic.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      // If Stop was clicked while we were waiting on the permission prompt
      // or device init, drop this stream right away -- otherwise the mic
      // LED stays on with no UI affordance to release it.
      if (myGen !== sessionGen.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      // 3. Set up the peer connection.
      pc = new RTCPeerConnection();
      pcRef.current = pc;
      const track = stream.getAudioTracks()[0];
      pc.addTrack(track, stream);

      // 4. Data channel for JSON events from OpenAI.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        // Nothing to do -- server session already configured by our mint call.
      };
      dc.onmessage = (ev) => handleRealtimeEvent(ev.data);
      dc.onerror = (e) => console.error("dc error", e);

      // 5. Create & send offer.
      const offer = await pc.createOffer();
      if (myGen !== sessionGen.current) return;
      await pc.setLocalDescription(offer);
      if (myGen !== sessionGen.current) return;
      const sdpResp = await fetch(
        `https://api.openai.com/v1/realtime?intent=transcription`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1",
          },
        },
      );
      if (myGen !== sessionGen.current) return;
      if (!sdpResp.ok) {
        const text = await sdpResp.text();
        throw new Error(`OpenAI SDP ${sdpResp.status}: ${text}`);
      }
      const answerSdp = await sdpResp.text();
      if (myGen !== sessionGen.current) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      if (myGen !== sessionGen.current) return;

      setLocalRec(true);
      void adminFetch("/api/transcript", {
        method: "POST",
        body: JSON.stringify({ kind: "recording", recording: true }),
      });
    } catch (e: any) {
      console.error(e);
      if (myGen === sessionGen.current) {
        setErr(e?.message ?? String(e));
      }
      // Manual cleanup of locals in case refs were never assigned (early
      // failure before we wired pcRef/streamRef).
      try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
      try { pc?.close(); } catch {}
      cleanup();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  async function stop() {
    // Update UI immediately so an impatient operator doesn't keep clicking
    // (and so Stop wins even if the start POST hasn't reached the server yet).
    setLocalRec(false);
    setStarting(false);
    cleanup();
    try {
      await adminFetch("/api/transcript", {
        method: "POST",
        body: JSON.stringify({ kind: "recording", recording: false }),
      });
    } catch {}
  }

  function handleRealtimeEvent(raw: string) {
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    // See https://platform.openai.com/docs/api-reference/realtime-server-events
    switch (evt.type) {
      case "input_audio_buffer.speech_started":
        segmentStartedAt.current = Date.now();
        partialBufferRef.current = "";
        break;
      case "conversation.item.input_audio_transcription.delta": {
        // Each delta is the new fragment, NOT the cumulative text. Accumulate
        // and send the running buffer so the live transcript reads naturally
        // instead of flashing single words.
        const fragment: string = evt.delta ?? "";
        if (fragment) {
          partialBufferRef.current += fragment;
          void adminFetch("/api/transcript", {
            method: "POST",
            body: JSON.stringify({
              kind: "live",
              text: partialBufferRef.current,
            }),
          }).catch(() => {});
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = evt.transcript ?? "";
        const startedAt = segmentStartedAt.current || Date.now();
        segmentStartedAt.current = 0;
        partialBufferRef.current = "";
        if (text) {
          void adminFetch("/api/transcript", {
            method: "POST",
            body: JSON.stringify({
              kind: "segment",
              text,
              startedAt,
              endedAt: Date.now(),
            }),
          }).catch(() => {});
        }
        break;
      }
      case "error":
        console.error("realtime error event", evt);
        setErr(evt.error?.message ?? "Realtime error");
        break;
    }
  }

  // Pill reflects ground truth (either local session or server says recording).
  // Button state is driven by local intent so Stop wins immediately, without
  // waiting for the SSE round-trip on the recording=false POST.
  const isRecording = localRec || recording;
  const showStop = localRec || starting;

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Microphone</h2>
          <p className="text-xs text-white/50">
            Streams to OpenAI `gpt-4o-transcribe`. `gpt-5.4-mini` analyzes the
            rolling transcript and writes pitches live.
          </p>
        </div>
        <div className="text-right">
          {isRecording ? (
            <span className="pulse-dot text-red-300 font-semibold">LIVE</span>
          ) : starting ? (
            <span className="text-white/60 text-sm">Connecting…</span>
          ) : (
            <span className="text-white/50 text-sm">Idle</span>
          )}
          {analyzing && (
            <div className="text-[11px] text-brand-mint/80 mt-1">
              Analyzing transcript…
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        {!showStop ? (
          <button className="btn-primary flex-1" onClick={start}>
            🎙️ Start recording
          </button>
        ) : (
          <button className="btn-danger flex-1" onClick={stop}>
            {starting && !localRec ? "Cancel" : "■ Stop recording"}
          </button>
        )}
      </div>
      {err && (
        <div className="mt-3 text-sm text-red-300 bg-red-500/10 rounded-lg p-2 border border-red-500/30">
          {err}
        </div>
      )}
      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-widest text-white/40 mb-1">
          Live transcript
        </div>
        <div className="min-h-[4rem] max-h-40 overflow-y-auto scrollbar-thin rounded-lg bg-black/30 p-3 text-sm text-white/80">
          {liveTranscript ? (
            <span className="italic">{liveTranscript}</span>
          ) : (
            <span className="text-white/30">
              Transcript will appear here as people speak…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- Pitches ------------------------------- */

function PitchesSection({
  pitches,
  historyCount,
  lastSnapshot,
}: {
  pitches: Pitch[];
  historyCount: number;
  lastSnapshot: { label: string; at: number } | null;
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [undoFlash, setUndoFlash] = useState<string | null>(null);
  const sorted = useMemo(
    () => [...pitches].sort((a, b) => a.order - b.order),
    [pitches],
  );

  async function submitAdd() {
    if (!newTitle.trim()) return;
    await adminFetch("/api/pitch", {
      method: "POST",
      body: JSON.stringify({ title: newTitle, description: newDesc }),
    });
    setNewTitle("");
    setNewDesc("");
    setAdding(false);
  }

  async function clearTranscript() {
    if (!confirm("Clear the rolling transcript buffer? (Pitches stay.)")) return;
    await adminFetch("/api/transcript", { method: "DELETE" });
  }

  async function undo() {
    if (historyCount === 0) return;
    const label = lastSnapshot?.label ?? "previous state";
    if (!confirm(`Undo "${label}"? Pitches and ballots will be rolled back to the moment before that change.`))
      return;
    try {
      const res: { ok?: boolean; restored?: { label: string } } = await adminFetch(
        "/api/pitch/undo",
        { method: "POST" },
      );
      if (res?.ok && res.restored) {
        setUndoFlash(`Restored: ${res.restored.label}`);
        setTimeout(() => setUndoFlash(null), 3500);
      }
    } catch (e: any) {
      alert(e?.message ?? "Undo failed");
    }
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Pitches ({sorted.length})</h2>
          <p className="text-xs text-white/50">
            AI writes these live. Tap any pitch to edit — your edit locks it.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost"
            onClick={undo}
            disabled={historyCount === 0}
            title={
              lastSnapshot
                ? `Undo: ${lastSnapshot.label} (${formatRelativeTime(lastSnapshot.at)})`
                : "Nothing to undo"
            }
          >
            ↶ Undo{historyCount > 0 ? ` (${historyCount})` : ""}
          </button>
          <button className="btn-ghost" onClick={clearTranscript}>
            Clear transcript
          </button>
          <button className="btn-primary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "+ Add"}
          </button>
        </div>
      </div>
      {undoFlash && (
        <div className="mt-3 text-xs text-brand-mint bg-brand-mint/10 rounded-lg p-2 border border-brand-mint/30">
          {undoFlash}
        </div>
      )}

      {adding && (
        <div className="mt-4 space-y-2">
          <input
            className="input"
            placeholder="Title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <input
            className="input"
            placeholder="Description"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
          />
          <button className="btn-primary w-full" onClick={submitAdd}>
            Add pitch
          </button>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {sorted.length === 0 && (
          <li className="text-sm text-white/40 italic">
            No pitches yet. Start the mic — they'll appear automatically.
          </li>
        )}
        {sorted.map((p, i) => (
          <PitchRow key={p.id} index={i + 1} pitch={p} />
        ))}
      </ul>
    </section>
  );
}

function PitchRow({ index, pitch }: { index: number; pitch: Pitch }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(pitch.title);
  const [d, setD] = useState(pitch.description);

  useEffect(() => {
    if (!editing) {
      setT(pitch.title);
      setD(pitch.description);
    }
  }, [pitch.title, pitch.description, editing]);

  async function save() {
    await adminFetch(`/api/pitch/${pitch.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: t, description: d }),
    });
    setEditing(false);
  }
  async function del() {
    if (!confirm(`Delete "${pitch.title}"?`)) return;
    await adminFetch(`/api/pitch/${pitch.id}`, { method: "DELETE" });
  }
  async function toggleStatus() {
    await adminFetch(`/api/pitch/${pitch.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: pitch.status === "completed" ? "in_progress" : "completed",
      }),
    });
  }

  return (
    <li className="rounded-xl bg-black/25 border border-white/10 p-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold">
          {index}
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                className="input"
                value={t}
                onChange={(e) => setT(e.target.value)}
              />
              <textarea
                className="input"
                rows={2}
                value={d}
                onChange={(e) => setD(e.target.value)}
              />
              <div className="flex gap-2">
                <button className="btn-primary" onClick={save}>
                  Save
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="font-semibold truncate">{pitch.title}</div>
                <StatusBadge status={pitch.status} locked={!!pitch.locked} />
              </div>
              <div className="text-sm text-white/70 mt-0.5">
                {pitch.description}
              </div>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex flex-col gap-1">
            <button
              className="btn-ghost !px-2 !py-1 text-xs"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              className="btn-ghost !px-2 !py-1 text-xs"
              onClick={toggleStatus}
            >
              {pitch.status === "completed" ? "Reopen" : "Done"}
            </button>
            <button
              className="btn-danger !px-2 !py-1 text-xs"
              onClick={del}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function StatusBadge({
  status,
  locked,
}: {
  status: "in_progress" | "completed";
  locked: boolean;
}) {
  const cls =
    status === "in_progress"
      ? "bg-brand-mint/20 text-brand-mint border-brand-mint/40"
      : "bg-brand-teal/20 text-brand-teal border-brand-teal/40";
  return (
    <span className="flex items-center gap-1">
      <span className={`text-[10px] uppercase tracking-widest rounded-full px-2 py-0.5 border ${cls}`}>
        {status === "in_progress" ? "live" : "done"}
      </span>
      {locked && (
        <span className="text-[10px] text-white/50" title="Locked (admin edited)">
          🔒
        </span>
      )}
    </span>
  );
}

/* ----------------------------- Poll Controls ----------------------------- */

function PollControls({
  status,
  voterCount,
  hasPitches,
}: {
  status: PollStatus;
  voterCount: number;
  hasPitches: boolean;
}) {
  async function setStatus(next: PollStatus) {
    // Going to draft or re-opening voting wipes existing ballots server-side.
    // Confirm before destroying real votes -- nothing to confirm if voterCount
    // is 0 (typical first-open path during the event).
    const willClearVotes =
      (next === "draft" || next === "open") && voterCount > 0;
    if (willClearVotes) {
      const ok = confirm(
        `This will reset all ${voterCount} ballot${voterCount === 1 ? "" : "s"}. Continue?`,
      );
      if (!ok) return;
    }
    await adminFetch("/api/poll", {
      method: "POST",
      body: JSON.stringify({ status: next }),
    });
  }
  const stages: { key: PollStatus; label: string; hint: string }[] = [
    { key: "draft", label: "Draft", hint: "Pitches only; voting off" },
    { key: "open", label: "Open Voting", hint: "Voters can submit" },
    { key: "closed", label: "Close Voting", hint: "No more submissions" },
    { key: "results", label: "Reveal Results", hint: "Show tally on display" },
  ];
  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Poll Stage</h2>
          <p className="text-xs text-white/50">
            Current: <b className="text-white/80">{status.toUpperCase()}</b> ·{" "}
            {voterCount} ballot{voterCount === 1 ? "" : "s"} received
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {stages.map((s) => {
          const active = status === s.key;
          const disabled = s.key !== "draft" && !hasPitches;
          return (
            <button
              key={s.key}
              disabled={disabled}
              onClick={() => setStatus(s.key)}
              className={`rounded-xl p-3 text-left border transition ${
                active
                  ? "bg-gradient-to-r from-brand-blue/40 to-brand-subtle-blue/40 border-brand-blue/50"
                  : "bg-white/5 hover:bg-white/10 border-white/10"
              } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              <div className="font-semibold">{s.label}</div>
              <div className="text-xs text-white/60 mt-0.5">{s.hint}</div>
            </button>
          );
        })}
      </div>
      {status === "open" && (
        <div className="mt-3 text-xs text-brand-mint/80">
          Voting is live. The display is showing the voter count as ballots
          come in.
        </div>
      )}
    </section>
  );
}

/* --------------------------- Results Reveal -------------------------- */

function ResultsRevealSection({
  status,
  state,
  revealLimit,
  revealedCount,
  showAllResults,
}: {
  status: PollStatus;
  state: PollState | null;
  revealLimit: number;
  revealedCount: number;
  showAllResults: boolean;
}) {
  const pitchCount = state?.pitches?.length ?? 0;
  // Compute the *true* effective limit using the live tally so the admin sees
  // the same grouping that the display/vote pages will use. When ties straddle
  // the cutoff, this is larger than the raw revealLimit -- e.g. revealLimit=2
  // against [10, 8, 8, 5] expands to 3 so both rank-2 entries land together.
  const tally = useMemo(
    () => (state ? computeTally(state) : []),
    [state],
  );
  const effectiveLimit = useMemo(
    () => effectiveTopLimit(tally, revealLimit),
    [tally, revealLimit],
  );
  const tiesExpanded = effectiveLimit > Math.min(revealLimit, pitchCount);
  const isResults = status === "results";
  const allTopRevealed = revealedCount >= effectiveLimit;
  const hasRest = pitchCount > effectiveLimit;

  async function setLimit(next: number) {
    await adminFetch("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ revealLimit: next }),
    });
  }
  async function revealNext() {
    await adminFetch("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ revealedCount: revealedCount + 1 }),
    });
  }
  async function showAll() {
    await adminFetch("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ showAllResults: true }),
    });
  }
  async function resetReveal() {
    await adminFetch("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ revealedCount: 0, showAllResults: false }),
    });
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">Results Reveal</h2>
          <p className="text-xs text-white/50">
            Stage how many top results show up first. The rest stay hidden
            unless you opt in. Adjust any time -- before, during, or after
            pitching.
          </p>
        </div>
        <div className="text-right shrink-0">
          {isResults ? (
            <span className="text-xs text-white/60">
              Revealed{" "}
              <b className="text-white/90">{Math.min(revealedCount, effectiveLimit)}</b>
              {" "}of{" "}
              <b className="text-white/90">{effectiveLimit}</b>
              {showAllResults && hasRest ? " · all shown" : ""}
            </span>
          ) : (
            <span className="text-xs text-white/40">
              Reveal controls activate at the results stage
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <label className="text-sm text-white/70">Show top</label>
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            aria-label="Show one fewer result"
            className="btn-ghost !px-3 !py-1.5 text-lg leading-none"
            disabled={revealLimit <= 1}
            onClick={() => void setLimit(revealLimit - 1)}
          >
            −
          </button>
          <div className="font-display text-2xl font-bold w-10 text-center tabular-nums">
            {revealLimit}
          </div>
          <button
            type="button"
            aria-label="Show one more result"
            className="btn-ghost !px-3 !py-1.5 text-lg leading-none"
            disabled={revealLimit >= 100}
            onClick={() => void setLimit(revealLimit + 1)}
          >
            +
          </button>
        </div>
        <span className="text-sm text-white/60">
          {pitchCount === 0
            ? "(no pitches yet)"
            : `of ${pitchCount} pitch${pitchCount === 1 ? "" : "es"}`}
          {tiesExpanded && (
            <span className="text-brand-mint/80">
              {" "}· showing {effectiveLimit} (ties grouped)
            </span>
          )}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          className="btn-primary"
          disabled={!isResults || allTopRevealed || effectiveLimit === 0}
          onClick={() => void revealNext()}
        >
          {effectiveLimit === 0
            ? "No pitches"
            : allTopRevealed
              ? "Top revealed"
              : `Reveal #${Math.min(revealedCount + 1, effectiveLimit)}`}
        </button>
        <button
          className="btn-accent"
          disabled={!isResults || !allTopRevealed || !hasRest || showAllResults}
          onClick={() => void showAll()}
          title={hasRest ? "Reveal everyone below the top" : "No pitches below the top"}
        >
          {showAllResults ? "All shown" : "Show remaining"}
        </button>
        <button
          className="btn-ghost"
          disabled={!isResults || effectiveLimit === 0}
          onClick={() => void resetReveal()}
        >
          Reset reveal
        </button>
      </div>
    </section>
  );
}

// Compact "12s ago" / "3m ago" label for the undo tooltip.
function formatRelativeTime(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

/* ------------------------------ Links/QR tips ------------------------------ */

function LinksSection() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  if (!origin) return null;
  return (
    <section className="card">
      <h2 className="text-lg font-bold">Event URLs</h2>
      <ul className="mt-2 text-sm space-y-1 text-white/80">
        <li>
          Display (projector):{" "}
          <a className="text-brand-mint underline" href="/display" target="_blank">
            {origin}/display
          </a>
        </li>
        <li>
          Voter page (QR target):{" "}
          <a className="text-brand-mint underline" href="/vote" target="_blank">
            {origin}/vote
          </a>
        </li>
      </ul>
    </section>
  );
}
