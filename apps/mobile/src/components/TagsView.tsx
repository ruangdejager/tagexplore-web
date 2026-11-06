import { useMemo, useState } from 'react';
import { ago, alertText, movementText } from '../format.js';
import type { OrgData, TagRow } from '../useOrgData.js';
import { TagLine } from './TagLine.js';

export function TagsView({ data, onOpenTag }: { data: OrgData; onOpenTag: (tagId: string) => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? data.rows.filter((r) => r.tagId.toLowerCase().includes(needle) || (r.label ?? '').toLowerCase().includes(needle))
      : data.rows;
    // Switched-on tags first; within each, alerts first, then most recently heard.
    return [...filtered].sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) ||
        Number(Boolean(b.alert)) - Number(Boolean(a.alert)) ||
        (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
    );
  }, [data.rows, query]);

  if (data.error && !data.updatedAt) return <p className="empty">{data.error}</p>;
  if (!data.updatedAt) return <p className="empty">Loading…</p>;

  const now = Date.now();
  const detailFor = (row: TagRow): string => {
    if (row.hidden) return `Switched off · heard ${ago(row.lastSeenAt, now)}`;
    if (row.alert) return alertText(row.alert, now);
    if (row.snap) return `${movementText(row.snap.movementState)} · ${ago(row.snap.lastSeenAt, now)}`;
    return `Last heard ${ago(row.lastSeenAt, now)}`;
  };

  const toggle = async (tagId: string, hide: boolean): Promise<void> => {
    setError(null);
    try {
      await data.setHidden(tagId, hide);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that tag.');
    }
  };

  return (
    <div className="list-page">
      <input
        className="search"
        type="search"
        placeholder={`Search ${data.rows.length} tags`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="list-note">
        {data.watched.length} of {data.rows.length} switched on. Switching a tag off leaves it off the map, the count and the
        alerts for everyone in the organisation.
      </p>
      {error && <p className="hint bad">{error}</p>}
      <ul className="rows">
        {rows.map((row) => (
          <li key={row.tagId}>
            <TagLine row={row} detail={detailFor(row)} onOpen={onOpenTag} onToggle={toggle} />
          </li>
        ))}
        {rows.length === 0 && <li className="empty">No tags match.</li>}
      </ul>
    </div>
  );
}
