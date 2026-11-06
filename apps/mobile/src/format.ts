import { formatAge, type TagAlert } from '@tagexplore/core';
import type { TagRow } from './useOrgData.js';

export function ago(at: number | null | undefined, now: number = Date.now()): string {
  if (at === null || at === undefined) return 'never';
  return `${formatAge(now - at)} ago`;
}

export function alertText(alert: TagAlert, now: number = Date.now()): string {
  return alert.kind === 'still' ? 'Still' : `Not seen in ${formatAge(now - alert.lastSeenAt)}`;
}

export type RowStatus = 'alert' | 'ok' | 'quiet';

/** What colour a tag is drawn in: red for an alert, green when fine, grey when not heard in 72h. */
export function rowStatus(row: TagRow): RowStatus {
  if (row.alert) return 'alert';
  return row.snap ? 'ok' : 'quiet';
}

export function movementText(state: number | null | undefined): string {
  if (state === 1) return 'Still';
  if (state === 0) return 'Moving';
  return 'Unknown';
}
