import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setState, type PollStatus } from "@/lib/store";

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
  setState((s) => {
    s.pollStatus = status;
    if (status === "draft" || status === "open") {
      // Re-opening or resetting clears prior votes.
      s.votes = {};
      s.voterCount = 0;
    }
  });
  return Response.json({ ok: true });
}
