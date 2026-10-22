import { uiText, useLanguage } from "../i18n";
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CalendarDays, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

type ShellProps = { label: ReactNode; required?: boolean; hint?: ReactNode; error?: string; wide?: boolean; className?: string; hideLabel?: boolean; fieldKey?: string };

/** Label + control + hint/error, wired together for assistive technology. */
export function FieldShell({ label, required, hint, error, wide, className, hideLabel, fieldKey, children }: ShellProps & { children: (ids: { id: string; describedBy?: string }) => ReactNode }) {
  useLanguage();
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined, errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('field', wide && 'span-2', error && 'has-error', className)} data-field={fieldKey}>
      <label htmlFor={id} className={cn('field-label', hideLabel && 'sr-only')}>
        {label}
        {/* The control itself carries required / aria-required, so assistive technology announces it once. */}
        {required && <span className="field-required" aria-hidden="true">*</span>}
      </label>
      {children({ id, describedBy })}
      {error && <p id={errorId} className="field-error"><AlertCircle aria-hidden="true" />{error}</p>}
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
    </div>
  );
}

export type FieldProps = ShellProps & {
  value: unknown; onChange: (v: string) => void; type?: string; disabled?: boolean; placeholder?: string;
  min?: string | number; max?: string | number; step?: string | number; rows?: number; autoComplete?: string; inputMode?: 'text' | 'decimal' | 'numeric' | 'email' | 'tel' | 'url' | 'search';
  maxLength?: number; readOnly?: boolean; onBlur?: () => void;
};

/** Text-like input. type="textarea" renders a multi-line field. */
export function Field({ label, value, onChange, type = 'text', required = false, wide = false, disabled = false, hint, error, placeholder, min, max, step, rows = 3, autoComplete, inputMode, maxLength, readOnly, onBlur, className, hideLabel, fieldKey }: FieldProps) {
  useLanguage();
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} wide={wide} className={className} hideLabel={hideLabel} fieldKey={fieldKey}>
      {({ id, describedBy }) => type === 'textarea'
        ? <Textarea id={id} value={String(value ?? '')} onChange={e => onChange(e.target.value)} rows={rows} disabled={disabled} required={required} placeholder={placeholder} aria-invalid={!!error || undefined} aria-describedby={describedBy} maxLength={maxLength} readOnly={readOnly} onBlur={onBlur} />
        : <Input id={id} type={type} value={String(value ?? '')} onChange={e => onChange(e.target.value)} required={required} disabled={disabled} placeholder={placeholder}
            step={step ?? (type === 'number' ? 'any' : undefined)} min={min ?? (type === 'number' ? 0 : undefined)} max={max} autoComplete={autoComplete}
            inputMode={inputMode ?? (type === 'number' ? 'decimal' : undefined)} aria-invalid={!!error || undefined} aria-describedby={describedBy} maxLength={maxLength} readOnly={readOnly} onBlur={onBlur} />}
    </FieldShell>
  );
}

/** Password input with a show/hide toggle. Never pre-filled from stored data. */
export function PasswordField({ label, value, onChange, required, hint, error, wide, className, fieldKey, autoComplete = 'current-password', disabled }: ShellProps & { value: string; onChange: (v: string) => void; autoComplete?: string; disabled?: boolean }) {
  useLanguage();
  const [show, setShow] = useState(false);
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} wide={wide} className={className} fieldKey={fieldKey}>
      {({ id, describedBy }) => (
        <div className="password-field">
          <Input id={id} type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} required={required} disabled={disabled} autoComplete={autoComplete}
            maxLength={200} aria-invalid={!!error || undefined} aria-describedby={describedBy} spellCheck={false} autoCapitalize="off" />
          <button type="button" className="password-toggle" aria-label={show ? uiText("Hide password") : uiText("Show password")} aria-pressed={show} disabled={disabled} onClick={() => setShow(!show)}>
            {show ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </div>
      )}
    </FieldShell>
  );
}

export type PickerProps = ShellProps & { value: unknown; onChange: (v: string) => void; options: [string, string][]; none?: string; disabled?: boolean; allowNone?: boolean };

