import { useState } from 'react';

export type MainView = 'global' | 'movement';

interface Props {
  view: MainView;
  onChange: (view: MainView) => void;
}

const OPTIONS: Array<{ value: MainView; label: string }> = [
  { value: 'global', label: 'Global Map' },
  { value: 'movement', label: 'Movement Map' },
];

/**
 * Sits to the left of the tag list, collapsed by default: a narrow rail you
 * expand to pick which main view the map area shows. Expanding lays the
 * options over the tag list as a floating panel — the list itself never
 * narrows or shifts to make room. Collapsing hides the labels, not the
 * current choice — the view stays whatever was last picked.
 */
export function ViewPanel({ view, onChange }: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <nav className="view-panel" data-collapsed={collapsed ? '1' : '0'}>
      <button
        className="view-panel-toggle"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand view panel' : 'Collapse view panel'}
      >
        ☰
      </button>
      {!collapsed && (
        <div className="view-panel-options">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              className="view-panel-option"
              data-active={view === o.value ? '1' : '0'}
              onClick={() => {
                onChange(o.value);
                setCollapsed(true);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
