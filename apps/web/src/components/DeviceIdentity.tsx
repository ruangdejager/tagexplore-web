import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { DeviceIdentityCandidate, DeviceRow } from '../api.js';

/**
 * The admin-side surface for a reader's two learned identities — its radio id
 * and the tag carried on the same animal.
 *
 * Both fill themselves in from the readings, so the interesting question is
 * rarely "what is it" but "why is it that, or why is it still blank". These
 * components exist to answer that: the cell says where the value came from,
 * and the expandable row shows every candidate with the evidence behind it and
 * the reason it was or wasn't chosen.
 */

/**
 * `AdminPanel`'s shared mutation wrapper: it owns error reporting, the success
 * notice, and telling the map behind the panel to reload. It swallows the
 * action's own return value, so anything that needs the new state re-reads it.
 */
type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;

/**
 * How long a reader may go without pushing before an `auto` one falls back to
 * scraping. Mirrored from the server's own default purely to colour the "last
 * ingest" cell — the server has already decided the mode, and this only says
 * out loud that a *pinned* push device (which never falls back) has gone quiet
 * past the point where an auto one would have.
 */
export const PUSH_GRACE_MS = 180 * 60_000;

export function pushStatusClass(device: DeviceRow): string {
  if (device.lastPushAt === null) return 'status-error';
  return Date.now() - device.lastPushAt > PUSH_GRACE_MS ? 'status-error' : 'status-ok';
}

/**
 * One identity, as an editable cell.
 *
 * Typing a value latches it: the inference will never write over it again
 * until the field is cleared. That is the whole contract with the person using
 * this table, so the badge states which side of it the value is on rather than
 * leaving it to be inferred from nothing.
 *
 * An empty cell is two different answers, which is what the "no tag" toggle is
 * for. Left alone, empty means nobody knows yet and the inference keeps
 * looking. Toggled on, it means this reader carries no tag at all — a stated
 * fact, latched the same way a typed value is, because otherwise the inference
 * goes on offering whichever tag it hears loudest and the cell fills itself
 * back in with a wrong answer every time it is cleared.
 */
export function IdentityCell({
  device,
  field,
  title,
  expanded,
  onToggleExpanded,
  run,
  reload,
}: {
  device: DeviceRow;
  field: 'radioId' | 'carriedTagId';
  title: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  run: Run;
  reload: () => void;
}): JSX.Element {
  const value = field === 'radioId' ? device.radioId : device.carriedTagId;
  const source = field === 'radioId' ? device.radioIdSource : device.carriedTagSource;
  const statedNone = value === null && source === 'manual';

  const write = (next: string | null): Promise<void> =>
    run(() => api.updateDevice(device.imei, field === 'radioId' ? { radioId: next } : { carriedTagId: next })).then(
      reload,
    );

  return (
    <td className="mono identity-cell">
      <input
        // Keyed on the value *and* its source so a change made elsewhere — an
        // inference run, accepting a candidate, or the toggle beside it —
        // actually appears. An uncontrolled input holding a stale
        // `defaultValue` would keep showing the old one, and the two empty
        // states differ only in the source.
        key={`${source ?? ''}:${value ?? ''}`}
        defaultValue={value ?? ''}
        placeholder={statedNone ? 'no tag' : 'unknown'}
        title={title}
        onBlur={(e) => {
          const next = e.target.value.trim().toUpperCase();
          if (next === (value ?? '')) return;
          void write(next);
        }}
      />
      {source === 'auto' && <span className="identity-badge">auto</span>}
      {field === 'carriedTagId' && (
        <button
          type="button"
          className={statedNone ? 'identity-none is-on' : 'identity-none'}
          aria-pressed={statedNone}
          title={
            statedNone
              ? 'Recorded as carrying no tag. Turn this off to hand the field back to the inference.'
              : 'Record that this reader carries no tag, which also stops the inference filling one in.'
          }
          onClick={() => void write(statedNone ? '' : null)}
        >
          no tag
        </button>
      )}
      <button
        type="button"
        className="identity-expand"
        onClick={onToggleExpanded}
        title="What the inference has to go on for this reader"
        aria-label="Show identity evidence"
      >
        {expanded ? '▴' : '▾'}
      </button>
    </td>
  );
}

