import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { genId, setState, store } from "@/lib/store";
import { summarizePitch } from "@/lib/anthropic";

export const runtime = "nodejs";

// POST /api/pitch  body: { transcript: string, manualTitle?, manualDescription? }
// Creates a new pitch entry, summarizes via Claude (async-in-request) and broadcasts.
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;

  let body: { transcript?: string; title?: string; description?: string } = {};
  try {
    body = await req.json();
  } catch {}
  const transcript = (body.transcript ?? "").trim();
  const providedTitle = body.title?.trim();
  const providedDescription = body.description?.trim();

  const id = genId();
  setState((s) => {
    s.pitches.push({
      id,
      title: providedTitle || "Summarizing…",
      description: providedDescription || "Listening to the pitch…",
      status: providedTitle && providedDescription ? "ready" : "summarizing",
      createdAt: Date.now(),
    });
  });

  // If admin provided full manual entry, skip Claude.
  if (providedTitle && providedDescription) {
    return Response.json({ ok: true, id });
  }

  // Summarize in the background so the request returns fast.
  (async () => {
    try {
      const summary = await summarizePitch(transcript);
      setState((s) => {
        const p = s.pitches.find((x) => x.id === id);
        if (!p) return;
        p.title = summary.title;
        p.description = summary.description;
        p.status = "ready";
      });
    } catch (err) {
      console.error("summarize failed", err);
      setState((s) => {
        const p = s.pitches.find((x) => x.id === id);
        if (!p) return;
        p.title = "Untitled Pitch";
        p.description =
          transcript.slice(0, 140) || "(summary failed — edit me from admin)";
        p.status = "ready";
      });
    }
  })();

  return Response.json({ ok: true, id });
}

// GET /api/pitch -> current state snapshot (handy for debugging)
export async function GET() {
  return Response.json(store.state);
}
