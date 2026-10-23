import { uiText, useLanguage, dynamicLabels, translatedEntries , translatedMap } from "./i18n";
import {Identity} from './identity-ui';
import {timeRange,rangeDays} from './time-range.mjs';
import {MeetingApprovals} from './meeting-approval-ui';
import { RecurrenceFields } from './recurrence-ui';
import { WorkspaceSections } from './workspace-sections';
import { OrganizationPage } from './organization-ui';
import { apiFetch, apiPath, uuid } from './api-client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, CalendarDays, Eye as EyeIcon, ChevronLeft, ChevronRight, Clock3, Columns3, Download, FolderKanban, GitBranch, LayoutGrid, Link2, List, ListChecks,
  Paperclip, Pencil, Plus, Printer, Repeat, Scale, Send, Sheet, Trash2, Users, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import type { Row } from './components';
import type { PersonOption } from './ui-kit';
import type { Workspace } from './ui';
import { TASK_SECTIONS as EN_TASK_SECTIONS, TASK_STATUS as EN_TASK_STATUS, TASK_COLORS, TASK_REPORTS as EN_TASK_REPORTS, MONTHLY_REPORTS as EN_MONTHLY_REPORTS, OPEN_TASK_STATUSES, RECURRENCE as EN_RECURRENCE, RECURRENCE_SHORT as EN_RECURRENCE_SHORT, enrichedTasks, workspaceStats, formatMinutes, taskToday, weekStart, addDays, taskActions, editApprovalTarget, reminderDays, REMINDER_PRESETS, assignedByMe, toReviewOrApprove, canManageMeeting } from './task-domain.mjs';
import { TaskCategories, TaskVisibility } from './task-access-ui';
import { TaskDetail, TaskStateBadge, RequestsView, RequestDialog, RequestEditor, MonthlyTaskReport, requestDraft, useTasks, peopleOptions, profileOptions, SupportNote, firstName, canApproveOn, mayDecideDue, SCOPE_NOTE, SCOPE_CHIP } from './task-workflow-ui';
import { CalendarView, FollowMeeting, OffsetChooser, parseOffsets } from './calendar-ui';
import { GroupsView } from './groups-ui';
import { PhotoControl } from './profile-ui';
import { useServerReport } from './report-hook';
import { useViewState, type Route } from './router';
import { displayZone, formatDate, formatDateTime, isMissing, plural, zoneName, zoneOffset, zoneOptions, zonedInput, zonedToIso } from './format';
import {
  Alert, Avatar, AvatarStack, BarList, ButtonLink, Card, CheckboxField, DataTable, DatePickerButton, DateRangeFilter, DateText, EmptyState, ErrorState, ExpandableText, Field,
  FilterBar, FilterSelect, FormSection, IconButton, NoAccess, PageHeader, PeoplePicker, PersonPicker, Picker, PriorityBadge, ProgressBar, SearchInput, Segmented,
  StatCard, StatusBadge, ToggleFilter, buildChips, statusLabel, useConfirm, useFormErrors, type Column, type DateRange,
} from './ui-kit';
const TASK_SECTIONS = translatedMap(EN_TASK_SECTIONS);
const TASK_STATUS = translatedMap(EN_TASK_STATUS);
const TASK_REPORTS = translatedMap(EN_TASK_REPORTS);
const MONTHLY_REPORTS = translatedMap(EN_MONTHLY_REPORTS);
const RECURRENCE = translatedMap(EN_RECURRENCE);
const RECURRENCE_SHORT = translatedMap(EN_RECURRENCE_SHORT);

const organizationRead = async (params: Row) => { const res = await apiFetch('/api/organization?' + new URLSearchParams(params as Record<string,string>)); const data = await res.json(); if (!res.ok) throw new Error(data.error || uiText("Unable to load organization")); return data; };
const entries = (o: Record<string, string>): [string, string][] => translatedEntries(o);
type Kind = 'workspace' | 'profile' | 'task' | 'time' | 'meeting';
type TaskModal = { kind: Kind; data: Row };
const CREATE_LABEL: Record<string, string> = translatedMap({ workspace: 'New workspace', users: 'Add team member', tasks: 'New task', timesheets: 'Log time', calendar: 'Schedule meeting' });
const CREATE_KIND: Record<string, Kind> = { workspace: 'workspace', users: 'profile', tasks: 'task', timesheets: 'time', calendar: 'meeting' };
const CREATE_RESOURCE: Record<string, string> = { calendar: 'tasks.meetings' };
const STATUS_ORDER = Object.keys(TASK_STATUS);

export function taskDraft(w: Workspace, kind: Kind, row: Row = {}, workspace = ''): Row {
  const d = w.data, wid = row.workspace_id || workspace || d.tm_workspaces.find((r: Row) => r.status === 'ACTIVE' && r.org_access?.can_create !== false)?.id || '';
  const members = d.tm_members.filter((m: Row) => m.workspace_id === wid).map((m: Row) => m.staff_id), owner = members.includes(w.actor) ? w.actor : members[0] || w.actor;
  const common = { ...row, expected_version: row.version, request_key: uuid() };
  if (kind === 'workspace') return { kind: d.organization?.enabled ? 'PERSONAL' : 'LEGACY', name: '', description: '', department: '', owner_id: w.actor, color: 'BLUE', member_ids: row.id ? d.tm_members.filter((m: Row) => m.workspace_id === row.id).map((m: Row) => m.staff_id) : [w.actor],
    manager_ids: row.id ? [...(row.org_access?.manager_ids || [])] : d.workspace_setup?.primary_manager_id ? [d.workspace_setup.primary_manager_id] : [], team_ids: [], ...common };
  if (kind === 'profile') return { name: '', email: '', phone: '', position: '', department: '', active: 1, ...common, ...(row.username ? {name:row.username} : {}) };
  if (kind === 'task') {
    // Supporting people who rejected are kept on record but are not in the list (they can be asked again).
    const all = row.id ? d.tm_assignees.filter((a: Row) => a.task_id === row.id && a.status !== 'DECLINED').map((a: Row) => a.staff_id) : [];
    const pic = row.pic_id || all[0] || w.actor, ws = d.tm_workspaces.find((x: Row) => x.id === wid);
    return { workspace_id: wid, title: '', description: '', start_date: taskToday(), due_date: addDays(taskToday(), 3), status: 'NOT_STARTED', priority: 'MEDIUM', progress: 0, estimate: formatMinutes(row.estimate_minutes || 0),
      related_type: '', related_id: '', activity_id: '', department: ws?.department || '', department_note: '', reviewer_id: w.actor, recurrence: '', recurrence_until: '', checklist: [], reminder_days: [1], change_note: '', ...common,
      pic_id: pic, supporter_ids: all.filter((x: string) => x !== pic), assignee_ids: undefined };
  }
  if (kind === 'time') return { task_id: '', workspace_id:'',activity:'', staff_id: w.actor, work_date: taskToday(), duration: formatMinutes(row.minutes || 60), notes: '', ...common };
  // V5.5: meeting times are edited in the person's own time zone; sharing and reminders belong to the meeting.
  // V5.6.8: whoever schedules a meeting organizes it, unless they may approve meetings (then they can choose someone).
  const start = row.start_at || nextHour(), end = row.end_at || new Date(Date.parse(start) + 3600000).toISOString();
  const organizer = row.id ? row.organizer_id : w.can('tasks.meetings', 'approve') ? owner : w.actor;
  // V5.6.8: a new meeting starts with a reminder that is still ahead (1 hour, else 15 minutes, else none), so its own
  // defaults always save.
  const ahead = [60, 15].find(n => Date.parse(start) - n * 60000 > Date.now() + 60000);
  return { workspace_id: wid, title: '', agenda: '', organizer_id: organizer, attendee_ids: row.id ? d.tm_attendees.filter((a: Row) => a.meeting_id === row.id).map((a: Row) => a.staff_id) : [organizer], status: 'SCHEDULED', location: '', url: '', minutes_notes: '', task_id: '', activity_id: '', share_scope: 'PARTICIPANTS', ...common, ...(row.id?{share_scope:row.share_scope==='SELECTED'?'SELECTED':'PARTICIPANTS'}:{}),
    share_ids: row.id ? (d.tm_meeting_shares || []).filter((x: Row) => x.meeting_id === row.id).map((x: Row) => x.staff_id) : [],
    reminder_offsets: row.id ? parseOffsets(row.reminder_offsets) : ahead === undefined ? [] : [ahead], start_at: zonedInput(start), end_at: zonedInput(end) };
}
/** The start of the next hour in the display time zone. */
const nextHour = () => zonedToIso(zonedInput(new Date(Date.now() + 3600000).toISOString()).slice(0, 14) + '00');
const SHARE_OPTIONS: [string, string][] = [dynamicLabels(['PARTICIPANTS', "Participants only"], { 1: () => uiText("Participants only") }), dynamicLabels(['SELECTED', "Participants and people I choose"], { 1: () => uiText("Participants and people I choose") })];
/** The organizer, the attendees and whoever scheduled it take part in a meeting; others only see it when it is shared with them. */
const takesPart = (w: Workspace, m: Row) => m.organizer_id === w.actor || m.created_by === w.actor || w.data.tm_attendees.some((a: Row) => a.meeting_id === m.id && a.staff_id === w.actor);

// ---------------------------------------------------------------- addresses of open items
// V5.6.8: an open task, task request or group has an address of its own, so the browser's Back (and the Android back
// gesture) closes it, a section change never leaves it open, and the address can be shared. A task opened on the Tasks
// list keeps its V5.5 address (#/tasks/tasks/TASK-…); elsewhere it opens over the section that is showing
// (#/tasks/calendar?task=TASK-…). Groups are #/tasks/groups/<id>; task requests ?request=<id>.
type Nav = { navigate: Workspace['navigate']; route: Route };
/** Whether the address names an open task, task request or group. */
export const itemOpenIn = (route: Route) => route.parts[0] === 'tasks' && (['tasks', 'groups'].includes(route.parts[1]) && !!route.parts[2] || route.query.has('task') || route.query.has('request'));
/** The address of task `id` opened over the Task Management section `section`. */
export function taskRoute(section: string, id: string, query?: URLSearchParams) {
  if (!section || section === 'tasks') return `/tasks/tasks/${encodeURIComponent(id)}`;
  const q = new URLSearchParams(query); q.delete('request'); q.set('task', id);
  return `/tasks/${section}?${q}`;
}
// Whether the history entry before the open item is the list it was opened from: then closing goes back to it (one
// history entry per item, so Back after closing leaves the page instead of reopening it).
let closeGoesBack = false;
/** Opens an item's address: a new history entry from a list, or the same entry when moving from one open item to another. */
export function openItem({ navigate, route }: Nav, path: string) {
  const replace = itemOpenIn(route);
  if (!replace) closeGoesBack = true;
  navigate(path, { replace });
}
/** Closes the open item: back to the list it was opened from, otherwise to `path` (for example after a shared link). */
export function closeItem({ navigate }: Nav, path: string) {
  if (closeGoesBack) { closeGoesBack = false; window.history.back(); }
  else navigate(path, { replace: true });
}

