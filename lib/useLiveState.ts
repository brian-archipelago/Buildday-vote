"use client";

import { useEffect, useRef, useState } from "react";
import type { PollState, TwinkleEvent } from "./store";

interface UseLiveStateOptions {
  onTwinkle?: (ev: TwinkleEvent) => void;
}

// Subscribe to /api/events (SSE) and keep a local copy of the poll state.
// Optionally subscribe to ephemeral twinkle events for live voter feedback.
export function useLiveState(opts: UseLiveStateOptions = {}): PollState | null {
  const [state, setState] = useState<PollState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const twinkleHandlerRef = useRef(opts.onTwinkle);

  // Keep latest handler in a ref so we don't reconnect when it changes.
  useEffect(() => {
    twinkleHandlerRef.current = opts.onTwinkle;
  }, [opts.onTwinkle]);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const es = new EventSource("/api/events");
      sourceRef.current = es;
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          setState(data);
        } catch {}
      };
      es.addEventListener("twinkle", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as TwinkleEvent;
          twinkleHandlerRef.current?.(data);
        } catch {}
      });
      es.onerror = () => {
        es.close();
        if (cancelled) return;
        // Auto-reconnect with backoff.
        setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
    };
  }, []);

  return state;
}
