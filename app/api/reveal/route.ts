import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setState, store } from "@/lib/store";
import { computeTally, effectiveTopLimit } from "@/lib/tally";

export const runtime = "nodejs";

// POST /api/reveal
// Body (all fields optional, applied independently):
//   { revealLimit?: number }     -- set how many top results to feature
//   { revealedCount?: number }   -- set absolute reveal cursor (UI usually
//                                   sends current+1 for "Reveal next" or 1
//                                   for "Reset")
//   { showAllResults?: boolean } -- toggle visibility of rank > revealLimit
//
// Server clamps every value against current pitch count and revealLimit so
// admin UI never has to worry about going out of bounds.
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));

  setState((s) => {
    if (typeof body.revealLimit === "number" && Number.isFinite(body.revealLimit)) {
      // Store admin's intent verbatim (>= 1) regardless of current pitch
      // count -- they may set "top 5" before pitches even exist. The display
      // side clamps to actual pitches when rendering. Capped generously to
      // catch typo entries like 9999.
      s.revealLimit = Math.max(1, Math.min(Math.floor(body.revealLimit), 100));
    }

    // Effective ceiling honours tie-grouping: if revealLimit=2 but the 2nd
    // and 3rd entries are tied, the cursor must be allowed to reach 3 so
    // both rank-2 entries get featured together. Recomputed *after* applying
    // any new revealLimit so the clamps below see the updated value.
    const tally = computeTally(s);
    const ceiling = effectiveTopLimit(tally, s.revealLimit);

    if (typeof body.revealLimit === "number" && Number.isFinite(body.revealLimit)) {
      // Re-clamp the cursor in case the new limit is smaller than where we
      // already are mid-reveal.
      s.revealedCount = Math.min(s.revealedCount, ceiling);
    }

    if (typeof body.revealedCount === "number" && Number.isFinite(body.revealedCount)) {
      s.revealedCount = Math.max(0, Math.min(Math.floor(body.revealedCount), ceiling));
    }

    if (typeof body.showAllResults === "boolean") {
      s.showAllResults = body.showAllResults;
    }
  });

  return Response.json({
    ok: true,
    revealLimit: store.state.revealLimit,
    revealedCount: store.state.revealedCount,
    showAllResults: store.state.showAllResults,
  });
}
