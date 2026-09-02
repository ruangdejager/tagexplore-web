import { useEffect, useState } from 'react';
import * as api from '../api.js';
import type { OrgAccessRequestRow } from '../api.js';

/**
 * Shown to a logged-in user with no organisation yet: lets them ask for one,
 * and shows the answer once an admin gives it.
 */
export function OrgRequestPanel(): JSX.Element {
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [orgId, setOrgId] = useState('');
  const [request, setRequest] = useState<OrgAccessRequestRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.fetchAccountOrgs().then((res) => setOrgs(res.orgs)).catch(() => setOrgs([]));
    api
      .fetchMyOrgRequest()
      .then((res) => setRequest(res.request))
      .catch(() => setRequest(null));
  }, []);

  if (request === undefined) return <div className="demo-banner">Loading…</div>;

  if (request?.status === 'pending') {
    return (
      <div className="demo-banner">
        Your request to join <strong>{request.orgName ?? 'that organisation'}</strong> is waiting on an admin.
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOrgAccess(orgId);
      setRequest(res.request);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="demo-banner org-request">
      {request?.status === 'rejected' && (
        <p style={{ margin: '0 0 6px' }}>
          Your request to join {request.orgName ?? 'that organisation'} was declined. You can ask for a different one.
        </p>
      )}
      <p style={{ margin: '0 0 6px' }}>Request access to your organisation:</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)} style={{ flex: 1 }}>
          <option value="">— pick one —</option>
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
        <button className="pill" disabled={!orgId || busy} onClick={() => void submit()}>
          {busy ? '…' : 'Request'}
        </button>
      </div>
      {error && <p className="modal-error" style={{ marginTop: 6 }}>{error}</p>}
    </div>
  );
}
