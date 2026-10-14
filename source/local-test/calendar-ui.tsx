// V5.5 Calendar: meetings, task deadlines, personal notes and CRM activities in one place (Month, Week, Day and
// Agenda), in the signed-in person's time zone. Everything shown comes from the server already limited to what this
// person may see: meetings they take part in or that are shared with them, tasks within their Task Visibility Scope,
// and their own notes (nobody else's notes ever reach the browser).
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BellRing, BriefcaseBusiness, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, ClipboardCheck, Lock, MapPin, NotebookPen, Plus, Trash2, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { Row } from './components';
import { DayPanel } from './day-preview';
import type { Workspace } from './ui';
import { enrichedTasks, taskStateLabel } from './task-domain.mjs';
import { useViewState } from './router';
import { displayZone, formatDate, formatTime, zoneName, zonedInput, zonedToIso, plural } from './format';
import { Alert, CheckboxField, DatePickerButton, EmptyState, Field, FilterSelect, IconButton, Segmented, ToggleFilter, useConfirm } from './ui-kit';

type Kind = 'meeting' | 'task' | 'note' | 'activity';
type Item = { key: string; kind: Kind; title: string; day: string; endDay: string; allDay: boolean; start?: string; end?: string; row: Row; overdue?: boolean; done?: boolean; meta: string };
const KINDS: Record<Kind, { label: string; icon: LucideIcon }> = {
  meeting: { label: 'Meetings', icon: Video },
  task: { label: 'Task deadlines', icon: ClipboardCheck },
  note: { label: 'My notes', icon: NotebookPen },
  activity: { label: 'CRM activities', icon: BriefcaseBusiness },
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- days (plain YYYY-MM-DD strings, no time zone)
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const weekStart = (d: string) => addDays(d, -weekday(d));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => { const [y, m] = d.split('-').map(Number), i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`; };
const dayLong = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const dayShort = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
/** The calendar day of a timestamp in the display time zone. */
const dayOf = (iso: string) => zonedInput(iso).slice(0, 10);
const todayKey = () => dayOf(new Date().toISOString());

// ---------------------------------------------------------------- the items this person may see
function useItems(w: Workspace, workspace: string, mine: boolean): Item[] {
  return useMemo(() => {
    const d = w.data, me = w.actor, out: Item[] = [];
    const attendees = new Map<string, string[]>();
    for (const a of d.tm_attendees || []) attendees.set(a.meeting_id, [...(attendees.get(a.meeting_id) || []), a.staff_id]);
    for (const m of d.tm_meetings || []) {
      if (m.status === 'CANCELLED' || (workspace && m.workspace_id !== workspace)) continue;
      const people = attendees.get(m.id) || [], part = m.organizer_id === me || m.created_by === me || people.includes(me);
      if (mine && !part) continue;
      out.push({ key: `m:${m.id}`, kind: 'meeting', title: m.title, day: dayOf(m.start_at), endDay: dayOf(m.end_at), allDay: false, start: m.start_at, end: m.end_at, row: m, done: m.status === 'COMPLETED',
        meta: [m.location, `${people.length} ${plural(people.length, 'person', 'people')}`, part ? '' : 'shared with you'].filter(Boolean).join(' · ') });
    }
    if (w.can('tasks.tasks')) for (const t of enrichedTasks({...d,tm_tasks:d.tm_calendar_tasks || []})) {
      if (t.status === 'CANCELLED' || (workspace && t.workspace_id !== workspace) || (mine && t.access_reason && t.access_reason !== 'involved')) continue;
      out.push({ key: `t:${t.id}`, kind: 'task', title: t.title, day: t.due_date, endDay: t.due_date, allDay: true, row: t, overdue: t.overdue, done: t.status === 'COMPLETED', meta: `Due · ${w.lookup(t.pic_id)} · ${taskStateLabel(t)}` });
    }
    for (const n of d.tm_calendar_notes || []) out.push({ key: `n:${n.id}`, kind: 'note', title: n.title, day: n.all_day ? n.day : dayOf(n.start_at), endDay: n.all_day ? n.day : dayOf(n.end_at || n.start_at), allDay: !!n.all_day, start: n.start_at || undefined, end: n.end_at || undefined, row: n, done: !!n.done, meta: 'Only you can see this note' });
    if (w.can('crm.activities')) for (const a of d.activities || []) {
      if (a.assigned_to !== me || a.status !== 'OPEN' || !a.start_at || workspace) continue;
      out.push({ key: `a:${a.id}`, kind: 'activity', title: a.subject, day: dayOf(a.start_at), endDay: dayOf(a.end_at || a.start_at), allDay: false, start: a.start_at, end: a.end_at || undefined, row: a, meta: `${String(a.channel || '').toLowerCase()} · ${a.id}` });
    }
    // All-day items first (deadlines, then notes), then by time.
    return out.sort((x, y) => x.day.localeCompare(y.day) || Number(y.allDay) - Number(x.allDay) || (x.start || '').localeCompare(y.start || '') || x.title.localeCompare(y.title));
  }, [w.data, workspace, mine]); // eslint-disable-line react-hooks/exhaustive-deps
}
const itemsOn = (items: Item[], day: string) => items.filter(i => i.day <= day && i.endDay >= day);
const timeText = (i: Item, day?: string) => i.allDay ? (i.kind === 'task' ? 'Due' : 'All day') : i.day !== i.endDay && day && day !== i.day ? (day === i.endDay ? `until ${formatTime(i.end)}` : 'All day') : `${formatTime(i.start)}${i.end && i.kind !== 'activity' ? `–${formatTime(i.end)}` : ''}`;

export type CalendarActions = { openTask: (id: string) => void; openMeeting: (m: Row) => void; newMeeting?: (day: string) => void };

export function CalendarView({ w, workspace, setWorkspace, actions }: { w: Workspace; workspace: string; setWorkspace: (v: string) => void; actions: CalendarActions }) {
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
  const [v, setV] = useViewState('tasks:calendar', { view: '', anchor: '', kinds: ['meeting', 'task', 'note', 'activity'] as string[], mine: false });
  const view = (v.view || (narrow ? 'agenda' : 'month')) as 'month' | 'week' | 'day' | 'agenda';
  const today = todayKey(), anchor = v.anchor || today;
  const [note, setNote] = useState<Row | null>(null), [panelDay, setPanelDay] = useState<string | null>(null);
  useEffect(() => setPanelDay(null), [view, anchor, workspace, v.mine, v.kinds]);
  const selectDay = (day: string, open: boolean) => setPanelDay(current => open ? day : current === day ? null : current);
  const set = (patch: Partial<typeof v>) => setV(s => ({ ...s, ...patch }));
  const all = useItems(w, workspace, v.mine), items = all.filter(i => v.kinds.includes(i.kind));
  const step = (n: number) => set({ anchor: view === 'month' ? addMonths(anchor, n) : view === 'week' ? addDays(anchor, 7 * n) : view === 'day' ? addDays(anchor, n) : addDays(anchor, 30 * n) });
  const open = (i: Item) => i.kind === 'task' ? actions.openTask(i.row.id) : i.kind === 'meeting' ? actions.openMeeting(i.row) : i.kind === 'note' ? setNote({ ...i.row }) : w.show('activity', i.row.id);
  const newNote = (day: string) => setNote({ day, all_day: 1, title: '', body: '', reminder_offsets: '[]' });
  const title = view === 'month' ? `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}` : view === 'week' ? `${formatDate(weekStart(anchor))} – ${formatDate(addDays(weekStart(anchor), 6))}` : view === 'day' ? dayLong(anchor) : `${formatDate(anchor)} – ${formatDate(addDays(anchor, 29))}`;
  const kindToggle = (k: Kind) => { const has = v.kinds.includes(k); set({ kinds: has ? v.kinds.filter(x => x !== k) : [...v.kinds, k] }); };
  const kinds = (Object.keys(KINDS) as Kind[]).filter(k => (k !== 'task' || w.can('tasks.tasks')) && (k !== 'activity' || w.can('crm.activities')));
  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <div className="cal-nav">
          <Button variant="outline" size="sm" onClick={() => set({ anchor: today })} disabled={anchor === today && view !== 'month' || (view === 'month' && anchor.slice(0, 7) === today.slice(0, 7))}>Today</Button>
          <IconButton label={`Previous ${view === 'agenda' ? '30 days' : view}`} icon={ChevronLeft} variant="ghost" onClick={() => step(-1)} />
          <IconButton label={`Next ${view === 'agenda' ? '30 days' : view}`} icon={ChevronRight} variant="ghost" onClick={() => step(1)} />
          <h2 className="cal-title" aria-live="polite">{title}</h2>
          {/* V5.6.8: the date is shown in words in the title; this opens the browser's date picker. */}
          <DatePickerButton className="cal-jump" label="Go to date" value={anchor} onChange={v => set({ anchor: v })} />
        </div>
        <div className="cal-tools">
          <Segmented label="Calendar view" size="sm" value={view} onChange={x => set({ view: x })} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }, { value: 'agenda', label: 'Agenda' }]} />
          <Button size="sm" variant="outline" onClick={() => newNote(view === 'month' && anchor.slice(0, 7) !== today.slice(0, 7) ? anchor : today)}><NotebookPen />Note</Button>
          {actions.newMeeting && <Button size="sm" onClick={() => actions.newMeeting!(anchor < today ? today : anchor)}><CalendarPlus />Meeting</Button>}
        </div>
      </div>
      <div className="cal-filters" role="group" aria-label="Show in the calendar">
        {kinds.map(k => { const K = KINDS[k]; return <button key={k} type="button" className={`cal-kind kind-${k}`} aria-pressed={v.kinds.includes(k)} onClick={() => kindToggle(k)}><K.icon aria-hidden="true" />{K.label}</button>; })}
        <span className="cal-filter-sep" aria-hidden="true" />
        <FilterSelect label="Workspace" value={workspace} onChange={setWorkspace} options={w.data.tm_workspaces.map((r: Row) => [r.id, r.name])} />
        <ToggleFilter label="Only mine" pressed={!!v.mine} onChange={x => set({ mine: x })} />
      </div>
      {view === 'month' ? <MonthGrid anchor={anchor} today={today} items={items} open={open} panelDay={panelDay} onDay={selectDay} onNote={newNote} />
        : view === 'week' ? <WeekColumns anchor={anchor} today={today} items={items} open={open} panelDay={panelDay} onDay={selectDay} onNote={newNote} />
          : view === 'day' ? <DayList day={anchor} today={today} items={items} open={open} onNote={newNote} />
            : <Agenda from={anchor} items={items} open={open} today={today} />}
      {note && <NoteEditor w={w} note={note} onClose={() => setNote(null)} />}
    </div>
  );
}

function ItemButton({ i, open, day, compact = false, month = false }: { i: Item; open: (i: Item) => void; day?: string; compact?: boolean; month?: boolean }) {
  const K = KINDS[i.kind], when = timeText(i, day);
  // V5.6.8: a month cell is narrow, so it shows only the start time (and "Overdue", never "Due"), leaving room for the title.
  const shown = month ? (i.allDay ? (i.kind === 'task' && i.overdue ? 'Overdue' : '') : day && day !== i.day ? '' : formatTime(i.start)) : i.allDay ? (i.kind === 'task' ? (i.overdue ? 'Overdue' : 'Due') : '') : when;
  return (
    <button type="button" className={`cal-item kind-${i.kind}${i.overdue ? ' is-overdue' : ''}${i.done ? ' is-done' : ''}`} onClick={() => open(i)}
      aria-label={`${K.label.replace(/s$/, '')}: ${i.title}, ${when}${i.overdue ? ', overdue' : ''}${i.done ? ', done' : ''}`} title={`${i.title} · ${when}${i.meta ? ` · ${i.meta}` : ''}`}>
      <K.icon aria-hidden="true" />
      {!compact && shown && <span className="cal-item-time">{shown}</span>}
      <span className="cal-item-title">{i.title}</span>
      {i.kind === 'note' && <Lock aria-hidden="true" className="cal-private" />}
    </button>
  );
}

function DayEvents({ day, items, open }: { day: string; items: Item[]; open: (i: Item) => void }) {
  return <ul>{items.map(i => { const K = KINDS[i.kind]; return <li key={i.key}>
    <button type="button" className={`cal-item kind-${i.kind}${i.overdue ? ' is-overdue' : ''}${i.done ? ' is-done' : ''}`} onClick={() => open(i)}>
      <K.icon aria-hidden="true" /><span className="day-preview-event"><span className="cal-item-title">{i.title}</span>
        <small>{K.label.replace(/s$/, '')} · {timeText(i, day)}{i.overdue ? ' · Overdue' : ''}{i.done ? ' · Done' : ''}</small>
        {i.meta && <small>{i.meta}</small>}
      </span>
    </button>
  </li>; })}</ul>;
}

function MonthGrid({ anchor, today, items, open, panelDay, onDay, onNote }: { anchor: string; today: string; items: Item[]; open: (i: Item) => void; panelDay: string | null; onDay: (d: string, open: boolean) => void; onNote: (d: string) => void }) {
  const first = weekStart(monthStart(anchor)), month = anchor.slice(0, 7), weeks: string[][] = [];
  for (let wk = 0; wk < 6; wk++) { const row = Array.from({ length: 7 }, (_, i) => addDays(first, wk * 7 + i)); if (wk > 3 && row[0].slice(0, 7) !== month) break; weeks.push(row); }
  return (
    <table className="cal-month">
      <caption className="sr-only">{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}. Select a date to open its items.</caption>
      <thead><tr>{WEEKDAYS.map(d => <th key={d} scope="col">{d}</th>)}</tr></thead>
      <tbody>
        {weeks.map(row => <tr key={row[0]}>
          {row.map(day => {
            const list = itemsOn(items, day), shown = list.slice(0, 3), more = list.length - shown.length;
            return (
              <DayPanel key={day} open={panelDay === day} onOpenChange={value => onDay(day, value)} label={dayLong(day)} count={list.length} className="calendar" details={<DayEvents day={day} items={list} open={open} />}>
              <td data-calendar-day={day} className={`${day.slice(0, 7) !== month ? 'is-other' : ''}${day === today ? ' is-today' : ''}`}>
                <div className="cal-day-head">
                  <button type="button" className="cal-day-number" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day} aria-label={`${dayLong(day)}: ${list.length} ${plural(list.length, 'item')}. Open the day's items.`}>{Number(day.slice(8))}</button>
                  <button type="button" className="cal-add" onClick={() => onNote(day)} aria-label={`Add a note on ${dayLong(day)}`} title="Add a note"><Plus aria-hidden="true" /></button>
                </div>
                <ul className="cal-day-items">
                  {shown.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} month /></li>)}
                  {more > 0 && <li><button type="button" className="cal-more" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day}>+{more} more</button></li>}
                </ul>
                {list.length > 0 && <span className="cal-dots" aria-hidden="true">{list.slice(0, 4).map(i => <span key={i.key} className={`cal-dot kind-${i.kind}${i.overdue ? ' is-overdue' : ''}`} />)}</span>}
              </td>
              </DayPanel>
            );
          })}
        </tr>)}
      </tbody>
    </table>
  );
}

