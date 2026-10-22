import { uiText, useLanguage } from "../i18n";
import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox, Lock, RefreshCw, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type StateProps = { icon?: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean };

function State({ icon: Icon = Inbox, title, description, action, className, compact, tone = 'neutral', role }: StateProps & { tone?: 'neutral' | 'danger' | 'lock'; role?: string }) {
  useLanguage();
  return (
    <div className={cn('state', compact && 'state-compact', `state-${tone}`, className)} role={role}>
      <span className="state-icon" aria-hidden="true"><Icon /></span>
      <p className="state-title">{title}</p>
      {description && <p className="state-description">{description}</p>}
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}

/** Nothing exists yet. Explain what will appear and how to add it. */
export const EmptyState = (p: StateProps) => <State {...p} />;

/** Filters matched nothing. Always offer a way back. */
export function NoResults({ onClear, title = 'No matching records', description = 'Try a different search or remove a filter.', compact }: { onClear?: () => void; title?: ReactNode; description?: ReactNode; compact?: boolean }) {
  useLanguage();
  return <State icon={SearchX} title={title} description={description} compact={compact} action={onClear && <Button variant="outline" size="sm" onClick={onClear}>{uiText("Clear filters")}</Button>} />;
}

export function ErrorState({ title = 'This information could not be loaded', message, onRetry, compact }: { title?: ReactNode; message?: ReactNode; onRetry?: () => void; compact?: boolean }) {
  useLanguage();
  return <State icon={AlertTriangle} tone="danger" role="alert" title={title} description={message} compact={compact} action={onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw />{uiText("Try again")}</Button>} />;
}

export function NoAccess({ title = 'You don’t have access to this area', description = 'Your role or individual function settings do not include View permission here. Ask an administrator if you need it.', action, compact }: { title?: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  useLanguage();
  return <State icon={Lock} tone="lock" title={title} description={description} action={action} compact={compact} />;
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  useLanguage();
  return <span className={cn('skeleton', className)} style={style} aria-hidden="true" />;
}

/** Layout-shaped placeholder while data loads. */
export function LoadingState({ label = 'Loading…', variant = 'table', rows = 6 }: { label?: string; variant?: 'table' | 'cards' | 'stats' | 'page'; rows?: number }) {
  useLanguage();
  return (
    <div className={cn('loading-state', `loading-${variant}`)} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === 'stats' && <div className="loading-grid">{Array.from({ length: 4 }, (_, i) => <div className="loading-card" key={i}><Skeleton className="sk-line sk-w40" /><Skeleton className="sk-line sk-lg sk-w60" /><Skeleton className="sk-line sk-w70" /></div>)}</div>}
      {variant === 'cards' && <div className="loading-grid">{Array.from({ length: rows }, (_, i) => <div className="loading-card tall" key={i}><Skeleton className="sk-line sk-w50" /><Skeleton className="sk-line sk-w90" /><Skeleton className="sk-line sk-w70" /><Skeleton className="sk-line sk-w30" /></div>)}</div>}
      {variant === 'table' && <div className="loading-table">{Array.from({ length: rows }, (_, i) => <div className="loading-row" key={i}><Skeleton className="sk-line sk-w20" /><Skeleton className="sk-line sk-w30" /><Skeleton className="sk-line sk-w15" /><Skeleton className="sk-line sk-w10" /></div>)}</div>}
      {variant === 'page' && <><div className="loading-head"><Skeleton className="sk-line sk-w20" /><Skeleton className="sk-line sk-xl sk-w40" /></div><div className="loading-grid">{Array.from({ length: 4 }, (_, i) => <div className="loading-card" key={i}><Skeleton className="sk-line sk-w40" /><Skeleton className="sk-line sk-lg sk-w60" /></div>)}</div><div className="loading-table">{Array.from({ length: rows }, (_, i) => <div className="loading-row" key={i}><Skeleton className="sk-line sk-w30" /><Skeleton className="sk-line sk-w20" /><Skeleton className="sk-line sk-w15" /></div>)}</div></>}
    </div>
  );
}
