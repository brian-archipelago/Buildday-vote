import Anthropic from "@anthropic-ai/sdk";
import {
  store,
  setState,
  publicState,
  windowTranscript,
  pruneWindow,
  ANALYZER_MIN_INTERVAL_MS,
  ANALYZER_MAX_INTERVAL_MS,
  genId,
  type Pitch,
} from "./store";

let _client: Anthropic | null = null;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Haiku 4.5 is fast and cheap -- ideal for a 15-30s analyzer cadence.
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are the "pitch boundary analyzer" for a live AI-hackathon voting app.

You receive:
1. An ordered list of pitches already recognized so far (each with id, title, description, status, and a "locked" flag).
2. A rolling transcript of the last ~5 minutes of live audio from the front of the room. Each line is prefixed with a relative timestamp like [t=42s]. The transcript is a rough speech-to-text and may contain errors, filler words, overlapping speech, applause, MC announcements, or Q&A.

Your job: output the canonical list of pitches so far -- by updating the existing list with any new or refined pitches the transcript reveals.

Boundaries to look for:
- The MC saying "next up", "let's welcome", "thanks everyone", "round of applause", or someone introducing themselves.
- A clear shift in topic from one idea/product to another.
- Long silence / crowd noise between content blocks.

Output rules:
- Return ALL pitches -- both existing (possibly updated) and any new ones -- in chronological order.
- For every existing pitch you see in the input, preserve its id and order.
- NEVER modify a pitch where "locked": true. Copy it through unchanged. (Admin edited it.)
- If a pitch is "in_progress" and the transcript indicates it has ended (new pitch started or long wrap-up happened), set its status to "completed" and refine its title/description based on what was said.
- If a brand new pitch is underway in the transcript, add it with status "in_progress" and a best-guess title/description; it will be refined in later passes.
- Titles: 2-6 words, Title Case, specific (not "an AI tool"), no trailing punctuation.
- Descriptions: one sentence, <= 18 words, concrete about what the product does.
- Do NOT invent pitches from Q&A banter, MC announcements, applause, or filler. Only create a pitch entry when a speaker is actually describing a product/idea.
- If nothing in the transcript merits a pitch entry yet, return the input list unchanged.

Reply with ONLY this JSON shape, no prose, no code fences:
{
  "pitches": [
    { "id": "<existing-id-or-new>", "title": "...", "description": "...", "status": "in_progress" | "completed" }
  ]
}`;

interface AnalyzerPitch {
  id: string;
  title: string;
  description: string;
  status: "in_progress" | "completed";
}

export async function runAnalyzerOnce(): Promise<void> {
  const now = Date.now();
  pruneWindow(now);
  const win = windowTranscript();
  if (win.segmentCount === 0) return;

  // Snapshot current pitches (to send as context) without internal fields.
  const existing = store.state.pitches.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    status: p.status,
    locked: !!p.locked,
  }));

  setState((s) => {
    s.analyzing = true;
  });

  try {
    const res = await client().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Existing pitches (JSON):\n${JSON.stringify(existing, null, 2)}`,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: `Rolling transcript (most recent ~5 min):\n"""\n${win.text}\n"""\n\nRespond with the full updated pitch list JSON.`,
            },
          ],
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    let parsed: { pitches?: AnalyzerPitch[] };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return;
    }
    const next = Array.isArray(parsed.pitches) ? parsed.pitches : [];

    // Merge: preserve locked pitches unchanged, update existing, append new.
    setState((s) => {
      const lockedById = new Map(
        s.pitches.filter((p) => p.locked).map((p) => [p.id, p]),
      );
      const prevById = new Map(s.pitches.map((p) => [p.id, p]));
      const merged: Pitch[] = [];
      let orderCounter = 0;
      for (const ap of next) {
        if (!ap || typeof ap !== "object") continue;
        const id = String(ap.id || "").trim();
        const existingLocked = lockedById.get(id);
        if (existingLocked) {
          merged.push({ ...existingLocked, order: orderCounter++ });
          continue;
        }
        const prev = prevById.get(id);
        if (prev) {
          merged.push({
            ...prev,
            title: sanitize(ap.title, 60) || prev.title,
            description: sanitize(ap.description, 180) || prev.description,
            status: ap.status === "completed" ? "completed" : "in_progress",
            order: orderCounter++,
            endedAt:
              ap.status === "completed" && !prev.endedAt ? now : prev.endedAt,
          });
        } else {
          merged.push({
            id: id || genId(),
            title: sanitize(ap.title, 60) || "Untitled Pitch",
            description: sanitize(ap.description, 180) || "(no description yet)",
            status: ap.status === "completed" ? "completed" : "in_progress",
            startedAt: now,
            endedAt: ap.status === "completed" ? now : undefined,
            order: orderCounter++,
          });
        }
      }
      // Always preserve locked pitches that the model may have forgotten to echo.
      for (const p of s.pitches) {
        if (p.locked && !merged.find((m) => m.id === p.id)) {
          merged.push({ ...p, order: orderCounter++ });
        }
      }
      s.pitches = merged;
      s._lastAnalyzedAt = Date.now();
      s._transcriptSinceLastAnalyze = 0;
    });
  } catch (err) {
    console.error("analyzer failed", err);
  } finally {
    setState((s) => {
      s.analyzing = false;
    });
  }
}

function sanitize(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, max);
}

// Called whenever a new transcript segment is ingested. Decides whether
// to trigger an analyzer pass, honoring a minimum interval.
let _pending = false;
export function maybeTriggerAnalyzer(opts?: { force?: boolean }) {
  const now = Date.now();
  const sinceLast = now - store.state._lastAnalyzedAt;
  const force = !!opts?.force;
  if (_pending) return;
  if (!force && sinceLast < ANALYZER_MIN_INTERVAL_MS) return;
  _pending = true;
  // Fire-and-forget; don't block the request.
  (async () => {
    try {
      await runAnalyzerOnce();
    } finally {
      _pending = false;
    }
  })();
}

// Background timer that forces a periodic pass even if nothing new arrived,
// to catch "pitch ended and nobody is speaking" cases.
let _timerStarted = false;
export function ensureAnalyzerTimer() {
  if (_timerStarted) return;
  _timerStarted = true;
  setInterval(() => {
    const segs = store.state._segments;
    if (segs.length === 0) return;
    const now = Date.now();
    const sinceLast = now - store.state._lastAnalyzedAt;
    if (sinceLast >= ANALYZER_MAX_INTERVAL_MS) {
      maybeTriggerAnalyzer({ force: true });
    }
  }, 5_000);
}
