import { uiText, useLanguage } from "./i18n";
// Share Live Data (connected data), next to Share Data (an independent copy). The server keeps one source of truth and
// checks every read and write; these dialogs only choose who sees which columns, connect a Live Data column to a
// group, and show the edit history. Nothing here is a copy of the source values.
import { useEffect, useMemo, useState } from 'react';
import { History, Link2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Row } from './components';
import { groupCommand, groupRead } from './group-api';
import { formatDateTime, plural } from './format';
import { Alert, CheckboxField, Field, Picker } from './ui-kit';

export const LIVE_ERRORS: Record<string, string> = {
  '#N/A': 'Live Data is not available to you: the share was revoked or you no longer have access.',
  '#DUP!': 'Several shared records match this row, so no value is shown. The source group needs a unique match key.',
  '#REF!': 'The shared column or its match column was removed from the source group.',
};
const PERMISSION: Record<string, string> = { VIEW: 'Viewer', EDIT: 'Can edit' };
const VIA: Record<string, string> = { group: 'In the source group', live: 'Through Live Data', import: 'Excel or group import' };
const ACTION: Record<string, string> = { EDIT: 'Changed', ADD_ROW: 'Record added', DELETE_ROW: 'Record deleted', IMPORT: 'Imported' };

/** A Live Data column as the table shows and edits it: its source's type and settings, with the connection beside it. */
export function viewColumn(c: Row): Row {
  if (c.type !== 'LINKED') return c;
  const live = c.live || { state: 'no_access' };
  const type = live.source_type === 'FORMULA' ? 'NUMBER' : live.source_type || 'TEXT';
  return { ...c, type, settings: live.source_settings || {}, linked: { ...live, readOnly: live.permission !== 'EDIT' } };
}

