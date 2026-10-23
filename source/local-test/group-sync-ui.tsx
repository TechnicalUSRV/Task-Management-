import { uiText, useLanguage , translatedMap } from "./i18n";
// V5.5 Groups · Settings & sharing → Google Sheets: connect a group to one worksheet, choose the direction and the
// columns, check exactly what would be shared, then start, pause, sync now, resolve conflicts or disconnect.
// Tokens and secrets never reach the browser; every action is checked again on the server.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeftRight, CircleAlert, ExternalLink, Link2, Loader2, Pause, Play, RefreshCw, Sheet as SheetIcon, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { Row } from './components';
import type { Workspace } from './ui';
import { COLUMN_TYPES as EN_COLUMN_TYPES } from './group-domain.mjs';
import { groupPost, groupRead } from './group-api';
import { formatDateTime, plural } from './format';
import { Alert, ButtonLink, Card, CheckboxField, EmptyState, Field, Picker, StatusBadge, useConfirm } from './ui-kit';
const COLUMN_TYPES = translatedMap(EN_COLUMN_TYPES);

const call = async (data: Row): Promise<Row> => (await groupPost('/api/google', data)).result ?? {};
const DIRECTION_HELP: Record<string, string> = translatedMap({
  TO_SHEETS: 'The sheet is a copy of the group. Edits made in the sheet to these columns are replaced at the next sync.',
  FROM_SHEETS: 'The sheet is the source. Its values replace the group’s values in these columns; new sheet rows become group rows.',
  TWO_WAY: 'Edits on either side are copied to the other. A cell changed on both sides since the last sync is shown as a conflict for you to resolve.',
});
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { ACTIVE: 'success', PAUSED: 'neutral', ERROR: 'danger' };
export const syncLabel = (s: Row) => s.status === 'ACTIVE' ? `Google Sheets · ${s.last_success_at ? `synced ${formatDateTime(s.last_success_at)}` : 'starting'}` : s.status === 'PAUSED' ? uiText("Google Sheets · paused") : uiText("Google Sheets · stopped");

