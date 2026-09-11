import { useCallback, useEffect, useState } from 'react';
import type { DeviceRow, LinkReading, TagSnapshot } from '@tagexplore/core';
import * as api from '../api.js';

/**
 * Ingest happens on the devices' own schedule — typically once an hour — so
 * there is nothing to gain from polling harder than this. A minute is short
 * enough that a page left open on a wall display stays honest.
 */
const REFRESH_MS = 60_000;

export interface SnapshotState {
  snapshots: TagSnapshot[];
  links: LinkReading[];
  devices: DeviceRow[];
  /** The window the server actually answered for, so the UI can date the view. */
  from: number;
  to: number;
  loading: boolean;
  /**
   * True once *this* org's first fetch has settled — false again the instant
   * `orgId` changes to one that hasn't loaded yet, but untouched by a
   * background refresh of the same org, so the caller can gate on "never
   * loaded this org" without the periodic auto-refresh flipping it off.
   */
  hasLoaded: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSnapshots(
  orgId: string | null,
  hours: number,
  enabled: boolean,
  excludeDeviceImeis?: string[],
): SnapshotState {
  const [snapshots, setSnapshots] = useState<TagSnapshot[]>([]);
  const [links, setLinks] = useState<LinkReading[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [range, setRange] = useState({ from: 0, to: 0 });
  const [loading, setLoading] = useState(false);
  // The org id the data currently in state actually belongs to — compared
  // against the live `orgId` below rather than kept as its own true/false, so
  // switching orgs is detected without a separate reset effect.
  const [loadedOrgId, setLoadedOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Joined to a string for the dependency array: `excludeDeviceImeis` is a new
  // array reference on every render even when its contents haven't changed,
  // and re-fetching on every render (rather than only when the actual toggle
  // set changes) would defeat the point of this hook's own polling cadence.
  const excludeDeviceImeisKey = excludeDeviceImeis?.join(',') ?? '';

  useEffect(() => {
    if (!enabled) {
      setSnapshots([]);
      setLinks([]);
      setDevices([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([api.fetchSnapshots(orgId, hours, excludeDeviceImeis), api.fetchDevices(orgId)])
      .then(([snapshotRes, deviceRes]) => {
        if (cancelled) return;
        setSnapshots(snapshotRes.snapshots);
        setLinks(snapshotRes.links);
        setDevices(deviceRes.devices);
        setRange({ from: snapshotRes.from, to: snapshotRes.to });
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load tags.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setLoadedOrgId(orgId);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, hours, enabled, nonce, excludeDeviceImeisKey]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { snapshots, links, devices, from: range.from, to: range.to, loading, hasLoaded: enabled && loadedOrgId === orgId, error, refresh };
}
