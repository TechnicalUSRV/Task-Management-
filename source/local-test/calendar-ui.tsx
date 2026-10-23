import { formatDisplayDate } from './i18n';
import { uiText, useLanguage, dynamicLabels } from "./i18n";
// V5.5 Calendar: meetings, task deadlines, personal notes and CRM activities in one place (Month, Week, Day and
// Agenda), in the signed-in person's time zone. Everything shown comes from the server already limited to what this
// person may see: meetings they take part in or that are shared with them, tasks within their Task Visibility Scope,
// and their own notes (nobody else's notes ever reach the browser).
// Under My Management (organizational title → employee) narrows these same items to one employee's work: it shows only
// meetings and tasks this person may already see, never anyone's personal notes.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BellRing, BriefcaseBusiness, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, ClipboardCheck, Lock, MapPin, NotebookPen, Plus, Trash2, Users, Video, X } from 'lucide-react';
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
  meeting: { get label() { return uiText("Meetings"); }, icon: Video },
  task: { get label() { return uiText("Task deadlines"); }, icon: ClipboardCheck },
  note: { get label() { return uiText("My notes"); }, icon: NotebookPen },
  activity: { get label() { return uiText("CRM activities"); }, icon: BriefcaseBusiness },
};
const WEEKDAYS = dynamicLabels(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], { 0: () => uiText("Mon"), 1: () => uiText("Tue"), 2: () => uiText("Wed"), 3: () => uiText("Thu"), 4: () => uiText("Fri"), 5: () => uiText("Sat"), 6: () => uiText("Sun") });
const MONTHS = dynamicLabels(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], { 0: () => uiText("January"), 1: () => uiText("February"), 2: () => uiText("March"), 3: () => uiText("April"), 4: () => uiText("May"), 5: () => uiText("June"), 6: () => uiText("July"), 7: () => uiText("August"), 8: () => uiText("September"), 9: () => uiText("October"), 10: () => uiText("November"), 11: () => uiText("December") });

