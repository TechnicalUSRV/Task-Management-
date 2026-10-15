import {Identity} from './identity-ui';
import { apiFetch, apiPath, openCompany } from './api-client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bell, Building2, ChartNoAxesCombined, ChevronDown, ClipboardCheck, Globe, Landmark, LayoutDashboard, Loader2, LogOut,
  RefreshCw, SearchX, Send, Settings2, ShieldCheck, Truck, UserRound, UsersRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Toaster, toast } from 'sonner';
import { type Data, type Row, type Model, Editor, initialModel } from './components';
import { CRMWorkflow } from './crm-workflow';
import { RecordList, Detail, CRMActivities, CRMReports } from './crm-ui';
import { OperationsWorkspace, OperationsReports } from './operations-ui';
import { FinancePage } from './finance-ui';
import { ERPDashboard, SourceExplorer, CentralReports } from './erp-ui';
import { AuthGate, Administration } from './access-ui';
import { TaskManagement, openItem, taskRoute } from './tasks-ui';
import { SettingsView } from './settings-ui';
import { TASK_SECTIONS, taskSectionVisible } from './task-domain.mjs';
import { NotificationsMenu, decisionsFor, orgPending } from './task-workflow-ui';
import { TelegramConnectDialog } from './telegram-ui';
import { MyProfileDialog, sidebarThemeOf } from './profile-ui';
import { allowed } from './access-catalog.mjs';
import { useHashRoute, type Route } from './router';
import { formatTime, setDisplayZone } from './format';
import { Avatar, AvatarPhotoProvider, ConfirmProvider, EmptyState, ErrorState, IconButton, NoAccess, PageHeader } from './ui-kit';
import { BrandTitle, LogoIcon, LOGO_ALT } from './brand';

import { TABLES, CRM_TYPES, crmSlug, crmType } from './crm-config';
export { TABLES, CRM_TYPES, crmSlug };

export type Workspace = {
  data: Data; actor: string; currency: string;
  show: (type: string, id: string) => void;
  edit: (kind: string, row?: Row) => void;
  perform: (action: string, row: Row, options?: { quiet?: boolean }) => Promise<Row>;
  lookup: (id: string) => string;
  can: (resource: string, action?: string) => boolean;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  route: Route;
  refresh: (options?: { quiet?: boolean; announce?: boolean }) => Promise<void>;
};

async function read(url: string): Promise<any> {
  const r = await apiFetch(url);
  const d = await r.json() as Row;
  if (!r.ok) { if (r.status === 401) window.dispatchEvent(new Event('session-expired')); throw new Error(d.error || 'Unable to load records.'); }
  return d;
}

export function LocalERP() {
  return <ConfirmProvider><AuthGate>{(user, signOut) => <ERPWorkspace user={user} signOut={signOut} />}</AuthGate></ConfirmProvider>;
}

type NavItem = { id: string; label: string; icon: LucideIcon; href: string; visible: boolean; badge?: number; alert?: boolean; children?: { id: string; label: string; href: string; count?: number }[] };

