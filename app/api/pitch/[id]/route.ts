import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setState } from "@/lib/store";

export const runtime = "nodejs";

// PATCH /api/pitch/:id  body: { title?, description? }
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  setState((s) => {
    const p = s.pitches.find((x) => x.id === params.id);
    if (!p) return;
    if (typeof body.title === "string") p.title = body.title.slice(0, 80);
    if (typeof body.description === "string")
      p.description = body.description.slice(0, 240);
    p.status = "ready";
  });
  return Response.json({ ok: true });
}

// DELETE /api/pitch/:id
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  setState((s) => {
    s.pitches = s.pitches.filter((p) => p.id !== params.id);
    for (const voter of Object.keys(s.votes)) {
      s.votes[voter] = s.votes[voter].filter((pid) => pid !== params.id);
    }
  });
  return Response.json({ ok: true });
}
