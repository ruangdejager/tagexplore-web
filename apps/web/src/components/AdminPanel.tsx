import { useCallback, useEffect, useState } from 'react';
import { describeSchedule, formatAge, formatMinuteOfDay, parseMinuteOfDay, shortDeviceId } from '@tagexplore/core';
import * as api from '../api.js';
import type { AdminUserRow, DeviceRow, OrgTagRow, OrganisationRow, UnclaimedTagRow, UserRole } from '../api.js';

interface Props {
  currentUserId: string;
  onClose: () => void;
  /** Called after a change that the map behind this panel should pick up. */
  onDataChanged: () => void;
}

type Tab = 'orgs' | 'users' | 'devices' | 'tags';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'orgs', label: 'Organisations' },
  { id: 'users', label: 'Users' },
  { id: 'devices', label: 'Devices' },
  { id: 'tags', label: 'Tags' },
];

const ROLES: UserRole[] = ['user', 'admin'];

function seenLabel(ms: number | null): string {
  return ms === null ? 'never' : `${formatAge(Date.now() - ms)} ago`;
}

export function AdminPanel({ currentUserId, onClose, onDataChanged }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('orgs');
  const [orgs, setOrgs] = useState<OrganisationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadOrgs = useCallback(() => {
    api
      .fetchOrgs()
      .then((res) => setOrgs(res.orgs))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load organisations.'));
  }, []);

  useEffect(loadOrgs, [loadOrgs]);

  /** Every mutating call in this panel funnels through here, so one place owns
   *  error reporting, the success notice, and telling the map to reload. */
  const run = useCallback(
    async (action: () => Promise<unknown>, message?: string): Promise<void> => {
      setError(null);
      setNotice(null);
      try {
        await action();
        if (message) setNotice(message);
        loadOrgs();
        onDataChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work.');
      }
    },
    [loadOrgs, onDataChanged],
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Admin</h2>
          <span className="modal-count">{orgs.length} organisations</span>
          <button className="pill" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="admin-tabs">
          {TABS.map((t) => (
            <button key={t.id} className="pill" data-on={tab === t.id ? '1' : '0'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {error && <p className="modal-error">{error}</p>}
        {notice && <p className="modal-ok">{notice}</p>}

        {tab === 'orgs' && <OrgsTab orgs={orgs} run={run} />}
        {tab === 'users' && <UsersTab orgs={orgs} currentUserId={currentUserId} run={run} />}
        {tab === 'devices' && <DevicesTab orgs={orgs} run={run} />}
        {tab === 'tags' && <TagsTab orgs={orgs} run={run} />}
      </div>
    </div>
  );
}

type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;

// --- Organisations ----------------------------------------------------------

function OrgsTab({ orgs, run }: { orgs: OrganisationRow[]; run: Run }): JSX.Element {
  const [name, setName] = useState('');

  return (
    <>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => api.createOrg(name.trim()), `Added ${name.trim()}.`).then(() => setName(''));
        }}
      >
        <label>
          New organisation
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Groenvley" />
        </label>
        <button className="button-primary" type="submit">
          Add
        </button>
      </form>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Users</th>
            <th>Devices</th>
            <th>Tags</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orgs.map((org) => (
            <tr key={org.id}>
              <td>
                <input
                  defaultValue={org.name}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== org.name) void run(() => api.renameOrg(org.id, next), 'Renamed.');
                  }}
                />
              </td>
              <td className="mono">{org.userCount}</td>
              <td className="mono">{org.deviceCount}</td>
              <td className="mono">{org.tagCount}</td>
              <td>
                <div className="actions">
                  <button
                    className="button-danger"
                    onClick={() => {
                      // Deleting an organisation takes its devices and all of
                      // their readings with it, so make that explicit first.
                      const ok = window.confirm(
                        `Delete ${org.name}? Its ${org.deviceCount} device(s) and every reading they collected go with it. This cannot be undone.`,
                      );
                      if (ok) void run(() => api.deleteOrg(org.id), `Deleted ${org.name}.`);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// --- Users ------------------------------------------------------------------

function UsersTab({
  orgs,
  currentUserId,
  run,
}: {
  orgs: OrganisationRow[];
  currentUserId: string;
  run: Run;
}): JSX.Element {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.fetchAdminUsers().then((res) => setUsers(res.users)).catch(() => setUsers([]));
  }, [nonce]);

  const reload = (): void => setNonce((n) => n + 1);

  return (
    <>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Organisation</th>
            <th>Access</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td className="mono">
                {user.username}
                {user.id === currentUserId && <span style={{ opacity: 0.6 }}> (you)</span>}
              </td>
              <td>
                <select
                  value={user.orgId ?? ''}
                  onChange={(e) => void run(() => api.updateUser(user.id, { orgId: e.target.value || null })).then(reload)}
                >
                  <option value="">— none —</option>
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={user.role}
                  onChange={(e) => void run(() => api.updateUser(user.id, { role: e.target.value as UserRole })).then(reload)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <div className="actions">
                  <button
                    className="button-danger"
                    onClick={() => {
                      if (window.confirm(`Delete the account "${user.username}"?`)) {
                        void run(() => api.deleteUser(user.id), 'Account deleted.').then(reload);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="modal-hint">
        <strong>user</strong> — sees only their own organisation's whitelisted tags. <strong>admin</strong> — that, plus
        this panel and the ability to look at any organisation. Anyone can sign up, but a new account sees nothing until
        it is placed in an organisation here.
      </p>
    </>
  );
}

// --- Devices ----------------------------------------------------------------

function DevicesTab({ orgs, run }: { orgs: OrganisationRow[]; run: Run }): JSX.Element {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [nonce, setNonce] = useState(0);
  const [imei, setImei] = useState('');
  const [label, setLabel] = useState('');
  const [orgId, setOrgId] = useState('');
  const [busyImei, setBusyImei] = useState<string | null>(null);

  useEffect(() => {
    api.fetchAdminDevices().then((res) => setDevices(res.devices)).catch(() => setDevices([]));
  }, [nonce]);

  const reload = (): void => setNonce((n) => n + 1);

  return (
    <>
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!imei.trim() || !orgId) return;
          void run(() => api.createDevice(imei.trim(), orgId, label.trim()), `Added ${imei.trim()}.`).then(() => {
            setImei('');
            setLabel('');
            reload();
          });
        }}
      >
        <label>
          IMEI
          <input value={imei} onChange={(e) => setImei(e.target.value)} placeholder="866049074634379" />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="North reader" />
        </label>
        <label>
          Organisation
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">— pick one —</option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button-primary" type="submit">
          Add device
        </button>
      </form>

      <table className="admin-table">
        <thead>
          <tr>
            <th>IMEI</th>
            <th>Label</th>
            <th>Organisation</th>
            <th>First report</th>
            <th>Every</th>
            <th>Per day</th>
            <th>Offset</th>
            <th>Log read at</th>
            <th>Last ingest</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.imei}>
              <td className="mono" title={device.imei}>
                …{shortDeviceId(device.imei)}
              </td>
              <td>
                <input
                  defaultValue={device.label}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== device.label) void run(() => api.updateDevice(device.imei, { label: next })).then(reload);
                  }}
                />
              </td>
              <td>
                <select
                  value={device.orgId}
                  onChange={(e) => void run(() => api.updateDevice(device.imei, { orgId: e.target.value })).then(reload)}
                >
                  {orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="mono">
                <input
                  type="time"
                  defaultValue={formatMinuteOfDay(device.reportStartMinute)}
                  onBlur={(e) => {
                    const minute = parseMinuteOfDay(e.target.value);
                    if (minute !== null && minute !== device.reportStartMinute) {
                      void run(() => api.updateDevice(device.imei, { reportStartMinute: minute })).then(reload);
                    }
                  }}
                />
              </td>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                <input
                  style={{ width: 56, display: 'inline-block' }}
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={device.reportIntervalMinutes}
                  onBlur={(e) =>
                    void run(() =>
                      api.updateDevice(device.imei, { reportIntervalMinutes: Number(e.target.value) }),
                    ).then(reload)
                  }
                />
                m
              </td>
              <td className="mono">
                <input
                  style={{ width: 52 }}
                  type="number"
                  min={1}
                  max={1440}
                  defaultValue={device.reportCountPerDay}
                  onBlur={(e) =>
                    void run(() => api.updateDevice(device.imei, { reportCountPerDay: Number(e.target.value) })).then(
                      reload,
                    )
                  }
                />
              </td>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                +
                <input
                  style={{ width: 48, display: 'inline-block' }}
                  type="number"
                  min={0}
                  max={1440}
                  defaultValue={device.pollOffsetMinutes}
                  onBlur={(e) =>
                    void run(() => api.updateDevice(device.imei, { pollOffsetMinutes: Number(e.target.value) })).then(
                      reload,
                    )
                  }
                />
                m
              </td>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                {describeSchedule(device)}
              </td>
              <td className={statusClass(device.lastIngestStatus)} title={device.lastIngestStatus ?? ''}>
                {device.lastIngestAt === null ? 'never' : seenLabel(device.lastIngestAt)}
              </td>
              <td>
                <div className="actions">
                  <button
                    className="pill"
                    data-on={device.active ? '1' : '0'}
                    onClick={() => void run(() => api.updateDevice(device.imei, { active: !device.active })).then(reload)}
                  >
                    {device.active ? 'Active' : 'Paused'}
                  </button>
                  <button
                    className="pill"
                    disabled={busyImei === device.imei}
                    onClick={() => {
                      setBusyImei(device.imei);
                      void run(async () => {
                        const res = await api.ingestNow(device.imei);
                        return res;
                      }, `Read ${device.imei}.`)
                        .then(reload)
                        .finally(() => setBusyImei(null));
                    }}
                  >
                    {busyImei === device.imei ? '…' : 'Read now'}
                  </button>
                  <button
                    className="button-danger"
                    onClick={() => {
                      if (window.confirm(`Delete ${device.imei}? Every reading it collected goes with it.`)) {
                        void run(() => api.deleteDevice(device.imei), 'Device deleted.').then(reload);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="modal-hint">
        A device is read <em>report time + offset</em>. The fleet default — first report 04:10, every 60 minutes, 19 a
        day, read 10 minutes later — means logs are fetched at 04:20, 05:20 … 22:20, and the device is left alone
        overnight. With the settings API configured these four numbers are refreshed from the device itself every few
        hours, so editing them by hand only matters for a device whose settings cannot be read.
      </p>
    </>
  );
}

function statusClass(status: string | null): string {
  if (!status) return 'status-idle';
  return status.startsWith('error') ? 'status-error' : 'status-ok';
}

// --- Tag whitelist ----------------------------------------------------------

function TagsTab({ orgs, run }: { orgs: OrganisationRow[]; run: Run }): JSX.Element {
  const [orgId, setOrgId] = useState<string>(orgs[0]?.id ?? '');
  const [tags, setTags] = useState<OrgTagRow[]>([]);
  const [unclaimed, setUnclaimed] = useState<UnclaimedTagRow[]>([]);
  const [paste, setPaste] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!orgId && orgs[0]) setOrgId(orgs[0].id);
  }, [orgs, orgId]);

  useEffect(() => {
    if (!orgId) return;
    api.fetchAdminOrgTags(orgId).then((res) => setTags(res.tags)).catch(() => setTags([]));
    api.fetchUnclaimedTags(orgId).then((res) => setUnclaimed(res.tags)).catch(() => setUnclaimed([]));
  }, [orgId, nonce]);

  const reload = (): void => setNonce((n) => n + 1);

  return (
    <>
      <div className="admin-form">
        <label>
          Organisation
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Add tag IDs (space, comma or newline separated)
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="3E1E 441F 2D94" />
        </label>
        <button
          className="button-primary"
          onClick={() => {
            if (!paste.trim() || !orgId) return;
            void run(async () => {
              const res = await api.addOrgTags(orgId, paste);
              setPaste('');
              return res;
            }, 'Whitelist updated.').then(reload);
          }}
        >
          Add to whitelist
        </button>
      </div>

      {unclaimed.length > 0 && (
        <>
          <p className="modal-hint" style={{ marginBottom: 6 }}>
            Heard by this organisation's devices but not on its whitelist:
          </p>
          <div className="chips" style={{ marginBottom: 14 }}>
            {unclaimed.map((tag) => (
              <button
                key={`${tag.tagId}-${tag.deviceImei}`}
                className="chip"
                title={`Last heard ${seenLabel(tag.lastSeenAt)} by …${shortDeviceId(tag.deviceImei)}`}
                onClick={() => void run(() => api.addOrgTags(orgId, [tag.tagId]), `Added ${tag.tagId}.`).then(reload)}
              >
                + {tag.tagId}
                <span className="count">{seenLabel(tag.lastSeenAt)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Label</th>
            <th>Last heard</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            <tr key={tag.tagId}>
              <td className="mono">{tag.tagId}</td>
              <td>
                <input
                  defaultValue={tag.label ?? ''}
                  placeholder="—"
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== (tag.label ?? '')) {
                      void run(() => api.setOrgTagLabel(orgId, tag.tagId, next)).then(reload);
                    }
                  }}
                />
              </td>
              <td className="mono">{seenLabel(tag.lastSeenAt)}</td>
              <td>
                <div className="actions">
                  <button
                    className="button-danger"
                    onClick={() =>
                      void run(() => api.removeOrgTag(orgId, tag.tagId), `Removed ${tag.tagId}.`).then(reload)
                    }
                  >
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="modal-hint">
        Removing a tag only drops this organisation's claim on it — the readings stay, so adding it back brings its whole
        history with it.
      </p>
    </>
  );
}
