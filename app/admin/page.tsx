"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveState } from "@/lib/useLiveState";
import {
  adminFetch,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from "@/lib/client";
import type { Pitch, PollStatus } from "@/lib/store";

export default function AdminPage() {
  const state = useLiveState();
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const t = getAdminToken();
    if (t) {
      setToken(t);
      setAuthed(true);
    }
  }, []);

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
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          <button
            className="btn-primary mt-4 w-full"
            onClick={() => {
              setAdminToken(token.trim());
              setAuthed(true);
            }}
          >
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
            <h1 className="text-2xl font-bold">Admin Console</h1>
            <p className="text-xs text-white/50">
              Mic operator · poll controls · manual overrides
            </p>
          </div>
          <button className="btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </header>

        <MicSection recording={!!state?.recording} liveTranscript={state?.liveTranscript ?? ""} analyzing={!!state?.analyzing} />
        <PitchesSection pitches={state?.pitches ?? []} />
        <PollControls
          status={state?.pollStatus ?? "draft"}
          voterCount={state?.voterCount ?? 0}
          hasPitches={(state?.pitches?.length ?? 0) > 0}
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
  const [err, setErr] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const segmentStartedAt = useRef<number>(0);

  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.getSenders().forEach((s) => s.track?.stop());
      pcRef.current?.close();
    } catch {}
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    pcRef.current = null;
    dcRef.current = null;
    streamRef.current = null;
  }

  async function start() {
    setErr(null);
    try {
      // 1. Mint an ephemeral session token from our server.
      const session = await adminFetch("/api/realtime-session", {
        method: "POST",
      });
      const ephemeralKey: string | undefined =
        session?.client_secret?.value ??
        session?.client_secret ??
        undefined;
      if (!ephemeralKey) throw new Error("No ephemeral key in session response");

      // 2. Get the mic.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      // 3. Set up the peer connection.
      const pc = new RTCPeerConnection();
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
      await pc.setLocalDescription(offer);
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
      if (!sdpResp.ok) {
        const text = await sdpResp.text();
        throw new Error(`OpenAI SDP ${sdpResp.status}: ${text}`);
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setLocalRec(true);
      void adminFetch("/api/transcript", {
        method: "POST",
        body: JSON.stringify({ kind: "recording", recording: true }),
      });
    } catch (e: any) {
      console.error(e);
      setErr(e?.message ?? String(e));
      cleanup();
    }
  }

  async function stop() {
    cleanup();
    setLocalRec(false);
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
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const partial =
          evt.delta ?? evt.transcript ?? "";
        if (partial) {
          // Debounced POST; live updates are coalesced server-side.
          void adminFetch("/api/transcript", {
            method: "POST",
            body: JSON.stringify({ kind: "live", text: partial }),
          }).catch(() => {});
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = evt.transcript ?? "";
        const startedAt = segmentStartedAt.current || Date.now();
        segmentStartedAt.current = 0;
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

  const isRecording = localRec || recording;

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Microphone</h2>
          <p className="text-xs text-white/50">
            Streams to OpenAI `gpt-4o-transcribe`. Claude analyzes the rolling
            transcript and writes pitches live.
          </p>
        </div>
        <div className="text-right">
          {isRecording ? (
            <span className="pulse-dot text-red-300 font-semibold">LIVE</span>
          ) : (
            <span className="text-white/50 text-sm">Idle</span>
          )}
          {analyzing && (
            <div className="text-[11px] text-fuchsia-300/80 mt-1">
              Analyzing transcript…
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        {!isRecording ? (
          <button className="btn-primary flex-1" onClick={start}>
            🎙️ Start recording
          </button>
        ) : (
          <button className="btn-danger flex-1" onClick={stop}>
            ■ Stop recording
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

function PitchesSection({ pitches }: { pitches: Pitch[] }) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
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
          <button className="btn-ghost" onClick={clearTranscript}>
            Clear transcript
          </button>
          <button className="btn-primary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Cancel" : "+ Add"}
          </button>
        </div>
      </div>

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
      ? "bg-amber-500/20 text-amber-200 border-amber-400/30"
      : "bg-emerald-500/20 text-emerald-200 border-emerald-400/30";
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
                  ? "bg-gradient-to-r from-fuchsia-500/40 to-violet-500/40 border-fuchsia-300/40"
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
        <div className="mt-3 text-xs text-emerald-300/80">
          Voting is live. The display is showing the voter count as ballots
          come in.
        </div>
      )}
    </section>
  );
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
          <a className="text-fuchsia-300 underline" href="/display" target="_blank">
            {origin}/display
          </a>
        </li>
        <li>
          Voter page (QR target):{" "}
          <a className="text-fuchsia-300 underline" href="/vote" target="_blank">
            {origin}/vote
          </a>
        </li>
      </ul>
    </section>
  );
}
