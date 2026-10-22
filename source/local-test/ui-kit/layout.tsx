import { uiText, useLanguage } from "../i18n";
import { useId, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Crumb = { label: ReactNode; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  useLanguage();
  // A single crumb would only repeat the page title, so the trail starts at two levels.
  if (items.length < 2) return null;
  return (
    <nav aria-label={uiText("Breadcrumb")} className="breadcrumbs">
      <ol>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i}>
              {last || !c.href ? <span aria-current={last ? 'page' : undefined}>{c.label}</span> : <a href={c.href}>{c.label}</a>}
              {!last && <ChevronRight className="crumb-sep" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Predictable page top: breadcrumbs → title (+ status) → description/meta → actions.
 * Filters and content follow in that order below it.
 */
export function PageHeader({ crumbs, title, badge, description, meta, actions, children, className }: {
  crumbs?: Crumb[]; title: ReactNode; badge?: ReactNode; description?: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  useLanguage();
  return (
    <header className={cn('page-header', className)}>
      {crumbs && <Breadcrumbs items={crumbs} />}
      <div className="page-header-row">
        <div className="page-title-block">
          <div className="page-title-line">
            <h1 className="page-title">{title}</h1>
            {badge}
          </div>
          {description && <p className="page-description">{description}</p>}
          {meta && <div className="page-meta">{meta}</div>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Route-level tabs (each tab is an address). */
export function SectionTabs({ items, active, label, className }: { items: { id: string; label: ReactNode; href: string; count?: number; icon?: LucideIcon }[]; active: string; label: string; className?: string }) {
  useLanguage();
  return (
    <nav className={cn('section-tabs', className)} aria-label={label}>
      <div className="section-tabs-track">
        {items.map(({ id, label: text, href, count, icon: Icon }) => (
          <a key={id} href={href} className="section-tab" aria-current={id === active ? 'page' : undefined}>
            {Icon && <Icon aria-hidden="true" />}
            <span>{text}</span>
            {count !== undefined && <span className="section-tab-count">{count}</span>}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** Mutually exclusive view switch (List / Board / Cards …). */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: LucideIcon; count?: number; hideLabel?: boolean }[]; label: string; size?: 'sm' | 'md'; className?: string;
}) {
  useLanguage();
  return (
    <div role="group" aria-label={label} className={cn('segmented', `segmented-${size}`, className)}>
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} title={o.hideLabel && typeof o.label === 'string' ? o.label : undefined} aria-label={o.hideLabel && typeof o.label === 'string' ? o.label : undefined}>
          {o.icon && <o.icon aria-hidden="true" />}
          {!o.hideLabel && <span>{o.label}</span>}
          {o.count !== undefined && <span className="segmented-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Surface for a titled block of content. */
export function Card({ title, description, actions, children, footer, className, bodyClassName, flush, id, headingLevel = 2 }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; bodyClassName?: string; flush?: boolean; id?: string; headingLevel?: 2 | 3;
}) {
  useLanguage();
  const headingId = useId();
  const H = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section className={cn('card', flush && 'card-flush', className)} aria-labelledby={title ? headingId : undefined} id={id}>
      {(title || actions) && (
        <div className="card-header">
          <div className="card-heading">
            {title && <H className="card-title" id={headingId}>{title}</H>}
            {description && <p className="card-description">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && children !== null && children !== false && <div className={cn('card-body', bodyClassName)}>{children}</div>}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

/** A labelled region inside a page without its own surface. */
export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  useLanguage();
  const id = useId();
  return (
    <section className={cn('section', className)} aria-labelledby={title ? id : undefined}>
      {(title || actions) && <div className="section-header"><div>{title && <h2 className="section-title" id={id}>{title}</h2>}{description && <p className="section-description">{description}</p>}</div>{actions && <div className="section-actions">{actions}</div>}</div>}
      {children}
    </section>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  useLanguage();
  return <div className={cn('toolbar', className)}>{children}</div>;
}
