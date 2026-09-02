import type {
  AuthUser,
  BatterySeries,
  DeviceRow,
  IngestRunRow,
  OrgTagRow,
  OrganisationRow,
  TagSnapshot,
  UnclaimedTagRow,
  UserRole,
} from '@tagexplore/core';

export type { AuthUser, BatterySeries, DeviceRow, OrgTagRow, OrganisationRow, TagSnapshot, UnclaimedTagRow, UserRole };

export interface AdminUserRow {
  id: string;
  username: string;
  role: UserRole;
  orgId: string | null;
  orgName: string | null;
  createdAt: number;
}

/**
 * Every call goes through here so an error response becomes a thrown Error
 * carrying the server's own message — the UI shows that text rather than
 * inventing its own wording for a failure it does not understand.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// --- Auth ------------------------------------------------------------------

export const fetchCurrentUser = (): Promise<{ user: AuthUser | null }> => request('/api/auth/me');

export const login = (username: string, password: string): Promise<{ user: AuthUser }> =>
  request('/api/auth/login', { method: 'POST', ...json({ username, password }) });

export const signup = (username: string, password: string): Promise<{ user: AuthUser }> =>
  request('/api/auth/signup', { method: 'POST', ...json({ username, password }) });

export const logout = (): Promise<{ ok: true }> => request('/api/auth/logout', { method: 'POST' });

// --- Org-scoped data --------------------------------------------------------

/** Admins may pass an org id to look at any organisation; for a user it is ignored. */
function scoped(path: string, orgId: string | null, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  if (orgId) search.set('orgId', orgId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const fetchSnapshots = (
  orgId: string | null,
  hours: number,
): Promise<{ from: number; to: number; snapshots: TagSnapshot[] }> =>
  request(scoped('/api/snapshots', orgId, { hours }));

export const fetchOrgTags = (orgId: string | null): Promise<{ tags: OrgTagRow[] }> =>
  request(scoped('/api/tags', orgId));

export const fetchDevices = (orgId: string | null): Promise<{ devices: DeviceRow[] }> =>
  request(scoped('/api/devices', orgId));

export const fetchBattery = (
  orgId: string | null,
  from: number,
  to: number,
  tagIds: string[],
): Promise<{ from: number; to: number; bucketMinutes: number; series: BatterySeries[] }> =>
  request(scoped('/api/battery', orgId, { from, to, tags: tagIds.join(',') }));

// --- Admin ------------------------------------------------------------------

export const fetchOrgs = (): Promise<{ orgs: OrganisationRow[] }> => request('/api/admin/orgs');

export const createOrg = (name: string): Promise<{ org: { id: string; name: string } }> =>
  request('/api/admin/orgs', { method: 'POST', ...json({ name }) });

export const renameOrg = (id: string, name: string): Promise<{ ok: true }> =>
  request(`/api/admin/orgs/${id}`, { method: 'PATCH', ...json({ name }) });

export const deleteOrg = (id: string): Promise<{ ok: true }> =>
  request(`/api/admin/orgs/${id}`, { method: 'DELETE' });

export const fetchAdminUsers = (): Promise<{ users: AdminUserRow[] }> => request('/api/admin/users');

export const updateUser = (id: string, patch: { role?: UserRole; orgId?: string | null }): Promise<{ ok: true }> =>
  request(`/api/admin/users/${id}`, { method: 'PATCH', ...json(patch) });

export const deleteUser = (id: string): Promise<{ ok: true }> =>
  request(`/api/admin/users/${id}`, { method: 'DELETE' });

export const fetchAdminDevices = (): Promise<{ devices: DeviceRow[] }> => request('/api/admin/devices');

export const createDevice = (imei: string, orgId: string, label: string): Promise<{ device: DeviceRow }> =>
  request('/api/admin/devices', { method: 'POST', ...json({ imei, orgId, label }) });

export const updateDevice = (
  imei: string,
  patch: Partial<
    Pick<
      DeviceRow,
      'label' | 'active' | 'orgId' | 'reportStartMinute' | 'reportIntervalMinutes' | 'reportCountPerDay' | 'pollOffsetMinutes'
    >
  >,
): Promise<{ device: DeviceRow }> => request(`/api/admin/devices/${imei}`, { method: 'PATCH', ...json(patch) });

export const deleteDevice = (imei: string): Promise<{ ok: true }> =>
  request(`/api/admin/devices/${imei}`, { method: 'DELETE' });

export const ingestNow = (
  imei: string,
): Promise<{ result: { blocksParsed: number; readingsWritten: number; from: string; to: string } }> =>
  request(`/api/admin/devices/${imei}/ingest`, { method: 'POST' });

export const fetchIngestRuns = (imei?: string): Promise<{ runs: IngestRunRow[] }> =>
  request(imei ? `/api/admin/ingest-runs?imei=${imei}` : '/api/admin/ingest-runs');

export const fetchAdminOrgTags = (orgId: string): Promise<{ tags: OrgTagRow[] }> =>
  request(`/api/admin/orgs/${orgId}/tags`);

export const addOrgTags = (
  orgId: string,
  tagIds: string | string[],
): Promise<{ added: number; skipped: number; invalid: string[]; tags: OrgTagRow[] }> =>
  request(`/api/admin/orgs/${orgId}/tags`, { method: 'POST', ...json({ tagIds }) });

export const setOrgTagLabel = (orgId: string, tagId: string, label: string): Promise<{ ok: true }> =>
  request(`/api/admin/orgs/${orgId}/tags/${tagId}`, { method: 'PATCH', ...json({ label }) });

export const removeOrgTag = (orgId: string, tagId: string): Promise<{ ok: true }> =>
  request(`/api/admin/orgs/${orgId}/tags/${tagId}`, { method: 'DELETE' });

export const fetchUnclaimedTags = (orgId?: string): Promise<{ tags: UnclaimedTagRow[] }> =>
  request(orgId ? `/api/admin/unclaimed-tags?orgId=${orgId}` : '/api/admin/unclaimed-tags');
