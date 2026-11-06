import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/** How far (px) the sheet has to be pulled before letting go closes it. */
const CLOSE_DISTANCE = 110;
/** Or how fast (px/ms) a shorter flick has to be moving. */
const CLOSE_VELOCITY = 0.6;
const OUT_MS = 200;

/**
 * A bottom sheet over a dimmed backdrop. It closes by tapping the backdrop or
 * the handle, or by pulling it down, as iOS sheets do. A pull only starts
 * when the sheet is scrolled to its top, so scrolling a long card still
 * scrolls; pulling down from the top then becomes the close gesture.
 *
 * Touch events rather than pointer events: on iOS a vertical pan on scrollable
 * content is claimed by the browser's own scrolling and the pointer stream is
 * cancelled, whereas a non-passive `touchmove` can take it over.
 */
export function Sheet({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }): JSX.Element {
  const sheet = useRef<HTMLElement | null>(null);
  const backdrop = useRef<HTMLButtonElement | null>(null);
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = sheet.current;
    if (el) {
      el.style.transition = `transform ${OUT_MS}ms ease-in`;
      el.style.transform = 'translateY(100%)';
    }
    if (backdrop.current) {
      backdrop.current.style.transition = `opacity ${OUT_MS}ms ease-in`;
      backdrop.current.style.opacity = '0';
    }
    setTimeout(onClose, OUT_MS);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;
    let tracking = false;
    let dragging = false;

    const setOffset = (dy: number): void => {
      el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
      if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0, 1 - dy / (el.offsetHeight || 1)));
    };

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || closing.current) return;
      tracking = el.scrollTop <= 0;
      dragging = false;
      startX = e.touches[0]!.clientX;
      startY = lastY = e.touches[0]!.clientY;
      lastT = e.timeStamp;
      velocity = 0;
    };

    const onMove = (e: TouchEvent): void => {
      if (!tracking) return;
      const y = e.touches[0]!.clientY;
      const dy = y - startY;
      if (!dragging) {
        // Mostly sideways: a horizontal scroll (the raw readings table), not a pull.
        if (Math.abs(e.touches[0]!.clientX - startX) > Math.abs(dy)) {
          tracking = false;
          return;
        }
        // Pulling up, or the content has been scrolled: leave it to scrolling.
        if (dy < 0 || el.scrollTop > 0) {
          tracking = false;
          return;
        }
        if (dy < 6) return;
        dragging = true;
        el.style.transition = 'none';
        if (backdrop.current) backdrop.current.style.transition = 'none';
      }
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity = (y - lastY) / dt;
      lastY = y;
      lastT = e.timeStamp;
      setOffset(dy);
    };

    const onEnd = (): void => {
      if (!dragging) {
        tracking = false;
        return;
      }
      const dy = lastY - startY;
      tracking = false;
      dragging = false;
      if (dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY) {
        close();
      } else {
        el.style.transition = 'transform 180ms ease-out';
        if (backdrop.current) backdrop.current.style.transition = 'opacity 180ms ease-out';
        setOffset(0);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [close]);

  return (
    <div className="sheet-layer">
      <button ref={backdrop} className="sheet-backdrop" aria-label="Close" onClick={close} />
      <section ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        <button className="sheet-handle" aria-label="Close" onClick={close} />
        {children}
      </section>
    </div>
  );
}
