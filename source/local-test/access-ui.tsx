import { apiFetch, openCompany } from './api-client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, Copy, History, KeyRound, Loader2, Plus, Send, Sheet, ShieldCheck, Trash2, UserX, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type Row } from './components';
import { RESOURCES, roleDefaults } from './access-catalog.mjs';
import { FunctionGroups, CompanyTools } from './admin-functions';
import { TelegramAdmin } from './telegram-ui';
import { GoogleSheetsAdmin } from './group-sync-ui';
import { Logo } from './brand';
import type { Workspace } from './ui';
import { useViewState } from './router';
import { plural } from './format';
import {
  Alert, Avatar, DataTable, DateText, EmptyState, ErrorState, ExpandableText, Field, FilterBar, FilterSelect, FormSection, IconButton, Missing, NoAccess,
  PageHeader, PasswordField, Picker, SearchInput, SectionTabs, StatCard, StatusBadge, SwitchField, Tag, buildChips, useConfirm, useFormErrors, type Column,
} from './ui-kit';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ================================================================ sign-in / first administrator

export function AuthGate({ children }: { children: (user: Row, signOut: () => Promise<void>) => ReactNode }) {
  const [status, setStatus] = useState<Row | null>(null), [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(false), [expired, setExpired] = useState(false);
  const [form, setForm] = useState<Row>({ username: '', email: '', password: '', confirm: '', staff_id: '', name: '' });
  const [errors, setErrors] = useState<Record<string, string>>({}), [formError, setFormError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const load = async () => {
    setLoadError('');
    try {
      const r = await apiFetch('/api/auth/status');
      const d = await r.json() as Row;
      if (!r.ok) throw new Error(d.error || 'The local Task Controlling Management server did not respond.');
      setStatus(d);
      if (d.setup_required) {
        const s = d.staff.find((s: Row) => s.id === 'STAFF-003') || d.staff[0];
        setForm(f => ({ ...f, staff_id: f.staff_id || s?.id || '', name: f.name || s?.name || '' }));
      }
    } catch (e) {
      setLoadError(e instanceof TypeError ? 'The local Task Controlling Management server is not responding. Check that the start window is still open, then try again.' : (e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const onExpired = () => { setStatus(null); setExpired(true); void load(); };
    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, []);
  const signOut = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setStatus(s => ({ ...s, user: null })); setExpired(false);
    setForm(f => ({ ...f, password: '', confirm: '' }));
  };
  if (status?.user) return <>{children(status.user, signOut)}</>;

  const setup = !!status?.setup_required;
  const set = (key: string, value: string) => { setForm(f => ({ ...f, [key]: value })); setErrors(e => { const n = { ...e }; delete n[key]; return n; }); };
  const validate = () => {
    const e: Record<string, string> = {};
    if (setup && status?.staff?.length && !form.staff_id) e.staff_id = 'Select the staff identity for this administrator.';
    if (setup && !String(form.name).trim()) e.name = 'Enter the administrator’s username.';
    if (!setup && !String(form.username).trim()) e.username = 'Enter your username.';
    if (setup && String(form.email).trim() && !EMAIL.test(String(form.email).trim())) e.email = 'Enter a valid contact email.';
    if (!form.password) e.password = 'Enter your password.';
    else if (setup && form.password.length < 10) e.password = 'Use at least 10 characters.';
    if (setup && form.password && form.confirm !== form.password) e.confirm = form.confirm ? 'The passwords do not match.' : 'Enter the password again.';
    return e;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found); setFormError('');
    if (Object.keys(found).length) {
      requestAnimationFrame(() => (formRef.current?.querySelector('.has-error input, .has-error [role=combobox]') as HTMLElement | null)?.focus());
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, username: setup ? form.name : form.username, email: String(form.email).trim() }) });
      const d = await r.json() as Row;
      if (!r.ok) throw new Error(d.error || 'Unable to sign in.');
      setStatus(s => ({ ...s, user: d.user, setup_required: false })); setExpired(false);
      setForm(f => ({ ...f, password: '', confirm: '' }));
    } catch (e) {
      const message = e instanceof TypeError ? 'The local Task Controlling Management server is not responding. Your entries are kept — try again when it is running.' : (e as Error).message;
      if (setup && /password/i.test(message)) setErrors({ password: message });
      else if (/valid email/i.test(message)) setErrors({ email: message });
      else setFormError(message);
    } finally { setBusy(false); }
  };
  const companies: Row[] = status?.companies || [];
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="auth-brand">
          <h1 className="auth-title"><Logo size={600} className="auth-logo" /></h1>
        </div>
        <div className="auth-pitch">
          <h2>Your team’s daily workspace.</h2>
          <p>Plan tasks, coordinate your team and keep work moving.</p>
          <ul className="auth-features">
            <li><ShieldCheck aria-hidden="true" />Role-based access for each company</li>
            <li><UsersRound aria-hidden="true" />Shared tasks, meetings and approvals</li>
            <li><KeyRound aria-hidden="true" />Secure access to your workspace</li>
          </ul>
        </div>
      </aside>
      <main className="auth-main" id="main-content">
        <div className="auth-card">
          {!status ? (
            loadError
              ? <ErrorState title="Can’t reach the local Task Controlling Management server" message={loadError} onRetry={() => void load()} />
              : <div className="auth-loading" role="status"><Loader2 className="boot-spinner" aria-hidden="true" />Opening workspace…</div>
          ) : (
            <>
              <div className="auth-card-head">
                <h2>{setup ? 'Create the administrator' : 'Sign in'}</h2>
                <p>{setup ? status.staff.length ? 'Connect the first login to an existing staff identity. Their CRM and approval history stays connected.' : 'Start with an empty system and create your first administrator account.' : <>Welcome back to <strong>Task Controlling Management</strong>. Use your username and password.</>}</p>
              </div>
              <form ref={formRef} className="auth-form" onSubmit={submit} noValidate>
                {expired && !setup && !formError && <Alert tone="info" title="Your session ended">Sign in again to continue. Anything you had not saved may need to be entered again.</Alert>}
                {formError && <Alert tone="danger" live>{formError}</Alert>}
                {setup && status.staff.length > 0 && !formError && <Alert tone="info" title="Restoring an existing company?">Your logins and records are in the data folder of your previous Task Controlling Management folder. Close the Task Controlling Management, copy that data folder into this one and start again, instead of creating a new administrator.</Alert>}
                {!setup && companies.length > 1 && <Picker label="Company" value={status.company_id || 'default'} allowNone={false} options={companies.map((c: Row) => [c.id, c.name])} onChange={v => v && openCompany(v)} hint="Each company has its own accounts and records." />}
                {setup && <>
                  {status.staff.length > 0 && <Picker label="Staff identity" required value={form.staff_id} error={errors.staff_id} options={status.staff.map((s: Row) => [s.id, `${s.name} · ${s.id}`])}
                    onChange={v => { set('staff_id', v); const name = status.staff.find((s: Row) => s.id === v)?.name; if (name) set('name', name); }} />}
                  <Field label="Username" required value={form.name} error={errors.name} autoComplete="name" onChange={v => set('name', v)} />
                </>}
                {setup ? <Field label="Contact email" type="email" hint="Optional." value={form.email} error={errors.email} autoComplete="email" onChange={v => set('email', v)} /> : <Field label="Username" required value={form.username} error={errors.username} autoComplete="username" onChange={v => set('username', v)} />}
                <PasswordField label="Password" required value={form.password} error={errors.password} autoComplete={setup ? 'new-password' : 'current-password'} hint={setup ? 'At least 10 characters.' : undefined} onChange={v => set('password', v)} />
                {setup && <PasswordField label="Confirm password" required value={form.confirm} error={errors.confirm} autoComplete="new-password" onChange={v => set('confirm', v)} />}
                <Button type="submit" size="lg" loading={busy}>{busy ? 'Please wait…' : setup ? 'Create administrator & sign in' : 'Sign in'}</Button>
                <p className="auth-note">Ask your administrator if you need help signing in.</p>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ================================================================ administration

type AdminModal = { kind: 'role' | 'user'; data: Row };
type AdminProps = Workspace & { tab?: string; initialUserId?: string | null; onFocused?: () => void };

export function Administration(w: AdminProps) {
  const d = w.data;
  const confirm = useConfirm();
  const [modal, setModal] = useState<AdminModal | null>(null);
  const canUsers = w.can('admin.users'), canRoles = w.can('admin.roles');
  const tabs = [
    canUsers && { id: 'users', label: 'User accounts', href: '#/admin/users', icon: UsersRound, count: d.access_users.length },
    canRoles && { id: 'roles', label: 'Roles & permissions', href: '#/admin/roles', icon: ShieldCheck, count: d.access_roles.length },
    (w.can('admin.modules') || w.can('admin.companies')) && { id: 'company', label: 'Company & modules', href: '#/admin/company', icon: Building2 },
    w.can('admin.telegram') && { id: 'telegram', label: 'Telegram', href: '#/admin/telegram', icon: Send },
    w.can('admin.integrations') && { id: 'google', label: 'Google Sheets', href: '#/admin/google', icon: Sheet },
    (canUsers || canRoles) && { id: 'history', label: 'Access history', href: '#/admin/history', icon: History },
  ].filter(Boolean) as { id: string; label: string; href: string; icon: typeof UsersRound; count?: number }[];
  const active = tabs.find(t => t.id === w.tab)?.id || tabs[0]?.id;

  const roleName = (id: string) => d.access_roles.find((r: Row) => r.id === id)?.name || id;
  const permissions = (id: string) => Object.fromEntries(RESOURCES.map(([r]: any) => [r, d.access_permissions.filter((p: Row) => p.role_id === id && p.resource === r).map((p: Row) => p.action)]));
  const editRole = (r?: Row, clone = false) => setModal({
    kind: 'role',
    data: r
      ? { ...r, id: clone ? undefined : r.id, name: clone ? `${r.name} copy` : r.name, protected: clone ? 0 : r.protected, expected_version: clone ? undefined : r.version, permissions: permissions(r.id) }
      : { name: '', description: '', permissions: roleDefaults('VIEWER') },
  });
  const editUser = (r?: Row) => {
    const p = d.tm_profiles.find((p: Row) => p.staff_id === r?.staff_id);
    const defaultRole = d.access_roles.some((x: Row) => x.id === 'ROLE-MEMBER') ? 'ROLE-MEMBER' : d.access_roles.find((x: Row) => !x.protected)?.id || '';
    const settings = Object.fromEntries(RESOURCES.map(([resource]: any) => [resource, Object.fromEntries((d.access_user_permissions || []).filter((x: Row) => x.user_id === r?.id && x.resource === resource).map((x: Row) => [x.action, x.effect]))]).filter(([, v]) => Object.keys(v as Row).length));
    setModal({ kind: 'user', data: { name: '', email: '', role_id: defaultRole, active: 1, ...p, ...r, password: '', expected_version: r?.version, function_settings: settings } });
  };
  useEffect(() => {
    if (!w.initialUserId) return;
    const user = d.access_users.find((u: Row) => u.id === w.initialUserId);
    if (user) editUser(user);
    w.onFocused?.();
  }, [w.initialUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  const disableUser = async (u: Row) => {
    const self = u.id === d.auth.user.id;
    const answer = await confirm({
      title: self ? 'Disable your own account?' : `Disable ${u.name}’s account?`,
      description: self ? 'You will be signed out immediately and will not be able to sign in again until another administrator re-activates the account.' : 'They are signed out immediately and can no longer sign in. Their staff record, tasks and approval history stay connected.',
      confirmLabel: 'Disable account', tone: 'danger', reason: { label: 'Reason', required: true, placeholder: 'For example: left the company' },
    });
    if (!answer) return;
    try { await w.perform('admin.user.disable', { id: u.id, expected_version: u.version, reason: answer.reason }); } catch (e) { toast.error((e as Error).message); }
  };
  const deleteRole = async (r: Row) => {
    if (!(await confirm({ title: `Delete the “${r.name}” role?`, description: 'This cannot be undone. Roles that are still assigned to an account cannot be deleted.', confirmLabel: 'Delete role', tone: 'danger' }))) return;
    try { await w.perform('admin.role.delete', { id: r.id, expected_version: r.version }); } catch (e) { toast.error((e as Error).message); }
  };

  if (!tabs.length) return <><PageHeader crumbs={[{ label: 'Administration' }]} title="Administration" /><NoAccess /></>;
  const current = tabs.find(t => t.id === active)!;
  const actions = active === 'users' && w.can('admin.users', 'create') ? <Button onClick={() => editUser()}><Plus />Create user</Button>
    : active === 'roles' && w.can('admin.roles', 'create') ? <Button onClick={() => editRole()}><Plus />Create role</Button> : undefined;
  return (
    <>
      <PageHeader crumbs={[{ label: 'Administration', href: '#/admin' }, { label: current.label }]} title="Administration"
        description={`Login accounts, roles and permissions for ${d.company.name}. Every change is recorded in access history.`} actions={actions} />
      <SectionTabs label="Administration sections" active={active} items={tabs} />
      {active === 'users' && <UsersTab w={w} roleName={roleName} onEdit={editUser} onDisable={disableUser} />}
      {active === 'roles' && <RolesTab w={w} onEdit={editRole} onDelete={deleteRole} />}
      {active === 'company' && <CompanyTools w={w} />}
      {active === 'history' && <HistoryTab w={w} />}
      {active === 'telegram' && <TelegramAdmin w={w} />}
      {active === 'google' && <GoogleSheetsAdmin w={w} />}
      {modal && <AdminEditor key={`${modal.kind}:${modal.data.id || 'new'}`} w={w} model={modal} onClose={() => setModal(null)} />}
    </>
  );
}

const USER_FILTERS = { query: '', role: '', status: '', custom: '' };

function UsersTab({ w, roleName, onEdit, onDisable }: { w: Workspace; roleName: (id: string) => string; onEdit: (u: Row) => void; onDisable: (u: Row) => void }) {
  const d = w.data;
  const [f, setF] = useViewState('admin:users', USER_FILTERS);
  const set = (patch: Partial<typeof USER_FILTERS>) => setF(v => ({ ...v, ...patch }));
  const overrides = (id: string) => (d.access_user_permissions || []).filter((p: Row) => p.user_id === id).length;
  const users: Row[] = d.access_users;
  const rows = users.filter(u => (!f.query || `${u.name} ${u.email} ${roleName(u.role_id)} ${u.staff_id} ${u.position} ${u.department}`.toLowerCase().includes(f.query.toLowerCase()))
    && (!f.role || u.role_id === f.role) && (!f.status || (f.status === 'ACTIVE' ? !!u.active : !u.active)) && (!f.custom || (f.custom === 'yes' ? overrides(u.id) > 0 : overrides(u.id) === 0)));
  const chips = buildChips([
    { key: 'query', label: 'Search', value: f.query, display: `“${f.query}”`, clear: () => set({ query: '' }) },
    { key: 'role', label: 'Role', value: f.role, display: roleName(f.role), clear: () => set({ role: '' }) },
    { key: 'status', label: 'Status', value: f.status, display: f.status === 'ACTIVE' ? 'Active' : 'Disabled', clear: () => set({ status: '' }) },
    { key: 'custom', label: 'Individual settings', value: f.custom, display: f.custom === 'yes' ? 'Has overrides' : 'Role only', clear: () => set({ custom: '' }) },
  ]);
  const canUpdate = w.can('admin.users', 'update'), canDisable = w.can('admin.users', 'delete');
  const activeCount = users.filter(u => u.active).length;
  const columns: Column[] = [
    { key: 'name', header: 'User', minWidth: 220, cell: u => <span className="person-cell"><Avatar name={u.name} size="sm" /><span className="cell-stack"><span className="cell-title">{u.name}{u.id === d.auth.user.id && <Tag className="ml-2">You</Tag>}</span><small><span className="id-text">{u.staff_id}</span>{[u.position, u.department].filter(Boolean).length > 0 && <> · {[u.position, u.department].filter(Boolean).join(', ')}</>}</small></span></span> },
    { key: 'username', header: 'Username', cell: u => <span className="text-break">{u.username}</span> },
    { key: 'role_id', header: 'Role', sortValue: u => roleName(u.role_id), cell: u => <span className="inline-icon-text">{u.role_id === 'ROLE-ADMIN' && <ShieldCheck aria-hidden="true" />}{roleName(u.role_id)}</span> },
    { key: 'overrides', header: 'Overrides', headerTitle: 'Individual function settings that override the role', sortValue: u => overrides(u.id), cell: u => { const n = overrides(u.id); return n ? <Tag>{n} override{n === 1 ? '' : 's'}</Tag> : <span className="muted">Role only</span>; } },
    { key: 'active', header: 'Status', sortValue: u => (u.active ? 'Active' : 'Disabled'), cell: u => <StatusBadge value={u.active ? 'ACTIVE' : 'DISABLED'} /> },
    { key: 'updated_at', header: 'Last changed', cell: u => <DateText value={u.updated_at} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, sortable: false, align: 'right', cell: u => (
      <div className="row-actions">
        <Button size="xs" variant="outline" onClick={() => onEdit(u)}>{canUpdate ? 'Edit' : 'View'}</Button>
        {!!u.active && canDisable && <IconButton label={`Disable ${u.name}’s account`} icon={UserX} size="icon-xs" className="icon-danger" onClick={() => onDisable(u)} />}
      </div>
    ) },
  ];
  return (
    <>
      <div className="stat-grid cols-4">
        <StatCard label="Login accounts" value={users.length} icon={UsersRound} tone="accent" caption="In this company" />
        <StatCard label="Active" value={activeCount} tone="success" caption="Can sign in" onClick={activeCount ? () => set({ status: 'ACTIVE' }) : undefined} actionLabel="Show active accounts" />
        <StatCard label="Disabled" value={users.length - activeCount} caption="Sign-in blocked · history kept" onClick={users.length - activeCount ? () => set({ status: 'DISABLED' }) : undefined} actionLabel="Show disabled accounts" />
        <StatCard label="Roles" value={d.access_roles.length} icon={ShieldCheck} caption="Permission templates" href={w.can('admin.roles') ? '#/admin/roles' : undefined} actionLabel="Open roles and permissions" />
      </div>
      <FilterBar className="mt-6"
        search={<SearchInput value={f.query} onChange={v => set({ query: v })} label="Search users" placeholder="Search name, email, role or department…" />}
        filters={<>
          <FilterSelect label="Role" value={f.role} onChange={v => set({ role: v })} options={d.access_roles.map((r: Row) => [r.id, r.name])} />
          <FilterSelect label="Status" value={f.status} onChange={v => set({ status: v })} options={[['ACTIVE', 'Active'], ['DISABLED', 'Disabled']]} />
          <FilterSelect label="Individual settings" value={f.custom} onChange={v => set({ custom: v })} options={[['yes', 'Has overrides'], ['no', 'Role only']]} />
        </>}
        chips={chips} onReset={() => setF(USER_FILTERS)} summary={<><strong>{rows.length}</strong> of {users.length} {plural(users.length, 'account')}</>} />
      <div className="card card-flush">
        <DataTable columns={columns} rows={rows} stateKey="admin-users" resetKey={JSON.stringify(f)} defaultSort={{ key: 'name', dir: 'asc' }} onRowClick={onEdit} rowLabel={u => `Open account for ${u.name}`}
          filtered={chips.length > 0} onClearFilters={() => setF(USER_FILTERS)} itemName="accounts"
          empty={<EmptyState icon={UsersRound} title="No login accounts yet" description="Create a user account to give a staff member access." />} />
      </div>
      <p className="page-footnote">Disabling an account ends its sessions and keeps its work history. Team profiles (position, department, contact details) are also managed in Task Management → Users.</p>
    </>
  );
}

function RolesTab({ w, onEdit, onDelete }: { w: Workspace; onEdit: (r?: Row, clone?: boolean) => void; onDelete: (r: Row) => void }) {
  const d = w.data;
  const canCreate = w.can('admin.roles', 'create'), canUpdate = w.can('admin.roles', 'update'), canDelete = w.can('admin.roles', 'delete'), seesUsers = w.can('admin.users');
  const total = RESOURCES.reduce((n: number, [, , actions]: any) => n + actions.length, 0);
  return (
    <>
      <div className="card-grid role-grid">
        {d.access_roles.map((r: Row) => {
          const accounts = d.access_users.filter((u: Row) => u.role_id === r.id).length;
          const granted = d.access_permissions.filter((p: Row) => p.role_id === r.id).length;
          return (
            <article key={r.id} className="role-card">
              <div className="role-card-head">
                <h2 className="role-name">{r.name}</h2>
                {r.protected ? <StatusBadge tone="info" label="Protected" /> : null}
              </div>
              <ExpandableText className="role-description" text={r.description || 'Custom role.'} lines={2} />
              <dl className="role-stats">
                <div><dt>Permissions</dt><dd><span className="num">{granted}</span><span className="muted"> of {total}</span></dd></div>
                {seesUsers && <div><dt>Accounts</dt><dd className="num">{accounts}</dd></div>}
              </dl>
              <div className="role-actions">
                <Button variant="outline" size="sm" onClick={() => onEdit(r)}>{!r.protected && canUpdate ? 'Edit permissions' : 'View permissions'}</Button>
                {canCreate && <IconButton label={`Duplicate ${r.name}`} icon={Copy} onClick={() => onEdit(r, true)} />}
                {!r.protected && canDelete && (seesUsers && accounts > 0
                  ? <span className="role-note">Assigned to {accounts} account{accounts === 1 ? '' : 's'} — reassign before deleting</span>
                  : <IconButton label={`Delete ${r.name}`} icon={Trash2} className="icon-danger" onClick={() => onDelete(r)} />)}
              </div>
            </article>
          );
        })}
      </div>
      <p className="page-footnote">View is required before any other action. Delete means archive for workspaces and disable for user accounts. The Administrator role is protected and always has every enabled function.</p>
    </>
  );
}

const HISTORY_FILTERS = { query: '', action: '', actor: '' };

function HistoryTab({ w }: { w: Workspace }) {
  const d = w.data;
  const [f, setF] = useViewState('admin:history', HISTORY_FILTERS);
  const set = (patch: Partial<typeof HISTORY_FILTERS>) => setF(v => ({ ...v, ...patch }));
  const audit: Row[] = d.access_audit;
  const actionOptions = [...new Set(audit.map(a => a.action))].sort().map(a => [a, a] as [string, string]);
  const actorOptions = [...new Set(audit.map(a => a.actor_id).filter(Boolean))].map(id => [id, w.lookup(id)] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
  const rows = audit.filter(a => (!f.query || `${a.action} ${a.target_id} ${a.detail} ${w.lookup(a.actor_id)}`.toLowerCase().includes(f.query.toLowerCase())) && (!f.action || a.action === f.action) && (!f.actor || a.actor_id === f.actor));
  const chips = buildChips([
    { key: 'query', label: 'Search', value: f.query, display: `“${f.query}”`, clear: () => set({ query: '' }) },
    { key: 'action', label: 'Action', value: f.action, clear: () => set({ action: '' }) },
    { key: 'actor', label: 'By', value: f.actor, display: w.lookup(f.actor), clear: () => set({ actor: '' }) },
  ]);
  return (
    <>
      <FilterBar
        search={<SearchInput value={f.query} onChange={v => set({ query: v })} label="Search access history" placeholder="Search action, record or details…" />}
        filters={<>
          <FilterSelect label="Action" value={f.action} onChange={v => set({ action: v })} options={actionOptions} />
          <FilterSelect label="By" value={f.actor} onChange={v => set({ actor: v })} options={actorOptions} />
        </>}
        chips={chips} onReset={() => setF(HISTORY_FILTERS)} summary={<><strong>{rows.length}</strong> of {audit.length} {plural(audit.length, 'change')} · the latest 200 are shown</>} />
      <div className="card card-flush">
        <DataTable rows={rows} stateKey="admin-history" resetKey={JSON.stringify(f)} defaultSort={{ key: 'created_at', dir: 'desc' }} filtered={chips.length > 0} onClearFilters={() => setF(HISTORY_FILTERS)} itemName="changes"
          empty={<EmptyState icon={History} title="No access changes recorded yet" description="Sign-ins and changes to accounts, roles and modules appear here." />}
          columns={[
            { key: 'created_at', header: 'When', minWidth: 150, cell: a => <DateText value={a.created_at} withTime /> },
            { key: 'actor_id', header: 'By', sortValue: a => w.lookup(a.actor_id), cell: a => a.actor_id ? <span className="person-cell"><Avatar name={w.lookup(a.actor_id)} size="sm" />{w.lookup(a.actor_id)}</span> : <Missing label="System" /> },
            { key: 'action', header: 'Action', minWidth: 170 },
            { key: 'target_id', header: 'Record', cell: a => <span className="id-text">{a.target_id}</span> },
            { key: 'detail', header: 'Details', sortable: false, minWidth: 280, wrap: true, cell: a => <ExpandableText className="audit-detail" text={a.detail} lines={2} /> },
          ]} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- role / user editor

function AdminEditor({ w, model, onClose }: { w: Workspace; model: AdminModal; onClose: () => void }) {
  const [d, setD] = useState<Row>(() => structuredClone(model.data));
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const form = useFormErrors();
  const confirm = useConfirm();
  const role = model.kind === 'role';
  const canSave = role ? !d.protected && w.can('admin.roles', d.id ? 'update' : 'create') : w.can('admin.users', d.id ? 'update' : 'create');
  const set = (k: string, v: any) => { setD(s => ({ ...s, [k]: v })); setDirty(true); form.clear(k); };
  const close = async () => {
    if (busy) return;
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', description: 'The changes you made in this form will be lost.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', tone: 'danger' }))) return;
    onClose();
  };
  const field = (k: string, label: string, type = 'text', required = false, extra: { wide?: boolean; hint?: string; autoComplete?: string } = {}) => {
    form.register({ key: k, label, required, type, value: d[k] });
    return <Field key={k} fieldKey={k} label={label} type={type} required={required} wide={extra.wide} hint={extra.hint} autoComplete={extra.autoComplete} value={d[k]} error={form.errors[k]} disabled={!canSave} onChange={v => set(k, v)} />;
  };
  const fieldFor = (message: string) => /password/i.test(message) ? 'password' : /email/i.test(message) ? 'email' : /name/i.test(message) && /already|required|enter/i.test(message) ? 'name' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if (!role && d.password && (d.password.length < 10 || d.password.length > 200)) { form.setFieldError('password', 'Use a password between 10 and 200 characters.'); return; }
    if (!role && String(d.email ?? '').trim() && !EMAIL.test(String(d.email).trim())) { form.setFieldError('email', 'Enter a valid email address.'); return; }
    setBusy(true); form.reset();
    try {
      const payload = role ? d : { ...d, username:d.name, email: String(d.email ?? '').trim(), active: Number(d.active) ? 1 : 0, ...(d.role_id === 'ROLE-ADMIN' ? { function_settings: {} } : {}) };
      await w.perform(role ? 'admin.role.save' : 'admin.user.save', payload);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save.';
      const key = fieldFor(message);
      if (key) form.setFieldError(key, message); else form.fail(message);
    } finally { setBusy(false); }
  };

  const catalog: Row[] = w.data.erp_catalog;
  const staffOptions: [string, string][] = w.data.lookups.filter((r: Row) => r.kind === 'staff' && r.active && !w.data.access_users.some((u: Row) => u.staff_id === r.id)).map((r: Row) => [r.id, `${r.name} · ${r.id}`]);
  const roleBase = Object.fromEntries(RESOURCES.map(([r]: any) => [r, w.data.access_permissions.filter((p: Row) => p.role_id === d.role_id && p.resource === r).map((p: Row) => p.action)]));
  let body: ReactNode;
  if (role) {
    body = <>
      <FormSection title="Role details">
        {field('name', 'Role name', 'text', true)}
        {field('description', 'Description', 'textarea', false, { wide: true, hint: 'Explain who this role is for.' })}
      </FormSection>
      <FormSection title="Permissions" description="Changes apply to every account with this role as soon as you save. View is added automatically when you grant another action." columns={1}>
        {canSave && (
          <div className="template-row" role="group" aria-label="Start from a template">
            <span className="template-label">Start from</span>
            <Button type="button" size="xs" variant="outline" onClick={() => set('permissions', roleDefaults('VIEWER'))}>View only</Button>
            <Button type="button" size="xs" variant="outline" onClick={() => set('permissions', roleDefaults('MEMBER'))}>Team member</Button>
            <Button type="button" size="xs" variant="outline" onClick={() => set('permissions', roleDefaults('MANAGER'))}>Manager</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => set('permissions', {})}>Clear all</Button>
          </div>
        )}
        <FunctionGroups catalog={catalog} value={d.permissions} onChange={v => set('permissions', v)} disabled={!canSave} />
      </FormSection>
    </>;
  } else {
    form.register({ key: 'role_id', label: 'Role', required: true, type: 'select', value: d.role_id });
    form.register({ key: 'password', label: d.id ? 'New password' : 'Password', required: !d.id, type: 'password', value: d.password });
    body = <>
      <FormSection title="Account">
        {!d.id && (
          <Picker label="Staff identity" wide value={d.staff_id || ''} none="Create a new staff member" options={staffOptions} disabled={!canSave}
            hint="Connect the login to an existing staff member so their CRM, task and approval history stays linked."
            onChange={v => { const p = w.data.tm_profiles.find((p: Row) => p.staff_id === v); setD(s => ({ ...s, staff_id: v, name: p?.name || (v ? w.lookup(v) : ''), email: p?.email || '', position: p?.position || '', department: p?.department || '' })); setDirty(true); }} />
        )}
        {field('name', 'Username', 'text', true, { autoComplete: 'off' })}
        {field('email', 'Contact email', 'email', false, { autoComplete: 'off', hint: 'Optional.' })}
        <Picker fieldKey="role_id" label="Role" required value={d.role_id} allowNone={false} options={w.data.access_roles.map((r: Row) => [r.id, r.name])} error={form.errors.role_id} disabled={!canSave}
          onChange={v => { set('role_id', v); if (v === 'ROLE-ADMIN') set('function_settings', {}); }} />
        <SwitchField className="field-switch" label="Account active" description={Number(d.active) ? 'This person can sign in.' : 'Sign-in is blocked. Records and history are kept.'} checked={!!Number(d.active)} disabled={!canSave} onChange={v => set('active', v ? 1 : 0)} />
      </FormSection>
      <FormSection title="Team profile" description="Shown in Task Management and on assignments.">
        {field('position', 'Position')}
        {field('department', 'Department')}
      </FormSection>
      <FormSection title={d.id ? 'Reset password' : 'Password'} columns={1}>
        <PasswordField fieldKey="password" label={d.id ? 'New password' : 'Password'} required={!d.id} value={d.password || ''} error={form.errors.password} autoComplete="new-password" disabled={!canSave}
          hint={d.id ? 'Leave blank to keep the current password. At least 10 characters.' : 'At least 10 characters. Share it with the person securely.'} onChange={v => set('password', v)} />
      </FormSection>
      <FormSection title="Individual function settings" description="Inherit uses the role. Allow or Deny overrides it for this person in this company. Denying View blocks every action for that function. Modules turned off for the company stay unavailable." columns={1}>
        {d.role_id === 'ROLE-ADMIN'
          ? <Alert tone="success" icon={ShieldCheck}>Administrator access is protected and includes every enabled function. Choose another role to customize individual permissions.</Alert>
          : <FunctionGroups user catalog={catalog} value={d.function_settings || {}} base={roleBase} onChange={v => set('function_settings', v)} disabled={!canSave} />}
      </FormSection>
      {d.id && canSave && <Alert tone="info">Saving a new role, email, password, status or function settings signs this person out of their active sessions. Their work history stays connected.</Alert>}
    </>;
  }
  const title = role ? (d.id ? (canSave ? `Edit role · ${model.data.name}` : `Role · ${model.data.name}`) : model.data.name ? `Duplicate role · ${model.data.name.replace(/ copy$/, '')}` : 'Create role')
    : d.id ? (canSave ? `Edit account · ${model.data.name}` : `Account · ${model.data.name}`) : 'Create user account';
  const description = role
    ? (d.protected ? 'The Administrator role is protected and always has full access. Duplicate it to create a custom role.' : 'Permissions apply to every account assigned this role.')
    : 'One account connects to one staff identity. Existing CRM, task and approval records keep that identity.';
  return (
    <Dialog open onOpenChange={v => { if (!v) void close(); }}>
      <DialogContent className="dialog-xl" onInteractOutside={e => e.preventDefault()} onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); void close(); } }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate autoComplete="off">
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {form.formError && <Alert tone="danger" title="This could not be saved" live>{form.formError}</Alert>}
              {!canSave && <Alert tone="neutral">You can view this {role ? 'role' : 'account'}, but your permissions don’t allow changes.</Alert>}
              {body}
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>{canSave ? 'Cancel' : 'Close'}</Button>
              {canSave && <Button type="submit" loading={busy}>{busy ? 'Saving…' : role ? (d.id ? 'Save role' : 'Create role') : d.id ? 'Save account' : 'Create account'}</Button>}
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
