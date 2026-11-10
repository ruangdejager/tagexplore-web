import type { TagSnapshot } from '../apiTypes.js';
import { formatAge } from './positionAge.js';

/**
 * The alert rule, shared by the server's push notifier and the mobile app.
 *
 * It is the same rule the web app's `AlertsPanel` applies in the browser:
 *
 *   - **still**: the tag's latest reading says it is not moving
 *     (`movementState === 1`). This wins over "stale" — "still" already
 *     explains why the tag has gone quiet, so a second alarm for the same tag
 *     would only be noise.
 *   - **stale**: the tag has not been heard for `STALE_ALERT_HOURS`.
 *
 * Only tags the caller passes in are judged. Callers drop tags switched off for
 * the organisation (`org_tags.hidden`) before calling, exactly as the web panel
 * only watches toggled-on tags.
 */
export const STALE_ALERT_HOURS = 8;

/**
 * How far back the snapshot window reaches when alerts are worked out: a year,
 * the same window the web app loads its sidebar (and so its alerts panel)
 * from. A tag last heard before that has dropped out of the window and no
 * longer raises a "stale" alert.
 */
export const ALERT_SNAPSHOT_WINDOW_HOURS = 24 * 365;

export type TagAlertKind = 'still' | 'stale';

export interface TagAlert {
  tagId: string;
  label: string | null;
  kind: TagAlertKind;
  lastSeenAt: number;
  /** Only for `still`: when the tag went still (the start of its current still streak). */
  stillSince?: number;
  /**
   * Only for `still`: the newest GPS fix taken at or after the tag went still,
   * or null when none has arrived since. Null is what the apps show as "No fix".
   */
  fixAfterStill?: number | null;
  /**
   * Where the alert is, when there is a fix to say so: for `still`, the fix
   * taken at or after the tag went still; for `stale`, the tag's last fix.
   * Null for a still tag with no fix since, or a tag that never had one.
   */
  lat: number | null;
  lon: number | null;
  /** When that fix was taken. */
  fixAt: number | null;
}

/**
 * One alert episode as the server recorded it: from when the tag entered the
 * alert until it left it. `endedAt` is null while the alert is still active.
 */
export interface AlertHistoryEntry {
  id: number;
  tagId: string;
  label: string | null;
  kind: TagAlertKind;
  startedAt: number;
  endedAt: number | null;
  /** The alert's position, as last recorded while it was active — null when it had no fix. */
  lat: number | null;
  lon: number | null;
  fixAt: number | null;
}

/**
 * When an alert actually began, as opposed to when a check first noticed it:
 * the start of the still streak, or the moment the tag crossed the stale
 * threshold.
 */
export function alertStartedAt(alert: TagAlert): number {
  return alert.kind === 'still' ? (alert.stillSince ?? alert.lastSeenAt) : alert.lastSeenAt + STALE_ALERT_HOURS * 3_600_000;
}

/**
 * The newest fix at or after the tag went still, or null. A fix in the very
 * reading that first reported still counts: that is where the tag stopped.
 */
export function fixAfterStill(snap: Pick<TagSnapshot, 'fixAt' | 'stillSince' | 'lastSeenAt'>): number | null {
  const since = snap.stillSince ?? snap.lastSeenAt;
  return snap.fixAt !== null && snap.fixAt >= since ? snap.fixAt : null;
}

export function computeTagAlerts(snapshots: TagSnapshot[], nowMs: number): TagAlert[] {
  const staleCutoff = nowMs - STALE_ALERT_HOURS * 3_600_000;
  const alerts: TagAlert[] = [];
  for (const snap of snapshots) {
    if (snap.movementState === 1) {
      const fix = fixAfterStill(snap);
      alerts.push({
        tagId: snap.tagId,
        label: snap.label,
        kind: 'still',
        lastSeenAt: snap.lastSeenAt,
        stillSince: snap.stillSince ?? snap.lastSeenAt,
        fixAfterStill: fix,
        lat: fix !== null ? snap.lat : null,
        lon: fix !== null ? snap.lon : null,
        fixAt: fix,
      });
    } else if (snap.lastSeenAt < staleCutoff) {
      alerts.push({
        tagId: snap.tagId,
        label: snap.label,
        kind: 'stale',
        lastSeenAt: snap.lastSeenAt,
        lat: snap.lat,
        lon: snap.lon,
        fixAt: snap.lat !== null ? snap.fixAt : null,
      });
    }
  }
  return alerts;
}

/** A short human line for one alert, used as a notification body and in the mobile list. */
export function describeTagAlert(alert: TagAlert, nowMs: number): string {
  if (alert.kind === 'still') return alert.fixAfterStill == null ? 'still · No fix' : 'still · fix after still';
  return `not seen in ${formatAge(nowMs - alert.lastSeenAt)}`;
}
