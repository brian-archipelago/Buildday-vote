import { NextRequest } from "next/server";
import { publicState, store, type TwinkleEvent } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (state: unknown) => {
        safeEnqueue(`data: ${JSON.stringify(state)}\n\n`);
      };
      const sendTwinkle = (ev: TwinkleEvent) => {
        safeEnqueue(`event: twinkle\ndata: ${JSON.stringify(ev)}\n\n`);
      };

      // initial snapshot
      send(publicState());

      const onUpdate = (state: unknown) => send(state);
      const onTwinkle = (ev: TwinkleEvent) => sendTwinkle(ev);
      store.emitter.on("update", onUpdate);
      store.emitter.on("twinkle", onTwinkle);

      const heartbeat = setInterval(() => {
        safeEnqueue(`: ping\n\n`);
      }, 15000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        store.emitter.off("update", onUpdate);
        store.emitter.off("twinkle", onTwinkle);
        try {
          controller.close();
        } catch {}
      };

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
