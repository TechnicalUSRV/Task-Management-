import { useId, useRef, type ReactElement, type ReactNode } from 'react';
import { Popover } from 'radix-ui';
import './styles/day-preview.css';

/** One explicitly selected day's items. Hover and focus never open a panel. */
export function DayPanel({ label, count, children, details, open, onOpenChange, className = '' }: {
  label: string; count: number; children: ReactElement; details: ReactNode; open: boolean; onOpenChange: (open: boolean) => void; className?: string;
}) {
  const heading = useId(), anchor = useRef<HTMLDivElement>(null), restoreFocus = useRef(false);
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Anchor asChild ref={anchor} onClick={e => {
      // Date buttons and blank date space open the day. Event and Add Note buttons keep their own actions.
      if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
      const control = (e.target as HTMLElement).closest('button, a, input, select');
      if (!control || control.hasAttribute('data-day-trigger')) onOpenChange(true);
    }}>
      {children}
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content className={`day-preview ${className}`} side="bottom" align="start" sideOffset={6} collisionPadding={12}
        aria-labelledby={heading} onCloseAutoFocus={e => {
          e.preventDefault();
          if (restoreFocus.current) { restoreFocus.current = false; anchor.current?.querySelector<HTMLElement>('[data-day-trigger]')?.focus({ preventScroll: true }); }
        }} onEscapeKeyDown={e => { e.stopPropagation(); restoreFocus.current = true; }}>
        <header className="day-preview-head"><div><h3 id={heading}>{label}</h3><p>{count} {count === 1 ? 'item' : 'items'}</p></div>
          <button type="button" className="day-preview-close" onClick={() => { restoreFocus.current = true; onOpenChange(false); }}>Close</button>
        </header>
        <div className="day-preview-list" onClick={e => { if ((e.target as HTMLElement).closest('button')) onOpenChange(false); }}>
          {count ? details : <p className="day-preview-empty">Nothing planned for this day.</p>}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