function ERPWorkspace({ user, signOut }: { user: Row; signOut: () => Promise<void> }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string>(''), [announcement, setAnnouncement] = useState('');
  const [model, setModel] = useState<Model | null>(null);
  const [taskFocus, setTaskFocus] = useState<{ kind: string; id: string } | null>(null), [adminFocus, setAdminFocus] = useState<string | null>(null);
  const [telegramOpen, setTelegramOpen] = useState(false), [profileOpen, setProfileOpen] = useState(false);
  const { route, navigate } = useHashRoute();
  const actor = data?.auth.user.staff_id || user.staff_id;
  const can = useCallback((resource: string, action = 'view') => allowed(data?.auth.permissions, resource, action), [data]);
  // V5.6.8: each person's own sidebar colour (My profile → Appearance), on every page, in the phone menu and the icon rail.
  // A colour just chosen shows at once (`themePreview`) and settles on the saved one when the save finishes.
  const [themePreview, setThemePreview] = useState<string | null>(null);
  const sidebarTheme = sidebarThemeOf(themePreview ?? data?.my_sidebar_theme);
  useLayoutEffect(() => { document.documentElement.dataset.sidebarTheme = sidebarTheme; }, [sidebarTheme]);
  const lastLoad = useRef(0), seenChange = useRef<number | null>(null);
  // quiet: background reload without the "Updating…" state; announce: tell screen readers when a reload they asked for finishes.
  const refresh = useCallback(async ({ quiet = false, announce = false }: { quiet?: boolean; announce?: boolean } = {}) => {
    if (!quiet) { setError(''); setRefreshing(true); }
    try {
      const next = await read('/api/state'), at = new Date().toISOString();
      setDisplayZone(next.my_timezone);
      setData(next); setLoadedAt(at); setError(''); lastLoad.current = Date.now(); seenChange.current = next.change_seq ?? null;
      if (announce) setAnnouncement(`Data updated at ${formatTime(at)}`);
    }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); if (!quiet) setRefreshing(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Keep the screen in step with work done elsewhere: by colleagues, in the Telegram bot or in the Telegram app.
  // Every 4 seconds while this tab is visible (and when the person returns to it) ask the server whether anything
  // was saved since the data on screen was loaded, and reload quietly if so; reload anyway every 5 minutes.
  // Not while a dialog or menu is open or someone is typing, so nothing changes under their hands.
  useEffect(() => {
    let checking = false, failures = 0, lastScroll = 0;
    const OFFLINE = 'The local Task Controlling Management server is not responding.';
    // A full-app reload re-renders everything; holding it off while the person is actively
    // scrolling (anywhere — the page, a dialog, a list) keeps scrolling smooth. capture:true
    // catches scrolls inside inner containers too; the reload resumes the moment they pause.
    const onScroll = () => { lastScroll = Date.now(); };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    const busy = () => {
      if (Date.now() - lastScroll < 600) return true;
      if (document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return true;
      const a = document.activeElement as HTMLInputElement | null;
      return !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'search' && a.type !== 'checkbox' && a.type !== 'radio'));
    };
    const check = async () => {
      if (checking || document.visibilityState !== 'visible' || busy()) return;
      checking = true;
      try {
        let stale = Date.now() - lastLoad.current > 300000;
        if (!stale) {
          const r = await apiFetch('/api/changes');
          if (r.status === 401) { window.dispatchEvent(new Event('session-expired')); return; }
          if (!r.ok) return;
          stale = (await r.json() as Row).seq !== seenChange.current;
          failures = 0; setError(e => (e === OFFLINE ? '' : e));
          // Nothing new: the data on screen is current as of now (only re-render when the shown minute changes).
          if (!stale) { const now = new Date().toISOString(); setLoadedAt(old => (formatTime(old) === formatTime(now) ? old : now)); }
        }
        if (stale && !busy()) await refresh({ quiet: true });
      } catch { if (++failures >= 2) setError(OFFLINE); }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => void check(), 4000), back = () => void check();
    document.addEventListener('visibilitychange', back); window.addEventListener('focus', back);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions); };
  }, [refresh]);

  // Move focus to the page and back to the top when the address changes, so keyboard and screen-reader users land on the new content.
  const mainRef = useRef<HTMLElement>(null), firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; return; }
    window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true });
  }, [route.path]);

  // V5.6.8: an open task or task request has an address of its own (#/tasks/tasks/TASK-…, or ?task= / ?request= on the
  // Task Management section that is open), so Back closes it and the address can be shared.
  const taskSectionNow = route.parts[0] === 'tasks' && data && taskSectionVisible(route.parts[1], can) ? route.parts[1] : 'tasks';
  const openTask = (id: string) => openItem({ navigate, route }, taskRoute(taskSectionNow, id, route.query));
  const openLinkedActivity = (r?: Row) => {
    if (!r || !data) return false;
    const task = data.tm_tasks.find((t: Row) => t.activity_id === r.id), meeting = data.tm_meetings.find((m: Row) => m.activity_id === r.id);
    if (task) { openTask(task.id); return true; }
    if (meeting) { navigate('/tasks/calendar'); setTaskFocus({ kind: 'meeting', id: meeting.id }); return true; }
    return false;
  };
  const show = (type: string, id: string) => {
    if (!id) return;
    if (type === 'admin_user') { navigate('/admin/users'); setAdminFocus(id); return; }
    if (type === 'tm_task') { openTask(id); return; }
    if (type === 'tm_request') { openItem({ navigate, route }, `/tasks/requests?request=${encodeURIComponent(id)}`); return; }
    if (type.startsWith('tm_')) {
      const kind = type.slice(3);
      navigate(`/tasks/${({ meeting: 'calendar', calnote: 'calendar', workspace: 'workspace', profile: 'users', time: 'timesheets' } as Row)[kind] || 'tasks'}`);
      setTaskFocus({ kind, id });
      return;
    }
    if (type === 'activity') { if (data) { const r = data.activities.find((x: Row) => x.id === id); if (!openLinkedActivity(r) && r) setModel(initialModel('activity', data, actor, r)); } return; }
    if (type === 'operations') { navigate(`/operations/${encodeURIComponent(id)}`); return; }
    if (type === 'order') { navigate(`/operations/orders/${encodeURIComponent(id)}`); return; }
    navigate(`/crm/${crmSlug(type)}/${encodeURIComponent(id)}`);
  };
  const perform = async (action: string, row: Row, options: { quiet?: boolean } = {}) => {
    const res = await apiFetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data: row }) });
    const answer = await res.json() as Row;
    if (!res.ok) { if (res.status === 401) window.dispatchEvent(new Event('session-expired')); throw new Error(answer.error || 'Unable to save. Your entries are still in the form.'); }
    await refresh();
    if (!options.quiet) toast.success(answer.result.message || 'Saved');
    return answer.result;
  };
  const edit = (kind: string, row: Row = {}) => { if (!data) return; if (kind === 'activity' && openLinkedActivity(row)) return; setModel(initialModel(kind, data, actor, row)); };

  // ---------------------------------------------------------------- navigation model
  const nav = useMemo(() => {
    if (!data) return [] as { label?: string; items: NavItem[] }[];
    const prefix = (p: string) => Object.keys(data.auth.permissions).some(k => k.startsWith(p) && can(k));
    const taskTabs = Object.entries(TASK_SECTIONS).filter(([key]) => taskSectionVisible(key, can));
    // Work waiting for this person: tasks to accept or reject (in charge, supporting or reviewing), work to review, changes,
    // requests and due dates to decide, and (V5.6.8) organization requests they approve. The bell counts the same.
    const waiting = data.tm_tasks ? decisionsFor(data, actor, can).total : orgPending(data).count;
    const alerts = data.ops_notifications.filter((n: Row) => n.actor_id === actor && !n.resolved_at).length;
    const groups: { label?: string; items: NavItem[] }[] = [
      { items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, href: '#/dashboard', visible: can('dashboard') }] },
      { label: 'Customers', items: [{ id: 'crm', label: 'CRM', icon: UsersRound, href: '#/crm', visible: prefix('crm.'), children: [{ id: 'workflow', label: 'Overview', href: '#/crm' }, ...CRM_TYPES.filter(([t]) => can('crm.' + TABLES[t])).map(([t, label, slug]) => ({ id: slug, label, href: `#/crm/${slug}`, count: data[TABLES[t]].length }))] }] },
      { label: 'Work', items: [{ id: 'tasks', label: 'Task Management', icon: ClipboardCheck, href: `#/tasks/${taskTabs[0]?.[0] || 'workspace'}`, visible: taskTabs.length > 0, badge: waiting || undefined, alert: waiting > 0, children: taskTabs.map(([key, label]) => ({ id: key, label, href: `#/tasks/${key}` })) }] },
      { label: 'Operations', items: [
        { id: 'operations', label: 'Operations', icon: Truck, href: '#/operations', visible: prefix('ops.'), badge: alerts || undefined, alert: alerts > 0 },
        { id: 'finance', label: 'Finance', icon: Landmark, href: '#/finance', visible: can('ops.finance') },
      ] },
      { label: 'Insights', items: [{ id: 'reports', label: 'Reports', icon: ChartNoAxesCombined, href: '#/reports', visible: prefix('reports.') }] },
      { label: 'Administration', items: [
        { id: 'admin', label: 'Administration', icon: ShieldCheck, href: '#/admin', visible: prefix('admin.') },
        { id: 'settings', label: 'Company settings', icon: Settings2, href: '#/settings', visible: can('settings') },
      ] },
    ];
    return groups.map(g => ({ ...g, items: g.items.filter(i => i.visible) })).filter(g => g.items.length);
  }, [data, can, actor]);

  // Redirect an unknown or unauthorised address to the first permitted area.
  const visibleIds = nav.flatMap(g => g.items.map(i => i.id));
  const section = route.parts[0];
  const moduleOk = visibleIds.includes(section);
  useEffect(() => {
    if (!data || moduleOk || !visibleIds.length) return;
    const first = nav[0]?.items[0];
    if (first) navigate(first.href.slice(1), { replace: true });
  }, [data, moduleOk, visibleIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Task Management: the section in the address, or the first one this person can open. A direct task address
  // (#/tasks/tasks/TASK-000123) keeps the task open (Task Management shows it, or reports it as not found, exactly like
  // a task that doesn't exist). V5.6.8: an unknown or missing section (#/tasks, #/tasks/foo, the old #/tasks/meetings)
  // is replaced by a real one, so the sidebar, the page and the tab title always agree.
  const taskTabs = data ? Object.keys(TASK_SECTIONS).filter(k => taskSectionVisible(k, can)) : [];
  const askedTask = route.parts[1] === 'meetings' ? 'calendar' : route.parts[1];
  const taskSection = taskTabs.includes(askedTask) ? askedTask : taskTabs[0];
  useEffect(() => {
    if (!data || section !== 'tasks' || !taskSection || route.parts[1] === taskSection) return;
    navigate(`/tasks/${taskSection}`, { replace: true });
  }, [route.path, !!data, section, taskSection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page title for the browser tab / history. Task Management uses its section names (and the open task, request or group).
  useEffect(() => {
    const label = nav.flatMap(g => g.items).find(i => i.id === section)?.label;
    if (section === 'tasks' && data && taskSection) {
      const id = (['tasks', 'groups'].includes(taskSection) && route.parts[2]) || route.query.get('task') || route.query.get('request') || '';
      const item = !id ? '' : taskSection === 'groups' && route.parts[2] ? (data.tm_boards || []).find((b: Row) => b.id === id)?.name
        : route.query.get('request') && !route.query.get('task') ? (data.tm_requests || []).find((q: Row) => q.id === id)?.title || id
          : (data.tm_tasks || []).find((t: Row) => t.id === id)?.title || id;
      document.title = [item, TASK_SECTIONS[taskSection as keyof typeof TASK_SECTIONS], label, 'Task Controlling Management'].filter(Boolean).join(' · ');
      return;
    }
    const detail = route.parts.length > 2 ? route.parts[2] : route.parts[1] && !['records'].includes(route.parts[1]) ? route.parts[1] : '';
    document.title = [detail && decodeURIComponent(detail), label, 'Task Controlling Management'].filter(Boolean).join(' · ');
  }, [route, nav, section, data, taskSection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Boot message="Opening your workspace…" />;
  if (!data) return <Boot error={error} onRetry={() => void refresh()} onSignOut={() => void signOut()} />;

  const lookup = (id: string) => data.lookups.find((r: Row) => r.id === id)?.name || id || '—';
  const photoOf = photoIndex(data);
  const w: Workspace = { data, actor, show, edit, perform, lookup, currency: data.company.currency, can, navigate, route, refresh };
  const alerts = data.ops_notifications.filter((n: Row) => n.actor_id === actor && !n.resolved_at);

  let content: ReactNode;
  if (!visibleIds.length) content = <><PageHeader title="No modules available" /><NoAccess title="Your account has no module permissions" description="Ask an administrator to assign a role or individual function settings." /></>;
  else if (!moduleOk) content = null;
  else if (section === 'dashboard') content = route.parts[1] === 'records' ? <SourceExplorer key={data.task_scope?.revision} {...w} filters={parseFilters(route.query.get('f'))} onBack={() => navigate('/dashboard')} /> : <ERPDashboard key={data.task_scope?.revision} {...w} drill={f => navigate(`/dashboard/records?f=${encodeURIComponent(JSON.stringify(f))}`)} />;
  else if (section === 'crm') {
    const slug = route.parts[1], type = slug ? crmType(slug) : undefined, id = route.parts[2];
    if (!slug) content = <CRMWorkflow {...w} />;
    else if (!type) content = <NotFound w={w} />;
    else if (!can('crm.' + TABLES[type])) content = <NoAccess />;
    else if (id) {
      const row = data[TABLES[type]]?.find((r: Row) => r.id === id);
      content = row ? <Detail key={`${type}:${id}`} {...w} type={type} row={row} /> : <NotFound w={w} label={`${id} was not found, or you don’t have access to it.`} back={`/crm/${slug}`} />;
    } else content = <RecordList key={type} {...w} type={type} />;
  } else if (section === 'tasks') {
    // V5.5: Meetings live in the Calendar; earlier addresses still work (they are replaced by the current one).
    content = <TaskManagement {...w} section={taskSection} onSection={s => navigate(`/tasks/${s}`)} legacy={<CRMActivities {...w} embedded />} focus={taskFocus} onFocused={() => setTaskFocus(null)} onAdministration={() => navigate('/admin/users')} />;
  } else if (section === 'operations') {
    if (route.parts[1] === 'orders' && route.parts[2]) {
      const row = data.orders.find((r: Row) => r.id === route.parts[2]);
      content = row ? <Detail key={`order:${row.id}`} {...w} type="order" row={row} /> : <NotFound w={w} back="/operations" />;
    } else if (route.parts[1]) {
      const exists = data.ops_requests.some((r: Row) => r.id === route.parts[1]);
      content = exists ? <OperationsWorkspace {...w} initialId={route.parts[1]} /> : <NotFound w={w} label={`${route.parts[1]} was not found, or you don’t have access to it.`} back="/operations" />;
    } else content = <OperationsWorkspace {...w} />;
  } else if (section === 'finance') content = <FinancePage {...w} />;
  else if (section === 'reports') content = <CentralReports key={data.task_scope?.revision} {...w} tab={route.parts[1] || ''} crm={<CRMReports {...w} />} operations={<OperationsReports {...w} />} />;
  else if (section === 'admin') content = <Administration {...w} tab={route.parts[1] || ''} initialUserId={adminFocus} onFocused={() => setAdminFocus(null)} />;
  else if (section === 'settings') content = <SettingsView {...w} />;

  return (
    <AvatarPhotoProvider photo={photoOf}>
    <SidebarProvider className="app-shell" defaultOpen={!/(?:^|;\s*)sidebar_state=false/.test(document.cookie)}>
      <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <AppSidebar nav={nav} active={section} activeChild={section === 'crm' ? route.parts[1] || 'workflow' : section === 'tasks' ? route.parts[1] : undefined} company={data.company.name} />
      <SidebarInset>
        <header className="app-header">
          <div className="app-header-start">
            <SidebarTrigger />
            <span className="header-divider" aria-hidden="true" />
            <label className="company-switch" title="Switch company">
              <Building2 aria-hidden="true" />
              <span className="sr-only">Current company</span>
              <select value={data.company_context?.id || 'default'} onChange={e => openCompany(e.target.value)}>
                {(data.companies || []).map((c: Row) => <option key={c.id} value={c.id}>{c.name.trim().toLowerCase() === LOGO_ALT.toLowerCase() ? 'Default company' : c.name}</option>)}
              </select>
            </label>
            {data.sharing?.url && <a className="header-shared" href="#/admin/telegram" aria-label="Shared access: open the Telegram page" title={`Anyone with ${data.sharing.url} can reach the sign-in page while the sharing window is open.`}><Globe aria-hidden="true" /><span className="header-shared-text">Shared access</span></a>}
          </div>
          <div className="app-header-end">
            {loadedAt && <span className="header-updated">{refreshing ? 'Updating…' : `Updated ${formatTime(loadedAt)}`}</span>}
            <span className="sr-only" aria-live="polite">{announcement}</span>
            <IconButton label="Refresh data" icon={refreshing ? Loader2 : RefreshCw} className={refreshing ? 'is-spinning' : undefined} disabled={refreshing} onClick={() => void refresh({ announce: true })} />
            {can('tasks.tasks') ? <NotificationsMenu w={w} opsAlerts={prefix(data, can, 'ops.') ? alerts.length : 0} onOps={() => navigate('/operations?view=approvals')} />
              : prefix(data, can, 'ops.') ? (
                <span className="header-icon-button">
                  <IconButton label={alerts.length ? `${alerts.length} approval alert${alerts.length === 1 ? '' : 's'}` : 'Approval alerts'} icon={Bell} onClick={() => navigate('/operations?view=approvals')} />
                  {alerts.length > 0 && <span className="count-pill" aria-hidden="true">{alerts.length > 9 ? '9+' : alerts.length}</span>}
                </span>
              ) : null}
            <UserMenu name={lookup(actor) === actor ? data.auth.user.name : lookup(actor)} role={data.auth.user.role_name} email={data.auth.user.email} onProfile={() => setProfileOpen(true)}
              telegram={can('tasks.tasks') && data.telegram?.enabled ? (data.telegram.link ? 'connected' : 'available') : undefined} onTelegram={() => setTelegramOpen(true)} onSignOut={() => void signOut()} />
          </div>
        </header>
        <main id="main-content" ref={mainRef} tabIndex={-1} className="app-main">
          <div className="page">
            {error && <div className="app-error"><ErrorState compact title="The latest data could not be loaded" message={`${error} What you see may be out of date.`} onRetry={() => void refresh()} /></div>}
            {content}
          </div>
        </main>
      </SidebarInset>
      {model && <Editor key={`${model.kind}:${model.data.id || 'new'}:${model.action}`} model={model} state={data} actor={actor} onClose={() => setModel(null)} onSave={async (action, d) => { const result = await perform(action, d); if (result.id && TABLES[result.type] && !['activity', 'document', 'campaign'].includes(result.type)) show(result.type, result.id); }} />}
      {telegramOpen && <TelegramConnectDialog w={w} onClose={() => setTelegramOpen(false)} />}
      {profileOpen && <MyProfileDialog w={w} onClose={() => setProfileOpen(false)} sidebarTheme={sidebarTheme} onSidebarTheme={setThemePreview} onTelegram={can('tasks.tasks') ? () => { setProfileOpen(false); setTelegramOpen(true); } : undefined}
        onTeamProfile={can('tasks.users', 'update') ? () => { setProfileOpen(false); show('tm_profile', actor); } : undefined} />}
      <Toaster position="bottom-right" closeButton />
    </SidebarProvider>
    </AvatarPhotoProvider>
  );
}

/** Profile photos by person name (staff names are unique), so every avatar in the Task Controlling Management can show a face. */
function photoIndex(data: Data): (name: string) => string | undefined {
  const byId = new Map<string, number>((data.staff_photos || []).map((p: Row) => [p.staff_id, p.version]));
  const byName = new Map<string, string>();
  if (byId.size) for (const r of data.lookups as Row[]) if (byId.has(r.id) && !byName.has(r.name)) byName.set(r.name, apiPath(`/api/photo?staff=${encodeURIComponent(r.id)}&v=${byId.get(r.id)}`));
  return name => byName.get(name);
}

const prefix = (data: Data, can: (r: string, a?: string) => boolean, p: string) => Object.keys(data.auth.permissions).some(k => k.startsWith(p) && can(k));
function parseFilters(raw: string | null): Row { try { const f = JSON.parse(raw || '{}'); return f && typeof f === 'object' && !Array.isArray(f) ? f : {}; } catch { return {}; } }

function AppSidebar({ nav, active, activeChild, company }: { nav: { label?: string; items: NavItem[] }[]; active: string; activeChild?: string; company: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const closeOnMobile = () => { if (isMobile) setOpenMobile(false); };
  const showCompanyName = company.trim().toLowerCase() !== LOGO_ALT.toLowerCase();
  return (
    <Sidebar collapsible="icon" className="app-sidebar">
      <SidebarHeader>
        <a className="sidebar-brand" href="#/dashboard" onClick={closeOnMobile} aria-label={`${LOGO_ALT}${showCompanyName ? ` · ${company}` : ''} · go to dashboard`}>
          <span className="brand-mark" aria-hidden="true"><LogoIcon size={32} alt="" /></span>
          <span className="brand-text"><span className="brand-name"><BrandTitle /></span>{showCompanyName && <span className="brand-company">{company}</span>}</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          {nav.map((group, gi) => (
            <SidebarGroup key={gi}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map(item => {
                    const isActive = active === item.id;
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                          <a href={item.href} aria-current={isActive && !activeChild ? 'page' : undefined} onClick={closeOnMobile}>
                            <item.icon aria-hidden="true" />
                            <span>{item.label}</span>
                            {item.badge ? <span className={item.alert ? 'nav-badge is-alert' : 'nav-badge'} aria-label={`${item.badge} pending`}>{item.badge}</span> : null}
                          </a>
                        </SidebarMenuButton>
                        {isActive && item.children && item.children.length > 1 && (
                          <SidebarMenuSub>
                            {item.children.map(child => (
                              <SidebarMenuSubItem key={child.id}>
                                <SidebarMenuSubButton href={child.href} isActive={activeChild === child.id} aria-current={activeChild === child.id ? 'page' : undefined}
                                  onClick={() => { closeOnMobile(); if (window.location.hash === child.href) window.dispatchEvent(new CustomEvent('erp:reselect', { detail: child.href })); }}>
                                  <span>{child.label}</span>
                                  {child.count !== undefined && <span className="nav-badge">{child.count}</span>}
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}

function UserMenu({ name, role, email, onProfile, telegram, onTelegram, onSignOut }: { name: string; role: string; email: string; onProfile?: () => void; telegram?: 'connected' | 'available'; onTelegram: () => void; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="user-trigger" aria-label={`Account: ${name}, ${role}`}>
          <Avatar name={name} size="md" />
          <span className="user-trigger-text"><strong><Identity name={name}/></strong><span>{role}</span></span>
          <ChevronDown aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="user-menu">
        <div className="user-menu-head"><Avatar name={name} /><div><strong><Identity name={name}/></strong><span>{email}</span><span>{role}</span></div></div>
        <DropdownMenuSeparator />
        {onProfile && <DropdownMenuItem onSelect={onProfile}><UserRound />My profile</DropdownMenuItem>}
        {telegram && <DropdownMenuItem onSelect={onTelegram}><Send />{telegram === 'connected' ? 'Telegram · connected' : 'Connect Telegram'}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={onSignOut}><LogOut />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Boot({ message, error, onRetry, onSignOut }: { message?: string; error?: string; onRetry?: () => void; onSignOut?: () => void }) {
  return (
    <main className="boot">
      <div className="boot-card" role={error ? 'alert' : 'status'}>
        <LogoIcon size={88} className="boot-logo" />
        {error ? <><h1>The local database could not be opened</h1><p>{error}</p><div className="row"><Button onClick={onRetry}><RefreshCw />Try again</Button><Button variant="outline" onClick={onSignOut}>Sign out</Button></div></> : <><Loader2 className="boot-spinner" aria-hidden="true" /><h1>{message}</h1><p>Loading your company records.</p></>}
      </div>
    </main>
  );
}

function NotFound({ w, label = 'This page does not exist.', back = '/dashboard' }: { w: Workspace; label?: string; back?: string }) {
  return <><PageHeader title="Not found" /><EmptyState icon={SearchX} title="We couldn’t find that record" description={label} action={<Button variant="outline" onClick={() => w.navigate(back)}>Go back</Button>} /></>;
}
