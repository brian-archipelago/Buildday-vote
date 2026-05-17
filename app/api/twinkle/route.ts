import { NextRequest } from "next/server";
import { emitTwinkle, store } from "@/lib/store";

export const runtime = "nodejs";

// Per-voter rate limit: at most one twinkle every MIN_GAP_MS.
const MIN_GAP_MS = 50;
const lastByVoter = new Map<string, number>();

// Bound the map so a flood of unique voter ids can't grow it indefinitely.
const MAX_VOTERS_TRACKED = 5000;

export async function POST(req: NextRequest) {
  // Only meaningful while voting is open. Silently ignore otherwise so the
  // voter UI doesn't have to special-case anything.
  if (store.state.pollStatus !== "open") {
    return new Response(null, { status: 204 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  const pitchId = typeof body?.pitchId === "string" ? body.pitchId : null;
  const kind = body?.kind === "deselect" ? "deselect" : "select";
  const voterId = typeof body?.voterId === "string" ? body.voterId : "anon";
  if (!pitchId) return new Response(null, { status: 400 });

  // Drop if the pitch doesn't exist (deleted between toggles).
  if (!store.state.pitches.some((p) => p.id === pitchId)) {
    return new Response(null, { status: 204 });
  }

  const now = Date.now();
  const last = lastByVoter.get(voterId) ?? 0;
  if (now - last < MIN_GAP_MS) {
    return new Response(null, { status: 204 });
  }
  if (lastByVoter.size >= MAX_VOTERS_TRACKED) {
    // Cheap eviction: clear the whole map; this is best-effort throttling.
    lastByVoter.clear();
  }
  lastByVoter.set(voterId, now);

  emitTwinkle({ pitchId, kind, at: now });
  return new Response(null, { status: 204 });
}
