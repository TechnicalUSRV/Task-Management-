import { uiText, useLanguage, dynamicLabels, translatedEntries , translatedMap, translatedTuples } from "./i18n";
import { apiFetch, apiPath, uuid } from './api-client';
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlarmClock, ArrowDown, ArrowRight, ArrowUp, Ban, Bell, BellRing, Eye as EyeIcon, CalendarClock, CheckCheck, CheckCircle2, ChevronLeft, ChevronRight, CircleSlash, ClipboardCheck, Download, FileClock, FileText, Hand, Inbox, Link2, ListChecks, MessageSquare, Paperclip, Pencil,
  PlayCircle, Plus, Printer, Repeat, RotateCcw, Scale, Send, ShieldCheck, Trash2, Undo2, UserCheck, UserRoundCog, Users, XCircle, type LucideIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { Row } from './components';
import type { Workspace } from './ui';
import {
  TASK_STATUS as EN_TASK_STATUS, REQUEST_STATUS as EN_REQUEST_STATUS, TASK_SOURCES as EN_TASK_SOURCES, MONTHLY_CATEGORIES as EN_MONTHLY_CATEGORIES, RECURRENCE_SHORT as EN_RECURRENCE_SHORT, ROLE_LABEL as EN_ROLE_LABEL, TASK_FILE_ACCEPT, PREVIEW_TYPES, OPEN_TASK_STATUSES, enrichedTasks, taskActions, waitingFor, taskStateLabel, taskToday, addDays, currentMonth, monthBounds, shiftMonth, formatMinutes,
  CHANGE_KIND as EN_CHANGE_KIND, CHANGE_STATUS as EN_CHANGE_STATUS, REMINDER_PRESETS, approvalTarget, assignerOf, completionApprover, completionPath, reminderDays, reminderText, twoSided, canDecideDue, reopenNeedsApproval,
} from './task-domain.mjs';
import { CameraAttachment } from './camera-attachment';
import { TaskSharing, TaskVisibility } from './task-access-ui';
import { GroupDelivery } from './group-delivery-ui';
import { groupRead } from './group-api';
import { fileToBase64 } from './profile-ui';
import { useServerReport } from './report-hook';
import { TaskFilePreview } from './file-preview';
import { useViewState } from './router';
import { formatDate, formatDateTime, isMissing, plural } from './format';
import {
  Alert, Avatar, AvatarStack, ButtonLink, Card, CheckboxField, DataTable, DateText, EmptyState, ErrorState, ExpandableText, Field, FilterBar, FilterSelect, FormSection, IconButton, KeyValues,
  PeoplePicker, PersonPicker, Picker, PriorityBadge, ProgressBar, Segmented, StatCard, StatusBadge, buildChips, useConfirm, useFormErrors, type Column, type PersonOption, type Tone,
} from './ui-kit';
const TASK_STATUS = translatedMap(EN_TASK_STATUS);
const REQUEST_STATUS = translatedMap(EN_REQUEST_STATUS);
const TASK_SOURCES = translatedMap(EN_TASK_SOURCES);
const MONTHLY_CATEGORIES = translatedTuples(EN_MONTHLY_CATEGORIES);
const RECURRENCE_SHORT = translatedMap(EN_RECURRENCE_SHORT);
const ROLE_LABEL = translatedMap(EN_ROLE_LABEL);
const CHANGE_KIND = translatedMap(EN_CHANGE_KIND);
const CHANGE_STATUS = translatedMap(EN_CHANGE_STATUS);

// ------------------------------------------------------------------ shared helpers
// V5.6.8: "Accepted" is a task that has not started yet (neutral, like the Not started column it sits in); only work in
// progress is blue.
export const STATE_TONES: Record<string, Tone> = { 'Awaiting acceptance': 'warning', Accepted: 'neutral', 'Not started': 'neutral', 'In progress': 'info', 'In review': 'purple', Completed: 'success', Cancelled: 'neutral', Stuck: 'danger', Rejected: 'danger' };
export function TaskStateBadge({ task }: { task: Row }) {
  useLanguage();
  const label = taskStateLabel(task);
  return <StatusBadge value={label} label={uiText(label)} tone={STATE_TONES[label] || 'neutral'} title={task.stuck ? uiText("Stuck: {p0}", { p0: task.stuck_reason }) : task.declined ? uiText("Rejected: {p0}", { p0: task.declined_reason }) : undefined} />;
}
export const useTasks = (w: Workspace) => useMemo(() => enrichedTasks(w.data), [w.data]);
export const canApproveTasks = (w: Workspace) => w.can('tasks.tasks', 'approve');
/** V5.6.8: the person is on the task (or a decision about it waits for them), not only seeing it through oversight. */
export const involvedIn = (t: Row) => !t.access_reason || t.access_reason === 'involved';
/** V5.5: Tasks “Approve” counts only on tasks the person is directly on; a task seen through a reporting line, workspace
 *  governance or company-wide access is for viewing only (the server applies the same rule). */
export const canApproveOn = (w: Workspace, t: Row) => canApproveTasks(w) && involvedIn(t);
/** Why a task someone is not on is visible to them. Every reason other than 'involved' is view-only. */
export const SCOPE_NOTE: Record<string, string> = translatedMap({ team: 'Someone in your reporting line is in charge', company: 'Company-wide task access', governance: 'Workspace governance', organization: 'Organization administration', membership: 'Workspace membership', owner: 'Workspace ownership' });
/** The same reasons as short marks beside a task's title in lists, cards and the board. */
export const SCOPE_CHIP: Record<string, string> = translatedMap({ team: 'Team', company: 'Company', governance: 'Governance', organization: 'Organization', membership: 'Membership', owner: 'Ownership' });
/** V5.6.8: organization requests waiting for this person's decision (the server sends the list, or only their number). */
export function orgPending(data: Row): { count: number; items: Row[] } {
  const p = data.organization?.pending;
  return Array.isArray(p) ? { count: p.length, items: p } : { count: Math.max(0, Number(p) || 0), items: [] };
}
/** V5.6.8: everything waiting for this person's decision, counted the same way in the sidebar badge, the bell and the
 *  Tasks page: tasks to accept or reject, work to review, changes to approve, task requests, new due dates they may
 *  decide (canDecideDue, the server's own rule) and organization requests. */
export function decisionsFor(data: Row, me: string, can: (resource: string, action?: string) => boolean, tasks: Row[] = enrichedTasks(data)) {
  const base = waitingFor(data, me, tasks), canApprove = can('tasks.tasks', 'approve');
  const due: Row[] = tasks.filter((t: Row) => t.due_request && canDecideDue(t, t.due_request, me, { canApprove, involved: involvedIn(t) })).map((t: Row) => t.due_request);
  const org = orgPending(data);
  return { ...base, due, org, total: base.answer.length + base.review.length + base.approvals.length + base.requests.length + due.length + org.count };
}
/** Whether this person may decide the new due date asked for on task `t` (the server applies the same rule). */
export const mayDecideDue = (w: Workspace, t: Row, q: Row | null | undefined = t.due_request) => !!q && canDecideDue(t, q, w.actor, { canApprove: canApproveTasks(w), involved: involvedIn(t) });
export const firstName = (name: string) => String(name || '').split(' · ')[0];
const sourceLabel = (s?: string) => (s && s !== 'WEB' ? TASK_SOURCES[s as keyof typeof TASK_SOURCES] || s : '');
const kb = (bytes: number) => `${Math.max(1, Math.ceil(Number(bytes || 0) / 1024)).toLocaleString('en-US')} KB`;

/** Everyone who can be given work or asked for a task (V5.3: whatever their role), with photo, department and position.
 *  `include` keeps people who are already on the record visible even if they can no longer be chosen. */
export function peopleOptions(w: Workspace, { include = [], exclude = [] }: { include?: (string | null | undefined)[]; exclude?: string[] } = {}): PersonOption[] {
  const byId = new Map<string, PersonOption>();
  for (const p of w.data.tm_people || []) byId.set(p.staff_id, { id: p.staff_id, name: p.name, detail: [p.department, p.position].filter(Boolean).join(' · ') || undefined, note: p.signed_in ? undefined : uiText("Not signed in yet"), you: p.staff_id === w.actor });
  for (const id of include) if (id && !byId.has(id)) byId.set(id, { id, name: w.lookup(id), note: uiText("Can’t be chosen now"), you: id === w.actor });
  return [...byId.values()].filter(p => !exclude.includes(p.id)).sort((a, b) => Number(!!b.you) - Number(!!a.you) || a.name.localeCompare(b.name));
}
/** Everyone in the team directory (meetings, workspaces and timesheets also list people without a login). */
export function profileOptions(w: Workspace, include: (string | null | undefined)[] = []): PersonOption[] {
  const byId = new Map<string, PersonOption>();
  for (const p of w.data.tm_profiles || []) if (p.active || include.includes(p.staff_id)) byId.set(p.staff_id, { id: p.staff_id, name: p.name, detail: [p.department, p.position].filter(Boolean).join(' · ') || undefined, you: p.staff_id === w.actor });
  for (const id of include) if (id && !byId.has(id)) byId.set(id, { id, name: w.lookup(id), you: id === w.actor });
  return [...byId.values()].sort((a, b) => Number(!!b.you) - Number(!!a.you) || a.name.localeCompare(b.name));
}
const ANSWER: Record<string, { label: string; tone: Tone }> = { PENDING: { get label() { return uiText("Waiting for answer"); }, tone: 'warning' }, ACCEPTED: { get label() { return uiText("Accepted"); }, tone: 'success' }, DECLINED: { get label() { return uiText("Rejected"); }, tone: 'danger' } };
/** The answer of a supporting person, shown beside their name in the task editor. */
export function SupportNote({ task, staff }: { task: Row; staff: string }) {
  useLanguage();
  const row = (task.support || []).find((x: Row) => x.staff_id === staff);
  if (!row) return <small className="muted">{uiText("Will be asked to accept")}</small>;
  return <small className={row.status === 'PENDING' ? 'text-warning' : row.status === 'DECLINED' ? 'text-danger' : 'text-success'}>{ANSWER[row.status]?.label}</small>;
}

