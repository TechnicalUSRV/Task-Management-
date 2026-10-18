import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns3, Download, FolderOpen, Paperclip, RefreshCw } from 'lucide-react';
import type { Row } from './components';
import { cellText, COLUMN_TYPES, statusLabels } from './group-domain.mjs';
import { cellColors, formatColumnNumber } from './group-presentation';
import { GroupDelivery } from './group-delivery-ui';
import './styles/tg-groups.css';

type Common = { read: (path: string) => Promise<Row>; command: (action: string, data: Row) => Promise<Row> };
type Props = Common & { data: Row; me: string; can: (r: string, a?: string) => boolean; name: (id?: string | null) => string;
  edit: (groupId: string, row: Row, column: Row, saved: () => void) => Promise<void>;
  attachments: (groupId: string, files: Row[], title: string) => void };

export function MiniGroups({ data, me, can, name, read, command, edit, attachments }: Props) {
  const [scope, setScope] = useState('mine'), [workspace, setWorkspace] = useState(''), [id, setId] = useState('');
  const [board, setBoard] = useState<Row | null>(null), [page, setPage] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]), [kind, setKind] = useState(''), [q, setQ] = useState(''), [filter, setFilter] = useState(''), [value, setValue] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const boards: Row[] = (data.tm_boards || []).filter((g: Row) => g.status === 'ACTIVE');
  const members = new Set((data.tm_members || []).filter((m: Row) => m.staff_id === me).map((m: Row) => m.workspace_id));
  const mine = boards.filter(g => g.owner_id === me || members.has(g.workspace_id) || (data.tm_board_access || []).some((a: Row) => a.board_id === g.id && a.staff_id === me));
  const scoped = scope === 'mine' ? mine : boards;
  const workspaceIds = [...new Set<string>(scoped.map(g => g.workspace_id))];
  const workspaceName = (key: string) => (data.tm_workspaces || []).find((w: Row) => w.id === key)?.name || (data.tm_workspace_refs || []).find((w: Row) => w.id === key)?.name || 'Shared workspace';
  const available = scoped.filter(g => !workspace || g.workspace_id === workspace);
  const columns: Row[] = board?.columns || [];
  const shown = columns.filter(c => !hidden.includes(c.id) && (!kind || c.type === kind));
  const permitted = !!can('tasks.groups');
  // Both initial data and changes come from the same scoped backend as the office web app.
  useEffect(() => {
    if (!id || !permitted) { setBoard(null); setPage(null); return; }
    let live = true; setBusy(true); setError('');
    read('/group?' + new URLSearchParams({ id })).then(r => { if (!live) return; setBoard(r); setHidden(r.view.hidden_columns || []); }).catch(e => { if (live) { setError(e.message); setBoard(null); } }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [id, permitted, read, data.change_seq]);
  useEffect(() => {
    if (!id || !permitted) return;
    let live = true; setBusy(true);
    const timer = setTimeout(() => {
      const filters = filter && value ? [{ col: filter, op: 'eq', value }] : [];
      read('/group-rows?' + new URLSearchParams({ id, q, offset: String(offset), limit: '50', filters: JSON.stringify(filters) }))
        .then(r => { if (live) { setPage(r); setError(''); } }).catch(e => { if (live) { setError(e.message); setPage(null); } }).finally(() => { if (live) setBusy(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [id, q, offset, filter, value, refresh, read, permitted, data.change_seq]);
  const select = (key: string) => { setId(key); setBoard(null); setPage(null); setQ(''); setFilter(''); setValue(''); setOffset(0); };
  const saveColumns = async () => { setError(''); try { await command('tm.group.view.save', { group_id: id, view: { hidden_columns: hidden } }); } catch(e) { setError((e as Error).message); } };
  const text = (c: Row, r: Row) => { const v = c.type === 'FORMULA' ? r.computed?.[c.id] : r.values?.[c.id]; return ['NUMBER', 'FORMULA'].includes(c.type) ? formatColumnNumber(v, c.settings) : cellText(c, v, name); };
  if (!permitted) return <div className="callout">Your role does not include Groups.</div>;
  return <section className="mini-groups"><header className="page-header"><h1>Groups</h1>{id && <button type="button" className="icon-btn" aria-label="Refresh Group" onClick={() => setRefresh(s => s + 1)}><RefreshCw /></button>}</header>
    <div className="mg-controls"><select aria-label="Group scope" className="input" value={scope} onChange={e => { setScope(e.target.value); setWorkspace(''); select(''); }}><option value="mine">My Groups</option><option value="company">Company · authorized scope</option></select>
      <select aria-label="Workspace" className="input" value={workspace} onChange={e => { setWorkspace(e.target.value); select(''); }}><option value="">All authorized workspaces</option>{workspaceIds.map(key => <option key={key} value={key}>{workspaceName(key)}</option>)}</select>
      <select aria-label="Group" className="input" value={id} onChange={e => select(e.target.value)}><option value="">Choose a Group</option>{available.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
    </div>
    {!id && <div className="mg-empty"><FolderOpen /><p>{available.length ? 'Choose a Group to open its table.' : 'No Groups in this scope.'}</p></div>}
    {board && <><div className="mg-tools"><input type="search" className="input" aria-label="Search Group records" placeholder="Search records…" value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} /><details><summary><Columns3 size={18} />Columns</summary><div className="mg-column-options"><select className="input" aria-label="Column type" value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option>{Object.entries(COLUMN_TYPES).map(([key, label]) => <option key={key} value={key}>{String(label)}</option>)}</select>
      {columns.map(c => <label key={c.id}><input type="checkbox" checked={!hidden.includes(c.id)} onChange={e => setHidden(s => e.target.checked ? s.filter(x => x !== c.id) : [...s, c.id])} />{c.name}</label>)}<button type="button" className="btn" onClick={() => void saveColumns()}>Save my columns</button></div></details></div>
      {!!columns.filter(c => c.type === 'STATUS').length && <div className="mg-controls mg-filter"><select className="input" aria-label="Filter by status column" value={filter} onChange={e => { setFilter(e.target.value); setValue(''); setOffset(0); }}><option value="">Status filter</option>{columns.filter(c => c.type === 'STATUS').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>{filter && <select className="input" aria-label="Status value" value={value} onChange={e => { setValue(e.target.value); setOffset(0); }}><option value="">All statuses</option>{statusLabels(columns.find(c => c.id === filter)).map((l: Row) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}</div>}
      <div className="mg-table-wrap" role="region" tabIndex={0} aria-label={`${board.group.name} records`}><table className="mg-table"><thead><tr><th>#</th>{shown.map(c => <th key={c.id}>{c.name}</th>)}</tr></thead><tbody>{(page?.rows || []).map((r: Row, i: number) => <tr key={r.id}><th>{offset + i + 1}</th>{shown.map(c => <td key={c.id} style={cellColors(r, c)}>{c.type === 'ATTACHMENT' ? <button type="button" onClick={() => attachments(id, r.values?.[c.id] || [], c.name)}><Paperclip size={15} />{(r.values?.[c.id] || []).length} files</button> : board.group.caps.editRows && c.type !== 'FORMULA' ? <button type="button" aria-label={`Edit ${c.name}: ${text(c, r) || 'empty'}`} onClick={() => { void edit(id, r, c, () => setRefresh(s => s + 1)).catch(e => setError(e.message)); }}>{text(c, r) || '—'}</button> : <span>{text(c, r) || '—'}</span>}</td>)}</tr>)}</tbody></table></div>
      {!shown.length && <p className="hint">Choose at least one column to display.</p>}{page && !page.rows.length && <p className="hint">No matching records.</p>}
      {page && <div className="mg-paging"><button type="button" className="btn" disabled={busy || offset === 0} aria-label="Previous records" onClick={() => setOffset(n => Math.max(0, n - 50))}><ChevronLeft /></button><span>{page.total ? offset + 1 : 0}–{offset + page.rows.length} / {page.total}</span><button type="button" className="btn" disabled={busy || offset + page.rows.length >= page.total} aria-label="Next records" onClick={() => setOffset(n => n + 50)}><ChevronRight /></button></div>}
    </>}{busy && <p role="status" className="hint">Loading…</p>}{error && <p role="alert" className="callout tone-danger">{error}</p>}
  </section>;
}

export function MiniGroupAttachments({ groupId, files, title, read, command, viewFile, download, onClose }: Common & { groupId: string; files: Row[]; title: string; viewFile: (f: Row) => void; download: (f: Row) => void; onClose: () => void }) {
  const delivery = useCallback((key: string) => read('/group-delivery?' + new URLSearchParams({ id: groupId, delivery: key })), [groupId, read]);
  const withCell = (f: Row) => ({ ...f, group_id: groupId, cell_files: files });
  return <section className="mini-groups"><header className="page-header"><button type="button" className="icon-btn" onClick={onClose} aria-label="Close attachments"><ChevronLeft /></button><h1>{title}</h1></header><ul className="mg-files">{files.map(f => <li key={f.id}><button type="button" className="mg-filename" onClick={() => viewFile(withCell(f))}>{f.name}</button><button type="button" className="icon-btn" aria-label={`Download ${f.name}`} onClick={() => download(withCell(f))}><Download /></button></li>)}</ul>{files.length ? <GroupDelivery groupId={groupId} files={files} read={delivery} command={command} /> : <p className="hint">No files in this cell.</p>}</section>;
}
