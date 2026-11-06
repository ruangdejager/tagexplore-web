import { useEffect, useRef, useState } from 'react';

/**
 * The Farmranger logo with the organisation's name beside it. With more than
 * one organisation the name is a dropdown: one tap opens the list, one tap
 * picks. Tapping anywhere else closes it.
 */
export function OrgPicker(props: {
  orgs: Array<{ id: string; name: string }>;
  orgId: string | null;
  onPick: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const name = props.orgs.find((o) => o.id === props.orgId)?.name ?? 'No organisation';
  const canPick = props.orgs.length > 1;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="brand" ref={ref}>
      <img className="brand-logo" src="/m/farmranger-logo.svg" alt="Farmranger" width="34" height="34" />
      <button
        type="button"
        className="org-picker"
        onClick={() => canPick && setOpen((v) => !v)}
        aria-haspopup={canPick ? 'listbox' : undefined}
        aria-expanded={canPick ? open : undefined}
        disabled={!canPick}
      >
        <span className="org-picker-name">{name}</span>
        {canPick && (
          <svg className={`org-caret ${open ? 'up' : ''}`} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <ul className="org-menu" role="listbox" aria-label="Organisation">
          {props.orgs.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                role="option"
                aria-selected={o.id === props.orgId}
                className={o.id === props.orgId ? 'selected' : ''}
                onClick={() => {
                  props.onPick(o.id);
                  setOpen(false);
                }}
              >
                <span>{o.name}</span>
                {o.id === props.orgId && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
