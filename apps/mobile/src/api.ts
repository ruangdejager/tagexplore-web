import type {
  AuthUser,
  DeviceRow,
  DiscoveryCountPoint,
  GeofenceRegion,
  GpsPoint,
  LinkReading,
  OrgTagRow,
  OrganisationRow,
  TagAlert,
  TagSnapshot,
} from '@tagexplore/core';

/**
 * The phone app's calls. Same server, same session cookie and same endpoints
 * as the desktop app, plus `/api/push/*`, which exists only for this app.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error ?? `Request failed (${res.status}).`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const q = (orgId: string, extra: Record<string, string | number> = {}): string =>
  new URLSearchParams({ orgId, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();

export const fetchMe = (): Promise<{ user: AuthUser | null }> => request('/api/auth/me');
export const login = (username: string, password: string): Promise<{ user: AuthUser }> =>
  request('/api/auth/login', json({ username, password }));
export const logout = (): Promise<unknown> => request('/api/auth/logout', { method: 'POST' });

/** Admins can open any organisation; everyone else only their own. */
export async function fetchOrgs(user: AuthUser): Promise<Array<{ id: string; name: string }>> {
  if (user.role !== 'admin') return user.orgs;
  const res = await request<{ orgs: OrganisationRow[] }>('/api/admin/orgs');
  return res.orgs.map((o) => ({ id: o.id, name: o.name })).sort((a, b) => a.name.localeCompare(b.name));
}

export const fetchSnapshots = (orgId: string, hours: number): Promise<{ snapshots: TagSnapshot[]; links: LinkReading[] }> =>
  request(`/api/snapshots?${q(orgId, { hours })}`);
export const fetchTags = (orgId: string): Promise<{ tags: OrgTagRow[] }> => request(`/api/tags?${q(orgId)}`);
/** Switches a tag off (or on) for the whole organisation, exactly as the desktop list's toggle does. */
export const setTagHidden = (orgId: string, tagId: string, hidden: boolean): Promise<{ tags: OrgTagRow[] }> =>
  request(`/api/tags/${encodeURIComponent(tagId)}?${q(orgId)}`, { method: 'PATCH', body: JSON.stringify({ hidden }) });
export const fetchDevices = (orgId: string): Promise<{ devices: DeviceRow[] }> => request(`/api/devices?${q(orgId)}`);
/** The readers as of one past round: each one's position for that round, not today's. */
export const fetchDevicesAt = (orgId: string, at: number): Promise<{ devices: DeviceRow[] }> =>
  request(`/api/devices?${q(orgId, { at })}`);
export const fetchGeofences = (orgId: string): Promise<{ geofences: GeofenceRegion[] }> => request(`/api/geofences?${q(orgId)}`);
/** Every raw GPS fix in the last `hours`, for the heatmap. */
export const fetchPositions = (orgId: string, hours: number): Promise<{ points: GpsPoint[] }> =>
  request(`/api/positions?${q(orgId, { hours })}`);
/** Each tag's latest reading as of one past round — what the map shows while browsing count history. */
export const fetchSnapshotsAt = (orgId: string, at: number): Promise<{ snapshots: TagSnapshot[]; links: LinkReading[] }> =>
  request(`/api/snapshots?${q(orgId, { to: at, from: Math.max(0, at - 364 * 86_400_000) })}`);
/** Per-round unique-tag counts, newest first; `before` pages further back. */
export const fetchDiscoveryCounts = (orgId: string, limit: number, before?: number): Promise<{ counts: DiscoveryCountPoint[] }> =>
  request(`/api/discovery-counts?${q(orgId, before === undefined ? { limit } : { limit, before })}`);
export const fetchAlerts = (orgId: string): Promise<{ now: number; alerts: TagAlert[] }> =>
  request(`/api/push/alerts?${q(orgId)}`);

export const fetchPushConfig = (): Promise<{ publicKey: string }> => request('/api/push/config');
export const pushStatus = (endpoint: string): Promise<{ subscribed: boolean; orgId: string | null }> =>
  request('/api/push/status', json({ endpoint }));
export const pushSubscribe = (orgId: string, subscription: PushSubscriptionJSON): Promise<{ subscribed: boolean }> =>
  request('/api/push/subscribe', json({ orgId, subscription }));
export const pushUnsubscribe = (endpoint: string): Promise<unknown> => request('/api/push/unsubscribe', json({ endpoint }));
export const pushTest = (endpoint: string): Promise<unknown> => request('/api/push/test', json({ endpoint }));
