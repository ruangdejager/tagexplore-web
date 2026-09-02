import { useCallback, useEffect, useState } from 'react';
import type { DeviceRow, TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

/**
 * Ingest happens on the devices' own schedule — typically once an hour — so
 * there is nothing to gain from polling harder than this. A minute is short
 * enough that a page left open on a wall display stays honest.
 */
const REFRESH_MS = 60_000;

export interface SnapshotState {
  snapshots: TagSnapshot[];
  devices: DeviceRow[];
  /** The window the server actually answered for, so the UI can date the view. */
  from: number;
  to: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSnapshots(orgId: string | null, hours: number, enabled: boolean): SnapshotState {
  const [snapshots, setSnapshots] = useState<TagSnapshot[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [range, setRange] = useState({ from: 0, to: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setSnapshots([]);
      setDevices([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([api.fetchSnapshots(orgId, hours), api.fetchDevices(orgId)])
      .then(([snapshotRes, deviceRes]) => {
        if (cancelled) return;
        setSnapshots(snapshotRes.snapshots);
        setDevices(deviceRes.devices);
        setRange({ from: snapshotRes.from, to: snapshotRes.to });
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load tags.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, hours, enabled, nonce]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { snapshots, devices, from: range.from, to: range.to, loading, error, refresh };
}