// ---------------------------------------------------------------- days (plain YYYY-MM-DD strings, no time zone)
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const weekStart = (d: string) => addDays(d, -weekday(d));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => { const [y, m] = d.split('-').map(Number), i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`; };
const dayLong = (d: string) => formatDisplayDate(new Date(`${d}T12:00:00Z`), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayShort = (d: string) => formatDisplayDate(new Date(`${d}T12:00:00Z`), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
/** The calendar day of a timestamp in the display time zone. */
const dayOf = (iso: string) => zonedInput(iso).slice(0, 10);
const todayKey = () => dayOf(new Date().toISOString());

// ---------------------------------------------------------------- the items this person may see
/** Under My Management: the people chosen (one employee, everyone with one title, or everyone below me), or null. */
type Managed = { ids: Set<string> } | null;
function useItems(w: Workspace, workspace: string, mine: boolean, managed: Managed): Item[] {
  return useMemo(() => {
    const d = w.data, me = w.actor, out: Item[] = [];
    const attendees = new Map<string, string[]>();
    for (const a of d.tm_attendees || []) attendees.set(a.meeting_id, [...(attendees.get(a.meeting_id) || []), a.staff_id]);
    for (const m of d.tm_meetings || []) {
      if (m.status === 'CANCELLED' || (workspace && m.workspace_id !== workspace)) continue;
      const people = attendees.get(m.id) || [], part = m.organizer_id === me || m.created_by === me || people.includes(me);
      if (mine && !part) continue;
      if (managed && ![m.organizer_id, m.created_by, ...people].some(x => managed.ids.has(x))) continue;
      out.push({ key: `m:${m.id}`, kind: 'meeting', title: m.title, day: dayOf(m.start_at), endDay: dayOf(m.end_at), allDay: false, start: m.start_at, end: m.end_at, row: m, done: m.status === 'COMPLETED',
        meta: [m.location, `${people.length} ${plural(people.length, 'person', 'people')}`, part ? '' : "shared with you"].filter(Boolean).join(' · ') });
    }
    // An employee's task deadlines: the tasks they are on, among the tasks this person may already see.
    const onTask = new Map<string, Set<string>>();
    if (managed) for (const a of d.tm_assignees || []) if (a.status !== 'DECLINED') onTask.set(a.task_id, (onTask.get(a.task_id) || new Set()).add(a.staff_id));
    const taskRows = managed ? (d.tm_tasks || []).filter((t: Row) => [t.pic_id, t.created_by, t.assigned_by, t.reviewer_id, ...(onTask.get(t.id) || [])].some(x => managed.ids.has(x))) : d.tm_calendar_tasks || [];
    if (w.can('tasks.tasks')) for (const t of enrichedTasks({...d,tm_tasks:taskRows})) {
      if (t.status === 'CANCELLED' || (workspace && t.workspace_id !== workspace) || (mine && t.access_reason && t.access_reason !== 'involved')) continue;
      out.push({ key: `t:${t.id}`, kind: 'task', title: t.title, day: t.due_date, endDay: t.due_date, allDay: true, row: t, overdue: t.overdue, done: t.status === 'COMPLETED', meta: `Due · ${w.lookup(t.pic_id)} · ${taskStateLabel(t)}` });
    }
    // Personal notes and CRM activities are always the signed-in person's own: they are not part of someone else's calendar.
    if (!managed) for (const n of d.tm_calendar_notes || []) out.push({ key: `n:${n.id}`, kind: 'note', title: n.title, day: n.all_day ? n.day : dayOf(n.start_at), endDay: n.all_day ? n.day : dayOf(n.end_at || n.start_at), allDay: !!n.all_day, start: n.start_at || undefined, end: n.end_at || undefined, row: n, done: !!n.done, meta: 'Only you can see this note' });
    if (!managed && w.can('crm.activities')) for (const a of d.activities || []) {
      if (a.assigned_to !== me || a.status !== 'OPEN' || !a.start_at || workspace) continue;
      out.push({ key: `a:${a.id}`, kind: 'activity', title: a.subject, day: dayOf(a.start_at), endDay: dayOf(a.end_at || a.start_at), allDay: false, start: a.start_at, end: a.end_at || undefined, row: a, meta: `${String(a.channel || '').toLowerCase()} · ${a.id}` });
    }
    // All-day items first (deadlines, then notes), then by time.
    return out.sort((x, y) => x.day.localeCompare(y.day) || Number(y.allDay) - Number(x.allDay) || (x.start || '').localeCompare(y.start || '') || x.title.localeCompare(y.title));
  }, [w.data, workspace, mine, managed]); // eslint-disable-line react-hooks/exhaustive-deps
}
const itemsOn = (items: Item[], day: string) => items.filter(i => i.day <= day && i.endDay >= day);
const timeText = (i: Item, day?: string) => i.allDay ? (i.kind === 'task' ? uiText("Due") : uiText("All day")) : i.day !== i.endDay && day && day !== i.day ? (day === i.endDay ? `until ${formatTime(i.end)}` : uiText("All day")) : `${formatTime(i.start)}${i.end && i.kind !== 'activity' ? `–${formatTime(i.end)}` : ''}`;

export type CalendarActions = { openTask: (id: string) => void; openMeeting: (m: Row) => void; newMeeting?: (day: string) => void };

export function CalendarView({ w, workspace, setWorkspace, actions }: { w: Workspace; workspace: string; setWorkspace: (v: string) => void; actions: CalendarActions }) {
  useLanguage();
  const narrow = typeof window !== 'undefined' && window.matchMedia?.("(max-width: 640px)").matches;
  const [v, setV] = useViewState('tasks:calendar', { view: '', anchor: '', kinds: ['meeting', 'task', 'note', 'activity'] as string[], mine: false, managed: false, title: '', person: '' });
  const view = (v.view || (narrow ? 'agenda' : 'month')) as 'month' | 'week' | 'day' | 'agenda';
  const today = todayKey(), anchor = v.anchor || today;
  const [note, setNote] = useState<Row | null>(null), [panelDay, setPanelDay] = useState<string | null>(null);
  useEffect(() => setPanelDay(null), [view, anchor, workspace, v.mine, v.kinds]);
  const selectDay = (day: string, open: boolean) => setPanelDay(current => open ? day : current === day ? null : current);
  const set = (patch: Partial<typeof v>) => setV(s => ({ ...s, ...patch }));
  // Under My Management: titles come from Organizational Structure (not "Level 1/2/3"); only people below me are listed.
  const team: Row[] = w.data.management_people || [];
  const titles = [...new Map(team.map(p => [String(p.org_level ?? ''), p.title as string])).entries()].sort((a, b) => (Number(a[0]) || 1001) - (Number(b[0]) || 1001));
  const inTitle = team.filter(p => !v.title || String(p.org_level ?? '') === v.title);
  const managedIds = useMemo<Managed>(() => !v.managed || !team.length ? null : { ids: new Set(v.person ? [v.person] : inTitle.map(p => p.staff_id)) }, [v.managed, v.person, v.title, team]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useItems(w, workspace, v.mine && !managedIds, managedIds), items = all.filter(i => v.kinds.includes(i.kind));
  const step = (n: number) => set({ anchor: view === 'month' ? addMonths(anchor, n) : view === 'week' ? addDays(anchor, 7 * n) : view === 'day' ? addDays(anchor, n) : addDays(anchor, 30 * n) });
  const open = (i: Item) => i.kind === 'task' ? actions.openTask(i.row.id) : i.kind === 'meeting' ? actions.openMeeting(i.row) : i.kind === 'note' ? setNote({ ...i.row }) : w.show('activity', i.row.id);
  const newNote = (day: string) => setNote({ day, all_day: 1, title: '', body: '', reminder_offsets: '[]' });
  const title = view === 'month' ? `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}` : view === 'week' ? `${formatDate(weekStart(anchor))} – ${formatDate(addDays(weekStart(anchor), 6))}` : view === 'day' ? dayLong(anchor) : `${formatDate(anchor)} – ${formatDate(addDays(anchor, 29))}`;
  const kindToggle = (k: Kind) => { const has = v.kinds.includes(k); set({ kinds: has ? v.kinds.filter(x => x !== k) : [...v.kinds, k] }); };
  const kinds = (Object.keys(KINDS) as Kind[]).filter(k => (k !== 'task' || w.can('tasks.tasks')) && (k !== 'activity' || w.can('crm.activities')) && (!managedIds || (k !== 'note' && k !== 'activity')));
  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <div className="cal-nav">
          <Button variant="outline" size="sm" onClick={() => set({ anchor: today })} disabled={anchor === today && view !== 'month' || (view === 'month' && anchor.slice(0, 7) === today.slice(0, 7))}>{uiText("Today")}</Button>
          <IconButton label={uiText("Previous {p0}", { p0: view === 'agenda' ? '30 days' : view })} icon={ChevronLeft} variant="ghost" onClick={() => step(-1)} />
          <IconButton label={uiText("Next {p0}", { p0: view === 'agenda' ? '30 days' : view })} icon={ChevronRight} variant="ghost" onClick={() => step(1)} />
          <h2 className="cal-title" aria-live="polite">{title}</h2>
          {/* V5.6.8: the date is shown in words in the title; this opens the browser's date picker. */}
          <DatePickerButton className="cal-jump" label={uiText("Go to date")} value={anchor} onChange={v => set({ anchor: v })} />
        </div>
        <div className="cal-tools">
          <Segmented label={uiText("Calendar view")} size="sm" value={view} onChange={x => set({ view: x })} options={[{ value: 'month', label: uiText("Month") }, { value: 'week', label: uiText("Week") }, { value: 'day', label: uiText("Day") }, { value: 'agenda', label: uiText("Agenda") }]} />
          <Button size="sm" variant="outline" onClick={() => newNote(view === 'month' && anchor.slice(0, 7) !== today.slice(0, 7) ? anchor : today)}><NotebookPen />{uiText("Note")}</Button>
          {actions.newMeeting && <Button size="sm" onClick={() => actions.newMeeting!(anchor < today ? today : anchor)}><CalendarPlus />{uiText("Meeting")}</Button>}
        </div>
      </div>
      <div className="cal-filters" role="group" aria-label={uiText("Show in the calendar")}>
        {kinds.map(k => { const K = KINDS[k]; return <button key={k} type="button" className={`cal-kind kind-${k}`} aria-pressed={v.kinds.includes(k)} onClick={() => kindToggle(k)}><K.icon aria-hidden="true" />{K.label}</button>; })}
        <span className="cal-filter-sep" aria-hidden="true" />
        <FilterSelect label={uiText("Workspace")} value={workspace} onChange={setWorkspace} options={w.data.tm_workspaces.map((r: Row) => [r.id, r.name])} />
        <ToggleFilter label={uiText("Only mine")} pressed={!!v.mine && !v.managed} onChange={x => set({ mine: x, ...(x ? { managed: false, title: '', person: '' } : {}) })} />
        {team.length > 0 && <ToggleFilter label={uiText("Under My Management")} pressed={!!v.managed} onChange={x => set({ managed: x, title: '', person: '', ...(x ? { mine: false } : {}) })} />}
        {v.managed && team.length > 0 && <>
          <FilterSelect label={uiText("Title")} allLabel="All titles" value={v.title} onChange={x => set({ title: x, person: '' })} options={titles} />
          <FilterSelect label={uiText("Employee")} allLabel={v.title ? uiText("Everyone with this title") : uiText("Everyone I manage")} value={v.person} onChange={x => set({ person: x })} options={inTitle.map(p => [p.staff_id, p.name] as [string, string])} people />
        </>}
      </div>
      {v.managed && team.length > 0 && <p className="cal-scope-note muted small" role="status"><Users aria-hidden="true" className="inline-icon" />{v.person ? uiText("{p0}’s", { p0: w.lookup(v.person) }) : v.title ? uiText("{p0} team’s", { p0: titles.find(([k]) => k === v.title)?.[1] || 'Selected title' }) : uiText("Your team’s")} {uiText("meetings and task deadlines that you are allowed to see. Personal notes stay private.")}</p>}
      {view === 'month' ? <MonthGrid anchor={anchor} today={today} items={items} open={open} panelDay={panelDay} onDay={selectDay} onNote={newNote} />
        : view === 'week' ? <WeekColumns anchor={anchor} today={today} items={items} open={open} panelDay={panelDay} onDay={selectDay} onNote={newNote} />
          : view === 'day' ? <DayList day={anchor} today={today} items={items} open={open} onNote={newNote} />
            : <Agenda from={anchor} items={items} open={open} today={today} />}
      {note && <NoteEditor w={w} note={note} onClose={() => setNote(null)} />}
    </div>
  );
}

function ItemButton({ i, open, day, compact = false, month = false }: { i: Item; open: (i: Item) => void; day?: string; compact?: boolean; month?: boolean }) {
  useLanguage();
  const K = KINDS[i.kind], when = timeText(i, day);
  // V5.6.8: a month cell is narrow, so it shows only the start time (and "Overdue", never "Due"), leaving room for the title.
  const shown = month ? (i.allDay ? (i.kind === 'task' && i.overdue ? uiText("Overdue") : '') : day && day !== i.day ? '' : formatTime(i.start)) : i.allDay ? (i.kind === 'task' ? (i.overdue ? uiText("Overdue") : uiText("Due")) : '') : when;
  return (
    <button type="button" className={`cal-item kind-${i.kind}${i.overdue ? " is-overdue" : ''}${i.done ? " is-done" : ''}`} onClick={() => open(i)}
      aria-label={uiText("{p0}: {p1}, {p2}{p3}{p4}", { p0: K.label.replace(/s$/, ''), p1: i.title, p2: when, p3: i.overdue ? ', overdue' : '', p4: i.done ? ', done' : '' })} title={uiText("{p0} · {p1}{p2}", { p0: i.title, p1: when, p2: i.meta ? ` · ${i.meta}` : '' })}>
      <K.icon aria-hidden="true" />
      {!compact && shown && <span className="cal-item-time">{shown}</span>}
      <span className="cal-item-title">{i.title}</span>
      {i.kind === 'note' && <Lock aria-hidden="true" className="cal-private" />}
    </button>
  );
}

function DayEvents({ day, items, open }: { day: string; items: Item[]; open: (i: Item) => void }) {
  useLanguage();
  return <ul>{items.map(i => { const K = KINDS[i.kind]; return <li key={i.key}>
    <button type="button" className={`cal-item kind-${i.kind}${i.overdue ? " is-overdue" : ''}${i.done ? " is-done" : ''}`} onClick={() => open(i)}>
      <K.icon aria-hidden="true" /><span className="day-preview-event"><span className="cal-item-title">{i.title}</span>
        <small>{K.label.replace(/s$/, '')} · {timeText(i, day)}{i.overdue ? uiText(" · Overdue") : ''}{i.done ? uiText(" · Done") : ''}</small>
        {i.meta && <small>{i.meta}</small>}
      </span>
    </button>
  </li>; })}</ul>;
}

function MonthGrid({ anchor, today, items, open, panelDay, onDay, onNote }: { anchor: string; today: string; items: Item[]; open: (i: Item) => void; panelDay: string | null; onDay: (d: string, open: boolean) => void; onNote: (d: string) => void }) {
  useLanguage();
  const first = weekStart(monthStart(anchor)), month = anchor.slice(0, 7), weeks: string[][] = [];
  for (let wk = 0; wk < 6; wk++) { const row = Array.from({ length: 7 }, (_, i) => addDays(first, wk * 7 + i)); if (wk > 3 && row[0].slice(0, 7) !== month) break; weeks.push(row); }
  return (
    <table className="cal-month">
      <caption className="sr-only">{MONTHS[Number(month.slice(5)) - 1]} {month.slice(0, 4)}{uiText(". Select a date to open its items.")}</caption>
      <thead><tr>{WEEKDAYS.map(d => <th key={d} scope="col">{d}</th>)}</tr></thead>
      <tbody>
        {weeks.map(row => <tr key={row[0]}>
          {row.map(day => {
            const list = itemsOn(items, day), shown = list.slice(0, 3), more = list.length - shown.length;
            return (
              <DayPanel key={day} open={panelDay === day} onOpenChange={value => onDay(day, value)} label={dayLong(day)} count={list.length} className="calendar" details={<DayEvents day={day} items={list} open={open} />}>
              <td data-calendar-day={day} className={`${day.slice(0, 7) !== month ? 'is-other' : ''}${day === today ? " is-today" : ''}`}>
                <div className="cal-day-head">
                  <button type="button" className="cal-day-number" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day} aria-label={uiText("{p0}: {p1} {p2}. Open the day's items.", { p0: dayLong(day), p1: list.length, p2: plural(list.length, 'item') })}>{Number(day.slice(8))}</button>
                  <button type="button" className="cal-add" onClick={() => onNote(day)} aria-label={uiText("Add a note on {p0}", { p0: dayLong(day) })} title={uiText("Add a note")}><Plus aria-hidden="true" /></button>
                </div>
                <ul className="cal-day-items">
                  {shown.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} month /></li>)}
                  {more > 0 && <li><button type="button" className="cal-more" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day}>+{more} more</button></li>}
                </ul>
                {list.length > 0 && <span className="cal-dots" aria-hidden="true">{list.slice(0, 4).map(i => <span key={i.key} className={`cal-dot kind-${i.kind}${i.overdue ? " is-overdue" : ''}`} />)}</span>}
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
  useLanguage();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));
  return (
    <div className="cal-week">
      {days.map(day => {
        const list = itemsOn(items, day);
        return (
          <DayPanel key={day} open={panelDay === day} onOpenChange={value => onDay(day, value)} label={dayLong(day)} count={list.length} className="calendar" details={<DayEvents day={day} items={list} open={open} />}>
          <section data-calendar-day={day} className={`cal-week-day${day === today ? " is-today" : ''}`} aria-label={uiText("{p0}: {p1} {p2}", { p0: dayLong(day), p1: list.length, p2: plural(list.length, 'item') })}>
            <header><button type="button" className="cal-week-date" data-day-trigger aria-haspopup="dialog" aria-expanded={panelDay === day}><span>{WEEKDAYS[weekday(day)]}</span><strong>{Number(day.slice(8))}</strong></button>
              <button type="button" className="cal-add" onClick={() => onNote(day)} aria-label={uiText("Add a note on {p0}", { p0: dayLong(day) })} title={uiText("Add a note")}><Plus aria-hidden="true" /></button></header>
            <ul>{list.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} /></li>)}</ul>
            {!list.length && <p className="cal-empty">{uiText("Nothing planned")}</p>}
          </section>
          </DayPanel>
        );
      })}
    </div>
  );
}

function DayList({ day, today, items, open, onNote }: { day: string; today: string; items: Item[]; open: (i: Item) => void; onNote: (d: string) => void }) {
  useLanguage();
  const list = itemsOn(items, day), allDay = list.filter(i => i.allDay || (i.day !== i.endDay && i.day !== day && i.endDay !== day)), timed = list.filter(i => !allDay.includes(i));
  return (
    <div className="cal-day">
      <div className="row-between"><p className="text-section">{day === today ? uiText("Today · ") : ''}{dayLong(day)}</p><Button size="sm" variant="ghost" onClick={() => onNote(day)}><Plus />{uiText("Add a note")}</Button></div>
      {allDay.length > 0 && <ul className="cal-day-allday" aria-label={uiText("All day")}>{allDay.map(i => <li key={i.key}><ItemButton i={i} open={open} day={day} /></li>)}</ul>}
      {timed.length ? <ol className="cal-day-timed">{timed.map(i => (
        <li key={i.key} className={`kind-${i.kind}`}>
          <span className="cal-day-time num">{timeText(i, day)}</span>
          <div className="cal-day-body"><ItemButton i={i} open={open} day={day} compact />{i.meta && <p className="muted small">{i.kind === 'meeting' && i.row.location ? <><MapPin aria-hidden="true" className="inline-icon" />{i.meta}</> : i.meta}</p>}</div>
        </li>
      ))}</ol> : !allDay.length && <EmptyState compact icon={CalendarDays} title={uiText("Nothing planned for this day")} description={uiText("Add a personal note, or schedule a meeting.")} />}
    </div>
  );
}

function Agenda({ from, items, open, today }: { from: string; items: Item[]; open: (i: Item) => void; today: string }) {
  useLanguage();
  const to = addDays(from, 29), days: [string, Item[]][] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const list = itemsOn(items, d); if (list.length) days.push([d, list]); }
  if (!days.length) return <EmptyState icon={CalendarDays} title={uiText("Nothing in these 30 days")} description={uiText("Meetings, task deadlines, your notes and your CRM activities appear here.")} />;
  return (
    <div className="agenda cal-agenda">
      {days.map(([day, list]) => (
        <section key={day} className="agenda-day" aria-label={dayLong(day)}>
          <h3 className="agenda-date"><span>{day === today ? uiText("Today") : day === addDays(today, 1) ? uiText("Tomorrow") : dayShort(day)}</span><small>{formatDate(day)}</small></h3>
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
export const OFFSET_PRESETS: [number, string][] = [dynamicLabels([0, "At the time"], { 1: () => uiText("At the time") }), dynamicLabels([15, "15 minutes"], { 1: () => uiText("15 minutes") }), dynamicLabels([60, "1 hour"], { 1: () => uiText("1 hour") }), dynamicLabels([1440, "1 day"], { 1: () => uiText("1 day") }), dynamicLabels([2880, "2 days"], { 1: () => uiText("2 days") })];
export const offsetLabel = (n: number) => n === 0 ? uiText("At the time") : n % 1440 === 0 ? `${n / 1440} day${n === 1440 ? '' : 's'} before` : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'} before` : `${n} minutes before`;
export const parseOffsets = (v: unknown): number[] => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter(n => Number.isInteger(n) && n >= 0) : []; } catch { return []; } };
/** Chooses up to five reminders (minutes before the start), with presets and another amount in minutes, hours or days. */
export function OffsetChooser({ value, onChange, start, label = 'Reminders', hint }: { value: number[]; onChange: (v: number[]) => void; start?: string; label?: string; hint?: ReactNode }) {
  useLanguage();
  const [amount, setAmount] = useState(''), [unit, setUnit] = useState('60'), [error, setError] = useState('');
  const list = [...new Set(value)].sort((a, b) => b - a), toggle = (n: number, on: boolean) => onChange(on ? [...list, n] : list.filter(x => x !== n));
  const startMs = start ? Date.parse(start) : NaN, past = list.filter(n => Number.isFinite(startMs) && startMs - n * 60000 < Date.now() - 60000);
  const add = () => { const n = Number(amount) * Number(unit); if (!Number.isInteger(n) || n < 1 || n > 43200) { setError(uiText("Choose up to 30 days.")); return; } if (list.length >= 5 && !list.includes(n)) { setError(uiText("Choose up to five reminders.")); return; } onChange([...list, n]); setAmount(''); setError(''); };
  return (
    <fieldset className="offset-chooser span-2">
      <legend className="field-label">{label}</legend>
      <div className="offset-options">
        {OFFSET_PRESETS.map(([n, text]) => <CheckboxField key={n} label={n === 0 ? text : uiText("{p0} before", { p0: text })} checked={list.includes(n)} onChange={x => toggle(n, x)} />)}
        {list.filter(n => !OFFSET_PRESETS.some(([p]) => p === n)).map(n => <span key={n} className="reminder-chip">{offsetLabel(n)}<IconButton label={uiText("Remove the reminder {p0}", { p0: offsetLabel(n) })} icon={X} onClick={() => toggle(n, false)} /></span>)}
      </div>
      <div className="offset-other">
        <Field label={uiText("Other")} type="number" min="1" value={amount} onChange={x => { setAmount(x); setError(''); }} placeholder="3" error={error} />
        <label className="offset-unit"><span className="sr-only">{uiText("Unit")}</span><select value={unit} onChange={e => setUnit(e.target.value)}><option value="1">{uiText("minutes before")}</option><option value="60">{uiText("hours before")}</option><option value="1440">{uiText("days before")}</option></select></label>
        <Button type="button" size="sm" variant="outline" disabled={!amount.trim()} onClick={add}><Plus />{uiText("Add")}</Button>
      </div>
      {past.length > 0 && <p className="field-error" role="alert">{past.map(offsetLabel).join(' and ')} {uiText("would already be in the past. Remove ")}{past.length === 1 ? 'it' : 'them'} {uiText("or move the start.")}</p>}
      {hint && <p className="field-hint">{hint}</p>}
    </fieldset>
  );
}