export function TaskManagement(w: Workspace & { section: string; onSection: (s: string) => void; legacy: ReactNode; focus?: { kind: string; id: string } | null; onFocused: () => void; onAdministration: () => void }) {
  useLanguage();
  // V5.6.8: each section keeps its own workspace filter, so choosing one on Tasks no longer narrows the Calendar.
  const [tasksWs, setTasksWs] = useViewState('tasks:workspace:tasks', ''), [groupsWs, setGroupsWs] = useViewState('tasks:workspace:groups', '');
  const [timeWs, setTimeWs] = useViewState('tasks:workspace:timesheets', ''), [calendarWs, setCalendarWs] = useViewState('tasks:workspace:calendar', '');
  const [modal, setModal] = useState<TaskModal | null>(null), [requestForm, setRequestForm] = useState<Row | null>(null);
  const section = w.section, d = w.data, route = w.route, query = route.query;
  // What is open comes from the address (see above).
  const detail = (section === 'tasks' && route.parts[2]) || query.get('task') || null;
  const request = !detail && query.get('request') || null;
  const openGroup = section === 'groups' ? route.parts[2] || '' : '';
  const sectionPath = () => { const q = new URLSearchParams(query); q.delete('task'); q.delete('request'); const s = q.toString(); return `/tasks/${section}${s ? `?${s}` : ''}`; };
  const openTask = (id: string) => openItem(w, taskRoute(section, id, query));
  const closeTask = () => closeItem(w, sectionPath());
  const openRequest = (id: string) => { const q = new URLSearchParams(query); q.delete('task'); q.set('request', id); openItem(w, `/tasks/${section}?${q}`); };
  const setOpenGroup = (id: string) => (id ? openItem(w, `/tasks/groups/${encodeURIComponent(id)}`) : closeItem(w, '/tasks/groups'));
  const sectionWorkspace = ({ tasks: tasksWs, groups: groupsWs, timesheets: timeWs, calendar: calendarWs } as Record<string, string>)[section] || '';
  const open = (kind: Kind, row: Row = {}) => setModal({ kind, data: taskDraft(w, kind, row, sectionWorkspace) });
  useEffect(() => {
    if (!w.focus) return;
    const kind = w.focus.kind;
    if (kind === 'task') openTask(w.focus.id);
    else if (kind === 'request') openRequest(w.focus.id);
    else {
      const table = ({ meeting: 'tm_meetings', workspace: 'tm_workspaces', profile: 'tm_profiles', time: 'tm_timesheets' } as Row)[kind];
      const row = d[table]?.find((r: Row) => (kind === 'profile' ? r.staff_id : r.id) === w.focus?.id);
      if (row) open(kind as Kind, row);
    }
    w.onFocused();
  }, [w.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const dialogs = <>
    {detail && !modal && <TaskDetail key={detail} w={w} taskId={detail} onClose={closeTask} onEdit={t => open('task', t)} />}
    {request && !requestForm && <RequestDialog key={request} w={w} requestId={request} onClose={closeTask} onEdit={q => setRequestForm(requestDraft(w, q))} onOpenTask={openTask} />}
    {requestForm && <RequestEditor w={w} draft={requestForm} onClose={() => setRequestForm(null)} />}
    {modal && <TaskEditor key={`${modal.kind}:${modal.data.id || modal.data.staff_id || 'new'}`} w={w} model={modal} onClose={() => setModal(null)} onCreated={id => { if (modal.kind === 'task') openTask(id); }} />}
  </>;
  if (d.operational_access === false) return <><PageHeader title={uiText("Task Management")} /><p role="status">{uiText("Your account is not mapped to the Organizational Structure. Ask an administrator to assign your level to access business records.")}</p></>;
  if (section === 'organization') return <><OrganizationPage onOpenTask={openTask} data={d} actor={w.actor} read={organizationRead} perform={w.perform} requestId={query.get('org_request') || undefined} />{dialogs}</>;
  if (!section) return <><PageHeader title={uiText("Task Management")} /><NoAccess /></>;
  // V5.6.8: adding team members is for managers and administrators (the server checks the same).
  const createKind = CREATE_KIND[section], canCreate = !!createKind && w.can(CREATE_RESOURCE[section] || `tasks.${section}`, 'create') && (section !== 'users' || w.can('admin.users', 'update') || w.can('tasks.tasks', 'approve'));
  const label = uiText(TASK_SECTIONS[section as keyof typeof TASK_SECTIONS]);
  const newRequest = () => setRequestForm(requestDraft(w));
  // V5.6.8: every section's actions sit at the right end of its first toolbar (the page titles, breadcrumbs and section
  // tabs live in the sidebar). The primary action is the only filled button; `secondary` makes it an outline button too
  // (for example beside the CRM activities' own "New activity").
  const actionsFor = (secondary = false) => (canCreate && section !== 'calendar' || ['tasks', 'requests'].includes(section) && w.can('tasks.tasks') || section === 'users' && (w.can('admin.users') || d.organization?.enabled && w.can('tasks.organization'))) ? <>
    {section === 'users' && d.organization?.enabled && w.can('tasks.organization') && <Button variant="outline" onClick={() => w.navigate('/tasks/organization')}><GitBranch />{uiText("Organizational structure")}</Button>}
    {section === 'users' && w.can('admin.users') && <Button variant="outline" onClick={w.onAdministration}>{uiText("Manage login accounts")}<ArrowUpRight /></Button>}
    {['tasks', 'requests'].includes(section) && w.can('tasks.tasks') && <Button variant={section === 'requests' && !secondary ? 'default' : 'outline'} onClick={newRequest}><Send />{uiText("Request a task")}</Button>}
    {canCreate && section !== 'calendar' && <Button variant={secondary ? 'outline' : 'default'} onClick={() => open(createKind)}><Plus />{uiText(CREATE_LABEL[section])}</Button>}
  </> : null;
  const actions = actionsFor();
  // V5.5.1: an open group gets the whole page (its own compact toolbar and heading).
  const groupOpen = section === 'groups' && !!openGroup && (d.tm_boards || []).some((b: Row) => b.id === openGroup);
  return (
    <>
      {!groupOpen && <h1 className="sr-only">{label}</h1>}
      {section === 'workspace' ? <Workspaces w={w} open={open} actions={actions} onViewTasks={id => { setTasksWs(id); w.onSection('tasks'); }} onViewGroups={id => { setGroupsWs(id); w.onSection('groups'); }} />
        : section === 'groups' ? <GroupsView w={w} workspace={groupsWs} setWorkspace={setGroupsWs} openId={openGroup} setOpenId={setOpenGroup} />
        : section === 'users' ? <People w={w} open={open} actions={actions} />
        : section === 'tasks' ? <TaskViews w={w} workspace={tasksWs} setWorkspace={setTasksWs} open={r => openTask(r.id)} legacy={w.legacy} actions={actions} crmActions={actionsFor(true)} />
        : section === 'requests' ? <RequestsView w={w} onOpen={openRequest} onNew={newRequest} actions={actions} />
        : section === 'timesheets' ? <Timesheets w={w} workspace={timeWs} setWorkspace={setTimeWs} open={r => open('time', r)} actions={actions} />
        : section === 'calendar' ? <CalendarView w={w} workspace={calendarWs} setWorkspace={setCalendarWs}
          actions={{ openTask, openMeeting: m => open('meeting', m), newMeeting: w.can('tasks.meetings', 'create') ? day => open('meeting', day <= zonedInput(new Date().toISOString()).slice(0, 10) ? {} : { start_at: zonedToIso(`${day}T09:00`), end_at: zonedToIso(`${day}T10:00`) }) : undefined }} />
        : <TaskReports key={w.data.task_scope?.revision} w={w} />}
      {dialogs}
    </>
  );
}

const workspaceOptions = (w: Workspace): [string, string][] => [...new Map([...w.data.tm_workspaces,...(w.data.tm_workspace_refs||[]),...(w.data.workspace_dashboard?.managed||[])].map((r:Row)=>[r.id,r])).values()].map((r: Row) => [r.id, r.name + (r.status === 'ARCHIVED' ? uiText(" (archived)") : '')]);

// ================================================================ workspaces
function Workspaces({ w, open, actions, onViewTasks, onViewGroups }: { w: Workspace; open: (k: Kind, r?: Row) => void; actions: ReactNode; onViewTasks: (id: string) => void; onViewGroups: (id: string) => void }) {
  useLanguage();
  const [addingMember, setAddingMember] = useState<Row | null>(null), [removingMember, setRemovingMember] = useState<Row | null>(null);
  const confirm = useConfirm();
  const d = w.data, dashboard = d.workspace_dashboard || {my:[],managed:[],shared:[],people:[],has_management:false};
  const tasks = enrichedTasks(d), mine = new Set(dashboard.my.filter((r:Row)=>!r.deleted_at).map((r:Row)=>r.id)), all = tasks.filter((t:Row)=>mine.has(t.workspace_id));
  // V5.6.8: what deleting a workspace stops, from what this person can see: its open tasks (and how many involve other
  // people), pending task requests and scheduled meetings.
  const impact = (r: Row) => {
    const open = tasks.filter((t: Row) => t.workspace_id === r.id && OPEN_TASK_STATUSES.includes(t.status));
    const shared = open.filter((t: Row) => [t.pic_id, ...t.supporters, t.reviewer_id, t.assigned_by, t.created_by].some(p => p && p !== w.actor)).length;
    const requests = (d.tm_requests || []).filter((q: Row) => q.workspace_id === r.id && q.status === 'PENDING').length;
    const meetings = (d.tm_meetings || []).filter((m: Row) => m.workspace_id === r.id && m.status === 'SCHEDULED').length;
    const parts = [open.length && `${open.length} open ${plural(open.length, 'task')}${shared ? ` (${shared === open.length ? (open.length === 1 ? uiText("it involves") : uiText("all involve")) : `${shared} involve${shared === 1 ? 's' : ''}`} other people)` : ''}`,
      requests && `${requests} pending task ${plural(requests, 'request')}`, meetings && `${meetings} scheduled ${plural(meetings, 'meeting')}`].filter(Boolean) as string[];
    return parts.length ? `Deleting it stops ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}. They are hidden until the workspace is restored; the people involved are notified.`
      : uiText("It has no open tasks, pending task requests or scheduled meetings that you can see.");
  };
  const remove = async (r: Row) => {
    const restore = !!r.deleted_at;
    const ok = await confirm({ title: uiText("{p0} “{p1}”?", { p0: restore ? 'Restore' : 'Delete', p1: r.name }), description: restore ? uiText("The workspace returns to its previous state with its members, tasks and history.") : uiText("{p0} Tasks, members and history are kept, and pending workspace membership requests are cancelled. You can restore it from My Workspaces with “Show deleted”.", { p0: impact(r) }), confirmLabel: restore ? uiText("Restore workspace") : uiText("Delete workspace"), tone: restore ? 'default' : 'danger' });
    if (ok) void w.perform(restore ? 'tm.workspace.restore' : 'tm.workspace.delete', {id:r.id,expected_version:r.version,acknowledged:true}).catch(e=>toast.error(e.message));
  };
  // V5.6.8: Archive / Delete / Restore follow the person's current authority over the workspace (the server's flags).
  // Without those flags (an older server) the earlier rule applies.
  const canArchive = (r: Row) => typeof r.org_access?.can_archive === 'boolean' ? r.org_access.can_archive : w.can('tasks.workspace', 'delete') && r.org_access?.can_manage !== false;
  const canDelete = (r: Row) => !!(r.deleted_at ? r.org_access?.can_restore : r.org_access?.can_delete);
  const archive = async (r: Row) => {
    const archiving = r.status === 'ACTIVE';
    const ok = await confirm({ title: uiText("{p0} “{p1}”?", { p0: archiving ? 'Archive' : 'Restore', p1: r.name }), description: archiving ? uiText("Archived workspaces are read-only and hidden by default. Tasks, time and history are kept. Open tasks and scheduled meetings must be finished or cancelled first.") : uiText("The workspace becomes active again and its work can be changed."), confirmLabel: archiving ? uiText("Archive workspace") : uiText("Restore workspace"), tone: archiving ? 'danger' : 'default' });
    if (ok) void w.perform('tm.workspace.archive', { id: r.id, expected_version: r.version, status: archiving ? 'ARCHIVED' : 'ACTIVE' }).catch(e => toast.error(e.message));
  };
  return (
    <>
      <div className="stat-grid cols-4">
        <StatCard label={uiText("My active workspaces")} value={dashboard.my.filter((r:Row)=>!r.deleted_at&&r.status==='ACTIVE').length} icon={FolderKanban} tone="accent" caption={uiText("Created or directly owned by you")} />
        <StatCard label={uiText("My workspace open tasks")} value={all.filter((t:Row)=>!['COMPLETED','CANCELLED'].includes(t.status)).length} caption={uiText("{p0} overdue", { p0: all.filter((t:Row)=>t.overdue).length })} tone="warning" />
        <StatCard label={uiText("Completed tasks")} value={all.filter((t:Row)=>t.status==='COMPLETED').length} caption={uiText("of {p0} permitted tasks in your workspaces", { p0: all.length })} tone="success" />
        <StatCard label={uiText("Managed workspaces")} value={dashboard.managed.length} icon={Users} caption={uiText("Within your reporting hierarchy")} />
      </div>
      <WorkspaceSections dashboard={dashboard} actor={w.actor} actions={actions} render={(r: Row) => {
          const s = workspaceStats(d, r.id), color = TASK_COLORS[r.color as keyof typeof TASK_COLORS];
          return (
            <article key={r.id} className={`ws-card${r.status === 'ARCHIVED' ? " is-archived" : ''}`} style={{ ['--ws-color' as string]: color }}>
              <div className="ws-card-top">
                <span className="ws-icon" aria-hidden="true"><FolderKanban /></span>
                <div className="ws-card-heading">
                  <h3>{r.reference_only ? r.name : <button type="button" className="ws-name" onClick={() => open('workspace', d.tm_workspaces.find((x:Row)=>x.id===r.id)||r)}>{r.name}</button>}</h3>
                  <p className="ws-meta">{r.department || uiText("No department")} {uiText("· owner ")}<Identity name={w.lookup(r.owner_id)}/>{r.org_access?.manager_ids?.length ? <> {uiText("· managed by ")}{r.org_access.manager_ids.map((m: string) => w.lookup(m)).join(', ')}</> : null}</p>
                </div>
                <span className="ws-card-badges">
                  {r.kind && r.kind !== 'LEGACY' && <StatusBadge value={r.kind} label={r.visibility==='PUBLIC'?uiText("Public"):r.kind === 'PERSONAL' ? uiText("Personal") : uiText("Public")} />}
                  {r.deleted_at ? <StatusBadge value="ARCHIVED" label={uiText("Deleted")} /> : r.status === 'ARCHIVED' && <StatusBadge value="ARCHIVED" />}
                </span>
              </div>
              <ExpandableText className="ws-description" text={r.description} lines={2} empty={<p className="muted small">{uiText("No description yet.")}</p>} />
              <div className="ws-progress">
                <div className="row-between"><span className="small">{s.completed} {uiText("of ")}{s.tasks} {plural(s.tasks, 'task')} complete{s.overdue ? <span className="text-danger"> · {s.overdue} overdue</span> : null}</span></div>
                <ProgressBar value={s.progress} label={uiText("{p0} progress", { p0: r.name })} />
              </div>
              <div className="ws-card-footer">
                <AvatarStack names={(r.member_ids||s.members).map(w.lookup)} />
                <span className="ws-time" title={uiText("Time recorded")}><Clock3 aria-hidden="true" /><span className="num">{formatMinutes(s.minutes)}</span></span>
              </div>
              <div className="ws-actions">
                <Button variant="outline" size="sm" disabled={!!r.deleted_at||!w.can('tasks.tasks')} onClick={() => onViewTasks(r.id)}>{uiText("View tasks")}<ChevronRight /></Button>
                {!r.deleted_at&&!r.reference_only&&w.can('tasks.groups') && <Button variant="ghost" size="sm" onClick={() => onViewGroups(r.id)}><Sheet />{uiText("Groups")}{(() => { const n = (w.data.tm_boards || []).filter((b: Row) => b.workspace_id === r.id && b.status === 'ACTIVE').length; return n ? <span className="count-inline num">{n}</span> : null; })()}</Button>}
                {r.org_access?.can_add_members && r.status === 'ACTIVE' && <Button variant="ghost" size="sm" onClick={() => setAddingMember(r)}><Users />{uiText("Add member")}</Button>}
                {r.org_access?.can_remove_members && r.status === 'ACTIVE' && <Button variant="ghost" size="sm" onClick={() => setRemovingMember(r)}><Users />{uiText("Remove member")}</Button>}
                {!r.reference_only&&!r.deleted_at&&<IconButton label={w.can('tasks.workspace', 'update') && (r.owner_id === w.actor || w.can('tasks.workspace', 'delete') || d.tm_members.some((m: Row) => m.workspace_id === r.id && m.staff_id === w.actor)) ? uiText("Edit {p0}", { p0: r.name }) : uiText("Details for {p0}", { p0: r.name })} icon={Pencil} onClick={() => open('workspace', d.tm_workspaces.find((x:Row)=>x.id===r.id)||r)} />}
                {!r.reference_only&&!r.deleted_at&&canArchive(r) && <IconButton label={r.status === 'ACTIVE' ? uiText("Archive {p0}", { p0: r.name }) : uiText("Restore {p0}", { p0: r.name })} icon={r.status === 'ACTIVE' ? Archive : ArchiveRestore} onClick={() => void archive(r)} />}
                {canDelete(r)&&<IconButton label={uiText("{p0} {p1}", { p0: r.deleted_at?'Restore deleted':'Delete', p1: r.name })} icon={r.deleted_at?ArchiveRestore:Trash2} onClick={()=>void remove(r)} />}
              </div>
            </article>
          );
      }} />
      {removingMember && <WorkspaceMemberDialog remove w={w} workspace={removingMember} onClose={() => setRemovingMember(null)} />}
      {addingMember && <WorkspaceMemberDialog w={w} workspace={addingMember} onClose={() => setAddingMember(null)} />}
    </>
  );
}

function WorkspaceMemberDialog({ w, workspace, onClose, remove=false }: { w: Workspace; workspace: Row; onClose: () => void; remove?: boolean }) {
  useLanguage();
  const [staff, setStaff] = useState(''), [role, setRole] = useState('MEMBER'), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [errors, setErrors] = useState<{ staff?: string; reason?: string }>({});
  const current = new Set(w.data.tm_members.filter((m: Row) => m.workspace_id === workspace.id).map((m: Row) => m.staff_id));
  const [requestKey] = useState(()=>uuid());
  const people = remove ? w.data.tm_members.filter((m:Row)=>m.workspace_id===workspace.id&&m.staff_id!==workspace.owner_id).map((m:Row)=>({id:m.staff_id,name:w.lookup(m.staff_id)})) : (workspace.org_access?.member_candidates||[]).filter((p:Row) => !current.has(p.id));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    const missing = { ...(!staff ? { staff: 'Choose the employee.' } : {}), ...(!reason.trim() ? { reason: uiText("Enter the reason for membership.") } : {}) };
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setBusy(true);
    try {
      const result = await w.perform(remove?'tm.workspace.member.remove':'tm.workspace.member.add', { expected_revision:workspace.org_access?.membership_revision, workspace_id: workspace.id, beneficiary_id: staff, member_role: role, reason, request_key: requestKey }, { quiet: true });
      toast.success(result.message || (remove?uiText("Member removed."):uiText("Member added with the governing manager’s approval."))); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  // V5.6.8: the standard dialog layout (padded body, footer with the buttons), like every other form.
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="dialog-md" onInteractOutside={e => busy && e.preventDefault()}>
      <DialogHeader><DialogTitle>{remove?uiText("Remove member from"):uiText("Add member to")} {workspace.name}</DialogTitle><DialogDescription>{remove?uiText("Membership-based access will be revoked. Existing tasks, history and independently authorized participation are retained."):workspace.visibility==='PERSONAL'?uiText("The workspace stays Personal: only you, its members and authorized Administration can open it. Your managers do not gain access."):uiText("Your authorized addition is recorded with this membership. Adding a member does not change their level or reporting manager.")}</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          <div className="dialog-body">
            {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
            <div className="form-grid">
              {people.length ? <PersonPicker label={uiText("Employee")} fieldKey="workspace-member" value={staff} onChange={v => { setStaff(v); setErrors(x => ({ ...x, staff: undefined })); }} people={people} required error={errors.staff} hint={remove?uiText("The workspace owner cannot be removed."):uiText("Only eligible active employees who are not already members are listed.")} />
                : <p className="muted small span-2">{remove?uiText("There are no other members to remove."):uiText("Every eligible employee is already a member.")}</p>}
              {!remove&&<Picker label={uiText("Workspace role")} fieldKey="workspace-member-role" value={role} onChange={setRole} options={[["MEMBER",uiText("Member")],["VIEWER",uiText("Viewer")]]} required allowNone={false} />}
              <Field label={uiText("Reason")} fieldKey="workspace-member-reason" type="textarea" value={reason} onChange={v => { setReason(v); setErrors(x => ({ ...x, reason: undefined })); }} required error={errors.reason} wide />
            </div>
          </div>
          <div className="dialog-footer"><Button type="button" variant="outline" onClick={onClose}>{uiText("Cancel")}</Button><Button type="submit" loading={busy} disabled={!people.length}>{busy ? uiText("Saving…") : remove?uiText("Remove member"):uiText("Add member")}</Button></div>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}

// ================================================================ people
function People({ w, open, actions }: { w: Workspace; open: (k: Kind, r?: Row) => void; actions: ReactNode }) {
  useLanguage();
  const [f, setF] = useViewState('tasks:people', { query: '', status: '', department: '', view: 'directory' });
  const [editing, setEditing] = useState<Row | null>(null);
  const d = w.data, all = enrichedTasks(d), canSetManager = w.can('admin.users', 'update') && !d.organization?.enabled;
  const departments = [...new Set(d.tm_profiles.map((p: Row) => p.department).filter(Boolean))].sort() as string[];
  const rows = d.tm_profiles.filter((p: Row) => (!f.status || (f.status === 'ACTIVE' ? p.active : !p.active)) && (!f.department || p.department === f.department) && `${p.name} ${p.email} ${p.department} ${p.position} ${p.staff_id} ${p.manager_id ? w.lookup(p.manager_id) : ''}`.toLowerCase().includes(f.query.toLowerCase()));
  const stats = (id: string) => { const tasks = all.filter((t: Row) => t.assignees.includes(id)); return { tasks, open: tasks.filter((t: Row) => !['COMPLETED', 'CANCELLED'].includes(t.status)).length, complete: tasks.filter((t: Row) => t.status === 'COMPLETED').length, overdue: tasks.filter((t: Row) => t.overdue).length }; };
  const reports = (id: string) => d.tm_profiles.filter((p: Row) => p.manager_id === id && p.active).length;
  const chips = buildChips([{ key: 'q', label: uiText("Search"), value: f.query, display: `“${f.query}”`, clear: () => setF(v => ({ ...v, query: '' })) }, { key: 's', label: uiText("Status"), value: f.status, display: statusLabel(f.status), clear: () => setF(v => ({ ...v, status: '' })) }, { key: 'd', label: uiText("Department"), value: f.department, clear: () => setF(v => ({ ...v, department: '' })) }]);
  const reset = () => setF(v => ({ query: '', status: '', department: '', view: v.view }));
  const view = f.view === 'lines' ? 'lines' : 'directory';
  return (
    <>
      {/* V5.6.8: the same compact top as the other sections: the view switch, then the page's actions on the right. */}
      <div className="toolbar"><Segmented label={uiText("Show")} value={view} onChange={v => setF(s => ({ ...s, view: v }))} options={[{ value: 'directory', label: uiText("Directory"), icon: Users }, { value: 'lines', label: uiText("Reporting lines"), icon: GitBranch }]} />{actions && <div className="row toolbar-actions">{actions}</div>}</div>
      {view === 'lines' ? <ReportingLines w={w} onEdit={canSetManager ? setEditing : undefined} onOpen={p => open('profile', p)} /> : <>
        <FilterBar search={<SearchInput value={f.query} onChange={v => setF(s => ({ ...s, query: v }))} label={uiText("Search team members")} placeholder={uiText("Search name, email, position, department or manager…")} />}
          filters={<><FilterSelect label={uiText("Status")} value={f.status} onChange={v => setF(s => ({ ...s, status: v }))} options={[['ACTIVE', uiText("Active")], ['INACTIVE', uiText("Inactive")]]} /><FilterSelect label={uiText("Department")} value={f.department} onChange={v => setF(s => ({ ...s, department: v }))} options={departments.map(x => [x, x])} /></>}
          chips={chips} onReset={reset} summary={<><strong>{rows.length}</strong> {uiText("of ")}{d.tm_profiles.length} {plural(d.tm_profiles.length, uiText("team member"))}</>} />
        <Card flush>
          <DataTable rows={rows} rowKey={p => p.staff_id} stateKey="tasks-people" resetKey={JSON.stringify(f)} onRowClick={p => open('profile', p)} rowLabel={p => `Open ${p.name}`} filtered={chips.length > 0} onClearFilters={reset} itemName="team members"
            columns={[
              { key: 'name', header: uiText("Team member"), minWidth: 220, cell: p => <span className="person-cell"><Avatar name={p.name} size="sm" /><span className="cell-stack"><span className="cell-title">{p.name}</span><small>{p.position || uiText("Team member")}</small></span></span> },
              { key: 'department', header: uiText("Department"), cell: p => p.department || null },
              { key: 'manager_id', header: uiText("Reports to"), sortValue: p => (p.manager_id ? w.lookup(p.manager_id) : ''), cell: p => p.manager_id ? <span className="cell-stack"><span>{w.lookup(p.manager_id)}</span>{reports(p.staff_id) > 0 && <small>{reports(p.staff_id)} {uiText("direct ")}{plural(reports(p.staff_id), 'report')}</small>}</span> : reports(p.staff_id) > 0 ? <small className="muted">{reports(p.staff_id)} {uiText("direct ")}{plural(reports(p.staff_id), 'report')}</small> : null },
              { key: 'email', header: uiText("Contact"), cell: p => p.email || p.phone ? <span className="cell-stack">{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : null}{p.phone ? <small>{p.phone}</small> : null}</span> : null },
              { key: 'open', header: uiText("Open tasks"), numeric: true, sortValue: p => stats(p.staff_id).open, cell: p => { const x = stats(p.staff_id); return <span className="num">{x.open}{x.overdue ? <span className="text-danger"> ({x.overdue} {uiText("overdue)")}</span> : null}</span>; } },
              { key: 'progress', header: uiText("Completed"), sortValue: p => { const x = stats(p.staff_id); return x.tasks.length ? x.complete / x.tasks.length : null; }, cell: p => { const x = stats(p.staff_id); return x.tasks.length ? <ProgressBar value={x.complete / x.tasks.length * 100} label={uiText("{p0} completed tasks", { p0: p.name })} size="sm" /> : <span className="muted small">{uiText("No tasks you can see")}</span>; } },
              { key: 'tasks_access', header: uiText("Can be assigned"), sortValue: p => { const u = (d.tm_people || []).find((x: Row) => x.staff_id === p.staff_id); return u ? (u.signed_in ? 2 : 1) : 0; }, cell: p => { const u = (d.tm_people || []).find((x: Row) => x.staff_id === p.staff_id); return u ? <StatusBadge value={u.signed_in ? 'YES' : 'PENDING'} label={u.signed_in ? uiText("Yes") : uiText("Yes · not signed in yet")} tone={u.signed_in ? 'success' : 'info'} /> : <StatusBadge value="NO" label={uiText("No login")} tone="neutral" title={uiText("Needs an Task Controlling Management login with Task Management")} />; } },
              { key: 'active', header: uiText("Status"), sortValue: p => p.active ? uiText("Active") : uiText("Inactive"), cell: p => <StatusBadge value={p.active ? 'ACTIVE' : 'INACTIVE'} /> },
            ]} empty={<EmptyState icon={Users} title={uiText("No team members yet")} />} />
        </Card>
        <p className="page-footnote">{uiText("Anyone with an Task Controlling Management login that includes Task Management can be given tasks. Administration manages sign-ins; making a profile inactive doesn’t disable its login. Task counts include only tasks you can see.")}</p>
      </>}
      {editing && <ManagerDialog w={w} person={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** V5.5: the reporting tree. Managers see the tasks led by the people under them; that never grants changing them. */
function ReportingLines({ w, onEdit, onOpen }: { w: Workspace; onEdit?: (p: Row) => void; onOpen: (p: Row) => void }) {
  useLanguage();
  const people: Row[] = w.data.tm_profiles.filter((p: Row) => p.active).sort((a: Row, b: Row) => a.name.localeCompare(b.name));
  const ids = new Set(people.map(p => p.staff_id)), under = new Map<string, Row[]>();
  for (const p of people) { const m = p.manager_id && ids.has(p.manager_id) && p.manager_id !== p.staff_id ? p.manager_id : ''; under.set(m, [...(under.get(m) || []), p]); }
  const shown = new Set<string>();
  const node = (p: Row, depth: number): ReactNode => {
    if (shown.has(p.staff_id)) return null;
    shown.add(p.staff_id);
    const kids = under.get(p.staff_id) || [];
    return (
      <li key={p.staff_id}>
        <div className="org-node">
          <button type="button" className="person-cell org-person" onClick={() => onOpen(p)}><Avatar name={p.name} size="sm" /><span className="cell-stack"><span className="cell-title">{p.name}</span><small>{[p.position, p.department].filter(Boolean).join(' · ') || uiText("Team member")}</small></span></button>
          {kids.length > 0 && <span className="org-count small muted">{kids.length} {uiText("direct ")}{plural(kids.length, 'report')}</span>}
          {onEdit && <Button size="xs" variant="ghost" onClick={() => onEdit(p)}><Pencil />{uiText("Manager")}<span className="sr-only"> {uiText("of ")}{p.name}</span></Button>}
        </div>
        {kids.length > 0 && <ul className="org-children" aria-label={uiText("Reporting to {p0}", { p0: p.name })}>{kids.map(c => node(c, depth + 1))}</ul>}
      </li>
    );
  };
  const roots = (under.get('') || []).map(p => node(p, 0));
  // A loop can only come from old data; anyone not reached yet is listed at the top level.
  const rest = people.filter(p => !shown.has(p.staff_id)).map(p => node(p, 0));
  return (
    <Card title={uiText("Reporting lines")} description={onEdit ? uiText("Choose “Manager” to change who someone reports to. Inactive people are not shown.") : uiText("Administrators set reporting lines. Inactive people are not shown.")}>
      {people.length ? <ul className="org-tree">{roots}{rest}</ul> : <EmptyState compact icon={GitBranch} title={uiText("No team members yet")} />}
    </Card>
  );
}

function ManagerDialog({ w, person, onClose }: { w: Workspace; person: Row; onClose: () => void }) {
  useLanguage();
  const [manager, setManager] = useState<string>(person.manager_id || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await w.perform('tm.profile.manager', { staff_id: person.staff_id, manager_id: manager || null }); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle>{uiText("Who does ")}{person.name} {uiText("report to?")}</DialogTitle><DialogDescription>{uiText("Their manager, and everyone above, can follow the tasks ")}{firstName(person.name)} {uiText("leads. Viewing only.")}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={save} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
              <PersonPicker label={uiText("Reports to")} value={manager} people={profileOptions(w, [manager]).filter(p => p.id !== person.staff_id)} allowNone noneLabel="Nobody (top of the reporting tree)" onChange={v => { setManager(v || ''); setError(''); }} />
            </div>
            <div className="dialog-footer"><Button type="button" variant="outline" onClick={onClose}>{uiText("Cancel")}</Button><Button type="submit" loading={busy} disabled={manager === (person.manager_id || '')}>{uiText("Save")}</Button></div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ tasks
// V5.6.8: the two decision views name what they hold; together they are exactly what the "need your decision" note counts.
const QUICK_VIEWS: [string, string][] = [dynamicLabels(['all', "All tasks"], { 1: () => uiText("All tasks") }), dynamicLabels(['answer', "To accept or reject"], { 1: () => uiText("To accept or reject") }), dynamicLabels(['mine', "In my charge"], { 1: () => uiText("In my charge") }), dynamicLabels(['supporting', "Supporting"], { 1: () => uiText("Supporting") }), dynamicLabels(['assigned', "Assigned by me"], { 1: () => uiText("Assigned by me") }), dynamicLabels(['review', "To review or approve"], { 1: () => uiText("To review or approve") }), dynamicLabels(['team', "My team"], { 1: () => uiText("My team") }), dynamicLabels(['stuck', "Stuck"], { 1: () => uiText("Stuck") }), dynamicLabels(['overdue', "Overdue"], { 1: () => uiText("Overdue") })];
type ViewContext = { me: string; team: Set<string>; decidesDue: (t: Row) => boolean };
function inView(view: string, t: Row, { me, team, decidesDue }: ViewContext) {
  const open = OPEN_TASK_STATUSES.includes(t.status);
  switch (view) {
    case 'answer': return (t.waiting || []).some((x: Row) => x.staff_id === me);
    // Personal views are work queues, so they list open tasks; finished work stays under All tasks and in the reports.
    case 'mine': return open && t.pic_id === me;
    case 'supporting': return open && t.supporters.includes(me);
    // V5.4: tasks this person gave to someone else (they are the assigner).
    case 'assigned': return assignedByMe(t, me);
    // Work to review, changes to approve and (V5.6.8) new due dates this person may decide.
    case 'review': return toReviewOrApprove(t, me) || decidesDue(t);
    // V5.5: tasks led by people who report to me, directly or through others (viewing only).
    case 'team': return team.has(t.pic_id);
    case 'stuck': return open && t.stuck;
    case 'overdue': return t.overdue;
    default: return true;
  }
}
// Phones start with cards: the list's columns don't fit a phone screen.
const narrowScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.("(max-width: 640px)").matches;
function TaskViews({ w, workspace, setWorkspace, open, legacy, actions, crmActions }: { w: Workspace; workspace: string; setWorkspace: (v: string) => void; open: (r: Row) => void; legacy: ReactNode; actions: ReactNode; crmActions: ReactNode }) {
  useLanguage();
  const [f, setF] = useViewState('tasks:filters', { view: narrowScreen() ? 'cards' : 'list', scope: 'all', query: '', status: '', owner: '', priority: '', department: '', openOnly: false });
  const set = (patch: Partial<typeof f>) => setF(v => ({ ...v, ...patch }));
  const [category,setCategory] = useState('mine');
  const [fromDate,setFromDate] = useState(''), [toDate,setToDate] = useState('');
  const authorized = useTasks(w), all = authorized.filter((t:Row)=>t.task_categories?.includes(category)), me = w.actor, team = new Set<string>(w.data.task_scope?.team || []), scope = f.scope === 'team' && !team.size ? 'all' : f.scope || 'all';
  const ctx: ViewContext = { me, team, decidesDue: t => mayDecideDue(w, t) };
  const departments = [...new Set(all.map((t: Row) => t.department).filter(Boolean))].sort() as string[];
  // V5.5: the person filter lists only people on the tasks this person can see.
  const people: [string, string][] = [...new Set<string>(all.flatMap((t: Row) => [...t.assignees, t.reviewer_id, t.assigned_by]).filter(Boolean))].map(id => [id, w.lookup(id)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  const rows = all.filter((t: Row) => (!fromDate||t.due_date>=fromDate)&&(!toDate||t.due_date<=toDate)&&inView(scope, t, ctx) && (!workspace || t.workspace_id === workspace) && (!f.status || t.status === f.status) && (!f.owner || t.assignees.includes(f.owner)) && (!f.priority || t.priority === f.priority) && (!f.department || t.department === f.department)
    && (!f.openOnly || OPEN_TASK_STATUSES.includes(t.status))
    && `${t.title} ${t.description} ${t.id} ${t.department} ${t.department_note || ''} ${t.assignees.map(w.lookup).join(' ')}`.toLowerCase().includes((f.query || '').toLowerCase()));
  const counts = Object.fromEntries(QUICK_VIEWS.map(([id]) => [id, all.filter((t: Row) => inView(id, t, ctx)).length]));
  const quickViews = QUICK_VIEWS.filter(([id]) => id !== 'team' || team.size > 0);
  const chips = buildChips([
    { key: 'q', label: uiText("Search"), value: f.query, display: `“${f.query}”`, clear: () => set({ query: '' }) },
    { key: 'ws', label: uiText("Workspace"), value: workspace, display: w.data.tm_workspaces.find((x: Row) => x.id === workspace)?.name, clear: () => setWorkspace('') },
    { key: 'st', label: uiText("Status"), value: f.status, display: statusLabel(f.status), clear: () => set({ status: '' }) },
    { key: 'ow', label: uiText("Person"), value: f.owner, display: w.lookup(f.owner), clear: () => set({ owner: '' }) },
    { key: 'pr', label: uiText("Priority"), value: f.priority, display: statusLabel(f.priority), clear: () => set({ priority: '' }) },
    { key: 'dp', label: uiText("Department"), value: f.department, clear: () => set({ department: '' }) },
    { key: 'op', label: uiText("Open tasks only"), value: f.openOnly, clear: () => set({ openOnly: false }) },
  ]);
  const reset = () => { setWorkspace(''); setF(v => ({ view: v.view, scope: v.scope, query: '', status: '', owner: '', priority: '', department: '', openOnly: false })); };
  // On phones the last view keeps a short name, so the whole switch fits on the screen.
  const views = [{ value: 'list', label: uiText("List"), icon: List }, { value: 'board', label: uiText("Board"), icon: Columns3 }, { value: 'cards', label: uiText("Cards"), icon: LayoutGrid }, ...(w.can('crm.activities') ? [{ value: 'crm', label: narrowScreen() ? 'CRM' : uiText("CRM activities"), icon: Link2 }] : [])];
  const person = (id: string, you = true, waiting = false) => <span className="person-cell"><Avatar name={w.lookup(id)} size="sm" /><span className="cell-stack"><span className="person-name">{w.lookup(id)}</span>{waiting ? <small>{uiText("Not accepted yet")}</small> : you && id === me && <small>{uiText("You")}</small>}</span></span>;
  const extras = (t: Row) => (t.recurrence || t.check_total || t.file_count) ? <span className="task-extras">
    {t.recurrence && <span title={uiText("Repeats {p0}", { p0: RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT] })}><Repeat aria-hidden="true" /><span className="sr-only">{uiText("Repeats ")}{RECURRENCE_SHORT[t.recurrence as keyof typeof RECURRENCE_SHORT]}</span></span>}
    {t.check_total > 0 && <span title={uiText("{p0} of {p1} steps completed", { p0: t.check_done, p1: t.check_total })}><ListChecks aria-hidden="true" /><span className="num">{t.check_done}/{t.check_total}</span><span className="sr-only"> {uiText("steps completed")}</span></span>}
    {t.file_count > 0 && <span title={uiText("Files")}><Paperclip aria-hidden="true" /><span className="num">{t.file_count}</span><span className="sr-only"> {plural(t.file_count, 'file')}</span></span>}
  </span> : null;
  // V5.5: tasks seen without being on them are marked. V5.6.8: every such reason (reporting line, workspace governance,
  // company-wide access, organization administration, workspace membership or ownership) is view-only.
  const access = (t: Row) => t.access_reason && t.access_reason !== 'involved' ? <span className={`access-chip is-${t.access_reason}`} title={uiText("{p0} · view only", { p0: SCOPE_NOTE[t.access_reason] || 'Visible to you' })}><EyeIcon aria-hidden="true" />{SCOPE_CHIP[t.access_reason] || uiText("View only")}<span className="sr-only">{uiText(", view only")}</span></span> : null;
  const card = (t: Row) => (
    <button type="button" className={`task-card${t.stuck ? " is-stuck" : ''}`} key={t.id} onClick={() => open(t)}>
      <span className="row-between"><span className="id-text">{t.id}</span><PriorityBadge value={t.priority} /></span>
      <span className="task-card-title">{t.title}{access(t)}</span>
      <span className="task-card-meta">{t.workspace}{t.department ? uiText(" · {p0}", { p0: t.department }) : ''}</span>
      {(t.stuck || t.awaiting || t.declined || t.status === 'IN_REVIEW' || t.change_request) && <span className="row">{(t.stuck || t.awaiting || t.declined || t.status === 'IN_REVIEW') && <TaskStateBadge task={t} />}{t.change_request && t.status !== 'IN_REVIEW' && <StatusBadge value="APPROVAL" label={uiText("Change waiting for approval")} tone="warning" />}</span>}
      {extras(t)}
      <ProgressBar value={t.progress} label={uiText("{p0} progress", { p0: t.title })} size="sm" />
      <span className="row-between task-card-foot"><span className="person-cell small" title={uiText("Person in charge")}><Avatar name={w.lookup(t.pic_id)} size="sm" />{w.lookup(t.pic_id).split(' · ')[0]}{t.supporters.length ? <span className="muted"> +{t.supporters.length}</span> : null}</span><span className={t.overdue ? "text-danger nowrap" : "nowrap muted"}><CalendarDays aria-hidden="true" className="inline-icon" />{t.overdue ? uiText("Overdue · ") : ''}{formatDate(t.due_date)}</span></span>
    </button>
  );
  // V5.6.8: what matters most comes first, so laptops show status, due date and priority without scrolling sideways.
  const cols: Column[] = [
    { key: 'title', header: uiText("Task"), minWidth: 230, cell: t => <span className="cell-stack"><span className="cell-title">{t.title}{access(t)}</span><small><span className="id-text">{t.id}</span> · {t.workspace}{t.department ? uiText(" · {p0}", { p0: t.department }) : ''}</small>{extras(t)}</span> },
    { key: 'pic_id', header: uiText("In charge"), minWidth: 160, sortValue: t => w.lookup(t.pic_id), cell: t => person(t.pic_id, true, t.pic_state === 'PENDING' && ['NOT_STARTED', 'IN_PROGRESS'].includes(t.status)) },
    { key: 'status', header: uiText("Status"), sortValue: t => STATUS_ORDER.indexOf(t.status) * 10 + (t.stuck ? 1 : 0), cell: t => <span className="cell-stack"><TaskStateBadge task={t} />{t.change_request && t.status !== 'IN_REVIEW' && <small className="text-warning"><Scale aria-hidden="true" className="inline-icon" />{uiText("Waiting for approval")}</small>}</span> },
    { key: 'due_date', header: uiText("Due"), cell: t => t.overdue ? <span className="cell-stack due-overdue"><DateText value={t.due_date} /><small>{uiText("Overdue")}</small></span> : <span className="nowrap"><DateText value={t.due_date} /></span> },
    { key: 'priority', header: uiText("Priority"), sortValue: t => ({ HIGH: 0, MEDIUM: 1, LOW: 2 } as Row)[t.priority], cell: t => <PriorityBadge value={t.priority} /> },
    { key: 'progress', header: uiText("Progress"), minWidth: 140, cell: t => <span className="cell-stack"><ProgressBar value={t.progress} label={uiText("{p0} progress", { p0: t.title })} size="sm" />{(t.logged_minutes > 0 || t.estimate_minutes > 0) && <small className="num">{uiText("Logged ")}{formatMinutes(t.logged_minutes)}{t.estimate_minutes > 0 ? uiText(" of {p0}", { p0: formatMinutes(t.estimate_minutes) }) : ''}</small>}</span> },
    { key: 'supporters', header: uiText("Supporting"), sortValue: t => t.supporters.length, cell: t => t.supporters.length ? <AvatarStack names={t.supporters.map(w.lookup)} max={3} /> : null },
  ];
  // V5.6.8: one count for "need your decision": the tasks in "To accept or reject" and "To review or approve".
  const needsMe = all.filter((t: Row) => inView('answer', t, ctx) || inView('review', t, ctx)).length;
  return (
    <>
      <div className="toolbar task-toolbar">
        <Segmented label={uiText("Task view")} value={f.view as string} onChange={v => set({ view: v })} options={views} />
        {(f.view === 'crm' ? crmActions : actions) && <div className="row toolbar-actions">{f.view === 'crm' ? crmActions : actions}</div>}
      </div>
      {needsMe > 0 && f.view !== 'crm' && <Alert tone="info" className="needs-me" title={uiText("{p0} {p1} your decision", { p0: needsMe, p1: plural(needsMe, 'task needs', 'tasks need') })} action={<Button size="xs" variant="outline" onClick={() => set({ scope: counts.answer ? 'answer' : 'review' })}>{uiText("Show them")}</Button>}>{uiText("Accept or reject, review, approve a change or decide a due date.")}</Alert>}
      {f.view === 'crm' ? legacy : <>
        <TaskCategories value={category} onChange={v=>{setCategory(v);set({scope:'all'});}} tasks={authorized} />
        <div className="quick-views" role="group" aria-label={uiText("Show tasks")}>
          {quickViews.map(([id, text]) => <button key={id} type="button" className="quick-view" aria-pressed={scope === id} onClick={() => set({ scope: id })}><span>{text}</span><span className="quick-view-count">{counts[id]}</span></button>)}
        </div>
        <FilterBar search={<SearchInput value={f.query} onChange={v => set({ query: v })} label={uiText("Search tasks")} placeholder={uiText("Search title, ID, department or person…")} />}
          filters={<>
            <FilterSelect label={uiText("Workspace")} value={workspace} onChange={setWorkspace} options={workspaceOptions(w)} />
            {f.view !== 'board' && <FilterSelect label={uiText("Status")} value={f.status} onChange={v => set({ status: v })} options={entries(TASK_STATUS)} />}
            <FilterSelect label={uiText("Person")} value={f.owner} onChange={v => set({ owner: v })} options={people} allLabel="Anyone" people />
            <FilterSelect label={uiText("Department")} value={f.department} onChange={v => set({ department: v })} options={departments.map(x => [x, x])} />
            <label>{uiText("Due from")}<input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} /></label><label>{uiText("Due to")}<input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} /></label>
            <FilterSelect label={uiText("Priority")} value={f.priority} onChange={v => set({ priority: v })} options={[['HIGH', uiText("High")], ['MEDIUM', uiText("Medium")], ['LOW', uiText("Low")]]} />
            <ToggleFilter label={uiText("Open only")} pressed={!!f.openOnly} onChange={v => set({ openOnly: v })} />
          </>}
          chips={chips} onReset={reset} summary={<><strong>{rows.length}</strong> {uiText("of ")}{all.length} {plural(all.length, 'task')}</>} />
        {f.view === 'list' ? <Card flush>
          <DataTable columns={cols} rows={rows} stateKey="tasks-list" resetKey={JSON.stringify(f) + workspace} onRowClick={open} rowLabel={t => `Open task ${t.title}`} rowClassName={t => (t.overdue || t.stuck ? 'row-attention' : undefined)} filtered={chips.length > 0 || scope !== 'all'} onClearFilters={() => { reset(); set({ scope: 'all' }); }} itemName="tasks"
            empty={<EmptyState icon={List} title={uiText("No tasks yet")} description={uiText("Create a task, choose one person in charge and any supporting people, and follow it through to completion.")} />} />
        </Card> : f.view === 'cards' ? (rows.length ? <div className="card-grid">{rows.map(card)}</div> : <EmptyState title={chips.length || scope !== 'all' ? uiText("No matching tasks") : uiText("No tasks yet")} action={(chips.length > 0 || scope !== 'all') && <Button variant="outline" size="sm" onClick={() => { reset(); set({ scope: 'all' }); }}>{uiText("Clear filters")}</Button>} />)
          : <div className="kanban" role="list" aria-label={uiText("Task board by status")}>
            {entries(TASK_STATUS).filter(([id]) => !f.status || id === f.status).map(([id, label]) => {
              const items = rows.filter((t: Row) => t.status === id);
              return (
                <section className="kanban-column" key={id} role="listitem" aria-label={uiText("{p0}: {p1} {p2}", { p0: label, p1: items.length, p2: plural(items.length, 'task') })}>
                  <h3 className="kanban-head"><StatusBadge value={id} label={label} /><span className="kanban-count num">{items.length}</span></h3>
                  <div className="kanban-body">{items.map(card)}{!items.length && <p className="kanban-empty">{uiText("No tasks")}</p>}</div>
                </section>
              );
            })}
          </div>}
      </>}
    </>
  );
}

// ================================================================ timesheets
function Timesheets({ w, workspace, setWorkspace, open, actions }: { w: Workspace; workspace: string; setWorkspace: (v: string) => void; open: (r: Row) => void; actions: ReactNode }) {
  useLanguage();
  const [todayKey,setToday]=useState(taskToday()),[anchor,setAnchor]=useState(''),[mode,setMode]=useState('rolling'),[user,setUser]=useViewState('tasks:time-user',w.actor);
  const [custom,setCustom]=useState({from:addDays(taskToday(),-7),to:taskToday()});
  useEffect(()=>{const tick=()=>setToday(taskToday());const timer=window.setInterval(tick,30000);window.addEventListener('focus',tick);return()=>{clearInterval(timer);window.removeEventListener('focus',tick);};},[]);
  const range=timeRange(mode,anchor||todayKey,custom.from,custom.to),days=rangeDays(range);
  const taskMap=new Map<string,Row>([...(w.data.tm_tasks||[]),...(w.data.tm_task_options||[])].map((t:Row)=>[t.id,t]));
  const entries:Row[]=w.data.tm_timesheets.filter((e:Row)=>e.staff_id===user&&e.work_date>=range.from&&e.work_date<=range.to);
  const wid=(e:Row)=>e.workspace_id||taskMap.get(e.task_id)?.workspace_id||'';
  const workspaceIds=new Set(entries.map(wid));
  const logs=entries.filter(e=>!workspace||wid(e)===workspace);
  const grouped=new Map<string,Row>();for(const e of logs){const key=e.task_id||e.id;if(!grouped.has(key))grouped.set(key,{id:key,task_id:e.task_id,title:taskMap.get(e.task_id)?.title||e.activity||uiText("Independent work"),workspace_id:wid(e)});}
  const rows=[...grouped.values()],total=(list:Row[])=>formatMinutes(list.reduce((n,e)=>n+e.minutes,0)),forRow=(r:Row)=>logs.filter(e=>r.task_id?e.task_id===r.task_id:e.id===r.id);
  const wsName=(id:string)=>w.data.tm_workspaces.find((x:Row)=>x.id===id)?.name||(!id?uiText("Independent work"):id);
  return <Card title={uiText("Timesheet")} description={uiText("{p0} · {p1} – {p2}{p3}", { p0: w.lookup(user), p1: formatDate(range.from), p2: formatDate(range.to), p3: mode==='rolling'?' · both boundary dates included':'' })} actions={<div className="row"><Button size="sm" variant="outline" onClick={()=>{setAnchor('');setMode('rolling');}}>{uiText("Through today")}</Button>{actions}</div>} flush>
    <div className="card-inset timesheet-controls">
      <PersonPicker label={uiText("Person")} value={user} people={profileOptions(w,[user])} onChange={v=>setUser(v||w.actor)}/>
      <Picker label={uiText("Workspace")} value={workspace} options={workspaceOptions(w).filter(([id])=>workspaceIds.has(id))} none={uiText("All records, including independent work")} onChange={setWorkspace}/>
      <Picker label={uiText("Period")} value={mode} options={[["rolling",uiText("Previous weekday through today")],["week",uiText("Week")],["month",uiText("Month")],["custom",uiText("Date range")]]} onChange={setMode}/>
      {mode==='custom'?<><Field label={uiText("From")} type="date" value={custom.from} onChange={v=>setCustom(s=>({...s,from:v}))}/><Field label={uiText("Through")} type="date" value={custom.to} onChange={v=>setCustom(s=>({...s,to:v}))}/></>:<Field label={mode==='rolling'?uiText("Through date"):uiText("Date in period")} type="date" value={anchor||todayKey} onChange={setAnchor}/>}
      <div className="week-total" aria-live="polite"><span>{uiText("Period total")}</span><strong className="num">{total(logs)}</strong><small>h:mm</small></div>
    </div>
    {range.to<range.from?<div className="card-inset"><Alert tone="danger">{uiText("The end date must be on or after the start date.")}</Alert></div>:rows.length?<div className="table-wrap week-wrap"><table className="data-table week-table"><thead><tr><th>{uiText("Task / activity")}</th>{days.length?days.map(day=><th key={day} className={day===todayKey?'is-today':undefined}><span className="week-day">{new Intl.DateTimeFormat('en-GB',{weekday:'short',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'))}</span><span className="week-date">{Number(day.slice(8))}</span></th>):<th>{uiText("Entries")}</th>}<th>{uiText("Total")}</th></tr></thead><tbody>
      {rows.map(r=><tr key={r.id}><th><span className="cell-stack"><span className="cell-title">{r.title}</span><small>{wsName(r.workspace_id)}</small></span></th>{days.length?days.map(day=>{const entry=forRow(r).find(e=>e.work_date===day);return <td key={day}><button className={`time-cell${entry?" has-time":''}`} disabled={!entry||!w.can('tasks.timesheets','update')} onClick={()=>entry&&open(entry)}>{entry?formatMinutes(entry.minutes):'—'}</button></td>;}):<td>{forRow(r).map(e=><Button key={e.id} size="sm" variant="ghost" onClick={()=>open(e)}>{formatDate(e.work_date)} · {formatMinutes(e.minutes)}</Button>)}</td>}<td className="num">{total(forRow(r))}</td></tr>)}
    </tbody><tfoot><tr><th>{uiText("Daily total")}</th>{days.length?days.map(day=><td key={day} className="num">{total(logs.filter(e=>e.work_date===day))}</td>):<td/>}<td className="num">{total(logs)}</td></tr></tfoot></table></div>:<div className="card-inset"><EmptyState icon={Clock3} title={uiText("No time recorded in this period")} description={uiText("Add time for a task or record independent work.")}/></div>}
  </Card>;
}

// ================================================================ reports
function TaskReports({ w }: { w: Workspace }) {
  useLanguage();
  const [mode, setMode] = useViewState('reports:tasks-mode', 'monthly');
  return (
    <>
      <div className="toolbar"><Segmented label={uiText("Report type")} value={mode} onChange={setMode} options={[{ value: 'monthly', label: uiText("Monthly report") }, { value: 'detail', label: uiText("Workload, time and registers") }]} /></div>
      {mode === 'monthly' && w.can('tasks.tasks') ? <MonthlyTaskReport w={w} /> : <DetailedTaskReports w={w} />}
    </>
  );
}

const DETAIL_REPORTS = translatedEntries(TASK_REPORTS).filter(([key]) => !Object.hasOwn(MONTHLY_REPORTS, key)) as [string, string][];
function DetailedTaskReports({ w }: { w: Workspace }) {
  useLanguage();
  const [saved, setF] = useViewState<Row>('reports:tasks', { report: 'tasks' });
  const f = Object.hasOwn(MONTHLY_REPORTS, saved.report) ? { ...saved, report: 'tasks' } : saved;
  const set = (k: string, v: string) => setF(s => ({ ...s, [k]: v }));
  const params = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v))).toString();
  const { report, error, loading } = useServerReport('/api/tasks/report?' + params, w.data);
  const { report: workload } = useServerReport('/api/tasks/report?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...f, report: 'workload', status: '' }).filter(([, v]) => v))).toString(), w.data);
  const range: DateRange = { from: f.from || '', to: f.to || '', preset: f.from || f.to ? 'custom' : 'all' };
  const chips = buildChips([{ key: 'ws', label: uiText("Workspace"), value: f.workspace, display: w.data.tm_workspaces.find((x: Row) => x.id === f.workspace)?.name, clear: () => set('workspace', '') }, { key: 'u', label: uiText("Person"), value: f.user, display: w.lookup(f.user), clear: () => set('user', '') }, { key: 'p', label: uiText("Period"), value: f.from || f.to ? 'x' : '', display: `${f.from || '…'} – ${f.to || '…'}`, clear: () => setF(s => ({ ...s, from: '', to: '' })) }, { key: 's', label: uiText("Status"), value: f.status, display: statusLabel(f.status), clear: () => set('status', '') }]);
  const canExport = w.can('tasks.reports', 'export');
  const cols: Column[] = (report.columns || []).map(([key, label]: string[]) => ({ key, header: label, numeric: ['progress', 'tasks', 'completed', 'overdue', 'open', 'minutes', 'logged', 'estimate', 'duration'].includes(key), wrap: ['notes', 'minutes_notes', 'attendees', 'title', 'task'].includes(key),
    cell: (r: Row) => key === 'status' ? <StatusBadge value={r[key]} /> : key === 'priority' ? <PriorityBadge value={r[key]} /> : ['start_date', 'due_date', 'work_date', 'date'].includes(key) ? <DateText value={r[key]} /> : ['start_at', 'end_at'].includes(key) ? <span className="nowrap">{formatDateTime(r[key])}</span> : key === 'overdue' && typeof r[key] === 'string' ? <StatusBadge value={r[key]} /> : ['notes', 'minutes_notes'].includes(key) ? <ExpandableText text={r[key]} /> : isMissing(r[key]) ? null : String(r[key]) }));
  return (
    <>
      <FilterBar
        search={<Picker hideLabel label={uiText("Report")} value={f.report} onChange={v => setF(s => ({ ...s, report: v || 'tasks', status: '' }))} options={DETAIL_REPORTS} allowNone={false} className="report-picker" />}
        filters={<>
          <FilterSelect label={uiText("Workspace")} value={f.workspace || ''} onChange={v => set('workspace', v)} options={workspaceOptions(w)} />
          <FilterSelect label={uiText("Person")} value={f.user || ''} onChange={v => set('user', v)} options={(w.data.task_scope?.employee_filters?.[f.report] || []).map((id: string) => [id, w.lookup(id)])} allLabel="Everyone" people />
          <DateRangeFilter label={f.report === 'time' ? uiText("Work date") : f.report === 'meetings' ? uiText("Meeting date") : uiText("Due date")} value={range} onChange={r => setF(s => ({ ...s, from: r.from, to: r.to }))} />
          {['tasks', 'meetings'].includes(f.report) && <FilterSelect label={uiText("Status")} value={f.status || ''} onChange={v => set('status', v)} options={f.report === 'tasks' ? entries(TASK_STATUS) : [['SCHEDULED', uiText("Scheduled")], ['COMPLETED', uiText("Completed")], ['CANCELLED', uiText("Cancelled")]]} />}
        </>}
        actions={canExport && <><ButtonLink size="sm" href={apiPath('/api/tasks/report.csv?' + params)}><Download />CSV</ButtonLink><ButtonLink size="sm" target="_blank" rel="noopener" href={apiPath('/api/tasks/report.print?' + params)}><Printer />{uiText("Print / PDF")}</ButtonLink></>}
        chips={chips} onReset={() => setF({ report: f.report })} summary={<><strong>{report.rows.length}</strong> {uiText("matching rows")}</>}
      />
      {error ? <ErrorState message={error} /> : <>
        <div className="stat-grid cols-4">
          <StatCard label={uiText("Matching rows")} value={report.rows.length} caption={uiText(TASK_REPORTS[f.report as keyof typeof TASK_REPORTS])} />
          <StatCard label={uiText("Assigned tasks")} value={workload.rows.reduce((n: number, r: Row) => n + r.tasks, 0)} caption={uiText("Shared tasks count once per assignee")} />
          <StatCard label={uiText("Completed assignments")} value={workload.rows.reduce((n: number, r: Row) => n + r.completed, 0)} tone="success" />
          <StatCard label={uiText("Time recorded")} value={formatMinutes(workload.rows.reduce((n: number, r: Row) => n + r.minutes, 0))} unit="h:mm" icon={Clock3} />
        </div>
        <div className="grid-2 mt-5">
          <Card title={uiText("Recorded time by person")} description={uiText("Actual time from timesheets in the selected period (h:mm).")}>
            {workload.rows.some((r: Row) => r.minutes > 0) ? <BarList label={uiText("Recorded time by person")} unit="h:mm" format={v => formatMinutes(v)} items={[...workload.rows].sort((a: Row, b: Row) => b.minutes - a.minutes).map((r: Row) => ({ key: r.id, label: r.user, value: r.minutes, onSelect: () => setF(s => ({ ...s, report: 'time', user: r.id, status: '' })) }))} footer="Select a person to see their time entries." />
              : <EmptyState compact icon={Clock3} title={uiText("No time recorded in this period")} />}
          </Card>
          <Card title={uiText("Open work by person")} description={uiText("Open and overdue task assignments in the selected period.")}>
            {workload.rows.some((r: Row) => r.open > 0) ? <BarList label={uiText("Open task assignments by person")} unit="open tasks" items={[...workload.rows].sort((a: Row, b: Row) => b.open - a.open).map((r: Row) => ({ key: r.id, label: r.user, value: r.open, detail: r.overdue ? `${r.overdue} overdue` : undefined, onSelect: () => setF(s => ({ ...s, report: 'tasks', user: r.id, status: '' })) }))} />
              : <EmptyState compact title={uiText("No open assignments")} />}
          </Card>
        </div>
        <Card title={report.title} description={uiText("Task and workspace periods use due dates; time uses the work date; meetings use their start date (Cambodia time).")} flush className={`mt-5${loading ? " is-refreshing" : ''}`}>
          <DataTable dense columns={cols} rows={report.rows} stateKey={`rpt-tasks-${f.report}`} resetKey={params} filtered={chips.length > 0} onClearFilters={() => setF({ report: f.report })} pageSize={50} itemName="rows"
            footerRow={report.totals?.minutes && report.columns?.some(([k]: string[]) => ['duration', 'logged', 'minutes'].includes(k)) ? { [report.columns[0][0]]: 'Total', minutes: <span className="num">{report.totals.minutes}</span>, duration: <span className="num">{formatMinutes(report.totals.minutes)}</span>, logged: <span className="num">{formatMinutes(report.totals.minutes)}</span> } : undefined}
            empty={<EmptyState compact title={uiText("No rows for this report")} />} />
        </Card>
      </>}
    </>
  );
}

// ================================================================ editor
/** V5.5 Steps of Work (optional): an ordered list the people on the task tick off. Steps never change progress or close the task. */
function StepsDraft({ items, onChange }: { items: string[]; onChange: (v: string[]) => void }) {
  useLanguage();
  const [text, setText] = useState('');
  const add = () => { const v = text.trim(); if (!v) return; onChange([...items, v]); setText(''); };
  const move = (i: number, by: number) => { const j = i + by; if (j < 0 || j >= items.length) return; const next = [...items]; [next[i], next[j]] = [next[j], next[i]]; onChange(next); };
  return (
    <div className="checklist-draft span-2">
      <p className="field-label" id="steps-draft-label">{uiText("Steps of work ")}<span className="muted">{uiText("(optional)")}</span></p>
      {items.length > 0 && <ol className="checklist-draft-items" aria-labelledby="steps-draft-label">{items.map((item, i) => <li key={`${i}-${item}`}><span>{item}</span>
        <div className="step-tools">
          <IconButton label={uiText("Move “{p0}” up", { p0: item })} icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} />
          <IconButton label={uiText("Move “{p0}” down", { p0: item })} icon={ArrowDown} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
          <IconButton label={uiText("Remove “{p0}”", { p0: item })} icon={X} onClick={() => onChange(items.filter((_, n) => n !== i))} />
        </div></li>)}</ol>}
      <div className="checklist-draft-add">
        <Input value={text} maxLength={300} placeholder={uiText("Add a step, for example “Check the seal”")} aria-labelledby="steps-draft-label" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" size="sm" variant="outline" disabled={!text.trim() || items.length >= 50} onClick={add}><Plus />{uiText("Add step")}</Button>
      </div>
      <p className="field-hint">{uiText("Ticking a step tells the assigner. Steps don’t change progress or close the task.")}</p>
    </div>
  );
}

/** V5.4: days before the due date when the people on a task are reminded (1, 2, 3 or other days; none turns them off). */
function ReminderChooser({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  useLanguage();
  const [other, setOther] = useState(''), [error, setError] = useState('');
  const list = reminderDays(value), toggle = (n: number, on: boolean) => onChange(on ? [...list, n] : list.filter(x => x !== n));
  const add = () => { const n = Number(other.trim()); if (!Number.isInteger(n) || n < 1 || n > 90) { setError(uiText("Enter whole days from 1 to 90.")); return; } if (list.length >= 5 && !list.includes(n)) { setError(uiText("Choose up to five reminders.")); return; } onChange([...list, n]); setOther(''); setError(''); };
  return (
    <div className="reminder-chooser">
      <div className="reminder-options" role="group" aria-label={uiText("Remind before the due date")}>
        {REMINDER_PRESETS.map(n => <CheckboxField key={n} label={uiText("{p0} day{p1} before", { p0: n, p1: n === 1 ? '' : 's' })} checked={list.includes(n)} onChange={v => toggle(n, v)} />)}
        {list.filter(n => !REMINDER_PRESETS.includes(n)).map(n => <span key={n} className="reminder-chip">{n} {uiText("days before")}<IconButton label={uiText("Remove the reminder {p0} days before", { p0: n })} icon={X} onClick={() => toggle(n, false)} /></span>)}
      </div>
      <div className="reminder-other">
        <Field label={uiText("Other (days before)")} type="number" min="1" value={other} onChange={v => { setOther(v); setError(''); }} placeholder="7" error={error} hint={list.length ? undefined : uiText("No reminders: nobody is reminded before the due date.")} />
        <Button type="button" size="sm" variant="outline" disabled={!other.trim()} onClick={add}><Plus />{uiText("Add")}</Button>
      </div>
    </div>
  );
}

function TaskEditor({ w, model, onClose, onCreated }: { w: Workspace; model: TaskModal; onClose: () => void; onCreated?: (id: string) => void }) {
  useLanguage();
  const [outside, setOutside] = useState(false);
  const [d, setD] = useState<Row>(model.data), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [photoBusy, setPhotoBusy] = useState(false);
  const form = useFormErrors(), confirm = useConfirm();
  const k = model.kind, resource = 'tasks.' + ({ workspace: 'workspace', profile: 'users', task: 'tasks', time: 'timesheets', meeting: 'meetings' } as Row)[k];
  // Existing tasks: the task's managers (creator, reviewer, approvers) edit everything; the person in charge edits some details.
  const current = k === 'task' && d.id ? enrichedTasks(w.data).find((t: Row) => t.id === d.id) : null;
  const taskRoles = current ? taskActions(current, w.actor, { canApprove: canApproveOn(w, current) }) : null;
  // V5.4: once both sides are on the task, either side proposes changes and the other side approves them.
  // (Also for a completed or cancelled task both sides had agreed to: its record changes only with the other side.)
  // Approval is needed only from another person: when the editor holds every responsible role, changes save directly.
  const target: string | null = current ? editApprovalTarget(current, w.actor) || [current.reviewer_id,current.created_by,d.reviewer_id,d.pic_id].find(x=>x&&x!==w.actor) || null : null;
  const locked = !!taskRoles && !taskRoles.roles.isGovernor && !target;
  // V5.4: a workspace's members edit its details; only its owner and workspace managers (Workspace Delete) change its
  // owner or members, because membership opens the workspace's Groups.
  const wsOriginal: Row | null = k === 'workspace' && d.id ? w.data.tm_workspaces.find((x: Row) => x.id === d.id) || null : null;
  const wsManager = wsOriginal?.kind && wsOriginal.kind !== 'LEGACY' ? !!wsOriginal.org_access?.can_manage : !wsOriginal || wsOriginal.owner_id === w.actor || w.can('tasks.workspace', 'delete');
  const wsMember = !!wsOriginal && w.data.tm_members.some((m: Row) => m.workspace_id === wsOriginal.id && m.staff_id === w.actor);
  // V5.5: the people taking part in a meeting change it; people it is shared with only see it.
  const meetingOriginal: Row | null = k === 'meeting' && d.id ? w.data.tm_meetings.find((x: Row) => x.id === d.id) || null : null;
  const sharedOnly = !!meetingOriginal && !takesPart(w, meetingOriginal);
  // V5.6.8: only the organizer, whoever scheduled it, or a participant who may approve meetings changes its time, people,
  // organizer or details, or cancels it; other participants record notes, complete it and keep its reminders.
  const canApproveMeetings = w.can('tasks.meetings', 'approve');
  const managesMeeting = !meetingOriginal || canManageMeeting(meetingOriginal, w.actor, { participant: takesPart(w, meetingOriginal), canApprove: canApproveMeetings });
  const meetingLocked = k === 'meeting' && !managesMeeting;
  // V5.6.8: someone else's team profile (or a new team member) is for managers and administrators; their name and team
  // email are for administrators (User accounts “Update”), as the server checks.
  const otherProfile = k === 'profile' && d.staff_id !== w.actor, profileManager = w.can('tasks.users', 'update') && (w.can('admin.users', 'update') || w.can('tasks.tasks', 'approve'));
  const identityLocked = otherProfile && !!d.staff_id && !w.can('admin.users', 'update');
  const canSave = (k === 'task' && d.id ? w.can('tasks.tasks') : w.can(resource, d.id || (k === 'profile' && d.staff_id) ? 'update' : 'create')) && (!otherProfile || profileManager) && (!taskRoles || taskRoles.allowed.includes('edit')) && (k !== 'workspace' || (d.kind && d.kind !== 'LEGACY' ? wsManager : wsManager || wsMember)) && !sharedOnly;
  // V5.5: reporting lines are set by administrators (User accounts · Update).
  const canSetManager = w.can('admin.users', 'update') && !w.data.organization?.enabled;
  // Making someone else inactive (or active again) needs Tasks "Approve" (Managers and Administrators by default).
  const canSetActive = k !== 'profile' || !d.staff_id || d.staff_id === w.actor || w.can('tasks.tasks', 'approve');
  const set = (key: string, value: any) => { setD(s => ({ ...s, [key]: value })); setDirty(true); form.clear(key); };
  const field = (key: string, label: string, type = 'text', wide = false, required = false, extra: { hint?: string; placeholder?: string; min?: string; aliases?: string[]; disabled?: boolean } = {}) => { form.register({ key, label, required: required && !extra.disabled, type, value: d[key], aliases: extra.aliases }); return <Field key={key} fieldKey={key} label={label} type={type} value={d[key] ?? ''} onChange={v => set(key, v)} wide={wide} required={required} disabled={extra.disabled || !canSave} hint={extra.hint} placeholder={extra.placeholder} min={extra.min} error={form.errors[key]} />; };
  const pick = (key: string, label: string, options: [string, string][], extra: { required?: boolean; disabled?: boolean; none?: string; hint?: string; wide?: boolean; onChange?: (v: string) => void } = {}) => { form.register({ key, label, required: extra.required, type: 'select', value: d[key] }); return <Picker key={key} fieldKey={key} label={label} value={d[key]} options={options} required={extra.required} disabled={extra.disabled || !canSave} none={extra.none} hint={extra.hint} wide={extra.wide} error={form.errors[key]} onChange={extra.onChange || (v => set(key, v))} />; };
  const person = (key: string, label: string, options: PersonOption[], extra: { required?: boolean; disabled?: boolean; hint?: ReactNode; onChange?: (v: string) => void } = {}) => { form.register({ key, label, required: extra.required, type: 'select', value: d[key] }); return <PersonPicker key={key} fieldKey={key} label={label} value={d[key]} people={options} required={extra.required} disabled={extra.disabled || !canSave} hint={extra.hint} error={form.errors[key]} onChange={extra.onChange || (v => set(key, v))} />; };
  const chosenWorkspace = [...w.data.tm_workspaces,...(w.data.tm_workspace_refs||[])].find((x: Row) => x.id === d.workspace_id);
  const governed = chosenWorkspace?.kind && chosenWorkspace.kind !== 'LEGACY';
  const memberIds = new Set(w.data.tm_members.filter((m: Row) => m.workspace_id === d.workspace_id).map((m: Row) => m.staff_id));
  const chosen = new Set([w.actor,d.pic_id,d.reviewer_id,d.organizer_id,...(d.supporter_ids||[]),...(d.attendee_ids||[]),...(d.share_ids||[])]);
  const eligible = (x: PersonOption) => !governed || outside || memberIds.has(x.id) || chosen.has(x.id);
  const outsideToggle = governed ? <div className="span-2"><CheckboxField label={uiText("Choose people outside the workspace")} checked={outside} onChange={setOutside} disabled={!chosenWorkspace?.org_access?.can_collaborate_outside} /><p className="muted small">{chosenWorkspace?.org_access?.can_collaborate_outside ? uiText("Invite to this record only. Workspace membership is a separate approval.") : uiText("Outside invitations require approved collaboration authority.")}</p></div> : null;
  const profiles = profileOptions(w, [d.staff_id, d.owner_id, d.organizer_id, ...(d.member_ids || []), ...(d.attendee_ids || []), ...(d.share_ids || [])]).filter(p => k !== 'meeting' || eligible(p));
  const close = async () => { if (busy) return; if (dirty && !(await confirm({ title: uiText("Discard unsaved changes?"), description: uiText("The information you entered in this form will be lost."), confirmLabel: uiText("Discard changes"), cancelLabel: uiText("Keep editing"), tone: 'danger' }))) return; onClose(); };
  // Members of a workspace can choose anyone: saving adds them to it (V5.4: people outside it choose its members).
  const changeWorkspace = (v: string) => { setOutside(false); const ws = w.data.tm_workspaces.find((x: Row) => x.id === v); setD(s => ({ ...s, workspace_id: v, department: s.department && s.department !== w.data.tm_workspaces.find((x: Row) => x.id === s.workspace_id)?.department ? s.department : ws?.department || '', task_id: '' })); setDirty(true); form.clear('workspace_id'); };
  const selectActivity = (v: string) => { const a = w.data.activities.find((x: Row) => x.id === v); setD(s => ({ ...s, activity_id: v, ...(a ? { title: a.subject, ...(k === 'task' ? { description: a.summary, start_date: zonedInput(a.start_at).slice(0, 10), due_date: zonedInput(a.end_at || a.start_at).slice(0, 10), priority: a.priority, status: 'NOT_STARTED', progress: 0, pic_id: (w.data.tm_people || []).some((p: Row) => p.staff_id === a.assigned_to) ? a.assigned_to : s.pic_id } : { agenda: a.summary, start_at: zonedInput(a.start_at), end_at: zonedInput(a.end_at || new Date(Date.parse(a.start_at) + 3600000).toISOString()), status: a.status === 'OPEN' ? 'SCHEDULED' : a.status }) } : {}) })); setDirty(true); };
  const relatedRows: Row[] = ({ CONTACT: w.data.contacts, LEAD: w.data.leads, OPPORTUNITY: w.data.opportunities, ACCOUNT: w.data.accounts, OPERATIONS: w.data.ops_requests } as Row)[d.related_type] || [];
  const taskOptions = w.can('tasks.tasks') ? w.data.tm_tasks : w.data.tm_task_options, assignmentOptions = w.can('tasks.tasks') ? w.data.tm_assignees : w.data.tm_assignment_options;
  const assignedIds = assignmentOptions.filter((a: Row) => a.task_id === d.task_id && a.status !== 'DECLINED').map((a: Row) => a.staff_id);
  const history = w.data.tm_events.filter((e: Row) => e.entity_id === (d.id || d.staff_id)).slice().reverse();
  const isEdit = !!(d.id || (k === 'profile' && d.staff_id));
  const noun = ({ workspace: uiText('workspace'), profile: uiText('team member'), task: uiText('task'), time: uiText('time entry'), meeting: uiText('meeting') } as Row)[k];
  let body: ReactNode;
  // Responsible managers (management scope) and, for an Organizational workspace you own, members from your approved
  // branch. Creator, owner, responsible managers and members stay separate; the server checks every choice again.
  const setup: Row = w.data.workspace_setup || { managers: [], subordinates: [] };
  const wsAccess: Row = wsOriginal?.org_access || {};
  const makingPublic = !!d.id && wsOriginal?.visibility === 'PERSONAL' && d.visibility === 'PUBLIC';
  const scopeVisible = k === 'workspace' && (!d.id ? ['PUBLIC', 'ORGANIZATIONAL'].includes(d.kind) && setup.managers.length > 0 && (d.kind !== 'ORGANIZATIONAL' || d.owner_id === w.actor)
    : (wsOriginal?.visibility === 'PUBLIC' && !!wsAccess.can_set_managers) || makingPublic);
  const managerChoices: PersonOption[] = (!d.id ? setup.managers : wsAccess.manager_options || []).map((m: Row) => ({ id: m.id, name: m.name, detail: [m.title, m.direct ? "reports directly" : ''].filter(Boolean).join(' · ') || undefined }));
  const teamChoices: PersonOption[] = (setup.subordinates || []).map((m: Row) => ({ id: m.id, name: m.name }));
  const governedScope = k === 'workspace' && d.kind && d.kind !== 'LEGACY' ? <>
    {!!d.id && wsAccess.can_make_public && <FormSection title={uiText("Visibility")} columns={1}>
      <CheckboxField label={uiText("Make this workspace Public")} checked={makingPublic} onChange={v => set('visibility', v ? 'PUBLIC' : 'PERSONAL')}
        description={uiText("Its responsible managers will be able to see it and its tasks. This cannot be undone here.")} />
      {makingPublic && <CheckboxField label={uiText("I understand that the responsible managers below will see this workspace.")} checked={!!d.acknowledged} onChange={v => set('acknowledged', v)} error={form.errors.acknowledged} />}
    </FormSection>}
    {scopeVisible && <FormSection title={uiText("Responsible managers")} columns={1} description={uiText("Whose management this workspace falls under. Only the managers you choose (and the people above them) see it through management; another manager of yours does not see it unless you choose them or add them as a member.")}>
      <PeoplePicker label={uiText("Responsible managers")} people={managerChoices} value={d.manager_ids || []} onChange={v => set('manager_ids', v)} addLabel="Add a manager" max={10}
        hint={(d.manager_ids || []).length ? undefined : uiText("None chosen: your primary reporting line manages it, as before.")} disabled={!canSave} />
    </FormSection>}
    {!d.id && d.kind === 'ORGANIZATIONAL' && d.owner_id === w.actor && teamChoices.length > 0 && <FormSection title={uiText("Members from your team")} columns={1} description={uiText("Employees of your approved branch are added when the workspace is created; anyone else needs the governing manager’s approval.")}>
      <PeoplePicker label={uiText("Team members")} people={teamChoices} value={d.team_ids || []} onChange={v => set('team_ids', v)} addLabel="Add a team member" disabled={!canSave} />
    </FormSection>}
  </> : null;
  if (k === 'workspace') body = <>
    <FormSection title={uiText("Workspace")}>
      {!d.id && pick('kind', uiText("Workspace classification"), [['PERSONAL',uiText("Personal — owner only")],['PUBLIC',uiText("Public — owner managed")],['ORGANIZATIONAL',uiText("Organizational — Level 2 governance")]], { required: true, wide: true, onChange: v => { setD(s => ({...s,kind:v,...(['PERSONAL','PUBLIC'].includes(v)?{owner_id:w.actor}: {})})); setDirty(true); } })}
      {d.kind && d.kind !== 'LEGACY' && <p className="span-2 muted small">{d.kind === 'PERSONAL' ? uiText("Personal workspaces stay private: only you, the members you add and authorized Administration can open them.") : d.kind === 'PUBLIC' ? uiText("Public workspaces are visible to their members and to the responsible managers you choose below.") : uiText("An approved Owner grant or Level 2 authority is required. The governing manager comes from the owner’s reporting branch.")} {uiText("Manage membership and governance in Organizational Structure.")}</p>}
      {field('name', uiText("Workspace name"), 'text', true, true)}{field('department', uiText("Department"))}
      {person('owner_id', uiText("Workspace owner"), profiles, { required: true, disabled: !wsManager || ['PERSONAL','PUBLIC'].includes(d.kind) || !!d.id && d.kind === 'ORGANIZATIONAL', hint: d.id && d.kind === 'ORGANIZATIONAL' ? uiText("Change ownership in Organizational Structure after reviewing the affected scope.") : wsManager ? undefined : uiText("Only the owner or a workspace manager can change the owner."), onChange: v => { setD(s => ({ ...s, owner_id: v, member_ids: [...new Set([...(s.member_ids || []), v])] })); setDirty(true); form.clear('owner_id'); } })}
      {pick('color', uiText("Color"), Object.keys(TASK_COLORS).map(c => [c, c.charAt(0) + c.slice(1).toLowerCase()]), { required: true })}
      {field('description', uiText("Description"), 'textarea', true)}
    </FormSection>
    {governedScope}
    {(!d.kind || d.kind === 'LEGACY') && <FormSection title={uiText("Members")} columns={1}><PeoplePicker label={uiText("Workspace members")} people={profiles} value={d.member_ids || []} locked={[d.owner_id]} disabled={!wsManager} onChange={v => set('member_ids', v)} addLabel="Add a member" hint={wsManager ? uiText("The owner is always included. Members can open the workspace’s team groups. People that members choose for a task or meeting here are added automatically.") : uiText("Only the owner or a workspace manager can change the members.")} /></FormSection>}
  </>;
  else if (k === 'profile') {
    const login = (w.data.tm_people || []).find((p: Row) => p.staff_id === d.staff_id), hasPhoto = (w.data.staff_photos || []).some((p: Row) => p.staff_id === d.staff_id);
    body = <>
      {d.staff_id && w.can('tasks.users', 'update') && (!otherProfile || profileManager) && <PhotoControl name={w.lookup(d.staff_id)} hasPhoto={hasPhoto} busy={photoBusy} setBusy={setPhotoBusy} onError={m => (m ? form.setFormError(m) : form.reset())}
        save={base64 => w.perform('tm.profile.photo', { staff_id: d.staff_id, base64 })} remove={() => w.perform('tm.profile.photo', { staff_id: d.staff_id, remove: true })} />}
      {d.staff_id && !login && <Alert tone="neutral" className="mt-4" title={uiText("No login")}>{uiText("This person has no Task Controlling Management login with Task Management, so they can’t be chosen for tasks or answer them. Create their login in Administration → User accounts.")}</Alert>}
      <FormSection title={uiText("Team profile")}>
        {field('name', uiText("Full name"), 'text', false, true, { disabled: !!d.staff_id, hint: uiText("Usernames are managed in Administration → User accounts.") })}{field('email', uiText("Contact email"), 'email', false, false, { disabled: identityLocked, hint: identityLocked ? uiText("Administrators change team emails.") : uiText("Used for contact and notifications.") })}
        {field('phone', uiText("Phone"))}{field('position', uiText("Position"))}{field('department', uiText("Department"))}
        {pick('active', uiText("Team status"), [['1', uiText("Active")], ['0', uiText("Inactive")]], { required: true, disabled: !canSetActive, hint: canSetActive ? uiText("Reassign open tasks and scheduled meetings before making someone inactive.") : uiText("Only managers and administrators (Task Management “Approve”) can make someone inactive or active again."), onChange: v => set('active', Number(v)) })}
      </FormSection>
      <FormSection title={uiText("Reporting line and time zone")} description={uiText("A manager also sees the tasks led by the people who report to them, directly or through others. Seeing a task gives no right to change or approve it.")}>
        <PersonPicker label={uiText("Reports to")} fieldKey="manager_id" value={d.manager_id || ''} people={profileOptions(w, [d.manager_id]).filter(p => p.id !== d.staff_id)} allowNone noneLabel="Nobody (top of the reporting tree)"
          disabled={!canSetManager} hint={canSetManager ? undefined : uiText("Administrators set reporting lines.")} error={form.errors.manager_id} onChange={v => set('manager_id', v || '')} />
        {pick('timezone', uiText("Time zone"), zoneOptions(), { none: uiText("Company time zone"), hint: uiText("Their calendar, meeting times and reminders use it.") })}
      </FormSection>
    </>;
  }
  else if (k === 'time') {

    body = <FormSection>
      <Picker fieldKey="task_id" label={uiText("Task (optional)")} none={uiText("Independent work")} wide value={d.task_id} disabled={!!d.id} error={form.errors.task_id} options={taskOptions.filter((t: Row) => t.status !== 'CANCELLED' || t.id === d.task_id).map((t: Row) => [t.id, `${t.title} · ${t.id}`])} onChange={v => { setD(s => ({ ...s, task_id: v, staff_id: assignmentOptions.find((a: Row) => a.task_id === v && a.staff_id === w.actor && a.status !== 'DECLINED')?.staff_id || assignmentOptions.find((a: Row) => a.task_id === v && a.status !== 'DECLINED')?.staff_id || w.actor })); setDirty(true); form.clear('task_id'); }} />
      {!d.task_id && <>{field('activity',uiText("Activity"),'text',true,true)}{pick('workspace_id',uiText("Workspace (optional)"),workspaceOptions(w),{none:uiText("No workspace"),disabled:!!d.id})}</>}
      {person('staff_id', uiText("Person"), profileOptions(w, [d.staff_id]).filter(p => d.task_id ? assignedIds.includes(p.id) || p.id === d.staff_id : p.id === w.actor), { required: true, disabled: !!d.id, hint: d.task_id ? uiText("Only people working on the task can log time on it.") : uiText("Independent work belongs to you.") })}
      {field('work_date', uiText("Work date"), 'date', false, true, { hint: uiText("Cannot be in the future.") })}
      {field('duration', uiText("Duration (H:MM)"), 'text', false, true, { placeholder: '1:30', hint: uiText("For example 1:30 for one hour thirty minutes. Up to 24:00 per person per day."), aliases: ["duration h mm", 'time'] })}
      {field('notes', uiText("Work notes"), 'textarea', true)}
    </FormSection>;
  } else {
    const isTask = k === 'task';
    // V5.6.8: an optional link to a CRM activity sits with the related records, after the title and people.
    const crmPicker = !d.id && w.can('crm.activities') ? pick('activity_id', isTask ? uiText("Connect a CRM activity") : uiText("Connect a CRM meeting"), w.data.activities.filter((a: Row) => (k === 'meeting' ? a.channel === 'MEETING' : a.channel !== 'MEETING' && a.status === 'OPEN') && !w.data[k === 'meeting' ? 'tm_meetings' : 'tm_tasks'].some((t: Row) => t.activity_id === a.id)).map((a: Row) => [a.id, `${a.subject} · ${a.id}`]), { none: uiText("None"), hint: uiText("Keeps the CRM activity and this item in sync (its title, dates and details are filled in from it), so everyone who can see CRM activities also sees it there."), onChange: selectActivity }) : null;
    const everyone = peopleOptions(w, { include: [d.pic_id, d.reviewer_id, ...(d.supporter_ids || [])] }).filter(eligible);
    const declined: Row[] = (current?.declined_supporters || []).filter((x: Row) => !(d.supporter_ids || []).includes(x.staff_id) && x.staff_id !== d.pic_id);
    body = <>
      {!isTask && d.id && <Alert tone="info">{uiText("Changes are sent to another participant for approval before they apply.")}</Alert>}
      {isTask && <TaskVisibility manager={d.governing_manager_id} onManager={v=>set('governing_manager_id',v)} managers={chosenWorkspace?.task_manager_options||[]} value={d.visibility} onChange={v=>set('visibility',v)} organizational={chosenWorkspace?.kind==='ORGANIZATIONAL'} disabled={!!d.id && !current?.can_manage_members} />}
      <FormSection title={isTask ? uiText("Task") : uiText("Meeting")}>
        {pick('workspace_id', uiText("Workspace"), [...w.data.tm_workspaces,...(w.data.tm_workspace_refs||[])].filter((r: Row) => r.status === 'ACTIVE' && r.org_access?.can_create !== false || r.id === d.workspace_id).map((r: Row) => [r.id, r.name]), { required: true, disabled: !!d.id, onChange: changeWorkspace })}
        <span />
        {field('title', isTask ? uiText("Task title") : uiText("Meeting subject"), 'text', true, true, { aliases: ["meeting title"], disabled: meetingLocked })}
        {isTask ? field('description', uiText("Expectation"), 'textarea', true, true, { placeholder: uiText("The result you expect: what is delivered, to what standard, and how you will know it is done."), aliases: ['description'] }) : field('agenda', uiText("Agenda"), 'textarea', true, false, { disabled: meetingLocked })}
      </FormSection>
      {isTask ? <>
        {d.id && !target && <p className="hint small">{uiText("You hold every responsible role on this task, so your changes are saved directly.")}</p>}
        {target && <Alert tone="info" icon={Scale} className="mb-4" title={uiText("Changes need {p0}’s approval", { p0: w.lookup(target) })}>{uiText("When you save, your changes are sent to ")}{firstName(w.lookup(target))}{uiText(". The task stays exactly as it is until they approve; they can also reject the change with a reason.")}</Alert>}
        {locked && <Alert tone="neutral" className="mb-4" title={uiText("You are the person in charge")}>{uiText("You can change the expectation, supporting people, estimate and department note. ")}{w.lookup(current?.reviewer_id)} {uiText("manages the title, dates, repeat, priority and people — use “Ask for a new due date” in the task to move the date, or “Hand over” to give it to someone else.")}</Alert>}
        <FormSection title={uiText("People")} description={uiText("Everyone who uses Task Management can be chosen. The person in charge, supporting people and the reviewer are each asked to accept or reject (unless you choose yourself).")}>
          {outsideToggle}
          {person('pic_id', uiText("Person in charge"), everyone, { required: true, disabled: locked, hint: !d.id ? (d.pic_id === w.actor ? uiText("You take charge, so the task starts as accepted.") : uiText("They are asked to accept or reject it.")) : current && current.pic_state === 'PENDING' ? uiText("{p0} has not accepted yet.", { p0: w.lookup(current.pic_id) }) : undefined, onChange: v => { setD(s => ({ ...s, pic_id: v, supporter_ids: (s.supporter_ids || []).filter((x: string) => x !== v), status: v === w.actor ? s.status : 'NOT_STARTED', progress: v === w.actor ? s.progress : 0 })); setDirty(true); form.clear('pic_id'); } })}
          {person('reviewer_id', uiText("Reviewer"), everyone, { required: true, disabled: locked, hint: current && current.reviewer_status !== 'ACCEPTED' && d.reviewer_id === current.reviewer_id ? (current.reviewer_status === 'PENDING' ? `${w.lookup(current.reviewer_id)} has not accepted yet.` : `${w.lookup(current.reviewer_id)} rejected reviewing this task. Choose someone else.`) : uiText("Reviews submitted work and decides due date requests. Usually the person who gives the task.") })}
          <PeoplePicker label={uiText("Supporting people")} people={everyone.filter(p => p.id !== d.pic_id)} value={d.supporter_ids || []} onChange={v => set('supporter_ids', v)} addLabel="Add supporting person"
            note={id => current ? <SupportNote task={current} staff={id} /> : null} empty={uiText("Optional. People who help the person in charge.")} />
          {declined.length > 0 && <div className="declined-list span-2" role="group" aria-label={uiText("People who rejected supporting this task")}>
            {declined.map((x: Row) => <p key={x.staff_id} className="declined-row"><span className="person-cell"><Avatar name={w.lookup(x.staff_id)} size="sm" /><span className="cell-stack"><span className="person-name">{w.lookup(x.staff_id)} {uiText("rejected supporting")}</span>{x.response_note && <small>“{x.response_note}”</small>}</span></span>
              {!locked || taskRoles?.roles.isPic ? <Button type="button" size="xs" variant="outline" onClick={() => set('supporter_ids', [...(d.supporter_ids || []), x.staff_id])}>{uiText("Ask again")}</Button> : null}</p>)}
          </div>}
        </FormSection>
        <FormSection title={uiText("Schedule")} columns={3}>
          {locked ? <><Field label={uiText("Start date")} type="date" value={d.start_date} onChange={() => {}} disabled /><Field label={uiText("Due date")} type="date" value={d.due_date} onChange={() => {}} disabled /></> : <>{field('start_date', uiText("Start date"), 'date', false, true)}{field('due_date', uiText("Due date"), 'date', false, true, { min: d.start_date })}</>}
          {field('estimate', uiText("Estimated effort (H:MM)"), 'text', false, false, { placeholder: '4:00', aliases: ['duration'] })}
          {pick('priority', uiText("Priority"), [['HIGH', uiText("High")], ['MEDIUM', uiText("Medium")], ['LOW', uiText("Low")]], { required: true, disabled: locked })}
          {pick('recurrence', uiText("Repeat"), (translatedEntries(RECURRENCE) as [string, string][]).filter(([v]) => v), { none: RECURRENCE[''], disabled: locked, onChange: v => { setD(s => ({ ...s, recurrence: v, recurrence_until: v ? s.recurrence_until : '' })); setDirty(true); }, hint: d.recurrence ? uiText("When it is closed, the next one is created with the same people and steps.") : undefined })}
          <RecurrenceFields frequency={d.recurrence || ''} value={d.recurrence_rule} due={d.due_date} disabled={locked} onChange={v => set('recurrence_rule',v)} />
          {d.recurrence ? (locked ? <Field label={uiText("Repeat until")} type="date" value={d.recurrence_until || ''} onChange={() => {}} disabled /> : field('recurrence_until', uiText("Repeat until"), 'date', false, false, { min: d.due_date, hint: uiText("Optional. Leave empty to repeat until it is changed.") })) : null}
          {current?.recurrence && d.recurrence === current.recurrence && d.due_date && d.due_date !== current.due_date && !locked && <div style={{ gridColumn: '1 / -1' }}>
            <CheckboxField label={uiText("Move the whole series to this date")} checked={!!d.move_series} onChange={v => set('move_series', v)}
              description={d.move_series ? uiText("The following tasks are planned from {p0} ({p1}).", { p0: formatDate(d.due_date), p1: RECURRENCE[d.recurrence as keyof typeof RECURRENCE].toLowerCase() }) : uiText("Off: only this task moves; the following ones keep their planned dates.")} />
          </div>}
          {!d.id && pick('status', uiText("Starting status"), [['NOT_STARTED', uiText("Not started")], ...(d.pic_id === w.actor ? [['IN_PROGRESS', uiText("In progress")], ['COMPLETED', uiText("Completed (record finished work)")]] as [string, string][] : [])], { required: true, hint: d.pic_id === w.actor ? undefined : uiText("The person in charge starts the work after accepting it."), onChange: v => { setD(s => ({ ...s, status: v, progress: v === 'COMPLETED' ? 100 : v === 'NOT_STARTED' ? 0 : Math.min(Number(s.progress) || 0, 99) })); setDirty(true); } })}
          {!d.id && d.status === 'IN_PROGRESS' && field('progress', uiText("Progress %"), 'number', false, false, { hint: uiText("0–99 until completed."), min: '0' })}
        </FormSection>
        {!d.id && <FormSection columns={1}><StepsDraft items={d.checklist || []} onChange={v => set('checklist', v)} /></FormSection>}
        {!d.id && <FormSection title={uiText("Deadline reminders")} description={uiText("The people on the task (in charge, supporting, you and the reviewer) are reminded in the Task Controlling Management, in Telegram and in the Telegram app.")} columns={1}>
          <ReminderChooser value={d.reminder_days || []} onChange={v => set('reminder_days', v)} />
        </FormSection>}
        <FormSection title={uiText("Department")} description={uiText("The department or team this task belongs to, and anything they should know.")}>
          {locked ? <Field label={uiText("Department")} value={d.department} onChange={() => {}} disabled /> : field('department', uiText("Department"), 'text', false, false, { hint: uiText("Defaults to the workspace department.") })}
          {field('department_note', uiText("Department note"), 'textarea', true, false, { placeholder: uiText("For example: Customs team signs off; Finance checks the invoice first.") })}
        </FormSection>
        {target && <FormSection columns={1}>{field('change_note', `Reason for the change (for ${firstName(w.lookup(target))})`, 'textarea', true, false, { placeholder: uiText("Optional. For example: the customer moved the delivery.") })}</FormSection>}
        {(crmPicker || !d.activity_id) && <FormSection title={uiText("Related record")} description={uiText("Optional. Links this task to a CRM activity, a customer record or an operations request so it appears in that history.")}>
          {crmPicker}
          {!d.activity_id && pick('related_type', uiText("Record type"), ([['CONTACT', uiText("Contact"), 'crm.contacts'], ['LEAD', uiText("Lead"), 'crm.leads'], ['OPPORTUNITY', uiText("Opportunity"), 'crm.opportunities'], ['ACCOUNT', uiText("Business Account"), 'crm.accounts'], ['OPERATIONS', uiText("Operations request"), 'ops.job']] as string[][]).filter(([key, , res]) => (key === 'OPERATIONS' ? w.data.ops_requests.length > 0 : w.can(res))).map(([key, label]) => [key, label]), { none: uiText("Internal task (no record)"), onChange: v => { setD(s => ({ ...s, related_type: v, related_id: '' })); setDirty(true); } })}
          {!d.activity_id && pick('related_id', uiText("Record"), relatedRows.map((r: Row) => [r.id, `${r.id} · ${r.title || r.customer_name || r.name || r.payload?.customer_name || ''}`]), { disabled: !d.related_type, required: !!d.related_type })}
        </FormSection>}
      </> : <>
        {sharedOnly && meetingOriginal && <div className="mb-4"><FollowMeeting w={w} meeting={meetingOriginal} /></div>}
        {meetingLocked && !sharedOnly && meetingOriginal && <Alert tone="neutral" className="mb-4" title={uiText("{p0} organizes this meeting", { p0: w.lookup(meetingOriginal.organizer_id) })}>{uiText("You can record its notes, mark it completed and change its reminders. Its time, people and details are changed, or the meeting cancelled, by the organizer, whoever scheduled it, or someone who approves meetings.")}</Alert>}
        <FormSection title={uiText("When and where")} description={uiText("{p0} ({p1}). Attendees can’t be double-booked while a meeting is scheduled.", { p0: zoneName(displayZone()), p1: zoneOffset(displayZone()) })}>
          {field('start_at', uiText("Starts"), 'datetime-local', false, true, { aliases: ["meeting start"], disabled: meetingLocked })}{field('end_at', uiText("Ends"), 'datetime-local', false, true, { aliases: ["meeting end"], disabled: meetingLocked })}
          {field('location', uiText("Location"), 'text', false, false, { disabled: meetingLocked })}{field('url', uiText("Meeting link"), 'url', false, false, { placeholder: 'https://', aliases: ["meeting url"], disabled: meetingLocked })}
          {pick('status', uiText("Status"), [['SCHEDULED', uiText("Scheduled")], ['COMPLETED', uiText("Completed")], ...(meetingLocked && meetingOriginal?.status !== 'CANCELLED' ? [] : [['CANCELLED', uiText("Cancelled")]] as [string, string][])], { required: true, hint: meetingLocked ? uiText("Only the organizer or the person who scheduled it can cancel it.") : undefined })}
          {d.status === 'CANCELLED' && field('reason', uiText("Cancellation reason"), 'textarea', true, true, { disabled: meetingLocked })}
        </FormSection>
        <FormSection title={uiText("People")} columns={1}>
          {d.id && <p className="hint small">{uiText("Changes need approval from another participant. If you are the only participant, invite another person to review the proposed change.")}</p>}
          {!meetingLocked && outsideToggle}
          {/* V5.6.8: whoever schedules a meeting organizes it; only people who approve meetings choose someone else. */}
          {!d.id && !canApproveMeetings ? <p className="muted small">{uiText("You organize the meetings you schedule. The organizer is always an attendee.")}</p>
            : person('organizer_id', uiText("Organizer"), profiles, { required: true, disabled: meetingLocked, onChange: v => { setD(s => ({ ...s, organizer_id: v, attendee_ids: [...new Set([...(s.attendee_ids || []), v])] })); setDirty(true); form.clear('organizer_id'); } })}
          <PeoplePicker label={uiText("Attendees")} people={profiles} value={d.attendee_ids || []} locked={[d.organizer_id]} disabled={meetingLocked} onChange={v => { setD(s => ({ ...s, attendee_ids: v, share_ids: (s.share_ids || []).filter((x: string) => !v.includes(x)) })); setDirty(true); }} addLabel="Add an attendee" hint={governed ? uiText("An invitation grants access to this meeting only.") : uiText("The organizer is always included. Attendees are added to the workspace.")} />
        </FormSection>
        <FormSection title={uiText("Who can see it")} description={uiText("Participants always see the meeting. Sharing lets others see it without being invited; they can’t change it.")} columns={1}>
          {pick('share_scope', uiText("Visible to"), SHARE_OPTIONS.filter(([v]) => v !== 'COMPANY' || !governed || chosenWorkspace?.visibility !== 'PERSONAL' && chosenWorkspace?.org_access?.can_collaborate_outside), { required: true, wide: true, disabled: meetingLocked, onChange: v => { setD(s => ({ ...s, share_scope: v, share_ids: v === 'SELECTED' ? s.share_ids || [] : [] })); setDirty(true); form.clear('share_scope'); } })}
          {d.share_scope === 'SELECTED' && <PeoplePicker label={uiText("Also share with")} people={profiles.filter(p => !(d.attendee_ids || []).includes(p.id) && p.id !== d.organizer_id)} value={(d.share_ids || []).filter((x: string) => !(d.attendee_ids || []).includes(x))} onChange={v => set('share_ids', v)} disabled={meetingLocked} addLabel="Add a person" max={100} error={form.errors.share_ids} hint={uiText("They see the meeting in their calendar and can ask for its reminders.")} />}
        </FormSection>
        <FormSection title={uiText("Related")} description={uiText("Optional. A task from the same workspace, or a CRM meeting kept in sync with this one.")}>
          {pick('task_id', uiText("Related task"), taskOptions.filter((t: Row) => t.workspace_id === d.workspace_id).map((t: Row) => [t.id, `${t.title} · ${t.id}`]), { none: uiText("No linked task"), disabled: meetingLocked })}
          {crmPicker}
        </FormSection>
        <FormSection title={uiText("Reminders")} columns={1}>
          <OffsetChooser value={d.reminder_offsets || []} onChange={v => set('reminder_offsets', v)} start={d.status === 'SCHEDULED' ? zonedToIso(d.start_at) : undefined} label={uiText("Remind before it starts")}
            hint={uiText("The organizer and attendees get them in the Task Controlling Management and in Telegram. They follow the meeting when it moves and stop when it is cancelled.")} />
        </FormSection>
        <FormSection columns={1}>{field('minutes_notes', uiText("Meeting notes and decisions"), 'textarea', true, false, { aliases: ["meeting notes decisions"] })}</FormSection>
      </>}
    </>;
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if (k === 'task' && !d.pic_id) { form.setFieldError('pic_id', uiText("Choose the person in charge.")); return; }
    setBusy(true); form.reset();
    try {
      const body = { ...d };
      // V5.5: the form shows the person's own time zone; the server stores UTC.
      if (k === 'meeting') { body.start_at = zonedToIso(d.start_at); body.end_at = zonedToIso(d.end_at); if (body.share_scope !== 'SELECTED') delete body.share_ids; }
      if (k === 'task' && d.id) { delete body.status; delete body.progress; }
      const governedWorkspace = k === 'workspace' && d.kind && d.kind !== 'LEGACY';
      if (governedWorkspace) delete body.member_ids;
      if (k === 'workspace') {
        if (governedWorkspace && !d.id && (d.team_ids || []).length) body.member_ids = d.team_ids;
        if (!scopeVisible) delete body.manager_ids;
        if (!makingPublic) { delete body.visibility; delete body.acknowledged; }
        delete body.team_ids;
      }
      const result = await w.perform(`tm.${k}.save`, body);
      onClose();
      if (!d.id && result?.id) onCreated?.(result.id);
    } catch (err) { form.fail((err as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    const result = await confirm({ title: uiText("Delete this time entry?"), description: uiText("{p0} on {p1} will be removed. The deletion and your reason are kept in the history.", { p0: formatMinutes(model.data.minutes), p1: formatDate(model.data.work_date) }), confirmLabel: uiText("Delete entry"), tone: 'danger', reason: { label: uiText("Reason for deleting"), required: true, placeholder: uiText("e.g. Logged on the wrong task") } });
    if (!result) return;
    setBusy(true); form.reset();
    try { await w.perform('tm.time.delete', { id: d.id, expected_version: d.expected_version, reason: result.reason }); onClose(); }
    catch (err) { form.fail((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={v => { if (!v) void close(); }}>
      <DialogContent className={k === 'time' || k === 'profile' ? 'dialog-md' : 'dialog-lg'} onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); void close(); } }}>
        <DialogHeader>
          <DialogTitle>{isEdit ? (canSave ? uiText('Edit {p0}', { p0: noun }) : uiText('{p0} details', { p0: noun })) : uiText("New {p0}", { p0: noun })}</DialogTitle>
          <DialogDescription>{k === 'profile' ? uiText("Work profile and team information. Administration manages login access.") : k === 'time' ? uiText("Durations use H:MM.") : isEdit ? uiText("{p0}{p1}", { p0: d.id, p1: canSave ? '' : ' · read-only for your account' }) : uiText("{p0} · fields marked * are required", { p0: w.data.company.name })}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          {k==='meeting' && d.id && (w.data.tm_meeting_changes||[]).some((q:Row)=>q.meeting_id===d.id) && <div className="dialog-body"><MeetingApprovals records={w.data.tm_meeting_changes||[]} meeting={d.id} me={w.actor} name={w.lookup} perform={w.perform} onApplied={onClose}/></div>}
          <fieldset disabled={busy || !canSave}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title={uiText("This could not be saved")} live>{form.formError}</Alert>}
              {!canSave && <Alert tone="neutral">{uiText("You can view this ")}{noun} {uiText("but your account can’t change it.")}</Alert>}
              {body}
              {d.activity_id && <Alert tone="info" icon={Link2} className="mt-4" title={uiText("Connected CRM activity {p0}", { p0: d.activity_id })}>{uiText("Saving updates that activity too, so both records stay in sync.")}</Alert>}
              {history.length > 0 && <details className="disclosure mt-4"><summary>{uiText("History")}<span className="summary-meta">{history.length} change{history.length === 1 ? '' : 's'}</span></summary><div className="disclosure-body"><ol className="timeline compact">{history.map((h: Row) => <li key={h.id}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-body"><p className="timeline-title">{h.action}</p>{h.detail && <p className="timeline-detail">{h.detail}</p>}<p className="timeline-meta">{formatDateTime(h.created_at)} · {w.lookup(h.actor_id)}</p></div></li>)}</ol></div></details>}
            </div>
          </fieldset>
            <div className="dialog-footer">
              {(d.contact_id && w.can('crm.contacts')) || (k === 'time' && d.id && w.can('tasks.timesheets', 'delete')) ? <div className="footer-start">
                {k === 'time' && d.id && w.can('tasks.timesheets', 'delete') && <Button type="button" variant="danger-outline" disabled={busy} onClick={() => void remove()}><Trash2 />{uiText("Delete entry")}</Button>}
                {d.contact_id && w.can('crm.contacts') && <Button type="button" variant="ghost" onClick={async () => { if (!dirty || await confirm({ title: uiText("Leave without saving?"), description: uiText("Your unsaved changes will be lost."), confirmLabel: uiText("Leave"), tone: 'danger' })) { onClose(); w.show('contact', d.contact_id); } }}><Link2 />{uiText("Customer journey")}</Button>}
              </div> : null}
              <Button type="button" variant="outline" disabled={busy} onClick={() => void close()}>{canSave ? uiText("Cancel") : uiText("Close")}</Button>
              {canSave && <Button type="submit" loading={busy}>{busy ? uiText("Saving…") : isEdit ? (target || k==='meeting' ? uiText("Send for approval") : uiText("Save changes")) : uiText("Create {p0}", { p0: noun })}</Button>}
            </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
