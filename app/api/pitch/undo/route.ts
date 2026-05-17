import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { undoLastPitchChange } from "@/lib/store";

export const runtime = "nodejs";

// POST /api/pitch/undo  -- pop the latest pitch snapshot and restore.
// Restores pitches + votes + voterCount to the moment before the most
// recent pitch-mutating change. Does NOT roll back _deletedTitles (see
// undoLastPitchChange in lib/store).
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  const restored = undoLastPitchChange();
  if (!restored) {
    return Response.json({ ok: false, error: "no history" }, { status: 409 });
  }
  return Response.json({ ok: true, restored });
}
