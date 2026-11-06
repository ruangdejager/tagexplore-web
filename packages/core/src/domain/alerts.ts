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
  /** Only for `still`: whether that latest (still) reading itself carried a GPS fix. */
  hasGpsFix?: boolean;
}

export function computeTagAlerts(snapshots: TagSnapshot[], nowMs: number): TagAlert[] {
  const staleCutoff = nowMs - STALE_ALERT_HOURS * 3_600_000;
  const alerts: TagAlert[] = [];
  for (const snap of snapshots) {
    if (snap.movementState === 1) {
      alerts.push({
        tagId: snap.tagId,
        label: snap.label,
        kind: 'still',
        lastSeenAt: snap.lastSeenAt,
        hasGpsFix: snap.fixAt === snap.lastSeenAt,
      });
    } else if (snap.lastSeenAt < staleCutoff) {
      alerts.push({ tagId: snap.tagId, label: snap.label, kind: 'stale', lastSeenAt: snap.lastSeenAt });
    }
  }
  return alerts;
}

/** A short human line for one alert, used as a notification body and in the mobile list. */
export function describeTagAlert(alert: TagAlert, nowMs: number): string {
  return alert.kind === 'still' ? 'still' : `not seen in ${formatAge(nowMs - alert.lastSeenAt)}`;
}
