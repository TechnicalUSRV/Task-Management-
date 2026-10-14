// V5.5 Groups: notes on a row (a side panel), access rules for rows and columns, and the Excel export.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Download, FileSpreadsheet, History, Loader2, Lock, MessageSquareText, Pencil, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { apiPath } from './api-client';
import type { Row } from './components';
import type { Workspace } from './ui';
import { GROUP_LIMITS } from './group-domain.mjs';
import { groupCommand, groupRead } from './group-api';
import { displayZone, formatDateTime, plural, zoneName } from './format';
import { Alert, Avatar, CheckboxField, EmptyState, ErrorState, Field, PeoplePicker, Segmented, useConfirm } from './ui-kit';

// ================================================================ notes on a row
/** Notes, remarks and progress updates on one row, newest first by default, with a date range in the reader's time zone.
 *  Notes are never replaced: editing keeps the earlier text and deleting keeps a record, both in the note's history. */
export function NotesDrawer({ w, groupId, row, title, onClose, onChanged }: { w: Workspace; groupId: string; row: Row; title: string; onClose: () => void; onChanged: () => void }) {
  const [f, setF] = useState({ order: 'newest', from: '', to: '', offset: 0 });
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string; version: number } | null>(null);
  const [history, setHistory] = useState<{ id: string; items: Row[] | null } | null>(null);
  const confirm = useConfirm(), inputId = useId();
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await groupRead('/api/tasks/group/notes', { id: groupId, row: row.id, order: f.order, from: f.from, to: f.to, offset: f.offset, limit: 20 })); setError(''); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [groupId, row.id, f.order, f.from, f.to, f.offset]);
  useEffect(() => { void load(); }, [load]);
  const set = (patch: Partial<typeof f>) => setF(s => ({ ...s, offset: 0, ...patch }));
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) { setFormError('Write the note first.'); return; }
    setBusy(true); setFormError('');
    try { await groupCommand('tm.group.note.add', { group_id: groupId, row_id: row.id, body: text }); setText(''); setF(s => ({ ...s, offset: 0, order: 'newest' })); await load(); onChanged(); }
    catch (err) { setFormError((err as Error).message); } finally { setBusy(false); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try { const r = await groupCommand('tm.group.note.edit', { group_id: groupId, id: editing.id, expected_version: editing.version, body: editing.body }); toast.success(r.message || 'Saved'); setEditing(null); await load(); }
    catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async (n: Row) => {
    if (!(await confirm({ title: 'Delete this note?', description: 'It disappears from the list; the row’s history keeps a record of it.', confirmLabel: 'Delete note', tone: 'danger' }))) return;
    try { await groupCommand('tm.group.note.delete', { group_id: groupId, id: n.id, expected_version: n.version }); await load(); onChanged(); }
    catch (err) { toast.error((err as Error).message); }
  };
  const showHistory = async (n: Row) => {
    if (history?.id === n.id) { setHistory(null); return; }
    setHistory({ id: n.id, items: null });
    try { const r = await groupRead('/api/tasks/group/note-history', { id: groupId, note: n.id }); setHistory({ id: n.id, items: r.history }); }
    catch (err) { toast.error((err as Error).message); setHistory(null); }
  };
  const total = data?.total || 0, notes: Row[] = data?.notes || [];
  return (
    <Sheet open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <SheetContent side="right" className="notes-drawer">
        <SheetHeader className="notes-head">
          <SheetTitle className="notes-title"><MessageSquareText aria-hidden="true" />Notes</SheetTitle>
          <SheetDescription className="notes-row">{title}</SheetDescription>
        </SheetHeader>
        <div className="notes-body">
          {data?.can_add && <form className="notes-add" onSubmit={add} noValidate>
            <label className="sr-only" htmlFor={inputId}>New note</label>
            <Textarea id={inputId} rows={3} value={text} maxLength={GROUP_LIMITS.note} placeholder="Add a note, remark or progress update…" onChange={e => { setText(e.target.value); setFormError(''); }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void add(e as unknown as FormEvent); } }} />
            {formError && <p className="field-error" role="alert">{formError}</p>}
            <div className="notes-add-foot"><span className="muted text-xs">Ctrl+Enter adds · {text.length.toLocaleString('en-US')}/{GROUP_LIMITS.note.toLocaleString('en-US')}</span><Button type="submit" size="sm" loading={busy} disabled={!text.trim()}>Add note</Button></div>
          </form>}
          <div className="notes-filters" role="group" aria-label="Show notes">
            <Segmented label="Order" size="sm" value={f.order} onChange={v => set({ order: v })} options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }]} />
            <Field label="From" type="date" value={f.from} onChange={v => set({ from: v })} className="notes-date" />
            <Field label="To" type="date" value={f.to} onChange={v => set({ to: v })} className="notes-date" />
            {(f.from || f.to) && <Button size="xs" variant="ghost" onClick={() => set({ from: '', to: '' })}>Clear dates</Button>}
          </div>
          <p className="muted text-xs">Dates and times in {zoneName(data?.zone || displayZone())}.</p>
          {error ? <ErrorState message={error} onRetry={() => void load()} />
            : loading && !data ? <p className="muted small" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />Loading notes…</p>
              : !notes.length ? <EmptyState compact icon={MessageSquareText} title={f.from || f.to ? 'No notes in these dates' : 'No notes yet'} description={data?.can_add ? undefined : 'Adding notes needs “Can edit records” access.'} />
                : <ol className="notes-list" aria-busy={loading}>
                  {notes.map(n => (
                    <li key={n.id} className={`note${n.deleted_at ? ' is-deleted' : ''}`}>
                      <div className="note-head">
                        <Avatar name={n.author} size="sm" />
                        <span className="note-author">{n.author}{n.author_id === w.actor && <span className="muted"> (you)</span>}</span>
                        <time className="note-time" dateTime={n.created_at}>{formatDateTime(n.created_at)}</time>
                      </div>
                      {n.deleted_at ? <p className="note-deleted">Deleted by {n.deleted_by} · {formatDateTime(n.deleted_at)}</p>
                        : editing && editing.id === n.id ? <div className="note-edit">
                          <Textarea rows={4} value={editing.body} maxLength={GROUP_LIMITS.note} aria-label="Edit the note" onChange={e => { const body = e.target.value; setEditing(x => x && { ...x, body }); }} autoFocus />
                          <div className="row"><Button size="xs" onClick={() => void saveEdit()} loading={busy}>Save</Button><Button size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                        </div>
                          : <p className="note-text">{n.body}</p>}
                      <div className="note-foot">
                        {n.edited_at && !n.deleted_at && <span className="muted text-xs">Edited {formatDateTime(n.edited_at)}</span>}
                        {n.can_edit && editing?.id !== n.id && <Button size="xs" variant="ghost" onClick={() => setEditing({ id: n.id, body: n.body, version: n.version })}><Pencil />Edit</Button>}
                        {n.can_delete && <Button size="xs" variant="ghost" onClick={() => void remove(n)}><Trash2 />Delete</Button>}
                        {n.can_history && <Button size="xs" variant="ghost" aria-expanded={history?.id === n.id} onClick={() => void showHistory(n)}><History />History ({n.revisions})</Button>}
                      </div>
                      {history && history.id === n.id && <div className="note-history">{!history.items ? <p className="muted small">Loading…</p> : <ol>{history.items.map((h, i) => <li key={i}><p className="text-xs muted">{h.action === 'DELETE' ? 'Deleted' : 'Earlier text'} · {h.actor} · {formatDateTime(h.created_at)}</p><p className="note-text">{h.body}</p></li>)}</ol>}</div>}
                    </li>
                  ))}
                </ol>}
          {total > (data?.limit || 20) && <nav className="notes-pager" aria-label="Note pages">
            <Button size="xs" variant="outline" disabled={f.offset === 0} onClick={() => setF(s => ({ ...s, offset: Math.max(0, s.offset - 20) }))}>Previous</Button>
            <span className="small num">{f.offset + 1}–{Math.min(total, f.offset + notes.length)} of {total}</span>
            <Button size="xs" variant="outline" disabled={f.offset + 20 >= total} onClick={() => setF(s => ({ ...s, offset: s.offset + 20 }))}>Next</Button>
          </nav>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ================================================================ access rules for rows and columns
export type RuleTarget = { kind: 'rows'; ids: string[]; current: Row[] | null; label: string } | { kind: 'column'; column: Row };
/** Restrict who sees rows or a column (a sharing change, for the people who manage the group). Rules only narrow the
 *  group's own sharing; the people who manage the group always see everything. */
export function AccessRuleDialog({ groupId, target, onClose, onSaved }: { groupId: string; target: RuleTarget; onClose: () => void; onSaved: (message: string) => void }) {
  const current: Row[] = (target.kind === 'column' ? target.column.access : target.current) || [];
  const [mode, setMode] = useState(current.length ? 'SOME' : 'ALL');
  const [people, setPeople] = useState<string[]>(current.filter(p => p.type === 'USER').map(p => p.id));
  const [roles, setRoles] = useState<string[]>(current.filter(p => p.type === 'ROLE').map(p => p.id));
  const [audience, setAudience] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void groupRead('/api/tasks/group/audience', { id: groupId }).then(setAudience).catch(e => setError((e as Error).message)); }, [groupId]);
  const what = target.kind === 'column' ? `the column “${target.column.name}”` : target.label;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const principals = mode === 'ALL' ? [] : [...people.map(id => ({ type: 'USER', id })), ...roles.map(id => ({ type: 'ROLE', id }))];
    if (mode === 'SOME' && !principals.length) { setError('Choose at least one person or role, or let everyone in the group see it.'); return; }
    setBusy(true); setError('');
    try {
      const r = target.kind === 'column' ? await groupCommand('tm.group.column.access', { group_id: groupId, id: target.column.id, principals })
        : await groupCommand('tm.group.row.access', { group_id: groupId, ids: target.ids, principals });
      onSaved(r.message || 'Access saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle><Lock aria-hidden="true" className="inline-icon" />Who can see {what}</DialogTitle>
          <DialogDescription>A sharing change for everyone in the group. To only tidy your own screen, use “Hide in my view” instead.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title="This could not be saved" live>{error}</Alert>}
              <fieldset className="choice-cards is-stacked">
                <legend className="field-label">Visible to</legend>
                <label className={`choice-card${mode === 'ALL' ? ' is-checked' : ''}`}><input type="radio" name="rule-mode" checked={mode === 'ALL'} onChange={() => setMode('ALL')} /><Users aria-hidden="true" className="choice-icon" /><span className="cell-stack"><span className="cell-title">Everyone who can open the group</span><small>No extra rule.</small></span></label>
                <label className={`choice-card${mode === 'SOME' ? ' is-checked' : ''}`}><input type="radio" name="rule-mode" checked={mode === 'SOME'} onChange={() => setMode('SOME')} /><Lock aria-hidden="true" className="choice-icon" /><span className="cell-stack"><span className="cell-title">Only the people and roles I choose</span><small>Everyone else no longer sees {target.kind === 'column' ? 'this column, or formulas that use it' : target.ids.length === 1 ? 'this row or its notes' : 'these rows or their notes'}.</small></span></label>
              </fieldset>
              {mode === 'SOME' && (!audience ? <p className="muted small" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />Loading who can open the group…</p> : <>
                <PeoplePicker label="People" people={(audience.people || []).map((p: Row) => ({ id: p.id, name: p.name }))} value={people} onChange={setPeople} addLabel="Add a person" max={GROUP_LIMITS.principals} hint="Only people who can open the group can be chosen." />
                {(audience.roles || []).length > 0 && <fieldset className="rule-roles"><legend className="field-label">Roles</legend>
                  {(audience.roles as Row[]).map(r => <CheckboxField key={r.id} label={r.name} checked={roles.includes(r.id)} onChange={v => setRoles(s => v ? [...s, r.id] : s.filter(x => x !== r.id))} />)}
                  <p className="field-hint">Anyone whose Task Controlling Management role is ticked (and who can open the group).</p></fieldset>}
              </>)}
              <p className="muted small">The people who manage the group always see everything. Exports, search, totals, notes and Google Sheets follow the same rule.</p>
            </div>
            <div className="dialog-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save access</Button></div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ Excel export
export function ExportDialog({ groupId, name, all, filtered, selectedIds, query, filteredActive, hiddenColumns, onClose }: {
  groupId: string; name: string; all: number; filtered: number; selectedIds: string[] | null; query: Record<string, string>; filteredActive: boolean; hiddenColumns: number; onClose: () => void;
}) {
  const [scope, setScope] = useState(selectedIds?.length ? 'selected' : filteredActive ? 'filtered' : 'all'), [columns, setColumns] = useState('all');
  const count = scope === 'selected' ? selectedIds!.length : scope === 'filtered' ? filtered : all;
  const params = new URLSearchParams({ id: groupId, scope, ...(columns === 'view' ? { columns: 'view' } : {}) });
  if (scope === 'selected') params.set('ids', selectedIds!.join(','));
  if (scope === 'filtered') for (const k of ['q', 'filters', 'sort', 'dir', 'hidden']) if (query[k]) params.set(k, query[k]);
  const href = apiPath(`/api/tasks/group.xlsx?${params.toString()}`);
  const option = (value: string, title: string, detail: string, n: number) => <label className={`choice-card${scope === value ? ' is-checked' : ''}`}><input type="radio" name="export-scope" checked={scope === value} onChange={() => setScope(value)} /><span className="cell-stack"><span className="cell-title">{title} <span className="muted num">({n.toLocaleString('en-US')})</span></span><small>{detail}</small></span></label>;
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle><FileSpreadsheet aria-hidden="true" className="inline-icon" />Export “{name}” to Excel</DialogTitle><DialogDescription>An .xlsx workbook with only the rows and columns you can see. Formula results are exported as values.</DialogDescription></DialogHeader>
        <div className="dialog-body stack">
          <fieldset className="choice-cards is-stacked"><legend className="field-label">Rows</legend>
            {option('all', 'All rows you can see', 'Every page, not only the rows on screen.', all)}
            {filteredActive && option('filtered', 'Rows matching your search and filters', 'In your current sort order.', filtered)}
            {!!selectedIds?.length && option('selected', 'Selected rows', 'The rows you ticked.', selectedIds.length)}
          </fieldset>
          {hiddenColumns > 0 && <fieldset className="choice-cards is-stacked"><legend className="field-label">Columns</legend>
            <label className={`choice-card${columns === 'all' ? ' is-checked' : ''}`}><input type="radio" name="export-cols" checked={columns === 'all'} onChange={() => setColumns('all')} /><span className="cell-stack"><span className="cell-title">All columns you can see</span><small>Including the {hiddenColumns} you hid in your view.</small></span></label>
            <label className={`choice-card${columns === 'view' ? ' is-checked' : ''}`}><input type="radio" name="export-cols" checked={columns === 'view'} onChange={() => setColumns('view')} /><span className="cell-stack"><span className="cell-title">Only the columns in my view</span><small>In your column order.</small></span></label>
          </fieldset>}
          <p className="muted small">Text starting with “=” stays text. Dates and numbers keep their Excel types; the header row is frozen and filterable.</p>
        </div>
        <div className="dialog-footer">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button asChild disabled={!count}><a href={href} download onClick={() => { toast.success(`Exporting ${count.toLocaleString('en-US')} ${plural(count, 'row')}…`); window.setTimeout(onClose, 300); }}><Download />Download .xlsx</a></Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
