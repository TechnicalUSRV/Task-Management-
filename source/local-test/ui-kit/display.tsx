import { uiText, useLanguage } from "../i18n";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Check, CheckCircle2, Clock3, Info, Minus, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { MISSING, formatDate, formatDateTime, formatDuration, formatMoney, formatNumber, humanize, initials, isMissing } from '../format';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'purple' | 'accent';

// ---------------------------------------------------------------- values

/** Placeholder for an absent value. Visually "—", announced as "Not provided". */
export function Missing({ label = 'Not provided' }: { label?: string }) {
  useLanguage();
  return <span className="missing" title={label}><span aria-hidden="true">{MISSING}</span><span className="sr-only">{label}</span></span>;
}

export function Money({ cents, currency = 'USD', className, emphasize }: { cents: unknown; currency?: string; className?: string; emphasize?: boolean }) {
  useLanguage();
  const text = formatMoney(cents, currency);
  if (text === null) return <Missing />;
  return <span className={cn('num', Number(cents) < 0 && 'num-negative', emphasize && 'num-strong', className)}>{text}</span>;
}

export function Num({ value, digits, suffix, className }: { value: unknown; digits?: number; suffix?: string; className?: string }) {
  useLanguage();
  const text = formatNumber(value, digits);
  if (text === null) return <Missing />;
  return <span className={cn('num', className)}>{text}{suffix}</span>;
}

export function Duration({ minutes, className }: { minutes: unknown; className?: string }) {
  useLanguage();
  const text = formatDuration(minutes);
  if (text === null) return <Missing />;
  return <span className={cn('num', className)} title={uiText("{p0} h {p1} min", { p0: Math.floor(Number(minutes) / 60), p1: Number(minutes) % 60 })}>{text}</span>;
}

export function DateText({ value, withTime = false, className }: { value: unknown; withTime?: boolean; className?: string }) {
  useLanguage();
  if (isMissing(value)) return <Missing />;
  const text = withTime ? formatDateTime(value) : formatDate(value);
  const full = String(value).length > 10 ? formatDateTime(value) : formatDate(value);
  return <time className={cn('date-text', className)} dateTime={String(value)} title={full || undefined}>{text}</time>;
}

// ---------------------------------------------------------------- status

const STATUS_TONES: Record<string, Tone> = {
  // positive / finished
  WON: 'success', PAID: 'success', ACCEPTED: 'success', APPROVED: 'success', COMPLETED: 'success', CONVERTED: 'success',
  CLOSED: 'success', FINANCE_VERIFIED: 'success', ISSUED: 'success', CONFIRMED: 'success', ACTIVE: 'success', YES: 'success', ALLOW: 'success',
  // in motion
  OPEN: 'info', NEW: 'info', IN_PROGRESS: 'info', SCHEDULED: 'info', IN_TRANSIT: 'info', ORDERED: 'info', ARRIVED_PORT: 'info', RECEIPT: 'info',
  QUALIFIED: 'purple', INVOICED: 'purple', SHIPPED: 'purple', DELIVERING: 'purple', IN_REVIEW: 'purple', AF_VERIFICATION: 'purple',
  // needs attention
  SUBMITTED: 'warning', DUE: 'warning', RETURNED: 'warning', RECEIVED_UNCONFIRMED: 'warning', UNPAID: 'warning', WARM: 'warning', MEDIUM: 'neutral',
  // problems
  LOST: 'danger', REJECTED: 'danger', OVERDUE: 'danger', HOT: 'danger', HIGH: 'danger', DENY: 'danger', LATE: 'danger', STUCK: 'danger', DECLINED: 'danger',
  PENDING: 'warning', AWAITING_ACCEPTANCE: 'warning', WITHDRAWN: 'neutral', ON: 'success', OFF: 'neutral',
  // inactive
  DRAFT: 'neutral', INACTIVE: 'neutral', DISQUALIFIED: 'neutral', SUSPENDED: 'neutral', CANCELLED: 'neutral', DISABLED: 'neutral',
  ARCHIVED: 'neutral', NOT_STARTED: 'neutral', NOT_RECEIVED: 'neutral', LOW: 'neutral', COLD: 'neutral', EXPIRED: 'neutral', NO: 'neutral',
};
const STATUS_LABELS: Record<string, string> = {
  AF_VERIFICATION: 'A/F verification', RECEIVED_UNCONFIRMED: 'Received · unconfirmed', NOT_RECEIVED: 'Not received',
  FINANCE_VERIFIED: 'Finance verified', ARRIVED_PORT: 'Arrived at port', IN_TRANSIT: 'In transit', AFTER_SALE: 'After sale',
  OPS_LEGACY: 'Earlier handoff', PR: 'Payment request', DN: 'Debit note', PO: 'Purchase order', JOB: 'Job file', QUOTATION: 'Quotation',
};
export const statusKey = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/[\s/-]+/g, '_');
export const statusTone = (value: unknown): Tone => STATUS_TONES[statusKey(value)] || 'neutral';
export const statusLabel = (value: unknown) => uiText(STATUS_LABELS[statusKey(value)] || humanize(value));