export function GoogleSheetsPanel({ w, groupId, groupName }: { w: Workspace; groupId: string; groupName: string }) {
  useLanguage();
  const [info, setInfo] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [preview, setPreview] = useState<Row | null>(null), [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const load = useCallback(async () => { try { setInfo(await call({ action: 'describe', group_id: groupId })); setError(''); } catch (e) { setError((e as Error).message); } }, [groupId]);
  useEffect(() => { void load(); }, [load]);
  // After signing in with Google in another tab, coming back here shows the connection.
  useEffect(() => { const f = () => void load(); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [load]);
  const act = async (label: string, data: Row, after?: (r: Row) => void) => {
    setBusy(label); setError('');
    try { const r = await call(data); if (r.message) toast.success(r.message); after?.(r); await load(); void w.refresh({ quiet: true }); }
    catch (e) { setError((e as Error).message); await load(); } finally { setBusy(''); }
  };
  const connect = async (existing: boolean) => {
    setBusy('connect'); setError('');
    try { const r = await groupPost('/api/google', { action: 'connect', group_id: groupId, existing }); window.open(r.url, '_blank', 'noopener'); toast.info(uiText("Finish signing in with Google in the new tab, then come back here.")); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  if (!info) return error ? <Alert tone="danger" title={uiText("Google Sheets")}>{error}</Alert> : <p className="muted small" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />{uiText("Loading…")}</p>;
  const sync: Row | null = info.sync, account: Row | null = info.account;
  return (
    <div className="gsheets stack">
      {info.simulated && <Alert tone="warning" title={uiText("Google Sheets connection required")}>{uiText("Changes are currently stored locally and are not sent to Google Sheets. Ask an administrator to connect this server to Google Sheets.")}</Alert>}
      {error && <Alert tone="danger" title={uiText("Google Sheets")} live>{error}</Alert>}
      {!info.configured ? <EmptyState compact icon={SheetIcon} title={uiText("Google Sheets isn’t set up yet")} description={uiText("An administrator adds the Google sign-in (OAuth client) in Administration → Google Sheets.")} />
        : <>
          <div className="gsheets-account">
            {account?.status === 'ACTIVE' ? <p className="small"><Link2 aria-hidden="true" className="inline-icon" />{uiText("Your Google account: ")}<strong>{account.email || 'connected'}</strong>{account.existing ? uiText(" · can use existing spreadsheets") : uiText(" · spreadsheets created by Task Controlling Management")}</p>
              : <p className="small">{account ? <>{uiText("Google access stopped: ")}{account.status_detail || uiText("connect again.")}</> : <>{uiText("Connect your Google account. Task Controlling Management only gets access to the spreadsheets it creates")}{info.allow_existing ? uiText(", or that you choose,") : ''} {uiText("— not your other files.")}</>}</p>}
            <div className="row">
              {account?.status !== 'ACTIVE' && <Button size="sm" onClick={() => void connect(false)} loading={busy === 'connect'}><Link2 />{uiText("Connect Google")}</Button>}
              {account?.status === 'ACTIVE' && info.allow_existing && !account.existing && !sync && <Button size="sm" variant="outline" onClick={() => void connect(true)} loading={busy === 'connect'}>{uiText("Allow existing spreadsheets")}</Button>}
              {account && <Button size="sm" variant="ghost" disabled={!!busy} onClick={async () => { if (await confirm({ title: uiText("Disconnect your Google account?"), description: uiText("Task Controlling Management’s access is revoked. Syncs you set up stop until someone connects Google again."), confirmLabel: uiText("Disconnect Google"), tone: 'danger' })) void act('account', { action: 'disconnect_account' }); }}><Unplug />{uiText("Disconnect Google")}</Button>}
            </div>
          </div>
          {sync ? (editing ? <SyncForm info={info} groupId={groupId} groupName={groupName} busy={busy} existing={sync} onCancel={() => setEditing(false)}
            onSubmit={data => act('settings', { action: 'settings', id: sync.id, ...data }, () => setEditing(false))} />
            : <SyncStatus sync={sync} busy={busy} preview={preview} onEdit={() => setEditing(true)}
              onSyncNow={() => void act('sync', { action: 'sync_now', id: sync.id })}
              onPause={() => void act('pause', { action: 'pause', id: sync.id })}
              onResume={() => void act('resume', { action: 'resume', id: sync.id }, () => setPreview(null))}
              onPreview={() => void act('preview', { action: 'preview', id: sync.id }, r => setPreview(r))}
              onResolve={(conflict, keep) => void act('resolve', { action: 'resolve', id: sync.id, conflict_id: conflict, keep })}
              onDisconnect={async () => { if (await confirm({ title: uiText("Disconnect this spreadsheet?"), description: uiText("Syncing stops. The spreadsheet and the group both keep their data."), confirmLabel: uiText("Disconnect"), tone: 'danger' })) void act('disconnect', { action: 'disconnect', id: sync.id }, () => setPreview(null)); }} />)
            : account?.status === 'ACTIVE' ? <SyncForm info={info} groupId={groupId} groupName={groupName} busy={busy} existing={null} onSubmit={data => act('setup', { action: 'setup', group_id: groupId, ...data }, r => setPreview(r.preview || null))} /> : null}
        </>}
    </div>
  );
}

function SyncStatus({ sync, busy, preview, onEdit, onSyncNow, onPause, onResume, onPreview, onResolve, onDisconnect }: {
  sync: Row; busy: string; preview: Row | null; onEdit: () => void; onSyncNow: () => void; onPause: () => void; onResume: () => void; onPreview: () => void; onResolve: (id: number, keep: 'GROUP' | 'SHEET') => void; onDisconnect: () => void;
}) {
  useLanguage();
  return (
    <div className="stack">
      <div className="gsheets-status">
        <div className="cell-stack">
          <span className="cell-title"><SheetIcon aria-hidden="true" className="inline-icon" />{sync.spreadsheet_name} · {sync.sheet_title}</span>
          <small>{({ TO_SHEETS: 'Group → Google Sheets', FROM_SHEETS: 'Google Sheets → Group', TWO_WAY: 'Both ways' } as Row)[sync.direction]} {uiText("· set up by ")}{sync.connected_by}{sync.connected_by_me ? uiText(" (you)") : ''} {uiText("· checks every ")}{sync.interval_s} s{sync.push ? uiText(" and on Google change notifications") : ''}</small>
        </div>
        <StatusBadge value={sync.status} label={sync.status === 'ACTIVE' ? uiText("Syncing") : sync.status === 'PAUSED' ? uiText("Paused") : uiText("Stopped")} tone={STATUS_TONE[sync.status]} />
      </div>
      {sync.status_detail && <Alert tone={sync.status === 'ERROR' ? 'danger' : 'neutral'}>{sync.status_detail}</Alert>}
      <dl className="gsheets-facts">
        <div><dt>{uiText("Last successful sync")}</dt><dd>{sync.last_success_at ? formatDateTime(sync.last_success_at) : uiText("Not yet")}</dd></div>
        <div><dt>{uiText("Last run")}</dt><dd>{sync.last_run_at ? uiText("{p0}{p1}", { p0: formatDateTime(sync.last_run_at), p1: sync.last_duration_ms != null ? ` · ${(sync.last_duration_ms / 1000).toFixed(1)} s` : '' }) : '—'}</dd></div>
        <div><dt>{uiText("Next check")}</dt><dd>{sync.status === 'ACTIVE' && sync.next_run_at ? formatDateTime(sync.next_run_at) : '—'}</dd></div>
        <div><dt>{uiText("Shared with the sheet")}</dt><dd>{sync.shared_rows.toLocaleString('en-US')} {plural(sync.shared_rows, 'row')} · {sync.shared_columns} {plural(sync.shared_columns, 'column')}{sync.include_restricted ? uiText(" · includes rows and columns with access rules") : sync.excluded_rows || sync.excluded_columns ? uiText(" · not shared: {p0} restricted {p1}, {p2} restricted {p3}", { p0: sync.excluded_rows, p1: plural(sync.excluded_rows, 'row'), p2: sync.excluded_columns, p3: plural(sync.excluded_columns, 'column') }) : ''}</dd></div>
        <div><dt>{uiText("Deleted rows")}</dt><dd>{sync.delete_mode === 'PROPAGATE' ? uiText("Deleting a row on one side deletes it on the other") : uiText("Never deleted on the other side")}</dd></div>
      </dl>
      <div className="row gsheets-actions">
        <ButtonLink size="sm" href={sync.url} target="_blank" rel="noopener noreferrer"><ExternalLink />{uiText("Open the sheet")}<span className="sr-only"> {uiText("(opens in a new tab)")}</span></ButtonLink>
        {sync.status !== 'PAUSED' && <Button size="sm" variant="outline" onClick={onSyncNow} loading={busy === 'sync'} disabled={!!busy}><RefreshCw />{uiText("Sync now")}</Button>}
        {sync.status === 'PAUSED' || sync.status === 'ERROR' ? <Button size="sm" onClick={onResume} loading={busy === 'resume'} disabled={!!busy}><Play />{sync.last_success_at ? uiText("Resume") : uiText("Start sync")}</Button>
          : <Button size="sm" variant="outline" onClick={onPause} loading={busy === 'pause'} disabled={!!busy}><Pause />{uiText("Pause")}</Button>}
        <Button size="sm" variant="ghost" onClick={onPreview} loading={busy === 'preview'} disabled={!!busy}>{uiText("Preview")}</Button>
        <Button size="sm" variant="ghost" onClick={onEdit} disabled={!!busy}>{uiText("Change settings")}</Button>
        <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={!!busy}><Unplug />{uiText("Disconnect")}</Button>
      </div>
      {preview && <SyncPreview preview={preview} />}
      {sync.conflicts.length > 0 && <section aria-label={uiText("Conflicts")} className="stack-sm">
        <h4 className="text-section"><CircleAlert aria-hidden="true" className="inline-icon text-danger" />{sync.conflicts.length} {plural(sync.conflicts.length, 'conflict')} {uiText("to resolve")}</h4>
        <ul className="conflict-list">{sync.conflicts.map((k: Row) => <li key={k.id}>
          <p className="small"><span className="id-text">{k.row_id}</span> · <strong>{k.column || uiText("a column")}</strong> · {k.reason}</p>
          <div className="conflict-values"><span><small className="muted">{uiText("Group")}</small>{k.erp_text || <em className="muted">empty</em>}</span><ArrowLeftRight aria-hidden="true" /><span><small className="muted">{uiText("Sheet")}</small>{k.sheet_text || <em className="muted">empty</em>}</span></div>
          <div className="row"><Button size="xs" variant="outline" onClick={() => onResolve(k.id, 'GROUP')} disabled={!!busy}>{uiText("Keep the group’s value")}</Button><Button size="xs" variant="outline" onClick={() => onResolve(k.id, 'SHEET')} disabled={!!busy}>{uiText("Keep the sheet’s value")}</Button></div>
        </li>)}</ul>
      </section>}
      {sync.runs.length > 0 && <details className="disclosure"><summary>{uiText("Recent runs")}<span className="summary-meta">{sync.runs.length}</span></summary>
        <div className="disclosure-body table-wrap" role="region" aria-label={uiText("Recent runs")} tabIndex={0}><table className="data-table dense"><thead><tr><th scope="col">{uiText("Started")}</th><th scope="col">{uiText("Why")}</th><th scope="col">{uiText("Result")}</th><th scope="col" className="align-right">{uiText("To sheet")}</th><th scope="col" className="align-right">{uiText("From sheet")}</th><th scope="col" className="align-right">{uiText("Conflicts")}</th><th scope="col" className="align-right">{uiText("Time")}</th></tr></thead>
          <tbody>{sync.runs.map((r: Row, i: number) => <tr key={i}><td className="nowrap">{formatDateTime(r.started_at)}</td><td>{r.trigger}</td><td title={r.detail || undefined}>{r.outcome}{r.detail ? <small className="muted"> · {String(r.detail).slice(0, 80)}</small> : null}</td><td className="align-right num">{r.to_sheet}</td><td className="align-right num">{r.from_sheet + (r.created || 0)}</td><td className="align-right num">{r.conflicts}</td><td className="align-right num">{r.duration_ms != null ? uiText("{p0} s", { p0: (r.duration_ms / 1000).toFixed(1) }) : ''}</td></tr>)}</tbody></table></div>
      </details>}
    </div>
  );
}

export function SyncPreview({ preview }: { preview: Row }) {
  useLanguage();
  if (preview.issues?.length) return <Alert tone="danger" title={uiText("The sheet needs attention before syncing")}><ul className="bullet-list">{preview.issues.map((x: string) => <li key={x}>{x}</li>)}</ul></Alert>;
  const s = preview.summary || {};
  return (
    <div className="gsheets-preview">
      <p className="text-label">{uiText("What the next sync would do")}</p>
      <ul className="gsheets-preview-list">
        <li><strong className="num">{s.to_sheet ?? 0}</strong> {uiText("cell or row ")}{plural(s.to_sheet ?? 0, 'write')} {uiText("to the sheet")}{s.new_in_sheet ? uiText(" ({p0} new {p1})", { p0: s.new_in_sheet, p1: plural(s.new_in_sheet, 'row') }) : ''}</li>
        <li><strong className="num">{s.from_sheet ?? 0}</strong> {plural(s.from_sheet ?? 0, 'value')} {uiText("copied into the group")}{s.new_in_group ? uiText(", {p0} new {p1}", { p0: s.new_in_group, p1: plural(s.new_in_group, 'row') }) : ''}</li>
        {(s.deleted_in_sheet || s.deleted_in_group) ? <li><strong className="num">{(s.deleted_in_sheet || 0) + (s.deleted_in_group || 0)}</strong> {plural((s.deleted_in_sheet || 0) + (s.deleted_in_group || 0), 'row')} deleted</li> : null}
        {s.conflicts ? <li className="text-danger"><strong className="num">{s.conflicts}</strong> {plural(s.conflicts, 'conflict')} {uiText("to resolve")}</li> : null}
        {(s.excluded_rows || s.excluded_columns) ? <li>{uiText("Not shared: ")}{s.excluded_rows || 0} {uiText("restricted ")}{plural(s.excluded_rows || 0, 'row')} {uiText("and ")}{s.excluded_columns || 0} {uiText("restricted ")}{plural(s.excluded_columns || 0, 'column')}</li> : null}
      </ul>
      {preview.warnings?.length > 0 && <Alert tone="warning" title={uiText("Warnings")}><ul className="bullet-list">{preview.warnings.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></Alert>}
    </div>
  );
}

function SyncForm({ info, groupId, groupName, busy, existing, onSubmit, onCancel }: { info: Row; groupId: string; groupName: string; busy: string; existing: Row | null; onSubmit: (data: Row) => Promise<void> | void; onCancel?: () => void }) {
  useLanguage();
  const cols: Row[] = info.columns, mapped = new Map<string, Row>((existing?.mapping || []).map((m: Row) => [m.column_id, m]));
  const [d, setD] = useState<Row>(() => ({
    mode: 'new', title: groupName, url: '', sheet_id: '', direction: existing?.direction || 'TO_SHEETS',
    columns: existing ? cols.filter(c => mapped.has(c.id)).map(c => ({ column_id: c.id, from_sheet: mapped.get(c.id)!.from_sheet !== false })) : cols.filter(c => c.syncable && !c.restricted).map(c => ({ column_id: c.id, from_sheet: true })),
    delete_mode: existing?.delete_mode || 'KEEP', confirm_delete: false, include_restricted: !!existing?.include_restricted, confirm_restricted: false, interval_s: String(existing?.interval_s || info.default_interval || 60),
  }));
  const [sheets, setSheets] = useState<Row | null>(null), [finding, setFinding] = useState(false), [error, setError] = useState('');
  const set = (patch: Row) => { setD(s => ({ ...s, ...patch })); setError(''); };
  const has = (id: string) => d.columns.some((m: Row) => m.column_id === id);
  const toggle = (id: string, on: boolean) => set({ columns: on ? [...d.columns, { column_id: id, from_sheet: true }] : d.columns.filter((m: Row) => m.column_id !== id) });
  const find = async () => {
    setFinding(true); setError('');
    try { const r = await call({ action: 'sheets', group_id: groupId, url: d.url }); setSheets(r); set({ sheet_id: String(r.selected ?? r.sheets[0]?.id ?? '') }); } catch (e) { setError((e as Error).message); } finally { setFinding(false); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.columns.length) { setError(uiText("Choose at least one column.")); return; }
    if (d.delete_mode === 'PROPAGATE' && existing?.delete_mode !== 'PROPAGATE' && !d.confirm_delete) { setError(uiText("Confirm that deletions are copied to the other side, or keep deleted rows.")); return; }
    if (d.include_restricted && !existing?.include_restricted && !d.confirm_restricted) { setError(uiText("Confirm that rows and columns with access rules are shared with everyone who can open the spreadsheet.")); return; }
    const body: Row = { direction: d.direction, columns: d.columns, delete_mode: d.delete_mode, confirm_delete: d.confirm_delete, include_restricted: d.include_restricted, confirm_restricted: d.confirm_restricted, interval_s: Number(d.interval_s) };
    if (!existing) Object.assign(body, d.mode === 'existing' ? { mode: 'existing', url: d.url, sheet_id: d.sheet_id === '' ? undefined : Number(d.sheet_id) } : { mode: 'new', title: d.title });
    await onSubmit(body);
  };
  const canExisting = info.allow_existing && info.account?.existing;
  return (
    <form className="stack gsheets-form" onSubmit={submit} noValidate>
      <h4 className="text-section">{existing ? uiText("Sync settings") : uiText("Connect a spreadsheet")}</h4>
      {error && <Alert tone="danger" title={uiText("Check this")} live>{error}</Alert>}
      {!existing && <fieldset className="choice-cards is-two"><legend className="field-label">{uiText("Spreadsheet")}</legend>
        <label className={`choice-card${d.mode === 'new' ? " is-checked" : ''}`}><input type="radio" name="gs-mode" checked={d.mode === 'new'} onChange={() => set({ mode: 'new' })} /><span className="cell-stack"><span className="cell-title">{uiText("Create a new spreadsheet")}</span><small>{uiText("In your Google Drive, shared with nobody else until you share it.")}</small></span></label>
        <label className={`choice-card${d.mode === 'existing' ? " is-checked" : ''}`}><input type="radio" name="gs-mode" disabled={!canExisting} checked={d.mode === 'existing'} onChange={() => set({ mode: 'existing' })} /><span className="cell-stack"><span className="cell-title">{uiText("Use an existing spreadsheet")}</span><small>{canExisting ? uiText("Paste its address, then choose the worksheet.") : info.allow_existing ? uiText("Choose “Allow existing spreadsheets” above first.") : uiText("Turned off by your administrator.")}</small></span></label>
      </fieldset>}
      {!existing && d.mode === 'new' && <Field label={uiText("Spreadsheet name")} value={d.title} onChange={v => set({ title: v })} required />}
      {!existing && d.mode === 'existing' && <div className="gsheets-find">
        <Field label={uiText("Spreadsheet address")} value={d.url} onChange={v => { set({ url: v }); setSheets(null); }} placeholder={uiText("https://docs.google.com/spreadsheets/d/…")} />
        <Button type="button" size="sm" variant="outline" onClick={() => void find()} loading={finding} disabled={!d.url.trim()}>{uiText("Find worksheets")}</Button>
        {sheets && <Picker label={uiText("Worksheet in “{p0}”", { p0: sheets.name })} value={String(d.sheet_id)} allowNone={false} options={sheets.sheets.map((x: Row) => [String(x.id), x.title])} onChange={v => set({ sheet_id: v })} />}
      </div>}
      <fieldset className="choice-cards"><legend className="field-label">{uiText("Direction")}</legend>
        {(['TO_SHEETS', 'FROM_SHEETS', 'TWO_WAY'] as const).map(k => <label key={k} className={`choice-card${d.direction === k ? " is-checked" : ''}`}><input type="radio" name="gs-dir" checked={d.direction === k} onChange={() => set({ direction: k })} /><span className="cell-stack"><span className="cell-title">{info.directions[k]}</span><small>{DIRECTION_HELP[k]}</small></span></label>)}
      </fieldset>
      {d.direction !== 'TO_SHEETS' && <Alert tone="warning" title={uiText("Anyone who can edit the spreadsheet can change this group")}>{uiText("Through this connection, people who can edit the sheet change the columns marked “from the sheet” below, in your name as the person who set it up (recorded as “Google Sheets sync”). Share the spreadsheet only with people who may edit the group.")}</Alert>}
      <fieldset className="gsheets-cols"><legend className="field-label">{uiText("Columns")}</legend>
        {cols.map(c => <div key={c.id} className="gsheets-col">
          <CheckboxField label={<>{c.name} <span className="muted">· {COLUMN_TYPES[c.type as keyof typeof COLUMN_TYPES]}</span></>} checked={has(c.id)} disabled={!c.syncable} onChange={v => toggle(c.id, v)} description={!c.syncable ? uiText("Can’t be synced.") : c.restricted && !d.include_restricted ? uiText("Has access rules (or uses a column that has): left out unless you include restricted data below.") : c.type === 'FORMULA' ? uiText("Its result goes to the sheet; the formula stays in the group.") : undefined} />
          {d.direction !== 'TO_SHEETS' && has(c.id) && c.from_sheet && <CheckboxField label={uiText("Editable from the sheet")} checked={d.columns.find((m: Row) => m.column_id === c.id)?.from_sheet !== false} onChange={v => set({ columns: d.columns.map((m: Row) => m.column_id === c.id ? { ...m, from_sheet: v } : m) })} />}
        </div>)}
      </fieldset>
      <fieldset className="stack-sm"><legend className="field-label">{uiText("Rows and columns with access rules")}</legend>
        <CheckboxField label={uiText("Also share rows and columns that have access rules")} checked={d.include_restricted} onChange={v => set({ include_restricted: v, confirm_restricted: false })} description={uiText("Off (recommended): they are left out of the sheet. Google sharing can’t repeat the group’s access rules.")} />
        {d.include_restricted && !existing?.include_restricted && <CheckboxField label={uiText("I understand that everyone who can open the spreadsheet will see them")} checked={d.confirm_restricted} onChange={v => set({ confirm_restricted: v })} />}
      </fieldset>
      <fieldset className="stack-sm"><legend className="field-label">{uiText("Deleted rows")}</legend>
        <Picker label={uiText("When a row is deleted on one side")} value={d.delete_mode} allowNone={false} options={[['KEEP', uiText("Keep it on the other side (safe)")], ['PROPAGATE', uiText("Delete it on the other side too")]]} onChange={v => set({ delete_mode: v, confirm_delete: false })} />
        {d.delete_mode === 'PROPAGATE' && existing?.delete_mode !== 'PROPAGATE' && <CheckboxField label={uiText("I understand that deleting a row in the sheet deletes it from the group (and the other way)")} checked={d.confirm_delete} onChange={v => set({ confirm_delete: v })} />}
      </fieldset>
      <Field label={uiText("Check for changes every (seconds)")} type="number" min={info.default_interval || 15} max={3600} value={d.interval_s} onChange={v => set({ interval_s: v })} hint={uiText("Target: {p0} s or less for ordinary sheets. A target, not a guarantee: Google limits how often a sheet can be read.", { p0: info.default_interval || 60 })} />
      <div className="row">
        <Button type="submit" loading={busy === 'setup' || busy === 'settings'} disabled={!!busy || (!existing && d.mode === 'existing' && !sheets)}>{existing ? uiText("Save settings") : uiText("Connect and preview")}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>{uiText("Cancel")}</Button>}
      </div>
      {!existing && <p className="muted small">{uiText("Nothing is synced yet: you see a preview first, then start the sync.")}</p>}
    </form>
  );
}

// ================================================================ Administration → Google Sheets
/** The company's Google OAuth client (the secret is kept encrypted on the server and never shown again), how often
 *  syncs check for changes, and every group connected to a spreadsheet. */
export function GoogleSheetsAdmin({ w }: { w: Workspace }) {
  useLanguage();
  const [cfg, setCfg] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [d, setD] = useState<Row>({ client_id: '', client_secret: '', allow_existing: false, interval_s: '60', push: false });
  const canEdit = w.can('admin.integrations', 'update');
  const load = useCallback(async () => {
    try { const c = await groupRead('/api/google/config'); setCfg(c); setD({ client_id: c.client_id || '', client_secret: '', allow_existing: !!c.allow_existing, interval_s: String(c.interval_s || 60), push: !!c.push }); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await w.perform('admin.integrations.save', { client_id: d.client_id, client_secret: d.client_secret || undefined, allow_existing: d.allow_existing, interval_s: Number(d.interval_s), push: d.push, expected_version: cfg?.version }); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (!cfg) return error ? <Alert tone="danger" title={uiText("Google Sheets")}>{error}</Alert> : <p className="muted small" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />{uiText("Loading…")}</p>;
  const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => toast.success(uiText("Copied"))).catch(() => toast.error(uiText("Copy failed. Select the text and copy it.")));
  return (
    <div className="stack">
      {cfg.simulated ? <Alert tone="warning" title={uiText("Google Sheets connection required")}>{uiText("This connection does not send changes to Google Sheets. Connect this server to Google before using spreadsheet synchronization.")}</Alert>
        : !cfg.client_id || !cfg.secret_set ? <Alert tone="info" title={uiText("Not set up yet")}>{uiText("Groups can be connected to Google Sheets once the Google sign-in below is added.")}</Alert> : null}
      {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
      <div className="grid-2">
        <Card title={uiText("Google sign-in (OAuth client)")} description={uiText("The company’s own Google Cloud OAuth client.")}>
          <form className="stack" onSubmit={save} noValidate>
            <fieldset disabled={!canEdit || busy} className="stack">
              <Field label={uiText("Client ID")} value={d.client_id} onChange={v => setD(s => ({ ...s, client_id: v }))} placeholder="1234-abc.apps.googleusercontent.com" />
              <Field label={uiText("Client secret")} type="password" value={d.client_secret} onChange={v => setD(s => ({ ...s, client_secret: v }))} placeholder={cfg.secret_set ? uiText("Saved · leave empty to keep it") : uiText("Paste the client secret")} hint={uiText("Stored encrypted on this server; never shown again.")} />
              <CheckboxField label={uiText("Allow connecting existing spreadsheets")} checked={d.allow_existing} onChange={v => setD(s => ({ ...s, allow_existing: v }))} description={uiText("Off: Task Controlling Management only uses spreadsheets it creates (the narrowest Google permission). On: people may also grant access to their spreadsheets.")} />
              <Field label={uiText("Check for changes every (seconds)")} type="number" min={15} max={3600} value={d.interval_s} onChange={v => setD(s => ({ ...s, interval_s: v }))} hint={uiText("The shortest interval any group may use. 30–60 s suits ordinary sheets; Google limits reads per minute.")} />
              <CheckboxField label={uiText("Use Google change notifications")} checked={d.push} onChange={v => setD(s => ({ ...s, push: v }))} description={uiText("Needs a public https address for this Task Controlling Management (ERP_PUBLIC_URL). Checks on the schedule continue either way.")} />
              {canEdit && <div className="row"><Button type="submit" loading={busy}>{uiText("Save")}</Button></div>}
            </fieldset>
          </form>
        </Card>
        <Card title={uiText("Set up in Google Cloud")} description={uiText("About fifteen minutes, once per company.")} bodyClassName="stack">
          <ol className="steps-list small">
            <li>{uiText("In Google Cloud console, create (or choose) a project and enable the ")}<strong>{uiText("Google Sheets API")}</strong> {uiText("and ")}<strong>{uiText("Google Drive API")}</strong>.</li>
            <li>{uiText("Configure the OAuth consent screen (Internal for a Google Workspace company) with the scopes ")}<code>drive.file</code>{d.allow_existing ? <> {uiText("and ")}<code>spreadsheets</code></> : null}.</li>
            <li>{uiText("Create an ")}<strong>{uiText("OAuth client ID")}</strong> {uiText("of type Web application, with this authorized redirect URI:")}</li>
          </ol>
          <div className="copy-row"><code className="mono small">{cfg.redirect_uri}</code><Button size="xs" variant="outline" onClick={() => copy(cfg.redirect_uri)}>{uiText("Copy")}</Button></div>
          <p className="muted small">{uiText("Each address people use to open the Task Controlling Management (for example a shared https address) needs its own redirect URI in the same OAuth client.")}</p>
          <ol className="steps-list small" start={4}><li>{uiText("Paste the client ID and secret here, then open a group → Settings & sharing → Google Sheets.")}</li></ol>
        </Card>
      </div>
      <Card title={uiText("Connected groups")} flush>
        {cfg.connections.length ? <div className="table-wrap" role="region" aria-label={uiText("Connected groups")} tabIndex={0}><table className="data-table dense"><thead><tr><th scope="col">{uiText("Group")}</th><th scope="col">{uiText("Spreadsheet")}</th><th scope="col">{uiText("Direction")}</th><th scope="col">{uiText("Status")}</th><th scope="col">{uiText("Last successful sync")}</th><th scope="col">{uiText("Set up by")}</th></tr></thead>
          <tbody>{cfg.connections.map((c: Row) => <tr key={c.id}><td>{c.group_name}</td><td>{c.spreadsheet_name}</td><td>{({ TO_SHEETS: 'Group → Sheets', FROM_SHEETS: 'Sheets → Group', TWO_WAY: 'Both ways' } as Row)[c.direction]}</td><td><StatusBadge value={c.status} label={c.status === 'ACTIVE' ? uiText("Syncing") : c.status === 'PAUSED' ? uiText("Paused") : uiText("Stopped")} tone={STATUS_TONE[c.status]} /></td><td className="nowrap">{c.last_success_at ? formatDateTime(c.last_success_at) : '—'}</td><td>{c.connected_by}</td></tr>)}</tbody></table></div>
          : <div className="card-inset"><EmptyState compact icon={SheetIcon} title={uiText("No group is connected yet")} /></div>}
      </Card>
    </div>
  );
}
