import {MeetingApprovals} from './meeting-approval-ui';
import {timeRange} from './time-range.mjs';
import {Identity} from './identity-ui';
import { RecurrenceFields } from './recurrence-ui';
import { DayPanel } from './day-preview';
import { OrganizationPage } from './organization-ui';
import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type TouchEvent as ReactTouchEvent, type ReactElement, type ReactNode } from 'react';
import {
  Clock3, AlarmClock, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Bell, BellRing, CalendarClock, CalendarDays, CalendarPlus, Camera, Check, CheckCheck, ChevronLeft, ChevronRight, CircleSlash, ClipboardCheck, ClipboardList, Download, FileText, Hand, Home, Inbox, Link2, ListChecks, Loader2,
  Lock, MessageSquare, NotebookPen, Paperclip, Pencil, PieChart, PlayCircle, Plus, Repeat, RotateCcw, Scale, Search, Send, Settings, ShieldCheck, Trash2, Undo2, UserCheck, UserPlus, UserRoundCog, Users, Video, X, XCircle, type LucideIcon,
} from 'lucide-react';
import {
  enrichedTasks, taskActions, taskStateLabel, waitingFor, dueDecider, REQUEST_STATUS, OPEN_TASK_STATUSES, RECURRENCE, RECURRENCE_SHORT, TASK_FILE_ACCEPT, PREVIEW_TYPES,
  formatMinutes, taskToday, addDays, daysBetween, currentMonth, monthBounds, shiftMonth, MONTHLY_CATEGORIES,
  CHANGE_KIND, CHANGE_STATUS, REMINDER_PRESETS, approvalTarget, editApprovalTarget, assignerOf, assignedByMe, completionApprover, completionPath, reminderDays, reminderText, toReviewOrApprove, twoSided,
  canDecideDue, canManageMeeting, reopenNeedsApproval,
} from './task-domain.mjs';
import { fileToBase64, photoFromFile } from './media';
import { setDisplayZone, zoneName, zonedInput, zonedToIso } from './format';
import { BrandTitle, LogoIcon } from './brand';
import { API_BASE, uuid } from './api-client';
import { PreviewPane, previewKind, type PreviewSource } from './file-preview';

// The Telegram Mini App: a phone-sized screen for Task Management inside Telegram. It talks only to the
// Mini App gateway, which checks Telegram's signed launch data and applies the person's Task Controlling Management permissions.
type Row = Record<string, any>;
declare global { interface Window { Telegram?: { WebApp?: any } } }
const tgApp = () => (typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined);
const COMPANY = /^\/c\/([a-zA-Z0-9_-]+)\/tg/.exec(typeof location === 'undefined' ? '' : location.pathname)?.[1] || 'default';
const API = `${API_BASE}/c/${COMPANY}/tg/api`;
const initData = () => tgApp()?.initData || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';
class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function call(path: string, body?: Row): Promise<Row> {
  const res = await fetch(API + path, { method: body ? 'POST' : 'GET', credentials: API_BASE ? 'include' : 'same-origin', headers: { Authorization: 'tma ' + initData(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data: Row = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong. Please try again.', res.status, data.code);
  return data;
}
const organizationRead = (params: Row) => call('/organization?' + new URLSearchParams(params as Record<string,string>));
const haptic = (kind: 'success' | 'error' | 'warning') => { try { tgApp()?.HapticFeedback?.notificationOccurred(kind); } catch { /* older Telegram versions */ } };
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDay = (d?: string | null) => (d ? DAY.format(new Date(`${d.slice(0, 10)}T12:00:00Z`)) : '—');
// V5.5: times are shown in the person's own time zone (their profile, else the company's, else Cambodia's).
let TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Phnom_Penh' }), TIME_ZONE = 'Asia/Phnom_Penh';
const useZone = (zone?: string) => { if (!zone || zone === TIME_ZONE) return; try { TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone }); TIME_ZONE = zone; } catch { /* keep the previous zone */ } };
const fmtTime = (v?: string | null) => (v ? TIME.format(new Date(v)) : '');
/** The calendar day and the time of a moment, in the person's time zone. */
const dayOf = (iso: string) => zonedInput(iso).slice(0, 10);
const hm = (iso?: string | null) => (iso ? zonedInput(iso).slice(11, 16) : '');
const calToday = () => dayOf(new Date().toISOString());
const relDay = (d: string) => { const n = daysBetween(taskToday(), d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`; };
/** A chosen date in words under a date field ("Wed, 14 Oct · in 7 days"), since phones show date inputs as numbers. */
const dayInWords = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${fmtDay(d)} · ${relDay(d)}` : '');
const first = (name: string) => String(name || '').split(' · ')[0];
const initials = (name: string) => first(name).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
const kb = (bytes: number) => `${Math.max(1, Math.ceil(Number(bytes || 0) / 1024)).toLocaleString('en-US')} KB`;
// Task states and priorities use the Task Controlling Management's sentence-case labels and tones (TASK_STATUS, STATE_TONES, PriorityBadge).
const TONE: Record<string, string> = { 'Awaiting acceptance': 'warning', Accepted: 'info', 'Not started': 'neutral', 'In progress': 'info', 'In review': 'purple', Completed: 'success', Cancelled: 'neutral', Stuck: 'danger', Rejected: 'danger' };
const REQ_TONE: Record<string, string> = { PENDING: 'warning', APPROVED: 'success', DECLINED: 'danger', WITHDRAWN: 'neutral' };
const PRIORITY: Record<string, [string, string]> = { HIGH: ['High priority', 'danger'], MEDIUM: ['Medium priority', 'neutral'], LOW: ['Low priority', 'neutral'] };
/** V5.6.8: how a task is visible to someone who is not on it. Every reason other than 'involved' is viewing only.
 *  [short label for lists, how it reads in "You can see this task through …"] */
const ACCESS: Record<string, [string, string]> = {
  team: ['In your team', 'management oversight'], company: ['Company-wide', 'company-wide access'], organization: ['Organization administration', 'organization administration'],
  owner: ['Workspace owner', 'workspace ownership'], membership: ['Workspace member', 'workspace membership'], governance: ['Workspace governance', 'workspace governance'],
};
const accessNote = (t: Row) => (!t.access_reason || t.access_reason === 'involved' ? undefined : `${ACCESS[t.access_reason]?.[0] || 'Authorized access'} · viewing only`);
/** Joins words as a sentence list: "a", "a and b", "a, b and c". */
const andList = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0] || '');
/** "Please fill in: Reason" without doubled punctuation when the label is a question. */
const fieldName = (label: string) => label.replace(/\s*\(optional\)$/i, '').replace(/[.:]+$/, '');
const alertError = (message: string) => { try { const app = tgApp(); if (typeof app?.showAlert === 'function') { app.showAlert(message); return; } } catch { /* fall back */ } window.alert(message); };

// V5.6.8: the Telegram theme (not the phone's) decides native controls (date and time pickers, checkboxes), and the
// Telegram header and background match the app's own background.
export function syncTelegramTheme() {
  const app = tgApp(), root = document.documentElement;
  root.dataset.tgScheme = app?.colorScheme === 'dark' ? 'dark' : 'light';
  try {
    if (app?.isVersionAtLeast?.('6.1')) { app.setHeaderColor?.('secondary_bg_color'); app.setBackgroundColor?.('secondary_bg_color'); }
    if (app?.isVersionAtLeast?.('7.10')) app.setBottomBarColor?.('secondary_bg_color');
  } catch { /* older Telegram versions */ }
}

// V5.6.8: a half-filled form is never thrown away by Back without asking. Forms and sheets report whether they hold
// changes; Telegram also asks before the whole app is closed while they do.
const unsaved = new Set<symbol>();
const syncClosingConfirmation = () => { try { const app = tgApp(); if (!app?.isVersionAtLeast?.('6.2')) return; if (unsaved.size) app.enableClosingConfirmation?.(); else app.disableClosingConfirmation?.(); } catch { /* not in Telegram */ } };
function useUnsaved(dirty: boolean) {
  const [key] = useState(() => Symbol('form'));
  useEffect(() => { if (dirty) unsaved.add(key); else unsaved.delete(key); syncClosingConfirmation(); }, [dirty, key]);
  useEffect(() => () => { unsaved.delete(key); syncClosingConfirmation(); }, [key]);
  return { saved: () => { unsaved.delete(key); syncClosingConfirmation(); }, again: () => { if (dirty) { unsaved.add(key); syncClosingConfirmation(); } } };
}
/** Asks "Discard your changes?" (Telegram's own dialog when there is one) and runs `discard` if the person agrees. */
function askDiscard(discard: () => void) {
  const app = tgApp();
  try { if (app?.isVersionAtLeast?.('6.2') && typeof app.showConfirm === 'function') { app.showConfirm('Discard your changes?', (ok: boolean) => { if (ok) discard(); }); return; } } catch { /* fall back */ }
  if (window.confirm('Discard your changes?')) discard();
}
/** The JSON of a form's values when it opened; the form holds changes while its values differ. */
function useDirty(value: unknown) {
  const [start] = useState(() => JSON.stringify(value));
  const dirty = JSON.stringify(value) !== start;
  return { dirty, ...useUnsaved(dirty) };
}

// What a list showed last (kept while the app is open), so going back to it from a task lands where the person was.
const scrollMemory = new Map<string, number>();
const listMemory = { q: '' };
const companyMemory: { f: Row; more: boolean } = { f: { q: '', ws: '', person: '', status: 'OPEN', priority: '', from: '', to: '' }, more: false };
const requestMemory = { tab: '' };
const reportMemory: { month: string; scope: 'me' | 'all'; cat: string } = { month: '', scope: 'me', cat: 'in_progress' };
let reportCache: { key: string; data: Row; revision?: string } | null = null;
const ASK_NOTE: Record<string, (c: Ctx, t: Row) => string> = {
  pic: () => 'Take charge? Accept or reject',
  supporter: (c, t) => `Support ${first(c.name(t.pic_id))}? Accept or reject`,
  reviewer: () => 'Review it? Accept or reject',
};

// V5.4 two-party approval: what a change request asks for, field by field.
const changesOf = (cr: Row): Row[] => { try { return JSON.parse(cr.changes_json || '[]'); } catch { return []; } };
const changeTitle = (cr: Row) => cr.kind === 'UPDATE' ? `Change ${changesOf(cr).map(x => String(x.label).toLowerCase()).join(', ') || 'details'}` : CHANGE_KIND[cr.kind as keyof typeof CHANGE_KIND];
const CHANGE_TONE: Record<string, string> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral', CLOSED: 'neutral' };
function Changes({ cr }: { cr: Row }) {
  const list = changesOf(cr);
  if (!list.length) return null;
  return <ul className="change-rows">{list.map(x => <li key={x.field}><span className="label">{x.label}</span><span className="change-vals"><s>{x.from_text}</s><ArrowRight aria-hidden="true" /><strong>{x.to_text}</strong></span></li>)}</ul>;
}
/** Reminder days chosen in a sheet (1, 2, 3 days before, or other days). */
function reminderInput(v: Row): number[] {
  const out: number[] = [1, 2, 3].filter(n => v[`d${n}`]);
  for (const part of String(v.other || '').split(/[,\s]+/).filter(Boolean)) { const n = Number(part); if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('Use whole days from 1 to 90, for example 7 or 5, 10.'); out.push(n); }
  const list = [...new Set(out)].sort((a, b) => b - a); if (list.length > 5) throw new Error('Choose up to five reminders.');
  return list;
}
const reminderFields: Field[] = [{ key: 'd1', label: '1 day before the due date', type: 'checkbox' }, { key: 'd2', label: '2 days before', type: 'checkbox' }, { key: 'd3', label: '3 days before', type: 'checkbox' }, { key: 'other', label: 'Other days before (optional)', type: 'text', placeholder: 'For example 7, or 5, 10', hint: 'Whole days from 1 to 90. Clear everything to turn reminders off.' }];
/** A screen to open from a link: ?task=, ?meeting=, ?note= (or Telegram's start parameter task_…, meeting_…, note_…). */
function linkedView(q: URLSearchParams, start: string): View | null {
  const id = (v: string | null) => (v && /^[A-Z]+-\d+$/.test(v) ? v : '');
  const [kind, value] = /^(task|meeting|note)_(.+)$/.exec(start)?.slice(1) || (start ? ['task', start] : ['', '']);
  const task = id(q.get('task')) || (kind === 'task' ? id(value) : ''), meeting = id(q.get('meeting')) || (kind === 'meeting' ? id(value) : ''), note = id(q.get('note')) || (kind === 'note' ? id(value) : '');
  if (id(q.get('org_request'))) return { kind: 'organization', id: id(q.get('org_request')) };
  return task ? { kind: 'task', id: task } : meeting ? { kind: 'meeting', id: meeting } : note ? { kind: 'note-form', id: note } : null;
}
const reminderStart = (days: unknown): Row => { const l = reminderDays(days as string); return { d1: l.includes(1), d2: l.includes(2), d3: l.includes(3), other: l.filter((n: number) => !REMINDER_PRESETS.includes(n)).join(', ') }; };

type View = {kind:'timesheets'} | { kind: 'organization'; id?: string } | { kind: 'task'; id: string } | { kind: 'task-form'; id?: string } | { kind: 'request'; id: string } | { kind: 'request-form'; id?: string } | { kind: 'settings' }
  | { kind: 'meeting'; id: string } | { kind: 'meeting-form'; id?: string; day?: string } | { kind: 'note-form'; id?: string; day?: string };
type Tab = 'home' | 'tasks' | 'calendar' | 'requests' | 'reports' | 'alerts';
type Person = { id: string; name: string; detail?: string; note?: string; you?: boolean };
type Field = { key: string; label: string; type?: 'text' | 'textarea' | 'date' | 'progress' | 'select' | 'person' | 'checkbox' | 'offsets'; required?: boolean; options?: [string, string][]; people?: Person[]; min?: string; hint?: string; placeholder?: string; start?: string };
// secondary: a second, destructive action under the form; `next` replaces the sheet with a confirmation first.
type SheetSpec = { title: string; description?: ReactNode; fields: Field[]; confirm: string; dismiss?: string; tone?: 'danger'; initial?: Row; run: (v: Row) => Promise<unknown>; secondary?: { label: string; run?: () => Promise<unknown>; next?: SheetSpec } };
type Ctx = {
  data: Row; me: string; tasks: Row[]; name: (id?: string | null) => string; photo: (id?: string | null) => string | undefined; can: (r: string, a?: string) => boolean; approver: boolean;
  /** A person's first name, or "You" / "you" for the person using the app. */
  who: (id?: string | null, lower?: boolean) => string;
  perform: (action: string, data: Row, options?: { quiet?: boolean }) => Promise<Row>; open: (v: View) => void; back: () => void; sheet: (s: SheetSpec) => void; setTab: (t: Tab) => void; showTasks: (scope: string) => void;
  fileUrl: (f: Row, inline?: boolean) => string; previewUrl: (f: Row) => string; viewFile: (f: Row) => void; download: (f: Row) => void;
};

// Open layers (sheets, people pickers, the photo viewer) close first when Telegram's Back button or Escape is used,
// so going back never throws away a half-filled form.
const layers: { close: () => void }[] = [];
const layerListeners = new Set<() => void>();
const layersChanged = () => layerListeners.forEach(f => f());
function useLayer(close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    const entry = { close: () => ref.current() };
    layers.push(entry); layersChanged();
    return () => { const i = layers.indexOf(entry); if (i >= 0) layers.splice(i, 1); layersChanged(); };
  }, []);
}
function useLayerCount() {
  const [n, setN] = useState(layers.length);
  useEffect(() => { const f = () => setN(layers.length); layerListeners.add(f); f(); return () => { layerListeners.delete(f); }; }, []);
  return n;
}

/** Everyone who can be given work or asked for a task (whatever their role), with department and position. */
function peopleList(c: Ctx, { include = [], exclude = [] }: { include?: (string | null | undefined)[]; exclude?: (string | null | undefined)[] } = {}): Person[] {
  const byId = new Map<string, Person>();
  for (const p of c.data.tm_people || []) byId.set(p.staff_id, { id: p.staff_id, name: p.name, detail: [p.department, p.position].filter(Boolean).join(' · ') || undefined, note: p.signed_in ? undefined : 'Not signed in yet', you: p.staff_id === c.me });
  for (const id of include) if (id && !byId.has(id)) byId.set(id, { id, name: c.name(id), note: 'Can’t be chosen now', you: id === c.me });
  return [...byId.values()].filter(p => !exclude.includes(p.id)).sort((a, b) => Number(!!b.you) - Number(!!a.you) || a.name.localeCompare(b.name));
}

/** V5.6.8: everything waiting for this person, as one number everywhere (the Home badge, the greeting and "Waiting for
 *  you"): tasks to accept or reject, work to review, changes to approve, task requests, due date requests they may decide
 *  (the server's rule: canDecideDue) and organization requests waiting for their decision. */
function waitingAll(c: Ctx) {
  const w = waitingFor(c.data, c.me, c.tasks);
  const due: Row[] = (c.data.tm_due_requests || []).filter((q: Row) => { const t = c.tasks.find(x => x.id === q.task_id); return !!t && canDecideDue(t, q, c.me, { canApprove: c.approver, involved: t.access_reason === 'involved' }); });
  const org = c.can('tasks.organization') ? Math.max(0, Number(c.data.organization?.pending) || 0) : 0;
  return { ...w, due, org, total: w.answer.length + w.review.length + w.approvals.length + w.requests.length + due.length + org };
}

/** Organizational Structure inside the Mini App. The page has its own heading, so the back bar carries no title. An
 *  empty request id opens its Approvals (from Home); a request id opens that request (Telegram messages, alerts). */
function OrganizationView({ c, requestId }: { c: Ctx; requestId?: string }) {
  const allowed = c.can('tasks.organization');
  useEffect(() => {
    // Until OrganizationPage opens Approvals for an empty request id itself, choose that tab once it is shown.
    if (requestId !== '' || !allowed) return;
    const tab = [...document.querySelectorAll<HTMLButtonElement>('.org-page.org-mini .org-tabs button')].find(b => /^Approvals/.test(b.textContent || ''));
    if (tab && tab.getAttribute('aria-current') !== 'page') tab.click();
  }, [requestId, allowed]);
  if (!allowed) return <><BackBar c={c} title="Organizational Structure" /><div className="callout" role="alert">Your account does not have permission to view Organizational Structure. Ask an administrator if you need access.</div></>;
  return <><BackBar c={c} /><OrganizationPage onOpenTask={id => c.open({ kind: 'task', id })} mini data={c.data} actor={c.me} read={organizationRead} perform={c.perform} requestId={requestId} /></>;
}

