import OpenAI from "openai";
import {
  store,
  setState,
  snapshotPitches,
  windowTranscript,
  pruneWindow,
  ANALYZER_MIN_INTERVAL_MS,
  ANALYZER_MAX_INTERVAL_MS,
  genId,
  type Pitch,
} from "./store";

let _client: OpenAI | null = null;
function client() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

// gpt-5.4-mini is fast and cheap -- ideal for a 15-30s analyzer cadence.
// (Same generation/tier as Claude Haiku 4.5 -- the previous analyzer model.)
// OpenAI auto-caches stable prompt prefixes >= 1024 tokens, so the system
// prompt + existing-pitches block we keep at the front of every request
// will be served from cache on subsequent passes within the cache TTL.
const MODEL = "gpt-5.4-mini";

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
- For every existing pitch you see in the input, preserve its id and order. Never drop or merge an existing pitch on your own; the admin handles cleanup manually if needed.
- NEVER modify a pitch where "locked": true. Copy it through unchanged. (Admin edited it.)
- If a pitch is "in_progress" and the transcript indicates it has ended (new pitch started or long wrap-up happened), set its status to "completed" and refine its title/description based on what was said.

When to create a pitch:
- Only when the transcript clearly reveals a speaker actively describing their own product/idea -- typically after at least one or two sentences naming what it does.
- If the speaker just said something vague ("I built something with AI") without any concrete content, do NOT create a pitch entry yet. Wait for the next pass.
- Better to wait one pass and produce an accurate first title than to spawn a pitch with a weak placeholder.

Refining titles and descriptions on every pass:
- Titles for unlocked pitches are NOT sticky. On every pass you have new transcript context, you MUST re-evaluate the title for accuracy and rewrite it freely if a better one emerges. Early titles are just best guesses; treat them as placeholders, not commitments.
- Descriptions follow the same rule -- rewrite freely as the speaker reveals more.
- If you genuinely have nothing better than the existing title, keep it. But default to refining, not preserving.
- Titles: 2-6 words, Title Case, specific (not "an AI tool"), no trailing punctuation.
- Descriptions: one sentence, <= 18 words, concrete about what the product does.
- Emojis: pick exactly ONE emoji per pitch that visually represents what the product is or does. Be specific and delightful — a coffee-finder app gets ☕, a fitness tracker gets 🏃, a CAD plugin gets 📐, a meeting summarizer gets 📝, a music tool gets 🎵, an AI agent for sales gets 🤝, a code reviewer gets 🔍. Avoid generic 🤖/💡/✨ unless the pitch genuinely has no specific theme. Re-evaluate the emoji every pass alongside the title -- if the concept becomes clearer, pick a better-fitting emoji.

What NOT to create pitches from:
- Q&A banter, MC announcements ("next up", "thanks everyone"), applause, audience reactions, filler, sponsor messages, jokes between pitches.
- The user message may include a list of titles labeled "DELETED BY ADMIN". The admin has explicitly removed those pitches because they were wrong, redundant, or off-topic. NEVER re-create a pitch matching any deleted title, NEVER re-create something that's clearly the same product/idea as a deleted entry even if the wording differs slightly. Treat the underlying audio as if it were not a pitch at all.
- If nothing in the transcript merits a pitch entry yet, return the input list unchanged.