const TONE_ICON: Partial<Record<Tone, LucideIcon>> = { success: Check, warning: Clock3, danger: AlertCircle };

/** Status pill: text label + tone + shape cue, so meaning never depends on color alone. */
export function StatusBadge({ value, label, tone, className, title }: { value?: unknown; label?: ReactNode; tone?: Tone; className?: string; title?: string }) {
  useLanguage();
  if (isMissing(value) && label === undefined) return <Missing />;
  const t = tone || statusTone(value);
  const Icon = TONE_ICON[t];
  return (
    <span className={cn('badge', `tone-${t}`, className)} title={title}>
      {Icon ? <Icon className="badge-icon" aria-hidden="true" /> : <span className="badge-dot" aria-hidden="true" />}
      <span>{label ?? statusLabel(value)}</span>
    </span>
  );
}

// V5.6.8: only High stands out (red). Medium, on most rows, is neutral text; Low is quieter still.
const PRIORITY: Record<string, { icon: LucideIcon; tone: Tone; label: string; muted?: boolean }> = {
  HIGH: { icon: ArrowUp, tone: 'danger', get label() { return uiText("High"); } },
  MEDIUM: { icon: Minus, tone: 'neutral', get label() { return uiText("Medium"); } },
  LOW: { icon: ArrowDown, tone: 'neutral', get label() { return uiText("Low"); }, muted: true },
};
export function PriorityBadge({ value }: { value?: string }) {
  useLanguage();
  const p = PRIORITY[statusKey(value)];
  if (!p) return <StatusBadge value={value} />;
  const Icon = p.icon;
  return <span className={cn('priority', `tone-${p.tone}`, p.muted && 'is-muted')} title={uiText("{p0} priority", { p0: p.label })}><Icon className="priority-icon" aria-hidden="true" /><span>{p.label}</span></span>;
}

/** Small neutral tag for categories and types (not state). */
export function Tag({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  useLanguage();
  return <span className={cn('tag', className)} title={title}>{children}</span>;
}

// ---------------------------------------------------------------- people

// Profile photos (V5.3). The app provides a lookup from a person's name to their photo address (staff names are
// unique), so every avatar on every screen shows the photo without each screen passing it along.
const AvatarPhotos = createContext<(name: string) => string | undefined>(() => undefined);
export function AvatarPhotoProvider({ photo, children }: { photo: (name: string) => string | undefined; children: ReactNode }) {
  useLanguage();
  return <AvatarPhotos.Provider value={photo}>{children}</AvatarPhotos.Provider>;
}
export const useAvatarPhoto = () => useContext(AvatarPhotos);

export function Avatar({ name, size = 'md', className, src }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; src?: string }) {
  useLanguage();
  const lookup = useContext(AvatarPhotos), url = src ?? lookup(name), [failed, setFailed] = useState('');
  if (url && failed !== url) return <span className={cn('avatar', 'avatar-photo', `avatar-${size}`, className)} aria-hidden="true"><img src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url)} /></span>;
  // A stable hue per person (from their name) keeps a face recognisable across screens.
  let hash = 0; for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const palette = ['#dbe6ff/#1d43b5', '#e5ddf9/#5b36a8', '#d7f0e6/#0b6b44', '#ffe9cc/#8a4b00', '#fde0e6/#9f1d3a', '#dcf1f7/#0b5f73'];
  const [bg, fg] = palette[hash % palette.length].split('/');
  return <span className={cn('avatar', `avatar-${size}`, className)} style={{ background: bg, color: fg }} aria-hidden="true">{initials(name)}</span>;
}

