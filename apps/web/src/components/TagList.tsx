import { AGE_COLOR, batteryColor, batteryPercent, positionAge, type PositionAge, type TagSnapshot } from '@tagexplore/core';

interface Props {
  snapshots: TagSnapshot[];
  selectedTagId: string | null;
  onSelect: (tagId: string) => void;
  now: number;
  /** Tags currently hidden from the map — the list itself always shows every tag. */
  hiddenFromMap: Set<string>;
  onToggleMapVisibility: (tagId: string) => void;
}

export function TagList({
  snapshots,
  selectedTagId,
  onSelect,
  now,
  hiddenFromMap,
  onToggleMapVisibility,
}: Props): JSX.Element {
  if (snapshots.length === 0) {
    return (
      <div className="list">
        <div className="empty">No tags match your search.</div>
      </div>
    );
  }

  return (
    <div className="list">
      {snapshots.map((tag) => {
        const age: PositionAge = positionAge(tag.fixAt, now);
        const shownOnMap = !hiddenFromMap.has(tag.tagId);
        const pct = batteryPercent(tag.batteryMv);
        return (
          <div
            key={tag.tagId}
            className="row"
            role="button"
            tabIndex={0}
            aria-selected={tag.tagId === selectedTagId}
            onClick={() => onSelect(tag.tagId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(tag.tagId);
              }
            }}
          >
            <button
              className="row-visibility"
              data-on={shownOnMap ? '1' : '0'}
              title={shownOnMap ? 'Hide from map' : 'Show on map'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMapVisibility(tag.tagId);
              }}
            />
            <span className="bar" style={{ background: AGE_COLOR[age] }} />
            <span className="sn">
              {tag.tagId}
              {tag.label && <span className="tag-label">{tag.label}</span>}
            </span>
            <span
              className="batt-bar"
              title={tag.batteryMv === null ? 'Battery unknown' : `${tag.batteryMv}mV`}
            >
              <span className="batt-bar-fill" style={{ width: `${pct ?? 0}%`, background: batteryColor(tag.batteryMv) }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