// ------------------------------------------------------------------ V5.4 two-party approval
const parseChanges = (c: Row): Row[] => { try { return JSON.parse(c.changes_json || '[]'); } catch { return []; } };
const CHANGE_TONE: Record<string, Tone> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral', CLOSED: 'neutral' };
const DECIDED: Record<string, string> = translatedMap({ APPROVED: 'Approved', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', CLOSED: 'Closed' });
/** What changes, field by field: previous value → new value. */
export function ChangeList({ changes }: { changes: Row[] }) {
  useLanguage();
  if (!changes.length) return null;
  return (
    <ul className="change-list">
      {changes.map(c => (
        <li key={c.field}>
          <span className="change-field">{c.label}</span>
          <span className="change-values"><span className="change-from"><span className="sr-only">{uiText("from ")}</span>{c.from_text}</span><ArrowRight aria-hidden="true" className="change-arrow" /><span className="change-to"><span className="sr-only">{uiText("to ")}</span>{c.to_text}</span></span>
        </li>
      ))}
    </ul>
  );
}
export const changeTitle = (c: Row) => c.kind === 'UPDATE' ? `Change ${parseChanges(c).map(x => String(x.label).toLowerCase()).join(', ') || 'details'}` : CHANGE_KIND[c.kind as keyof typeof CHANGE_KIND];
/** A change waiting for approval: the other side approves or rejects it; the person who asked can withdraw it. */
function ChangeRequestAlert({ w, cr, busy, run }: { w: Workspace; cr: Row; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  useLanguage();
  const me = w.actor, confirm = useConfirm(), who = firstName(w.lookup(cr.requested_by));
  const approve = async () => { if (await confirm({ title: uiText("Approve {p0}’s request?", { p0: who }), description: cr.kind === 'CANCEL' ? uiText("The task is cancelled and everyone on it is told.") : cr.kind === 'COMPLETE' ? uiText("The task is completed and everyone on it is told.") : uiText("The change is applied to the task now."), confirmLabel: uiText("Approve") })) await run(() => w.perform('tm.change.decide', { id: cr.id, decision: 'APPROVE', expected_version: cr.version })); };
  const reject = async () => { const r = await confirm({ title: uiText("Reject this request?"), description: uiText("{p0} will see your reason. The task stays exactly as it is.", { p0: who }), confirmLabel: uiText("Reject request"), tone: 'danger', reason: { label: uiText("Reason for rejecting"), required: true } }); if (r) await run(() => w.perform('tm.change.decide', { id: cr.id, decision: 'REJECT', note: r.reason, expected_version: cr.version })); };
  const withdraw = async () => { if (await confirm({ title: uiText("Withdraw your request?"), description: uiText("Nothing changes on the task."), confirmLabel: uiText("Withdraw request") })) await run(() => w.perform('tm.change.withdraw', { id: cr.id })); };
  return (
    <Alert tone="warning" icon={Scale} title={cr.approver_id === me ? uiText("{p0} asks you to approve: {p1}", { p0: w.lookup(cr.requested_by), p1: changeTitle(cr).toLowerCase() }) : uiText("Waiting for {p0} to approve: {p1}", { p0: w.lookup(cr.approver_id), p1: changeTitle(cr).toLowerCase() })}
      action={cr.approver_id === me ? <div className="row"><Button size="sm" disabled={busy} onClick={() => void approve()}><CheckCheck />{uiText("Approve")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void reject()}><XCircle />{uiText("Reject…")}</Button></div>
        : cr.requested_by === me ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void withdraw()}><CircleSlash />{uiText("Withdraw")}</Button> : undefined}>
      <ChangeList changes={parseChanges(cr)} />
      {cr.note && <p className="change-note">“{cr.note}”</p>}
      <p className="muted small">{uiText("Asked by ")}{w.lookup(cr.requested_by)} · {formatDateTime(cr.created_at)}{uiText(". Nothing changes until it is approved.")}</p>
    </Alert>
  );
}
/** Every change asked for on a task: who asked, what changed (previous → new), who decided and when. */
function ChangeHistory({ w, taskId }: { w: Workspace; taskId: string }) {
  useLanguage();
  const list: Row[] = (w.data.tm_change_requests || []).filter((c: Row) => c.task_id === taskId).slice().sort((a: Row, b: Row) => String(b.id).localeCompare(String(a.id)));
  const headingId = useId();
  if (!list.length) return null;
  return (
    <section aria-labelledby={headingId}>
      <h3 className="text-section" id={headingId}><Scale aria-hidden="true" className="inline-icon" />{uiText("Approvals")}</h3>
      <ol className="change-history">
        {list.map(c => (
          <li key={c.id}>
            <div className="row-between"><span className="cell-title">{changeTitle(c)}</span><StatusBadge value={c.status} label={CHANGE_STATUS[c.status as keyof typeof CHANGE_STATUS]} tone={CHANGE_TONE[c.status]} /></div>
            <ChangeList changes={parseChanges(c)} />
            <p className="muted small">{uiText("Asked by ")}{w.lookup(c.requested_by)} · {formatDateTime(c.created_at)}{sourceLabel(c.source) ? uiText(" · via {p0}", { p0: sourceLabel(c.source) }) : ''}{c.note ? <> · “{c.note}”</> : null}</p>
            {c.status === 'PENDING' ? <p className="muted small">{uiText("Waiting for ")}{w.lookup(c.approver_id)}</p>
              : <p className="muted small">{DECIDED[c.status]} {uiText("by ")}{w.lookup(c.decided_by)} · {formatDateTime(c.decided_at)}{sourceLabel(c.decision_source) ? uiText(" · via {p0}", { p0: sourceLabel(c.decision_source) }) : ''}{c.decision_note ? <> · “{c.decision_note}”</> : null}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
/** Deadline reminders chosen in a form: 1, 2 or 3 days before, or other days. */
export function parseReminderInput(v: Row): number[] {
  const out: number[] = [1, 2, 3].filter(n => v[`d${n}`]);
  for (const part of String(v.other || '').split(/[,\s]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error(uiText("Use whole days from 1 to 90, for example 7 or 5, 10."));
    out.push(n);
  }
  const list = [...new Set(out)].sort((a, b) => b - a);
  if (list.length > 5) throw new Error(uiText("Choose up to five reminders."));
  return list;
}
export const reminderInitial = (days: unknown): Row => { const list = reminderDays(days as string); return { d1: list.includes(1), d2: list.includes(2), d3: list.includes(3), other: list.filter(n => !REMINDER_PRESETS.includes(n)).join(', ') }; };

type ActionField = { key: string; label: string; type?: 'textarea' | 'date' | 'progress' | 'select' | 'person' | 'checkbox' | 'text'; required?: boolean; hint?: string; placeholder?: string; min?: string; options?: [string, string][]; people?: PersonOption[] };
type ActionSpec = { title: string; description?: ReactNode; fields: ActionField[]; confirmLabel: string; dismissLabel?: string; tone?: 'danger'; initial?: Row; run: (values: Row) => Promise<unknown> };

/** A small form in a dialog for one workflow step (reason, progress, new date…). */
export function ActionDialog({ spec, onClose }: { spec: ActionSpec; onClose: () => void }) {
  useLanguage();
  const [v, setV] = useState<Row>(spec.initial || {}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [errors, setErrors] = useState<Row>({});
  const set = (k: string, value: unknown) => { setV(s => ({ ...s, [k]: value })); setErrors(e => ({ ...e, [k]: '' })); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = Object.fromEntries(spec.fields.filter(f => f.required && isMissing(v[f.key])).map(f => [f.key, f.type === 'person' || f.type === 'select' ? `Choose ${f.label.toLowerCase().replace(/\?$/, '')}.` : `Enter ${f.label.toLowerCase().replace(/\?$/, '')}.`]));
    if (Object.keys(missing).length) { setErrors(missing); return; }
    setBusy(true); setError('');
    try { await spec.run(v); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-sm">
        <DialogHeader><DialogTitle>{spec.title}</DialogTitle><DialogDescription>{spec.description || uiText("Fields marked * are required.")}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
              {spec.fields.map(f => f.type === 'progress' ? <ProgressInput key={f.key} label={f.label} value={Number(v[f.key] ?? 0)} onChange={n => set(f.key, n)} hint={f.hint} />
                : f.type === 'select' ? <Picker key={f.key} label={f.label} value={v[f.key]} options={f.options || []} required={f.required} hint={f.hint} error={errors[f.key]} onChange={x => set(f.key, x)} />
                  : f.type === 'person' ? <PersonPicker key={f.key} label={f.label} value={v[f.key]} people={f.people || []} required={f.required} hint={f.hint} error={errors[f.key]} onChange={x => set(f.key, x)} />
                    : f.type === 'checkbox' ? <CheckboxField key={f.key} label={f.label} description={f.hint} checked={!!v[f.key]} onChange={x => set(f.key, x)} />
                      : <Field key={f.key} label={f.label} type={f.type || 'textarea'} value={v[f.key] ?? ''} onChange={x => set(f.key, x)} required={f.required} hint={f.hint} placeholder={f.placeholder} min={f.min} error={errors[f.key]} />)}
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={onClose}>{spec.dismissLabel || uiText("Cancel")}</Button>
              <Button type="submit" variant={spec.tone === 'danger' ? 'destructive' : 'default'} loading={busy}>{spec.confirmLabel}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProgressInput({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  useLanguage();
  const clamp = (n: number) => Math.max(0, Math.min(99, Math.round(Number.isFinite(n) ? n : 0)));
  return (
    <fieldset className="progress-input">
      <legend className="field-label">{label}</legend>
      <div className="progress-input-row">
        <input type="range" min={0} max={99} step={1} value={value} onChange={e => onChange(clamp(Number(e.target.value)))} aria-label={uiText("{p0} (slider)", { p0: label })} />
        <span className="progress-input-number"><input type="number" min={0} max={99} value={value} onChange={e => onChange(clamp(Number(e.target.value)))} aria-label={uiText("{p0} (percent)", { p0: label })} /><span aria-hidden="true">%</span></span>
      </div>
      <div className="progress-presets">{[10, 25, 50, 75, 90].map(n => <Button key={n} type="button" size="xs" variant={value === n ? 'secondary' : 'outline'} aria-pressed={value === n} onClick={() => onChange(n)}>{n}%</Button>)}</div>
      {hint && <p className="field-hint">{hint}</p>}
    </fieldset>
  );
}

// ------------------------------------------------------------------ task detail
const HISTORY_LABEL: Record<string, string> = {
  create: 'Task created', accept: 'Accepted the task', decline: 'Rejected the task', progress: 'Updated progress', stuck: 'Marked as stuck', resume: 'Resumed work',
  submit: 'Submitted for review', return: 'Returned for more work', close: 'Closed as completed', cancel: 'Cancelled the task', reopen: 'Reopened the task', get note() { return uiText("Comment"); },
  pass: 'Passed on for approval', change_request: 'Asked for approval', change_rejected: 'Rejected a change', change_withdrawn: 'Withdrew a request', change_closed: 'Request closed', reminders: 'Changed reminders',
  edit: 'Changed details', due_request: 'Asked for a new due date', due_change: 'Due date changed', due_declined: 'Declined a new due date', due_withdrawn: 'Withdrew a due date request',
  support_accept: 'Accepted to support', support_decline: 'Rejected supporting', review_accept: 'Accepted to review', review_decline: 'Rejected reviewing',
  handover: 'Handed the task over', remind: 'Sent a reminder', checklist: 'Steps of work', file: 'Added a file', file_removed: 'Removed a file',
};
const ACTION_ORDER = ['accept', 'decline', 'review-close', 'pass', 'return', 'progress', 'submit', 'close', 'resume', 'stuck', 'due', 'handover', 'remind', 'reminders', 'edit', 'reopen', 'cancel'];
const ASKED: Record<string, string> = translatedMap({ pic: 'to take charge of this task', supporter: 'to support this task', reviewer: 'to review this task' });

export function TaskDetail({ w, taskId, onClose, onEdit }: { w: Workspace; taskId: string; onClose: () => void; onEdit: (t: Row) => void }) {
  useLanguage();
  const tasks = useTasks(w), t = tasks.find((x: Row) => x.id === taskId);
  const [action, setAction] = useState<ActionSpec | null>(null), [comment, setComment] = useState(''), [busy, setBusy] = useState(false), [newItem, setNewItem] = useState(''), [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<Row | null>(null);
  const confirm = useConfirm(), headingId = useId();
  if (!t) return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-sm"><DialogHeader><DialogTitle>{uiText("Task not found")}</DialogTitle><DialogDescription>{uiText("It may have been removed, or your role no longer includes it.")}</DialogDescription></DialogHeader><div className="dialog-footer"><Button onClick={onClose}>{uiText("Close")}</Button></div></DialogContent>
    </Dialog>
  );
  const name = w.lookup, me = w.actor, { roles, allowed } = taskActions(t, me, { canApprove: canApproveOn(w, t) }), open = ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW'].includes(t.status);
  // V5.5: a new progress figure on a task someone else assigned waits for the assigner's side.
  // (and, from the assigner's side, a new figure waits for the person in charge).
  const progressBy: string | null = !twoSided(t) || !open ? null : (roles.isPic || roles.isSupporter) ? (assignerOf(t) !== me ? assignerOf(t) : null) : t.pic_id;
  const perform = (verb: string, extra: Row = {}) => w.perform(`tm.task.${verb}`, { id: t.id, expected_version: t.version, ...extra });
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const forwarding = t.status === 'IN_REVIEW' && roles.isPic;
  // V5.4: who must agree to my changes (null: they apply at once), and who makes a completion final.
  const target: string | null = approvalTarget(t, me), path = completionPath(t), finalApprover: string | null = completionApprover(t), cr: Row | null = t.change_request || null;
  const reopenBy: string | null = reopenNeedsApproval(t, me);
  const completionAsked = !!cr && cr.kind === 'COMPLETE' && cr.requester_side === 'PIC', asksApproval = roles.isPic && twoSided(t);
  const reviewStage: string | null = roles.isPic && path.review && path.review !== finalApprover ? path.review : null;
  const submitTo = roles.isPic ? (reviewStage || finalApprover || t.reviewer_id) : t.pic_id;
  const approvingCompletion = completionAsked && me === finalApprover;
  const note = (label: string, required = false): ActionField => ({ key: 'note', label, type: 'textarea', required });
  const myAnswers = roles.toAnswer as string[], rejectRole = myAnswers.length === 1 ? myAnswers[0] : myAnswers.length ? 'all' : roles.rejected[0];
  const everyone = peopleOptions(w, { include: [t.pic_id], exclude: [t.pic_id] });
  const specs: Record<string, { label: string; icon: LucideIcon; tone?: 'danger'; spec?: ActionSpec; direct?: () => void }> = {
    accept: { label: roles.rejected.length && !myAnswers.length ? uiText("Accept after all") : uiText("Accept"), icon: UserCheck, direct: () => void run(() => perform('accept')) },
    decline: { label: uiText("Reject…"), icon: XCircle, spec: { title: rejectRole === 'supporter' ? uiText("Reject supporting this task?") : rejectRole === 'reviewer' ? uiText("Reject reviewing this task?") : uiText("Reject this task?"), description: rejectRole === 'pic' ? uiText("{p0} will be told and can give it to someone else.", { p0: name(t.reviewer_id || t.created_by) }) : uiText("The people on the task will see your reason."), fields: [note(uiText("Reason for rejecting"), true)], confirmLabel: uiText("Reject"), tone: 'danger', run: v => perform('decline', v) } },
    progress: { label: t.status === 'NOT_STARTED' ? uiText("Start work") : uiText("Update progress"), icon: PlayCircle, spec: { title: t.status === 'NOT_STARTED' ? uiText("Start work on this task") : uiText("Update progress"),
      description: progressBy ? uiText("A new progress figure is sent to {p0} to approve. The task shows {p1}% until then. Use 0–99%.", { p0: firstName(name(progressBy)), p1: t.progress }) : uiText("Use 0–99%. When the work is finished, submit it for review or close it."),
      fields: [{ key: 'progress', label: uiText("Progress"), type: 'progress' }, note(progressBy ? `Note for ${firstName(name(progressBy))} (optional)` : uiText("Progress note (optional)"))], confirmLabel: progressBy ? uiText("Send for approval") : uiText("Save progress"), initial: { progress: t.progress }, run: v => perform('progress', v) } },
    stuck: { label: uiText("Mark as stuck…"), icon: Hand, spec: { title: uiText("Mark this task as stuck?"), description: uiText("The person in charge, the reviewer and supporting people are told. It stays stuck until someone resumes it."), fields: [note(uiText("What is blocking it?"), true)], confirmLabel: uiText("Mark as stuck"), run: v => perform('stuck', v) } },
    resume: { label: uiText("Resume work"), icon: PlayCircle, spec: { title: uiText("Resume this task?"), description: t.stuck_reason ? uiText("It was stuck: “{p0}”.", { p0: t.stuck_reason }) : undefined, fields: [note(uiText("Note (optional)"))], confirmLabel: uiText("Resume work"), run: v => perform('resume', v) } },
    submit: { label: asksApproval ? uiText("Submit for approval…") : forwarding ? uiText("Send to reviewer…") : uiText("Submit for review…"), icon: Send, spec: {
      title: asksApproval ? (reviewStage ? `Submit to ${name(reviewStage || '')} for review?` : `Ask ${name(finalApprover || '')} to approve completing it?`) : forwarding ? uiText("Send to {p0} for review?", { p0: name(submitTo) }) : uiText("Submit to {p0} for review?", { p0: name(submitTo) }),
      description: asksApproval ? (reviewStage ? `${firstName(name(reviewStage || ''))} checks the work first, then ${firstName(name(finalApprover || ''))} approves completing it. Until then it stays in review.` : `${firstName(name(finalApprover || ''))} assigned this task, so they approve completing it — or return it with notes.`)
        : roles.isPic ? uiText("{p0} can then close the task or return it with notes.", { p0: firstName(name(submitTo)) }) : uiText("{p0} (in charge) can then send it on for approval, or return it.", { p0: firstName(name(t.pic_id)) }),
      fields: [note(asksApproval ? uiText("Note for the approver (optional)") : uiText("Note for the reviewer (optional)"))], confirmLabel: asksApproval ? uiText("Submit for approval") : uiText("Submit"), run: v => perform('submit', v) } },
    pass: { label: uiText("Pass for approval…"), icon: ArrowRight, spec: { title: uiText("Pass to {p0} for approval?", { p0: name(finalApprover || '') }), description: uiText("You have checked the work. {p0} approves completing the task or returns it.", { p0: firstName(name(finalApprover || '')) }), fields: [note(uiText("Note for the approver (optional)"))], confirmLabel: uiText("Pass on for approval"), run: v => perform('pass', v) } },
    return: { label: approvingCompletion ? uiText("Return (don’t approve)…") : uiText("Return for more work…"), icon: Undo2, spec: { title: approvingCompletion ? uiText("Return the task instead of completing it?") : uiText("Return this task?"), description: uiText("It goes back to {p0} as in progress{p1}.", { p0: name(t.submitted_by), p1: completionAsked ? ', and the request to complete it is rejected' : '' }), fields: [note(uiText("What still needs to be done?"), true)], confirmLabel: uiText("Return task"), run: v => perform('return', v) } },
    close: approvingCompletion
      ? { label: uiText("Approve completion"), icon: CheckCircle2, spec: { title: uiText("Approve completing this task?"), description: <>{name(cr?.requested_by)} {uiText("asked to complete it. Progress becomes 100% and everyone on the task is told.")}{t.recurrence && !t.next_task_id ? uiText(" The next one (repeats {p0}) is created automatically.", { p0: RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT] }) : ''}</>, fields: [note(uiText("Note (optional)"))], confirmLabel: uiText("Approve completion"), run: v => perform('close', v) } }
      : target && t.status !== 'IN_REVIEW'
        ? { label: uiText("Ask to complete…"), icon: CheckCircle2, spec: { title: uiText("Ask {p0} to approve completing this task?", { p0: name(target || '') }), description: uiText("Nothing changes until {p0} approves. They can also reject it with a reason.", { p0: firstName(name(target || '')) }), fields: [note(uiText("Note for them (optional)"))], confirmLabel: uiText("Send for approval"), run: v => perform('close', v) } }
        : { label: uiText("Close as completed"), icon: CheckCircle2, spec: { title: uiText("Close this task as completed?"), description: <>{uiText("Progress becomes 100% and everyone on the task is told. It can be reopened later if needed.")}{t.recurrence && !t.next_task_id ? uiText(" The next one (repeats {p0}) is created automatically.", { p0: RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT] }) : ''}</>, fields: [note(uiText("Closing note (optional)"))], confirmLabel: uiText("Close task"), run: v => perform('close', v) } },
    cancel: { label: target ? uiText("Ask to cancel…") : uiText("Cancel task…"), icon: Ban, tone: 'danger', spec: { title: target ? uiText("Ask {p0} to approve cancelling this task?", { p0: name(target || '') }) : uiText("Cancel this task?"), description: target ? uiText("The task stays open until {p0} approves. Everyone on it is told once it is cancelled.", { p0: firstName(name(target || '')) }) : uiText("Everyone on the task is told. Cancelled tasks stay in the history and reports."), fields: [note(uiText("Cancellation reason"), true), ...(t.recurrence && !t.next_task_id ? [{ key: 'keep_series', label: uiText("Keep the repeating series"), type: 'checkbox', hint: uiText("Create the next one in the series anyway (only this one is cancelled).") } as ActionField] : [])], confirmLabel: target ? uiText("Send for approval") : uiText("Cancel task"), dismissLabel: 'Keep the task', tone: 'danger', run: v => perform('cancel', v) } },
    // V5.6.8: a task both sides agreed to close reopens only when the other side approves (the existing approval flow).
    reopen: reopenBy
      ? { label: uiText("Ask to reopen…"), icon: RotateCcw, spec: { title: uiText("Ask {p0} to approve reopening this task?", { p0: name(reopenBy) }), description: uiText("It stays {p0} until {p1} approves. They can also reject it with a reason.", { p0: t.status === 'CANCELLED' ? 'cancelled' : 'completed', p1: firstName(name(reopenBy)) }), fields: [note(uiText("Reason for reopening"), true)], confirmLabel: uiText("Send for approval"), run: v => perform('reopen', v) } }
      : { label: uiText("Reopen…"), icon: RotateCcw, spec: { title: uiText("Reopen this task?"), description: uiText("It opens again at once and everyone on it is told."), fields: [note(uiText("Reason for reopening"), true)], confirmLabel: uiText("Reopen task"), run: v => perform('reopen', v) } },
    due: { label: uiText("Ask for a new due date…"), icon: CalendarClock, spec: { title: uiText("Ask for a new due date"), description: uiText("{p0}. The current due date is {p1} and stays until then.", { p0: asksApproval ? `${name(assignerOf(t))} approves it` : `${name(t.reviewer_status !== 'DECLINED' && t.reviewer_id ? t.reviewer_id : t.created_by)} decides`, p1: formatDate(t.due_date) }), fields: [{ key: 'proposed_due_date', label: uiText("New due date"), type: 'date', required: true, min: t.start_date }, { key: 'reason', label: uiText("Reason"), type: 'textarea', required: true }], confirmLabel: uiText("Send request"), initial: { proposed_due_date: addDays(t.due_date, 3) }, run: v => w.perform('tm.due.request', { task_id: t.id, ...v }) } },
    handover: { label: uiText("Hand over…"), icon: UserRoundCog, spec: { title: uiText("Hand this task over"), description: target ? uiText("{p0} approves the hand-over first; you stay in charge until then. The new person is then asked to accept it.", { p0: name(target || '') }) : uiText("Choose who should take charge instead of you. They are asked to accept it; the reviewer and the person who created the task are told."), fields: [{ key: 'to_id', label: uiText("New person in charge"), type: 'person', required: true, people: everyone }, { key: 'keep', label: uiText("Keep me on the task as a supporting person"), type: 'checkbox' }, note(uiText("Note for them (optional)"))], confirmLabel: target ? uiText("Send for approval") : uiText("Hand over"), run: v => perform('handover', v) } },
    reminders: { label: uiText("Reminders…"), icon: AlarmClock, spec: { title: uiText("Deadline reminders"), description: uiText("The people on this task (in charge, supporting, the assigner and the reviewer) are reminded in the Task Controlling Management, in Telegram and in the Telegram app. Now: {p0}.", { p0: reminderText(t.reminder_days) }), fields: [{ key: 'd1', label: uiText("1 day before the due date"), type: 'checkbox' }, { key: 'd2', label: uiText("2 days before"), type: 'checkbox' }, { key: 'd3', label: uiText("3 days before"), type: 'checkbox' }, { key: 'other', label: uiText("Other days before (optional)"), type: 'text', placeholder: uiText("For example 7, or 5, 10"), hint: uiText("Whole days from 1 to 90, separated by commas. Clear everything to turn reminders off for this task.") }], confirmLabel: uiText("Save reminders"), initial: reminderInitial(t.reminder_days), run: v => w.perform('tm.task.reminders', { id: t.id, reminder_days: parseReminderInput(v) }) } },
    remind: { label: uiText("Send a reminder"), icon: BellRing, direct: () => void run(() => perform('remind')) },
    edit: { label: uiText("Edit details"), icon: Pencil, direct: () => onEdit(t) },
  };
  const reviewClose = (roles.isSubmittedTo || approvingCompletion) && allowed.includes('close');
  const order = t.stuck ? ['resume', ...ACTION_ORDER.filter(k => k !== 'resume')] : ACTION_ORDER;
  const buttons = order.map(k => (k === 'review-close' ? (reviewClose ? 'close' : '') : k === 'close' && reviewClose ? '' : k)).filter(k => k && allowed.includes(k) && (k !== 'accept' && k !== 'decline' || !myAnswers.length));
  const due = t.due_request, history = (w.data.tm_task_history || []).filter((h: Row) => h.task_id === t.id).slice().reverse();
  const decidesDue = mayDecideDue(w, t, due);
  const addComment = () => void run(async () => { await perform('note', { note: comment }); setComment(''); });
  const decideDue = async (decision: 'APPROVE' | 'DECLINE') => {
    if (decision === 'DECLINE') { const r = await confirm({ title: uiText("Decline the new due date?"), confirmLabel: uiText("Decline"), tone: 'danger', reason: { label: uiText("Reason"), required: true } }); if (!r) return; return run(() => w.perform('tm.due.decide', { id: due.id, decision, note: r.reason })); }
    return run(() => w.perform('tm.due.decide', { id: due.id, decision }));
  };
  // Checklist and files
  const items: Row[] = (w.data.tm_checklist || []).filter((c: Row) => c.task_id === t.id).sort((a: Row, b: Row) => a.position - b.position), canCheck = allowed.includes('checklist');
  const contributor = t.visibility !== 'PERSONAL' && (w.data.tm_task_members || []).some((m: Row)=>m.task_id===t.id&&m.staff_id===me&&m.permission==='CONTRIBUTOR');
  if(contributor&&t.status!=='CANCELLED'){if(!allowed.includes('note'))allowed.push('note');if(!allowed.includes('file'))allowed.push('file');}
  const files: Row[] = (w.data.tm_files || []).filter((f: Row) => f.task_id === t.id), canFile = allowed.includes('file');
  const addItem = (e: FormEvent) => { e.preventDefault(); const title = newItem.trim(); if (!title) return; void run(async () => { await w.perform('tm.check.add', { task_id: t.id, title }, { quiet: true }); setNewItem(''); }); };
  const removeItem = async (i: Row) => { if (await confirm({ title: uiText("Remove the step “{p0}”?", { p0: i.title }), confirmLabel: uiText("Remove step"), tone: 'danger' })) void run(() => w.perform('tm.check.remove', { id: i.id }, { quiet: true })); };
  const renameItem = (i: Row) => setAction({ title: uiText("Rename step"), fields: [{ key: 'title', label: uiText("Step"), type: 'text', required: true }], initial: { title: i.title }, confirmLabel: uiText("Save"), run: v => w.perform('tm.check.rename', { id: i.id, title: v.title }, { quiet: true }) });
  const moveItem = (i: Row, direction: 'up' | 'down') => void run(() => w.perform('tm.check.move', { id: i.id, direction }, { quiet: true }));
  const upload = async (file: File) => {
    if (file.size > 30 * 1024 * 1024) { toast.error(uiText("{p0} is larger than 30 MB.", { p0: file.name })); return; }
    setUploading(true);
    try { await w.perform('tm.file.add', { task_id: t.id, name: file.name, base64: await fileToBase64(file) }); } catch (e) { toast.error((e as Error).message); } finally { setUploading(false); }
  };
  const removeFile = async (f: Row) => { if (await confirm({ title: uiText("Remove {p0}?", { p0: f.name }), description: uiText("The file is deleted from the task. The history keeps a note that it was removed."), confirmLabel: uiText("Remove file"), tone: 'danger' })) void run(() => w.perform('tm.file.remove', { id: f.id })); };
  // People and their answers
  const invitedBy = (staff: string) => (w.data.tm_assignees || []).find((a: Row) => a.task_id === t.id && a.staff_id === staff)?.invited_by;
  const personRow = (staff: string, role: string, state?: string | null, extra?: ReactNode) => (
    <li key={`${role}-${staff}`} className="task-person">
      <Avatar name={name(staff)} size="md" />
      <span className="cell-stack"><span className="person-name">{name(staff)}{staff === me && <span className="muted"> {uiText("(you)")}</span>}</span><small>{role}</small>{extra}</span>
      {state && ANSWER[state] && (open || state === 'DECLINED') && <StatusBadge value={state} label={ANSWER[state].label} tone={ANSWER[state].tone} />}
    </li>
  );
  const series = t.series_id || (t.recurrence ? t.id : '');
  const previous = (w.data.tm_tasks || []).find((x: Row) => x.next_task_id === t.id), following = t.next_task_id;
  const facts: [ReactNode, ReactNode][] = [
    [uiText("Start"), <DateText value={t.start_date} />],
    [uiText("Due"), <span className={t.overdue ? 'text-danger' : undefined}><DateText value={t.due_date} />{t.overdue ? uiText(" · overdue") : ''}</span>],
    ...(t.recurrence ? [[uiText("Repeats"), <span className="row"><Repeat aria-hidden="true" className="inline-icon" />{RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT]}{t.recurrence_until ? <> {uiText("until ")}<DateText value={t.recurrence_until} /></> : ''}</span>] as [ReactNode, ReactNode]] : []),
    ...(series && (previous || following) ? [[uiText("Series"), <span className="row">{previous && <button type="button" className="text-link" onClick={() => w.show('tm_task', previous.id)}>{uiText("Previous: ")}{previous.id}</button>}{following && <button type="button" className="text-link" onClick={() => w.show('tm_task', following)}>{uiText("Next: ")}{following}</button>}</span>] as [ReactNode, ReactNode]] : []),
    [uiText("Department"), t.department || null],
    [uiText("Workspace"), t.workspace],
    [uiText("Effort"), `${formatMinutes(t.logged_minutes)} logged of ${formatMinutes(t.estimate_minutes)} estimated (h:mm)`],
    [uiText("Created"), <>{name(t.created_by)} · <DateText value={t.created_at} />{t.request_id ? <> {uiText("· from request ")}<span className="id-text">{t.request_id}</span></> : sourceLabel(t.source) ? uiText(" · via {p0}", { p0: sourceLabel(t.source) }) : ''}</>],
    [uiText("Assigned by"), <>{name(t.assigned_by)}{t.approval ? <span className="muted"> {uiText("· changes need both ")}{firstName(name(t.assigned_by))} {uiText("and ")}{firstName(name(t.pic_id))}</span> : twoSided(t) && open && !t.accepted_at ? <span className="muted"> {uiText("· approval starts once ")}{firstName(name(t.pic_id))} accepts</span> : null}</>],
    ...(open ? [[uiText("Reminders"), <span className="row">{reminderText(t.reminder_days)}{allowed.includes('reminders') && <Button size="xs" variant="ghost" onClick={() => setAction(specs.reminders.spec!)}><AlarmClock />{uiText("Change")}</Button>}</span>] as [ReactNode, ReactNode]] : []),
  ];
  return (
    <>
      <Dialog open onOpenChange={o => { if (!o && !busy && !uploading) onClose(); }}>
        <DialogContent className="dialog-lg task-detail">
          <DialogHeader>
            <DialogTitle>{t.title}</DialogTitle>
            <DialogDescription><span className="id-text">{t.id}</span> · {t.workspace}{t.department ? uiText(" · {p0}", { p0: t.department }) : ''}</DialogDescription>
          </DialogHeader>
          <div className="dialog-body stack" tabIndex={0} role="region" aria-label={uiText("Details of {p0}", { p0: t.title })}>
            <div className="task-detail-status">
              <TaskStateBadge task={t} /><PriorityBadge value={t.priority} />
              <span className={t.overdue ? "text-danger small" : "muted small"}>{uiText("Due ")}{formatDate(t.due_date)}{t.overdue ? uiText(" · overdue") : ''}</span>
              <div className="task-detail-progress"><ProgressBar value={t.progress} label={uiText("{p0} progress", { p0: t.title })} /></div>
            </div>
            {!involvedIn(t) && <p className="scope-note" role="note"><EyeIcon aria-hidden="true" className="inline-icon" />{t.access_reason === 'team' ? uiText("{p0} is in your reporting line, so you can follow this task.", { p0: name(t.pic_id) }) : t.access_reason === 'governance' ? uiText("You govern {p0}, so you can follow its tasks.", { p0: t.workspace || 'this workspace' }) : uiText("You can see this task through {p0}.", { p0: (SCOPE_NOTE[t.access_reason] || 'authorized access').toLowerCase() })} {uiText("Viewing only: the people on the task make the changes.")}</p>}
            {myAnswers.length > 0 && <Alert tone="info" title={uiText("{p0} asked you {p1}", { p0: name((myAnswers.length === 1 && myAnswers[0] === 'reviewer' ? t.created_by : invitedBy(me)) || t.created_by), p1: myAnswers.map(r => ASKED[r]).join(' and ') })}
              action={<div className="row"><Button size="sm" disabled={busy} onClick={() => void run(() => perform('accept'))}><UserCheck />{uiText("Accept")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setAction(specs.decline.spec!)}><XCircle />{uiText("Reject…")}</Button></div>}>
              {myAnswers.includes('pic') ? uiText("Accept to start the work, or reject it with a reason so it can be given to someone else.") : myAnswers.includes('supporter') ? uiText("You would help {p0}, who is in charge. Accept, or reject with a reason.", { p0: firstName(name(t.pic_id)) }) : uiText("You would review the work when it is submitted and decide due date requests. Accept, or reject with a reason.")}
            </Alert>}
            {!myAnswers.length && roles.rejected.length > 0 && open && <Alert tone="neutral" title={uiText("You rejected {p0} role{p1}", { p0: roles.rejected.map(r => ROLE_LABEL[r as keyof typeof ROLE_LABEL]).join(' and '), p1: roles.rejected.length > 1 ? 's' : '' })} action={allowed.includes('accept') ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => perform('accept'))}>{uiText("Accept after all")}</Button> : undefined}>{uiText("If you can help after all, you can still accept.")}</Alert>}
            {t.awaiting && !roles.isPic && <Alert tone="neutral" title={uiText("Waiting for {p0} to accept", { p0: name(t.pic_id) })}>{uiText("Supporting people can start once it is accepted.")}</Alert>}
            {t.declined && <Alert tone="warning" title={uiText("{p0} rejected this task", { p0: name(t.pic_id) })}>{t.declined_reason}{roles.isGovernor ? uiText(" Choose another person in charge with Edit details, or cancel the task.") : ''}</Alert>}
            {t.reviewer_status === 'DECLINED' && open && <Alert tone="warning" title={uiText("{p0} rejected reviewing this task", { p0: name(t.reviewer_id) })}>{t.reviewer_note}{roles.isGovernor ? uiText(" Choose a new reviewer with Edit details.") : ''}</Alert>}
            {t.stuck && <Alert tone="danger" title={uiText("Stuck since {p0}", { p0: formatDate(t.stuck_at) })}>{t.stuck_reason}<span className="muted"> — {name(t.stuck_by)}</span></Alert>}
            {t.status === 'IN_REVIEW' && <Alert tone="purple" title={roles.isSubmittedTo ? (approvingCompletion ? `${name(t.submitted_by)} asks you to approve completing this task` : `${name(t.submitted_by)} submitted this to you for review`) : completionAsked ? uiText("Waiting for {p0} by {p1}", { p0: t.submitted_to === finalApprover ? 'approval' : 'review', p1: name(t.submitted_to) }) : uiText("Waiting for review by {p0}", { p0: name(t.submitted_to) })}
              action={completionAsked && cr?.requested_by === me ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => w.perform('tm.change.withdraw', { id: cr.id }))}><CircleSlash />{uiText("Take back")}</Button> : undefined}>
              {t.submit_note ? <p>“{t.submit_note}”</p> : null}
              <p>{roles.isSubmittedTo ? (approvingCompletion ? uiText("Approve completion if the work is complete, or return it with notes.") : allowed.includes('pass') ? `Check the work, then pass it to ${firstName(name(finalApprover || ''))} for approval, or return it with notes.` : uiText("Close it if the work is complete, or return it with notes."))
                : uiText("Submitted by {p0} on {p1}.{p2}", { p0: name(t.submitted_by), p1: formatDateTime(t.submitted_at), p2: completionAsked && t.submitted_to !== finalApprover ? ` ${firstName(name(finalApprover || ''))} then approves completing it.` : '' })}{approvingCompletion && !roles.isSubmittedTo ? uiText(" {p0} has not checked it yet; you can still decide now.", { p0: firstName(name(t.submitted_to)) }) : ''}</p>
            </Alert>}
            {cr && !completionAsked && <ChangeRequestAlert w={w} cr={cr} busy={busy} run={run} />}
            {due && <Alert tone="info" icon={CalendarClock} title={uiText("{p0} asked to move the due date to {p1}", { p0: name(due.requested_by), p1: formatDate(due.proposed_due_date) })}
              action={decidesDue ? <div className="row"><Button size="sm" disabled={busy} onClick={() => void decideDue('APPROVE')}>{uiText("Approve date")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void decideDue('DECLINE')}>{uiText("Decline")}</Button></div>
                : due.requested_by === me ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => w.perform('tm.due.withdraw', { id: due.id }))}>{uiText("Withdraw")}</Button> : undefined}>
              {due.reason}<span className="muted"> {uiText("— waiting for ")}{name(due.decide_by)}</span></Alert>}
            {buttons.length > 0 && (
              <div className="task-actions" role="group" aria-label={uiText("Task actions")}>
                {buttons.map((k, i) => {
                  const a = specs[k];
                  return <Button key={k} variant={a.tone === 'danger' ? 'danger-outline' : i === 0 && !myAnswers.length ? 'default' : 'outline'} size="sm" disabled={busy} onClick={() => (a.direct ? a.direct() : setAction(a.spec!))}><a.icon />{a.label}</Button>;
                })}
              </div>
            )}
            <div className="grid-2 task-detail-grid">
              <section aria-labelledby={`${headingId}-people`}>
                <h3 className="text-section" id={`${headingId}-people`}>{uiText("People")}</h3>
                <ul className="task-people">
                  {personRow(t.pic_id, uiText("Person in charge"), ['NOT_STARTED', 'IN_PROGRESS'].includes(t.status) || t.pic_state !== 'PENDING' ? t.pic_state : null)}
                  {(t.support || []).map((x: Row) => personRow(x.staff_id, uiText("Supporting"), x.status, x.status === 'DECLINED' && x.response_note ? <small className="muted">“{x.response_note}”</small> : null))}
                  {t.reviewer_id && t.reviewer_id !== t.pic_id && personRow(t.reviewer_id, uiText("Reviewer"), t.reviewer_status, t.reviewer_status === 'DECLINED' && t.reviewer_note ? <small className="muted">“{t.reviewer_note}”</small> : null)}
                </ul>
                {allowed.includes('remind') && <p className="muted small">{t.waiting.filter((x: Row) => x.staff_id !== me).length} {plural(t.waiting.filter((x: Row) => x.staff_id !== me).length, uiText("person has"), uiText("people have"))} {uiText("not answered yet. Use “Send a reminder” to remind them.")}</p>}
              </section>
              <KeyValues items={facts} dense />
            </div>
            {t.department_note && <div className="notes-block"><p className="text-label">{uiText("Department note")}</p><p>{t.department_note}</p></div>}
            {t.description && <div><p className="text-label">{uiText("Expectation")}</p><ExpandableText text={t.description} lines={4} /></div>}
            {(items.length > 0 || canCheck) && <section aria-labelledby={`${headingId}-check`} className="task-checklist">
              <div className="row-between"><h3 className="text-section" id={`${headingId}-check`}><ListChecks aria-hidden="true" className="inline-icon" />{uiText("Steps of work")}</h3>{items.length > 0 && <span className="muted small num">{t.check_done} {uiText("of ")}{t.check_total} completed</span>}</div>
              {items.length > 0 && <ol className="checklist">
                {items.map((i, n) => <li key={i.id} className={i.done ? 'is-done' : undefined}>
                  <CheckboxField label={i.title} checked={!!i.done} disabled={!canCheck || busy} description={i.done ? uiText("Completed by {p0}{p1}", { p0: name(i.done_by), p1: i.done_at ? ` · ${formatDateTime(i.done_at)}` : '' }) : undefined} onChange={v => void run(() => w.perform('tm.check.toggle', { id: i.id, done: v }, { quiet: true }))} />
                  {canCheck && <span className="checklist-tools">
                    <IconButton label={uiText("Move “{p0}” up", { p0: i.title })} icon={ArrowUp} disabled={busy || n === 0} onClick={() => moveItem(i, 'up')} />
                    <IconButton label={uiText("Move “{p0}” down", { p0: i.title })} icon={ArrowDown} disabled={busy || n === items.length - 1} onClick={() => moveItem(i, 'down')} />
                    <IconButton label={uiText("Rename “{p0}”", { p0: i.title })} icon={Pencil} disabled={busy} onClick={() => renameItem(i)} /><IconButton label={uiText("Remove “{p0}”", { p0: i.title })} icon={Trash2} disabled={busy} onClick={() => void removeItem(i)} /></span>}
                </li>)}
              </ol>}
              {canCheck && <form className="checklist-add" onSubmit={addItem}>
                <label className="sr-only" htmlFor={`${headingId}-new`}>{uiText("New step")}</label>
                <Input id={`${headingId}-new`} value={newItem} maxLength={300} placeholder={items.length ? uiText("Add another step…") : uiText("Add a step, for example “Check the seal”")} onChange={e => setNewItem(e.target.value)} disabled={busy} />
                <Button type="submit" size="sm" variant="outline" disabled={busy || !newItem.trim()}><Plus />{uiText("Add step")}</Button>
              </form>}
              {items.length > 0 && <p className="muted small">{uiText("Completing a step tells ")}{firstName(name(assignerOf(t)))}{uiText("; it never changes the task’s progress or closes it.")}</p>}
            </section>}
            <TaskSharing task={t} data={w.data} command={w.perform} name={w.lookup} />
            {(files.length > 0 || canFile) && <section aria-labelledby={`${headingId}-files`} className="task-files-section">
              <div className="row-between"><h3 className="text-section" id={`${headingId}-files`}><Paperclip aria-hidden="true" className="inline-icon" />{uiText("Files")}</h3>
                {canFile && <label className={`btn-upload${uploading ? " is-busy" : ''}`}><Paperclip aria-hidden="true" />{uploading ? uiText("Uploading…") : uiText("Attach a file")}<input type="file" accept={TASK_FILE_ACCEPT} disabled={uploading} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} /></label>}</div>
              {canFile && <CameraAttachment disabled={uploading} upload={async file=>{await w.perform('tm.file.add',{task_id:t.id,name:file.name,base64:await fileToBase64(file)});}} />}
              {!!files.length && <GroupDelivery taskId={t.id} files={files} command={w.perform} read={delivery=>groupRead('/api/tasks/delivery',{id:t.id,delivery})} />}
              {files.length ? <ul className="task-files">
                {files.map(f => <li key={f.id}>
                  {PREVIEW_TYPES.includes(f.mime) ? <button type="button" className="file-thumb" onClick={() => setPreview(f)}><img src={apiPath(`/api/tasks/file?id=${encodeURIComponent(f.id)}&inline=1`)} alt="" loading="lazy" /><span className="sr-only">{uiText("Preview ")}{f.name}</span></button> : <span className="file-icon" aria-hidden="true"><FileText /></span>}
                  <span className="cell-stack"><button type="button" className="text-link file-open" onClick={() => setPreview(f)} title={uiText("Preview")}><EyeIcon aria-hidden="true" className="inline-icon" />{f.name}</button><small>{kb(f.size)} · {name(f.uploaded_by)} · {formatDateTime(f.created_at)}{sourceLabel(f.source) ? uiText(" · via {p0}", { p0: sourceLabel(f.source) }) : ''}</small></span>
                  <Tooltip><TooltipTrigger asChild><a className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'icon-button')} href={apiPath(`/api/tasks/file?id=${encodeURIComponent(f.id)}`)} download={f.name} aria-label={uiText("Download {p0}", { p0: f.name })}><Download aria-hidden="true" /></a></TooltipTrigger><TooltipContent>{uiText("Download")}</TooltipContent></Tooltip>
                  {(f.uploaded_by === me || roles.isGovernor) && <IconButton label={uiText("Remove {p0}", { p0: f.name })} icon={Trash2} disabled={busy} onClick={() => void removeFile(f)} />}
                </li>)}
              </ul> : <p className="muted small">{uiText("No files yet. Attach photos, PDFs or documents (up to 30 MB each). In Telegram, reply to the task’s message with a photo or document.")}</p>}
            </section>}
            {preview && <TaskFilePreview file={preview as Row & { id: string; name: string; mime: string }} onClose={() => setPreview(null)} />}
            <ChangeHistory w={w} taskId={t.id} />
            <section aria-labelledby={`h-${t.id}`}>
              <h3 className="text-section" id={`h-${t.id}`}>{uiText("Activity")}</h3>
              {allowed.includes('note') && (
                <div className="comment-box">
                  <label className="sr-only" htmlFor={`c-${t.id}`}>{uiText("Add a comment")}</label>
                  <Textarea id={`c-${t.id}`} rows={2} value={comment} placeholder={uiText("Add a comment for the people on this task…")} onChange={e => setComment(e.target.value)} maxLength={2000} />
                  <Button size="sm" variant="outline" disabled={busy || !comment.trim()} onClick={addComment}><MessageSquare />{uiText("Comment")}</Button>
                </div>
              )}
              {history.length ? <ol className="timeline compact task-history">
                {history.map((h: Row) => (
                  <li key={h.id} className={`history-${h.kind}`}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <div className="timeline-body">
                      <p className="timeline-title">{name(h.actor_id)} · {HISTORY_LABEL[h.kind] || h.kind}{h.kind === 'progress' ? uiText(" to {p0}%", { p0: h.progress }) : ''}</p>
                      {h.note && <p className="timeline-detail">{h.note}</p>}
                      <p className="timeline-meta">{formatDateTime(h.created_at)}{sourceLabel(h.source) ? uiText(" · via {p0}", { p0: sourceLabel(h.source) }) : ''}</p>
                    </div>
                  </li>
                ))}
              </ol> : <p className="muted small">{uiText("No activity yet.")}</p>}
            </section>
          </div>
          <div className="dialog-footer">
            {/* Leaving Task Management closes the task (its address is left behind in the history). */}
            {t.contact_id && w.can('crm.contacts') && <div className="footer-start"><Button type="button" variant="ghost" onClick={() => w.show('contact', t.contact_id)}><Link2 />{uiText("Customer journey")}</Button></div>}
            <Button type="button" variant="outline" onClick={onClose}>{uiText("Close")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      {action && <ActionDialog spec={action} onClose={() => setAction(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ requests (anyone can ask anyone)
export function requestDraft(w: Workspace, row: Row = {}): Row {
  return { title: '', description: '', manager_id: '', doer: 'RECEIVER', workspace_id: '', priority: 'MEDIUM', proposed_due_date: addDays(taskToday(), 7), department: w.data.tm_profiles.find((p: Row) => p.staff_id === w.actor)?.department || '', department_note: '', ...row, expected_version: row.version, request_key: row.id ? undefined : uuid() };
}
const DOER_LABEL = (w: Workspace, q: Row) => (q.doer === 'RECEIVER' ? `${firstName(w.lookup(q.manager_id))} does it` : q.doer === 'DECIDE' ? `${firstName(w.lookup(q.manager_id))} decides` : `${firstName(w.lookup(q.requested_by))} does it`);
const requestStatus = (q: Row) => <StatusBadge value={q.status} label={REQUEST_STATUS[q.status as keyof typeof REQUEST_STATUS]} tone={q.status === 'PENDING' ? 'warning' : q.status === 'APPROVED' ? 'success' : q.status === 'DECLINED' ? 'danger' : 'neutral'} />;
const personCell = (w: Workspace, id: string) => <span className="person-cell"><Avatar name={w.lookup(id)} size="sm" /><span className="cell-stack"><span className="person-name">{w.lookup(id)}</span>{id === w.actor && <small>{uiText("You")}</small>}</span></span>;

export function RequestsView({ w, onOpen, onNew, actions }: { w: Workspace; onOpen: (id: string) => void; onNew: () => void; actions?: ReactNode }) {
  useLanguage();
  const approver = canApproveTasks(w), me = w.actor;
  const [f, setF] = useViewState('tasks:requests', { tab: 'mine-to-decide', status: '' });
  const all: Row[] = w.data.tm_requests || [];
  const toDecide = all.filter(q => q.manager_id === me && q.status === 'PENDING'), mine = all.filter(q => q.requested_by === me), toMe = all.filter(q => q.manager_id === me);
  const tabs = [
    { value: 'mine-to-decide', label: uiText("Waiting for my answer"), count: toDecide.length },
    { value: 'mine', label: uiText("My requests"), count: mine.length },
    { value: 'to-me', label: uiText("Sent to me"), count: toMe.length },
    ...(approver ? [{ value: 'all', label: uiText("All requests"), count: all.length }] : []),
  ];
  const tab = tabs.some(x => x.value === f.tab) ? f.tab : tabs[0].value;
  const base = tab === 'mine-to-decide' ? toDecide : tab === 'mine' ? mine : tab === 'to-me' ? toMe : all;
  const rows = base.filter(q => !f.status || q.status === f.status).slice().sort((a, b) => (a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1) || String(b.created_at).localeCompare(String(a.created_at)));
  // V5.6.8: new due dates this person may decide (the server's rule) or asked for themselves, on open tasks only.
  const tasks = useTasks(w), openTask = (id: string) => tasks.find((t: Row) => t.id === id && OPEN_TASK_STATUSES.includes(t.status));
  const decides = (d: Row) => { const t = openTask(d.task_id); return !!t && mayDecideDue(w, t, d); };
  const dueRequests: Row[] = (w.data.tm_due_requests || []).filter((d: Row) => d.status === 'PENDING' && !!openTask(d.task_id) && (decides(d) || d.requested_by === me))
    .sort((a: Row, b: Row) => Number(decides(b)) - Number(decides(a)) || String(a.created_at).localeCompare(String(b.created_at)));
  const dueToDecide = dueRequests.filter(decides).length;
  // V5.4: changes to tasks waiting for approval: the ones I decide first, then the ones I asked for.
  const changes: Row[] = (w.data.tm_change_requests || []).filter((c: Row) => c.status === 'PENDING' && !(c.kind === 'COMPLETE' && c.requester_side === 'PIC') && (c.approver_id === me || c.requested_by === me))
    .sort((a: Row, b: Row) => Number(b.approver_id === me) - Number(a.approver_id === me) || String(a.created_at).localeCompare(String(b.created_at)));
  const toApprove = changes.filter(c => c.approver_id === me).length;
  const taskTitle = (id: string) => w.data.tm_tasks.find((t: Row) => t.id === id)?.title || id;
  const cols: Column[] = [
    { key: 'title', header: uiText("Request"), minWidth: 220, cell: q => <span className="cell-stack"><span className="cell-title">{q.title}</span><small><span className="id-text">{q.id}</span>{q.department ? uiText(" · {p0}", { p0: q.department }) : ''}</small></span> },
    { key: 'requested_by', header: uiText("From"), minWidth: 160, sortValue: q => w.lookup(q.requested_by), cell: q => personCell(w, q.requested_by) },
    { key: 'manager_id', header: uiText("Asked"), minWidth: 160, sortValue: q => w.lookup(q.manager_id), cell: q => personCell(w, q.manager_id) },
    { key: 'doer', header: uiText("Who does it"), sortValue: q => DOER_LABEL(w, q), cell: q => <span className="small">{DOER_LABEL(w, q)}</span> },
    { key: 'proposed_due_date', header: uiText("Needed by"), cell: q => q.proposed_due_date ? <DateText value={q.proposed_due_date} /> : null },
    { key: 'priority', header: uiText("Priority"), cell: q => <PriorityBadge value={q.priority} /> },
    { key: 'status', header: uiText("Status"), cell: q => requestStatus(q) },
  ];
  const chips = buildChips([{ key: 's', label: uiText("Status"), value: f.status, display: REQUEST_STATUS[f.status as keyof typeof REQUEST_STATUS], clear: () => setF(v => ({ ...v, status: '' })) }]);
  return (
    <>
      <div className="stat-grid cols-4">
        <StatCard label={uiText("Waiting for my answer")} value={toDecide.length} icon={Inbox} tone={toDecide.length ? 'warning' : undefined} onClick={toDecide.length ? () => setF(v => ({ ...v, tab: 'mine-to-decide', status: '' })) : undefined} actionLabel={uiText("Show requests waiting for my answer")} />
        <StatCard label={uiText("My open requests")} value={mine.filter(q => q.status === 'PENDING').length} caption={uiText("{p0} in total", { p0: mine.length })} />
        <StatCard label={uiText("Accepted this month")} value={all.filter(q => q.status === 'APPROVED' && String(q.decided_at || '').slice(0, 7) === taskToday().slice(0, 7) && (approver || q.requested_by === me || q.manager_id === me)).length} tone="success" caption={uiText("requests that became tasks")} />
        <StatCard label={uiText("Changes to approve")} value={toApprove + dueToDecide} icon={Scale} tone={toApprove + dueToDecide ? 'warning' : undefined} caption={uiText("task changes and new due dates")} />
      </div>
      {changes.length > 0 && (
        <Card className="mt-5" title={uiText("Changes waiting for approval")} description={uiText("Updates, completions and cancellations of tasks need the other side’s approval: the person in charge and the person who assigned the task.")} flush>
          <DataTable dense rows={changes} stateKey="tasks-change-requests" rowLabel={c => `Open task ${taskTitle(c.task_id)}`} onRowClick={c => w.show('tm_task', c.task_id)} rowClassName={c => (c.approver_id === me ? 'row-attention' : undefined)} itemName="change requests"
            columns={[
              { key: 'task', header: uiText("Task"), minWidth: 200, sortValue: c => taskTitle(c.task_id), cell: c => <span className="cell-stack"><span className="cell-title">{taskTitle(c.task_id)}</span><small className="id-text">{c.task_id}</small></span> },
              { key: 'change', header: uiText("Change"), minWidth: 240, wrap: true, sortValue: c => changeTitle(c), cell: c => <span className="cell-stack"><span>{changeTitle(c)}</span><ChangeList changes={parseChanges(c)} /></span> },
              { key: 'requested_by', header: uiText("Asked by"), cell: c => personCell(w, c.requested_by) },
              { key: 'approver_id', header: uiText("Approves"), cell: c => personCell(w, c.approver_id) },
              { key: 'created_at', header: uiText("Asked"), cell: c => <span className="nowrap">{formatDateTime(c.created_at)}</span> },
            ]} empty={<EmptyState compact title={uiText("Nothing is waiting for approval")} />} />
        </Card>
      )}
      <div className="toolbar mt-5"><Segmented label={uiText("Requests")} value={tab} onChange={v => setF(s => ({ ...s, tab: v }))} options={tabs} />{actions && <div className="row">{actions}</div>}</div>
      <FilterBar filters={<FilterSelect label={uiText("Status")} value={f.status} onChange={v => setF(s => ({ ...s, status: v }))} options={translatedEntries(REQUEST_STATUS) as [string, string][]} />}
        chips={chips} onReset={() => setF(s => ({ ...s, status: '' }))} summary={<><strong>{rows.length}</strong> {plural(rows.length, 'request')}</>} />
      <Card flush>
        <DataTable columns={cols} rows={rows} stateKey={`tasks-requests-${tab}`} resetKey={JSON.stringify(f)} onRowClick={q => onOpen(q.id)} rowLabel={q => `Open request ${q.title}`} rowClassName={q => (q.status === 'PENDING' && q.manager_id === me ? 'row-attention' : undefined)} itemName="requests" filtered={chips.length > 0} onClearFilters={() => setF(s => ({ ...s, status: '' }))}
          empty={<EmptyState icon={Inbox} title={tab === 'mine-to-decide' ? uiText("Nothing is waiting for your answer") : uiText("No task requests yet")} description={tab === 'mine' ? uiText("Ask anyone for a task: work you need them to do, or work you want to take on. They accept it (it becomes a task) or decline with a reason.") : undefined} action={tab === 'mine' ? <Button size="sm" onClick={onNew}><Plus />{uiText("Request a task")}</Button> : undefined} />} />
      </Card>
      {dueRequests.length > 0 && (
        <Card className="mt-5" title={uiText("Due date requests")} description={uiText("People working on a task can ask its reviewer for a new due date.")} flush>
          <DataTable dense rows={dueRequests} stateKey="tasks-due-requests" rowLabel={d => `Open task ${taskTitle(d.task_id)}`} onRowClick={d => w.show('tm_task', d.task_id)} rowClassName={d => (decides(d) ? 'row-attention' : undefined)} itemName="due date requests"
            columns={[
              { key: 'task', header: uiText("Task"), minWidth: 200, sortValue: d => taskTitle(d.task_id), cell: d => <span className="cell-stack"><span className="cell-title">{taskTitle(d.task_id)}</span><small className="id-text">{d.task_id}</small></span> },
              { key: 'requested_by', header: uiText("Asked by"), cell: d => personCell(w, d.requested_by) },
              { key: 'dates', header: uiText("Change"), sortValue: d => d.proposed_due_date, cell: d => <span className="nowrap"><DateText value={d.current_due_date} /> → <strong><DateText value={d.proposed_due_date} /></strong></span> },
              { key: 'reason', header: uiText("Reason"), wrap: true, minWidth: 180, cell: d => <ExpandableText text={d.reason} /> },
              { key: 'decide_by', header: uiText("Decides"), cell: d => personCell(w, d.decide_by) },
            ]} empty={<EmptyState compact title={uiText("No due date requests")} />} />
        </Card>
      )}
    </>
  );
}

export function RequestDialog({ w, requestId, onClose, onEdit, onOpenTask }: { w: Workspace; requestId: string; onClose: () => void; onEdit: (q: Row) => void; onOpenTask: (id: string) => void }) {
  useLanguage();
  const q: Row | undefined = (w.data.tm_requests || []).find((x: Row) => x.id === requestId);
  const [mode, setMode] = useState<'view' | 'approve'>('view'), [busy, setBusy] = useState(false), [action, setAction] = useState<ActionSpec | null>(null);
  const confirm = useConfirm(), form = useFormErrors();
  const [a, setA] = useState<Row>({});
  useEffect(() => {
    if (!q) return;
    const doer = q.doer || 'REQUESTER', wss = w.data.tm_workspaces.filter((x: Row) => x.status === 'ACTIVE'), mineWs = wss.filter((x: Row) => w.data.tm_members.some((m: Row) => m.workspace_id === x.id && m.staff_id === w.actor));
    setA({ workspace_id: q.workspace_id || (mineWs.length === 1 ? mineWs[0].id : wss.length === 1 ? wss[0].id : ''), pic_id: doer === 'RECEIVER' ? w.actor : doer === 'REQUESTER' ? q.requested_by : '', supporter_ids: [],
      reviewer_id: doer === 'RECEIVER' ? q.requested_by : w.actor, due_date: q.proposed_due_date && q.proposed_due_date >= taskToday() ? q.proposed_due_date : addDays(taskToday(), 7), title: q.title, priority: q.priority, department: q.department, department_note: q.department_note });
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q) return null;
  const me = w.actor, pending = q.status === 'PENDING', isAsked = q.manager_id === me, isRequester = q.requested_by === me, receives = q.doer === 'RECEIVER';
  const everyone = peopleOptions(w, { include: [a.pic_id, a.reviewer_id, q.requested_by] });
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const decline = async () => { const r = await confirm({ title: uiText("Decline this request?"), description: uiText("{p0} will see your reason.", { p0: w.lookup(q.requested_by) }), confirmLabel: uiText("Decline request"), tone: 'danger', reason: { label: uiText("Reason"), required: true } }); if (r) void run(() => w.perform('tm.request.decide', { id: q.id, decision: 'DECLINE', note: r.reason, expected_version: q.version })); };
  const withdraw = async () => { if (await confirm({ title: uiText("Withdraw this request?"), confirmLabel: uiText("Withdraw request"), tone: 'danger' })) void run(() => w.perform('tm.request.withdraw', { id: q.id })); };
  const forward = () => setAction({ title: uiText("Pass this request to someone else"), description: uiText("They receive it with your note; the requester is told."), fields: [{ key: 'manager_id', label: uiText("Pass it to"), type: 'person', required: true, people: peopleOptions(w, { exclude: [me, q.requested_by] }) }, { key: 'note', label: uiText("Note (optional)"), type: 'textarea' }], confirmLabel: uiText("Pass on"), run: v => w.perform('tm.request.forward', { id: q.id, ...v }) });
  const approve = async (e: FormEvent) => {
    e.preventDefault(); if (!form.validate()) return;
    setBusy(true); form.reset();
    try { const r = await w.perform('tm.request.decide', { id: q.id, decision: 'APPROVE', expected_version: q.version, ...a }); onClose(); if (r?.id) onOpenTask(r.id); }
    catch (err) { form.fail((err as Error).message); } finally { setBusy(false); }
  };
  const reg = (key: string, label: string, required = false, type = 'select') => { form.register({ key, label, required, type, value: a[key] }); return key; };
  return (
    <>
      <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
        <DialogContent className={mode === 'approve' ? 'dialog-lg' : 'dialog-md'}>
          <DialogHeader>
            <DialogTitle>{mode === 'approve' ? (receives ? uiText("Accept and create the task") : uiText("Approve and create the task")) : q.title}</DialogTitle>
            <DialogDescription><span className="id-text">{q.id}</span> {uiText("· requested by ")}{w.lookup(q.requested_by)} · {formatDateTime(q.created_at)}</DialogDescription>
          </DialogHeader>
          {mode === 'view' ? <>
            <div className="dialog-body stack" tabIndex={0} role="region" aria-label={uiText("Request details")}>
              <div className="row">{requestStatus(q)}<PriorityBadge value={q.priority} />{sourceLabel(q.source) && <span className="muted small">{uiText("via ")}{sourceLabel(q.source)}</span>}</div>
              {q.status === 'DECLINED' && <Alert tone="warning" title={uiText("Declined by {p0}", { p0: w.lookup(q.decided_by) })}>{q.decision_note}</Alert>}
              {q.status === 'APPROVED' && q.task_id && <Alert tone="success" title={uiText("Accepted as {p0}", { p0: q.task_id })} action={<Button size="sm" variant="outline" onClick={() => { onClose(); onOpenTask(q.task_id); }}>{uiText("Open task")}</Button>}>{q.decision_note || uiText("Accepted by {p0} on {p1}.", { p0: w.lookup(q.decided_by), p1: formatDate(q.decided_at) })}</Alert>}
              <KeyValues dense columns={2} items={[
                [uiText("From"), personCell(w, q.requested_by)], [uiText("Asked"), personCell(w, q.manager_id)],
                [uiText("Who does it"), DOER_LABEL(w, q)], [uiText("Needed by"), q.proposed_due_date ? <DateText value={q.proposed_due_date} /> : null],
                [uiText("Workspace"), q.workspace_id ? w.data.tm_workspaces.find((x: Row) => x.id === q.workspace_id)?.name : uiText("Chosen when accepted")], [uiText("Department"), q.department || null],
              ]} />
              {q.department_note && <div className="notes-block"><p className="text-label">{uiText("Department note")}</p><p>{q.department_note}</p></div>}
              {q.description && <div><p className="text-label">{uiText("Expectation")}</p><ExpandableText text={q.description} lines={5} /></div>}
              {pending && isAsked && <Alert tone="info" title={uiText("This request is waiting for your answer")}>{receives ? uiText("{p0} asks you to do this. Accept it to create the task (you are in charge and {p1} reviews it), decline it with a reason, or pass it to someone else.", { p0: firstName(w.lookup(q.requested_by)), p1: firstName(w.lookup(q.requested_by)) }) : q.doer === 'DECIDE' ? uiText("Accept it to create the task and choose who does it, decline it with a reason, or pass it to someone else.") : uiText("{p0} asks to take this on. Approve it to create the task (they are in charge and you review it), decline it with a reason, or pass it to someone else.", { p0: firstName(w.lookup(q.requested_by)) })}</Alert>}
            </div>
            <div className="dialog-footer">
              <div className="footer-start">
                {pending && isRequester && <><Button variant="outline" size="sm" disabled={busy} onClick={() => onEdit(q)}><Pencil />{uiText("Edit")}</Button><Button variant="danger-outline" size="sm" disabled={busy} onClick={() => void withdraw()}><CircleSlash />{uiText("Withdraw")}</Button></>}
                {pending && isAsked && <Button variant="ghost" size="sm" disabled={busy} onClick={forward}>{uiText("Pass to someone else…")}</Button>}
              </div>
              {pending && isAsked ? <><Button variant="outline" disabled={busy} onClick={() => void decline()}>{uiText("Decline…")}</Button><Button disabled={busy} onClick={() => setMode('approve')}><CheckCheck />{receives ? uiText("Accept…") : uiText("Approve…")}</Button></> : <Button variant="outline" onClick={onClose}>{uiText("Close")}</Button>}
            </div>
          </> : (
            <form className="dialog-form" onSubmit={approve} noValidate>
              <fieldset disabled={busy}>
                <div className="dialog-body">
                  {form.formError && <Alert tone="danger" title={uiText("This could not be saved")} live>{form.formError}</Alert>}
                  <FormSection title={uiText("Task")}>
                    <Field fieldKey={reg('title', uiText("Task title"), true, 'text')} label={uiText("Task title")} wide required value={a.title} onChange={v => setA(s => ({ ...s, title: v }))} error={form.errors.title} />
                    <Picker fieldKey={reg('workspace_id', uiText("Workspace"), true)} label={uiText("Workspace")} required value={a.workspace_id} error={form.errors.workspace_id} options={w.data.tm_workspaces.filter((x: Row) => x.status === 'ACTIVE').map((x: Row) => [x.id, x.name])} onChange={v => { setA(s => ({ ...s, workspace_id: v })); form.clear('workspace_id'); }} />
                    <Field fieldKey={reg('due_date', uiText("Due date"), true, 'date')} label={uiText("Due date")} type="date" required min={taskToday()} value={a.due_date} onChange={v => setA(s => ({ ...s, due_date: v }))} error={form.errors.due_date} />
                    <PersonPicker fieldKey={reg('pic_id', uiText("Person in charge"), true)} label={uiText("Person in charge")} required value={a.pic_id} error={form.errors.pic_id} people={everyone}
                      hint={a.pic_id === me ? uiText("You take charge, so the task starts as accepted.") : a.pic_id === q.requested_by && q.doer === 'REQUESTER' ? uiText("The requester asked for it, so the task starts as accepted.") : uiText("They are asked to accept the task.")}
                      onChange={v => { setA(s => ({ ...s, pic_id: v, supporter_ids: (s.supporter_ids || []).filter((x: string) => x !== v) })); form.clear('pic_id'); }} />
                    <Picker label={uiText("Priority")} value={a.priority} allowNone={false} options={[['HIGH', uiText("High")], ['MEDIUM', uiText("Medium")], ['LOW', uiText("Low")]]} onChange={v => setA(s => ({ ...s, priority: v }))} />
                  </FormSection>
                  <FormSection columns={1}>
                    <PeoplePicker label={uiText("Supporting people")} people={everyone.filter(p => p.id !== a.pic_id)} value={a.supporter_ids || []} onChange={v => setA(s => ({ ...s, supporter_ids: v }))} addLabel="Add supporting person" empty={uiText("Optional. They are asked to accept.")} />
                  </FormSection>
                  <FormSection title={uiText("Review and department")}>
                    <PersonPicker label={uiText("Reviewer")} value={a.reviewer_id} people={everyone} hint={a.reviewer_id === q.requested_by && receives ? uiText("The requester reviews the work (they asked for it).") : uiText("Reviews the work when it is submitted.")} onChange={v => setA(s => ({ ...s, reviewer_id: v }))} />
                    <Field label={uiText("Department")} value={a.department || ''} onChange={v => setA(s => ({ ...s, department: v }))} />
                    <Field label={uiText("Department note")} type="textarea" wide value={a.department_note || ''} onChange={v => setA(s => ({ ...s, department_note: v }))} />
                  </FormSection>
                </div>
                <div className="dialog-footer">
                  <Button type="button" variant="outline" onClick={() => setMode('view')}>{uiText("Back")}</Button>
                  <Button type="submit" loading={busy}><CheckCheck />{receives ? uiText("Accept and create task") : uiText("Approve and create task")}</Button>
                </div>
              </fieldset>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {action && <ActionDialog spec={action} onClose={() => setAction(null)} />}
    </>
  );
}

const DOER_CHOICES: [string, (asked: string) => string, string][] = [
  dynamicLabels(['RECEIVER', asked => (asked ? `${asked} does it` : uiText("They do it")), "The person you ask takes charge when they accept. You review the work."], { 2: () => uiText("The person you ask takes charge when they accept. You review the work.") }),
  dynamicLabels(['REQUESTER', () => 'I do it', "You ask to take this on. When they approve, you are in charge and they review it."], { 2: () => uiText("You ask to take this on. When they approve, you are in charge and they review it.") }),
  dynamicLabels(['DECIDE', asked => (asked ? `${asked} decides who does it` : uiText("They decide who does it")), "The person you ask chooses who takes charge when they accept."], { 2: () => uiText("The person you ask chooses who takes charge when they accept.") }),
];
export function RequestEditor({ w, draft, onClose }: { w: Workspace; draft: Row; onClose: () => void }) {
  useLanguage();
  const [d, setD] = useState<Row>(draft), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const form = useFormErrors(), confirm = useConfirm(), doerId = useId();
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setDirty(true); form.clear(k); };
  const people = peopleOptions(w, { include: [d.manager_id], exclude: [w.actor] });
  const reg = (key: string, label: string, required = false, type = 'text') => { form.register({ key, label, required, type, value: d[key] }); return key; };
  const close = async () => { if (busy) return; if (dirty && !(await confirm({ title: uiText("Discard this request?"), confirmLabel: uiText("Discard"), cancelLabel: uiText("Keep editing"), tone: 'danger' }))) return; onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!String(d.description || '').trim()) { form.setFieldError('description',uiText("Expectation is required.")); return; } if (!form.validate()) return;
    setBusy(true); form.reset();
    try { await w.perform('tm.request.save', { ...d, workspace_id: d.workspace_id || null, proposed_due_date: d.proposed_due_date || null }); onClose(); }
    catch (err) { form.fail((err as Error).message); } finally { setBusy(false); }
  };
  const asked = d.manager_id ? firstName(w.lookup(d.manager_id)) : '';
  return (
    <Dialog open onOpenChange={o => { if (!o) void close(); }}>
      <DialogContent className="dialog-lg" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{d.id ? uiText("Edit task request") : uiText("Request a task")}</DialogTitle>
          <DialogDescription>{uiText("Ask anyone who uses Task Management. They accept it (it becomes a task) or decline it with a reason. Fields marked * are required.")}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title={uiText("This could not be sent")} live>{form.formError}</Alert>}
              {!people.length && <Alert tone="warning" title={uiText("Nobody else uses Task Management yet")}>{uiText("Ask an administrator to create logins for your colleagues.")}</Alert>}
              <TaskVisibility request manager={d.governing_manager_id} onManager={v=>set('governing_manager_id',v)} managers={w.data.tm_workspaces.find((ws:Row)=>ws.id===d.workspace_id)?.task_manager_options||[]} value={d.visibility} onChange={v=>set('visibility',v)} organizational={w.data.tm_workspaces.some((ws:Row)=>ws.id===d.workspace_id&&ws.kind==='ORGANIZATIONAL')} />
              <FormSection title={uiText("What do you need?")}>
                <Field fieldKey={reg('title', uiText("Request title"), true)} label={uiText("Request title")} wide required value={d.title} onChange={v => set('title', v)} error={form.errors.title} placeholder={uiText("For example: Prepare the customs file for the October shipment")} />
                <PersonPicker fieldKey={reg('manager_id', uiText("Who you are asking"), true, 'select')} label={uiText("Ask")} required value={d.manager_id} people={people} error={form.errors.manager_id} onChange={v => set('manager_id', v)} placeholder={uiText("Choose who you are asking…")} hint={uiText("Anyone with Task Management, whatever their role.")} />
                <fieldset className="choice-cards span-2" aria-describedby={`${doerId}-hint`}>
                  <legend className="field-label">{uiText("Who should do it?")}</legend>
                  {DOER_CHOICES.map(([value, label, hint]) => (
                    <label key={value} className={`choice-card${d.doer === value ? " is-checked" : ''}`}>
                      <input type="radio" name={`${doerId}-doer`} value={value} checked={d.doer === value} onChange={() => set('doer', value)} />
                      <span className="cell-stack"><span className="cell-title">{label(asked)}</span><small>{hint}</small></span>
                    </label>
                  ))}
                  <p className="field-hint" id={`${doerId}-hint`}>{uiText("You can change the details until your request is answered.")}</p>
                </fieldset>
                <Picker label={uiText("Workspace")} value={d.workspace_id} none={uiText("Let them choose")} options={w.data.tm_workspaces.filter((x: Row) => x.status === 'ACTIVE').map((x: Row) => [x.id, x.name])} onChange={v => set('workspace_id', v)} />
                <Field label={uiText("Needed by")} type="date" value={d.proposed_due_date || ''} min={taskToday()} onChange={v => set('proposed_due_date', v)} hint={uiText("Optional. The final due date is set when the request is accepted.")} />
                <Picker label={uiText("Priority")} value={d.priority} allowNone={false} options={[['HIGH', uiText("High")], ['MEDIUM', uiText("Medium")], ['LOW', uiText("Low")]]} onChange={v => set('priority', v)} />
                <Field fieldKey={reg('description',uiText("Expectation"),true)} error={form.errors.description} label={uiText("Expectation")} type="textarea" required wide value={d.description} onChange={v => set('description', v)} />
              </FormSection>
              <FormSection title={uiText("Department")} description={uiText("Which department or team the task is for, and anything they should know.")}>
                <Field label={uiText("Department")} value={d.department} onChange={v => set('department', v)} />
                <Field label={uiText("Department note")} type="textarea" wide value={d.department_note} onChange={v => set('department_note', v)} />
              </FormSection>
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>{uiText("Cancel")}</Button>
              <Button type="submit" loading={busy} disabled={!people.length}><Send />{d.id ? uiText("Save request") : uiText("Send request")}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ monthly report
const CATEGORY_UI: Record<string, { tone: 'success' | 'accent' | 'danger' | 'warning'; icon: LucideIcon; caption: string }> = {
  completed: { tone: 'success', icon: CheckCircle2, get caption() { return uiText("Closed during the month"); } },
  in_progress: { tone: 'accent', icon: PlayCircle, get caption() { return uiText("In progress or in review at month end (not stuck)"); } },
  stuck: { tone: 'danger', icon: Hand, get caption() { return uiText("Marked stuck at any time in the month"); } },
  // V5.6.8: overdue is red, as everywhere else in Task Management.
  overdue: { tone: 'danger', icon: FileClock, get caption() { return uiText("Open past the due date at month end, or completed late"); } },
};
/** V5.6.8: the report month as words ("October 2026") with previous/next, instead of a browser month field ("2026 - 10"). */
function MonthStepper({ month, label, onChange }: { month: string; label: string; onChange: (month: string) => void }) {
  useLanguage();
  const now = currentMonth();
  return (
    <div className="month-stepper" role="group" aria-label={uiText("Report month")}>
      <IconButton label={uiText("Previous month")} icon={ChevronLeft} variant="outline" onClick={() => onChange(shiftMonth(month, -1))} />
      <span className="month-stepper-label" aria-live="polite">{label}</span>
      <IconButton label={uiText("Next month")} icon={ChevronRight} variant="outline" disabled={month >= now} onClick={() => onChange(shiftMonth(month, 1) > now ? now : shiftMonth(month, 1))} />
      {month !== now && <Button size="sm" variant="ghost" onClick={() => onChange(now)}>{uiText("This month")}</Button>}
    </div>
  );
}
export function MonthlyTaskReport({ w }: { w: Workspace }) {
  useLanguage();
  const [f, setF] = useViewState<Row>('reports:tasks-monthly', { month: currentMonth(), category: '', workspace: '', user: '', department: '' });
  const month = /^\d{4}-\d{2}$/.test(f.month) ? f.month : currentMonth();
  const report = f.category ? MONTHLY_CATEGORIES.find(c => c[0] === f.category)?.[2] || 'monthly' : 'monthly';
  const params = new URLSearchParams(Object.fromEntries(Object.entries({ report, month, workspace: f.workspace, user: f.user, department: f.department }).filter(([, v]) => v))).toString();
  const { report: data, error, loading } = useServerReport('/api/tasks/report?' + params, w.data);
  const summary = data.summary || { completed: 0, in_progress: 0, stuck: 0, overdue: 0 };
  const departments = [...new Set([...(w.data.tm_tasks || []).map((t: Row) => t.department), ...w.data.tm_workspaces.map((x: Row) => x.department)].filter(Boolean))].sort() as string[];
  const label = (() => { try { return monthBounds(month).label; } catch { return month; } })();
  const running = month === currentMonth();
  const cols: Column[] = (data.columns || []).map(([key, header]: string[]) => ({
    key, header, numeric: ['progress', 'days_overdue'].includes(key), wrap: ['title', 'detail', 'stuck_reason', 'supporters'].includes(key), minWidth: key === 'title' ? 200 : undefined,
    cell: (r: Row) => key === 'group' ? <StatusBadge value={r.group} label={r.group} tone={r.category === 'completed' ? 'success' : r.category === 'stuck' || r.category === 'overdue' ? 'danger' : 'info'} />
      : key === 'status' ? <StatusBadge value={r.status} /> : ['due_date', 'completed_on', 'stuck_since'].includes(key) ? <DateText value={r[key]} />
        : key === 'on_time' ? <StatusBadge value={r.on_time === 'Late' ? 'LATE' : 'YES'} label={r.on_time} /> : key === 'still_stuck' ? <StatusBadge value={r.still_stuck} label={r.still_stuck} tone={r.still_stuck === 'Yes' ? 'danger' : 'neutral'} />
          : key === 'id' ? <span className="id-text">{r.id}</span> : isMissing(r[key]) ? null : String(r[key]),
  }));
  const chips = buildChips([
    { key: 'ws', label: uiText("Workspace"), value: f.workspace, display: w.data.tm_workspaces.find((x: Row) => x.id === f.workspace)?.name, clear: () => setF(s => ({ ...s, workspace: '' })) },
    { key: 'u', label: uiText("Person"), value: f.user, display: w.lookup(f.user), clear: () => setF(s => ({ ...s, user: '' })) },
    { key: 'd', label: uiText("Department"), value: f.department, clear: () => setF(s => ({ ...s, department: '' })) },
  ]);
  const canExport = w.can('tasks.reports', 'export');
  return (
    <>
      <FilterBar
        search={<MonthStepper month={month} label={label} onChange={v => setF(s => ({ ...s, month: v }))} />}
        filters={<>
          <FilterSelect label={uiText("Workspace")} value={f.workspace} onChange={v => setF(s => ({ ...s, workspace: v }))} options={w.data.tm_workspaces.map((x: Row) => [x.id, x.name])} />
          <FilterSelect label={uiText("Person")} value={f.user} onChange={v => setF(s => ({ ...s, user: v }))} options={(w.data.task_scope?.employee_filters?.tasks || []).map((id: string) => [id, w.lookup(id)])} allLabel="Everyone" people />
          <FilterSelect label={uiText("Department")} value={f.department} onChange={v => setF(s => ({ ...s, department: v }))} options={departments.map(x => [x, x])} />
        </>}
        actions={canExport && <><ButtonLink size="sm" href={apiPath('/api/tasks/report.csv?' + params)}><Download />CSV</ButtonLink><ButtonLink size="sm" target="_blank" rel="noopener" href={apiPath('/api/tasks/report.print?' + params)}><Printer />{uiText("Print / PDF")}</ButtonLink></>}
        chips={chips} onReset={() => setF(s => ({ month: s.month, category: s.category, workspace: '', user: '', department: '' }))}
        summary={<><strong>{label}</strong>{running ? uiText(" · so far this month") : ''}</>} />
      {error ? <ErrorState message={error} /> : <>
        <div className="stat-grid cols-4 monthly-stats" role="group" aria-label={uiText("Task categories for {p0}", { p0: label })}>
          {MONTHLY_CATEGORIES.map(([key, name]) => {
            const ui = CATEGORY_UI[key];
            return <StatCard key={key} label={name} value={summary[key] ?? 0} icon={ui.icon} tone={ui.tone === 'accent' ? 'accent' : ui.tone} caption={ui.caption} className={f.category === key ? 'is-selected' : undefined}
              onClick={() => setF(s => ({ ...s, category: s.category === key ? '' : key }))} actionLabel={f.category === key ? uiText("Show all categories") : uiText("Show only {p0} tasks", { p0: name.toLowerCase() })} />;
          })}
        </div>
        <Card className={`mt-5${loading ? " is-refreshing" : ''}`} flush title={data.title || uiText("Monthly task summary · {p0}", { p0: label })}
          description={f.category ? uiText("Select the card again to see every category.") : uiText("Every task in each category. A task can appear in more than one (for example stuck and overdue).")}
          actions={f.category ? <Button size="sm" variant="ghost" onClick={() => setF(s => ({ ...s, category: '' }))}>{uiText("Show all categories")}</Button> : undefined}>
          <DataTable dense columns={cols} rows={data.rows || []} rowKey={r => `${r.category}:${r.id}`} stateKey={`rpt-monthly-${report}`} resetKey={params} onRowClick={r => w.show('tm_task', r.id)} rowLabel={r => `Open task ${r.title}`} pageSize={50} itemName="tasks"
            filtered={chips.length > 0} onClearFilters={() => setF(s => ({ ...s, workspace: '', user: '', department: '' }))}
            empty={<EmptyState compact title={f.category ? uiText("No {p0} tasks in {p1}", { p0: (MONTHLY_CATEGORIES.find(c => c[0] === f.category)?.[1] || '').toLowerCase(), p1: label }) : uiText("No tasks for {p0}", { p0: label })} description={running ? uiText("Tasks appear here as they are completed, worked on, get stuck or pass their due date this month.") : undefined} />} />
        </Card>
        <p className="page-footnote">{uiText("Months follow Cambodia time. Completed: closed during the month and still closed at its end. In progress: in progress or waiting for review at the end of the month (or today), and not stuck. Stuck: marked stuck at any time during the month. Overdue: still open after the due date at the end of the month (or today), or completed after the due date during the month.")}</p>
      </>}
    </>
  );
}


// ------------------------------------------------------------------ notifications (header)
const KIND_ICON: Record<string, LucideIcon> = {
  request_new: Inbox, request_approved: CheckCheck, request_declined: XCircle, request_withdrawn: CircleSlash, request_forwarded: Send,
  due_new: CalendarClock, due_approved: CalendarClock, due_declined: CalendarClock,
  task_assigned: UserCheck, task_updated: Pencil, task_supporting: Users, task_reviewer: ClipboardCheck,
  task_accepted: CheckCircle2, task_declined: XCircle, support_accepted: UserCheck, support_declined: XCircle, review_accepted: ClipboardCheck, review_declined: XCircle,
  task_reminder: BellRing, task_repeat: Repeat, task_file: Paperclip, task_due_soon: CalendarClock, task_overdue: FileClock,
  telegram_connected: Send, task_stuck: Hand, task_resumed: PlayCircle, task_progress: PlayCircle, task_submitted: Send, task_closed: CheckCircle2, task_returned: Undo2, task_cancelled: Ban, task_reopened: RotateCcw, task_note: MessageSquare,
  change_request: Scale, change_approved: CheckCheck, change_rejected: XCircle, change_withdrawn: CircleSlash, task_passed: ArrowRight,
};
const WAIT_ROLE: Record<string, string> = translatedMap({ pic: 'Take charge?', supporter: 'Support?', reviewer: 'Review?' });
const ORG_KIND: Record<string, string> = translatedMap({ MEMBERSHIP: 'Workspace membership', DELEGATION: 'Delegated authority', STRUCTURE: 'Reporting change' });
/** Opens Organizational Structure on one request (its Approvals tab), or on the page when no request is named. */
const orgAddress = (id?: string) => '/tasks/organization' + (id ? '?org_request=' + encodeURIComponent(id) : '');

export function NotificationsMenu({ w, opsAlerts, onOps }: { w: Workspace; opsAlerts: number; onOps: () => void }) {
  useLanguage();
  const [open, setOpen] = useState(false), [orgRows, setOrgRows] = useState<Row[]>([]);
  const tasks = useTasks(w), me = w.actor;
  const waiting = useMemo(() => decisionsFor(w.data, me, w.can, tasks), [w.data, me, tasks, w.can]);
  const org = waiting.org;
  // V5.6.8: organization requests this person decides. When the state carries only their number, the open menu reads
  // them (the same list as Organizational Structure → Approvals, "Waiting for me").
  useEffect(() => {
    if (!open || org.items.length || !org.count) return;
    let live = true;
    void apiFetch('/api/organization?' + new URLSearchParams({ view: 'requests', status: 'PENDING', mine: '1', limit: '20' }))
      .then(r => (r.ok ? r.json() : null)).then((d: Row | null) => { if (live && d) setOrgRows((d.rows || []).filter((q: Row) => q.status === 'PENDING' && q.approver_id === me)); }).catch(() => {});
    return () => { live = false; };
  }, [open, org.count, org.items.length, me]);
  const orgItems: Row[] = (org.items.length ? org.items : orgRows).slice(0, Math.max(org.count, 0));
  const list: Row[] = w.data.tm_notifications || [], unread = list.filter(n => !n.read_at);
  const total = unread.length + opsAlerts, decisions = waiting.total;
  const go = (n: Row) => {
    setOpen(false);
    if (!n.read_at) void w.perform('tm.notification.read', { id: n.id }, { quiet: true }).catch(() => {});
    if (n.org_request_id) w.navigate(orgAddress(n.org_request_id));
    else if (n.request_id && n.kind.startsWith('request_')) w.show('tm_request', n.request_id);
    else if (n.task_id) w.show('tm_task', n.task_id);
  };
  const openItem = (type: 'tm_task' | 'tm_request' | 'org', id: string) => { setOpen(false); if (type === 'org') w.navigate(orgAddress(id)); else w.show(type, id); };
  // Work that needs an answer from this person comes first, so a new assignment is never buried under updates.
  const answers: { key: string; type: 'tm_task' | 'tm_request' | 'org'; id: string; title: string; label: string; icon: LucideIcon }[] = [
    ...waiting.answer.map((t: Row) => ({ key: `a-${t.id}`, type: 'tm_task' as const, id: t.id, title: t.title, label: (t.waiting as Row[]).filter((x: Row) => x.staff_id === me).map((x: Row) => WAIT_ROLE[x.role]).join(' · '), icon: UserCheck })),
    ...waiting.review.map((t: Row) => ({ key: `r-${t.id}`, type: 'tm_task' as const, id: t.id, title: t.title, label: uiText("{p0} · from {p1}", { p0: completionApprover(t) === me && t.change_request?.kind === 'COMPLETE' ? 'Approve completion' : 'Review', p1: firstName(w.lookup(t.submitted_by)) }), icon: ClipboardCheck })),
    ...waiting.approvals.map((c: Row) => ({ key: `c-${c.id}`, type: 'tm_task' as const, id: c.task_id, title: tasks.find((t: Row) => t.id === c.task_id)?.title || c.task_id, label: uiText("Approve: {p0} · from {p1}", { p0: changeTitle(c).toLowerCase(), p1: firstName(w.lookup(c.requested_by)) }), icon: Scale })),
    ...waiting.requests.map((q: Row) => ({ key: `q-${q.id}`, type: 'tm_request' as const, id: q.id, title: q.title, label: uiText("Task request · from {p0}", { p0: firstName(w.lookup(q.requested_by)) }), icon: Inbox })),
    ...waiting.due.map((d: Row) => ({ key: `d-${d.id}`, type: 'tm_task' as const, id: d.task_id, title: tasks.find((t: Row) => t.id === d.task_id)?.title || d.task_id, label: uiText("New due date · {p0}", { p0: formatDate(d.proposed_due_date) }), icon: CalendarClock })),
    ...orgItems.map((q: Row) => ({ key: `o-${q.id}`, type: 'org' as const, id: q.id, title: uiText("{p0}{p1}", { p0: ORG_KIND[q.kind] || 'Organization request', p1: q.beneficiary_id ? ` · ${w.lookup(q.beneficiary_id)}` : '' }), label: uiText("Approve or reject · from {p0}", { p0: firstName(w.lookup(q.requester_id)) }), icon: ShieldCheck })),
  ];
  // Organization requests not listed yet (the menu is still reading them) stay reachable through Organizational Structure.
  const orgMore = Math.max(0, org.count - orgItems.length);
  const shown = answers.slice(0, 6), hidden = decisions - shown.length - (orgMore && shown.length < 6 ? orgMore : 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="header-icon-button notif-trigger" aria-label={total || decisions ? uiText("Notifications: {p0} unread, {p1} waiting for your decision", { p0: total, p1: decisions }) : uiText("Notifications")}>
          <Bell aria-hidden="true" />
          {total + decisions > 0 && <span className={`count-pill${decisions ? " is-alert" : ''}`} aria-hidden="true">{total + decisions > 9 ? '9+' : total + decisions}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="notif-menu" aria-label={uiText("Notifications")}>
        {decisions > 0 && <>
          <div className="notif-head"><h2 className="notif-title">{uiText("Waiting for your decision ")}<span className="notif-count">{decisions}</span></h2></div>
          <ul className="notif-list notif-answers">
            {shown.map(x => (
              <li key={x.key}>
                <button type="button" className="notif-item is-unread" onClick={() => openItem(x.type, x.id)}>
                  <x.icon aria-hidden="true" />
                  <span className="notif-text"><strong>{x.title}</strong><span>{x.label}</span></span>
                </button>
              </li>
            ))}
            {orgMore > 0 && shown.length < 6 && <li>
              <button type="button" className="notif-item is-unread" onClick={() => openItem('org', '')}>
                <ShieldCheck aria-hidden="true" />
                <span className="notif-text"><strong>{uiText("Organization approvals")}</strong><span>{orgMore} {plural(orgMore, 'request')} {uiText("waiting for your decision · Organizational Structure")}</span></span>
              </button>
            </li>}
            {hidden > 0 && <li className="notif-more">{uiText("and ")}{hidden} {uiText("more in Task Management")}</li>}
          </ul>
        </>}
        <div className="notif-head">
          <h2 className="notif-title">{uiText("Notifications")}</h2>
          {unread.length > 0 && <Button size="xs" variant="ghost" onClick={() => void w.perform('tm.notification.read', { all: true }, { quiet: true }).catch(err => toast.error(err.message))}><CheckCheck />{uiText("Mark all read")}</Button>}
        </div>
        <ul className="notif-list">
          {opsAlerts > 0 && <li><button type="button" className="notif-item is-unread" onClick={() => { setOpen(false); onOps(); }}><Inbox aria-hidden="true" /><span className="notif-text"><strong>{uiText("Operations approvals")}</strong><span>{opsAlerts} {plural(opsAlerts, 'request')} {uiText("waiting for you")}</span></span></button></li>}
          {list.slice(0, 12).map(n => {
            const Icon = KIND_ICON[n.kind] || Bell;
            return (
              <li key={n.id}>
                <button type="button" onClick={() => go(n)} className={`notif-item${n.read_at ? '' : " is-unread"}`}>
                  <Icon aria-hidden="true" />
                  <span className="notif-text"><strong>{n.title}</strong><span>{n.body}</span><small>{formatDateTime(n.created_at)}{n.read_at ? '' : uiText(" · new")}</small></span>
                </button>
              </li>
            );
          })}
        </ul>
        {!list.length && !opsAlerts && <p className="notif-empty">{uiText("You’re all caught up. Task updates for you appear here, and in Telegram if you connect it.")}</p>}
      </PopoverContent>
    </Popover>
  );
}

export const TASK_STATUS_OPTIONS = translatedEntries(TASK_STATUS) as [string, string][];
