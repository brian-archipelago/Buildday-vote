import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { genId, setState, snapshotPitches, publicState } from "@/lib/store";

export const runtime = "nodejs";

// POST /api/pitch  body: { title: string, description: string }
// Manual admin add -- always locked so the analyzer can't stomp on it.
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const title = String(body.title ?? "").trim().slice(0, 80) || "Untitled Pitch";
  const description =
    String(body.description ?? "").trim().slice(0, 240) || "(no description)";

  const id = genId();
  const now = Date.now();
  snapshotPitches(`admin add: ${title}`);
  setState((s) => {
    const maxOrder = s.pitches.reduce((m, p) => Math.max(m, p.order), -1);
    s.pitches.push({
      id,
      title,
      description,
      status: "completed",
      order: maxOrder + 1,
      startedAt: now,
      endedAt: now,
      locked: true,
    });
  });
  return Response.json({ ok: true, id });
}

export async function GET() {
  return Response.json(publicState().pitches);
}
