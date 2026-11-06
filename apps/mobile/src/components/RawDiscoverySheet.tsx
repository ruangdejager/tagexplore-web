import { useEffect, useState } from 'react';
import type { DiscoveryDetail, DiscoveryRoundDetail, DiscoverySource } from '@tagexplore/core';
import * as api from '../api.js';
import { Sheet } from './Sheet.js';

function stamp(ms: number): string {
  return new Date(ms).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false });
}

function orDash(value: number | string | null): string {
  return value === null || value === '' ? '—' : String(value);
}

function SourceTag({ source }: { source: DiscoverySource }): JSX.Element {
  return (
    <span className="source-tag" data-source={source}>
      {source === 'cbor' ? 'HTTP CBOR' : 'LOG SCRAPE'}
    </span>
  );
}

/** One reader's own round: how it arrived, when, and what it reported about itself. */
function RoundBlock({ round }: { round: DiscoveryRoundDetail }): JSX.Element {
  const pushed = round.source === 'cbor';
  const rows: Array<[string, React.ReactNode]> = [
    ['Arrived', round.receivedAt !== null ? stamp(round.receivedAt) : <span className="dim">not recorded (scraped from the log)</span>],
    [
      'Duration',
      round.durationSeconds === null ? (
        '—'
      ) : (
        <>
          {round.durationSeconds}s <span className="dim">{pushed ? 'measured' : 'inferred'}</span>
        </>
      ),
    ],
    ['Tags', round.tagCount],
    ['Reader firmware', orDash(round.readerFw)],
    ['Unit battery', round.unitBatteryMv === null ? '—' : `${round.unitBatteryMv} mV`],
    ['Timed out', round.timedOut ? 'yes' : 'no'],
  ];
  if (round.post) {
    rows.push(
      ['Primary', <span className="mono">{round.post.primaryDeviceId.toString(16).toUpperCase()}</span>],
      ['Session clock', <span className="mono small">{stamp(round.post.sessionUtc * 1000)}</span>],
      ['Mode', round.post.mode === 1 ? 'basic (1)' : `advanced (${round.post.mode})`],
      ['Primary version', round.post.primaryVersion === 0 ? '—' : round.post.primaryVersion],
      ['Body', `${round.post.byteCount} bytes, ${round.post.recordCount} records`],
    );
  }
  return (
    <div className="raw-round">
      <div className="raw-round-head">
        <strong>{round.deviceLabel ?? round.deviceImei}</strong>
        <SourceTag source={round.source} />
      </div>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The raw data behind one discovery round, as the desktop shows it: each
 * reader's own round and every stored reading, uncollapsed. For `dev` and
 * `admin` accounts only (the server enforces that as well). The readings table
 * is as wide as the desktop's, so it scrolls sideways.
 */
export function RawDiscoverySheet(props: { orgId: string; bracketAt: number; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<DiscoveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api
      .fetchDiscoveryDetail(props.orgId, props.bracketAt)
      .then((res) => live && setDetail(res))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [props.orgId, props.bracketAt]);

  const pushed = detail?.rounds.some((r) => r.source === 'cbor') ?? false;

  return (
    <Sheet onClose={props.onClose} label="Raw discovery">
      <div className="sheet-head">
        <div>
          <div className="sheet-title plain">Raw discovery</div>
          <div className="sheet-sub mono small">{stamp(props.bracketAt)}</div>
        </div>
        {detail && <SourceTag source={pushed ? 'cbor' : 'log'} />}
      </div>

      {error && <p className="hint bad">{error}</p>}
      {!detail && !error && <p className="empty">Loading…</p>}

      {detail && (
        <>
          {detail.rounds.length > 0 ? (
            detail.rounds.map((r) => <RoundBlock key={r.deviceImei} round={r} />)
          ) : (
            <p className="empty">No round row stored for this bracket.</p>
          )}

          <h3 className="raw-heading">Readings ({detail.readings.length})</h3>
          <div className="raw-table-wrap">
            <table className="raw-table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Reader</th>
                  <th>Battery</th>
                  <th>RSSI</th>
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
                    <td>{r.tagId}</td>
                    <td>{r.deviceImei.slice(-3)}</td>
                    <td>{r.batteryMv === null ? '—' : `${r.batteryMv}`}</td>
                    <td>{orDash(r.rssi)}</td>
                    <td>{orDash(r.waveCount)}</td>
                    <td>{orDash(r.hops)}</td>
                    <td>{r.movementState === null ? '—' : r.movementState === 1 ? 'still' : 'moving'}</td>
                    <td>{r.hasGps && r.lat !== null && r.lon !== null ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : '—'}</td>
                    <td>{r.gpsAgeSeconds === null ? '—' : `${r.gpsAgeSeconds}s`}</td>
                    <td>{orDash(r.fwVersionPatch)}</td>
                    <td>{orDash(r.linkId)}</td>
                  </tr>
                ))}
                {detail.readings.length === 0 && (
                  <tr>
                    <td colSpan={11}>No readings stored for this bracket.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Every stored row for this round, including tags outside the whitelist and the same tag heard by more than one
            reader. Battery in mV; reader by the last three digits of its IMEI.
          </p>
        </>
      )}
    </Sheet>
  );
}