// ------------------------------------------------------------------ app shell
export function MiniApp() {
  const [data, setData] = useState<Row | null>(null), [status, setStatus] = useState<{ kind: string; message?: string }>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('home'), [stack, setStack] = useState<View[]>([]), [scope, setScope] = useState('mine'), [area, setArea] = useState<'mine' | 'company'>('mine');
  const [toast, setToast] = useState<{ text: string; tone: string; id: number } | null>(null), [sheet, setSheet] = useState<{ spec: SheetSpec; key: number } | null>(null), [viewer, setViewer] = useState<Row | null>(null);
  const sheetSeq = useRef(0);
  // Opened from a message: ?task=, ?meeting= or ?note= (bot buttons), or the start parameter task_…, meeting_…, note_….
  const deepLink = useRef<View | null>(linkedView(new URLSearchParams(location.search), tgApp()?.initDataUnsafe?.start_param || ''));
  const show = useCallback((text: string, tone = 'success') => { setToast({ text, tone, id: Date.now() }); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);
  // quiet: keep the current screen if loading fails; background: also stay silent about passing network errors.
  const seenChange = useRef<number | null>(null);
  const load = useCallback(async (quiet = false, background = false) => {
    if (!initData()) { setStatus({ kind: 'auth' }); return; }
    try { const s = await call('/state'); seenChange.current = s.change_seq ?? null; useZone(s.my_timezone); setDisplayZone(s.my_timezone); setData(s); setStatus({ kind: 'ready' }); }
    catch (e) { const err = e as ApiError; if (!quiet || err.status === 403 || err.status === 401) setStatus({ kind: err.code || (err.status === 401 ? 'auth' : 'error'), message: err.message }); else if (!background) show(err.message, 'danger'); }
  }, [show]);
  useEffect(() => { const w = tgApp(); try { w?.ready(); w?.expand(); } catch { /* not in Telegram */ } void load(); }, [load]);
  // V5.6.8: follow Telegram's light or dark theme, also when the person switches it while the app is open.
  useEffect(() => {
    const w = tgApp(); syncTelegramTheme();
    try { w?.onEvent?.('themeChanged', syncTelegramTheme); } catch { /* older Telegram versions */ }
    return () => { try { w?.offEvent?.('themeChanged', syncTelegramTheme); } catch { /* ignore */ } };
  }, []);
  // Keep the data fresh when the person returns to the app, and check every 4 seconds while it is open whether
  // anything was saved in the Task Controlling Management or by colleagues; reload quietly if so. Not while a form or sheet is open or
  // someone is typing.
  const editing = useRef(false);
  // V5.5.1: not while a form or sheet is open (its values stay what the person started from; a save then reports a
  // change made meanwhile instead of overwriting it).
  useEffect(() => { const onVisible = () => { if (document.visibilityState === 'visible' && !editing.current && !document.querySelector('.org-dialog[open]')) void load(true); }; document.addEventListener('visibilitychange', onVisible); return () => document.removeEventListener('visibilitychange', onVisible); }, [load]);
  const layerCount = useLayerCount();
  useEffect(() => { editing.current = !!sheet || layerCount > 0 || /-form$/.test(stack[stack.length - 1]?.kind || ''); });
  useEffect(() => {
    let checking = false;
    const timer = window.setInterval(async () => {
      const a = document.activeElement;
      if (checking || !seenChange.current || document.visibilityState !== 'visible' || editing.current || document.querySelector('.org-dialog[open]') || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && (a as HTMLInputElement).type !== 'search')) return;
      checking = true;
      try { const r = await call('/changes'); if (r.seq !== seenChange.current && !editing.current) await load(true, true); }
      catch (e) { if ([401, 403].includes((e as ApiError).status)) void load(true); }
      finally { checking = false; }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [load]);
  // A meeting or a note opens over the Calendar; a task or an organization request over Home (V5.6.8).
  useEffect(() => { if (status.kind === 'ready' && deepLink.current) { const v = deepLink.current; deepLink.current = null; if (v.kind === 'meeting' || v.kind === 'note-form') setTab('calendar'); setStack([v]); } }, [status.kind]);
  // Going back from a form that holds changes asks first (V5.6.8); an open Organization dialog closes (or asks) first.
  const leave = useCallback(() => {
    const pop = () => setStack(s => s.slice(0, -1));
    if (unsaved.size) askDiscard(() => { unsaved.clear(); syncClosingConfirmation(); pop(); }); else pop();
  }, []);
  const back = useCallback(() => { const dialog = document.querySelector<HTMLDialogElement>('.org-dialog[open]'); if (dialog) { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); return; } leave(); }, [leave]);
  const onBack = useCallback(() => { const dialog = document.querySelector<HTMLDialogElement>('.org-dialog[open]'); if (dialog) { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); return; } const top = layers[layers.length - 1]; if (top) top.close(); else leave(); }, [leave]);
  useEffect(() => {
    const b = tgApp()?.BackButton; if (!b) return;
    try { if (stack.length || layerCount) { b.show(); b.onClick(onBack); } else b.hide(); } catch { /* ignore */ }
    return () => { try { b.offClick(onBack); } catch { /* ignore */ } };
  }, [stack.length, layerCount, onBack]);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && layers.length) { e.preventDefault(); layers[layers.length - 1].close(); } }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, []);
  // V5.6.8: a new screen starts at the top; going back lands where the person was on the screen below (a list, the
  // Organization page).
  const top = stack[stack.length - 1] as Row | undefined, screenKey = top ? `${stack.length}:${top.kind}:${top.id ?? ''}` : `tab:${tab}`;
  const shownKey = useRef(screenKey), depth = useRef(stack.length);
  useEffect(() => { const onScroll = () => scrollMemory.set(shownKey.current, window.scrollY); window.addEventListener('scroll', onScroll, { passive: true }); return () => window.removeEventListener('scroll', onScroll); }, []);
  useLayoutEffect(() => {
    const wentBack = stack.length < depth.current; depth.current = stack.length; shownKey.current = screenKey;
    window.scrollTo({ top: wentBack ? scrollMemory.get(screenKey) ?? 0 : 0 });
  }, [screenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const perform = useCallback(async (action: string, payload: Row, options: { quiet?: boolean } = {}) => {
    try { const r = await call('/command', { action, data: payload }); haptic('success'); if (!options.quiet) show(r.result?.message || 'Saved'); await load(true); return r.result || {}; }
    // V5.6.8: someone changed it meanwhile (409): the screen reloads, and the server's message is shown by the caller.
    catch (e) { haptic('error'); if ((e as ApiError).status === 409) void load(true, true); throw e; }
  }, [load, show]);
  const tasks = useMemo(() => (data ? enrichedTasks(data) : []), [data]);
  // The same media token is kept while it is valid for more than an hour, so photo addresses (and the browser cache) stay stable.
  const media = useRef('');
  if (data?.media_token && (!media.current || Number(media.current.split('.')[0]) * 1000 - Date.now() < 3600000)) media.current = data.media_token;
  if (status.kind !== 'ready' || !data) return <StatusScreen status={status} onRetry={() => { setStatus({ kind: 'loading' }); void load(); }} onLinked={() => { setStatus({ kind: 'loading' }); void load(); }} />;
  const me = data.auth.user.staff_id, perms = data.auth.permissions || {};
  const can = (r: string, a = 'view') => (perms[r] || []).includes(a);
  const names = new Map<string, string>((data.lookups || []).map((l: Row) => [l.id, l.name]));
  const photos = new Map<string, number>((data.staff_photos || []).map((p: Row) => [p.staff_id, p.version]));
  const token = encodeURIComponent(media.current);
  const fileUrl = (f: Row, inline = false) => `${API}/file?id=${encodeURIComponent(f.id)}${inline ? '&inline=1' : ''}&t=${token}`;
  const download = (f: Row) => {
    const url = new URL(fileUrl(f), location.href).href, app = tgApp();
    try {
      if (app?.isVersionAtLeast?.('8.0') && typeof app.downloadFile === 'function') { app.downloadFile({ url, file_name: f.name }); return; }
      if (typeof app?.openLink === 'function') { app.openLink(url); return; }
    } catch { /* fall back to a new window */ }
    window.open(url, '_blank', 'noopener');
  };
  const name = (id?: string | null) => (id ? names.get(id) || id : '—');
  const c: Ctx = {
    data, me, tasks, can, approver: can('tasks.tasks', 'approve'), name, perform,
    who: (id, lower = false) => (id && id === me ? (lower ? 'you' : 'You') : first(name(id))),
    photo: id => (id && token && photos.has(id) ? `${API}/photo?staff=${encodeURIComponent(id)}&v=${photos.get(id)}&t=${token}` : undefined),
    open: v => setStack(s => [...s, v]), back, sheet: s => setSheet({ spec: s, key: ++sheetSeq.current }), setTab: t => { setStack([]); setTab(t); }, showTasks: sc => { setScope(sc); setArea('mine'); setStack([]); setTab('tasks'); },
    fileUrl, previewUrl: f => `${API}/file-preview?id=${encodeURIComponent(f.id)}&t=${token}`, download,
    // Images, PDFs and Word, Excel, PowerPoint, CSV and text files open in the in-app preview; anything else downloads.
    viewFile: f => (previewKind(f.mime) !== 'none' ? setViewer(f) : download(f)),
  };
  const view = stack[stack.length - 1];
  const unread = (data.tm_notifications || []).filter((n: Row) => !n.read_at).length;
  const waiting = waitingAll(c);
  // The Organization page stays open (hidden) under a task opened from it, so going back keeps its tab and filters.
  const orgAt = stack.map(v => v.kind).lastIndexOf('organization'), orgView = orgAt >= 0 ? stack[orgAt] as { kind: 'organization'; id?: string } : null;
  return (
    <div className={`app${view ? ' has-stack' : ''}`}>
      {orgView && <main className="screen" hidden={view !== orgView} key={`org:${orgAt}:${orgView.id ?? '-'}`}><OrganizationView c={c} requestId={orgView.id} /></main>}
      {view !== orgView && <main className="screen" key={view ? `${view.kind}:${'id' in view ? view.id : ''}:${stack.length}` : tab}>
        {view?.kind === 'task' ? <TaskView c={c} id={view.id} />
          : view?.kind === 'task-form' ? <TaskForm c={c} id={view.id} />
            : view?.kind === 'request' ? <RequestView c={c} id={view.id} />
              : view?.kind === 'request-form' ? <RequestForm c={c} id={view.id} />
                : view?.kind === 'timesheets' ? <MiniTimesheets c={c}/> : view?.kind === 'settings' ? <SettingsView c={c} onUnlinked={() => { setStack([]); setStatus({ kind: 'not_linked' }); }} />
                  : view?.kind === 'meeting' ? <MeetingView c={c} id={view.id} />
                  : view?.kind === 'meeting-form' ? <MeetingForm c={c} id={view.id} day={view.day} />
                  : view?.kind === 'note-form' ? <NoteForm c={c} id={view.id} day={view.day} />
                  : tab === 'home' ? <HomeView c={c} />
                    : tab === 'tasks' ? (area === 'company' ? <CompanyTasks c={c} area={area} setArea={setArea} /> : <TaskList c={c} scope={scope} setScope={setScope} area={area} setArea={setArea} />)
                      : tab === 'calendar' ? <CalendarView c={c} />
                      : tab === 'requests' ? <RequestList c={c} />
                        : tab === 'reports' ? <ReportView c={c} />
                          : <AlertsView c={c} />}
      </main>}
      {!view && (
        <nav className="tabbar" aria-label="Main">
          {([['home', 'Home', Home], ['tasks', 'Tasks', ListChecks], ['calendar', 'Calendar', CalendarDays], ['requests', 'Requests', Inbox], ['reports', 'Reports', PieChart], ['alerts', 'Alerts', Bell]] as [Tab, string, LucideIcon][]).map(([id, label, Icon]) => {
            // V5.6.8: Home shows the same number as its "Waiting for you" list.
            const n = id === 'alerts' ? unread : id === 'requests' ? waiting.requests.length : id === 'home' ? waiting.total : 0;
            return (
              <button key={id} type="button" className="tab" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}
                aria-label={n ? `${label}, ${n} ${id === 'alerts' ? 'unread' : 'waiting for you'}` : undefined}>
                <span className="tab-icon" aria-hidden="true"><Icon />{n > 0 && <span className="dot-count">{n > 9 ? '9+' : n}</span>}</span>
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      )}
      {sheet && <Sheet key={sheet.key} c={c} spec={sheet.spec} onClose={() => setSheet(null)} />}
      {viewer && <Viewer c={c} file={viewer} onClose={() => setViewer(null)} />}
      <div className="toast-region" aria-live="polite">{toast && <div key={toast.id} className={`toast tone-${toast.tone}`}>{toast.tone === 'danger' ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{toast.text}</span></div>}</div>
    </div>
  );
}

function StatusScreen({ status, onRetry, onLinked }: { status: { kind: string; message?: string }; onRetry: () => void; onLinked: () => void }) {
  if (status.kind === 'loading') return <div className="center-screen" role="status"><Loader2 className="spin" aria-hidden="true" /><p>Loading your tasks…</p></div>;
  if (status.kind === 'not_linked') return <LinkScreen onLinked={onLinked} />;
  const text: Record<string, [string, string]> = {
    auth: ['Open this app from Telegram', 'This page works inside Telegram. Open it from the company bot: tap the Tasks button next to the message box.'],
    expired: ['Open the app again', 'For your security this session has ended. Close the app and open it again from the company bot.'],
    disabled: ['Your Task Controlling Management account is disabled', 'Ask an administrator to re-activate your login.'],
    no_access: ['No access to Task Management', 'Your Task Controlling Management role does not include Task Management. Ask an administrator.'],
    off: ['Telegram is turned off', 'An administrator has turned off Telegram for this company.'],
  };
  const [title, body] = text[status.kind] || ['Something went wrong', status.message || 'Please try again.'];
  return <div className="center-screen"><div className="empty-icon"><AlertTriangle aria-hidden="true" /></div><h1>{title}</h1><p className="hint">{body}</p>{!['auth', 'off', 'expired'].includes(status.kind) && <button type="button" className="btn primary" onClick={onRetry}>Try again</button>}</div>;
}

/** Connecting Telegram: sign in once with the username and password, or use the personal code from the Task Controlling Management. Neither expires. */
function LinkScreen({ onLinked }: { onLinked: () => void }) {
  const [mode, setMode] = useState<'login' | 'code'>('login');
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (e: FormEvent, fn: () => Promise<unknown>) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await fn(); haptic('success'); onLinked(); } catch (err) { haptic('error'); setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="screen link-screen">
      <div className="empty-icon"><Link2 aria-hidden="true" /></div>
      <h1>Connect your Task Controlling Management account</h1>
      <p className="hint center">Do this once. Telegram then opens your tasks straight away, with your own Task Controlling Management permissions.</p>
      <Chips label="How to connect" value={mode} onChange={m => { setMode(m); setError(''); }} options={[['login', 'Sign in with Task Controlling Management password'], ['code', 'Use my code']]} />
      {mode === 'login' ? (
        <form onSubmit={e => void run(e, () => call('/login', { username: email, password }))} className="stack" noValidate>
          <LField label="Username"><input className="input" type="text" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" inputMode="text" autoCapitalize="none" spellCheck={false} /></LField>
          <LField label="Task Controlling Management password"><input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></LField>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn primary block" disabled={busy || !email.trim() || !password}>{busy ? 'Signing in…' : 'Sign in and connect'}</button>
          <p className="hint small">Forgot your password? Ask an administrator to reset it in the Task Controlling Management.</p>
        </form>
      ) : (
        <form onSubmit={e => void run(e, () => call('/link', { code }))} className="stack" noValidate>
          <ol className="steps">
            <li>In the Task Controlling Management, click your name (top right) and choose <strong>Connect Telegram</strong>.</li>
            <li>Open the link there, scan its QR code with your phone, or type the code shown after <strong>/link</strong>.</li>
          </ol>
          <LField label="Code"><input className="input code-input" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={10} autoComplete="one-time-code" autoCapitalize="characters" placeholder="8 letters or numbers" aria-invalid={!!error || undefined} /></LField>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn primary block" disabled={busy || code.replace(/[^A-Z0-9]/gi, '').length !== 8}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p className="hint small">Your code does not expire. It works once; you can create a new one in the Task Controlling Management at any time.</p>
        </form>
      )}
    </main>
  );
}

// ------------------------------------------------------------------ small building blocks
/** A form field whose label points at the control (so the control's name is just the label) and whose hint is linked. */
function LField({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  const id = useId(), hintId = `${id}-hint`;
  const [control, ...rest] = Children.toArray(children);
  const hasHint = rest.some(r => isValidElement(r) && String((r.props as Row).className || '').includes('hint'));
  return (
    <div className="field">
      <label htmlFor={id} className="label">{label}{required && <span className="req" aria-hidden="true"> *</span>}</label>
      {isValidElement(control) ? cloneElement(control as ReactElement<Row>, { id, 'aria-describedby': hasHint ? hintId : undefined }) : control}
      {rest.map(r => (isValidElement(r) && String((r.props as Row).className || '').includes('hint') ? cloneElement(r as ReactElement<Row>, { id: hintId }) : r))}
    </div>
  );
}
function Badge({ label, tone = 'neutral' }: { label: string; tone?: string }) { return <span className={`badge tone-${tone}`}>{label}</span>; }
function StateBadge({ t }: { t: Row }) { const l = taskStateLabel(t); return <Badge label={l} tone={TONE[l]} />; }
/** Priority as in the Task Controlling Management: High stands out in red; Medium and Low are neutral. */
function PriorityBadge({ p }: { p: string }) { const [label, tone] = PRIORITY[p] || [`${String(p || '').charAt(0)}${String(p || '').slice(1).toLowerCase()} priority`, 'neutral']; return <Badge label={label} tone={tone} />; }
/** A person's photo, or their initials when there is none (or it cannot be loaded). */
function Avatar({ name, src, size }: { name: string; src?: string; size?: 'sm' | 'lg' | 'xl' }) {
  const [failed, setFailed] = useState('');
  const cls = `avatar${size ? ` avatar-${size}` : ''}`;
  if (src && failed !== src) return <span className={`${cls} has-photo`} aria-hidden="true"><img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} /></span>;
  return <span className={cls} aria-hidden="true">{initials(name)}</span>;
}
function Progress({ value, label }: { value: number; label: string }) { return <span className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>; }
function Section({ title, children, action, count }: { title: string; children: ReactNode; action?: ReactNode; count?: number }) {
  return <section className="section"><div className="section-head"><h2>{title}{count !== undefined && <span className="count">{count}</span>}</h2>{action}</div>{children}</section>;
}
function Empty({ icon: Icon = ClipboardList, title, text, action }: { icon?: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon aria-hidden="true" /></div><p className="empty-title">{title}</p>{text && <p className="hint">{text}</p>}{action}</div>;
}
function Extras({ t }: { t: Row }) {
  if (!t.recurrence && !t.check_total && !t.file_count) return null;
  return (
    <span className="extras">
      {t.recurrence && <span className="extra"><Repeat aria-hidden="true" /><span className="sr-only">Repeats {RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT]}</span></span>}
      {t.check_total > 0 && <span className="extra"><ListChecks aria-hidden="true" />{t.check_done}/{t.check_total}<span className="sr-only"> checklist items done</span></span>}
      {t.file_count > 0 && <span className="extra"><Paperclip aria-hidden="true" />{t.file_count}<span className="sr-only"> {t.file_count === 1 ? 'file' : 'files'}</span></span>}
    </span>
  );
}
/** A task in a list. `named`: people the note already names, so the person in charge is not repeated after it. */
function TaskRow({ c, t, note, named = [] }: { c: Ctx; t: Row; note?: string; named?: (string | null | undefined)[] }) {
  const pic = named.includes(t.pic_id) ? '' : `${c.who(t.pic_id)}${t.supporters.length ? ` +${t.supporters.length}` : ''}`;
  return (
    <button type="button" className="list-row" onClick={() => c.open({ kind: 'task', id: t.id })}>
      <span className={`state-dot tone-${TONE[taskStateLabel(t)] || 'neutral'}`} aria-hidden="true" />
      <span className="row-main">
        <span className="row-title">{t.title}</span>
        <span className="row-meta">{[note, pic].filter(Boolean).map(x => `${x} · `).join('')}<span className={t.overdue ? 'danger' : undefined}>due {fmtDay(t.due_date)}{t.overdue ? ' (overdue)' : ''}</span></span>
        <span className="row-foot"><StateBadge t={t} /><Progress value={t.progress} label={`${t.title}: ${t.progress}% complete`} /><span className="pct">{t.progress}%</span><Extras t={t} /></span>
      </span>
      <ChevronRight className="chev" aria-hidden="true" />
    </button>
  );
}
/** A row of chips that scrolls sideways on a phone (V5.6.8): a fade shows that more choices are off-screen, and the
 *  chosen one is scrolled into view, also when a Home tile opens the Tasks list on it. `chosen` re-runs that. */
function ChipRow({ label, chosen, children }: { label: string; chosen?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), shown = useRef(false);
  const edges = useCallback(() => {
    const el = ref.current; if (!el) return;
    const max = el.scrollWidth - el.clientWidth, more = max <= 1 ? '' : el.scrollLeft <= 1 ? 'end' : el.scrollLeft >= max - 1 ? 'start' : 'both';
    if (el.dataset.more !== more) el.dataset.more = more;
  }, []);
  useLayoutEffect(() => {
    const el = ref.current, on = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el && on) {
      const box = el.getBoundingClientRect(), r = on.getBoundingClientRect(), pad = 28;
      const dx = r.left < box.left + pad ? r.left - box.left - pad : r.right > box.right - pad ? r.right - box.right + pad : 0;
      if (dx) el.scrollTo({ left: el.scrollLeft + dx, behavior: shown.current && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    }
    shown.current = true; edges();
  }, [chosen, edges]);
  useEffect(() => { const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return; const ro = new ResizeObserver(edges); ro.observe(el); return () => ro.disconnect(); }, [edges]);
  return <div ref={ref} className="chips" role="group" aria-label={label} onScroll={edges}>{children}</div>;
}
function Chips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string, number?][]; label: string }) {
  return <ChipRow label={label} chosen={value}>{options.map(([id, text, n]) => <button key={id} type="button" className="chip" aria-pressed={value === id} onClick={() => onChange(id)}>{text}{n !== undefined && <span className="chip-count">{n}</span>}</button>)}</ChipRow>;
}
function Header({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return <header className="page-head"><div><h1>{title}</h1>{subtitle && <p className="hint">{subtitle}</p>}</div>{action}</header>;
}
function BackBar({ c, title }: { c: Ctx; title?: string }) {
  // Telegram shows its own Back button; this one is for previews outside Telegram and for clarity.
  return <div className="backbar"><button type="button" className="icon-btn" onClick={c.back} aria-label="Back"><ChevronLeft aria-hidden="true" /></button>{title && <span className="backbar-title">{title}</span>}</div>;
}

// ------------------------------------------------------------------ choosing people (with photos)
/** Full-screen list of people with photos and a search box. One person (tap to choose) or several (tick, then Done). */
function PeoplePicker({ c, title, people, selected, multi, onPick, onClose, empty }: { c: Ctx; title: string; people: Person[]; selected: string[]; multi?: boolean; onPick: (ids: string[]) => void; onClose: () => void; empty?: string }) {
  const [q, setQ] = useState(''), [sel, setSel] = useState<string[]>(selected), titleId = useId();
  useLayer(onClose);
  const needle = q.trim().toLowerCase(), shown = needle ? people.filter(p => `${p.name} ${p.detail || ''}`.toLowerCase().includes(needle)) : people;
  return (
    <div className="picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="picker-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X aria-hidden="true" /></button>
        <h2 id={titleId}>{title}</h2>
        {multi ? <button type="button" className="btn small primary" onClick={() => onPick(sel)}>Done</button> : <span className="picker-spacer" aria-hidden="true" />}
      </div>
      {people.length > 6 && <label className="picker-search"><Search aria-hidden="true" /><span className="sr-only">Search people</span><input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or department" autoComplete="off" /></label>}
      {shown.length ? (
        <ul className="picker-list">
          {shown.map(p => {
            const on = sel.includes(p.id);
            return (
              <li key={p.id}>
                <button type="button" className="picker-row" aria-pressed={multi ? on : undefined} aria-current={!multi && on ? 'true' : undefined}
                  onClick={() => (multi ? setSel(s => (on ? s.filter(x => x !== p.id) : [...s, p.id])) : onPick([p.id]))}>
                  <Avatar name={p.name} src={c.photo(p.id)} />
                  <span className="row-main"><span className="row-title">{p.name}{p.you ? ' (you)' : ''}</span>{(p.detail || p.note) && <span className="row-meta">{[p.detail, p.note].filter(Boolean).join(' · ')}</span>}</span>
                  {on ? <span className="picker-check"><Check aria-hidden="true" /></span> : multi ? <span className="picker-box" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : <Empty icon={Users} title={people.length ? 'Nobody matches your search' : empty ? 'Nobody to choose here yet' : 'Nobody can be chosen yet'} text={people.length ? undefined : empty || 'Ask an administrator to create Task Controlling Management logins for your colleagues.'} />}
      {multi && <p className="hint small picker-foot" aria-live="polite">{sel.length} selected</p>}
    </div>
  );
}
/** One person: shows their photo and name; tapping opens the people list. */
function PersonSelect({ c, label, value, onChange, people, required, hint, disabled, placeholder = 'Choose a person', invalid, field, empty }: { c: Ctx; label: string; value?: string | null; onChange: (id: string) => void; people: Person[]; required?: boolean; hint?: ReactNode; disabled?: boolean; placeholder?: string; invalid?: boolean; field?: string; empty?: string }) {
  const [open, setOpen] = useState(false), id = useId();
  const cur: Person | null = value ? people.find(p => p.id === value) || { id: value, name: c.name(value) } : null;
  return (
    <div className="field">
      <span className="label" id={`${id}-l`}>{label}{required && <span className="req" aria-hidden="true"> *</span>}</span>
      <button type="button" className="input person-select" disabled={disabled} aria-haspopup="dialog" aria-labelledby={`${id}-l ${id}-v`} aria-describedby={hint ? `${id}-h` : undefined} aria-invalid={invalid || undefined} data-field={field} onClick={() => setOpen(true)}>
        {cur ? <Avatar name={cur.name} src={c.photo(cur.id)} size="sm" /> : <UserPlus className="person-select-icon" aria-hidden="true" />}
        <span className="person-select-text" id={`${id}-v`}>
          {cur ? <><span className="person-select-name">{cur.name}{cur.you ? ' (you)' : ''}</span>{cur.detail && <span className="hint small">{cur.detail}</span>}</> : <span className="placeholder">{placeholder}{required && <span className="sr-only"> (required)</span>}</span>}
        </span>
        {!disabled && <ChevronRight className="chev" aria-hidden="true" />}
      </button>
      {hint && <span className="hint small" id={`${id}-h`}>{hint}</span>}
      {open && <PeoplePicker c={c} title={label} people={people} selected={value ? [value] : []} empty={empty} onPick={ids => { onChange(ids[0]); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}
/** Several people as chips with photos; "Add people" opens the list with ticks. */
function PeopleSelect({ c, label, value, onChange, people, hint, disabled, note, empty }: { c: Ctx; label: string; value: string[]; onChange: (ids: string[]) => void; people: Person[]; hint?: ReactNode; disabled?: boolean; note?: (id: string) => ReactNode; empty?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="field" disabled={disabled}>
      <legend className="label">{label}</legend>
      {value.length > 0 && (
        <ul className="people-chips">
          {value.map(id => {
            const n = people.find(x => x.id === id)?.name || c.name(id);
            return (
              <li key={id} className="person-chip">
                <Avatar name={n} src={c.photo(id)} size="sm" />
                <span className="person-chip-text"><span>{n}{id === c.me ? ' (you)' : ''}</span>{note?.(id)}</span>
                {!disabled && <button type="button" className="chip-x" aria-label={`Remove ${n}`} onClick={() => onChange(value.filter(x => x !== id))}><X aria-hidden="true" /></button>}
              </li>
            );
          })}
        </ul>
      )}
      {!disabled && <button type="button" className="btn small" onClick={() => setOpen(true)}><UserPlus aria-hidden="true" />{value.length ? 'Add or remove people' : 'Add people'}</button>}
      {hint && <span className="hint small">{hint}</span>}
      {open && <PeoplePicker c={c} title={label} multi people={people} selected={value} empty={empty} onPick={ids => { onChange(ids); setOpen(false); }} onClose={() => setOpen(false)} />}
    </fieldset>
  );
}
/** V5.6.8: what to say when a person list is limited to a workspace's members. */
const membersOnly = (workspace: string, canInviteOutside: boolean, what: 'task' | 'meeting') => canInviteOutside
  ? `Only members of ${workspace} are listed. Turn on “Select outside workspace” to invite someone for this ${what} only.`
  : `Only members of ${workspace} can be chosen. Ask its owner to add people to the workspace.`;
/** Moves to the first field that needs an answer (V5.6.8: the field is also marked, and scrolled into view). */
function focusField(root: Element | null | undefined, key: string) {
  const el = root?.querySelector<HTMLElement>(`[data-field="${key}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
/** "Fill in the title and the due date, and choose the reviewer." for the fields still missing. */
function missingText(fill: string[], choose: string[]) {
  const parts = [fill.length ? `fill in ${andList(fill)}` : '', choose.length ? `choose ${andList(choose)}` : ''].filter(Boolean).join(fill.length > 1 && choose.length ? ', and ' : ' and ');
  return parts ? `${parts.charAt(0).toUpperCase()}${parts.slice(1)}.` : '';
}
/** The save button of a long form, kept in reach at the bottom of the screen, with the form's message above it. */
function FormFoot({ error, children }: { error?: string; children: ReactNode }) {
  return <div className="form-foot">{error && <p className="error" role="alert">{error}</p>}{children}</div>;
}

// ------------------------------------------------------------------ sheets and the photo viewer
function Sheet({ c, spec, onClose }: { c: Ctx; spec: SheetSpec; onClose: () => void }) {
  const [v, setV] = useState<Row>(spec.initial || {}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState('');
  const ref = useRef<HTMLDivElement>(null), titleId = useId(), busyRef = useRef(false);
  busyRef.current = busy;
  const { dirty, saved, again } = useDirty(v);
  // Back, Escape or a tap beside the sheet close it; when something was typed or chosen, they ask first (V5.6.8).
  const dismiss = () => { if (busyRef.current) return; if (dirty) askDiscard(() => { saved(); onClose(); }); else onClose(); };
  useLayer(dismiss);
  useEffect(() => {
    // V5.6.8: on a phone the keyboard does not pop up for an optional note; focus moves to the sheet itself. With a
    // keyboard and mouse, to its first required text field.
    const field = matchMedia('(pointer: coarse)').matches ? null : ref.current?.querySelector<HTMLElement>('textarea[aria-required="true"], input[aria-required="true"]:not([type=checkbox]):not([type=radio])');
    (field || ref.current)?.focus({ preventScroll: true });
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = spec.fields.find(f => f.required && (v[f.key] === undefined || v[f.key] === null || String(v[f.key]).trim() === ''));
    if (missing) {
      const what = fieldName(missing.label);
      setInvalid(missing.key); setError(`${missing.type === 'person' || missing.type === 'select' ? 'Please choose' : 'Please fill in'}: ${what}${/[?!]$/.test(what) ? '' : '.'}`);
      focusField(ref.current, missing.key); return;
    }
    // Saving may go back a screen (for example after accepting a request), which must not ask about this sheet.
    setBusy(true); setError(''); saved();
    try { await spec.run(v); onClose(); }
    catch (err) {
      // V5.6.8: someone changed it meanwhile; the screen behind now shows the latest version, so the sheet closes.
      if ((err as ApiError).status === 409) { onClose(); alertError((err as Error).message); } else { again(); setError((err as Error).message); }
    } finally { setBusy(false); }
  };
  const secondary = async () => {
    const s = spec.secondary; if (!s) return;
    if (s.next) { saved(); c.sheet(s.next); return; }
    setBusy(true); setError('');
    try { await s.run?.(); saved(); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="sheet-backdrop" onClick={e => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <form onSubmit={submit} noValidate>
          <h2 id={titleId}>{spec.title}</h2>
          {spec.description && <p className="hint">{spec.description}</p>}
          <div className="stack">
            {spec.fields.map(f => <FieldInput key={f.key} c={c} f={f} value={v[f.key]} invalid={invalid === f.key} onChange={x => { setV(s => ({ ...s, [f.key]: x })); setError(''); if (invalid === f.key) setInvalid(''); }} />)}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{spec.dismiss || 'Cancel'}</button>
            <button type="submit" className={`btn ${spec.tone === 'danger' ? 'danger' : 'primary'}`} disabled={busy}>{busy ? 'Saving…' : spec.confirm}</button>
          </div>
          {spec.secondary && <button type="button" className="btn danger block sheet-secondary" disabled={busy} onClick={() => void secondary()}><Trash2 aria-hidden="true" />{spec.secondary.label}</button>}
        </form>
      </div>
    </div>
  );
}
function FieldInput({ c, f, value, onChange, invalid }: { c: Ctx; f: Field; value: any; onChange: (v: any) => void; invalid?: boolean }) {
  const bad = invalid || undefined;
  if (f.type === 'progress') {
    const n = Number(value ?? 0);
    return <fieldset className="field"><legend className="label">{f.label} <strong>{n}%</strong></legend><input type="range" min={0} max={99} value={n} onChange={e => onChange(Number(e.target.value))} aria-label={`${f.label} in percent`} className="range" />
      <div className="chips wrap">{[10, 25, 50, 75, 90].map(p => <button key={p} type="button" className="chip" aria-pressed={n === p} onClick={() => onChange(p)}>{p}%</button>)}</div>{f.hint && <span className="hint small">{f.hint}</span>}</fieldset>;
  }
  if (f.type === 'person') return <PersonSelect c={c} label={f.label} required={f.required} value={value} onChange={onChange} people={f.people || []} hint={f.hint} invalid={invalid} field={f.key} />;
  if (f.type === 'checkbox') return <label className="check-row"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /><span><strong>{f.label}</strong>{f.hint && <span className="hint small">{f.hint}</span>}</span></label>;
  if (f.type === 'offsets') return <OffsetChips value={Array.isArray(value) ? value : []} onChange={onChange} start={f.start} label={f.label} hint={f.hint} />;
  // A chosen date is repeated in words, since phones show date fields as numbers (V5.6.8).
  const words = f.type === 'date' ? dayInWords(value) : '';
  const hint = f.hint || words ? <span className="hint small">{[words, f.hint].filter(Boolean).join(' · ')}</span> : null;
  if (f.type === 'select') return <LField label={f.label} required={f.required}><select className="input" value={value ?? ''} onChange={e => onChange(e.target.value)} aria-required={f.required || undefined} aria-invalid={bad} data-field={f.key}><option value="">{f.placeholder || 'Choose…'}</option>{(f.options || []).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>{hint}</LField>;
  if (f.type === 'textarea' || !f.type) return <LField label={f.label} required={f.required}><textarea className="input" rows={3} value={value ?? ''} maxLength={2000} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} aria-required={f.required || undefined} aria-invalid={bad} data-field={f.key} />{hint}</LField>;
  return <LField label={f.label} required={f.required}><input className="input" type={f.type} value={value ?? ''} min={f.min} maxLength={f.type === 'text' ? 300 : undefined} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} aria-required={f.required || undefined} aria-invalid={bad} data-field={f.key} />{hint}</LField>;
}
/** A file attached to a task, full screen: images and PDFs (zoom, pages) and readable Word, Excel, PowerPoint, CSV and
 *  text files, with a download button. Telegram's Back button closes it. The short-lived media link is checked by the
 *  server exactly like a download. */
function Viewer({ c, file, onClose }: { c: Ctx; file: Row; onClose: () => void }) {
  useLayer(onClose);
  const source = useMemo<PreviewSource>(() => ({ file: { id: file.id, name: file.name, mime: file.mime, size: file.size }, bytesUrl: c.fileUrl(file, true),
    previewUrl: c.previewUrl(file), load: url => fetch(url, { credentials: API_BASE ? 'include' : 'same-origin' }), download: () => c.download(file) }), [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={file.name}>
      <PreviewPane source={source} onClose={onClose} dark />
    </div>
  );
}

// ------------------------------------------------------------------ home
/** Workspaces where this person may create tasks or meetings. */
const creatableWorkspaces = (c: Ctx, keep?: string | null): Row[] => [...(c.data.tm_workspaces || []), ...(c.data.tm_workspace_refs || [])].filter((w: Row) => (w.status === 'ACTIVE' && w.org_access?.can_create !== false) || (!!keep && w.id === keep));
const byDue = (a: Row, b: Row) => a.due_date.localeCompare(b.due_date);
function HomeView({ c }: { c: Ctx }) {
  const { tasks, me, data } = c, open = tasks.filter(t => OPEN_TASK_STATUSES.includes(t.status));
  // V5.4: the dashboard shows responsibility: work in my charge, work I gave to others, and what waits for my decision.
  const mine = open.filter(t => t.pic_id === me), given = tasks.filter(t => assignedByMe(t, me)), decide = tasks.filter(t => toReviewOrApprove(t, me));
  const overdue = open.filter(t => t.overdue && t.assignees.includes(me)), stuck = open.filter(t => t.stuck && (t.assignees.includes(me) || t.reviewer_id === me));
  const w = waitingAll(c);
  // V5.6.8: each task shows once on Home: what waits for me first, then my work and the work I gave, then what is due soon.
  const shown = new Set<string>([...w.answer.map((t: Row) => t.id), ...w.review.map((t: Row) => t.id), ...w.approvals.map((cr: Row) => cr.task_id), ...w.due.map((d: Row) => d.task_id)]);
  const mineList = mine.filter(t => !shown.has(t.id)).sort(byDue), givenList = given.filter(t => !shown.has(t.id)).sort(byDue);
  const listed = new Set([...shown, ...mineList.slice(0, 5).map(t => t.id), ...givenList.slice(0, 5).map(t => t.id)]);
  const soon = open.filter(t => t.assignees.includes(me) && !t.overdue && !listed.has(t.id) && daysBetween(taskToday(), t.due_date) <= 3).sort(byDue);
  const answerNote = (t: Row) => (t.waiting as Row[]).filter(x => x.staff_id === me).map(x => ASK_NOTE[x.role]?.(c, t)).filter(Boolean).join(' · ');
  const answerNamed = (t: Row) => [me, ...((t.waiting as Row[]).some(x => x.staff_id === me && x.role === 'supporter') ? [t.pic_id] : [])];
  // V5.5.1: today's meetings (that I take part in) and my notes.
  const day = calToday(), agenda = calendarItems(c, true).filter(i => i.kind !== 'task' && !i.done && i.day <= day && i.endDay >= day);
  return (
    <>
      <header className="hero hero-row">
        <div className="hero-text">
          <p className="hint brand-line"><LogoIcon size={28} className="brand-mark" alt="" /><span><BrandTitle /></span></p>
          <h1>Hi, {first(c.name(me))}</h1>
          <p className="hint">{fmtDay(taskToday())} · {w.total ? `${w.total} ${w.total === 1 ? 'thing needs' : 'things need'} you` : 'nothing is waiting for you'}</p>
        </div>
        <button type="button" className="avatar-btn" onClick={() => c.open({ kind: 'settings' })} aria-label="My profile and settings"><Avatar name={c.name(me)} src={c.photo(me)} size="lg" /></button>
      </header>
      <div className="tiles">
        <button type="button" className="tile" onClick={() => c.showTasks('mine')}><span className="tile-value">{mine.length}</span><span className="tile-label">In my charge</span></button>
        <button type="button" className="tile" onClick={() => c.showTasks('assigned')}><span className="tile-value">{given.length}</span><span className="tile-label">Assigned by me</span></button>
        <button type="button" className={`tile${decide.length ? ' tone-warning' : ''}`} onClick={() => c.showTasks('review')}><span className="tile-value">{decide.length}</span><span className="tile-label">To review or approve</span></button>
        <button type="button" className={`tile${w.answer.length ? ' tone-warning' : ''}`} onClick={() => c.showTasks('answer')}><span className="tile-value">{w.answer.length}</span><span className="tile-label">To accept or reject</span></button>
        <button type="button" className={`tile${overdue.length ? ' tone-danger' : ''}`} onClick={() => c.showTasks('overdue')}><span className="tile-value">{overdue.length}</span><span className="tile-label">Overdue</span></button>
        <button type="button" className={`tile${stuck.length ? ' tone-danger' : ''}`} onClick={() => c.showTasks('stuck')}><span className="tile-value">{stuck.length}</span><span className="tile-label">Stuck</span></button>
      </div>
      <button type="button" className="btn block" onClick={() => c.open({ kind: 'timesheets' })}><Clock3 aria-hidden="true" />Timesheets</button>
      <div className="actions-row">
        <button type="button" className="btn primary" onClick={() => c.open({ kind: 'task-form' })}><Plus aria-hidden="true" />New task</button>
        <button type="button" className="btn" onClick={() => c.open({ kind: 'request-form' })}><Send aria-hidden="true" />Request a task</button>
      </div>
      <Section title="Waiting for you" count={w.total}>
        {w.total ? <div className="list">
          {w.org > 0 && <button type="button" className="list-row" onClick={() => c.open({ kind: 'organization', id: '' })}><span className="row-icon" aria-hidden="true"><ShieldCheck /></span><span className="row-main"><span className="row-title">{w.org} organization {w.org === 1 ? 'request' : 'requests'} to review</span><span className="row-meta">Organizational Structure · Approvals</span></span><ChevronRight className="chev" aria-hidden="true" /></button>}
          {w.answer.map((t: Row) => <TaskRow key={`a-${t.id}`} c={c} t={t} note={answerNote(t)} named={answerNamed(t)} />)}
          {w.review.map((t: Row) => <TaskRow key={`r-${t.id}`} c={c} t={t} note={`${completionApprover(t) === me && t.change_request?.kind === 'COMPLETE' ? 'Approve completion' : 'Review'} · from ${c.who(t.submitted_by)}`} named={[t.submitted_by]} />)}
          {w.approvals.map((cr: Row) => { const t = tasks.find(x => x.id === cr.task_id); return t ? <TaskRow key={`c-${cr.id}`} c={c} t={t} note={`Approve: ${changeTitle(cr).toLowerCase()} · from ${c.who(cr.requested_by)}`} named={[cr.requested_by]} /> : null; })}
          {w.requests.map((q: Row) => <button key={q.id} type="button" className="list-row" onClick={() => c.open({ kind: 'request', id: q.id })}><Avatar name={c.name(q.requested_by)} src={c.photo(q.requested_by)} size="sm" /><span className="row-main"><span className="row-title">{q.title}</span><span className="row-meta">Task request from {c.who(q.requested_by)}{q.proposed_due_date ? ` · needed by ${fmtDay(q.proposed_due_date)}` : ''}</span></span><ChevronRight className="chev" aria-hidden="true" /></button>)}
          {w.due.map((d: Row) => { const t = tasks.find(x => x.id === d.task_id); return t ? <TaskRow key={`d-${d.id}`} c={c} t={t} note={`New date ${fmtDay(d.proposed_due_date)} asked by ${c.who(d.requested_by, true)}`} named={[d.requested_by]} /> : null; })}
        </div> : <Empty icon={CheckCheck} title="You’re all caught up" text={`Tasks to accept, work to review, changes to approve, task requests${c.can('tasks.organization') ? ', due dates and organization approvals' : ' and due dates'} appear here.`} />}
      </Section>
      {agenda.length > 0 && <Section title="Today in your calendar" count={agenda.length} action={<button type="button" className="link-btn" onClick={() => c.setTab('calendar')}>Open calendar</button>}>
        <div className="list">{agenda.slice(0, 4).map(i => <CalRow key={i.key} c={c} i={i} day={day} />)}</div>
      </Section>}
      {mineList.length > 0 && <Section title="In my charge" count={mineList.length} action={mine.length > 5 ? <button type="button" className="link-btn" onClick={() => c.showTasks('mine')}>See all</button> : undefined}>
        <div className="list">{mineList.slice(0, 5).map(t => <TaskRow key={`m-${t.id}`} c={c} t={t} />)}</div>
      </Section>}
      {givenList.length > 0 && <Section title="Assigned by me" count={givenList.length} action={given.length > 5 ? <button type="button" className="link-btn" onClick={() => c.showTasks('assigned')}>See all</button> : undefined}>
        <div className="list">{givenList.slice(0, 5).map(t => <TaskRow key={`g-${t.id}`} c={c} t={t} note={t.change_request && t.status !== 'IN_REVIEW' ? 'Change waiting for approval' : undefined} />)}</div>
      </Section>}
      {soon.length > 0 && <Section title="Due in the next 3 days" count={soon.length}><div className="list">{soon.slice(0, 6).map(t => <TaskRow key={t.id} c={c} t={t} />)}</div></Section>}
    </>
  );
}

// ------------------------------------------------------------------ task list
const SCOPES: [string, string][] = [['mine', 'In my charge'], ['assigned', 'Assigned by me'], ['review', 'To review or approve'], ['answer', 'To accept or reject'], ['supporting', 'Supporting'], ['open', 'All open'], ['stuck', 'Stuck'], ['overdue', 'Overdue'], ['done', 'Completed']];
function inScope(scope: string, t: Row, me: string) {
  const open = OPEN_TASK_STATUSES.includes(t.status);
  return scope === 'mine' ? open && t.pic_id === me : scope === 'answer' ? (t.waiting as Row[]).some(x => x.staff_id === me) : scope === 'supporting' ? open && t.supporters.includes(me)
    : scope === 'assigned' ? assignedByMe(t, me)
      : scope === 'review' ? toReviewOrApprove(t, me) : scope === 'stuck' ? open && t.stuck : scope === 'overdue' ? t.overdue : scope === 'done' ? t.status === 'COMPLETED' : open;
}
/** V5.5: My Tasks keeps its meaning (tasks I am directly on); Company shows every task within my Task Visibility Scope. */
function AreaSwitch({ area, setArea }: { area: 'mine' | 'company'; setArea: (a: 'mine' | 'company') => void }) {
  return <div className="segmented" role="group" aria-label="Tasks to show">{([['mine', 'My Tasks'], ['company', 'Company']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={area === v} onClick={() => setArea(v)}>{l}</button>)}</div>;
}
const involved = (t: Row) => !t.access_reason || t.access_reason === 'involved';
function TaskList({ c, scope, setScope, area, setArea }: { c: Ctx; scope: string; setScope: (s: string) => void; area: 'mine' | 'company'; setArea: (a: 'mine' | 'company') => void }) {
  // V5.6.8: the search is kept while the app is open, so it is still there after going back from a task.
  const [q, setQState] = useState(listMemory.q), setQ = (v: string) => { listMemory.q = v; setQState(v); };
  const mineOnly = c.tasks.filter(involved);
  const counts = Object.fromEntries(SCOPES.map(([id]) => [id, mineOnly.filter(t => inScope(id, t, c.me)).length]));
  const rows = mineOnly.filter(t => inScope(scope, t, c.me) && `${t.title} ${t.id} ${t.workspace} ${t.department} ${c.name(t.pic_id)}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (scope === 'done' ? String(b.completed_at).localeCompare(String(a.completed_at)) : a.due_date.localeCompare(b.due_date)));
  return (
    <>
      <Header title="Tasks" action={<button type="button" className="icon-btn filled" onClick={() => c.open({ kind: 'task-form' })} aria-label="New task"><Plus aria-hidden="true" /></button>} />
      <AreaSwitch area={area} setArea={setArea} />
      <Chips label="Show" value={scope} onChange={setScope} options={SCOPES.map(([id, l]) => [id, l, counts[id]])} />
      <label className="search"><span className="sr-only">Search tasks</span><input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks…" /></label>
      {rows.length ? <div className="list">{rows.slice(0, 200).map(t => <TaskRow key={t.id} c={c} t={t} note={scope === 'answer' ? (t.waiting as Row[]).filter(x => x.staff_id === c.me).map(x => ASK_NOTE[x.role]?.(c, t)).join(' · ') : undefined} />)}</div>
        : <Empty title={q ? 'No matching tasks' : 'No tasks here'} text={scope === 'mine' ? 'Tasks where you are the person in charge appear here.' : scope === 'answer' ? 'Tasks you are asked to take charge of, support or review appear here until you accept or reject them.' : undefined} />}
    </>
  );
}

const COMPANY_STATUS: [string, string][] = [['', 'Any status'], ['OPEN', 'Open'], ['NOT_STARTED', 'Not started'], ['IN_PROGRESS', 'In progress'], ['IN_REVIEW', 'In review'], ['STUCK', 'Stuck'], ['OVERDUE', 'Overdue'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled']];
function CompanyTasks({ c, area, setArea }: { c: Ctx; area: 'mine' | 'company'; setArea: (a: 'mine' | 'company') => void }) {
  // V5.6.8: filters are kept while the app is open (going back from a task keeps them).
  const [f, setFState] = useState(companyMemory.f), [more, setMoreState] = useState(companyMemory.more);
  const setF = (next: Row) => { companyMemory.f = next; setFState(next); }, setMore = (v: boolean) => { companyMemory.more = v; setMoreState(v); };
  const set = (patch: Row) => setF({ ...f, ...patch });
  const scope: Row = c.data.task_scope || {};
  // The people to filter by are only those on tasks this person may see.
  const people = [...new Set<string>(c.tasks.flatMap(t => [...t.assignees, t.reviewer_id]).filter(Boolean))].map(id => [id, c.name(id)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  const wss = [...new Map<string, string>(c.tasks.map(t => [t.workspace_id, t.workspace])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const statusOk = (t: Row) => !f.status || (f.status === 'OPEN' ? OPEN_TASK_STATUSES.includes(t.status) : f.status === 'STUCK' ? t.stuck : f.status === 'OVERDUE' ? t.overdue : t.status === f.status);
  const rows = c.tasks.filter(t => statusOk(t) && (!f.ws || t.workspace_id === f.ws) && (!f.person || t.assignees.includes(f.person) || t.reviewer_id === f.person) && (!f.priority || t.priority === f.priority)
    && (!f.from || t.due_date >= f.from) && (!f.to || t.due_date <= f.to) && `${t.title} ${t.id} ${t.workspace} ${t.department} ${c.name(t.pic_id)}`.toLowerCase().includes(f.q.toLowerCase()))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const active = [f.ws, f.person, f.priority, f.from, f.to].filter(Boolean).length + (f.status !== 'OPEN' ? 1 : 0);
  const others = [...new Set<string>(c.tasks.map(t => t.access_reason).filter((r: string) => r && !['involved', 'team', 'company'].includes(r)))].map(r => ACCESS[r]?.[1]).filter(Boolean) as string[];
  const reach = (scope.company ? 'Every task in the company (company-wide access).' : scope.team?.length ? `Your tasks and those led by the ${scope.team.length} ${scope.team.length === 1 ? 'person' : 'people'} in your reporting line.` : 'The tasks you are on.')
    + (!scope.company && others.length ? ` Also tasks you can see through ${andList(others)} (viewing only).` : '');
  return (
    <>
      <Header title="Tasks" subtitle={reach} />
      <AreaSwitch area={area} setArea={setArea} />
      <label className="search"><span className="sr-only">Search company tasks</span><input className="input" type="search" value={f.q} onChange={e => set({ q: e.target.value })} placeholder="Search tasks or people…" /></label>
      <div className="filter-grid">
        <label className="mini-field"><span>Status</span><select className="input" value={f.status} onChange={e => set({ status: e.target.value })}>{COMPANY_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="mini-field"><span>Employee</span><select className="input" value={f.person} onChange={e => set({ person: e.target.value })}><option value="">Anyone</option>{people.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      <button type="button" className="link-btn" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Fewer filters' : `More filters${active > 1 || (active === 1 && !f.person && f.status === 'OPEN') ? ` (${active})` : ''}`}</button>
      {more && <div className="filter-grid">
        <label className="mini-field"><span>Workspace</span><select className="input" value={f.ws} onChange={e => set({ ws: e.target.value })}><option value="">All</option>{wss.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="mini-field"><span>Priority</span><select className="input" value={f.priority} onChange={e => set({ priority: e.target.value })}><option value="">Any</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></label>
        <label className="mini-field"><span>Due from</span><input className="input" type="date" value={f.from} onChange={e => set({ from: e.target.value })} /></label>
        <label className="mini-field"><span>Due until</span><input className="input" type="date" value={f.to} min={f.from || undefined} onChange={e => set({ to: e.target.value })} /></label>
        {active > 0 && <button type="button" className="btn small" onClick={() => setF({ q: f.q, ws: '', person: '', status: 'OPEN', priority: '', from: '', to: '' })}>Clear filters</button>}
      </div>}
      <p className="hint small" aria-live="polite">{rows.length} {rows.length === 1 ? 'task' : 'tasks'}</p>
      {rows.length ? <div className="list">{rows.slice(0, 200).map(t => <TaskRow key={t.id} c={c} t={t} note={accessNote(t)} />)}</div>
        : <Empty title="No matching tasks" text="Change the filters to see more." />}
      {rows.length > 200 && <p className="hint small">Showing the first 200. Narrow the filters to see the rest.</p>}
    </>
  );
}

// ------------------------------------------------------------------ task detail
const HISTORY: Record<string, string> = {
  create: 'created the task', accept: 'accepted the task', decline: 'rejected the task', progress: 'updated progress', stuck: 'marked it stuck', resume: 'resumed work', submit: 'submitted for review', return: 'returned it',
  close: 'closed it', cancel: 'cancelled it', reopen: 'reopened it', note: 'commented', edit: 'changed details', due_request: 'asked for a new due date', due_change: 'changed the due date', due_declined: 'declined a new due date', due_withdrawn: 'withdrew a due date request',
  support_accept: 'accepted to support', support_decline: 'rejected supporting', review_accept: 'accepted to review', review_decline: 'rejected reviewing', handover: 'handed the task over', remind: 'sent a reminder',
  checklist: 'updated the steps of work', file: 'added a file', file_removed: 'removed a file',
  pass: 'passed it on for approval', change_request: 'asked for approval', change_rejected: 'rejected a change', change_withdrawn: 'withdrew a request', change_closed: 'closed a request', reminders: 'changed the reminders',
};
const ASKED: Record<string, string> = { pic: 'to take charge of this task', supporter: 'to support this task', reviewer: 'to review this task' };
function TaskView({ c, id }: { c: Ctx; id: string }) {
  const t = c.tasks.find(x => x.id === id);
  const [comment, setComment] = useState(''), [busy, setBusy] = useState(false), [step, setStep] = useState(''), [uploading, setUploading] = useState(false);
  const [ticking, setTicking] = useState<Record<string, boolean>>({});
  // A typed comment or step is not thrown away by Back without asking (V5.6.8).
  useDirty([comment, step]);
  if (!t) return <><BackBar c={c} title="Task" /><Empty icon={CircleSlash} title="Task not found" text="It may have been removed, or your role no longer includes it." /></>;
  const { roles, allowed } = taskActions(t, c.me, { canApprove: c.approver && involved(t) });
  // V5.6.8: every task action names the version on screen; a change made meanwhile is reported (409) and the task reloads.
  const act = (verb: string, extra: Row = {}) => c.perform(`tm.task.${verb}`, { id: t.id, expected_version: t.version, ...extra });
  // V5.5: a new progress figure on a task someone else assigned waits for the assigner's side to approve it.
  const progressBy: string | null = !twoSided(t) || !OPEN_TASK_STATUSES.includes(t.status) ? null : (roles.isPic || roles.isSupporter) ? (assignerOf(t) !== c.me ? assignerOf(t) : null) : t.pic_id;
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch { /* the toast shows the message */ } finally { setBusy(false); } };
  const quick = (fn: () => Promise<unknown>) => run(async () => { try { await fn(); } catch (e) { alertError((e as Error).message); } });
  const note = (label: string, required = false): Field => ({ key: 'note', label, type: 'textarea', required });
  // V5.4: who must agree to my changes (null: they apply at once) and who makes a completion final.
  const target: string | null = approvalTarget(t, c.me), path = completionPath(t), finalApprover: string | null = completionApprover(t), cr: Row | null = t.change_request || null;
  const completionAsked = !!cr && cr.kind === 'COMPLETE' && cr.requester_side === 'PIC', asksApproval = roles.isPic && twoSided(t), approvingCompletion = completionAsked && c.me === finalApprover;
  const reviewStage: string | null = roles.isPic && path.review && path.review !== finalApprover ? path.review : null;
  const to = roles.isPic ? (reviewStage || finalApprover || t.reviewer_id) : t.pic_id;
  const answers = roles.toAnswer as string[], rejected = roles.rejected as string[];
  const rejectRole = answers.length === 1 ? answers[0] : answers.length ? 'all' : rejected[0];
  const invitedBy = (c.data.tm_assignees || []).find((a: Row) => a.task_id === t.id && a.staff_id === c.me)?.invited_by;
  const asker = (answers.length === 1 && answers[0] === 'reviewer' ? t.created_by : invitedBy) || t.created_by;
  const others = peopleList(c, { exclude: [t.pic_id] });
  // V5.6.8: reopening a task both sides agreed to close waits for the other side's approval.
  const reopenBy: string | null = reopenNeedsApproval(t, c.me);
  const specs: Record<string, [string, LucideIcon, SheetSpec | (() => void), string?]> = {
    accept: [rejected.length && !answers.length ? 'Accept after all' : 'Accept', UserCheck, () => void quick(() => act('accept'))],
    decline: ['Reject…', XCircle, { title: rejectRole === 'supporter' ? 'Reject supporting this task?' : rejectRole === 'reviewer' ? 'Reject reviewing this task?' : 'Reject this task?', description: rejectRole === 'pic' ? `${first(c.name(t.reviewer_id || t.created_by))} will be told and can give it to someone else.` : 'The people on the task will see your reason.', fields: [note('Reason for rejecting', true)], confirm: 'Reject', tone: 'danger', run: v => act('decline', v) }],
    progress: [t.status === 'NOT_STARTED' ? 'Start work' : 'Update progress', PlayCircle, { title: 'Update progress', description: progressBy ? `${first(c.name(progressBy))} approves the new figure before it shows; it stays ${t.progress}% until then. Use 0–99%.` : 'Use 0–99%. Submit or close the task when the work is finished.', fields: [{ key: 'progress', label: 'Progress', type: 'progress' }, note(progressBy ? `Note for ${first(c.name(progressBy))} (optional)` : 'Note (optional)')], confirm: progressBy ? 'Send for approval' : 'Save', initial: { progress: t.progress }, run: v => act('progress', v) }],
    stuck: ['Mark as stuck…', Hand, { title: 'What is blocking this task?', description: 'Everyone on the task is told. It stays stuck until someone resumes it.', fields: [note('Blocker', true)], confirm: 'Mark as stuck', run: v => act('stuck', v) }],
    resume: ['Resume work', PlayCircle, { title: 'Resume this task', fields: [note('Note (optional)')], confirm: 'Resume', run: v => act('resume', v) }],
    submit: [asksApproval ? 'Submit for approval…' : t.status === 'IN_REVIEW' ? 'Send to reviewer…' : 'Submit for review…', Send, { title: asksApproval ? (reviewStage ? `Submit to ${first(c.name(reviewStage))} for review` : `Ask ${first(c.name(finalApprover))} to approve completing it`) : `Submit to ${first(c.name(to))}`,
      description: asksApproval ? (reviewStage ? `${first(c.name(reviewStage))} checks the work, then ${first(c.name(finalApprover))} approves completing it.` : `${first(c.name(finalApprover))} assigned this task, so they approve completing it or return it with notes.`) : roles.isPic ? 'They can close it or return it with notes.' : 'The person in charge can send it on for approval, or return it.',
      fields: [note(asksApproval ? 'Note for the approver (optional)' : 'Note for the reviewer (optional)')], confirm: asksApproval ? 'Submit for approval' : 'Submit', run: v => act('submit', v) }],
    pass: ['Pass for approval…', ArrowRight, { title: `Pass to ${first(c.name(finalApprover))} for approval`, description: `You checked the work. ${first(c.name(finalApprover))} approves completing it or returns it.`, fields: [note('Note for the approver (optional)')], confirm: 'Pass on', run: v => act('pass', v) }],
    return: [approvingCompletion ? 'Return (don’t approve)…' : 'Return for more work…', Undo2, { title: 'Return this task', description: `It goes back to ${first(c.name(t.submitted_by))}${completionAsked ? ' and the request to complete it is rejected' : ''}.`, fields: [note('What still needs to be done?', true)], confirm: 'Return', run: v => act('return', v) }],
    close: approvingCompletion ? ['Approve completion', Check, { title: 'Approve completing this task?', description: `${first(c.name(cr?.requested_by))} asked to complete it. Progress becomes 100% and everyone on the task is told.`, fields: [note('Note (optional)')], confirm: 'Approve completion', run: v => act('close', v) }]
      : target && t.status !== 'IN_REVIEW' ? ['Ask to complete…', Check, { title: `Ask ${first(c.name(target))} to approve completing it?`, description: `Nothing changes until ${first(c.name(target))} approves.`, fields: [note('Note for them (optional)')], confirm: 'Send for approval', run: v => act('close', v) }]
        : ['Close as completed', Check, { title: 'Close this task?', description: `Progress becomes 100% and everyone on the task is told.${t.recurrence && !t.next_task_id ? ` The next one (repeats ${RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT]}) is created automatically.` : ''}`, fields: [note('Closing note (optional)')], confirm: 'Close task', run: v => act('close', v) }],
    due: ['Ask for a new due date…', CalendarClock, { title: 'Ask for a new due date', description: `${first(c.name(asksApproval ? assignerOf(t) : dueDecider(t)))} ${asksApproval ? 'approves it' : 'decides'}. Currently due ${fmtDay(t.due_date)}.`, fields: [{ key: 'proposed_due_date', label: 'New due date', type: 'date', required: true, min: t.start_date }, { key: 'reason', label: 'Reason', type: 'textarea', required: true }], confirm: 'Send request', initial: { proposed_due_date: addDays(t.due_date, 3) }, run: v => c.perform('tm.due.request', { task_id: t.id, expected_version: t.version, ...v }) }],
    handover: ['Hand over…', UserRoundCog, { title: 'Hand this task over', description: target ? `${first(c.name(target))} approves the hand-over first; you stay in charge until then.` : 'Choose who should take charge instead. They are asked to accept it; the reviewer and the person who created the task are told.', fields: [{ key: 'to_id', label: 'New person in charge', type: 'person', required: true, people: others }, { key: 'keep', label: 'Keep me on the task as a supporting person', type: 'checkbox' }, note('Note for them (optional)')], confirm: target ? 'Send for approval' : 'Hand over', run: v => act('handover', v) }],
    reminders: ['Reminders…', AlarmClock, { title: 'Deadline reminders', description: `Everyone on this task is reminded here, in Telegram and in the Task Controlling Management. Now: ${reminderText(t.reminder_days)}.`, fields: reminderFields, confirm: 'Save reminders', initial: reminderStart(t.reminder_days), run: v => c.perform('tm.task.reminders', { id: t.id, expected_version: t.version, reminder_days: reminderInput(v) }) }],
    remind: ['Send a reminder', BellRing, () => void quick(() => act('remind'))],
    edit: ['Edit details', Pencil, () => c.open({ kind: 'task-form', id: t.id })],
    reopen: reopenBy ? ['Ask to reopen…', RotateCcw, { title: `Ask ${first(c.name(reopenBy))} to approve reopening it?`, description: `${first(c.name(reopenBy))} agreed to how this task ended, so they approve reopening it. It stays ${t.status === 'CANCELLED' ? 'cancelled' : 'completed'} until then.`, fields: [note('Reason', true)], confirm: 'Send for approval', run: v => act('reopen', v) }]
      : ['Reopen…', RotateCcw, { title: 'Reopen this task', fields: [note('Reason', true)], confirm: 'Reopen', run: v => act('reopen', v) }],
    cancel: [target ? 'Ask to cancel…' : 'Cancel task…', CircleSlash, { title: target ? `Ask ${first(c.name(target))} to approve cancelling it?` : 'Cancel this task?', description: target ? `The task stays open until ${first(c.name(target))} approves.` : 'Everyone on the task is told. Cancelled tasks stay in the history and reports.', fields: [note('Reason', true), ...(t.recurrence && !t.next_task_id ? [{ key: 'keep_series', label: 'Keep the repeating series', type: 'checkbox', hint: 'Create the next one anyway (only this one is cancelled).' } as Field] : [])], confirm: target ? 'Send for approval' : 'Cancel task', dismiss: 'Keep the task', tone: 'danger', run: v => act('cancel', v) }, 'danger'],
  };
  const reviewFirst = (roles.isSubmittedTo || approvingCompletion) && (allowed.includes('close') || allowed.includes('pass'));
  // V5.6.8 (W2): the person in charge can also return or pass on work a supporting person submitted (as in the Task Controlling Management).
  const order = [...(reviewFirst ? ['close', 'pass', 'return'] : []), ...(t.stuck ? ['resume'] : []), 'accept', 'decline', 'pass', 'return', 'progress', 'submit', 'close', 'resume', 'stuck', 'due', 'handover', 'remind', 'reminders', 'edit', 'reopen', 'cancel'];
  const buttons = [...new Set(order)].filter(k => allowed.includes(k) && (!answers.length || (k !== 'accept' && k !== 'decline')));
  // V5.6.8: one main action is styled primary, and only one that moves the work on (not "Reminders…" or "Edit details").
  const lead = answers.length ? null : buttons.find(k => ['accept', 'progress', 'submit', 'close', 'pass', 'resume'].includes(k));
  const actionButton = (k: string) => { const [label, Icon, what, style] = specs[k]; return <button key={k} type="button" disabled={busy} className={`btn block ${k === lead ? 'primary' : style || ''}`} onClick={() => (typeof what === 'function' ? what() : c.sheet(what))}><Icon aria-hidden="true" />{label}</button>; };
  // V5.6.8 (W5): only the people the server lets decide a due date request see Approve date / Decline.
  const due = t.due_request, decider = !!due && canDecideDue(t, due, c.me, { canApprove: c.approver, involved: t.access_reason === 'involved' });
  const history = (c.data.tm_task_history || []).filter((h: Row) => h.task_id === t.id).slice().reverse();
  const open = OPEN_TASK_STATUSES.includes(t.status);
  // Checklist and files
  const items: Row[] = (c.data.tm_checklist || []).filter((i: Row) => i.task_id === t.id).sort((a: Row, b: Row) => a.position - b.position), canCheck = allowed.includes('checklist');
  const files: Row[] = (c.data.tm_files || []).filter((f: Row) => f.task_id === t.id), canFile = allowed.includes('file');
  // A tick shows at once; it is saved in the background and undone if saving fails.
  const tick = (i: Row, done: boolean) => {
    setTicking(s => ({ ...s, [i.id]: done }));
    void quick(async () => { try { await c.perform('tm.check.toggle', { id: i.id, done }, { quiet: true }); } finally { setTicking(s => { const n = { ...s }; delete n[i.id]; return n; }); } });
  };
  const addStep = (e: FormEvent) => { e.preventDefault(); const title = step.trim(); if (!title) return; void quick(async () => { await c.perform('tm.check.add', { task_id: t.id, title }, { quiet: true }); setStep(''); }); };
  // V5.6.8 (W19): removing a step asks first, as in the Task Controlling Management.
  const editStep = (i: Row) => c.sheet({ title: 'Step of work', fields: [{ key: 'title', label: 'Step', type: 'text', required: true }], initial: { title: i.title }, confirm: 'Save', run: v => c.perform('tm.check.rename', { id: i.id, title: v.title }),
    secondary: { label: 'Remove this step', next: { title: `Remove the step “${i.title}”?`, description: 'The history keeps a note that it was removed.', fields: [], confirm: 'Remove step', dismiss: 'Keep it', tone: 'danger', run: () => c.perform('tm.check.remove', { id: i.id }) } } });
  const upload = async (file: File) => {
    if (file.size > 30 * 1024 * 1024) { alertError(`${file.name} is larger than 30 MB.`); return; }
    setUploading(true);
    try { await c.perform('tm.file.add', { task_id: t.id, name: file.name, base64: await fileToBase64(file) }); } catch (e) { alertError((e as Error).message); } finally { setUploading(false); }
  };
  const answerBadge = (state?: string | null) => (state === 'PENDING' && open ? <Badge label="Waiting for answer" tone="warning" /> : state === 'DECLINED' ? <Badge label="Rejected" tone="danger" /> : null);
  const person = (staff: string, role: string, state?: string | null, why?: string) => (
    <li key={`${role}-${staff}`}>
      <Avatar name={c.name(staff)} src={c.photo(staff)} />
      <span className="person-text"><strong><Identity name={c.name(staff)}/></strong><span className="hint">{role}{staff === c.me ? ' · you' : ''}</span>{why && <span className="hint small">“{why}”</span>}</span>
      {answerBadge(state)}
    </li>
  );
  return (
    <>
      <BackBar c={c} title={t.id} />
      <header className="detail-head">
        <h1>{t.title}</h1>
        <p className="hint">{t.workspace}{t.department ? ` · ${t.department}` : ''}{t.recurrence ? ` · repeats ${RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT]}` : ''}</p>
        <div className="detail-status"><StateBadge t={t} /><PriorityBadge p={t.priority} /><span className={t.overdue ? 'danger small' : 'hint small'}>Due {fmtDay(t.due_date)} ({relDay(t.due_date)})</span></div>
        <div className="detail-progress"><Progress value={t.progress} label={`${t.progress}% complete`} /><strong>{t.progress}%</strong></div>
      </header>
      {!involved(t) && <div className="callout tone-neutral">{t.access_reason === 'team' ? `${first(c.name(t.pic_id))} is in your reporting line, so you can follow this task.` : `You can see this task through ${ACCESS[t.access_reason]?.[1] || 'authorized access'}.`} Viewing only: the people on the task make the changes.</div>}
      {answers.length > 0 && <div className="callout tone-info">
        <strong>{first(c.name(asker))} asked you {answers.map(r => ASKED[r]).join(' and ')}.</strong> {answers.includes('pic') ? 'Accept to start the work, or reject it with a reason so it can be given to someone else.' : answers.includes('supporter') ? `You would help ${first(c.name(t.pic_id))}, who is in charge.` : 'You would review the work when it is submitted and decide due date requests.'}
        <div className="callout-actions"><button type="button" className="btn primary small" disabled={busy} onClick={() => void quick(() => act('accept'))}><UserCheck aria-hidden="true" />Accept</button><button type="button" className="btn small" disabled={busy} onClick={() => c.sheet(specs.decline[2] as SheetSpec)}><XCircle aria-hidden="true" />Reject…</button></div>
      </div>}
      {!answers.length && rejected.length > 0 && open && <div className="callout tone-neutral">You rejected this {rejected.map(r => (r === 'pic' ? 'task' : r === 'supporter' ? 'supporting role' : 'review')).join(' and ')}.{allowed.includes('accept') ? ' If you can help after all, you can still accept.' : ''}</div>}
      {t.awaiting && !roles.isPic && <div className="callout tone-neutral">Waiting for {first(c.name(t.pic_id))} to accept.</div>}
      {t.declined && <div className="callout tone-warning"><strong>{first(c.name(t.pic_id))} rejected this task:</strong> {t.declined_reason}{roles.isGovernor ? ' Choose another person in charge with Edit details, or cancel the task.' : ''}</div>}
      {t.reviewer_status === 'DECLINED' && open && <div className="callout tone-warning"><strong>{first(c.name(t.reviewer_id))} rejected reviewing:</strong> {t.reviewer_note}{roles.isGovernor ? ' Choose a new reviewer with Edit details.' : ''}</div>}
      {t.stuck && <div className="callout tone-danger"><strong>Stuck since {fmtDay(dayOf(t.stuck_at))}:</strong> {t.stuck_reason}</div>}
      {t.status === 'IN_REVIEW' && <div className="callout tone-purple"><strong>{roles.isSubmittedTo ? (approvingCompletion ? `${first(c.name(t.submitted_by))} asks you to approve completing this task.` : `${first(c.name(t.submitted_by))} submitted this to you.`) : completionAsked ? `Waiting for ${t.submitted_to === finalApprover ? 'approval' : 'review'} by ${first(c.name(t.submitted_to))}.` : `Waiting for review by ${first(c.name(t.submitted_to))}.`}</strong>{t.submit_note ? ` “${t.submit_note}”` : ''}
        {completionAsked && t.submitted_to !== finalApprover && !roles.isSubmittedTo ? ` ${first(c.name(finalApprover))} then approves completing it.` : ''}
        {roles.isSubmittedTo && !approvingCompletion && <p className="small">{allowed.includes('pass') ? `Check the work, then pass it to ${first(c.name(finalApprover))} for approval, or return it with notes.` : roles.isPic ? 'Check the work, then send it on or return it with notes.' : 'Close it if the work is complete, or return it with notes.'}</p>}
        {completionAsked && cr?.requested_by === c.me && <div className="callout-actions"><button type="button" className="btn small" disabled={busy} onClick={() => void quick(() => c.perform('tm.change.withdraw', { id: cr.id }))}>Take back the request</button></div>}
      </div>}
      {cr && !completionAsked && <div className="callout tone-warning">
        <strong><Scale aria-hidden="true" className="inline-icon" />{cr.approver_id === c.me ? `${first(c.name(cr.requested_by))} asks you to approve: ${changeTitle(cr).toLowerCase()}` : `Waiting for ${first(c.name(cr.approver_id))} to approve: ${changeTitle(cr).toLowerCase()}`}</strong>
        <Changes cr={cr} />
        {cr.note && <p className="small">“{cr.note}”</p>}
        <p className="hint small">Asked by {first(c.name(cr.requested_by))} · {fmtTime(cr.created_at)}. Nothing changes until it is approved.</p>
        {cr.approver_id === c.me && <div className="callout-actions"><button type="button" className="btn primary small" disabled={busy} onClick={() => void quick(() => c.perform('tm.change.decide', { id: cr.id, decision: 'APPROVE', expected_version: cr.version }))}><Check aria-hidden="true" />Approve</button><button type="button" className="btn small" disabled={busy} onClick={() => c.sheet({ title: 'Reject this request?', description: `${first(c.name(cr.requested_by))} will see your reason. The task stays as it is.`, fields: [{ key: 'note', label: 'Reason for rejecting', type: 'textarea', required: true }], confirm: 'Reject', tone: 'danger', run: v => c.perform('tm.change.decide', { id: cr.id, decision: 'REJECT', note: v.note, expected_version: cr.version }) })}><XCircle aria-hidden="true" />Reject…</button></div>}
        {cr.requested_by === c.me && <div className="callout-actions"><button type="button" className="btn small" disabled={busy} onClick={() => void quick(() => c.perform('tm.change.withdraw', { id: cr.id }))}>Withdraw request</button></div>}
      </div>}
      {due && <div className="callout tone-info"><strong>{first(c.name(due.requested_by))} asked to move the due date to {fmtDay(due.proposed_due_date)}.</strong> {due.reason}
        {decider && <div className="callout-actions"><button type="button" className="btn primary small" disabled={busy} onClick={() => void quick(() => c.perform('tm.due.decide', { id: due.id, decision: 'APPROVE', expected_version: due.version }))}>Approve date</button><button type="button" className="btn small" disabled={busy} onClick={() => c.sheet({ title: 'Decline the new due date', fields: [{ key: 'note', label: 'Reason', type: 'textarea', required: true }], confirm: 'Decline', tone: 'danger', run: v => c.perform('tm.due.decide', { id: due.id, decision: 'DECLINE', expected_version: due.version, ...v }) })}>Decline…</button></div>}
        {due.requested_by === c.me && <div className="callout-actions"><button type="button" className="btn small" disabled={busy} onClick={() => void quick(() => c.perform('tm.due.withdraw', { id: due.id }))}>Withdraw request</button></div>}
      </div>}
      {buttons.length > 0 && <div className="action-list">
        {(buttons.length > 4 ? buttons.slice(0, 3) : buttons).map(actionButton)}
        {buttons.length > 4 && <details className="more-actions">
          <summary className="btn block">More actions<span className="chip-count">{buttons.length - 3}</span></summary>
          <div className="action-list">{buttons.slice(3).map(actionButton)}</div>
        </details>}
      </div>}
      <Section title="People">
        <ul className="people">
          {person(t.pic_id, 'In charge', t.pic_state)}
          {(t.support as Row[]).map(x => person(x.staff_id, 'Supporting', x.status, x.status === 'DECLINED' ? x.response_note : ''))}
          {t.reviewer_id && t.reviewer_id !== t.pic_id && person(t.reviewer_id, 'Reviewer', t.reviewer_status, t.reviewer_status === 'DECLINED' ? t.reviewer_note : '')}
          {t.assigned_by && t.assigned_by !== t.pic_id && t.assigned_by !== t.reviewer_id && person(t.assigned_by, 'Assigned the task')}
        </ul>
        <p className="hint small">{t.approval ? `Changes, completion and cancellation need both ${first(c.name(t.pic_id))} and ${first(c.name(t.assigned_by))}.` : t.assigned_by === t.pic_id ? `${first(c.name(t.pic_id))} assigned this task to themselves.` : `Assigned by ${first(c.name(t.assigned_by))}.`}{open ? ` Reminders: ${reminderText(t.reminder_days)}.` : ''}</p>
      </Section>
      {(t.department_note || t.description) && <Section title="Details">
        {t.department_note && <p className="note-block"><span className="label">Department note</span>{t.department_note}</p>}
        {t.description && <p className="note-block"><span className="label">Expectation</span>{t.description}</p>}
      </Section>}
      {(items.length > 0 || canCheck) && <Section title="Steps of work" action={items.length ? <span className="hint small">{t.check_done} of {t.check_total} completed</span> : undefined}>
        {items.length > 0 && <ol className="checklist">
          {items.map((i, n) => (
            <li key={i.id} className={(ticking[i.id] ?? !!i.done) ? 'is-done' : undefined}>
              <label className="check-item">
                <input type="checkbox" checked={ticking[i.id] ?? !!i.done} disabled={!canCheck || busy} onChange={e => tick(i, e.target.checked)} />
                <span className="check-text"><span className="step-no">{n + 1}.</span> {i.title}{i.done && i.done_by ? <span className="hint small"> · {c.who(i.done_by)}{i.done_at ? `, ${fmtTime(i.done_at)}` : ''}</span> : null}</span>
              </label>
              {canCheck && <span className="step-tools">
                <button type="button" className="icon-btn small" disabled={busy || n === 0} aria-label={`Move “${i.title}” up`} onClick={() => void quick(() => c.perform('tm.check.move', { id: i.id, direction: 'up' }, { quiet: true }))}><ArrowUp aria-hidden="true" /></button>
                <button type="button" className="icon-btn small" disabled={busy || n === items.length - 1} aria-label={`Move “${i.title}” down`} onClick={() => void quick(() => c.perform('tm.check.move', { id: i.id, direction: 'down' }, { quiet: true }))}><ArrowDown aria-hidden="true" /></button>
                <button type="button" className="icon-btn small" aria-label={`Edit or remove “${i.title}”`} onClick={() => editStep(i)}><Pencil aria-hidden="true" /></button>
              </span>}
            </li>
          ))}
        </ol>}
        {items.length > 0 && <p className="hint small">Completing a step tells {first(c.name(assignerOf(t)))}. Steps don’t change progress or close the task.</p>}
        {canCheck && <form className="inline-add" onSubmit={addStep}>
          <label className="sr-only" htmlFor={`step-${t.id}`}>New step of work</label>
          <input id={`step-${t.id}`} className="input" value={step} maxLength={300} placeholder={items.length ? 'Add another step…' : 'Add a step, e.g. “Get quotes”'} onChange={e => setStep(e.target.value)} disabled={busy} />
          <button type="submit" className="btn small" disabled={busy || !step.trim()}><Plus aria-hidden="true" />Add</button>
        </form>}
      </Section>}
      {(files.length > 0 || canFile) && <Section title="Files" count={files.length || undefined} action={canFile ? <label className={`btn small file-btn${uploading ? ' is-busy' : ''}`}><Paperclip aria-hidden="true" />{uploading ? 'Uploading…' : 'Attach'}<input type="file" accept={TASK_FILE_ACCEPT} disabled={uploading} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} /></label> : undefined}>
        {files.length ? <ul className="files">
          {files.map(f => (
            <li key={f.id}>
              <button type="button" className="file-open" onClick={() => c.viewFile(f)} aria-label={`${previewKind(f.mime) !== 'none' ? 'Preview' : 'Download'} ${f.name}`}>
                {PREVIEW_TYPES.includes(f.mime) ? <img className="file-thumb" src={c.fileUrl(f, true)} alt="" loading="lazy" /> : <span className="file-thumb file-icon"><FileText aria-hidden="true" /></span>}
                <span className="row-main"><span className="row-title">{f.name}</span><span className="row-meta">{kb(f.size)} · {c.who(f.uploaded_by)} · {fmtTime(f.created_at)}</span></span>
              </button>
              {(f.uploaded_by === c.me || roles.isGovernor) && <button type="button" className="icon-btn small" aria-label={`Remove ${f.name}`} onClick={() => c.sheet({ title: `Remove ${f.name}?`, description: 'The file is deleted from the task. The history keeps a note that it was removed.', fields: [], confirm: 'Remove file', tone: 'danger', run: () => c.perform('tm.file.remove', { id: f.id }) })}><Trash2 aria-hidden="true" /></button>}
            </li>
          ))}
        </ul> : <p className="hint small">No files yet. Attach photos, PDFs or documents (up to 30 MB each), or reply to this task’s message in the bot chat with a photo or file.</p>}
      </Section>}
      {(() => { const list: Row[] = (c.data.tm_change_requests || []).filter((x: Row) => x.task_id === t.id).slice().sort((a: Row, b: Row) => String(b.id).localeCompare(String(a.id))); return list.length ? <Section title="Approvals" count={list.length}>
        <ul className="approvals">{list.map(x => <li key={x.id}><div className="row-between"><strong>{changeTitle(x)}</strong><Badge label={CHANGE_STATUS[x.status as keyof typeof CHANGE_STATUS]} tone={CHANGE_TONE[x.status]} /></div><Changes cr={x} />
          <p className="hint small">Asked by {first(c.name(x.requested_by))} · {fmtTime(x.created_at)}{x.note ? ` · “${x.note}”` : ''}</p>
          <p className="hint small">{x.status === 'PENDING' ? `Waiting for ${first(c.name(x.approver_id))}` : `${x.status === 'APPROVED' ? 'Approved' : x.status === 'REJECTED' ? 'Rejected' : x.status === 'WITHDRAWN' ? 'Withdrawn' : 'Closed'} by ${first(c.name(x.decided_by))} · ${fmtTime(x.decided_at)}${x.decision_note ? ` · “${x.decision_note}”` : ''}`}</p></li>)}</ul>
      </Section> : null; })()}
      <Section title="Activity">
        {allowed.includes('note') && <div className="comment">
          <label className="sr-only" htmlFor="comment">Add a comment</label>
          <textarea id="comment" className="input" rows={2} value={comment} maxLength={2000} placeholder="Add a comment…" onChange={e => setComment(e.target.value)} />
          <button type="button" className="btn small" disabled={busy || !comment.trim()} onClick={() => void run(async () => { try { await act('note', { note: comment }); setComment(''); } catch (e) { alertError((e as Error).message); } })}><MessageSquare aria-hidden="true" />Post</button>
        </div>}
        <ol className="timeline">
          {history.map((h: Row) => <li key={h.id}><span className={`tl-dot kind-${h.kind}`} aria-hidden="true" /><div><p><strong>{c.who(h.actor_id)}</strong> {HISTORY[h.kind] || h.kind.replace(/_/g, ' ')}{h.kind === 'progress' ? ` to ${h.progress}%` : ''}</p>{h.note && <p className="tl-note">{h.note}</p>}<p className="hint small">{fmtTime(h.created_at)}{h.source === 'TELEGRAM' ? ' · Telegram' : h.source === 'MINIAPP' ? ' · Telegram app' : ''}</p></div></li>)}
        </ol>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ create / edit a task
function TaskForm({ c, id }: { c: Ctx; id?: string }) {
  const [outside,setOutside] = useState(false);
  const t = id ? c.tasks.find(x => x.id === id) : null;
  // The version the form started from: a change someone made meanwhile is reported, not overwritten (V5.5.1).
  const [openedVersion] = useState(() => t?.version);
  const wss: Row[] = creatableWorkspaces(c, t?.workspace_id);
  const memberOf = (wid: string) => (c.data.tm_members || []).filter((m: Row) => m.workspace_id === wid).map((m: Row) => m.staff_id as string);
  const defaultWs = t?.workspace_id || wss.find(w => w.status === 'ACTIVE' && memberOf(w.id).includes(c.me))?.id || wss[0]?.id || '';
  const [d, setD] = useState<Row>(() => t ? { ...t, supporter_ids: [...t.supporters], recurrence: t.recurrence || '', recurrence_until: t.recurrence_until || '' }
    : { workspace_id: defaultWs, title: '', description: '', pic_id: c.me, supporter_ids: [], reviewer_id: c.me, due_date: addDays(taskToday(), 3), priority: 'MEDIUM', department: wss.find(w => w.id === defaultWs)?.department || '', department_note: '', recurrence: '', recurrence_until: '', checklist: [], reminder_days: [1] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [step, setStep] = useState(''), [invalid, setInvalid] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  // V5.4: once both sides are on the task, either side proposes changes and the other side approves them.
  const target: string | null = t ? editApprovalTarget(t, c.me) || [t.reviewer_id,d.reviewer_id,d.pic_id].find(x=>x&&x!==c.me) || null : null;
  const roles = t ? taskActions(t, c.me, { canApprove: c.approver && involved(t) }).roles : null, locked = !!roles && !roles.isGovernor && !target;
  const [otherDay, setOtherDay] = useState('');
  const { saved } = useDirty([d, step, otherDay, outside]);
  const ws = wss.find(w => w.id === d.workspace_id), governed = ws?.kind && ws.kind !== 'LEGACY';
  const selected = new Set([d.pic_id,d.reviewer_id,...(d.supporter_ids||[])]);
  const everyone = peopleList(c, { include: [d.pic_id, d.reviewer_id, ...(d.supporter_ids || [])] }).filter(p => !governed || outside || memberOf(d.workspace_id).includes(p.id) || selected.has(p.id)).map(p => ({...p,note:governed && !memberOf(d.workspace_id).includes(p.id) ? 'Outside workspace · this task only' : p.note}));
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setError(''); setInvalid(l => l.filter(x => x !== k)); };
  const bad = (k: string) => invalid.includes(k) || undefined;
  const pickerEmpty = governed && !outside ? membersOnly(ws?.name || 'this workspace', !!ws?.org_access?.can_collaborate_outside, 'task') : undefined;
  const supportNote = (sid: string) => { const r = (t?.support || []).find((x: Row) => x.staff_id === sid); return <span className={`hint small${r?.status === 'PENDING' ? ' warn' : ''}`}>{!r ? 'Will be asked to accept' : r.status === 'PENDING' ? 'Waiting for answer' : r.status === 'DECLINED' ? 'Rejected' : 'Accepted'}</span>; };
  const addStep = () => { const v = step.trim(); if (!v || (d.checklist || []).length >= 50) return; set('checklist', [...(d.checklist || []), v]); setStep(''); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    // V5.6.8: name only what is missing, mark those fields and move to the first one.
    const missing: [string, string, boolean][] = ([['title', 'the title', false], ['workspace_id', 'the workspace', true], ['pic_id', 'the person in charge', true], ['reviewer_id', 'the reviewer', true], ['due_date', 'the due date', false]] as [string, string, boolean][]).filter(([k]) => !String(d[k] ?? '').trim());
    if (missing.length) { setInvalid(missing.map(m => m[0])); setError(missingText(missing.filter(m => !m[2]).map(m => m[1]), missing.filter(m => m[2]).map(m => m[1]))); focusField(formRef.current, missing[0][0]); return; }
    if (!String(d.description || '').trim()) { setError('Expectation is required.'); return; }
    if (d.recurrence && d.recurrence_until && d.recurrence_until < d.due_date) { setError('“Repeat until” must be on or after the due date.'); return; }
    setBusy(true);
    try {
      const body: Row = { workspace_id: d.workspace_id, title: d.title, description: d.description, pic_id: d.pic_id, supporter_ids: d.supporter_ids, reviewer_id: d.reviewer_id, due_date: d.due_date, start_date: t ? t.start_date : (taskToday() <= d.due_date ? taskToday() : d.due_date), priority: d.priority, department: d.department, department_note: d.department_note, recurrence: d.recurrence || '', recurrence_rule:d.recurrence_rule, recurrence_until: d.recurrence ? d.recurrence_until || null : null };
      const r = t ? await c.perform('tm.task.save', { ...body, id: t.id, expected_version: openedVersion ?? t.version, move_series: d.move_series === true, estimate: `${Math.floor(t.estimate_minutes / 60)}:${String(t.estimate_minutes % 60).padStart(2, '0')}`, related_type: t.related_type || '', related_id: t.related_id || '', change_note: d.change_note || '' })
        : await c.perform('tm.task.save', { ...body, estimate: '0:00', checklist: (d.checklist || []).length ? d.checklist : undefined, reminder_days: d.reminder_days || [], request_key: uuid() });
      saved(); c.back(); if (!t && r.id) c.open({ kind: 'task', id: r.id });
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (!t && !c.can('tasks.tasks', 'create')) return <><BackBar c={c} title="New task" /><div className="callout" role="alert">Your account does not have permission to create tasks. Ask an administrator if you need access.</div></>;
  if (!t && !wss.length) return <><BackBar c={c} title="New task" /><Empty icon={ClipboardList} title="You can’t create tasks in a workspace yet" text="Ask a workspace owner to add you, or ask someone for the task instead." action={<button type="button" className="btn primary" onClick={() => { c.back(); c.open({ kind: 'request-form' }); }}><Send aria-hidden="true" />Request a task</button>} /></>;
  const picHint = !t ? (d.pic_id === c.me ? 'You take charge, so the task starts as accepted.' : 'They are asked to accept or reject it.') : t.pic_state === 'PENDING' ? `${first(c.name(t.pic_id))} has not accepted yet.` : undefined;
  return (
    <>
      <BackBar c={c} title={t ? 'Edit task' : 'New task'} />
      <form className="form" onSubmit={submit} noValidate ref={formRef}>
        {t && !target && <p className="hint small">Choose a different reviewer for a detail change to a task you manage alone. The change takes effect after approval.</p>}{target && <div className="callout tone-info"><strong><Scale aria-hidden="true" className="inline-icon" />Changes need {first(c.name(target))}’s approval.</strong> When you save, your changes are sent to {first(c.name(target))}; the task stays as it is until they approve.</div>}
        {locked && <div className="callout tone-neutral">You are the person in charge: you can change the expectation, supporting people and department note. Ask {first(c.name(t?.reviewer_id))} to change the rest, or use “Hand over” in the task.</div>}
        <LField label="Title" required><input className="input" value={d.title} maxLength={300} disabled={locked} onChange={e => set('title', e.target.value)} aria-required="true" aria-invalid={bad('title')} data-field="title" /></LField>
        <LField label="Workspace" required><select className="input" value={d.workspace_id} disabled={!!t} aria-invalid={bad('workspace_id')} data-field="workspace_id" onChange={e => { setOutside(false); const v = e.target.value; setD(s => ({ ...s, workspace_id: v, department: wss.find(w => w.id === v)?.department || s.department })); setInvalid(l => l.filter(x => x !== 'workspace_id')); }}>{wss.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <span className="hint small">{governed ? 'Invite to this task only. Workspace membership is approved separately.' : memberOf(d.workspace_id).includes(c.me) ? 'People you choose below are added to the workspace automatically.' : 'You aren’t a member of this workspace: choose its members, or ask its owner to add you.'}</span></LField>
        <PersonSelect c={c} label="Person in charge" required value={d.pic_id} people={everyone} disabled={locked} hint={picHint} invalid={bad('pic_id')} field="pic_id" empty={pickerEmpty}
          onChange={v => { setD(s => ({ ...s, pic_id: v, supporter_ids: (s.supporter_ids || []).filter((x: string) => x !== v) })); setInvalid(l => l.filter(x => x !== 'pic_id')); }} />
        {governed && <label className="switch-row"><span><strong>Select outside workspace</strong><span className="hint">Invites are for this task only. Membership requires a separate approval.</span></span><input type="checkbox" checked={outside} disabled={!ws?.org_access?.can_collaborate_outside} onChange={e => setOutside(e.target.checked)} /></label>}
        <PeopleSelect c={c} label="Supporting people (optional)" value={d.supporter_ids || []} people={everyone.filter(p => p.id !== d.pic_id)} onChange={v => set('supporter_ids', v)} note={t ? supportNote : undefined} empty={pickerEmpty}
          hint="Each supporting person is asked to accept or reject." />
        <PersonSelect c={c} label="Reviewer" required value={d.reviewer_id} people={everyone} disabled={locked} invalid={bad('reviewer_id')} field="reviewer_id" empty={pickerEmpty}
          hint={t && t.reviewer_status === 'DECLINED' && d.reviewer_id === t.reviewer_id ? `${first(c.name(t.reviewer_id))} rejected reviewing. Choose someone else.` : 'Reviews the work when it is submitted and decides due date requests.'} onChange={v => set('reviewer_id', v)} />
        <LField label="Due date" required><input className="input" type="date" value={d.due_date} disabled={locked} min={t?.start_date} aria-invalid={bad('due_date')} data-field="due_date" onChange={e => set('due_date', e.target.value)} />{d.due_date && <span className="hint small">{dayInWords(d.due_date)}</span>}</LField>
        {!locked && <div className="chips wrap" role="group" aria-label="Quick due dates">{[[0, 'Today'], [1, 'Tomorrow'], [3, 'In 3 days'], [7, 'In a week']].map(([n, l]) => <button key={n} type="button" className="chip" aria-pressed={d.due_date === addDays(taskToday(), n as number)} onClick={() => set('due_date', addDays(taskToday(), n as number))}>{l}</button>)}</div>}
        {t?.recurrence && d.recurrence === t.recurrence && d.due_date !== t.due_date && !locked && <label className="check-row"><input type="checkbox" checked={!!d.move_series} onChange={e => set('move_series', e.target.checked)} /><span><strong>Move the whole series to this date</strong><span className="hint small">{d.move_series ? 'The following tasks are planned from this date.' : 'Off: only this task moves; the following ones keep their planned dates.'}</span></span></label>}
        <fieldset className="field"><legend className="label">Priority</legend><div className="chips">{[['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']].map(([v, l]) => <button key={v} type="button" className="chip" disabled={locked} aria-pressed={d.priority === v} onClick={() => set('priority', v)}>{l}</button>)}</div></fieldset>
        <LField label="Repeat"><select className="input" value={d.recurrence || ''} disabled={locked} onChange={e => set('recurrence', e.target.value)}>{Object.entries(RECURRENCE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <span className="hint small">{d.recurrence ? 'When this task is closed, the next one is created with the same people and steps.' : 'For regular work, such as a weekly report.'}</span></LField>
        <RecurrenceFields frequency={d.recurrence || ''} value={d.recurrence_rule} due={d.due_date} disabled={locked} onChange={v => set('recurrence_rule',v)} />
        {d.recurrence && <LField label="Repeat until (optional)"><input className="input" type="date" value={d.recurrence_until || ''} disabled={locked} min={d.due_date} onChange={e => set('recurrence_until', e.target.value)} />{d.recurrence_until && <span className="hint small">{dayInWords(d.recurrence_until)}</span>}</LField>}
        <LField label="Expectation *"><textarea required className="input" rows={3} value={d.description || ''} maxLength={8000} placeholder="The result you expect, and how you’ll know it is done" onChange={e => set('description', e.target.value)} /></LField>
        {!t && <fieldset className="field"><legend className="label">Steps of work (optional)</legend>
          {(d.checklist || []).length > 0 && <ol className="checklist draft">{(d.checklist as string[]).map((s, i) => <li key={`${i}-${s}`}><span className="check-text">{s}</span><button type="button" className="icon-btn small" aria-label={`Remove “${s}”`} onClick={() => set('checklist', (d.checklist as string[]).filter((_, n) => n !== i))}><X aria-hidden="true" /></button></li>)}</ol>}
          <div className="inline-add"><input className="input" value={step} maxLength={300} placeholder="Add a step, e.g. “Get quotes”" aria-label="New step of work" onChange={e => setStep(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } }} /><button type="button" className="btn small" disabled={!step.trim()} onClick={addStep}><Plus aria-hidden="true" />Add</button></div>
          <span className="hint small">Ticking a step tells the assigner. Steps don’t change progress.</span>
        </fieldset>}
        <LField label="Department"><input className="input" value={d.department || ''} maxLength={150} disabled={locked} onChange={e => set('department', e.target.value)} /></LField>
        <LField label="Department note"><textarea className="input" rows={2} value={d.department_note || ''} maxLength={2000} placeholder="Which team is involved and anything they should know" onChange={e => set('department_note', e.target.value)} /></LField>
        {!t && <fieldset className="field"><legend className="label">Deadline reminders</legend>
          <div className="chips wrap" role="group" aria-label="Remind before the due date">{[...new Set([...REMINDER_PRESETS, ...reminderDays(d.reminder_days)])].sort((a, b) => a - b).map(n => <button key={n} type="button" className="chip" aria-pressed={reminderDays(d.reminder_days).includes(n)} onClick={() => { const l = reminderDays(d.reminder_days); set('reminder_days', l.includes(n) ? l.filter((x: number) => x !== n) : [...l, n]); }}>{n} day{n === 1 ? '' : 's'} before</button>)}</div>
          <div className="inline-add"><input className="input" inputMode="numeric" value={otherDay} placeholder="Other: days before" aria-label="Other reminder, days before the due date" onChange={e => setOtherDay(e.target.value.replace(/[^0-9]/g, ''))} /><button type="button" className="btn small" disabled={!otherDay || Number(otherDay) < 1 || Number(otherDay) > 90 || reminderDays(d.reminder_days).length >= 5} onClick={() => { set('reminder_days', [...reminderDays(d.reminder_days), Number(otherDay)]); setOtherDay(''); }}><Plus aria-hidden="true" />Add</button></div>
          <span className="hint small">{reminderDays(d.reminder_days).length ? `Everyone on the task is reminded ${reminderText(d.reminder_days)}.` : 'No reminders before the due date.'}</span>
        </fieldset>}
        {target && <LField label={`Reason for the change (for ${first(c.name(target))})`}><textarea className="input" rows={2} value={d.change_note || ''} maxLength={1000} placeholder="Optional" onChange={e => set('change_note', e.target.value)} /></LField>}
        <FormFoot error={error}><button type="submit" className="btn primary block" disabled={busy}>{busy ? 'Saving…' : t ? (target ? 'Send for approval' : 'Save changes') : 'Create task'}</button></FormFoot>
      </form>
    </>
  );
}

// ------------------------------------------------------------------ requests (anyone can ask anyone)
// V5.6.8: the person using the app is "you", not their own first name.
const doerText = (c: Ctx, q: Row, lower = false) => { const who = (id: string) => c.who(id, lower), verb = (id: string, v: string, you: string) => `${who(id)} ${id === c.me ? you : v}`;
  return (q.doer || 'REQUESTER') === 'RECEIVER' ? verb(q.manager_id, 'does it', 'do it') : q.doer === 'DECIDE' ? verb(q.manager_id, 'decides who does it', 'decide who does it') : verb(q.requested_by, 'does it', 'do it'); };
function RequestList({ c }: { c: Ctx }) {
  const all: Row[] = c.data.tm_requests || [], decide = all.filter(q => q.manager_id === c.me && q.status === 'PENDING'), mine = all.filter(q => q.requested_by === c.me), toMe = all.filter(q => q.manager_id === c.me);
  // V5.6.8: the chosen list is kept while the app is open (going back from a request keeps it).
  const [tab, setTabState] = useState(requestMemory.tab || (decide.length ? 'decide' : 'mine')), setTab = (v: string) => { requestMemory.tab = v; setTabState(v); };
  const list = (tab === 'decide' ? decide : tab === 'to-me' ? toMe : mine).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return (
    <>
      <Header title="Requests" subtitle="Ask anyone for a task, or answer requests sent to you." action={<button type="button" className="icon-btn filled" onClick={() => c.open({ kind: 'request-form' })} aria-label="Request a task"><Plus aria-hidden="true" /></button>} />
      <Chips label="Requests" value={tab} onChange={setTab} options={[['decide', 'Waiting for me', decide.length], ['mine', 'My requests', mine.length], ['to-me', 'Sent to me', toMe.length]]} />
      {list.length ? <div className="list">{list.map(q => {
        const other = tab === 'mine' ? q.manager_id : q.requested_by;
        return (
          <button key={q.id} type="button" className="list-row" onClick={() => c.open({ kind: 'request', id: q.id })}>
            <Avatar name={c.name(other)} src={c.photo(other)} size="sm" />
            <span className="row-main"><span className="row-title">{q.title}</span><span className="row-meta">{tab === 'mine' ? `To ${first(c.name(q.manager_id))}` : `From ${first(c.name(q.requested_by))}`} · {doerText(c, q, true)}{q.proposed_due_date ? ` · needed by ${fmtDay(q.proposed_due_date)}` : ''}</span><span className="row-foot"><Badge label={REQUEST_STATUS[q.status as keyof typeof REQUEST_STATUS]} tone={REQ_TONE[q.status]} /></span></span>
            <ChevronRight className="chev" aria-hidden="true" />
          </button>
        );
      })}</div> : <Empty icon={Inbox} title={tab === 'decide' ? 'No requests are waiting for you' : tab === 'to-me' ? 'Nobody has sent you a request yet' : 'You have not requested any tasks'} text={tab === 'mine' ? 'Ask anyone for work you need done, or ask to take something on. They accept it (it becomes a task) or explain why not.' : undefined}
        action={tab === 'mine' ? <button type="button" className="btn primary" onClick={() => c.open({ kind: 'request-form' })}><Send aria-hidden="true" />Request a task</button> : undefined} />}
    </>
  );
}
function RequestView({ c, id }: { c: Ctx; id: string }) {
  const q: Row | undefined = (c.data.tm_requests || []).find((x: Row) => x.id === id);
  if (!q) return <><BackBar c={c} title="Request" /><Empty icon={CircleSlash} title="Request not found" /></>;
  const pending = q.status === 'PENDING', asked = q.manager_id === c.me, requester = q.requested_by === c.me, doer = q.doer || 'REQUESTER';
  const wss: [string, string][] = (c.data.tm_workspaces || []).filter((w: Row) => w.status === 'ACTIVE').map((w: Row) => [w.id, w.name]);
  const mineWs = wss.filter(([wid]) => (c.data.tm_members || []).some((m: Row) => m.workspace_id === wid && m.staff_id === c.me));
  const everyone = peopleList(c, { include: [q.requested_by] });
  const accept = () => c.sheet({
    title: doer === 'REQUESTER' ? 'Approve and create the task' : 'Accept and create the task',
    description: doer === 'RECEIVER' ? `You take charge and ${first(c.name(q.requested_by))} reviews it.` : doer === 'REQUESTER' ? `${first(c.name(q.requested_by))} takes charge and you review it.` : 'Choose who takes charge. You review it.',
    fields: [{ key: 'workspace_id', label: 'Workspace', type: 'select', required: true, options: wss }, { key: 'pic_id', label: 'Person in charge', type: 'person', required: true, people: everyone, hint: 'Anyone who is not you or the requester is asked to accept.' }, { key: 'due_date', label: 'Due date', type: 'date', required: true, min: taskToday() }, { key: 'note', label: 'Note (optional)', type: 'textarea' }],
    initial: { workspace_id: q.workspace_id || (mineWs.length === 1 ? mineWs[0][0] : wss.length === 1 ? wss[0][0] : ''), pic_id: doer === 'RECEIVER' ? c.me : doer === 'REQUESTER' ? q.requested_by : '', due_date: q.proposed_due_date && q.proposed_due_date >= taskToday() ? q.proposed_due_date : addDays(taskToday(), 7) },
    confirm: doer === 'REQUESTER' ? 'Approve' : 'Accept', run: async v => { const r = await c.perform('tm.request.decide', { id: q.id, decision: 'APPROVE', expected_version: q.version, ...v }); c.back(); if (r.id) c.open({ kind: 'task', id: r.id }); },
  });
  const passTo = peopleList(c, { exclude: [c.me, q.requested_by] });
  const ws = q.workspace_id ? (c.data.tm_workspaces || []).find((w: Row) => w.id === q.workspace_id)?.name : '';
  return (
    <>
      <BackBar c={c} title={q.id} />
      <header className="detail-head"><h1>{q.title}</h1><p className="hint">{fmtTime(q.created_at)}</p><div className="detail-status"><Badge label={REQUEST_STATUS[q.status as keyof typeof REQUEST_STATUS]} tone={REQ_TONE[q.status]} /><PriorityBadge p={q.priority} /></div></header>
      {q.status === 'DECLINED' && <div className="callout tone-warning"><strong>Declined by {first(c.name(q.decided_by))}:</strong> {q.decision_note}</div>}
      {q.status === 'APPROVED' && q.task_id && <div className="callout tone-success"><strong>Accepted as {q.task_id}.</strong> <button type="button" className="link" onClick={() => c.open({ kind: 'task', id: q.task_id })}>Open the task</button></div>}
      {pending && asked && <div className="callout tone-info"><strong>This request is waiting for your answer.</strong> {doer === 'RECEIVER' ? `${first(c.name(q.requested_by))} asks you to do this.` : doer === 'DECIDE' ? 'Accept it and choose who does it.' : `${first(c.name(q.requested_by))} asks to take this on.`}</div>}
      <ul className="people">
        <li><Avatar name={c.name(q.requested_by)} src={c.photo(q.requested_by)} /><span className="person-text"><strong>{c.name(q.requested_by)}</strong><span className="hint">From{requester ? ' · you' : ''}</span></span></li>
        <li><Avatar name={c.name(q.manager_id)} src={c.photo(q.manager_id)} /><span className="person-text"><strong>{c.name(q.manager_id)}</strong><span className="hint">Asked{asked ? ' · you' : ''}</span></span></li>
      </ul>
      <dl className="facts">
        <div><dt>Who does it</dt><dd>{doerText(c, q)}</dd></div>
        <div><dt>Needed by</dt><dd>{q.proposed_due_date ? fmtDay(q.proposed_due_date) : 'Not set'}</dd></div>
        <div><dt>Workspace</dt><dd>{ws || 'Chosen when accepted'}</dd></div>
        {q.department && <div><dt>Department</dt><dd>{q.department}</dd></div>}
      </dl>
      {q.department_note && <p className="note-block"><span className="label">Department note</span>{q.department_note}</p>}
      {q.description && <p className="note-block"><span className="label">Expectation</span>{q.description}</p>}
      {pending && (asked || requester) && <div className="action-list">
        {asked && <><button type="button" className="btn primary block" onClick={accept}><Check aria-hidden="true" />{doer === 'REQUESTER' ? 'Approve…' : 'Accept…'}</button>
          <button type="button" className="btn block" onClick={() => c.sheet({ title: 'Decline this request', description: `${first(c.name(q.requested_by))} will see your reason.`, fields: [{ key: 'note', label: 'Reason', type: 'textarea', required: true }], confirm: 'Decline', tone: 'danger', run: v => c.perform('tm.request.decide', { id: q.id, decision: 'DECLINE', expected_version: q.version, ...v }) })}><XCircle aria-hidden="true" />Decline…</button>
          {passTo.length > 0 && <button type="button" className="btn block" onClick={() => c.sheet({ title: 'Pass this request to someone else', description: 'They receive it with your note; the requester is told.', fields: [{ key: 'manager_id', label: 'Pass it to', type: 'person', required: true, people: passTo }, { key: 'note', label: 'Note (optional)', type: 'textarea' }], confirm: 'Pass on', run: v => c.perform('tm.request.forward', { id: q.id, expected_version: q.version, ...v }) })}><Send aria-hidden="true" />Pass to someone else…</button>}</>}
        {requester && <><button type="button" className="btn block" onClick={() => c.open({ kind: 'request-form', id: q.id })}><ClipboardList aria-hidden="true" />Edit request</button>
          <button type="button" className="btn danger block" onClick={() => c.sheet({ title: 'Withdraw this request?', fields: [], confirm: 'Withdraw', tone: 'danger', run: () => c.perform('tm.request.withdraw', { id: q.id, expected_version: q.version }) })}><CircleSlash aria-hidden="true" />Withdraw</button></>}
      </div>}
    </>
  );
}
function RequestForm({ c, id }: { c: Ctx; id?: string }) {
  const old: Row | undefined = id ? (c.data.tm_requests || []).find((x: Row) => x.id === id) : undefined;
  const [d, setD] = useState<Row>(() => old ? { ...old, doer: old.doer || 'REQUESTER', workspace_id: old.workspace_id || '', proposed_due_date: old.proposed_due_date || '' }
    : { title: '', manager_id: '', doer: 'RECEIVER', workspace_id: '', proposed_due_date: addDays(taskToday(), 7), priority: 'MEDIUM', description: '', department: (c.data.tm_profiles || []).find((p: Row) => p.staff_id === c.me)?.department || '', department_note: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState<string[]>([]), doerName = useId(), formRef = useRef<HTMLFormElement>(null);
  const { saved } = useDirty(d);
  const people = peopleList(c, { include: [d.manager_id], exclude: [c.me] });
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setError(''); setInvalid(l => l.filter(x => x !== k)); };
  const asked = d.manager_id ? first(c.name(d.manager_id)) : '';
  const choices: [string, string, string][] = [
    ['RECEIVER', asked ? `${asked} does it` : 'They do it', 'The person you ask takes charge when they accept. You review the work.'],
    ['REQUESTER', 'I do it', 'You ask to take this on. When they approve, you are in charge and they review it.'],
    ['DECIDE', asked ? `${asked} decides who does it` : 'They decide who does it', 'The person you ask chooses who takes charge when they accept.'],
  ];
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!String(d.description || '').trim()) { setError('Expectation is required.'); return; } setError('');
    const missing = [!d.title?.trim() && 'title', !d.manager_id && 'manager_id'].filter(Boolean) as string[];
    if (missing.length) { setInvalid(missing); setError(missingText(missing.includes('title') ? ['what you need'] : [], missing.includes('manager_id') ? ['who you are asking'] : [])); focusField(formRef.current, missing[0]); return; }
    setBusy(true);
    try { await c.perform('tm.request.save', { ...d, id: old?.id, expected_version: old?.version, workspace_id: d.workspace_id || null, proposed_due_date: d.proposed_due_date || null, request_key: old ? undefined : uuid() }); saved(); c.back(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <BackBar c={c} title={old ? 'Edit request' : 'Request a task'} />
      <form className="form" onSubmit={submit} noValidate ref={formRef}>
        {!people.length && <div className="callout tone-warning">Nobody else uses Task Management yet. Ask an administrator to create logins for your colleagues.</div>}
        <LField label="What do you need?" required><input className="input" value={d.title} maxLength={300} onChange={e => set('title', e.target.value)} aria-required="true" aria-invalid={invalid.includes('title') || undefined} data-field="title" placeholder="Short title" /></LField>
        <PersonSelect c={c} label="Ask" required value={d.manager_id} people={people} onChange={v => set('manager_id', v)} invalid={invalid.includes('manager_id')} field="manager_id" placeholder="Choose who you are asking" hint="Anyone who uses Task Management, whatever their role." />
        <fieldset className="field"><legend className="label">Who should do it?</legend>
          <div className="choice-list">{choices.map(([v, label, hint]) => (
            <label key={v} className="choice"><input type="radio" name={doerName} value={v} checked={d.doer === v} onChange={() => set('doer', v)} /><span><strong>{label}</strong><span className="hint small">{hint}</span></span></label>
          ))}</div>
        </fieldset>
        <LField label="Workspace"><select className="input" value={d.workspace_id} onChange={e => set('workspace_id', e.target.value)}><option value="">Let them choose</option>{(c.data.tm_workspaces || []).filter((w: Row) => w.status === 'ACTIVE').map((w: Row) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></LField>
        <LField label="Needed by"><input className="input" type="date" value={d.proposed_due_date} min={taskToday()} onChange={e => set('proposed_due_date', e.target.value)} /><span className="hint small">{d.proposed_due_date ? `${dayInWords(d.proposed_due_date)}. ` : ''}Optional. The final due date is set when the request is accepted.</span></LField>
        <fieldset className="field"><legend className="label">Priority</legend><div className="chips">{[['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']].map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={d.priority === v} onClick={() => set('priority', v)}>{l}</button>)}</div></fieldset>
        <LField label="Expectation *"><textarea required className="input" rows={3} value={d.description} maxLength={8000} onChange={e => set('description', e.target.value)} /></LField>
        <LField label="Department"><input className="input" value={d.department} maxLength={150} onChange={e => set('department', e.target.value)} /></LField>
        <LField label="Department note"><textarea className="input" rows={2} value={d.department_note} maxLength={2000} onChange={e => set('department_note', e.target.value)} /></LField>
        <FormFoot error={error}><button type="submit" className="btn primary block" disabled={busy || !people.length}>{busy ? 'Sending…' : old ? 'Save request' : 'Send request'}</button></FormFoot>
      </form>
    </>
  );
}

// ------------------------------------------------------------------ reports
function ReportView({ c }: { c: Ctx }) {
  // V5.6.8: the month, scope and category (and the last report) are kept while the app is open, so going back from a
  // task lands on the same list.
  const [month, setMonthState] = useState(reportMemory.month || currentMonth()), [scope, setScopeState] = useState<'me' | 'all'>(reportMemory.scope), [cat, setCatState] = useState(reportMemory.cat);
  const setMonth = (v: string) => { reportMemory.month = v; setMonthState(v); }, setScope = (v: 'me' | 'all') => { reportMemory.scope = v; setScopeState(v); }, setCat = (v: string) => { reportMemory.cat = v; setCatState(v); };
  const scopeRevision = c.data.task_scope?.revision, cacheKey = `${month}:${scope}`;
  const [storedReport, setStored] = useState<{ data: Row; revision?: string } | null>(() => (reportCache?.key === cacheKey ? reportCache : null)), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const setReport = (r: { data: Row; revision?: string } | null) => { reportCache = r ? { ...r, key: cacheKey } : null; setStored(r); };
  // Never render a cached report from an earlier authority, even while the replacement request is in flight.
  const report = storedReport?.revision === scopeRevision ? storedReport?.data : null;
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    call(`/report?report=monthly&month=${month}&scope=${scope}`).then(r => { if (live) setReport({ data: r, revision: scopeRevision }); }).catch(e => { if (live) { setReport(null); setError((e as Error).message); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month, scope, c.data.change_seq, scopeRevision]);
  const label = monthBounds(month).label, rows = (report?.rows || []).filter((r: Row) => r.category === cat);
  const icons: Record<string, LucideIcon> = { completed: Check, in_progress: PlayCircle, stuck: Hand, overdue: AlertTriangle };
  const tones: Record<string, string> = { completed: 'success', in_progress: 'info', stuck: 'danger', overdue: 'warning' };
  return (
    <>
      <Header title="Monthly report" subtitle={scope === 'me' ? 'Tasks you are in charge of or supporting' : c.data.task_scope?.company ? 'All tasks in the company' : 'Tasks within your visibility scope'} />
      <div className="month-nav">
        <button type="button" className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft aria-hidden="true" /></button>
        <strong aria-live="polite">{label}{month === currentMonth() ? ' (so far)' : ''}</strong>
        <button type="button" className="icon-btn" disabled={month >= currentMonth()} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight aria-hidden="true" /></button>
      </div>
      {c.can('tasks.reports') && <Chips label="Scope" value={scope} onChange={setScope} options={[['me', 'My tasks'], ['all', 'Company']]} />}
      {error ? <div className="callout tone-danger">{error}</div> : <>
        <div className={`tiles report-tiles${loading ? ' is-loading' : ''}`} role="group" aria-label="Categories">
          {MONTHLY_CATEGORIES.map(([key, name]) => { const Icon = icons[key]; return <button key={key} type="button" className={`tile tone-${tones[key]}`} aria-pressed={cat === key} onClick={() => setCat(key)}><Icon aria-hidden="true" className="tile-icon" /><span className="tile-value">{report?.summary?.[key] ?? '–'}</span><span className="tile-label">{name}</span></button>; })}
        </div>
        <Section title={MONTHLY_CATEGORIES.find(x => x[0] === cat)?.[1] || ''} count={rows.length}>
          {rows.length ? <div className="list">{rows.map((r: Row) => {
            const t = c.tasks.find(x => x.id === r.id);
            return <button key={r.id} type="button" className="list-row" disabled={!t} onClick={() => t && c.open({ kind: 'task', id: r.id })}><span className={`state-dot tone-${tones[cat]}`} aria-hidden="true" /><span className="row-main"><span className="row-title">{r.title}</span><span className="row-meta">{first(r.pic)} · {r.detail}</span></span>{t && <ChevronRight className="chev" aria-hidden="true" />}</button>;
          })}</div> : <Empty icon={PieChart} title={loading ? 'Loading…' : 'No tasks in this category'} />}
        </Section>
        <p className="hint small footnote">Completed: closed during the month. In progress: in progress or in review at month end (or today), not stuck. Stuck: marked stuck at any time in the month. Overdue: open past the due date at month end, or completed late.</p>
      </>}
    </>
  );
}

// ------------------------------------------------------------------ calendar (V5.5.1)
// The same calendar as in the Task Controlling Management, for a phone: meetings (the ones you take part in or that are shared with you), task
// deadlines within your Task Visibility Scope, and your own notes, in your time zone. Meetings and notes can be added
// and changed here; the Task Controlling Management's rules decide who may do what (participants change a meeting, only you see your notes).
type CalKind = 'meeting' | 'task' | 'note';
type CalItem = { key: string; kind: CalKind; title: string; day: string; endDay: string; allDay: boolean; start?: string; end?: string; row: Row; done?: boolean; overdue?: boolean; meta: string };
const CAL_KINDS: [CalKind, string, LucideIcon][] = [['meeting', 'Meetings', Video], ['task', 'Deadlines', ClipboardCheck], ['note', 'My notes', NotebookPen]];
const CAL_ICON: Record<CalKind, LucideIcon> = { meeting: Video, task: ClipboardCheck, note: NotebookPen };
// What the calendar showed last (kept while the app is open, so going back to it lands on the same day).
const calMemory: { day: string; view: 'month' | 'agenda'; kinds: CalKind[]; mine: boolean } = { day: '', view: 'month', kinds: ['meeting', 'task', 'note'], mine: false };
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LONG_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const longDay = (d: string) => LONG_DAY.format(new Date(`${d}T12:00:00Z`));
const weekdayOf = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
const shiftMonths = (d: string, n: number) => { const [y, m] = d.split('-').map(Number), i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`; };
const OFFSETS: [number, string][] = [[0, 'At the start'], [15, '15 min before'], [60, '1 hour before'], [1440, '1 day before'], [2880, '2 days before']];
const offsetText = (n: number) => n === 0 ? 'at the start' : n % 1440 === 0 ? `${n / 1440} day${n === 1440 ? '' : 's'} before` : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'} before` : `${n} minutes before`;
const offsetsOf = (v: unknown): number[] => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter(n => Number.isInteger(n) && n >= 0) : []; } catch { return []; } };
const remindersText = (v: unknown) => { const l = [...new Set(offsetsOf(v))].sort((a, b) => b - a); return l.length ? l.map(offsetText).join(', ') : 'No reminders'; };
const attendeesOf = (c: Ctx, id: string): string[] => (c.data.tm_attendees || []).filter((a: Row) => a.meeting_id === id).map((a: Row) => a.staff_id);
const sharesOf = (c: Ctx, id: string): string[] => (c.data.tm_meeting_shares || []).filter((s: Row) => s.meeting_id === id).map((s: Row) => s.staff_id);
/** The organizer, the attendees and whoever scheduled it take part; others see a meeting only when it is shared with them. */
const takesPart = (c: Ctx, m: Row) => m.organizer_id === c.me || m.created_by === c.me || attendeesOf(c, m.id).includes(c.me);
const MEETING_STATUS: Record<string, [string, string]> = { SCHEDULED: ['Scheduled', 'info'], COMPLETED: ['Completed', 'success'], CANCELLED: ['Cancelled', 'neutral'] };
const SHARE_CHOICES: [string, string, string][] = [
  ['PARTICIPANTS', 'Participants only', 'The organizer and the people invited.'],
  ['SELECTED', 'Participants and people I choose', 'Choose who else can see it below.'],
];
const shareText = (c: Ctx, m: Row) => {
  const ws = (c.data.tm_workspaces || []).find((w: Row) => w.id === m.workspace_id)?.name || 'the workspace', n = sharesOf(c, m.id).length;
  return m.share_scope === 'SELECTED' ? `Participants and ${n} other ${n === 1 ? 'person' : 'people'}` : 'Participants only';
};
/** Everything a meeting change sends: the meeting as it is, with the changes on top (the server checks it all again). */
const meetingPayload = (c: Ctx, m: Row, patch: Row = {}): Row => ({
  id: m.id, expected_version: m.version, workspace_id: m.workspace_id, title: m.title, agenda: m.agenda || '', organizer_id: m.organizer_id, attendee_ids: attendeesOf(c, m.id),
  start_at: m.start_at, end_at: m.end_at, location: m.location || '', url: m.url || '', status: m.status, minutes_notes: m.minutes_notes || '', reason: m.reason || '',
  share_scope: m.share_scope === 'SELECTED' ? 'SELECTED' : 'PARTICIPANTS', share_ids: sharesOf(c, m.id), reminder_offsets: offsetsOf(m.reminder_offsets), ...patch,
});
const minutesOf = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** A new start time keeps the meeting's length (on one day); otherwise the end stays as it was. */
const keepLength = (from: string, to: string, next: string, longer: boolean) => {
  if (longer || !from || !to || !next) return to;
  const length = minutesOf(to) - minutesOf(from), end = minutesOf(next) + length;
  return length > 0 && end < 24 * 60 ? `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}` : to;
};
const openLink = (url: string) => { try { const app = tgApp(); if (typeof app?.openLink === 'function') { app.openLink(url); return; } } catch { /* fall back */ } window.open(url, '_blank', 'noopener'); };

function calendarItems(c: Ctx, mine: boolean): CalItem[] {
  const out: CalItem[] = [];
  for (const m of c.data.tm_meetings || []) {
    if (m.status === 'CANCELLED') continue;
    const people = attendeesOf(c, m.id), part = takesPart(c, m);
    if (mine && !part) continue;
    out.push({ key: `m:${m.id}`, kind: 'meeting', title: m.title, day: dayOf(m.start_at), endDay: dayOf(m.end_at), allDay: false, start: m.start_at, end: m.end_at, row: m, done: m.status === 'COMPLETED',
      meta: [m.location, `${people.length} ${people.length === 1 ? 'person' : 'people'}`, part ? '' : 'shared with you'].filter(Boolean).join(' · ') });
  }
  for (const t of c.tasks) {
    if (t.status === 'CANCELLED' || !t.calendar_visible) continue;
    out.push({ key: `t:${t.id}`, kind: 'task', title: t.title, day: t.due_date, endDay: t.due_date, allDay: true, row: t, overdue: t.overdue, done: t.status === 'COMPLETED', meta: `Due · ${c.who(t.pic_id)} · ${taskStateLabel(t)}${involved(t) ? '' : ' · viewing only'}` });
  }
  for (const n of c.data.tm_calendar_notes || []) out.push({ key: `n:${n.id}`, kind: 'note', title: n.title, day: n.all_day ? n.day : dayOf(n.start_at), endDay: n.all_day ? n.day : dayOf(n.end_at || n.start_at), allDay: !!n.all_day,
    start: n.start_at || undefined, end: n.end_at || undefined, row: n, done: !!n.done, meta: 'Only you can see this note' });
  // All-day items first (deadlines, then notes), then by time.
  return out.sort((x, y) => x.day.localeCompare(y.day) || Number(y.allDay) - Number(x.allDay) || (x.start || '').localeCompare(y.start || '') || x.title.localeCompare(y.title));
}
const itemsOn = (items: CalItem[], day: string) => items.filter(i => i.day <= day && i.endDay >= day);
const whenText = (i: CalItem, day: string) => i.allDay ? (i.kind === 'task' ? (i.overdue ? 'Overdue' : 'Due') : 'All day') : i.day !== i.endDay && day !== i.day ? (day === i.endDay ? `until ${hm(i.end)}` : 'All day') : hm(i.start);
function CalRow({ c, i, day }: { c: Ctx; i: CalItem; day: string }) {
  const Icon = CAL_ICON[i.kind];
  const open = () => (i.kind === 'meeting' ? c.open({ kind: 'meeting', id: i.row.id }) : i.kind === 'task' ? c.open({ kind: 'task', id: i.row.id }) : c.open({ kind: 'note-form', id: i.row.id }));
  const until = !i.allDay && i.end && i.kind !== 'task' && i.day === i.endDay ? `–${hm(i.end)}` : '';
  return (
    <button type="button" className={`list-row cal-row${i.done ? ' is-done' : ''}`} onClick={open}>
      <span className={`cal-bar kind-${i.kind}${i.overdue ? ' is-overdue' : ''}`} aria-hidden="true" />
      <span className="cal-when"><span>{whenText(i, day)}</span>{until && <span className="hint small">{until}</span>}</span>
      <span className="row-main">
        <span className="row-title"><Icon aria-hidden="true" className="inline-icon" />{i.title}<span className="sr-only">, {i.kind === 'meeting' ? 'meeting' : i.kind === 'task' ? 'task deadline' : 'your note'}{i.done ? ', done' : ''}</span></span>
        <span className="row-meta">{i.meta}</span>
      </span>
      <ChevronRight className="chev" aria-hidden="true" />
    </button>
  );
}

/** Lets Telegram's Back button (and Escape) close something that is not a sheet, such as the day panel (V5.6.8). */
function BackLayer({ onClose }: { onClose: () => void }) { useLayer(onClose); return null; }
function CalendarView({ c }: { c: Ctx }) {
  const today = calToday();
  const [st, setSt] = useState(() => ({ ...calMemory, day: calMemory.day || today }));
  const [panelDay, setPanelDay] = useState<string | null>(null);
  useEffect(() => setPanelDay(null), [st.view, st.mine, st.kinds]);
  const set = (patch: Partial<typeof calMemory>) => setSt(s => { const next = { ...s, ...patch }; Object.assign(calMemory, next); return next; });
  const gridRef = useRef<HTMLTableElement>(null);
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const ignoreClickUntil = useRef(0);
  const all = useMemo(() => calendarItems(c, st.mine), [c.data, c.tasks, st.mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = all.filter(i => st.kinds.includes(i.kind));
  const canMeet = c.can('tasks.meetings', 'create') && creatableWorkspaces(c).length > 0, meetings = c.can('tasks.meetings');
  const month = monthOf(st.day), weeks: string[][] = [];
  const start = addDays(month, -weekdayOf(month));
  for (let wk = 0; wk < 6; wk++) { const row = Array.from({ length: 7 }, (_, k) => addDays(start, wk * 7 + k)); if (wk > 3 && row[0].slice(0, 7) !== month.slice(0, 7)) break; weeks.push(row); }
  const pick = (day: string, focus = false) => { set({ day }); if (focus) window.requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus()); };
  const startSwipe = (e: ReactTouchEvent<HTMLTableElement>) => {
    ignoreClickUntil.current = 0;
    const touch = e.touches[0];
    swipe.current = e.touches.length === 1 ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
  };
  const moveSwipe = (e: ReactTouchEvent<HTMLTableElement>) => {
    const start = swipe.current, touch = Array.from(e.touches).find(t => t.identifier === start?.id);
    if (!start || !touch || e.touches.length !== 1) { swipe.current = null; return; }
    // Let a vertical scroll or a pinch keep its normal behavior without changing the month.
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) swipe.current = null;
  };
  const endSwipe = (e: ReactTouchEvent<HTMLTableElement>) => {
    const start = swipe.current;
    swipe.current = null;
    const touch = Array.from(e.changedTouches).find(t => t.identifier === start?.id);
    if (!start || !touch || e.touches.length) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // A swipe must not also select whichever day was under the finger.
    ignoreClickUntil.current = Date.now() + 500;
    pick(shiftMonths(st.day, dx < 0 ? 1 : -1));
  };
  const keys = (e: ReactKeyboardEvent<HTMLButtonElement>, day: string) => {
    const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (by[e.key] !== undefined) { e.preventDefault(); pick(addDays(day, by[e.key]), true); }
    else if (e.key === 'Home') { e.preventDefault(); pick(addDays(day, -weekdayOf(day)), true); }
    else if (e.key === 'End') { e.preventDefault(); pick(addDays(day, 6 - weekdayOf(day)), true); }
    else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); pick(shiftMonths(day, e.key === 'PageUp' ? -1 : 1), true); }
  };
  const toggleKind = (k: CalKind) => set({ kinds: st.kinds.includes(k) ? st.kinds.filter(x => x !== k) : [...st.kinds, k] });
  const kinds = CAL_KINDS.filter(([k]) => k !== 'meeting' || meetings);
  const agendaDays: [string, CalItem[]][] = [];
  if (st.view === 'agenda') for (let d = today, n = 0; n < 30; n++, d = addDays(d, 1)) { const l = itemsOn(items, d); if (l.length) agendaDays.push([d, l]); }
  return (
    <>
      <Header title="Calendar" subtitle={`Times in ${zoneName()}`} action={<button type="button" className="chip head-chip" aria-pressed={st.mine} onClick={() => set({ mine: !st.mine })}>Only mine</button>} />
      <div className={canMeet ? 'actions-row' : 'actions-row single'}>
        {canMeet && <button type="button" className="btn primary" onClick={() => c.open({ kind: 'meeting-form', day: st.day })}><CalendarPlus aria-hidden="true" />New meeting</button>}
        <button type="button" className={canMeet ? 'btn' : 'btn primary'} onClick={() => c.open({ kind: 'note-form', day: st.day })}><NotebookPen aria-hidden="true" />New note</button>
      </div>
      <div className="segmented" role="group" aria-label="Calendar view">{([['month', 'Month'], ['agenda', 'Next 30 days']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={st.view === v} onClick={() => set({ view: v })}>{l}</button>)}</div>
      <ChipRow label="Show in the calendar">
        {kinds.map(([k, label, Icon]) => <button key={k} type="button" className={`chip cal-kind kind-${k}`} aria-pressed={st.kinds.includes(k)} onClick={() => toggleKind(k)}><Icon aria-hidden="true" className="chip-icon" />{label}</button>)}
      </ChipRow>
      {panelDay && <BackLayer onClose={() => setPanelDay(null)} />}
      {st.view === 'month' ? <>
        <div className="month-nav">
          <button type="button" className="icon-btn" onClick={() => pick(shiftMonths(st.day, -1))} aria-label="Previous month"><ChevronLeft aria-hidden="true" /></button>
          <strong aria-live="polite">{MONTH_NAMES[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</strong>
          <span className="month-nav-end">
            {st.day !== today && <button type="button" className="btn small" onClick={() => pick(today)}>Today</button>}
            <button type="button" className="icon-btn" onClick={() => pick(shiftMonths(st.day, 1))} aria-label="Next month"><ChevronRight aria-hidden="true" /></button>
          </span>
        </div>
        <table className="cal-grid" ref={gridRef} onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={() => { swipe.current = null; }}
          onClickCapture={e => { if (e.detail && Date.now() < ignoreClickUntil.current) { e.preventDefault(); e.stopPropagation(); } }}>
          <caption className="sr-only">{MONTH_NAMES[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}. Choose a day to see what is on it; the arrow keys move between days. Swipe left for the next month or right for the previous month.</caption>
          <thead><tr>{WEEK.map(d => <th key={d} scope="col" abbr={d}>{d.slice(0, 2)}</th>)}</tr></thead>
          <tbody>
            {weeks.map(row => <tr key={row[0]}>
              {row.map(day => {
                const on = itemsOn(items, day), chosen = day === st.day;
                return (
                  <DayPanel key={day} open={panelDay === day} onOpenChange={open => { setPanelDay(current => open ? day : current === day ? null : current); if (open) pick(day); }} label={longDay(day)} count={on.length} details={<div className="list">{on.map(i => <CalRow key={i.key} c={c} i={i} day={day} />)}</div>}>
                  <td>
                    <button type="button" data-day={day} data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day} tabIndex={chosen ? 0 : -1} aria-pressed={chosen} onKeyDown={e => keys(e, day)}
                      className={`cal-cell${day.slice(0, 7) !== month.slice(0, 7) ? ' is-other' : ''}${day === today ? ' is-today' : ''}`}
                      aria-label={`${longDay(day)}${day === today ? ', today' : ''}: ${on.length ? `${on.length} ${on.length === 1 ? 'item' : 'items'}` : 'nothing planned'}`}>
                      <span className="cal-num">{Number(day.slice(8))}</span>
                      <span className="cal-dots" aria-hidden="true">{on.slice(0, 3).map(i => <span key={i.key} className={`cal-dot kind-${i.kind}${i.overdue ? ' is-overdue' : ''}`} />)}</span>
                    </button>
                  </td>
                  </DayPanel>
                );
              })}
            </tr>)}
          </tbody>
        </table>
      </> : agendaDays.length ? agendaDays.map(([day, l]) => (
        <Section key={day} title={day === today ? `Today · ${fmtDay(day)}` : day === addDays(today, 1) ? `Tomorrow · ${fmtDay(day)}` : fmtDay(day)}>
          <div className="list">{l.map(i => <CalRow key={i.key} c={c} i={i} day={day} />)}</div>
        </Section>
      )) : <Empty icon={CalendarDays} title="Nothing in the next 30 days" text="Meetings, task deadlines and your notes appear here." />}
      <p className="hint small footnote">Meetings show if you take part or they are shared with you; deadlines are the tasks you can see. Your notes and their reminders are private to you.</p>
    </>
  );
}

function MeetingView({ c, id }: { c: Ctx; id: string }) {
  const m: Row | undefined = (c.data.tm_meetings || []).find((x: Row) => x.id === id);
  const [busy, setBusy] = useState(false);
  if (!m) return <><BackBar c={c} title="Meeting" /><Empty icon={CircleSlash} title="Meeting not found" text="It may have been removed, or it is no longer shared with you." /></>;
  // A meeting in a workspace this person only works in through it (a reference) can still be completed by them.
  const people = attendeesOf(c, m.id), part = takesPart(c, m), ws = [...(c.data.tm_workspaces || []), ...(c.data.tm_workspace_refs || [])].find((w: Row) => w.id === m.workspace_id);
  const following = (c.data.tm_meeting_followers || []).some((f: Row) => f.meeting_id === m.id && f.staff_id === c.me);
  const canChange = part && c.can('tasks.meetings', 'update') && !m.activity_id && !!ws && (ws.reference_only || ws.status === 'ACTIVE');
  // V5.6.8: only its organizer, whoever scheduled it, or a participant who may approve meetings changes its time, people or
  // details, or cancels it. Other participants can still complete it with notes and set its reminders.
  const manage = canChange && canManageMeeting(m, c.me, { participant: part, canApprove: c.can('tasks.meetings', 'approve') });
  const startIso = m.status === 'SCHEDULED' ? m.start_at : undefined;
  const [label, tone] = MEETING_STATUS[m.status] || [m.status, 'neutral'];
  const sameDay = dayOf(m.start_at) === dayOf(m.end_at);
  const when = sameDay ? `${fmtDay(dayOf(m.start_at))} · ${hm(m.start_at)}–${hm(m.end_at)}` : `${fmtDay(dayOf(m.start_at))} ${hm(m.start_at)} – ${fmtDay(dayOf(m.end_at))} ${hm(m.end_at)}`;
  const task = m.task_id ? c.tasks.find(t => t.id === m.task_id) : null;
  const save = (patch: Row) => c.perform('tm.meeting.save', meetingPayload(c, m, patch));
  const follow = async () => { setBusy(true); try { await c.perform('tm.meeting.follow', { id: m.id, follow: !following }); } catch (e) { try { tgApp()?.showAlert?.((e as Error).message); } catch { window.alert((e as Error).message); } } finally { setBusy(false); } };
  const peopleRow = (staff: string, role: string) => <li key={`${role}-${staff}`}><Avatar name={c.name(staff)} src={c.photo(staff)} /><span className="person-text"><strong><Identity name={c.name(staff)}/></strong><span className="hint">{role}{staff === c.me ? ' · you' : ''}</span></span></li>;
  return (
    <>
      <BackBar c={c} title={m.id} />
      <header className="detail-head">
        <h1>{m.title}</h1>
        <p className="hint">{ws?.name || 'Meeting'}</p>
        <div className="detail-status"><Badge label={label} tone={tone} />{!part && <Badge label="Shared with you" tone="purple" />}<span className="hint small">{when}</span></div>
      </header>
      <MeetingApprovals records={c.data.tm_meeting_changes||[]} meeting={m.id} me={c.me} name={c.name} perform={c.perform}/>
      {m.status === 'CANCELLED' && <div className="callout tone-neutral"><strong>Cancelled.</strong> {m.reason}</div>}
      {!part && <div className="callout tone-info"><strong>This meeting is shared with you.</strong> You can see it but not change it. {following ? 'You get its reminders.' : 'Its participants get its reminders; you can ask for them too.'}
        {m.status === 'SCHEDULED' && <div className="callout-actions"><button type="button" className="btn small" disabled={busy} onClick={() => void follow()}><BellRing aria-hidden="true" />{following ? 'Stop reminders' : 'Get its reminders'}</button></div>}
      </div>}
      {part && m.activity_id && <div className="callout tone-neutral">Linked to a CRM activity: change it in the Task Controlling Management.</div>}
      <dl className="facts">
        <div><dt>When ({zoneName()})</dt><dd>{when}</dd></div>
        <div><dt>Where</dt><dd>{m.location || 'Not set'}</dd></div>
        <div><dt>Visible to</dt><dd>{shareText(c, m)}</dd></div>
        <div><dt>Reminders</dt><dd>{m.status === 'SCHEDULED' ? remindersText(m.reminder_offsets) : 'None (not scheduled)'}</dd></div>
      </dl>
      {m.url && m.status === 'SCHEDULED' && <button type="button" className="btn block" onClick={() => openLink(m.url)}><Link2 aria-hidden="true" />Join online</button>}
      {canChange && !manage && <p className="hint small">{c.who(m.organizer_id)} organizes this meeting{m.created_by && m.created_by !== m.organizer_id ? ` (scheduled by ${c.who(m.created_by, true)})` : ''}: they change its time, people and details. You can complete it with notes and set its reminders.</p>}
      {canChange && <div className="action-list">
        {manage && <button type="button" className="btn block" onClick={() => c.open({ kind: 'meeting-form', id: m.id })}><Pencil aria-hidden="true" />{m.status === 'SCHEDULED' ? 'Edit, reschedule or invite' : 'Edit details'}</button>}
        {!manage && m.status === 'SCHEDULED' && <button type="button" className="btn block" onClick={() => c.sheet({ title: 'Meeting reminders', description: 'Everyone taking part is reminded, in the Task Controlling Management and here in Telegram.', fields: [{ key: 'offsets', label: 'Reminders', type: 'offsets', start: startIso }], initial: { offsets: offsetsOf(m.reminder_offsets) }, confirm: 'Save reminders', run: v => save({ reminder_offsets: v.offsets || [] }) })}><AlarmClock aria-hidden="true" />Reminders…</button>}
        {m.status !== 'CANCELLED' && <button type="button" className="btn block" onClick={() => c.sheet({ title: m.status === 'COMPLETED' ? 'Notes and decisions' : 'Mark as completed', description: m.status === 'COMPLETED' ? undefined : 'Note what was decided. Everyone who can see the meeting can read it.', fields: [{ key: 'minutes_notes', label: 'Notes and decisions (optional)', type: 'textarea' }], initial: { minutes_notes: m.minutes_notes || '' }, confirm: 'Save', run: v => save({ status: 'COMPLETED', minutes_notes: v.minutes_notes || '' }) })}><Check aria-hidden="true" />{m.status === 'COMPLETED' ? 'Edit notes and decisions' : 'Mark as completed…'}</button>}
        {manage && m.status === 'SCHEDULED' && <button type="button" className="btn danger block" onClick={() => c.sheet({ title: 'Cancel this meeting?', description: 'Everyone invited is told, with your reason. Its reminders stop.', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }], confirm: 'Cancel meeting', dismiss: 'Keep it', tone: 'danger', run: v => save({ status: 'CANCELLED', reason: v.reason }) })}><CircleSlash aria-hidden="true" />Cancel meeting…</button>}
      </div>}
      <Section title="People" count={new Set([m.organizer_id, ...people]).size}>
        <ul className="people">{peopleRow(m.organizer_id, 'Organizer')}{people.filter(x => x !== m.organizer_id).map(x => peopleRow(x, 'Invited'))}</ul>
      </Section>
      {m.agenda && <Section title="Agenda"><p className="note-block">{m.agenda}</p></Section>}
      {m.minutes_notes && <Section title="Notes and decisions"><p className="note-block">{m.minutes_notes}</p></Section>}
      {task && <Section title="Task"><div className="list"><TaskRow c={c} t={task} /></div></Section>}
    </>
  );
}

/** Up to five reminders, minutes before the start: the usual choices, and any other amount already set (from the Task Controlling Management). */
function OffsetChips({ value, onChange, start, label = 'Reminders', hint }: { value: number[]; onChange: (v: number[]) => void; start?: string; label?: string; hint?: string }) {
  const list = [...new Set(value)].sort((a, b) => b - a), startMs = start ? Date.parse(start) : NaN;
  const past = list.filter(n => Number.isFinite(startMs) && startMs - n * 60000 < Date.now() - 60000);
  const toggle = (n: number) => onChange(list.includes(n) ? list.filter(x => x !== n) : list.length >= 5 ? list : [...list, n]);
  const choices = [...OFFSETS, ...list.filter(n => !OFFSETS.some(([p]) => p === n)).map(n => [n, offsetText(n).replace(/^./, x => x.toUpperCase())] as [number, string])];
  return (
    <fieldset className="field">
      <legend className="label">{label}</legend>
      <div className="chips wrap" role="group" aria-label={label}>{choices.map(([n, text]) => <button key={n} type="button" className="chip" aria-pressed={list.includes(n)} onClick={() => toggle(n)}>{text}</button>)}</div>
      {past.length > 0 ? <span className="error small" role="alert">The reminder {past.map(offsetText).join(' and ')} would already be in the past. Remove it or choose a later start.</span>
        : <span className="hint small">{hint || (list.length ? `Reminders ${list.map(offsetText).join(', ')} (in the Task Controlling Management and here in Telegram).` : 'No reminders.')}</span>}
    </fieldset>
  );
}

function MeetingForm({ c, id, day }: { c: Ctx; id?: string; day?: string }) {
  const [outside,setOutside] = useState(false);
  // The meeting as it was when the form opened (with its people): the save sends that version, so a change made meanwhile
  // by someone else is reported instead of being overwritten.
  const [m] = useState<Row | undefined>(() => (id ? (c.data.tm_meetings || []).find((y: Row) => y.id === id) : undefined));
  const wss: Row[] = creatableWorkspaces(c, m?.workspace_id);
  const memberOf = (wid: string) => (c.data.tm_members || []).filter((x: Row) => x.workspace_id === wid).map((x: Row) => x.staff_id as string);
  const [d, setD] = useState<Row>(() => {
    const today = calToday(), wanted = day && day > today ? `${day}T09:00` : zonedInput(new Date(Date.now() + 3600000).toISOString()).slice(0, 14) + '00';
    const startIso = m?.start_at || zonedToIso(wanted), endIso = m?.end_at || new Date(Date.parse(startIso) + 3600000).toISOString();
    const s = zonedInput(startIso), e = zonedInput(endIso);
    return {
      workspace_id: m?.workspace_id || wss.find(w => w.status === 'ACTIVE' && memberOf(w.id).includes(c.me))?.id || wss.find(w => w.status === 'ACTIVE')?.id || '',
      title: m?.title || '', agenda: m?.agenda || '', location: m?.location || '', url: m?.url || '', organizer_id: m?.organizer_id || c.me,
      attendee_ids: m ? attendeesOf(c, m.id).filter(x => x !== m.organizer_id) : [], date: s.slice(0, 10), from: s.slice(11, 16), to: e.slice(11, 16), end_date: e.slice(0, 10), longer: e.slice(0, 10) !== s.slice(0, 10),
            // V5.6.8: a new meeting starts with the longest usual reminder that is not already in the past.
      share_scope: m?.share_scope === 'SELECTED' ? 'SELECTED' : 'PARTICIPANTS', share_ids: m ? sharesOf(c, m.id) : [], offsets: m ? offsetsOf(m.reminder_offsets) : [60, 15, 0].filter(n => Date.parse(startIso) - n * 60000 > Date.now() + 60000).slice(0, 1),
    };
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState<string[]>([]), shareName = useId(), formRef = useRef<HTMLFormElement>(null);
  const { saved } = useDirty([d, outside]);
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setError(''); setInvalid(l => l.filter(x => x !== k)); };
  const bad = (k: string) => invalid.includes(k) || undefined;
  const startIso = d.date && d.from ? zonedToIso(`${d.date}T${d.from}`) : '', endIso = (d.longer ? d.end_date : d.date) && d.to ? zonedToIso(`${d.longer ? d.end_date : d.date}T${d.to}`) : '';
  const desc = (l: number[]) => JSON.stringify([...new Set(l)].sort((a, b) => b - a));
  const timing = !m || Date.parse(startIso) !== Date.parse(m.start_at) || desc(d.offsets) !== desc(offsetsOf(m.reminder_offsets));
  const ws = wss.find(w => w.id === d.workspace_id), governed = ws?.kind && ws.kind !== 'LEGACY';
  const selected = new Set([...d.attendee_ids,...d.share_ids]);
  const everyone = peopleList(c, { include: [...d.attendee_ids, ...d.share_ids], exclude: [d.organizer_id] }).filter(p => !governed || outside || memberOf(d.workspace_id).includes(p.id) || selected.has(p.id)).map(p => ({...p,note:governed && !memberOf(d.workspace_id).includes(p.id) ? 'Outside workspace · this meeting only' : p.note}));
  const wsName = wss.find(w => w.id === d.workspace_id)?.name || 'the workspace';
  const pickerEmpty = governed && !outside ? membersOnly(wsName, !!ws?.org_access?.can_collaborate_outside, 'meeting') : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    const missing: [string, string, boolean][] = ([['title', 'the title', false], ['workspace_id', 'the workspace', true], ['date', 'the date', false], ['from', 'the start time', false], ['to', 'the end time', false]] as [string, string, boolean][]).filter(([k]) => !String(d[k] ?? '').trim());
    if (missing.length) { setInvalid(missing.map(x => x[0])); setError(missingText(missing.filter(x => !x[2]).map(x => x[1]), missing.filter(x => x[2]).map(x => x[1]))); focusField(formRef.current, missing[0][0]); return; }
    if (Date.parse(endIso) <= Date.parse(startIso)) { setInvalid(['to']); setError('The meeting must end after it starts.'); focusField(formRef.current, 'to'); return; }
    if (d.share_scope === 'SELECTED' && !d.share_ids.length) { setError('Choose who else can see the meeting, or keep it visible to its participants only.'); return; }
    // As on the server: reminders in the past are refused only when the start or the reminders change.
    const late = timing ? d.offsets.filter((n: number) => Date.parse(startIso) - n * 60000 < Date.now() - 60000) : [];
    if (late.length && (!m || m.status === 'SCHEDULED')) { setError(`The reminder ${late.map(offsetText).join(' and ')} would already be in the past. Remove it or choose a later start.`); return; }
    const changes = { title: d.title.trim(), agenda: d.agenda, location: d.location, url: d.url.trim(), attendee_ids: [...new Set([d.organizer_id, ...d.attendee_ids])], start_at: startIso, end_at: endIso,
      share_scope: d.share_scope, share_ids: d.share_scope === 'SELECTED' ? d.share_ids : [], reminder_offsets: d.offsets };
    setBusy(true);
    try {
      const r = m ? await c.perform('tm.meeting.save', meetingPayload(c, m, changes))
        : await c.perform('tm.meeting.save', { ...changes, workspace_id: d.workspace_id, organizer_id: c.me, status: 'SCHEDULED', request_key: uuid() });
      saved(); c.back(); if (!m && r.id) c.open({ kind: 'meeting', id: r.id });
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <BackBar c={c} title={m ? 'Edit meeting' : 'New meeting'} />{m && <p className="hint small">Changes need approval from another participant. If you are the only participant, invite another person to review the proposed change.</p>}
      <form className="form" onSubmit={submit} noValidate ref={formRef}>
        <LField label="Title" required><input className="input" value={d.title} maxLength={300} onChange={e => set('title', e.target.value)} aria-required="true" aria-invalid={bad('title')} data-field="title" placeholder="What is the meeting about?" /></LField>
        <LField label="Workspace" required><select className="input" value={d.workspace_id} disabled={!!m} aria-invalid={bad('workspace_id')} data-field="workspace_id" onChange={e => {setOutside(false);set('workspace_id', e.target.value);}}>{wss.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <span className="hint small">{governed ? 'Invitations grant access to this meeting only. Workspace membership is approved separately.' : memberOf(d.workspace_id).includes(c.me) ? 'People you invite from outside it are added to the workspace.' : 'You aren’t a member of this workspace: invite its members, or ask its owner to add you.'}</span></LField>
        <LField label="Date" required><input className="input" type="date" value={d.date} aria-invalid={bad('date')} data-field="date" onChange={e => { const v = e.target.value; setD(s => ({ ...s, date: v, end_date: s.longer && s.end_date >= v ? s.end_date : v })); setError(''); setInvalid(l => l.filter(x => x !== 'date')); }} />{d.date && <span className="hint small">{dayInWords(d.date)}</span>}</LField>
        <div className="time-row">
          <LField label={`Starts (${zoneName()})`} required><input className="input" type="time" value={d.from} aria-invalid={bad('from')} data-field="from" onChange={e => { const v = e.target.value; setD(s => ({ ...s, from: v, to: keepLength(s.from, s.to, v, !!s.longer) })); setError(''); setInvalid(l => l.filter(x => x !== 'from')); }} /></LField>
          <LField label="Ends" required><input className="input" type="time" value={d.to} aria-invalid={bad('to')} data-field="to" onChange={e => set('to', e.target.value)} /></LField>
        </div>
        <label className="check-row"><input type="checkbox" checked={!!d.longer} onChange={e => setD(s => ({ ...s, longer: e.target.checked, end_date: e.target.checked ? addDays(s.date, 1) : s.date }))} /><span><strong>Ends on a later day</strong><span className="hint small">For a meeting over several days (up to seven).</span></span></label>
        {d.longer && <LField label="End date" required><input className="input" type="date" value={d.end_date} min={d.date} onChange={e => set('end_date', e.target.value)} />{d.end_date && <span className="hint small">{dayInWords(d.end_date)}</span>}</LField>}
        {governed && <label className="switch-row"><span><strong>Select outside workspace</strong><span className="hint">Invitations do not add workspace membership.</span></span><input type="checkbox" checked={outside} disabled={!ws?.org_access?.can_collaborate_outside} onChange={e => setOutside(e.target.checked)} /></label>}
        <PeopleSelect c={c} label="Invite people" value={d.attendee_ids} people={everyone} empty={pickerEmpty} onChange={v => set('attendee_ids', v)} hint={`${d.organizer_id === c.me ? 'You are the organizer.' : `Organizer: ${c.name(d.organizer_id)}.`} Everyone invited is told and gets the reminders.`} />
        <LField label="Where"><input className="input" value={d.location} maxLength={500} onChange={e => set('location', e.target.value)} placeholder="Room, address or “Online”" /></LField>
        <LField label="Online meeting link"><input className="input" type="url" inputMode="url" value={d.url} maxLength={2000} onChange={e => set('url', e.target.value)} placeholder="https://…" autoCapitalize="none" spellCheck={false} /></LField>
        <LField label="Agenda"><textarea className="input" rows={3} value={d.agenda} maxLength={8000} onChange={e => set('agenda', e.target.value)} placeholder="What will be discussed" /></LField>
        <fieldset className="field"><legend className="label">Visible to</legend>
          <div className="choice-list">{SHARE_CHOICES.filter(([v]) => v !== 'COMPANY' || !governed || ws?.visibility !== 'PERSONAL' && ws?.org_access?.can_collaborate_outside).map(([v, l, h]) => <label key={v} className="choice"><input type="radio" name={shareName} value={v} checked={d.share_scope === v} onChange={() => set('share_scope', v)} /><span><strong>{v === 'WORKSPACE' ? `Everyone in ${wsName}` : l}</strong><span className="hint small">{h}</span></span></label>)}</div>
        </fieldset>
        {d.share_scope === 'SELECTED' && <PeopleSelect c={c} label="Also visible to" value={d.share_ids} people={everyone.filter(p => !d.attendee_ids.includes(p.id))} empty={pickerEmpty} onChange={v => set('share_ids', v)} hint="They can see the meeting and ask for its reminders; they can’t change it." />}
        <OffsetChips value={d.offsets} onChange={v => set('offsets', v)} start={timing && (!m || m.status === 'SCHEDULED') ? startIso : undefined} />
        <FormFoot error={error}><button type="submit" className="btn primary block" disabled={busy}>{busy ? 'Saving…' : m ? 'Send for approval' : 'Schedule meeting'}</button></FormFoot>
      </form>
    </>
  );
}

function NoteForm({ c, id, day }: { c: Ctx; id?: string; day?: string }) {
  // The note as it was when the form opened (its version is sent, so a change made meanwhile is reported).
  const [n] = useState<Row | undefined>(() => (id ? (c.data.tm_calendar_notes || []).find((x: Row) => x.id === id) : undefined));
  const [d, setD] = useState<Row>(() => {
    const s = n?.start_at ? zonedInput(n.start_at) : '', e = n?.end_at ? zonedInput(n.end_at) : '';
    const date = n ? (n.all_day ? n.day : s.slice(0, 10)) : day || calToday();
    // A note made in the Task Controlling Management may end on a later day: that day is kept unless the note's date changes.
    return { title: n?.title || '', body: n?.body || '', all_day: n ? !!n.all_day : true, date, end_date: e ? e.slice(0, 10) : date, from: s ? s.slice(11, 16) : '09:00', to: e ? e.slice(11, 16) : '', offsets: n ? offsetsOf(n.reminder_offsets) : [], done: !!n?.done };
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState<string[]>([]), formRef = useRef<HTMLFormElement>(null);
  const { saved } = useDirty(d);
  if (id && !n) return <><BackBar c={c} title="Note" /><Empty icon={CircleSlash} title="Note not found" text="It may have been deleted." /></>;
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setError(''); setInvalid(l => l.filter(x => x !== k)); };
  const bad = (k: string) => invalid.includes(k) || undefined;
  // An all-day note's reminders count back from 09:00 on its day.
  const startIso = d.date ? zonedToIso(`${d.date}T${d.all_day ? '09:00' : d.from || '09:00'}`) : '';
  const desc = (l: number[]) => JSON.stringify([...new Set(l)].sort((a, b) => b - a));
  const timing = !n || !!d.all_day !== !!n.all_day || (d.all_day ? d.date !== n.day : Date.parse(startIso) !== Date.parse(n.start_at)) || desc(d.offsets) !== desc(offsetsOf(n.reminder_offsets));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    const missing = ([['title', 'the title'], ['date', 'the date'], ...(d.all_day ? [] : [['from', 'the time']])] as [string, string][]).filter(([k]) => !String(d[k] ?? '').trim());
    if (missing.length) { setInvalid(missing.map(x => x[0])); setError(missingText(missing.map(x => x[1]), [])); focusField(formRef.current, missing[0][0]); return; }
    const endIso = !d.all_day && d.to ? zonedToIso(`${d.end_date > d.date ? d.end_date : d.date}T${d.to}`) : '';
    if (endIso && Date.parse(endIso) < Date.parse(startIso)) { setError('The end must be after the start.'); return; }
    // As on the server: reminders in the past are refused only when the day, the time or the reminders change.
    const late = timing ? d.offsets.filter((x: number) => Date.parse(startIso) - x * 60000 < Date.now() - 60000) : [];
    if (late.length && !d.done) { setError(`The reminder ${late.map(offsetText).join(' and ')} would already be in the past. Remove it or choose a later time.`); return; }
    setBusy(true);
    try {
      await c.perform('tm.calnote.save', { id: n?.id, expected_version: n?.version, title: d.title.trim(), body: d.body, all_day: !!d.all_day, day: d.all_day ? d.date : undefined,
        start_at: d.all_day ? undefined : zonedToIso(`${d.date}T${d.from}`), end_at: endIso || undefined, reminder_offsets: d.offsets, done: !!d.done });
      saved(); c.back();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <BackBar c={c} title={n ? 'Your note' : 'New note'} />
      <form className="form" onSubmit={submit} noValidate ref={formRef}>
        <div className="callout tone-neutral"><Lock aria-hidden="true" className="inline-icon" />Only you can see your notes and their reminders.</div>
        <LField label="Title" required><input className="input" value={d.title} maxLength={200} onChange={e => set('title', e.target.value)} aria-required="true" aria-invalid={bad('title')} data-field="title" placeholder="e.g. Call the customs broker" /></LField>
        <LField label="Date" required><input className="input" type="date" value={d.date} aria-invalid={bad('date')} data-field="date" onChange={e => { const v = e.target.value; setD(s => ({ ...s, date: v, end_date: v })); setError(''); setInvalid(l => l.filter(x => x !== 'date')); }} />{d.date && <span className="hint small">{dayInWords(d.date)}</span>}</LField>
        <label className="check-row"><input type="checkbox" checked={!!d.all_day} onChange={e => set('all_day', e.target.checked)} /><span><strong>All day</strong><span className="hint small">{d.all_day ? 'Reminders count back from 09:00 on this day.' : 'Turn on for a note without a time.'}</span></span></label>
        {!d.all_day && <div className="time-row">
          <LField label={`From (${zoneName()})`} required><input className="input" type="time" value={d.from} aria-invalid={bad('from')} data-field="from" onChange={e => set('from', e.target.value)} /></LField>
          <LField label={d.end_date > d.date ? `Until (${fmtDay(d.end_date)})` : 'Until (optional)'}><input className="input" type="time" value={d.to} onChange={e => set('to', e.target.value)} /></LField>
        </div>}
        <LField label="Note"><textarea className="input" rows={4} value={d.body} maxLength={4000} onChange={e => set('body', e.target.value)} /></LField>
        <OffsetChips value={d.offsets} onChange={v => set('offsets', v)} start={timing && !d.done ? startIso : undefined} hint={d.offsets.length ? `Reminders ${[...d.offsets].sort((a: number, b: number) => b - a).map(offsetText).join(', ')}, to you only (in the Task Controlling Management and here in Telegram).` : 'No reminders.'} />
        {n && <label className="check-row"><input type="checkbox" checked={!!d.done} onChange={e => set('done', e.target.checked)} /><span><strong>Done</strong><span className="hint small">Done notes stay in your calendar and send no more reminders.</span></span></label>}
        <FormFoot error={error}><button type="submit" className="btn primary block" disabled={busy}>{busy ? 'Saving…' : n ? 'Save note' : 'Add note'}</button></FormFoot>
        {n && <button type="button" className="btn danger block" disabled={busy} onClick={() => c.sheet({ title: `Delete “${n.title}”?`, description: 'The note and its reminders are deleted.', fields: [], confirm: 'Delete note', tone: 'danger', run: async () => { await c.perform('tm.calnote.delete', { id: n.id, expected_version: n.version }); saved(); c.back(); } })}><Trash2 aria-hidden="true" />Delete note</button>}
      </form>
    </>
  );
}

// ------------------------------------------------------------------ alerts, profile and settings
function AlertsView({ c }: { c: Ctx }) {
  const list: Row[] = c.data.tm_notifications || [], unread = list.filter(n => !n.read_at).length;
  const open = (n: Row) => {
    if (!n.read_at) void call('/command', { action: 'tm.notification.read', data: { id: n.id } }).catch(() => {});
    if (n.org_request_id) c.open({ kind: 'organization', id: n.org_request_id });
    else if (n.request_id && n.kind.startsWith('request_')) c.open({ kind: 'request', id: n.request_id });
    else if (n.task_id) c.open({ kind: 'task', id: n.task_id });
    else if (n.meeting_id) c.open({ kind: 'meeting', id: n.meeting_id });
    else if (n.note_id) c.open({ kind: 'note-form', id: n.note_id });
  };
  return (
    <>
      <Header title="Alerts" subtitle={unread ? `${unread} unread` : 'All read'} action={<button type="button" className="icon-btn" onClick={() => c.open({ kind: 'settings' })} aria-label="Profile and settings"><Settings aria-hidden="true" /></button>} />
      {unread > 0 && <button type="button" className="btn small" onClick={() => void c.perform('tm.notification.read', { all: true }).catch(() => {})}><CheckCheck aria-hidden="true" />Mark all as read</button>}
      {list.length ? <div className="list">{list.map(n => (
        <button key={n.id} type="button" className={`list-row alert-row${n.read_at ? '' : ' is-unread'}`} onClick={() => open(n)}>
          <span className={`state-dot ${n.read_at ? 'tone-neutral' : 'tone-info'}`} aria-hidden="true" />
          <span className="row-main"><span className="row-title">{n.title}</span><span className="row-meta">{n.body}</span><span className="hint small">{fmtTime(n.created_at)}{n.read_at ? '' : ' · new'}</span></span>
        </button>
      ))}</div> : <Empty icon={Bell} title="No alerts yet" text="New tasks, reviews, requests and changes to your tasks appear here." />}
    </>
  );
}
function SettingsView({ c, onUnlinked }: { c: Ctx; onUnlinked: () => void }) {
  const notify = !!c.data.telegram?.link?.notify, user = c.data.auth.user, name = c.name(c.me), profile = c.data.tm_profiles.find((p: Row) => p.staff_id === c.me), nickname = profile?.nickname || '';
  const hasPhoto = (c.data.staff_photos || []).some((p: Row) => p.staff_id === c.me);
  const [draft, setDraft] = useState(nickname), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { setDraft(nickname); }, [nickname]);
  const pick = async (file: File) => { setBusy(true); setError(''); try { await c.perform('me.photo.save', { base64: await photoFromFile(file) }); } catch (e) { setError((e as Error).message); haptic('error'); } finally { setBusy(false); } };
  const saveName = async (e: FormEvent) => {
    e.preventDefault(); if (draft.trim() === nickname) return;
    setSaving(true); setError('');
    try { await c.perform('me.profile.save', { nickname: draft.trim() }); } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };
  return (
    <>
      <BackBar c={c} title="Profile and settings" />{c.can('tasks.timesheets') && <button className="btn block" onClick={()=>c.open({kind:'timesheets'})}><Clock3/>Timesheets</button>}
      {c.can('tasks.organization') && <button type="button" className="btn block" onClick={() => c.open({ kind: 'organization' })}><Users />Organizational Structure{c.data.organization?.pending ? ` (${c.data.organization.pending} pending)` : ''}</button>}
      <section className="profile-card">
        <Avatar name={name} src={c.photo(c.me)} size="xl" />
        <div className="profile-text"><h1><Identity name={name}/></h1><p className="hint">{user.email}</p><p className="hint small">{user.role_name}</p></div>
      </section>
      <div className="profile-actions">
        <label className={`btn file-btn${busy ? ' is-busy' : ''}`}><Camera aria-hidden="true" />{busy ? 'Saving…' : hasPhoto ? 'Change photo' : 'Add a photo'}<input type="file" accept="image/*" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} /></label>
        {hasPhoto && <button type="button" className="btn danger" disabled={busy} onClick={() => c.sheet({ title: 'Remove your photo?', description: 'Your initials are shown instead.', fields: [], confirm: 'Remove photo', tone: 'danger', run: () => c.perform('me.photo.remove', {}) })}><Trash2 aria-hidden="true" />Remove photo</button>}
      </div>
      <p className="hint small">A clear photo of your face helps colleagues recognise you when they choose people for tasks and requests.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="form" onSubmit={saveName} noValidate>
        <LField label="Username / display name"><input className="input" value={user.username || user.name} readOnly /></LField><LField label="Nickname (optional)"><input className="input" value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} autoComplete="name" disabled={saving} /><span className="hint small">Shown in parentheses next to your username.</span></LField>
        <button type="submit" className="btn primary block" disabled={saving || draft.trim() === nickname}>{saving ? 'Saving…' : 'Save nickname'}</button>
      </form>
      <Section title="Telegram">
        <label className="switch-row"><span><strong>Task messages in the bot chat</strong><span className="hint">New tasks and requests to accept, reviews, reminders and a morning summary.</span></span><input type="checkbox" role="switch" checked={notify} onChange={e => void c.perform('tg.link.notify', { notify: e.target.checked }).catch(() => {})} /></label>
        <button type="button" className="btn danger block" onClick={() => c.sheet({ title: 'Disconnect Telegram?', description: 'You can connect again at any time: sign in here with your username and password, or use your link in the Task Controlling Management.', fields: [], confirm: 'Disconnect', tone: 'danger', run: async () => { await call('/command', { action: 'tg.link.unlink', data: {} }); onUnlinked(); } })}>Disconnect this Telegram account</button>
      </Section>
      <p className="hint small footnote">Signed in as {name} ({user.role_name}) · {c.data.company.name}. Everything you do here is saved in the Task Controlling Management straight away.</p>
    </>
  );
}

function MiniTimesheets({c}:{c:Ctx}) {
 const [mode,setMode]=useState('rolling'),[anchor,setAnchor]=useState(''),[today,setToday]=useState(taskToday()),[custom,setCustom]=useState({from:addDays(taskToday(),-7),to:taskToday()}),[edit,setEdit]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const tick=()=>setToday(taskToday()),timer=window.setInterval(tick,30000);window.addEventListener('focus',tick);return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[]);
 const range=timeRange(mode,anchor||today,custom.from,custom.to),logs=(c.data.tm_timesheets||[]).filter((e:Row)=>e.staff_id===c.me&&e.work_date>=range.from&&e.work_date<=range.to),total=logs.reduce((n:number,e:Row)=>n+e.minutes,0);
 const tasks=c.tasks.filter(t=>t.assignees.includes(c.me)&&t.status!=='CANCELLED');
 const set=(key:string,value:any)=>setEdit(d=>({...d,[key]:value}));
 const save=async(e:FormEvent)=>{e.preventDefault();if(!edit)return;setBusy(true);setError('');try{await c.perform('tm.time.save',{...edit,staff_id:c.me,expected_version:edit.version});setEdit(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 if(!c.can('tasks.timesheets'))return <><BackBar c={c} title="Timesheets"/><div className="callout" role="alert">Your account does not have permission to view timesheets. Ask an administrator if you need access.</div></>;
 return <><BackBar c={c} title="Timesheets"/><div className="form"><LField label="Period"><select className="input" value={mode} onChange={e=>setMode(e.target.value)}><option value="rolling">Previous weekday through today</option><option value="week">Week</option><option value="month">Month</option><option value="custom">Date range</option></select></LField>{mode==='custom'?<><LField label="From"><input type="date" className="input" value={custom.from} onChange={e=>setCustom(d=>({...d,from:e.target.value}))}/></LField><LField label="Through"><input type="date" className="input" value={custom.to} onChange={e=>setCustom(d=>({...d,to:e.target.value}))}/></LField></>:<LField label="Date"><input type="date" className="input" value={anchor||today} onChange={e=>setAnchor(e.target.value)}/></LField>}<p>{range.from} – {range.to} · Total <strong>{formatMinutes(total)}</strong> hours</p>{c.can('tasks.timesheets','create')&&<button className="btn primary" onClick={()=>setEdit({task_id:'',workspace_id:'',activity:'',work_date:today,duration:'1:00',notes:''})}>Add time</button>}</div>
 {error&&<p role="alert" className="error">{error}</p>}{edit&&<form className="form" onSubmit={save}><LField label="Task (optional)"><select className="input" value={edit.task_id||''} disabled={!!edit.id} onChange={e=>set('task_id',e.target.value)}><option value="">Independent work</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></LField>{!edit.task_id&&<><LField label="Activity"><input required className="input" value={edit.activity||''} onChange={e=>set('activity',e.target.value)}/></LField><LField label="Workspace (optional)"><select className="input" disabled={!!edit.id} value={edit.workspace_id||''} onChange={e=>set('workspace_id',e.target.value)}><option value="">No workspace</option>{c.data.tm_workspaces.map((w:Row)=><option key={w.id} value={w.id}>{w.name}</option>)}</select></LField></>}
 <LField label="Work date"><input required className="input" type="date" max={today} value={edit.work_date} onChange={e=>set('work_date',e.target.value)}/></LField><LField label="Duration (H:MM)"><input required className="input" value={edit.duration} onChange={e=>set('duration',e.target.value)}/></LField><LField label="Work notes"><textarea className="input" value={edit.notes} onChange={e=>set('notes',e.target.value)}/></LField><button disabled={busy} className="btn primary" type="submit">Save time</button><button type="button" className="btn" onClick={()=>setEdit(null)}>Cancel</button></form>}
 <Section title="Recorded work" count={logs.length}>{logs.length?<div className="list">{logs.map((e:Row)=><button className="list-row" key={e.id} disabled={!c.can('tasks.timesheets','update')} onClick={()=>setEdit({...e,duration:formatMinutes(e.minutes)})}><span className="row-main"><strong>{c.tasks.find(t=>t.id===e.task_id)?.title||e.activity||'Independent work'}</strong><span className="row-meta">{e.work_date} · {formatMinutes(e.minutes)} h · {c.data.tm_workspaces.find((w:Row)=>w.id===e.workspace_id)?.name||'No workspace'}</span></span></button>)}</div>:<p className="hint">No time recorded in this period.</p>}</Section></>;
}
