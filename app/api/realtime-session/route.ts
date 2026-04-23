import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

// POST /api/realtime-session
// Mints a short-lived ephemeral client token that the admin browser uses to
// open a WebRTC connection DIRECTLY to OpenAI's Realtime transcription endpoint.
// The real OPENAI_API_KEY never leaves the server.
//
// Docs: https://platform.openai.com/docs/guides/realtime-transcription
export async function POST(req: NextRequest) {
  const gate = requireAdmin(req);
  if (gate) return gate;

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const body = {
    input_audio_format: "pcm16",
    input_audio_transcription: {
      model: "gpt-4o-transcribe",
      language: "en",
      // A short hint to steer the model toward hackathon-specific vocabulary.
      prompt:
        "Startup pitch event at an AI hackathon. Speakers describe AI-powered products, agents, SDKs, APIs, RAG, LLMs, prompts, evals, vector databases, and similar technical terms.",
    },
    turn_detection: {
      type: "server_vad",
      threshold: 0.55,
      prefix_padding_ms: 300,
      silence_duration_ms: 900,
    },
  };

  const res = await fetch(
    "https://api.openai.com/v1/realtime/transcription_sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("realtime session mint failed", res.status, text);
    return Response.json(
      { error: "Failed to mint session", detail: text },
      { status: 500 },
    );
  }

  const session = await res.json();
  return Response.json(session);
}