function WeekColumns({ anchor, today, items, open, panelDay, onDay, onNote }: { anchor: string; today: string; items: Item[]; open: (i: Item) => void; panelDay: string | null; onDay: (d: string, open: boolean) => void; onNote: (d: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));
  return (
    <div className="cal-week">
      {days.map(day => {
        const list = itemsOn(items, day);
        return (
          <DayPanel key={day} open={panelDay === day} onOpenChange={value => onDay(day, value)} label={dayLong(day)} count={list.length} className="calendar" details={<DayEvents day={day} items={list} open={open} />}>
          <section data-calendar-day={day} className={`cal-week-day${day === today ? ' is-today' : ''}`} aria-label={`${dayLong(day)}: ${list.length} ${plural(list.length, 'item')}`}>
            <header><button type="button" className="cal-week-date" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day}><span>{WEEKDAYS[weekday(day)]}</span><strong>{Number(day.slice(8))}</strong></button>
              <button type="button" className="cal-add" onClick={() => onNote(day)} aria-label={`Add a note on ${dayLong(day)}`} title="Add a note"><Plus aria-hidden="true" /></button></header>
            <ul>{list.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} /></li>)}</ul>
            {!list.length && <p className="cal-empty">Nothing planned</p>}
          </section>
          </DayPanel>
        );
      })}
    </div>
  );
}

