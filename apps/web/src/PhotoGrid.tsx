import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { pinchColumns, rangeSelection } from './gridSelection';

interface Props {
  ids: string[];
  selected: ReadonlySet<string>;
  onSelectionChange: (selection: Set<string>) => void;
  selectionMode: boolean;
  disabled: boolean;
  columns: number;
  maxColumns?: number;
  onColumnsChange: (columns: number) => void;
  children: ReactNode;
}
interface Sweep {
  anchor: number;
  baseline: Set<string>;
  startX: number;
  startY: number;
  x: number;
  y: number;
  lastIndex: number;
  locked: boolean;
  immediate: boolean;
}
interface Pinch { distance: number; columns: number }

export function PhotoGrid(props: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const suppressUntil = useRef(0);
  const cancelledContact = useRef(false);
  const idsKey = props.ids.join('\0');
  useEffect(() => { current.current = props; });

  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const ids = current.current.ids;
    let sweep: Sweep | null = null;
    let pinch: Pinch | null = null;
    let pointerId: number | null = null;
    let touchId: number | null = null;
    let frame = 0;
    let lastFrame = 0;
    let live = true;

    const photoAt = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return -1;
      const card = target.closest<HTMLElement>('[data-photo-id]');
      if (!card || !element.contains(card)) return -1;
      const control = target.closest('button,a,input,select,textarea');
      if (control && !control.matches('.photo-open,.photo-select')) return -1;
      return ids.indexOf(card.dataset.photoId ?? '');
    };
    const indexAt = (x: number, y: number) => photoAt(document.elementFromPoint(x, y));
    const scrollIndexAt = (x: number, y: number) => {
      const tray = document.querySelector<HTMLElement>('.download-tray')?.getBoundingClientRect();
      const hitY = tray && x >= tray.left && x <= tray.right && y >= tray.top ? Math.max(1, tray.top - 8) : y;
      const direct = indexAt(x, hitY);
      if (direct >= 0) return direct;
      // While an existing sweep scrolls at an edge, fixed controls/gaps must not
      // stop its range. Only consider this grid's authorized visible cards.
      let closest = -1; let distance = Infinity;
      for (const card of element.querySelectorAll<HTMLElement>('[data-photo-id]')) {
        const rect = card.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
        const dx = Math.max(rect.left - x, 0, x - rect.right);
        const dy = Math.max(rect.top - hitY, 0, hitY - rect.bottom);
        const next = dx * dx + dy * dy;
        const index = ids.indexOf(card.dataset.photoId ?? '');
        if (index >= 0 && next < distance) { distance = next; closest = index; }
      }
      return closest;
    };
    const stopScroll = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0; lastFrame = 0;
    };
    const releaseCapture = () => {
      if (pointerId !== null && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      pointerId = null;
    };
    const stop = (restore: boolean) => {
      stopScroll();
      if (restore && sweep?.locked && live && !current.current.disabled) current.current.onSelectionChange(new Set(sweep.baseline));
      sweep = null; pinch = null; touchId = null;
      releaseCapture();
    };
    const apply = (index: number) => {
      if (!sweep || index < 0 || index === sweep.lastIndex) return;
      sweep.lastIndex = index;
      current.current.onSelectionChange(rangeSelection(ids, sweep.baseline, sweep.anchor, index));
    };
    const scroll = (time: number) => {
      frame = 0;
      if (!sweep?.locked || !live || current.current.disabled) return;
      const margin = 64;
      const height = window.innerHeight;
      const moved = Math.hypot(sweep.x - sweep.startX, sweep.y - sweep.startY) >= 8;
      const speed = !moved ? 0 : sweep.y < margin ? -Math.min(1, (margin - sweep.y) / margin) : sweep.y > height - margin ? Math.min(1, (sweep.y - height + margin) / margin) : 0;
      const delta = lastFrame ? Math.min(32, time - lastFrame) : 16;
      lastFrame = time;
      if (speed) {
        window.scrollBy({ top: speed * delta * 0.65, behavior: 'instant' });
        apply(scrollIndexAt(sweep.x, Math.max(1, Math.min(height - 1, sweep.y))));
      }
      frame = requestAnimationFrame(scroll);
    };
    const lock = () => {
      if (!sweep || sweep.locked) return;
      sweep.locked = true;
      if (pointerId !== null) element.setPointerCapture(pointerId);
      suppressUntil.current = Date.now() + 350;
      apply(sweep.anchor);
      frame = requestAnimationFrame(scroll);
    };
    const begin = (target: EventTarget | null, x: number, y: number) => {
      const anchor = photoAt(target);
      const immediate = target instanceof Element && !!target.closest('.photo-select');
      if (anchor < 0 || (!current.current.selectionMode && !immediate)) return false;
      sweep = { anchor, baseline: new Set(current.current.selected), startX: x, startY: y, x, y, lastIndex: -1, locked: false, immediate };
      return true;
    };
    const move = (x: number, y: number, isTouch: boolean) => {
      if (!sweep) return;
      sweep.x = x; sweep.y = y;
      const dx = Math.abs(x - sweep.startX); const dy = Math.abs(y - sweep.startY);
      if (!sweep.locked) {
        if (isTouch && !sweep.immediate && dy > 8 && dy > dx) { stop(false); return; }
        if (Math.max(dx, dy) < 8) return;
        lock();
      }
      apply(indexAt(x, y));
    };
    const distance = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    const touchStart = (event: TouchEvent) => {
      if (current.current.disabled) return;
      if (event.touches.length === 1 && !sweep && !pinch) { suppressUntil.current = 0; cancelledContact.current = false; }
      if (event.touches.length >= 2) {
        if (!pinch) {
          if (sweep?.locked) current.current.onSelectionChange(new Set(sweep.baseline));
          stopScroll(); sweep = null; touchId = null;
          pinch = { distance: distance(event.touches), columns: current.current.columns };
        }
        event.preventDefault(); suppressUntil.current = Date.now() + 350;
      } else if (!pinch && event.touches.length === 1) {
        const touch = event.touches[0]!;
        if (begin(event.target, touch.clientX, touch.clientY)) {
          touchId = touch.identifier;
          if (sweep?.immediate) { lock(); event.preventDefault(); }
        }
      }
    };
    const touchMove = (event: TouchEvent) => {
      if (pinch) {
        event.preventDefault();
        if (event.touches.length >= 2) {
          const next = pinchColumns(pinch.columns, pinch.distance, distance(event.touches), current.current.maxColumns);
          if (next !== current.current.columns) current.current.onColumnsChange(next);
        }
        return;
      }
      const touch = Array.from(event.touches).find(touch => touch.identifier === touchId);
      if (!touch) return;
      move(touch.clientX, touch.clientY, true);
      if (sweep?.locked) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      if (pinch) {
        event.preventDefault(); suppressUntil.current = Date.now() + 350;
        // Do not turn the remaining finger into a new sweep after pinching.
        if (event.touches.length === 0) stop(false);
        return;
      }
      if (touchId !== null && !Array.from(event.touches).some(touch => touch.identifier === touchId)) {
        if (sweep?.locked) { event.preventDefault(); suppressUntil.current = Date.now() + 350; }
        stop(false);
      }
    };
    const touchCancel = () => { cancelledContact.current = true; suppressUntil.current = Date.now() + 350; stop(true); };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0 || !event.isPrimary || current.current.disabled || sweep || pinch) return;
      suppressUntil.current = 0; cancelledContact.current = false;
      if (begin(event.target, event.clientX, event.clientY)) {
        pointerId = event.pointerId;
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerId !== pointerId) return;
      move(event.clientX, event.clientY, false);
      if (sweep?.locked) event.preventDefault();
    };
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerId !== pointerId) return;
      if (sweep?.locked) { event.preventDefault(); suppressUntil.current = Date.now() + 350; }
      stop(false);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.pointerId === pointerId) { cancelledContact.current = true; suppressUntil.current = Date.now() + 350; stop(true); }
    };
    const click = (event: MouseEvent) => {
      if (event.detail !== 0 && (cancelledContact.current || Date.now() < suppressUntil.current) && event.target instanceof Element && event.target.closest('.photo-open,.photo-select,.add-card')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const blur = () => { cancelledContact.current = true; suppressUntil.current = Date.now() + 350; stop(true); };
    const visibility = () => { if (document.hidden) blur(); };
    const dragStart = (event: DragEvent) => {
      if (sweep) event.preventDefault();
    };
    element.addEventListener('touchstart', touchStart, { passive: false });
    element.addEventListener('touchmove', touchMove, { passive: false });
    element.addEventListener('touchend', touchEnd, { passive: false });
    element.addEventListener('touchcancel', touchCancel);
    element.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    element.addEventListener('click', click, true);
    element.addEventListener('dragstart', dragStart);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      const suppress = !!sweep?.locked || !!pinch;
      live = false; stop(false);
      if (suppress) { cancelledContact.current = true; suppressUntil.current = Date.now() + 350; }
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('touchend', touchEnd);
      element.removeEventListener('touchcancel', touchCancel);
      element.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      element.removeEventListener('click', click, true);
      element.removeEventListener('dragstart', dragStart);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [idsKey, props.selectionMode, props.disabled, props.maxColumns]);

  return <div ref={grid} className="photo-grid" data-columns={props.columns} data-selecting={props.selectionMode} style={{ '--photo-columns': props.columns } as CSSProperties}>{props.children}</div>;
}
