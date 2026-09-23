import { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';

/**
 * The server-sent stream that replaced the Refresh button.
 *
 * Frames carry no data, only "this organisation has something new" — so this
 * hook's whole output is a pair of counters that other hooks put in their
 * dependency arrays. The actual re-fetch still goes through the ordinary
 * endpoints, which is what keeps one path for loading data rather than two.
 */

/** Twelve readers posting inside the same second should cost one re-fetch, not twelve. */
const DEBOUNCE_MS = 750;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * Fallback heartbeat interval, used until the server's `hello` says what it
 * actually is. Silence for three of these is treated as a dead connection.
 */
const ASSUMED_HEARTBEAT_MS = 25_000;
const SILENCE_MULTIPLIER = 3;

export interface LiveState {
  /** Bumped by anything the map or the device list would want to re-read. */
  dataNonce: number;
  geofenceNonce: number;
  /**
   * Bumped when the organisation's tag list changes — someone switching a tag
   * off is an org-wide change, so it has to reach the other people looking at
   * the same org rather than only the browser that did it.
   */
  tagNonce: number;
  /** Whether the stream is currently up — what the LIVE badge reports. */
  connected: boolean;
  /** When the last frame arrived, heartbeats included. Null until the first one. */
  lastEventAt: number | null;
}

export function useLiveEvents(orgId: string | null, enabled: boolean): LiveState {
  const [state, setState] = useState<LiveState>({
    dataNonce: 0,
    geofenceNonce: 0,
    tagNonce: 0,
    connected: false,
    lastEventAt: null,
  });

  // Held in refs rather than state: the debounce and the watchdog read these
  // on every frame, and re-creating the connection whenever one changed would
  // defeat the point of holding a connection open.
  const sourceRef = useRef<EventSource | null>(null);
  const serverStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !orgId) {
      setState((s) => ({ ...s, connected: false }));
      return;
    }

    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let heartbeatMs = ASSUMED_HEARTBEAT_MS;
    let lastFrameAt = Date.now();

    type Kind = 'data' | 'geofences' | 'tags';
    const NONCE_FIELD: Record<Kind, 'dataNonce' | 'geofenceNonce' | 'tagNonce'> = {
      data: 'dataNonce',
      geofences: 'geofenceNonce',
      tags: 'tagNonce',
    };

    const debounces = new Map<Kind, ReturnType<typeof setTimeout>>();
    const bump = (kind: Kind): void => {
      const existing = debounces.get(kind);
      if (existing) clearTimeout(existing);
      debounces.set(
        kind,
        setTimeout(() => {
          debounces.delete(kind);
          const field = NONCE_FIELD[kind];
          setState((s) => ({ ...s, [field]: s[field] + 1 }));
        }, DEBOUNCE_MS),
      );
    };

    const noteFrame = (): void => {
      lastFrameAt = Date.now();
      setState((s) => (s.connected && s.lastEventAt === lastFrameAt ? s : { ...s, connected: true, lastEventAt: lastFrameAt }));
    };

    const connect = (): void => {
      if (closed) return;
      const source = new EventSource(api.liveEventsUrl(orgId));
      sourceRef.current = source;

      source.addEventListener('hello', (event) => {
        attempt = 0;
        noteFrame();
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            serverStartedAt?: number;
            heartbeatSeconds?: number;
          };
          if (payload.heartbeatSeconds) heartbeatMs = payload.heartbeatSeconds * 1000;
          // A different process answered than the one we were talking to, so
          // anything published while we were away is simply gone. Re-read
          // everything rather than wait for the next campaign to arrive.
          if (serverStartedAtRef.current !== null && serverStartedAtRef.current !== payload.serverStartedAt) {
            bump('data');
            bump('geofences');
            bump('tags');
          }
          serverStartedAtRef.current = payload.serverStartedAt ?? null;
        } catch {
          // A malformed hello still proves the stream is up, which is the
          // only thing this handler is load-bearing for.
        }
      });

      for (const type of ['readings', 'device-position'] as const) {
        source.addEventListener(type, () => {
          noteFrame();
          bump('data');
        });
      }
      source.addEventListener('geofences', () => {
        noteFrame();
        bump('geofences');
      });
      source.addEventListener('tags', () => {
        noteFrame();
        bump('tags');
      });
      // Heartbeats are comment frames, which fire no event — but any traffic at
      // all resets the browser's own read, so this covers a server that sends
      // unnamed frames rather than the ones above.
      source.onmessage = noteFrame;

      source.onerror = () => {
        // `EventSource` retries on its own schedule and tells us nothing about
        // why it failed, so the reconnect is taken over here instead: closed,
        // then reopened on a backoff that a successful `hello` resets.
        source.close();
        if (sourceRef.current === source) sourceRef.current = null;
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
        attempt += 1;
        const jittered = base * (0.8 + Math.random() * 0.4);
        reconnectTimer = setTimeout(connect, jittered);
      };
    };

    const reopen = (): void => {
      if (closed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
      attempt = 0;
      lastFrameAt = Date.now();
      connect();
    };

    // A laptop that slept, or a network that came back, can leave an
    // `EventSource` that is open as far as the browser is concerned and dead
    // as far as any byte is concerned — it never fires `onerror`, so nothing
    // else here would ever notice.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reopen();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', reopen);

    watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt > heartbeatMs * SILENCE_MULTIPLIER) reopen();
    }, heartbeatMs);

    connect();

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', reopen);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
      for (const timer of debounces.values()) clearTimeout(timer);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [orgId, enabled]);

  return state;
}
