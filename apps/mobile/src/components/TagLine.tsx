import { useState } from 'react';
import { batteryLevel } from '@tagexplore/core';
import { rowStatus } from '../format.js';
import type { TagRow } from '../useOrgData.js';

/**
 * One list row: status dot, tag id and label, one line of detail, battery
 * chip. With `onToggle`, a switch on the left turns the tag off or on for the
 * whole organisation, as the desktop list's toggle does.
 */
export function TagLine(props: {
  row: TagRow;
  detail: string;
  onOpen: (tagId: string) => void;
  onToggle?: (tagId: string, hidden: boolean) => Promise<void>;
}): JSX.Element {
  const { row } = props;
  const mv = row.snap?.batteryMv ?? null;
  const [busy, setBusy] = useState(false);
  const on = !row.hidden;

  return (
    <div className={`row ${row.hidden ? 'off' : ''}`}>
      {props.onToggle && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={on ? `Switch ${row.tagId} off` : `Switch ${row.tagId} on`}
          className="switch"
          data-on={on ? '1' : '0'}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            props.onToggle!(row.tagId, on).finally(() => setBusy(false));
          }}
        >
          <span />
        </button>
      )}
      <button type="button" className="row-open" onClick={() => props.onOpen(row.tagId)}>
        {!props.onToggle && <span className={`status-dot ${rowStatus(row)}`} aria-hidden="true" />}
        <span className="row-main">
          <span className="row-title">
            {props.onToggle && <span className={`status-dot small ${row.hidden ? 'quiet' : rowStatus(row)}`} aria-hidden="true" />}
            <span className="tag-id">{row.tagId}</span>
            {row.label && <span className="tag-label">{row.label}</span>}
          </span>
          <span className={`row-detail ${row.alert ? 'bad' : ''}`}>{props.detail}</span>
        </span>
        {mv !== null && <span className={`battery-chip ${batteryLevel(mv)}`}>{(mv / 1000).toFixed(2)}V</span>}
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </div>
  );
}
