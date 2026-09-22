import { useEffect, useState } from 'react';
import type { DiscoveryDetail, DiscoveryRoundDetail, DiscoverySource } from '@tagexplore/core';
import * as api from '../api.js';

interface Props {
  /** The bracket whose raw data to show — the count-history row that was clicked. */
  bracketAt: number;
  orgId: string | null;
  /** Kept in step with the history list itself, so the table shows the same readers. */
  excludeDeviceImeis?: string[];
  onClose: () => void;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

/** Seconds since the epoch, as the unit's own RTC reported them. */
function utcStamp(seconds: number): string {
  return `${stamp(seconds * 1000)} (${seconds})`;
}

function orDash(value: number | string | null): string {
  return value === null || value === '' ? '—' : String(value);
}

function coordinates(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '—';
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/**
 * How the data got here, in the two words that actually distinguish the paths.
 * Deliberately prominent: which path a round came by is what decides whether
 * its duration was measured or inferred and whether its time is real or a
 * 15-minute bucket, so it is the first thing this table has to answer.
 */
function SourceTag({ source }: { source: DiscoverySource }): JSX.Element {
  return (
    <span className="source-tag" data-source={source}>
      {source === 'cbor' ? 'HTTP CBOR' : 'LOG SCRAPE'}
    </span>
  );
}

/** A reader's own round: how it arrived, when, and what it reported about itself. */
function RoundBlock({ round }: { round: DiscoveryRoundDetail }): JSX.Element {
  const pushed = round.source === 'cbor';
  return (
    <div className="raw-round">
      <div className="raw-round-head">
        <strong>{round.deviceLabel ?? round.deviceImei}</strong>
        <span className="mono">{round.deviceImei}</span>
        <SourceTag source={round.source} />
      </div>
      <dl className="raw-round-facts">
        <dt>Arrived</dt>
        <dd>
          {round.receivedAt !== null ? (
            stamp(round.receivedAt)
          ) : (
            // A scraped round genuinely has no arrival time — saying so is more
            // use than showing the bracket a second time and implying it has one.
            <span className="dim">not recorded — scraped from the log after the fact</span>
          )}
        </dd>
        <dt>Duration</dt>
        <dd>
          {round.durationSeconds === null ? (
            '—'
          ) : (
            <>
              {round.durationSeconds}s{' '}
              <span className="dim">{pushed ? 'measured by the firmware' : 'inferred from the bracket'}</span>
            </>
          )}
        </dd>
        <dt>Tags</dt>
        <dd>{round.tagCount}</dd>
        <dt>Reader firmware</dt>
        <dd>{orDash(round.readerFw)}</dd>
        <dt>Unit battery</dt>
        <dd>{round.unitBatteryMv === null ? '—' : `${round.unitBatteryMv} mV`}</dd>
        <dt>Timed out</dt>
        <dd>{round.timedOut ? 'yes' : 'no'}</dd>
        {round.post && (
          <>
            <dt>Primary</dt>
            <dd className="mono">
              {round.post.primaryDeviceId.toString(16).toUpperCase()} <span className="dim">({round.post.primaryDeviceId})</span>
            </dd>
            <dt>Session clock</dt>
            <dd>{utcStamp(round.post.sessionUtc)}</dd>
            <dt>Mode</dt>
            <dd>{round.post.mode === 1 ? 'basic (1)' : `advanced (${round.post.mode})`}</dd>
            <dt>Primary version</dt>
            <dd>{round.post.primaryVersion === 0 ? '— (too old to report)' : round.post.primaryVersion}</dd>
            <dt>Body</dt>
            <dd>
              {round.post.byteCount} bytes, {round.post.recordCount} records
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * The raw data behind one discovery round, for a `dev` or `admin` account:
 * every reader's own round and every stored reading, uncollapsed and
 * unaggregated, with the ingest path each one came by spelled out.
 *
 * This is the diagnostic view for the period where both ingest paths are live
 * — the question it exists to answer is "did this come from the unit itself or
 * out of its log, and does what landed match what the unit says it sent".
 */
export function DiscoveryRawModal({ bracketAt, orgId, excludeDeviceImeis, onClose }: Props): JSX.Element {
  const [detail, setDetail] = useState<DiscoveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api
      .fetchDiscoveryDetail(orgId, bracketAt, excludeDeviceImeis)
      .then((res) => {
        if (live) setDetail(res);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [bracketAt, orgId, excludeDeviceImeis]);

  // Escape closes, same as the other overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pushed = detail?.rounds.some((r) => r.source === 'cbor') ?? false;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Raw discovery</h2>
          <span className="mono dim">{stamp(bracketAt)}</span>
          {detail && <SourceTag source={pushed ? 'cbor' : 'log'} />}
          <button className="pill" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}
        {!detail && !error && <div className="empty">Loading…</div>}

        {detail && (
          <>
            <div className="raw-rounds">
              {detail.rounds.length > 0 ? (
                detail.rounds.map((r) => <RoundBlock key={r.deviceImei} round={r} />)
              ) : (
                <div className="empty">No round row stored for this bracket.</div>
              )}
            </div>

            <table className="admin-table raw-readings">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Reader</th>
                  <th>Battery</th>
                  <th>RSSI</th>
                  {/* Wave before hops, matching the order the rows are sorted in. */}
                  <th>Wave</th>
                  <th>Hops</th>
                  <th>Move</th>
                  <th>GPS</th>
                  <th>Fix age</th>
                  <th>FW</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {detail.readings.map((r) => (
                  <tr key={`${r.deviceImei}-${r.tagId}`}>
                    <td className="mono">{r.tagId}</td>
                    {/* No ingest path per row: the reader column already names
                        the round it belongs to, and that round's own block
                        above says how it arrived. */}
                    <td className="mono">{r.deviceImei}</td>
                    <td className="mono">{r.batteryMv === null ? '—' : `${r.batteryMv} mV`}</td>
                    <td className="mono">{orDash(r.rssi)}</td>
                    <td className="mono">{orDash(r.waveCount)}</td>
                    <td className="mono">{orDash(r.hops)}</td>
                    {/* 0 = moving, 1 = still — the tag's own raw field, carried
                        through unchanged by both paths. */}
                    <td className="mono">{r.movementState === null ? '—' : r.movementState === 1 ? 'still (1)' : `moving (${r.movementState})`}</td>
                    <td className="mono">{r.hasGps ? coordinates(r.lat, r.lon) : '—'}</td>
                    <td className="mono">{r.gpsAgeSeconds === null ? '—' : `${r.gpsAgeSeconds}s`}</td>
                    <td className="mono">{orDash(r.fwVersionPatch)}</td>
                    <td className="mono">{orDash(r.linkId)}</td>
                  </tr>
                ))}
                {detail.readings.length === 0 && (
                  <tr>
                    <td colSpan={11} className="dim">
                      No readings stored for this bracket.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="modal-hint">
              Every stored row for this round, by wave then hop count, including tags outside the whitelist and the same
              tag heard by more than one reader.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
