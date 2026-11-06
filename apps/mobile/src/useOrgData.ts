import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALERT_SNAPSHOT_WINDOW_HOURS,
  type DeviceRow,
  type LinkReading,
  type OrgTagRow,
  type TagAlert,
  type TagSnapshot,
} from '@tagexplore/core';
import * as api from './api.js';

/** One tag on the organisation's list, with whatever is known about it. */
export interface TagRow {
  tagId: string;
  label: string | null;
  /** Switched off for the organisation: left off the map, the count and the alerts, as on the desktop. */
  hidden: boolean;
  /** Latest reading in the window (a year, as on the desktop); null when never heard in that time. */
  snap: TagSnapshot | null;
  /** Last time it was heard at all. */
  lastSeenAt: number | null;
  alert: TagAlert | null;
}

export interface OrgData {
  /** Every tag on the list, switched off ones included (the Tags tab shows and toggles them). */
  rows: TagRow[];
  /** Only the switched-on tags: what the map, the count and the alerts use. */
  watched: TagRow[];
  alerts: TagAlert[];
  devices: DeviceRow[];
  /** Every reader's reading of every tag in the latest round: what link view draws. */
  links: LinkReading[];
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  /** Which organisation the loaded data belongs to; lags `orgId` until a switch has finished loading. */
  loadedOrgId: string | null;
  live: boolean;
  refresh: () => void;
  setHidden: (tagId: string, hidden: boolean) => Promise<void>;
}

/** Background poll, for when the live stream is down (iOS drops it whenever the app is in the background). */
const POLL_MS = 60_000;
const DEBOUNCE_MS = 750;

/**
 * Everything the three tabs show, for one organisation: the tag list, each
 * tag's latest reading, the readers and the server's alert list. Refreshes on
 * the live stream's signal, when the app comes back to the foreground, when a
 * push arrives while it's open, and once a minute as a fallback.
 */
export function useOrgData(orgId: string | null): OrgData {
  const [tags, setTags] = useState<OrgTagRow[]>([]);
  const [snapshots, setSnapshots] = useState<TagSnapshot[]>([]);
  const [alerts, setAlerts] = useState<TagAlert[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [links, setLinks] = useState<LinkReading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loadedOrgId, setLoadedOrgId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setNonce((n) => n + 1), DEBOUNCE_MS);
  }, []);

  // Switching organisation starts from a clean slate rather than flashing the
  // previous one's tags.
  useEffect(() => {
    setTags([]);
    setSnapshots([]);
    setAlerts([]);
    setDevices([]);
    setLinks([]);
    setUpdatedAt(null);
    setLoadedOrgId(null);
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.fetchTags(orgId),
      api.fetchSnapshots(orgId, ALERT_SNAPSHOT_WINDOW_HOURS),
      api.fetchAlerts(orgId),
      api.fetchDevices(orgId).catch(() => ({ devices: [] as DeviceRow[] })),
    ])
      .then(([t, s, a, d]) => {
        if (cancelled) return;
        setTags(t.tags);
        setSnapshots(s.snapshots);
        setLinks(s.links ?? []);
        setAlerts(a.alerts);
        setDevices(d.devices);
        setUpdatedAt(Date.now());
        setLoadedOrgId(orgId);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, nonce]);

  // Live stream: frames only say "something changed", so any frame is a refresh.
  useEffect(() => {
    if (!orgId) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = (): void => {
      if (closed || document.visibilityState !== 'visible') return;
      source = new EventSource(`/api/events?orgId=${encodeURIComponent(orgId)}`);
      source.addEventListener('hello', () => setLive(true));
      for (const type of ['readings', 'tags', 'device-position']) source.addEventListener(type, refresh);
      source.onerror = () => {
        setLive(false);
        source?.close();
        source = null;
        if (!closed) retry = setTimeout(open, 5_000);
      };
    };
    const close = (): void => {
      source?.close();
      source = null;
      setLive(false);
      if (retry) clearTimeout(retry);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        refresh();
        if (!source) open();
      } else {
        close();
      }
    };

    open();
    document.addEventListener('visibilitychange', onVisibility);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    const onMessage = (e: MessageEvent): void => {
      if ((e.data as { type?: string })?.type === 'push') refresh();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);

    return () => {
      closed = true;
      close();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [orgId, refresh]);

  /**
   * Same as the desktop toggle: org-wide, applied from the server's answer
   * rather than guessed at. The alert list is re-read straight after, because
   * switching a tag off takes it out of the alerts.
   */
  const setHidden = useCallback(
    async (tagId: string, hidden: boolean): Promise<void> => {
      if (!orgId) return;
      const res = await api.setTagHidden(orgId, tagId, hidden);
      setTags(res.tags);
      const a = await api.fetchAlerts(orgId).catch(() => null);
      if (a) setAlerts(a.alerts);
    },
    [orgId],
  );

  const rows = useMemo<TagRow[]>(() => {
    const snapByTag = new Map(snapshots.map((s) => [s.tagId, s]));
    const alertByTag = new Map(alerts.map((a) => [a.tagId, a]));
    return tags.map((t) => {
      const snap = snapByTag.get(t.tagId) ?? null;
      return {
        tagId: t.tagId,
        label: t.label,
        hidden: t.hidden,
        snap,
        lastSeenAt: snap?.lastSeenAt ?? t.lastSeenAt,
        alert: t.hidden ? null : (alertByTag.get(t.tagId) ?? null),
      };
    });
  }, [tags, snapshots, alerts]);

  const watched = useMemo(() => rows.filter((r) => !r.hidden), [rows]);

  return { rows, watched, alerts, devices, links, loading, error, updatedAt, loadedOrgId, live, refresh, setHidden };
}
