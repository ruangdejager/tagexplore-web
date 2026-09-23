/**
 * The in-process fan-out behind `GET /api/events`.
 *
 * Every browser looking at an organisation holds one SSE connection; whenever
 * something lands that changes what that organisation would see — a pushed
 * campaign, a scraped log, a reader's new position — the ingest path publishes
 * a one-line *signal* here and every connection for that org writes it out.
 *
 * The signal deliberately carries no tag data. It says "org X has new data",
 * and the client then re-fetches through the ordinary org-scoped endpoints,
 * which re-authorise and re-apply the tag whitelist and device exclusions. That
 * keeps filtering in exactly one place instead of growing a second
 * serialisation path that has to be kept in step with the first.
 *
 * A plain `Map<orgId, Set<listener>>` rather than `node:events`: keying by
 * organisation is the whole job, it costs nothing, and thirty open tabs don't
 * trip a `maxListeners` warning. Dispatch is a loop with a per-listener
 * `try/catch`, because `publish` is called from inside ingest transactions — a
 * wedged connection must never be able to fail a write.
 */

export type LiveEventType = 'readings' | 'device-position' | 'geofences' | 'tags';

export interface LiveEvent {
  type: LiveEventType;
  orgId: string;
  /** The reader the change came from. Empty for a change nobody's reader caused. */
  imei: string;
  /** Server clock at publish time. */
  at: number;
  /** The discovery round that changed. Only on `readings`. */
  bracketAt?: number;
}

export type LiveListener = (event: LiveEvent) => void;

export interface LiveBus {
  publish(event: LiveEvent): void;
  /** Returns the unsubscribe function; calling it twice is harmless. */
  subscribe(orgId: string, listener: LiveListener): () => void;
  subscriberCount(orgId: string): number;
}

export function createLiveBus(): LiveBus {
  const byOrg = new Map<string, Set<LiveListener>>();

  return {
    publish(event: LiveEvent): void {
      const listeners = byOrg.get(event.orgId);
      if (!listeners) return;
      // Copied before iterating: a listener that unsubscribes itself while
      // being notified would otherwise mutate the set mid-loop.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error('[live] subscriber threw:', err instanceof Error ? err.message : err);
        }
      }
    },

    subscribe(orgId: string, listener: LiveListener): () => void {
      let listeners = byOrg.get(orgId);
      if (!listeners) {
        listeners = new Set();
        byOrg.set(orgId, listeners);
      }
      listeners.add(listener);

      return () => {
        const current = byOrg.get(orgId);
        if (!current) return;
        current.delete(listener);
        // Dropped rather than left empty, so an org nobody is watching stops
        // costing a map entry once its last tab closes.
        if (current.size === 0) byOrg.delete(orgId);
      };
    },

    subscriberCount(orgId: string): number {
      return byOrg.get(orgId)?.size ?? 0;
    },
  };
}
