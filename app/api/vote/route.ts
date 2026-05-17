import { NextRequest } from "next/server";
import { setState, store } from "@/lib/store";

export const runtime = "nodejs";

// POST /api/vote  body: { voterId: string, selections: string[] }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const voterId = String(body.voterId || "").slice(0, 64);
  const selections: string[] = Array.isArray(body.selections)
    ? body.selections.map((s: unknown) => String(s)).slice(0, 50)
    : [];
  if (!voterId) {
    return Response.json({ error: "missing voterId" }, { status: 400 });
  }
  if (store.state.pollStatus !== "open") {
    return Response.json({ error: "poll is not open" }, { status: 403 });
  }
  const validIds = new Set(store.state.pitches.map((p) => p.id));
  const clean = selections.filter((id) => validIds.has(id));

  setState((s) => {
    const isNew = !(voterId in s.votes);
    s.votes[voterId] = clean;
    if (isNew) s.voterCount += 1;
  });
  return Response.json({ ok: true, accepted: clean });
}
