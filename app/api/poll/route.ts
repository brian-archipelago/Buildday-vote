import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setState, snapshotPitches, store, type PollStatus } from "@/lib/store";

export const runtime = "nodejs";

const VALID: PollStatus[] = ["draft", "open", "closed", "results"];

// POST /api/poll  body: { status: "draft"|"open"|"closed"|"results" }
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const status = body.status as PollStatus;
  if (!VALID.includes(status)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }
  // Snapshot before any stage transition that touches pitches or votes:
  // - draft/open both wipe ballots
  // - open/closed/results lock the pitch list and force in-progress to
  //   completed
  // Skipping a no-op transition (re-clicking the current stage) avoids
  // bloating the undo stack with churn-free snapshots.
  if (store.state.pollStatus !== status) {
    snapshotPitches(`stage: ${store.state.pollStatus} -> ${status}`);
  }
  setState((s) => {
    const wasResults = s.pollStatus === "results";
    s.pollStatus = status;
    if (status === "draft") {
      // Resetting back to draft clears prior votes.
      s.votes = {};
      s.voterCount = 0;
    }
    if (status === "open") {
      // Opening voting freezes the pitch list -- voters need a stable set
      // of options. Clear prior votes from any earlier draft cycle.
      s.votes = {};
      s.voterCount = 0;
    }
    if (status === "open" || status === "closed" || status === "results") {
      // Pitching is over (or about to be). Force any in-progress pitches
      // to completed and lock the whole list so the analyzer stops
      // mutating it and the "live" badge clears from the UI.
      const now = Date.now();
      for (const p of s.pitches) {
        if (p.status === "in_progress") {
          p.status = "completed";
          if (!p.endedAt) p.endedAt = now;
        }
        p.locked = true;
      }
      // Mic should be off too -- nothing left to transcribe. The admin's
      // browser observes this via SSE and tears down its WebRTC peer.
      s.recording = false;
      s.liveTranscript = "";
    }
    if (status === "results" && !wasResults) {
      // Entering results: every slot starts as a placeholder. Admin drives
      // each reveal manually via "Reveal #N" so the room can build a
      // moment around it instead of #1 popping the second they hit
      // "Reveal Results". "Show all" stays off until admin opts in.
      s.revealedCount = 0;
      s.showAllResults = false;
    }
  });
  return Response.json({ ok: true });
}