function DayList({ day, today, items, open, onNote }: { day: string; today: string; items: Item[]; open: (i: Item) => void; onNote: (d: string) => void }) {
  const list = itemsOn(items, day), allDay = list.filter(i => i.allDay || (i.day !== i.endDay && i.day !== day && i.endDay !== day)), timed = list.filter(i => !allDay.includes(i));
  return (
    <div className="cal-day">
      <div className="row-between"><p className="text-section">{day === today ? 'Today · ' : ''}{dayLong(day)}</p><Button size="sm" variant="ghost" onClick={() => onNote(day)}><Plus />Add a note</Button></div>
      {allDay.length > 0 && <ul className="cal-day-allday" aria-label="All day">{allDay.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} /></li>)}</ul>}
      {timed.length ? <ol className="cal-day-timed">{timed.map(i => (
        <li key={i.key} className={`kind-${i.kind}`}>
          <span className="cal-day-time num">{timeText(i, day)}</span>
          <div className="cal-day-body"><ItemButton i={i} open={open} day={day} compact />{i.meta && <p className="muted small">{i.kind === 'meeting' && i.row.location ? <><MapPin aria-hidden="true" className="inline-icon" />{i.meta}</> : i.meta}</p>}</div>
        </li>
      ))}</ol> : !allDay.length && <EmptyState compact icon={CalendarDays} title="Nothing planned for this day" description="Add a personal note, or schedule a meeting." />}
    </div>
  );
}

