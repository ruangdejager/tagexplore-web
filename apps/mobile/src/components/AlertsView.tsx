import { alertText } from '../format.js';
import type { OrgData } from '../useOrgData.js';
import { TagLine } from './TagLine.js';

export function AlertsView({ data, onOpenTag }: { data: OrgData; onOpenTag: (tagId: string) => void }): JSX.Element {
  if (data.error && !data.updatedAt) return <p className="empty">{data.error}</p>;
  if (!data.updatedAt) return <p className="empty">Loading…</p>;

  const now = Date.now();
  const alertRows = data.watched.filter((r) => r.alert);

  return (
    <div className="list-page">
      <div className="summary">
        <div className={`summary-figure ${alertRows.length ? 'bad' : 'good'}`}>{alertRows.length}</div>
        <div className="summary-text">
          <strong>{alertRows.length === 1 ? 'tag needs attention' : 'tags need attention'}</strong>
          <span>
            of {data.watched.length} watched · updated{' '}
            {new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

      {alertRows.length === 0 ? (
        <p className="all-clear">All tags reporting normally.</p>
      ) : (
        <ul className="rows">
          {alertRows.map((row) => (
            <li key={row.tagId}>
              <TagLine row={row} detail={alertText(row.alert!, now)} onOpen={onOpenTag} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