Reply with ONLY this JSON shape, no prose, no code fences:
{
  "pitches": [
    { "id": "<existing-id-or-new>", "title": "...", "description": "...", "emoji": "🎯", "status": "in_progress" | "completed" }
  ]
}`;

interface AnalyzerPitch {
  id: string;
  title: string;
  description: string;
  emoji?: string;
  status: "in_progress" | "completed";
}

export async function runAnalyzerOnce(): Promise<void> {
  // Once the admin opens voting (or beyond), the pitch list is meant to be
  // frozen. Skip analysis entirely -- the lock-on-open handler already
  // marked pitches as completed/locked, and running anyway would waste
  // tokens and risk a model misfire mutating something it shouldn't.
  if (store.state.pollStatus !== "draft") return;

  const now = Date.now();
  pruneWindow(now);
  const win = windowTranscript();
  if (win.segmentCount === 0) return;

  // Snapshot current pitches (to send as context) without internal fields.
  const existing = store.state.pitches.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    emoji: p.emoji ?? "",
    status: p.status,
    locked: !!p.locked,
  }));
  const deletedTitles = store.state._deletedTitles.slice();

  setState((s) => {
    s.analyzing = true;
  });

  try {
    const res = await client().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Existing pitches (JSON):\n${JSON.stringify(existing, null, 2)}`,
            deletedTitles.length > 0
              ? `DELETED BY ADMIN (do NOT re-create these, even if mentioned):\n${JSON.stringify(deletedTitles, null, 2)}`
              : null,
            `Rolling transcript (most recent ~5 min):\n"""\n${win.text}\n"""`,
            `Respond with the full updated pitch list JSON.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    const text = res.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return;
    let parsed: { pitches?: AnalyzerPitch[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const next = Array.isArray(parsed.pitches) ? parsed.pitches : [];

    // Additive merge: NEVER drop an existing pitch (locked or unlocked) just
    // because the model omitted it. The previous behavior replaced s.pitches
    // wholesale with the model's output, which silently lost pitches when
    // the model "consolidated" a long list against a thin (5-min rolling)
    // transcript -- losing 10 of 15 pitches in production once. The model's
    // role is now strictly: refine titles/descriptions/emoji/status of
    // existing pitches, and propose brand-new ones. Removal is admin-only.
    //
    // Snapshot must happen here -- right before the mutation -- not at the
    // top of runAnalyzerOnce(). The OpenAI await above means store.state
    // can have been mutated in the meantime by other handlers.
    snapshotPitches("analyzer pass");
    setState((s) => {
      const prevById = new Map(s.pitches.map((p) => [p.id, p]));
      const seenIds = new Set<string>();
      const updates = new Map<string, Pitch>();
      const additions: Pitch[] = [];
      for (const ap of next) {
        if (!ap || typeof ap !== "object") continue;
        const id = String(ap.id || "").trim();
        const prev = id ? prevById.get(id) : undefined;
        if (prev) {
          seenIds.add(prev.id);
          if (prev.locked) {
            // Locked pitches pass through unchanged regardless of what the
            // model said about them.
            updates.set(prev.id, prev);
            continue;
          }
          updates.set(prev.id, {
            ...prev,
            title: sanitize(ap.title, 60) || prev.title,
            description: sanitize(ap.description, 180) || prev.description,
            emoji: sanitizeEmoji(ap.emoji) || prev.emoji,
            status: ap.status === "completed" ? "completed" : "in_progress",
            endedAt:
              ap.status === "completed" && !prev.endedAt ? now : prev.endedAt,
          });
        } else {
          additions.push({
            id: id || genId(),
            title: sanitize(ap.title, 60) || "Untitled Pitch",
            description: sanitize(ap.description, 180) || "(no description yet)",
            emoji: sanitizeEmoji(ap.emoji) || "💡",
            status: ap.status === "completed" ? "completed" : "in_progress",
            startedAt: now,
            endedAt: ap.status === "completed" ? now : undefined,
            order: 0, // overwritten below
          });
        }
      }
      // Rebuild in the original order: existing pitches keep their slot
      // (updated or untouched if model omitted them), new ones append.
      const merged: Pitch[] = [];
      let orderCounter = 0;
      for (const prev of s.pitches) {
        const updated = updates.get(prev.id) ?? prev;
        merged.push({ ...updated, order: orderCounter++ });
      }
      for (const add of additions) {
        merged.push({ ...add, order: orderCounter++ });
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

// Trim and bound the emoji field. The model occasionally returns multiple
// chars (e.g. "🤖✨") or wraps in text; take the first 8 chars after
// trimming whitespace and ignore obviously non-emoji ASCII fallbacks.
function sanitizeEmoji(v: unknown): string {
  if (typeof v !== "string") return "";
  const trimmed = v.trim().slice(0, 8);
  if (!trimmed) return "";
  // Reject pure ASCII (e.g. "x", ":)") — those aren't emoji.
  if (/^[\x00-\x7F]+$/.test(trimmed)) return "";
  return trimmed;
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
//
// Crucially: once recording is off AND nothing new has been ingested since
// the last pass, stop firing. The previous behavior kept analyzing every
// 30s for ~5 more minutes after the user hit Stop, with each pass fed by
// progressively thinner transcript context -- which caused the original
// "pitches disappeared after stop" disaster. A late-arriving final segment
// will still bump _transcriptSinceLastAnalyze, so a real wrap-up still
// gets one more pass.
let _timerStarted = false;
export function ensureAnalyzerTimer() {
  if (_timerStarted) return;
  _timerStarted = true;
  setInterval(() => {
    const s = store.state;
    if (s._segments.length === 0) return;
    if (!s.recording && s._transcriptSinceLastAnalyze === 0) return;
    const now = Date.now();
    const sinceLast = now - s._lastAnalyzedAt;
    if (sinceLast >= ANALYZER_MAX_INTERVAL_MS) {
      maybeTriggerAnalyzer({ force: true });
    }
  }, 5_000);
}
