import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { Row } from './components';
import { groupCommand, groupRead } from './group-api';
import { CheckboxField, Picker } from './ui-kit';
export function ShareDataDialog({ groupId, columns, initialColumn, onClose }: { groupId: string; columns: Row[]; initialColumn: string; onClose: () => void }) {
  const [data, setData] = useState<Row>({ people: [], shares: [] }), [recipient, setRecipient] = useState(''), [chosen, setChosen] = useState<string[]>([initialColumn]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const load = () => groupRead('/api/tasks/group/shares', { id: groupId }).then(setData);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps
  const existing = data.shares.find((s: Row) => s.recipient_id === recipient);
  const save = async (active: boolean, grant: Row | undefined = existing) => {
    setBusy(true); setError(''); setMessage('');
    try { const result = await groupCommand('tm.group.data-share.save', { group_id: groupId, recipient_id: active ? recipient : grant?.recipient_id, column_ids: active ? chosen : [], active, expected_version: grant?.version }); await load(); setMessage(result.message); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}><DialogContent className="dialog-lg"><DialogHeader><DialogTitle>Share Data</DialogTitle><DialogDescription>Allow someone to copy selected columns into their own Group. Source editing and workspace access stay separate.</DialogDescription></DialogHeader>
    <div className="dialog-body stack"><Picker label="Recipient" value={recipient} none="Choose a person" options={data.people.map((p: Row) => [p.id, p.name])} onChange={id => { setRecipient(id); const old = data.shares.find((s: Row) => s.recipient_id === id && s.active); setChosen(old?.column_ids || [initialColumn]); }} />
      <fieldset disabled={busy}><legend className="field-label">Columns this person may import</legend>{columns.filter(c => c.type !== 'ATTACHMENT').map(c => <CheckboxField key={c.id} label={c.name} checked={chosen.includes(c.id)} onChange={v => setChosen(s => v ? [...s, c.id] : s.filter(x => x !== c.id))} />)}</fieldset>
      <p className="field-hint">Row and column restrictions still apply. Include the input columns when sharing a formula. Formula results are copied as numbers. Attachments are not copied. Outside-workspace recipients require your organizational collaboration permission.</p>
      {!!data.shares.filter((s: Row) => s.active).length && <div><h3>Active shares</h3>{data.shares.filter((s: Row) => s.active).map((s: Row) => <div className="row-between" key={s.id}><span>{s.name} · {s.column_ids.length} columns</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void save(false, s)}>Revoke</Button></div>)}</div>}
      {error && <p role="alert" className="field-error">{error}</p>}{message && <p role="status">{message}</p>}
    </div><div className="dialog-footer"><Button variant="outline" disabled={busy} onClick={onClose}>Close</Button><Button disabled={busy || !recipient || !chosen.length} onClick={() => void save(true)}>Save share</Button></div></DialogContent></Dialog>;
}

export function InternalImportSource({ groupId, onReady }: { groupId: string; onReady: (imp: Row) => void }) {
  const [sources, setSources] = useState<Row[]>([]), [source, setSource] = useState(''), [data, setData] = useState<Row | null>(null);
  const [columns, setColumns] = useState<string[]>([]), [rows, setRows] = useState<string[]>([]), [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let live = true; groupRead('/api/tasks/group/import-sources', { id: groupId }).then(r => { if (live) setSources(r.sources); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [groupId]);
  useEffect(() => { if (!source) { setData(null); return; } let live = true; setBusy(true); setError(''); setData(null);
    groupRead('/api/tasks/group/import-source', { id: groupId, source }).then(r => { if (!live) return; setData(r); setColumns(r.columns.map((c: Row) => c.id)); setRows(r.rows.map((r: Row) => r.id)); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); }); return () => { live = false; };
  }, [groupId, source]);
  const stage = async () => { setBusy(true); setError(''); try { const r = await groupCommand('tm.group.import.internal', { group_id: groupId, source_id: source, column_ids: columns, row_ids: rows }); onReady(r.import); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const label = (r: Row) => r.cells.filter((_: Row, i: number) => columns.includes(data!.columns[i].id)).map((c: Row) => typeof c.v === 'object' ? c.v?.error || '' : String(c.v ?? '')).join(' · ');
  const filtered = (data?.rows || []).filter((r: Row) => label(r).toLowerCase().includes(search.toLowerCase()));
  return <div className="stack"><Picker label="Source Group" value={source} none="Choose a Group" options={sources.map(s => [s.id, `${s.name}${s.shared ? ' · shared data' : ''}`])} onChange={setSource} /><p className="field-hint">Only authorized Groups and explicit data shares appear. Data is copied; later source edits do not sync.</p>
    {data && <><fieldset><legend className="field-label">1. Select columns</legend>{data.columns.map((c: Row) => <CheckboxField key={c.id} label={`${c.name} · ${c.type}`} checked={columns.includes(c.id)} onChange={v => setColumns(s => v ? [...s, c.id] : s.filter(x => x !== c.id))} />)}</fieldset>
      <div className="row-between"><strong>2. Select rows ({rows.length})</strong><Button size="xs" variant="outline" onClick={() => setRows(rows.length === data.rows.length ? [] : data.rows.map((r: Row) => r.id))}>{rows.length === data.rows.length ? 'Clear all' : 'Select all'}</Button></div>
      <input aria-label="Find source rows" value={search} placeholder="Find rows…" onChange={e => setSearch(e.target.value)} />
      <div className="internal-source-rows">{filtered.slice(0, 500).map((r: Row) => <label key={r.id}><input type="checkbox" checked={rows.includes(r.id)} onChange={e => setRows(s => e.target.checked ? [...s, r.id] : s.filter(x => x !== r.id))} /><span>{label(r) || '(empty row)'}</span></label>)}</div>
      {filtered.length > 500 && <p className="field-hint">Showing 500 matches. Refine the search to select individual rows; Select all includes every source row.</p>}
      <Button disabled={busy || !columns.length || !rows.length} onClick={() => void stage()}>Continue to field mapping</Button></>}
    {busy && <p role="status">Loading source…</p>}{error && <p role="alert" className="field-error">{error}</p>}
  </div>;
}