function Agenda({ from, items, open, today }: { from: string; items: Item[]; open: (i: Item) => void; today: string }) {
  const to = addDays(from, 29), days: [string, Item[]][] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const list = itemsOn(items, d); if (list.length) days.push([d, list]); }
  if (!days.length) return <EmptyState icon={CalendarDays} title="Nothing in these 30 days" description="Meetings, task deadlines, your notes and your CRM activities appear here." />;
  return (
    <div className="agenda cal-agenda">
      {days.map(([day, list]) => (
        <section key={day} className="agenda-day" aria-label={dayLong(day)}>
          <h3 className="agenda-date"><span>{day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : dayShort(day)}</span><small>{formatDate(day)}</small></h3>
          <ul className="agenda-list">{list.map(i => (
            <li key={i.key} className={`cal-agenda-item kind-${i.kind}`}>
              <span className="agenda-time num">{timeText(i, day)}</span>
              <div className="agenda-body"><ItemButton i={i} open={open} day={day} compact /><p className="agenda-meta">{i.meta}</p></div>
            </li>
          ))}</ul>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- reminders (minutes before the start)
export const OFFSET_PRESETS: [number, string][] = [[0, 'At the time'], [15, '15 minutes'], [60, '1 hour'], [1440, '1 day'], [2880, '2 days']];
export const offsetLabel = (n: number) => n === 0 ? 'At the time' : n % 1440 === 0 ? `${n / 1440} day${n === 1440 ? '' : 's'} before` : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'} before` : `${n} minutes before`;
export const parseOffsets = (v: unknown): number[] => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter(n => Number.isInteger(n) && n >= 0) : []; } catch { return []; } };
/** Chooses up to five reminders (minutes before the start), with presets and another amount in minutes, hours or days. */
export function OffsetChooser({ value, onChange, start, label = 'Reminders', hint }: { value: number[]; onChange: (v: number[]) => void; start?: string; label?: string; hint?: ReactNode }) {
  const [amount, setAmount] = useState(''), [unit, setUnit] = useState('60'), [error, setError] = useState('');
  const list = [...new Set(value)].sort((a, b) => b - a), toggle = (n: number, on: boolean) => onChange(on ? [...list, n] : list.filter(x => x !== n));
  const startMs = start ? Date.parse(start) : NaN, past = list.filter(n => Number.isFinite(startMs) && startMs - n * 60000 < Date.now() - 60000);
  const add = () => { const n = Number(amount) * Number(unit); if (!Number.isInteger(n) || n < 1 || n > 43200) { setError('Choose up to 30 days.'); return; } if (list.length >= 5 && !list.includes(n)) { setError('Choose up to five reminders.'); return; } onChange([...list, n]); setAmount(''); setError(''); };
  return (
    <fieldset className="offset-chooser span-2">
      <legend className="field-label">{label}</legend>
      <div className="offset-options">
        {OFFSET_PRESETS.map(([n, text]) => <CheckboxField key={n} label={n === 0 ? text : `${text} before`} checked={list.includes(n)} onChange={x => toggle(n, x)} />)}
        {list.filter(n => !OFFSET_PRESETS.some(([p]) => p === n)).map(n => <span key={n} className="reminder-chip">{offsetLabel(n)}<IconButton label={`Remove the reminder ${offsetLabel(n)}`} icon={X} onClick={() => toggle(n, false)} /></span>)}
      </div>
      <div className="offset-other">
        <Field label="Other" type="number" min="1" value={amount} onChange={x => { setAmount(x); setError(''); }} placeholder="3" error={error} />
        <label className="offset-unit"><span className="sr-only">Unit</span><select value={unit} onChange={e => setUnit(e.target.value)}><option value="1">minutes before</option><option value="60">hours before</option><option value="1440">days before</option></select></label>
        <Button type="button" size="sm" variant="outline" disabled={!amount.trim()} onClick={add}><Plus />Add</Button>
      </div>
      {past.length > 0 && <p className="field-error" role="alert">{past.map(offsetLabel).join(' and ')} would already be in the past. Remove {past.length === 1 ? 'it' : 'them'} or move the start.</p>}
      {hint && <p className="field-hint">{hint}</p>}
    </fieldset>
  );
}

// ---------------------------------------------------------------- personal notes (only their owner sees them)
function NoteEditor({ w, note, onClose }: { w: Workspace; note: Row; onClose: () => void }) {
  const zone = displayZone();
  const [d, setD] = useState<Row>(() => ({ ...note, start_local: note.start_at ? zonedInput(note.start_at) : `${note.day || todayKey()}T09:00`, end_local: note.end_at ? zonedInput(note.end_at) : '', offsets: parseOffsets(note.reminder_offsets) }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), confirm = useConfirm();
  const set = (k: string, v: unknown) => setD(s => ({ ...s, [k]: v }));
  useEffect(() => setError(''), [d.title]);
  const startIso = d.all_day ? zonedToIso(`${d.day}T09:00`, zone) : zonedToIso(d.start_local, zone);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!String(d.title || '').trim()) { setError('Enter a title.'); return; }
    setBusy(true); setError('');
    try {
      await w.perform('tm.calnote.save', { id: d.id, expected_version: d.version, title: d.title, body: d.body || '', all_day: !!d.all_day, day: d.all_day ? d.day : undefined,
        start_at: d.all_day ? undefined : zonedToIso(d.start_local, zone), end_at: d.all_day || !d.end_local ? undefined : zonedToIso(d.end_local, zone), reminder_offsets: d.offsets, done: !!d.done });
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${note.title}”?`, description: 'The note and its reminders are deleted.', confirmLabel: 'Delete note', tone: 'danger' }))) return;
    setBusy(true);
    try { await w.perform('tm.calnote.delete', { id: note.id, expected_version: note.version }); onClose(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle>{note.id ? 'Your note' : 'New note'}</DialogTitle><DialogDescription><Lock aria-hidden="true" className="inline-icon" />Only you can see your notes and their reminders.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title="This could not be saved" live>{error}</Alert>}
              <Field label="Title" value={d.title || ''} onChange={v => set('title', v)} required maxLength={200} />
              <CheckboxField label="All day" checked={!!d.all_day} onChange={v => set('all_day', v ? 1 : 0)} />
              {d.all_day ? <Field label="Date" type="date" value={d.day || ''} onChange={v => set('day', v)} required />
                : <div className="grid-2"><Field label={`Starts (${zoneName(zone)})`} type="datetime-local" value={d.start_local} onChange={v => set('start_local', v)} required /><Field label="Ends (optional)" type="datetime-local" value={d.end_local || ''} onChange={v => set('end_local', v)} /></div>}
              <Field label="Note" type="textarea" rows={4} value={d.body || ''} onChange={v => set('body', v)} maxLength={4000} />
              <OffsetChooser value={d.offsets} onChange={v => set('offsets', v)} start={startIso} hint={d.all_day ? 'For an all-day note, reminders count back from 09:00 on its day. They reach only you (Task Controlling Management bell and Telegram).' : 'Reminders reach only you (Task Controlling Management bell and Telegram).'} />
              {note.id && <CheckboxField label="Done" description="Done notes stay in your calendar and send no more reminders." checked={!!d.done} onChange={v => set('done', v)} />}
            </div>
            <div className="dialog-footer">
              {note.id && <div className="footer-start"><Button type="button" variant="danger-outline" onClick={() => void remove()}><Trash2 />Delete</Button></div>}
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={busy}>{note.id ? 'Save note' : 'Add note'}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** For a meeting shared with someone who is not taking part: ask for (or stop) its reminders. */
export function FollowMeeting({ w, meeting }: { w: Workspace; meeting: Row }) {
  const following = (w.data.tm_meeting_followers || []).some((f: Row) => f.meeting_id === meeting.id && f.staff_id === w.actor);
  const [busy, setBusy] = useState(false);
  return (
    <Alert tone="neutral" icon={BellRing} title="This meeting is shared with you"
      action={<Button size="sm" variant="outline" loading={busy} onClick={async () => { setBusy(true); try { await w.perform('tm.meeting.follow', { id: meeting.id, follow: !following }); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }}>{following ? 'Stop reminders' : 'Get its reminders'}</Button>}>
      You can see it but not change it. {following ? 'You get its reminders.' : 'Its participants get its reminders; you can ask for them too.'}
    </Alert>
  );
}
