import Anthropic from "@anthropic-ai/sdk";

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

// Haiku 4.5 is the fastest current model -- good for per-pitch summary calls.
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You summarize startup-style pitches delivered at an AI hackathon.

Input: a rough speech-to-text transcript of one person pitching one idea. It may be messy, contain filler words, or be partially cut off at the start or end. The speaker may not use complete sentences.

Output: a compact JSON object with two fields and no other text:
{"title": "<short catchy title, 2-6 words, Title Case, no trailing punctuation>",
 "description": "<one vivid sentence, <= 18 words, describing what the product/idea does>"}

Rules:
- Be specific about what the idea actually does; avoid generic phrases like "an AI tool".
- If the transcript is empty, nonsense, or has no pitch, reply with
  {"title":"Untitled Pitch","description":"(Could not extract a clear pitch from the audio.)"}.
- Never include code fences, markdown, or explanations. JSON only.`;

export interface PitchSummary {
  title: string;
  description: string;
}

export async function summarizePitch(transcript: string): Promise<PitchSummary> {
  const trimmed = transcript.trim();
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `Transcript:\n"""\n${trimmed || "(empty)"}\n"""`,
      },
    ],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { title: "Untitled Pitch", description: text.slice(0, 140) || "(no summary)" };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      title: String(parsed.title || "Untitled Pitch").slice(0, 60).trim(),
      description: String(parsed.description || "").slice(0, 180).trim(),
    };
  } catch {
    return { title: "Untitled Pitch", description: text.slice(0, 140) };
  }
}
