import { AGE_COLOR, batteryColor, formatAge, positionAge, type PositionAge, type TagSnapshot } from '@tagexplore/core';

interface Props {
  snapshots: TagSnapshot[];
  selectedTagId: string | null;
  onSelect: (tagId: string) => void;
  now: number;
}

export function TagList({ snapshots, selectedTagId, onSelect, now }: Props): JSX.Element {
  if (snapshots.length === 0) {
    return (
      <div className="list">
        <div className="empty">
          No tags match these filters. Widen the window, clear the search, or turn a fix-age filter back on.
        </div>
      </div>
    );
  }

  return (
    <div className="list">
      {snapshots.map((tag) => {
        const age: PositionAge = positionAge(tag.fixAt, now);
        return (
          <button
            key={tag.tagId}
            className="row"
            aria-selected={tag.tagId === selectedTagId}
            onClick={() => onSelect(tag.tagId)}
          >
            <span className="bar" style={{ background: AGE_COLOR[age] }} />
            <span>
              <span className="sn">
                {tag.tagId}
                {tag.label && <span className="tag-label">{tag.label}</span>}
              </span>
              <span className="meta">
                {tag.lat === null ? 'no fix' : `fix ${formatAge(now - (tag.fixAt as number))} ago`} · seen{' '}
                {formatAge(now - tag.lastSeenAt)} ago
              </span>
            </span>
            <span className="batt">
              <span style={{ color: batteryColor(tag.batteryMv) }}>
                {tag.batteryMv === null ? '—' : `${tag.batteryMv}mV`}
              </span>
              <small>{tag.readingCount} rounds</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