/**
 * Plain-language versions of the reasons `infer/identity.ts` records. The
 * stored codes are for the API; nobody should have to learn them to read this
 * table.
 */
const REJECTION_TEXT: Record<string, string> = {
  'also-heard': 'this reader also hears it as a tag, so it is a relay rather than the reader',
  'too-few-rounds': 'not enough discovery rounds yet',
  'share-below-threshold': 'two candidates are too close to choose between',
  'score-below-threshold': 'does not look enough like a carried tag',
  'no-margin': 'the runner-up is too close to call',
  'heard-better-elsewhere': 'another reader hears it just as well, so it may be on that animal instead',
  'is-a-radio-id': 'that id belongs to a reader, not a tag',
  'outranked-by-report': 'a campaign reported this reader’s id directly, which beats any vote',
  'implausible-rssi': 'its recorded signal strength is not a real reading',
};

/**
 * Every candidate for one reader, with a one-click way to take any of them.
 *
 * Shown on demand rather than always: it answers "why hasn't it picked one?",
 * which is asked rarely and cannot be answered at all without this.
 */
export function IdentityEvidenceRow({
  device,
  run,
  reload,
  colSpan,
}: {
  device: DeviceRow;
  run: Run;
  reload: () => void;
  colSpan: number;
}): JSX.Element {
  const [candidates, setCandidates] = useState<DeviceIdentityCandidate[] | null>(null);
  const [nonce, setNonce] = useState(0);

  // `identityCheckedAt` is in the dependency list so a scheduled run that
  // lands while this is open refreshes it, not only an explicit re-run.
  useEffect(() => {
    let cancelled = false;
    api
      .fetchDeviceIdentity(device.imei)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [device.imei, device.identityCheckedAt, nonce]);

  return (
    <tr className="identity-evidence">
      <td colSpan={colSpan}>
        <div className="identity-evidence-head">
          <span>Identity evidence</span>
          <button
            className="pill"
            onClick={() =>
              void run(() => api.reinferDeviceIdentity(device.imei), 'Re-ran the inference.').then(() => {
                setNonce((n) => n + 1);
                reload();
              })
            }
          >
            Re-run now
          </button>
        </div>

        {candidates === null ? (
          <div className="empty">Loading…</div>
        ) : candidates.length === 0 ? (
          <div className="empty">
            Nothing to go on yet. Both values are worked out from this reader&rsquo;s own discovery rounds, so there is
            nothing to show until it has reported a few.
          </div>
        ) : (
          <table className="identity-candidates">
            <thead>
              <tr>
                <th>For</th>
                <th>Value</th>
                <th>Rounds</th>
                <th>Score</th>
                <th>Verdict</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={`${candidate.kind}:${candidate.value}`}>
                  <td>{candidate.kind === 'radio' ? 'Radio ID' : 'Carried tag'}</td>
                  <td className="mono">
                    {candidate.value}
                    {/* A pushed campaign states its own primary's id, so this
                        one was reported rather than worked out — worth saying,
                        because it is the difference between evidence and
                        arithmetic. */}
                    {candidate.exact && <span className="identity-badge">reported</span>}
                  </td>
                  <td className="mono">{candidate.rounds}</td>
                  <td className="mono">{candidate.score.toFixed(2)}</td>
                  <td className="identity-reason">
                    {candidate.rejectedFor
                      ? (REJECTION_TEXT[candidate.rejectedFor] ?? candidate.rejectedFor)
                      : 'clear enough to use'}
                    {candidate.evidence && (
                      <span className="identity-numbers">
                        {Object.entries(candidate.evidence)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(' · ')}
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      className="pill"
                      title="Set this by hand — which also stops the inference ever changing it"
                      onClick={() => {
                        const patch =
                          candidate.kind === 'radio' ? { radioId: candidate.value } : { carriedTagId: candidate.value };
                        void run(() => api.updateDevice(device.imei, patch)).then(reload);
                      }}
                    >
                      Use
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}