/** Single choice from a list. `none` is the unselected option (placeholder). */
export function Picker({ label, value, onChange, options, none = 'Select…', disabled = false, required, hint, error, wide, className, hideLabel, allowNone = true, fieldKey }: PickerProps) {
  useLanguage();
  const current = value !== undefined && value !== null && value !== '' ? String(value) : '__none__';
  const known = current === '__none__' || options.some(([v]) => v === current);
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} wide={wide} className={className} hideLabel={hideLabel} fieldKey={fieldKey}>
      {({ id, describedBy }) => (
        // Radix can report '' when the option list changes under a new value (its hidden form <select> resets);
        // only real choices are passed on. Choosing the "none" entry arrives as '__none__'.
        <Select value={current} onValueChange={v => { if (v !== '') onChange(v === '__none__' ? '' : v); }} disabled={disabled}>
          <SelectTrigger id={id} className="w-full" aria-invalid={!!error || undefined} aria-describedby={describedBy} aria-required={required || undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(allowNone || current === '__none__') && <SelectItem value="__none__" className={cn(required && 'select-placeholder')}>{none}</SelectItem>}
            {!known && <SelectItem value={current}>{current}</SelectItem>}
            {options.filter(([v]) => v !== '').map(([v, n]) => <SelectItem key={v} value={v}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </FieldShell>
  );
}

export function CheckboxField({ label, checked, onChange, description, disabled, error, className }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; description?: ReactNode; disabled?: boolean; error?: string; className?: string }) {
  useLanguage();
  const id = useId();
  return (
    <div className={cn('check-field', error && 'has-error', className)}>
      <Checkbox id={id} checked={checked} onCheckedChange={v => onChange(v === true)} disabled={disabled} aria-invalid={!!error || undefined} aria-describedby={description ? `${id}-d` : undefined} />
      <div>
        <label htmlFor={id} className="check-label">{label}</label>
        {description && <p id={`${id}-d`} className="field-hint">{description}</p>}
        {error && <p className="field-error"><AlertCircle aria-hidden="true" />{error}</p>}
      </div>
    </div>
  );
}

export function SwitchField({ label, checked, onChange, description, disabled, className }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; description?: ReactNode; disabled?: boolean; className?: string }) {
  useLanguage();
  const id = useId();
  return (
    <div className={cn('switch-field', disabled && 'is-disabled', className)}>
      <div className="switch-text">
        <label htmlFor={id} className="check-label">{label}</label>
        {description && <p id={`${id}-d`} className="field-hint">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={description ? `${id}-d` : undefined} />
    </div>
  );
}

/** V5.6.8: an icon button that opens the browser's date picker, for screens that already show the chosen date in words
 *  (a visible date field would show mm/dd/yyyy, which reads as another date in Cambodia). */
export function DatePickerButton({ value, onChange, label = 'Go to date', className }: { value: string; onChange: (v: string) => void; label?: string; className?: string }) {
  useLanguage();
  const ref = useRef<HTMLInputElement>(null);
  const open = () => { const el = ref.current; if (!el) return; try { el.showPicker(); } catch { el.focus(); el.click(); } };
  return (
    <span className={cn('date-picker-button', className)}>
      <Button type="button" variant="outline" size="icon-sm" className="icon-button date-picker-trigger" aria-label={label} title={label} onClick={open}><CalendarDays aria-hidden="true" /></Button>
      <input ref={ref} type="date" tabIndex={-1} aria-hidden="true" value={value} onChange={e => { if (e.target.value) onChange(e.target.value); }} />
    </span>
  );
}

/** Groups related fields under a short heading. */
export function FormSection({ title, description, children, className, columns = 2 }: { title?: ReactNode; description?: ReactNode; children: ReactNode; className?: string; columns?: 1 | 2 | 3 }) {
  useLanguage();
  const id = useId();
  return (
    <fieldset className={cn('form-section', className)} aria-labelledby={title ? id : undefined}>
      {(title || description) && (
        <div className="form-section-head">
          {title && <legend className="form-section-title" id={id}>{title}</legend>}
          {description && <p className="form-section-description">{description}</p>}
        </div>
      )}
      <div className={cn('form-grid', `form-cols-${columns}`)}>{children}</div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- validation

export type FieldSpec = { key: string; label: string; required?: boolean; type?: string; aliases?: string[]; value?: unknown };

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)|·.*$|\*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Finds the field an error message is about, so the message can sit beside it. */
export function matchFieldError(message: string, fields: FieldSpec[]): string | null {
  const m = ` ${norm(message)} `;
  let best: string | null = null, bestLen = 0;
  for (const f of fields) {
    for (const candidate of [f.label, ...(f.aliases || [])]) {
      const l = norm(candidate);
      if (l.length < 3) continue;
      const hit = m.startsWith(` ${l} `) || m.includes(` valid ${l} `) || m.includes(` a valid ${l} `) || m.includes(` select ${l} `) || m.includes(` active ${l} `) || m.includes(` ${l} is required`) || m.includes(` ${l} must `) || m.includes(` ${l} cannot `);
      if (hit && l.length > bestLen) { best = f.key; bestLen = l.length; }
    }
  }
  if (!best && / email /.test(m)) best = fields.find(f => f.type === 'email')?.key ?? null;
  return best;
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * Collects field specs during render, validates required fields before submit
 * and places server errors next to the matching field. Unmatched errors stay in
 * the form-level alert. Entered values are never cleared on failure.
 */
export function useFormErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const specs = useRef<FieldSpec[]>([]);
  specs.current = [];
  const register = useCallback((spec: FieldSpec) => { specs.current.push(spec); return spec.key; }, []);
  const clear = useCallback((key: string) => setErrors(e => { if (!e[key]) return e; const next = { ...e }; delete next[key]; return next; }), []);
  const validate = () => {
    const next: Record<string, string> = {};
    for (const f of specs.current) if (f.required && isBlank(f.value)) next[f.key] = f.type === 'select' ? `Select ${f.label.replace(/\s*\*$/, '').toLowerCase()}.` : `Enter ${f.label.replace(/\s*\*$/, '').toLowerCase()}.`;
    setErrors(next);
    if (Object.keys(next).length) {
      setFormError(Object.keys(next).length === 1 ? uiText("Complete the highlighted field.") : `Complete the ${Object.keys(next).length} highlighted fields.`);
      requestAnimationFrame(() => (document.querySelector('.dialog-surface .has-error input, .dialog-surface .has-error textarea, .dialog-surface .has-error button, .has-error input, .has-error textarea, .has-error [role=combobox]') as HTMLElement | null)?.focus());
      return false;
    }
    return true;
  };
  const fail = (message: string) => {
    const key = matchFieldError(message, specs.current);
    setFormError(message);
    setErrors(key ? { [key]: message } : {});
  };
  const reset = () => { setErrors({}); setFormError(''); };
  /** Puts a message beside a known field (and in the form summary). */
  const setFieldError = (key: string, message: string, summary = message) => { setErrors({ [key]: message }); setFormError(summary); };
  return { errors, formError, register, clear, validate, fail, reset, setFormError, setFieldError };
}
