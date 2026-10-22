import { uiText, useLanguage } from "../i18n";
import { createContext, useCallback, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type ConfirmOptions = {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** Ask for a reason (stored with the action, e.g. deleting time or disabling a login). */
  /** singleLine: a one-line field, for example to type a number to confirm a large deletion. */
  reason?: { label: string; required?: boolean; placeholder?: string; singleLine?: boolean; inputMode?: 'numeric' | 'text' };
};
export type ConfirmResult = false | { reason: string };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<ConfirmResult>>(async o => (window.confirm(String(o.title)) ? { reason: '' } : false));

/** Accessible replacement for window.confirm / window.prompt. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  useLanguage();
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (r: ConfirmResult) => void } | null>(null);
  const [reason, setReason] = useState(''), [error, setError] = useState('');
  const settled = useRef(false);
  const reasonId = useId();
  const confirm = useCallback((options: ConfirmOptions) => new Promise<ConfirmResult>(resolve => {
    settled.current = false; setReason(''); setError(''); setState({ options, resolve });
  }), []);
  const finish = (result: ConfirmResult) => { if (settled.current) return; settled.current = true; state?.resolve(result); setState(null); };
  const o = state?.options;
  const danger = o?.tone === 'danger';
  const accept = () => {
    if (o?.reason?.required && !reason.trim()) { setError(uiText("Enter {p0}.", { p0: o.reason.label.toLowerCase() })); return; }
    finish({ reason: reason.trim() });
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!state} onOpenChange={open => { if (!open) finish(false); }}>
        {o && (
          <AlertDialogContent onKeyDown={e => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); accept(); } }}>
            <div className="confirm-body">
              <span className={cn('confirm-icon', danger ? 'tone-danger' : 'tone-info')} aria-hidden="true">{danger ? <AlertTriangle /> : <HelpCircle />}</span>
              <div className="confirm-text">
                <AlertDialogTitle>{o.title}</AlertDialogTitle>
                {o.description ? <AlertDialogDescription>{o.description}</AlertDialogDescription> : <AlertDialogDescription className="sr-only">{uiText("Confirm or cancel this action.")}</AlertDialogDescription>}
                {o.reason && (
                  <div className={cn("field confirm-reason", error && 'has-error')}>
                    <label htmlFor={reasonId} className="field-label">{o.reason.label}{o.reason.required && <span className="field-required" aria-hidden="true">*</span>}</label>
                    {o.reason.singleLine
                      ? <Input id={reasonId} autoFocus autoComplete="off" inputMode={o.reason.inputMode} value={reason} aria-required={o.reason.required || undefined} placeholder={o.reason.placeholder} aria-invalid={!!error || undefined} aria-describedby={error ? `${reasonId}-e` : undefined} onChange={e => { setReason(e.target.value); setError(''); }} />
                      : <Textarea id={reasonId} autoFocus rows={3} value={reason} aria-required={o.reason.required || undefined} placeholder={o.reason.placeholder} aria-invalid={!!error || undefined} aria-describedby={error ? `${reasonId}-e` : undefined} onChange={e => { setReason(e.target.value); setError(''); }} />}
                    {error && <p className="field-error" id={`${reasonId}-e`}>{error}</p>}
                  </div>
                )}
              </div>
            </div>
            <div className="confirm-footer">
              <AlertDialogCancel asChild><Button variant="outline">{o.cancelLabel || uiText("Cancel")}</Button></AlertDialogCancel>
              <Button variant={danger ? 'destructive' : 'default'} onClick={accept} autoFocus={!o.reason}>{o.confirmLabel || uiText("Confirm")}</Button>
            </div>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
