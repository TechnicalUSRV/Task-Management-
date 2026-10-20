import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns3, Download, FolderOpen, ListFilter, Paperclip, RefreshCw, Send } from 'lucide-react';
import type { Row } from './components';
import { cellText, COLUMN_TYPES, statusLabels } from './group-domain.mjs';
import { cellColors, formatColumnNumber } from './group-presentation';
import { MiniDeliverySheet, fileKind, fileSize } from './group-delivery-ui';
import { viewColumn } from './group-live-ui';
import './styles/tg-groups.css';

type Common = { read: (path: string) => Promise<Row>; command: (action: string, data: Row) => Promise<Row> };
type Props = Common & { data: Row; me: string; can: (r: string, a?: string) => boolean; name: (id?: string | null) => string;
  edit: (groupId: string, row: Row, column: Row, saved: () => void) => Promise<void>;
  attachments: (groupId: string, files: Row[], title: string) => void };

// The Groups tab's screen is rebuilt after a visit to an Attachment cell (or another tab), so the open Group, its search,
// filter, page and table scroll position are kept here for the session instead of being lost.
const memory = { scope: 'mine', workspace: '', id: '', q: '', filter: '', value: '', kind: '', offset: 0, top: 0, left: 0 };

export function MiniGroups({ data, me, can, name, read, command, edit, attachments }: Props) {
  const [scope, setScope] = useState(memory.scope), [workspace, setWorkspace] = useState(memory.workspace), [id, setId] = useState(memory.id);
  const [board, setBoard] = useState<Row | null>(null), [page, setPage] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]), [kind, setKind] = useState(memory.kind), [q, setQ] = useState(memory.q), [filter, setFilter] = useState(memory.filter), [value, setValue] = useState(memory.value), [offset, setOffset] = useState(memory.offset), [refresh, setRefresh] = useState(0);
  useEffect(() => { Object.assign(memory, { scope, workspace, id, q, filter, value, kind, offset }); }, [scope, workspace, id, q, filter, value, kind, offset]);
  const boards: Row[] = (data.tm_boards || []).filter((g: Row) => g.status === 'ACTIVE');
  const members = new Set((data.tm_members || []).filter((m: Row) => m.staff_id === me).map((m: Row) => m.workspace_id));
  const mine = boards.filter(g => g.owner_id === me || members.has(g.workspace_id) || (data.tm_board_access || []).some((a: Row) => a.board_id === g.id && a.staff_id === me));
  const scoped = scope === 'mine' ? mine : boards;
  const workspaceIds = [...new Set<string>(scoped.map(g => g.workspace_id))];
  const workspaceName = (key: string) => (data.tm_workspaces || []).find((w: Row) => w.id === key)?.name || (data.tm_workspace_refs || []).find((w: Row) => w.id === key)?.name || 'Shared workspace';
  const available = scoped.filter(g => !workspace || g.workspace_id === workspace);
  // Live Data columns read and edit as their source's type; Viewer columns are read-only (the server checks again).
  const columns: Row[] = (board?.columns || []).map(viewColumn);
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
  // The table scrolls by itself: a new page, search or filter starts again at its first record.
  // Coming back to an open Group returns to the same place in its table once its records are loaded.
  const wrap = useRef<HTMLDivElement>(null), restore = useRef(memory.id ? { top: memory.top, left: memory.left } : null);
  useEffect(() => { if (!restore.current) wrap.current?.scrollTo({ top: 0 }); }, [id, q, offset, filter, value]);
  useEffect(() => { if (page && restore.current && wrap.current) { wrap.current.scrollTo(restore.current); restore.current = null; } }, [page, board]);
  const select = (key: string) => { setId(key); setBoard(null); setPage(null); setQ(''); setFilter(''); setValue(''); setOffset(0); };
  const saveColumns = async () => { setError(''); try { await command('tm.group.view.save', { group_id: id, view: { hidden_columns: hidden } }); } catch(e) { setError((e as Error).message); } };
  const text = (c: Row, r: Row) => { const v = c.type === 'FORMULA' ? r.computed?.[c.id] : r.values?.[c.id]; if (c.linked && v && typeof v === 'object' && !Array.isArray(v)) return String(v.error || ''); return ['NUMBER', 'FORMULA'].includes(c.type) ? formatColumnNumber(v, c.settings) : cellText(c, v, name); };
  if (!permitted) return <div className="callout">Your role does not include Groups.</div>;
  const statusColumns = columns.filter(c => c.type === 'STATUS'), filtered = !!(filter && value);
  // Table-first layout: compact pickers and one tools row, then the table fills the rest of the screen and scrolls by
  // itself (headers and row numbers stay pinned), so the page around it does not scroll as well.
  return <section className={`mini-groups${board ? ' is-open' : ''}`}>
    {/* With a Group open, the highlighted Groups tab names the page; the heading stays for screen readers. */}
    <header className={board ? 'sr-only' : 'mg-head'}><h1>Groups</h1></header>
    {busy && <span className="sr-only" role="status">Loading…</span>}
    <div className="mg-pickers"><select aria-label="Group scope" className="input" value={scope} onChange={e => { setScope(e.target.value); setWorkspace(''); select(''); }}><option value="mine">My Groups</option><option value="company">Company (authorized)</option></select>
      <select aria-label="Workspace" className="input mg-workspace" value={workspace} onChange={e => { setWorkspace(e.target.value); select(''); }}><option value="">All workspaces</option>{workspaceIds.map(key => <option key={key} value={key}>{workspaceName(key)}</option>)}</select>
      <select aria-label="Group" className="input mg-group" value={id} onChange={e => select(e.target.value)}><option value="">Choose a Group</option>{available.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      {id && <button type="button" className="icon-btn mg-refresh" aria-label="Refresh Group" onClick={() => setRefresh(s => s + 1)}><RefreshCw className={busy ? 'mg-spinning' : undefined} aria-hidden="true" /></button>}
    </div>
    {error && <p role="alert" className="callout tone-danger mg-error">{error}</p>}
    {!id && <div className="mg-empty"><FolderOpen /><p>{available.length ? 'Choose a Group to open its table.' : 'No Groups in this scope.'}</p></div>}
    {board && <><div className="mg-tools"><input type="search" className="input" aria-label="Search Group records" placeholder="Search…" value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} />
      <details className="mg-menu"><summary aria-label="Columns"><Columns3 aria-hidden="true" /><span>Columns</span></summary><div className="mg-column-options"><select className="input" aria-label="Column type" value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option>{Object.entries(COLUMN_TYPES).map(([key, label]) => <option key={key} value={key}>{String(label)}</option>)}</select>
        {columns.map(c => <label key={c.id}><input type="checkbox" checked={!hidden.includes(c.id)} onChange={e => setHidden(s => e.target.checked ? s.filter(x => x !== c.id) : [...s, c.id])} />{c.name}</label>)}<button type="button" className="btn" onClick={() => void saveColumns()}>Save my columns</button></div></details>
      {!!statusColumns.length && <details className="mg-menu"><summary aria-label={filtered ? 'Filter, 1 active' : 'Filter'}><ListFilter aria-hidden="true" /><span>Filter</span>{filtered && <span className="mg-dot" aria-hidden="true" />}</summary><div className="mg-column-options mg-filter-options">
        <select className="input" aria-label="Filter by status column" value={filter} onChange={e => { setFilter(e.target.value); setValue(''); setOffset(0); }}><option value="">Status filter</option>{statusColumns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {filter && <select className="input" aria-label="Status value" value={value} onChange={e => { setValue(e.target.value); setOffset(0); }}><option value="">All statuses</option>{statusLabels(columns.find(c => c.id === filter)).map((l: Row) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        {filtered && <button type="button" className="btn" onClick={() => { setFilter(''); setValue(''); setOffset(0); }}>Clear filter</button>}</div></details>}
    </div>
      <div ref={wrap} className="mg-table-wrap" onScroll={e => { memory.top = e.currentTarget.scrollTop; memory.left = e.currentTarget.scrollLeft; }} role="region" tabIndex={0} aria-label={`${board.group.name} records`}><table className="mg-table"><thead><tr><th>#</th>{shown.map(c => <th key={c.id} className={c.linked ? 'mg-live' : undefined} title={c.linked ? `Live Data${c.linked.source_group_name ? ` from ${c.linked.source_group_name}` : ''}${c.linked.readOnly ? ' · view only' : ''}` : undefined}>{c.name}{c.linked && <span className="sr-only"> (Live Data{c.linked.readOnly ? ', view only' : ''})</span>}</th>)}</tr></thead><tbody>{(page?.rows || []).map((r: Row, i: number) => <tr key={r.id}><th>{offset + i + 1}</th>{shown.map(c => <td key={c.id} style={cellColors(r, c)}>{c.type === 'ATTACHMENT' ? <button type="button" onClick={() => attachments(id, r.values?.[c.id] || [], c.name)}><Paperclip size={15} />{(r.values?.[c.id] || []).length} files</button> : board.group.caps.editRows && c.type !== 'FORMULA' && !c.linked?.readOnly ? <button type="button" aria-label={`Edit ${c.name}: ${text(c, r) || 'empty'}`} onClick={() => { void edit(id, r, c, () => setRefresh(s => s + 1)).catch(e => setError(e.message)); }}>{text(c, r) || '—'}</button> : <span>{text(c, r) || '—'}</span>}</td>)}</tr>)}</tbody></table>
        {!shown.length && <p className="hint mg-note">Choose at least one column to display.</p>}{page && !page.rows.length && <p className="hint mg-note">No matching records.</p>}</div>
      {page && <div className="mg-paging"><button type="button" className="btn" disabled={busy || offset === 0} aria-label="Previous records" onClick={() => setOffset(n => Math.max(0, n - 50))}><ChevronLeft /></button><span>{page.total ? offset + 1 : 0}–{offset + page.rows.length} / {page.total}</span><button type="button" className="btn" disabled={busy || offset + page.rows.length >= page.total} aria-label="Next records" onClick={() => setOffset(n => n + 50)}><ChevronRight /></button></div>}
    </>}
  </section>;
}

export function MiniGroupAttachments({ groupId, files, title, read, command, viewFile, download, onClose, layer }: Common & { groupId: string; files: Row[]; title: string; viewFile: (f: Row) => void; download: (f: Row) => void; onClose: () => void; layer: (close: () => void) => void }) {
  const delivery = useCallback((key: string) => read('/group-delivery?' + new URLSearchParams({ id: groupId, delivery: key })), [groupId, read]);
  const withCell = (f: Row) => ({ ...f, group_id: groupId, cell_files: files });
  const [sending, setSending] = useState(false);
  // Send to Telegram sits above the files (no scrolling to find it) and opens a full-screen selection sheet.
  return <section className="mini-groups mg-attachments"><header className="page-header"><button type="button" className="icon-btn" onClick={onClose} aria-label="Close attachments"><ChevronLeft /></button><h1>{title}</h1></header>
    {files.length > 0 && <div className="mg-send-bar"><button type="button" className="btn primary mg-send-open" onClick={() => setSending(true)}><Send aria-hidden="true" />Send to Telegram</button>
      <span className="hint small">{files.length} {files.length === 1 ? 'file' : 'files'} · choose which to send</span></div>}
    {files.length ? <ul className="mg-files">{files.map(f => <li key={f.id}><button type="button" className="mg-filename" onClick={() => viewFile(withCell(f))}><span className="mg-file-name">{f.name}</span><span className="mg-file-meta">{fileKind(f)}{f.size ? ` · ${fileSize(f.size)}` : ''}</span></button><button type="button" className="icon-btn" aria-label={`Download ${f.name}`} onClick={() => download(withCell(f))}><Download /></button></li>)}</ul>
      : <p className="hint">No files in this cell.</p>}
    {sending && <MiniDeliverySheet groupId={groupId} files={files} read={delivery} command={command} layer={layer} onClose={() => setSending(false)} />}
  </section>;
}