// ---------------------------------------------------------------- the source side: who sees which columns live
export function ShareLiveDialog({ groupId, groupName, initialColumn, onClose }: { groupId: string; groupName: string; initialColumn?: string; onClose: () => void }) {
  useLanguage();
  const [data, setData] = useState<Row>({ people: [], shares: [], columns: [] }), [recipient, setRecipient] = useState('');
  const [perms, setPerms] = useState<Record<string, string>>(initialColumn ? { [initialColumn]: 'VIEW' } : {});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [history, setHistory] = useState(false);
  const load = () => groupRead('/api/tasks/group/live-shares', { id: groupId }).then(setData);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps
  const existing: Row | undefined = data.shares.find((s: Row) => s.recipient_id === recipient);
  const pick = (id: string) => {
    setRecipient(id); setMessage(''); setError('');
    const old = data.shares.find((s: Row) => s.recipient_id === id && s.active);
    setPerms(old ? Object.fromEntries(old.columns.map((c: Row) => [c.column_id, c.permission])) : initialColumn ? { [initialColumn]: 'VIEW' } : {});
  };
  const save = async (active: boolean, grant: Row | undefined = existing) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await groupCommand('tm.group.live-share.save', { group_id: groupId, recipient_id: grant?.recipient_id || recipient, active, expected_version: grant?.version,
        columns: active ? Object.entries(perms).map(([column_id, permission]) => ({ column_id, permission })) : [] });
      await load(); setMessage(result.message);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const active = data.shares.filter((s: Row) => s.active);
  const name = (id: string) => data.columns.find((c: Row) => c.id === id)?.name || uiText("a removed column");
  return <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
    <DialogContent className="dialog-lg">
      <DialogHeader><DialogTitle>{uiText("Share Live Data")}</DialogTitle>
        <DialogDescription>{uiText("Connected data: the people you choose see this group’s current values in their own group, and with Can edit they change them here. Use Share Data instead to let someone take an independent copy.")}</DialogDescription></DialogHeader>
      <div className="dialog-body stack">
        <Picker label={uiText("Recipient")} value={recipient} none={uiText("Choose a person")} options={data.people.map((p: Row) => [p.id, p.name])} onChange={pick}
          hint={uiText("Only people within your collaboration scope are listed. Sharing never gives them workspace membership or this group.")} />
        <fieldset className="live-columns" disabled={busy || !recipient}>
          <legend className="field-label">{uiText("Columns and permission")}</legend>
          <div className="live-column-list">
            {data.columns.map((c: Row) => <div key={c.id} className="live-column-row">
              <span className="cell-stack"><span className="cell-title">{c.name}</span><small className="muted">{c.type === 'FORMULA' ? uiText("Formula · Viewer only") : !c.editable ? uiText("Viewer only") : ' '}</small></span>
              <Picker label={uiText("Permission for {p0}", { p0: c.name })} hideLabel value={perms[c.id] || ''} none={uiText("Not shared")} allowNone
                options={[['VIEW', uiText("Viewer")], ...(c.editable ? [['EDIT', uiText("Can edit")] as [string, string]] : [])]}
                onChange={v => setPerms(s => { const n = { ...s }; if (v) n[c.id] = v; else delete n[c.id]; return n; })} />
            </div>)}
          </div>
        </fieldset>
        <p className="field-hint">{uiText("Viewer: sees the latest values and can use them in formulas, but never changes this group. Can edit: changes these cells here; every change is kept in the edit history. Share the column that rows are matched by (for example an item name) too, and every column a shared formula uses. Row and column restrictions still apply.")}</p>
        {!!active.length && <div className="live-active"><h3 className="text-section">{uiText("Live Data shared now")}</h3>
          <ul className="live-share-list">{active.map((s: Row) => { const edit = s.columns.filter((c: Row) => c.permission === 'EDIT').length; return <li key={s.id}>
            <span className="cell-stack"><span className="cell-title">{s.name}</span><small className="muted">{s.columns.map((c: Row) => `${name(c.column_id)} (${PERMISSION[c.permission]})`).join(', ')}{edit ? uiText(" · {p0} can edit", { p0: edit }) : ''}</small></span>
            <span className="row"><Button size="sm" variant="ghost" disabled={busy} onClick={() => pick(s.recipient_id)}>{uiText("Change")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void save(false, s)}>{uiText("Revoke")}</Button></span>
          </li>; })}</ul></div>}
        {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
        {message && <p role="status" className="text-success small">{message}</p>}
      </div>
      <div className="dialog-footer">
        <div className="footer-start"><Button variant="ghost" onClick={() => setHistory(true)}><History />{uiText("Edit history")}</Button></div>
        {existing?.active && <Button variant="outline" disabled={busy} onClick={() => void save(false)}>{uiText("Revoke for ")}{existing.name.split(' ')[0]}</Button>}
        <Button variant="outline" disabled={busy} onClick={onClose}>{uiText("Close")}</Button>
        <Button disabled={busy || !recipient || !Object.keys(perms).length} onClick={() => void save(true)}><Link2 />{existing?.active ? uiText("Save changes") : uiText("Share live")}</Button>
      </div>
      {history && <LiveHistoryDialog groupId={groupId} groupName={groupName} onClose={() => setHistory(false)} />}
    </DialogContent>
  </Dialog>;
}

// ---------------------------------------------------------------- the recipient's side: a Live Data column
export function AddLiveColumnDialog({ groupId, columns, after, onClose, onSaved }: { groupId: string; columns: Row[]; after?: string; onClose: () => void; onSaved: (message: string) => void | Promise<void> }) {
  useLanguage();
  const [sources, setSources] = useState<Row[] | null>(null), [share, setShare] = useState(''), [value, setValue] = useState(''), [key, setKey] = useState(''), [local, setLocal] = useState('');
  const [name, setName] = useState(''), [addRows, setAddRows] = useState(false), [preview, setPreview] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let on = true; groupRead('/api/tasks/group/live-sources', { id: groupId }).then(r => { if (on) setSources(r.sources); }).catch(e => { if (on) setError(e.message); }); return () => { on = false; }; }, [groupId]);
  const source: Row | undefined = (sources || []).find(s => s.share_id === share);
  useEffect(() => { if (!share) { setPreview(null); return; } let on = true; groupRead('/api/tasks/group/live', { share, limit: 5 }).then(r => { if (on) setPreview(r); }).catch(() => { if (on) setPreview(null); }); return () => { on = false; }; }, [share]);
  const keys = columns.filter(c => !c.linked && ['TEXT', 'NUMBER', 'DATE', 'STATUS'].includes(c.type));
  const chosen = source?.columns.find((c: Row) => c.id === value);
  const pickSource = (id: string) => { setShare(id); const s = (sources || []).find(x => x.share_id === id); const first = s?.columns.find((c: Row) => c.type !== 'TEXT') || s?.columns[0];
    setValue(first?.id || ''); setKey(s?.columns.find((c: Row) => c.type === 'TEXT')?.id || ''); setLocal(keys.find(c => c.type === 'TEXT')?.id || keys[0]?.id || ''); setName(first ? `${first.name} (live)` : ''); };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await groupCommand('tm.group.column.save', { group_id: groupId, name, type: 'LINKED', ...(after ? { after } : {}), settings: { share_id: share, source_column_id: value, source_key_id: key, key_column_id: local } });
      let message = r.message || uiText("Live Data column added.");
      if (addRows) { const added = await groupCommand('tm.group.live.rows', { group_id: groupId, column_id: r.id }); message = `${message} ${added.message}`; }
      await onSaved(message);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const shown = (c: Row, v: unknown) => v === undefined || v === null ? '' : typeof v === 'object' ? (v as Row).error || '' : Array.isArray(v) ? v.join(', ') : c.type === 'STATUS' ? (c.settings?.labels || []).find((l: Row) => l.id === v)?.name || '' : String(v);
  return <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
    <DialogContent className="dialog-lg" onInteractOutside={e => e.preventDefault()}>
      <DialogHeader><DialogTitle>{uiText("Add a Live Data column")}</DialogTitle>
        <DialogDescription>{uiText("Shows a column someone shared with you, as it is now in their group. Your rows are matched to their records by a column you both have (for example Item).")}</DialogDescription></DialogHeader>
      <div className="dialog-body stack">
        {sources && !sources.length && <Alert tone="neutral" title={uiText("Nothing is shared with you live yet")}>{uiText("Ask the owner of the group you need to use “Share Live Data” on its columns.")}</Alert>}
        {!!sources?.length && <>
          <Picker label={uiText("Shared with you")} value={share} none={uiText("Choose Live Data")} options={sources.map(s => [s.share_id, `${s.group_name} · shared by ${s.shared_by}`])} onChange={pickSource} required />
          {source && <>
            <div className="grid-2">
              <Picker label={uiText("Column to show")} value={value} allowNone={false} options={source.columns.map((c: Row) => [c.id, `${c.name} · ${PERMISSION[c.permission]}`])} onChange={v => { setValue(v); const c = source.columns.find((x: Row) => x.id === v); if (c) setName(`${c.name} (live)`); }} required />
              <Field label={uiText("Name in this group")} value={name} onChange={setName} required maxLength={80} />
              <Picker label={uiText("Match records by (in {p0})", { p0: source.group_name })} value={key} allowNone={false} options={source.columns.map((c: Row) => [c.id, c.name])} onChange={setKey} required />
              <Picker label={uiText("…with this group’s column")} value={local} allowNone={false} options={keys.map(c => [c.id, c.name])} onChange={setLocal} required hint={uiText("Text, Number, Date or Status. Matching ignores upper/lower case and extra spaces.")} />
            </div>
            {chosen && <p className="field-hint">{chosen.permission === 'EDIT' ? uiText("Can edit: changes you make in this column are saved in the source group and recorded in its edit history.") : uiText("Viewer: you see the latest values and can use them in formulas; you cannot change them.")}</p>}
            {preview && <div className="live-preview"><p className="small muted">{preview.total} {uiText("shared ")}{plural(preview.total, 'record')} {uiText("· first ")}{Math.min(5, preview.rows.length)}:</p>
              <table className="data-table compact"><thead><tr>{[key, value].filter((x, i, a) => x && a.indexOf(x) === i).map(id => <th key={id}>{preview.columns.find((c: Row) => c.id === id)?.name}</th>)}</tr></thead>
                <tbody>{preview.rows.map((r: Row) => <tr key={r.id}>{[key, value].filter((x, i, a) => x && a.indexOf(x) === i).map(id => { const c = preview.columns.find((x: Row) => x.id === id) || {}; return <td key={id}>{shown(c, r.values[id])}</td>; })}</tr>)}</tbody></table></div>}
            <CheckboxField label={uiText("Also add a row for each shared record this group doesn’t have yet")} description={uiText("Each new row gets the record’s match value; nothing else is copied.")} checked={addRows} onChange={setAddRows} />
          </>}
        </>}
        {error && <Alert tone="danger" title={uiText("This could not be saved")} live>{error}</Alert>}
      </div>
      <div className="dialog-footer">
        <Button variant="outline" disabled={busy} onClick={onClose}>{uiText("Cancel")}</Button>
        <Button disabled={busy || !share || !value || !key || !local || !name.trim()} loading={busy} onClick={() => void submit()}><Link2 />{uiText("Add Live Data column")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

// ---------------------------------------------------------------- edit history of live-shared columns
export function LiveHistoryDialog({ groupId, groupName, column, onClose }: { groupId: string; groupName?: string; column?: string; onClose: () => void }) {
  useLanguage();
  const [f, setF] = useState({ from: '', to: '', actor: '', column: column || '', offset: 0 });
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let on = true; setBusy(true);
    groupRead('/api/tasks/group/live-history', { id: groupId, ...f, limit: 50 }).then(r => { if (on) { setData(r); setError(''); } }).catch(e => { if (on) setError(e.message); }).finally(() => { if (on) setBusy(false); });
    return () => { on = false; }; }, [groupId, f]);
  const set = (patch: Partial<typeof f>) => setF(s => ({ ...s, ...patch, offset: 'offset' in patch ? patch.offset! : 0 }));
  const filtered = !!(f.from || f.to || f.actor || (f.column && f.column !== column));
  const people = useMemo(() => (data?.people || []).map((p: Row) => [p.id, p.name] as [string, string]), [data]);
  return <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
    <DialogContent className="dialog-xl">
      <DialogHeader><DialogTitle>{uiText("Live Data edit history")}</DialogTitle>
        <DialogDescription>{data?.group?.name || groupName || uiText("Source group")} {uiText("· every change to a live-shared column: who, when, the record, and the value before and after.")}</DialogDescription></DialogHeader>
      <div className="dialog-body stack">
        <div className="live-history-filters">
          <Field label={uiText("From")} type="date" value={f.from} onChange={v => set({ from: v })} />
          <Field label={uiText("To")} type="date" value={f.to} onChange={v => set({ to: v })} />
          <Picker label={uiText("Person")} value={f.actor} none={uiText("Everyone")} options={people} onChange={v => set({ actor: v })} />
          <Picker label={uiText("Column")} value={f.column} none={uiText("Every shared column")} options={(data?.columns || []).map((c: Row) => [c.id, c.name])} onChange={v => set({ column: v })} />
          {filtered && <Button size="sm" variant="ghost" onClick={() => set({ from: '', to: '', actor: '', column: column || '' })}><RotateCcw />{uiText("Clear filters")}</Button>}
        </div>
        {error && <Alert tone="danger" title={uiText("The history could not be loaded")} live>{error}</Alert>}
        {data && <div className="table-wrap"><table className="data-table live-history">
          <caption className="sr-only">{uiText("Live Data edit history, newest first. Times are in ")}{data.zone}.</caption>
          <thead><tr><th scope="col">{uiText("When")}</th><th scope="col">{uiText("Who")}</th><th scope="col">{uiText("Record")}</th><th scope="col">{uiText("Column")}</th><th scope="col">{uiText("Before")}</th><th scope="col">{uiText("After")}</th><th scope="col">{uiText("How")}</th></tr></thead>
          <tbody>{data.items.map((x: Row) => <tr key={x.id}>
            <td className="nowrap">{formatDateTime(x.at)}</td><td>{x.actor}</td><td>{x.row || <span className="muted small" title={uiText("This record was deleted, or its name is in a column you cannot see.")}>{x.row_id}</span>}</td><td>{x.column}</td>
            <td className="live-before">{x.action === 'ADD_ROW' ? <span className="muted">—</span> : x.before || <span className="muted">empty</span>}</td>
            <td>{x.action === 'DELETE_ROW' ? <span className="muted">{ACTION.DELETE_ROW}</span> : x.after || <span className="muted">empty</span>}</td>
            <td className="small muted">{x.action === 'EDIT' ? VIA[x.via] || x.via : ACTION[x.action] || x.action}</td>
          </tr>)}
          {!data.items.length && <tr><td colSpan={7} className="muted">{filtered ? uiText("No changes match these filters.") : uiText("No changes have been made to live-shared columns yet.")}</td></tr>}</tbody>
        </table></div>}
        {data && data.total > data.limit && <div className="row-between"><span className="small muted num">{data.offset + 1}–{data.offset + data.items.length} {uiText("of ")}{data.total}</span>
          <span className="row"><Button size="sm" variant="outline" disabled={busy || f.offset === 0} onClick={() => set({ offset: Math.max(0, f.offset - 50) })}>{uiText("Newer")}</Button>
            <Button size="sm" variant="outline" disabled={busy || f.offset + 50 >= data.total} onClick={() => set({ offset: f.offset + 50 })}>{uiText("Older")}</Button></span></div>}
      </div>
      <div className="dialog-footer"><Button variant="outline" onClick={onClose}>{uiText("Close")}</Button></div>
    </DialogContent>
  </Dialog>;
}