// ---------------------------------------------------------------- personal notes (only their owner sees them)
function NoteEditor({ w, note, onClose }: { w: Workspace; note: Row; onClose: () => void }) {
  useLanguage();
  const zone = displayZone();
  const [d, setD] = useState<Row>(() => ({ ...note, start_local: note.start_at ? zonedInput(note.start_at) : `${note.day || todayKey()}T09:00`, end_local: note.end_at ? zonedInput(note.end_at) : '', offsets: parseOffsets(note.reminder_offsets) }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), confirm = useConfirm();
  const set = (k: string, v: unknown) => setD(s => ({ ...s, [k]: v }));
  useEffect(() => setError(''), [d.title]);
  const startIso = d.all_day ? zonedToIso(`${d.day}T09:00`, zone) : zonedToIso(d.start_local, zone);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!String(d.title || '').trim()) { setError(uiText("Enter a title.")); return; }
    setBusy(true); setError('');
    try {
      await w.perform('tm.calnote.save', { id: d.id, expected_version: d.version, title: d.title, body: d.body || '', all_day: !!d.all_day, day: d.all_day ? d.day : undefined,
        start_at: d.all_day ? undefined : zonedToIso(d.start_local, zone), end_at: d.all_day || !d.end_local ? undefined : zonedToIso(d.end_local, zone), reminder_offsets: d.offsets, done: !!d.done });
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: uiText("Delete “{p0}”?", { p0: note.title }), description: uiText("The note and its reminders are deleted."), confirmLabel: uiText("Delete note"), tone: 'danger' }))) return;
    setBusy(true);
    try { await w.perform('tm.calnote.delete', { id: note.id, expected_version: note.version }); onClose(); } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle>{note.id ? uiText("Your note") : uiText("New note")}</DialogTitle><DialogDescription><Lock aria-hidden="true" className="inline-icon" />{uiText("Only you can see your notes and their reminders.")}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
              <Field label={uiText("Title")} value={d.title || ''} onChange={v => set('title', v)} required maxLength={200} />
              <CheckboxField label={uiText("All day")} checked={!!d.all_day} onChange={v => set('all_day', v ? 1 : 0)} />
              {d.all_day ? <Field label={uiText("Date")} type="date" value={d.day || ''} onChange={v => set('day', v)} required />
                : <div className="grid-2"><Field label={uiText("Starts ({p0})", { p0: zoneName(zone) })} type="datetime-local" value={d.start_local} onChange={v => set('start_local', v)} required /><Field label={uiText("Ends (optional)")} type="datetime-local" value={d.end_local || ''} onChange={v => set('end_local', v)} /></div>}
              <Field label={uiText("Note")} type="textarea" rows={4} value={d.body || ''} onChange={v => set('body', v)} maxLength={4000} />
              <OffsetChooser value={d.offsets} onChange={v => set('offsets', v)} start={startIso} hint={d.all_day ? uiText("For an all-day note, reminders count back from 09:00 on its day. They reach only you (Task Controlling Management bell and Telegram).") : uiText("Reminders reach only you (Task Controlling Management bell and Telegram).")} />
              {note.id && <CheckboxField label={uiText("Done")} description={uiText("Done notes stay in your calendar and send no more reminders.")} checked={!!d.done} onChange={v => set('done', v)} />}
            </div>
            <div className="dialog-footer">
              {note.id && <div className="footer-start"><Button type="button" variant="danger-outline" onClick={() => void remove()}><Trash2 />{uiText("Delete")}</Button></div>}
              <Button type="button" variant="outline" onClick={onClose}>{uiText("Cancel")}</Button>
              <Button type="submit" loading={busy}>{note.id ? uiText("Save note") : uiText("Add note")}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** For a meeting shared with someone who is not taking part: ask for (or stop) its reminders. */
export function FollowMeeting({ w, meeting }: { w: Workspace; meeting: Row }) {
  useLanguage();
  const following = (w.data.tm_meeting_followers || []).some((f: Row) => f.meeting_id === meeting.id && f.staff_id === w.actor);
  const [busy, setBusy] = useState(false);
  return (
    <Alert tone="neutral" icon={BellRing} title={uiText("This meeting is shared with you")}
      action={<Button size="sm" variant="outline" loading={busy} onClick={async () => { setBusy(true); try { await w.perform('tm.meeting.follow', { id: meeting.id, follow: !following }); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }}>{following ? uiText("Stop reminders") : uiText("Get its reminders")}</Button>}>
      {uiText("You can see it but not change it. ")}{following ? uiText("You get its reminders.") : uiText("Its participants get its reminders; you can ask for them too.")}
    </Alert>
  );
}
