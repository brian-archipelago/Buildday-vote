import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { genId, setState, store } from "@/lib/store";
import { ensureAnalyzerTimer, maybeTriggerAnalyzer } from "@/lib/analyzer";

export const runtime = "nodejs";

// POST /api/transcript
// Body variants:
//   { kind: "segment", text: string, startedAt?: number, endedAt?: number }
//     -> a completed transcript segment from OpenAI's realtime transcription.
//   { kind: "live", text: string }
//     -> the current partial/interim transcript of the in-progress utterance.
//        Shown to admin for confidence but NOT fed to analyzer.
//   { kind: "recording", recording: boolean }
//     -> mic session start/stop toggle.
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const kind = body?.kind;
  const now = Date.now();

  if (kind === "live") {
    const text = String(body.text ?? "").slice(0, 2000);
    setState((s) => {
      s.liveTranscript = text;
    });
    return Response.json({ ok: true });
  }

  if (kind === "recording") {
    const recording = !!body.recording;
    setState((s) => {
      s.recording = recording;
      if (!recording) s.liveTranscript = "";
    });
    return Response.json({ ok: true });
  }

  if (kind === "segment") {
    const text = String(body.text ?? "").trim();
    if (!text) return Response.json({ ok: true, skipped: "empty" });
    const startedAt = Number.isFinite(body.startedAt)
      ? Math.min(Number(body.startedAt), now)
      : now;
    const endedAt = Number.isFinite(body.endedAt)
      ? Math.min(Number(body.endedAt), now)
      : now;
    setState((s) => {
      s._segments.push({
        id: genId(),
        text,
        startedAt,
        endedAt,
      });
      s._transcriptSinceLastAnalyze += text.length;
      s.liveTranscript = "";
    });
    ensureAnalyzerTimer();
    maybeTriggerAnalyzer();
    return Response.json({ ok: true, segments: store.state._segments.length });
  }

  return Response.json({ error: "unknown kind" }, { status: 400 });
}

// DELETE /api/transcript  -- admin nukes the rolling window (fresh start).
export async function DELETE(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  setState((s) => {
    s._segments = [];
    s.liveTranscript = "";
    s._lastAnalyzedAt = 0;
    s._transcriptSinceLastAnalyze = 0;
  });
  return Response.json({ ok: true });
}
