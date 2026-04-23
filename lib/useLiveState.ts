"use client";

import { useEffect, useRef, useState } from "react";
import type { PollState } from "./store";

// Subscribe to /api/events (SSE) and keep a local copy of the poll state.
export function useLiveState(): PollState | null {
  const [state, setState] = useState<PollState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

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
