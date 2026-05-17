import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setState, snapshotPitches, store } from "@/lib/store";

export const runtime = "nodejs";

// PATCH /api/pitch/:id  body: { title?, description?, status? }
// Admin edits always lock the pitch so the analyzer won't overwrite it.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = requireAdmin(req);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const target = store.state.pitches.find((p) => p.id === params.id);
  if (target) snapshotPitches(`admin edit: ${target.title}`);
  setState((s) => {
    const p = s.pitches.find((x) => x.id === params.id);
    if (!p) return;
    if (typeof body.title === "string") p.title = body.title.slice(0, 80);
    if (typeof body.description === "string")
      p.description = body.description.slice(0, 240);
    if (body.status === "completed" || body.status === "in_progress") {
      p.status = body.status;
      if (body.status === "completed" && !p.endedAt) p.endedAt = Date.now();
    }
    p.locked = true;
  });
  return Response.json({ ok: true });
}

// Buffer (ms) on either side of a deleted pitch's time window when pruning
// transcript segments. The pitch's startedAt/endedAt are server timestamps
// from when the analyzer first/last touched the pitch; the underlying speech
// can extend slightly past those marks. 8s catches the boundary chatter
// without nuking unrelated adjacent content.
const DELETE_SEGMENT_BUFFER_MS = 8_000;

// DELETE /api/pitch/:id
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  const target = store.state.pitches.find((p) => p.id === params.id);
  if (target) snapshotPitches(`admin delete: ${target.title}`);
  setState((s) => {
    const deleted = s.pitches.find((p) => p.id === params.id);
    s.pitches = s.pitches.filter((p) => p.id !== params.id);
    for (const voter of Object.keys(s.votes)) {
      s.votes[voter] = s.votes[voter].filter((pid) => pid !== params.id);
    }
    if (!deleted) return;

    // Tombstone the title so the analyzer's prompt explicitly tells it not
    // to re-create. Survives even after the audio is gone from the window,
    // protecting against reintroduction from late-arriving segments.
    const title = deleted.title.trim();
    if (title && !s._deletedTitles.includes(title)) {
      s._deletedTitles.push(title);
      if (s._deletedTitles.length > 30) {
        s._deletedTitles = s._deletedTitles.slice(-30);
      }
    }

    // Also remove transcript segments overlapping the deleted pitch's time
    // window. Without this, the analyzer can re-create the pitch from the
    // same audio with a slightly paraphrased title that bypasses the
    // tombstone. Belt-and-braces.
    const winStart = deleted.startedAt - DELETE_SEGMENT_BUFFER_MS;
    const winEnd = (deleted.endedAt ?? Date.now()) + DELETE_SEGMENT_BUFFER_MS;
    s._segments = s._segments.filter(
      (seg) => seg.endedAt < winStart || seg.startedAt > winEnd,
    );
  });
  return Response.json({ ok: true });
}
