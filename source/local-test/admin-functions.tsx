import { uiText, useLanguage, translatedEntries } from "./i18n";
import { useState, type FormEvent } from 'react';
import { Building2, Check, ChevronRight, Minus, Plus, Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ACTION_LABELS } from './access-catalog.mjs';
import { type Row } from './components';
import { apiFetch, openCompany } from './api-client';
import type { Workspace } from './ui';
import { Alert, Card, DataTable, Field, FormSection, PasswordField, SearchInput, StatusBadge, SwitchField, Tag, useFormErrors } from './ui-kit';

const ACTIONS = translatedEntries(ACTION_LABELS) as [string, string][];

/**
 * Permission matrix, grouped by module. Role mode uses checkboxes (View is added
 * automatically with any other action; clearing View clears the row). User mode
 * sets Inherit / Allow / Deny per action and shows the effective result.
 */
export function FunctionGroups({ catalog, value, base = {}, onChange, disabled = false, user = false }: { catalog: Row[]; value: Row; base?: Row; onChange: (v: Row) => void; disabled?: boolean; user?: boolean }) {
  useLanguage();
  const [search, setSearch] = useState(''), [expanded, setExpanded] = useState<string[]>(() => catalog.map(m => m.id));
  const setRole = (resource: string, action: string, checked: boolean) => {
    const actions: string[] = value[resource] || [];
    onChange({ ...value, [resource]: checked ? [...new Set([...actions, 'view', action])] : action === 'view' ? [] : actions.filter(a => a !== action) });
  };
  const setUser = (r: string, a: string, effect: string) => {
    const next = { ...value, [r]: { ...value[r] } };
    if (effect === 'INHERIT') delete next[r][a]; else next[r][a] = effect;
    if (!Object.keys(next[r]).length) delete next[r];
    onChange(next);
  };
  const effective = (m: Row, r: string, a: string) => r!=='admin.workspaces' && !!m.enabled
    && ((value[r]?.view || 'INHERIT') === 'DENY' ? false : (value[r]?.view === 'ALLOW' || (base[r] || []).includes('view')))
    && (value[r]?.[a] === 'DENY' ? false : value[r]?.[a] === 'ALLOW' ? true : (base[r] || []).includes(a));
  const q = search.trim().toLowerCase();
  const visible = catalog.map(m => ({ m, functions: (m.functions as Row[]).filter(f => !q || `${m.label} ${f.label}`.toLowerCase().includes(q)) })).filter(x => x.functions.length);
  return (
    <div className="perm-matrix">
      <div className="perm-tools">
        <SearchInput value={search} onChange={setSearch} label={uiText("Find a module or function")} placeholder={uiText("Find a module or function…")} className="perm-search" />
        <div className="perm-tools-actions">
          <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded(catalog.map(m => m.id))}>{uiText("Expand all")}</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded([])}>{uiText("Collapse all")}</Button>
        </div>
      </div>
      {!visible.length && <p className="perm-empty">{uiText("No module or function matches “")}{search}”.</p>}
      {visible.map(({ m: module, functions }) => {
        const total = functions.reduce((n: number, f: Row) => n + f.actions.length, 0);
        const granted = functions.reduce((n: number, f: Row) => n + f.actions.filter((a: string) => user ? effective(module, f.key, a) : (value[f.key] || []).includes(a)).length, 0);
        return (
          <details key={module.id} className="perm-group" open={!!q || expanded.includes(module.id)}
            onToggle={e => { const isOpen = e.currentTarget.open; setExpanded(old => isOpen ? [...new Set([...old, module.id])] : old.filter(id => id !== module.id)); }}>
            <summary>
              <span className="perm-group-title"><ChevronRight className="disclosure-icon" aria-hidden="true" />{module.label}</span>
              <span className="perm-group-meta">
                {!module.enabled && <StatusBadge tone="neutral" label={uiText("Module off")} />}
                <span><span className="num">{granted}</span> {uiText("of ")}<span className="num">{total}</span> {user ? 'allowed' : 'granted'}</span>
              </span>
            </summary>
            <div className="table-wrap perm-table-wrap">
              <table className="perm-table">
                <thead>
                  <tr>
                    <th scope="col" className="perm-fn">{uiText("Function")}</th>
                    {!user && <th scope="col" className="perm-all">{uiText("All")}</th>}
                    {ACTIONS.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {functions.map((f: Row) => {
                    const name = String(f.label).replace(/^[^·]+· /, '');
                    // Role values are arrays; per-user overrides are action/effect objects.
                    // Never call array methods on a saved override when reopening an account.
                    const current: string[] = !user && Array.isArray(value[f.key]) ? value[f.key] : [];
                    const all = f.actions.every((a: string) => current.includes(a)), some = current.length > 0;
                    return (
                      <tr key={f.key}>
                        <th scope="row" className="perm-fn">{name}</th>
                        {!user && (
                          <td className="perm-all">
                            <Checkbox aria-label={uiText("{p0}: every action", { p0: f.label })} disabled={disabled || !module.enabled || f.key==='admin.workspaces'} checked={all ? true : some ? 'indeterminate' : false}
                              onCheckedChange={v => onChange({ ...value, [f.key]: v === true ? [...f.actions] : [] })} />
                          </td>
                        )}
                        {ACTIONS.map(([action, label]) => (
                          <td key={action}>
                            {!f.actions.includes(action) ? <span className="perm-na" title={uiText("Not available for this function")}><span aria-hidden="true">—</span><span className="sr-only">{uiText("Not available")}</span></span>
                              : user ? (
                                <div className="override-cell">
                                  <select className="control control-sm" aria-label={uiText("{p0}: {p1}", { p0: f.label, p1: label })} disabled={disabled || !module.enabled || f.key==='admin.workspaces'} value={value[f.key]?.[action] || 'INHERIT'} onChange={e => setUser(f.key, action, e.target.value)}>
                                    <option value="INHERIT">{uiText("Inherit (")}{(base[f.key] || []).includes(action) ? 'allow' : 'deny'})</option>
                                    <option value="ALLOW">{uiText("Allow")}</option>
                                    <option value="DENY">{uiText("Deny")}</option>
                                  </select>
                                  {effective(module, f.key, action)
                                    ? <span className="perm-result is-yes"><Check aria-hidden="true" />{uiText("Allowed")}</span>
                                    : <span className="perm-result"><Minus aria-hidden="true" />{uiText("Denied")}</span>}
                                </div>
                              ) : <Checkbox aria-label={uiText("{p0}: {p1}", { p0: f.label, p1: label })} disabled={disabled || !module.enabled || f.key==='admin.workspaces'} checked={current.includes(action)} onCheckedChange={v => setRole(f.key, action, v === true)} />}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

const EMPTY_COMPANY = { name: '', admin_name: '', admin_email: '', admin_password: '', confirm: '' };

/** Company modules and company creation (Administration → Company & modules). */
export function CompanyTools({ w }: { w: Workspace }) {
  useLanguage();
  const modules: Row[] = w.data.erp_catalog || [];
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const isOn = (id: string) => (draft ? !!draft[id] : !!modules.find(m => m.id === id)?.enabled);
  const names = (ids: string[]) => ids.map(id => modules.find(m => m.id === id)?.label || id).join(', ');
  const toggle = (id: string, on: boolean) => setDraft(d => ({ ...Object.fromEntries(modules.map(m => [m.id, !!m.enabled])), ...d, [id]: on }));
  const changed = !!draft && modules.some(m => !!draft[m.id] !== !!m.enabled);
  const canUpdate = w.can('admin.modules', 'update');
  const save = async () => {
    setBusy(true); setError('');
    try { await w.perform('admin.modules.save', { modules: draft, versions: Object.fromEntries(w.data.erp_module_settings.map((m: Row) => [m.module_id, m.version])) }); setDraft(null); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const canCreate = w.data.company_context?.id === 'default' && w.data.auth.user.role_id === 'ROLE-ADMIN' && w.can('admin.companies', 'create');
  return (
    <div className="stack-6">
      {w.can('admin.modules') && (
        <Card title={<span className="card-title-icon"><Puzzle aria-hidden="true" />{uiText("Company modules")}</span>}
          description={uiText("Turn Task Controlling Management areas on or off for this company. Records and saved permissions are kept while a module is off, and come back when it is turned on again.")}
          footer={changed ? <div className="card-footer-actions"><span className="muted">{uiText("You have unsaved module changes.")}</span><Button variant="outline" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>{uiText("Cancel")}</Button><Button loading={busy} onClick={() => void save()}>{uiText("Save modules")}</Button></div> : undefined}>
          {error && <Alert tone="danger" title={uiText("Modules were not saved")} live>{error}</Alert>}
          <div className="module-list">
            {modules.map(m => {
              const on = isOn(m.id);
              const missing = (m.dependencies as string[]).filter(dep => !isOn(dep));
              const dependents = modules.filter(x => (x.dependencies as string[]).includes(m.id) && isOn(x.id)).map(x => x.id);
              const locked = m.required || (!on && missing.length > 0) || (on && dependents.length > 0);
              const note = m.required ? uiText("Required — always on")
                : !on && missing.length ? `Turn on ${names(missing)} first`
                : on && dependents.length ? `${names(dependents)} ${dependents.length === 1 ? 'depends' : 'depend'} on it`
                : m.dependencies.length ? `Requires ${names(m.dependencies)}` : uiText("Optional");
              return <SwitchField key={m.id} label={<>{m.label}{draft && !!draft[m.id] !== !!m.enabled && <Tag className="ml-2">{uiText("Changed")}</Tag>}</>} description={uiText("{p0} · {p1} function{p2}", { p0: note, p1: m.functions.length, p2: m.functions.length === 1 ? '' : 's' })} checked={on} disabled={!canUpdate || locked || busy} onChange={v => toggle(m.id, v)} />;
            })}
          </div>
          {!canUpdate && <p className="card-note">{uiText("You can view module settings. Changing them needs Update permission for Administration · Company modules.")}</p>}
        </Card>
      )}
      {w.can('admin.companies') && <CompaniesCard w={w} canCreate={canCreate} />}
    </div>
  );
}

function CompaniesCard({ w, canCreate }: { w: Workspace; canCreate: boolean }) {
  useLanguage();
  const [creating, setCreating] = useState(false), [form, setForm] = useState<Row>(EMPTY_COMPANY), [busy, setBusy] = useState(false), [created, setCreated] = useState<Row | null>(null);
  const errors = useFormErrors();
  const set = (key: string, value: string) => { setForm(d => ({ ...d, [key]: value })); errors.clear(key); };
  const field = (key: string, label: string, type = 'text', required = true) => { errors.register({ key, label, required, type, value: form[key] }); return <Field fieldKey={key} label={label} type={type} required={required} hint={required ? undefined : uiText("Optional.")} value={form[key]} error={errors.errors[key]} onChange={v => set(key, v)} autoComplete="off" />; };
  errors.register({ key: 'admin_password', label: uiText("Administrator password"), required: true, type: 'password', value: form.admin_password });
  errors.register({ key: 'confirm', label: uiText("Confirm password"), required: true, type: 'password', value: form.confirm });
  const current = w.data.company_context?.id || 'default';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!errors.validate()) return;
    if (form.admin_password.length < 10) { errors.setFieldError('admin_password', uiText("Use at least 10 characters.")); return; }
    if (form.admin_password !== form.confirm) { errors.setFieldError('confirm', uiText("The passwords do not match.")); return; }
    setBusy(true); errors.reset();
    try {
      const { confirm: _confirm, ...body } = form;
      const r = await apiFetch('/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json() as Row;
      if (!r.ok) throw new Error(d.error || uiText("The company could not be created."));
      setCreated(d.result); setForm(EMPTY_COMPANY); setCreating(false);
      void w.refresh();
    } catch (err) {
      const message = err instanceof TypeError ? uiText("The local Task Controlling Management server is not responding. Your entries are kept.") : (err as Error).message;
      if (/company name/i.test(message)) errors.setFieldError('name', message);
      else if (/password/i.test(message)) errors.setFieldError('admin_password', message);
      else if (/email/i.test(message)) errors.setFieldError('admin_email', message);
      else errors.fail(message);
    } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="card-title-icon"><Building2 aria-hidden="true" />{uiText("Companies on this computer")}</span>} flush
      description={uiText("Each company has its own records, accounts, roles and modules. Sign in separately after switching.")}
      actions={canCreate && !creating ? <Button variant="outline" onClick={() => { setCreating(true); setCreated(null); }}><Plus />{uiText("Create company")}</Button> : undefined}>
      {created && <div className="card-inset"><Alert tone="success" title={uiText("{p0} was created", { p0: created.name })} action={<Button size="sm" onClick={() => openCompany(created.id)}>{uiText("Open its sign-in")}</Button>}>{uiText("It starts with empty business records and its own Administrator account.")}</Alert></div>}
      <DataTable rows={w.data.companies || []} pageSize={0} itemName="companies" columns={[
        { key: 'name', header: uiText("Company"), cell: c => <span className="cell-title">{c.name}{c.id === current && <Tag className="ml-2">{uiText("Current")}</Tag>}</span> },
        { key: 'id', header: uiText("Company ID"), cell: c => <span className="id-text">{c.id}</span> },
        { key: 'open', header: <span className="sr-only">{uiText("Actions")}</span>, sortable: false, align: 'right', cell: c => c.id === current ? <span className="muted">{uiText("Signed in")}</span> : <Button size="xs" variant="outline" onClick={() => openCompany(c.id)}>{uiText("Open sign-in")}</Button> },
      ]} />
      {!canCreate && <p className="card-note card-inset">{uiText("New companies are created by an Administrator signed in to the original company.")}</p>}
      {creating && (
        <form className="card-inset company-form" onSubmit={submit} noValidate autoComplete="off">
          <fieldset disabled={busy}>
            {errors.formError && <Alert tone="danger" title={uiText("The company was not created")} live>{errors.formError}</Alert>}
            <FormSection title={uiText("New company")} description={uiText("The new company starts with empty business records and its own Administrator account.")}>
              {field('name', uiText("Company name"))}
              {field('admin_name', uiText("Administrator full name"))}
              {field('admin_email', uiText("Administrator email"), 'email', false)}
              <span className="form-spacer" aria-hidden="true" />
              <PasswordField fieldKey="admin_password" label={uiText("Administrator password")} required value={form.admin_password} error={errors.errors.admin_password} autoComplete="new-password" hint={uiText("At least 10 characters.")} onChange={v => set('admin_password', v)} />
              <PasswordField fieldKey="confirm" label={uiText("Confirm password")} required value={form.confirm} error={errors.errors.confirm} autoComplete="new-password" onChange={v => set('confirm', v)} />
            </FormSection>
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => { setCreating(false); errors.reset(); }}>{uiText("Cancel")}</Button>
              <Button type="submit" loading={busy}>{busy ? uiText("Creating…") : uiText("Create company")}</Button>
            </div>
          </fieldset>
        </form>
      )}
    </Card>
  );
}