export function AvatarStack({ names, max = 4, label }: { names: string[]; max?: number; label?: string }) {
  useLanguage();
  if (!names.length) return <Missing label={uiText("No one assigned")} />;
  const shown = names.slice(0, max);
  const text = label || names.join(', ');
  return (
    <span className="avatar-stack" role="img" aria-label={text} title={text}>
      {shown.map((n, i) => <Avatar key={`${n}-${i}`} name={n} size="sm" />)}
      {names.length > max && <span className="avatar avatar-sm avatar-more" aria-hidden="true">+{names.length - max}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- measures

export function ProgressBar({ value, label, showValue = true, tone = 'accent', size = 'md' }: { value: number; label?: string; showValue?: boolean; tone?: 'accent' | 'success' | 'warning' | 'danger'; size?: 'sm' | 'md' }) {
  useLanguage();
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return (
    <div className={cn('progress', `progress-${size}`)}>
      <div className={cn('progress-track', `progress-${tone}`)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label || uiText("Progress")}>
        <span style={{ width: `${v}%` }} />
      </div>
      {showValue && <span className="progress-value num">{v}%</span>}
    </div>
  );
}

// ---------------------------------------------------------------- text

/** Long text clamped to a few lines with an explicit way to reveal the rest. */
export function ExpandableText({ text, lines = 2, className, empty }: { text?: string | null; lines?: number; className?: string; empty?: ReactNode }) {
  useLanguage();
  const [open, setOpen] = useState(false), [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null), id = useId();
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 2);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [text, lines]);
  if (isMissing(text)) return <>{empty ?? <Missing />}</>;
  return (
    <div className={cn('expandable', className)}>
      <p id={id} ref={ref} className="expandable-text" style={open ? undefined : { WebkitLineClamp: lines, lineClamp: lines } as CSSProperties} data-open={open || undefined}>{text}</p>
      {(overflows || open) && <button type="button" className="expandable-toggle" aria-expanded={open} aria-controls={id} onClick={e => { e.stopPropagation(); setOpen(!open); }}>{open ? uiText("Show less") : uiText("Show more")}</button>}
    </div>
  );
}

/** Label/value list for record details. Missing values render as "—". */
export function KeyValues({ items, columns = 1, className, dense }: { items: [ReactNode, ReactNode, string?][]; columns?: 1 | 2 | 3; className?: string; dense?: boolean }) {
  useLanguage();
  return (
    <dl className={cn('kv', `kv-cols-${columns}`, dense && 'kv-dense', className)}>
      {items.map(([label, value, key], i) => (
        <div className="kv-row" key={key || (typeof label === 'string' ? label : i)}>
          <dt>{label}</dt>
          <dd>{isMissing(value as unknown) || value === false ? <Missing /> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- stat card

export function StatCard({ label, value, unit, caption, detail, icon: Icon, tone, href, onClick, actionLabel, className }: {
  label: string; value: ReactNode; unit?: ReactNode; caption?: ReactNode; detail?: ReactNode; icon?: LucideIcon; tone?: Tone;
  href?: string; onClick?: () => void; actionLabel?: string; className?: string;
}) {
  useLanguage();
  const body = (
    <>
      <span className="stat-top">
        <span className="stat-label">{label}</span>
        {Icon && <span className={cn('stat-icon', tone && `tone-${tone}`)} aria-hidden="true"><Icon /></span>}
      </span>
      <span className="stat-value">{value}{unit && <span className="stat-unit">{unit}</span>}</span>
      {caption && <span className="stat-caption">{caption}</span>}
      {detail && <span className="stat-detail">{detail}</span>}
      {(href || onClick) && <span className="stat-link" aria-hidden="true"><ArrowRight /></span>}
    </>
  );
  const cls = cn('stat-card', (href || onClick) && 'is-interactive', className);
  if (href) return <a className={cls} href={href} aria-label={actionLabel}>{body}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={actionLabel}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

// ---------------------------------------------------------------- stepper

export type Step = { label: ReactNode; description?: ReactNode; state: 'done' | 'current' | 'upcoming' | 'error' | 'skipped'; href?: string; onClick?: () => void };
export function Stepper({ steps, label, orientation = 'horizontal', className }: { steps: Step[]; label: string; orientation?: 'horizontal' | 'vertical'; className?: string }) {
  useLanguage();
  const stateText = { done: 'Completed', current: 'Current step', upcoming: 'Not started', error: uiText("Needs attention"), skipped: 'Skipped' };
  return (
    <ol className={cn('stepper', `stepper-${orientation}`, className)} aria-label={label}>
      {steps.map((s, i) => {
        const marker = s.state === 'done' ? <Check aria-hidden="true" /> : s.state === 'error' ? <X aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>;
        const content = <><span className="step-marker">{marker}</span><span className="step-text"><span className="step-label">{s.label}</span>{s.description && <span className="step-description">{s.description}</span>}<span className="sr-only">{stateText[s.state]}</span></span></>;
        return (
          <li key={i} className={cn('step', `step-${s.state}`)} aria-current={s.state === 'current' ? 'step' : undefined}>
            {s.href ? <a className="step-inner" href={s.href}>{content}</a> : s.onClick ? <button type="button" className="step-inner" onClick={s.onClick}>{content}</button> : <span className="step-inner">{content}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- alerts & actions

const ALERT_ICON: Record<Tone, LucideIcon> = { success: CheckCircle2, warning: AlertTriangle, danger: AlertCircle, info: Info, neutral: Info, purple: Info, accent: Info };
export function Alert({ tone = 'info', title, children, action, className, icon, live }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; icon?: LucideIcon; live?: boolean }) {
  useLanguage();
  const Icon = icon || ALERT_ICON[tone];
  return (
    <div className={cn('alert', `tone-${tone}`, className)} role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}>
      <Icon className="alert-icon" aria-hidden="true" />
      <div className="alert-body">{title && <p className="alert-title">{title}</p>}{children && <div className="alert-text">{children}</div>}</div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  );
}

/** Icon-only button with an accessible name and a tooltip. */
export function IconButton({ label, icon: Icon, tooltip = true, className, size = 'icon-sm', variant = 'ghost', ...props }: Omit<ComponentProps<typeof Button>, 'children'> & { label: string; icon: LucideIcon; tooltip?: boolean }) {
  useLanguage();
  const button = <Button type="button" variant={variant} size={size} aria-label={label} className={cn('icon-button', className)} {...props}><Icon aria-hidden="true" /></Button>;
  if (!tooltip) return button;
  return <Tooltip><TooltipTrigger asChild>{button}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

/** An anchor styled as a button (downloads, print views, navigation). */
export function ButtonLink({ href, variant = 'outline', size = 'default', className, children, ...props }: ComponentProps<'a'> & { variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'link'; size?: 'default' | 'sm' | 'xs' | 'lg' }) {
  useLanguage();
  return <a href={href} className={cn(buttonVariants({ variant, size }), className)} {...props}>{children}</a>;
}

/** Announces text to screen readers without showing it. */
export function LiveRegion({ message }: { message: string }) {
  useLanguage();
  const [text, setText] = useState('');
  useEffect(() => { const t = setTimeout(() => setText(message), 50); return () => clearTimeout(t); }, [message]);
  return <div className="sr-only" role="status" aria-live="polite">{text}</div>;
}
