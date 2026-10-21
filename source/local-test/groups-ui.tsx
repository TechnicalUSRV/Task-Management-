import { Share2 } from 'lucide-react';
import { CheckboxField } from './ui-kit';
import { formatColumnNumber, cellColors } from './group-presentation';
import { CellFormatControl } from './group-cell-format';
import { GroupDelivery } from './group-delivery-ui';
import { ShareDataDialog } from './group-sharing-ui';
import { AddLiveColumnDialog, LIVE_ERRORS, LiveHistoryDialog, ShareLiveDialog, viewColumn } from './group-live-ui';
import './styles/group-live.css';
// Task Management → Workspace → Groups → a group (V5.4). A group is a customizable table: its own columns (Text, Date,
// Number, Status, In Charge, Support, Formula, and V5.6.9 Attachment), rows, sharing and formulas. The server checks and calculates everything;
// this screen previews formulas with the same rules (group-domain.mjs) and never shows a save before the server confirms it.
import { apiFetch, apiPath } from './api-client';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import {
  Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, Calculator, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Columns3, Download, Expand, Eye, EyeOff, GripVertical, Hash, History,
  LayoutList, Link2, ListFilter, Loader2, Lock, MessageSquareText, MoreHorizontal, MoreVertical, Paperclip, FileText, FileImage, Pencil, Plus, RotateCcw, Save, Search, Settings2, Sheet, Tags, Trash2, Type, Upload, User, Users, X, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { Row } from './components';
import type { Workspace } from './ui';
import {
  COLUMN_TYPES, COLUMN_HINTS, STATUS_COLORS, DEFAULT_STATUS_LABELS, LEVELS, LEVEL_LABELS, LEVEL_HINTS, FORMULA_FUNCTIONS, FORMULA_RULES, FORMULA_ERRORS, GROUP_LIMITS,
  groupCaps, cellText, formatResult, formatDay, cleanCell, columnNameError, compileFormula, previewFormula, statusLabels, emptyValue, levelKey,
} from './group-domain.mjs';
import { groupCommand, groupRead, type GroupError } from './group-api';
import { GroupFilePreview } from './file-preview';
import { TASK_FILE_TYPES, TASK_FILE_ACCEPT } from './task-domain.mjs';
import { CameraAttachment } from './camera-attachment';
import { fileToBase64 } from './media';
import { NotesDrawer, AccessRuleDialog, ExportDialog, type RuleTarget } from './group-tools-ui';
import { ImportWizard } from './group-import-ui';
import { GoogleSheetsPanel, syncLabel } from './group-sync-ui';
import { useViewState } from './router';
import { formatDateTime, plural } from './format';
import { Alert, Avatar, EmptyState, ErrorState, ExpandableText, Field, FilterBar, FormSection, IconButton, Picker, SearchInput, Segmented, StatusBadge, ToggleFilter, useConfirm, type FilterChip } from './ui-kit';

type ColumnType = keyof typeof COLUMN_TYPES;
const TYPE_ICON: Record<string, LucideIcon> = { TEXT: Type, DATE: CalendarDays, NUMBER: Hash, STATUS: Tags, IN_CHARGE: User, SUPPORT: Users, FORMULA: Calculator, ATTACHMENT: Paperclip };
const TYPE_ORDER = Object.keys(COLUMN_TYPES) as ColumnType[];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const cellKey = (row: string, col: string) => `${row}:${col}`;

// ------------------------------------------------------------------ small helpers
const inactiveIds = (w: Workspace) => new Set<string>([...w.data.lookups.filter((l: Row) => l.kind === 'staff' && !l.active).map((l: Row) => l.id), ...(w.data.tm_profiles || []).filter((p: Row) => !p.active).map((p: Row) => p.staff_id)]);
const personName = (w: Workspace, id: string, inactive: Set<string>) => `${w.lookup(id)}${inactive.has(id) ? ' (inactive)' : ''}`;
const visibilityText = (w: Workspace, b: Row) => {
  if (b.visibility !== 'TEAM') return b.owner_id === w.actor ? 'Personal · only you' : `Personal · only ${w.lookup(b.owner_id)}`;
  if (b.audience === 'WORKSPACE') return `Team · everyone in ${w.data.tm_workspaces.find((x: Row) => x.id === b.workspace_id)?.name || 'the workspace'}`;
  const n = (w.data.tm_board_access || []).filter((a: Row) => a.board_id === b.id).length + 1;
  return `Team · ${n} ${plural(n, 'person', 'people')}`;
};
const capsFor = (w: Workspace, b: Row) => { const wsArchived = w.data.tm_workspaces.find((x: Row) => x.id === b.workspace_id)?.status !== 'ACTIVE'; return groupCaps(b.level || 0, (a: string) => w.can('tasks.groups', a), { admin: !!b.admin, owner: b.owner_id === w.actor, archived: b.status === 'ARCHIVED' || wsArchived, wsArchived }); };
const colorClass = (c?: string) => `status-color-${String(c || 'GRAY').toLowerCase()}`;
function StatusChip({ label }: { label?: Row | null }) {
  if (!label) return null;
  return <span className={`status-chip ${colorClass(label.color)}`}>{label.name}</span>;
}

// ================================================================ the Groups section
/** V5.6.8: the open group is in the address (#/tasks/groups/<id>), so Back returns to the list; Task Management passes it in. */
export function GroupsView({ w, workspace, setWorkspace, openId, setOpenId }: { w: Workspace; workspace: string; setWorkspace: (v: string) => void; openId: string; setOpenId: (id: string) => void }) {
  const d = w.data, boards: Row[] = d.tm_boards || [], canCreateIn: string[] = d.tm_group_workspaces || [];
  const [f, setF] = useViewState('groups:list', { query: '', archived: false });
  const [editing, setEditing] = useState<Row | null>(null);
  const summaries = new Map<string, Row>((d.tm_board_summaries || []).map((x: Row) => [x.board_id, x]));
  const wsIds = new Set([...canCreateIn, ...boards.map(b => b.workspace_id)]);
  const workspaces: Row[] = d.tm_workspaces.filter((x: Row) => wsIds.has(x.id));
  const wid = workspaces.some(x => x.id === workspace) ? workspace : workspaces.find(x => boards.some(b => b.workspace_id === x.id && b.status === 'ACTIVE'))?.id || workspaces.find(x => x.status === 'ACTIVE')?.id || workspaces[0]?.id || '';
  const inWs = boards.filter(b => b.workspace_id === wid);
  const list = inWs.filter(b => (f.archived || b.status === 'ACTIVE') && `${b.name} ${b.description}`.toLowerCase().includes(f.query.toLowerCase()));
  const canCreate = w.can('tasks.groups', 'create') && canCreateIn.includes(wid);
  const ws = workspaces.find(x => x.id === wid);
  const open = boards.find(b => b.id === openId);
  const create = () => setEditing({ workspace_id: wid });
  const dialog = editing && <GroupSettingsDialog w={w} group={editing.id ? editing : null} workspaceId={editing.workspace_id || wid} tab={editing.tab} onClose={() => setEditing(null)} onSaved={id => { setEditing(null); if (id) setOpenId(id); }} />;
  if (open) return <><GroupBoard key={open.id} w={w} id={open.id} onBack={() => setOpenId('')} onOpen={setOpenId} onEdit={tab => setEditing({ ...open, tab })} />{dialog}</>;
  const chips = buildGroupChips(f, setF);
  return (
    <>
      {/* V5.6.8: the workspace picker and the page's action on one line, the button level with the picker (the count of
          groups is in the summary below). */}
      <div className="groups-top">
        <Picker label="Workspace" value={wid} allowNone={false} options={workspaces.map(x => [x.id, x.name + (x.status === 'ARCHIVED' ? ' (archived)' : '')])} onChange={v => setWorkspace(v)} className="groups-ws-picker" />
        {canCreate && <Button onClick={create}><Plus />Create group</Button>}
      </div>
      {!workspaces.length ? <EmptyState icon={Sheet} title="No workspace to add groups to" description="Groups live inside a workspace. Ask a workspace owner to add you to their workspace, or create a workspace first." />
        : <>
          <FilterBar className="mt-4" search={<SearchInput value={f.query} onChange={v => setF(s => ({ ...s, query: v }))} label="Search groups" placeholder="Search group name or description…" />}
            filters={<ToggleFilter label="Show archived" pressed={f.archived} onChange={v => setF(s => ({ ...s, archived: v }))} />}
            chips={chips} onReset={() => setF({ query: '', archived: false })} summary={<><strong>{list.length}</strong> {plural(list.length, 'group')} in {ws?.name}</>} />
          {list.length ? <div className="card-grid">
            {list.map(b => {
              const cols = summaries.get(b.id)?.columns || 0, rows = summaries.get(b.id)?.rows || 0;
              return (
                <article key={b.id} className={`group-card${b.status === 'ARCHIVED' ? ' is-archived' : ''}`}>
                  <div className="group-card-top">
                    <span className="group-icon" aria-hidden="true">{b.visibility === 'TEAM' ? <Users /> : <Lock />}</span>
                    <div className="group-card-heading">
                      <h3><button type="button" className="group-name" onClick={() => setOpenId(b.id)}>{b.name}</button></h3>
                      <p className="muted small">{visibilityText(w, b)}</p>
                    </div>
                    {b.status === 'ARCHIVED' && <StatusBadge value="ARCHIVED" />}
                  </div>
                  <ExpandableText className="group-description" text={b.description} lines={2} empty={<p className="muted small">No description.</p>} />
                  <p className="group-card-meta"><span className="num">{cols} {plural(cols, 'column')}</span><span className="num">{rows} {plural(rows, 'row')}</span><span>{LEVEL_LABELS[levelKey(b.level) as keyof typeof LEVEL_LABELS]}</span></p>
                  <div className="group-card-foot"><span className="person-cell small"><Avatar name={w.lookup(b.owner_id)} size="sm" />{w.lookup(b.owner_id).split(' · ')[0]}</span><Button size="sm" variant="outline" onClick={() => setOpenId(b.id)}>Open<ChevronRight /></Button></div>
                </article>
              );
            })}
          </div> : chips.length ? <EmptyState title="No matching groups" action={<Button size="sm" variant="outline" onClick={() => setF({ query: '', archived: false })}>Clear filters</Button>} />
            : <EmptyState icon={Sheet} title={`No groups in ${ws?.name || 'this workspace'} yet`} description="A group is a table you design: add the columns you need (text, dates, numbers, statuses, people and formulas), then add rows. Keep it personal, or share it with the workspace."
              action={canCreate ? <Button size="sm" onClick={create}><Plus />Create group</Button> : <p className="muted small">Your role can’t create groups here. Groups shared with you appear in this list.</p>} />}
        </>}
      {dialog}
    </>
  );
}
function buildGroupChips(f: { query: string; archived: boolean }, setF: (fn: (s: { query: string; archived: boolean }) => { query: string; archived: boolean }) => void): FilterChip[] {
  const out: FilterChip[] = [];
  if (f.query) out.push({ key: 'q', label: <>Search: “{f.query}”</>, text: `Search ${f.query}`, onRemove: () => setF(s => ({ ...s, query: '' })) });
  if (f.archived) out.push({ key: 'a', label: 'Including archived', text: 'Including archived', onRemove: () => setF(s => ({ ...s, archived: false })) });
  return out;
}

// ================================================================ one group
/** `draft`: what was typed (kept to try again after an error); `shown`: the value being saved, as the column keeps it. */
type CellState = { state: 'saving' | 'saved' | 'error'; message?: string; draft?: unknown; shown?: unknown };
type Filter = { col: string; value?: string; min?: string; max?: string; from?: string; to?: string };
type ViewState = { q: string; sort: { col: string; dir: 'asc' | 'desc' } | null; filters: Filter[]; page: number; mode: '' | 'table' | 'cards'; size: number; showHidden: boolean };
const VIEW_DEFAULT: ViewState = { q: '', sort: null, filters: [], page: 0, mode: '', size: 50, showHidden: false };
const PAGE_SIZES = [25, 50, 100, 200];
const DEFAULT_WIDTH: Record<string, number> = { TEXT: 240, DATE: 140, NUMBER: 130, STATUS: 160, IN_CHARGE: 190, SUPPORT: 230, FORMULA: 140, ATTACHMENT: 220 };
const clampWidth = (n: number, [min, max]: number[] = GROUP_LIMITS.width) => Math.round(Math.max(min, Math.min(max, n)));
// V5.5.1: no selection column. Rows are selected on their numbers, like Excel: click, drag, Shift+click, Ctrl+click.
const NUMBER_W = 108;
type ColumnDrag = { id: string; pointer: number; startX: number; startScroll: number; x: number; y: number; moved: boolean; frame: number; time: number; to: number; painted?: boolean; target: HTMLElement; columns: { id: string; left: number; width: number }[] };
const columnStyle = (id: string) => ({ transform: `var(--column-shift-${id})` });
type RowDrag = { pointer: number; anchor: number; current: number; mode: 'replace' | 'add' | 'remove'; base: Record<string, number>; moved: boolean; y: number; startY: number; wasOnly: boolean; frame: number; count: number; touch: boolean };
/** A row to open for typing once a page load that started after it was asked for arrives (`@first`: the first row of
 *  that page). `after`: the number of the last load started before; `ahead`: what is being typed for it (Enter). */
type Pending = { row: string; col: string; offset: number; after: number; ahead?: TypeAhead };
/** What is typed while the row an Enter moves to is on its way (a new row, or the first row of the next page): one entry
 *  per row, each Enter starts the next. `end`: Escape (`cancel`: the last entry is dropped) or Tab, a click elsewhere or
 *  the time limit (`keep`: it is saved without opening the cell); once ended, keys are no longer caught. `away`: the
 *  person has moved on (Tab, a click), so nothing opens and the keyboard focus is left where it is.
 *  `text`: the column takes typed text (text and number columns); `lines`: Shift+Enter starts a new line (text);
 *  `ghost`: a new row is being added, shown under the table meanwhile; `until`: when keys stop being caught, for a whole
 *  run of rows typed ahead. */
type TypeAhead = { col: string; parts: string[]; text: boolean; lines: boolean; ghost: boolean; until: number; end?: 'cancel' | 'keep'; away?: boolean };
type Step = { kind: 'row'; index: number } | { kind: 'page' | 'add' | 'stop' };
/** Toolbar buttons that may move into the “More” menu, and from which level (see GroupBoard). */
const FIT_ITEMS: [string, number][] = [['import', 1], ['export', 1], ['column', 2], ['settings', 2]];

/** What the server reads a page with: search, filters, sorting, paging, and whether the rows I hid are included. */
function queryOf(v: ViewState): Record<string, string> {
  const p: Record<string, string> = { offset: String(v.page * v.size), limit: String(v.size) };
  if (v.q.trim()) p.q = v.q.trim();
  if (v.filters.length) p.filters = JSON.stringify(v.filters);
  if (v.sort) { p.sort = v.sort.col; p.dir = v.sort.dir; }
  if (v.showHidden) p.hidden = '1';
  return p;
}

function GroupBoard({ w, id, onBack, onOpen, onEdit }: { w: Workspace; id: string; onBack: () => void; onOpen: (id: string) => void; onEdit: (tab?: string) => void }) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false);
  const [saved, setView] = useViewState<ViewState>(`group:${id}:view`, VIEW_DEFAULT);
  const view: ViewState = { ...VIEW_DEFAULT, ...saved, size: PAGE_SIZES.includes(saved.size) ? saved.size : 50 };
  const [search, setSearch] = useState(view.q);
  const [active, setActive] = useState<{ row: string; col: string } | null>(null);
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [shareColumn, setShareColumn] = useState<Row | null>(null);
  // Share Live Data (connected data) for a column or the whole group, a new Live Data column, and the edit history.
  const [liveShare, setLiveShare] = useState<{ column?: string } | null>(null), [liveColumn, setLiveColumn] = useState<{ after?: string } | null>(null);
  const [liveHistory, setLiveHistory] = useState<{ group: string; name?: string; column?: string } | null>(null);
  const [columnDialog, setColumnDialog] = useState<{ column?: Row; after?: string } | null>(null);
  const [cellDialog, setCellDialog] = useState<{ row: Row; col: Row } | null>(null);
  const [showAccess, setShowAccess] = useState(false), [showActivity, setShowActivity] = useState(false), [filterFor, setFilterFor] = useState<Row | null>(null), [busy, setBusy] = useState(false);
  const [notesFor, setNotesFor] = useState<{ row: Row; title: string } | null>(null), [ruleFor, setRuleFor] = useState<RuleTarget | null>(null);
  const [exporting, setExporting] = useState(false), [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({}), [allMatching, setAllMatching] = useState(false), [matchKey, setMatchKey] = useState('');
  const [menu, setMenu] = useState<{ row: string; bulk: boolean } | null>(null);
  const [rownumDraft, setRownumDraft] = useState<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({}), [drag, setDrag] = useState<{ id: string; to: number } | null>(null), [announce, setAnnounce] = useState('');
  // The row an Enter on the last row is adding, shown (with what is typed for it) until the server has added it.
  const [ghost, setGhost] = useState<{ col: string; parts: string[]; end?: string } | null>(null);
  // Toolbar buttons that move into the “More” menu when the toolbar would not fit on one line: 1 = Import and Export
  // data, 2 = also Add column and Settings & sharing. On wide screens everything stays in the toolbar.
  const [fit, setFit] = useState(0);
  const confirm = useConfirm(), inactive = useMemo(() => inactiveIds(w), [w.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
  const mode = view.mode || (narrow ? 'cards' : 'table');
  const query = queryOf(view), queryKey = JSON.stringify(query);
  const seqRef = useRef(0), hasData = useRef(false), wrapRef = useRef<HTMLDivElement>(null), bodyRef = useRef<HTMLTableSectionElement>(null), headRefs = useRef(new Map<string, HTMLElement>()), dragRef = useRef<ColumnDrag | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null), fitWidths = useRef(new Map<string, number>()), fitRef = useRef(0), minRoom = useRef([0, 0, 0]);
  // The anchor of Shift+click / Shift+Arrow selection is a row (not a position), so a refresh that moves rows can't shift it.
  const rowDrag = useRef<RowDrag | null>(null), anchorRef = useRef<string | null>(null), pendingOpen = useRef<Pending[]>([]), rowsRef = useRef<Row[]>([]), escapeRef = useRef<() => void>(() => {});
  // Enter on the last row (or the last row of a page): what is typed while the next row is on its way (`typeAhead`), then
  // put into its editor (`seed`); `enterTo`: the cell opened by Enter, whose text is selected so that typing replaces it
  // (as in Excel); `resume`: puts what was typed in place once the row is there (set on every render).
  const typeAhead = useRef<TypeAhead | null>(null), seed = useRef<{ key: string; text: string } | null>(null), enterTo = useRef('');
  const ghostCell = useRef<HTMLTableCellElement>(null);
  const resume = useRef<(target: string | null, p: Pending, ahead: TypeAhead | null) => void>(() => {});
  const gripHint = useId();
  const suppressColumnClick = useRef(false);
  const cancelColumnDrag = useCallback(() => {
    const current = dragRef.current;
    if (!current) return;
    dragRef.current = null; window.cancelAnimationFrame(current.frame); setDrag(null);
    const wrap = wrapRef.current;
    current.columns.forEach(c => wrap?.style.removeProperty(`--column-shift-${c.id}`));
    for (const key of ['--column-drop-left', '--column-drop-width', '--column-drop-height']) wrap?.style.removeProperty(key);
    suppressColumnClick.current = current.moved;
    if (current.target.hasPointerCapture(current.pointer)) current.target.releasePointerCapture(current.pointer);
  }, []);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && dragRef.current) { e.preventDefault(); e.stopPropagation(); cancelColumnDrag(); setAnnounce('Column move cancelled.'); } };
    document.addEventListener('keydown', key, true); window.addEventListener('blur', cancelColumnDrag); window.addEventListener('resize', cancelColumnDrag);
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancelColumnDrag); window.removeEventListener('resize', cancelColumnDrag); if (dragRef.current) window.cancelAnimationFrame(dragRef.current.frame); };
  }, [cancelColumnDrag]);
  const columnLayoutKey = JSON.stringify([data?.columns?.map((c: Row) => [c.id, c.position, c.type]), data?.view?.order, data?.view?.hidden_columns, data?.view?.widths, data?.layout?.widths]);
  useLayoutEffect(() => { cancelColumnDrag(); }, [columnLayoutKey, mode, queryKey, cancelColumnDrag]);

  const setV = (patch: Partial<ViewState>) => setView(v => ({ ...VIEW_DEFAULT, ...v, ...patch, page: 'page' in patch ? patch.page! : 0 }));
  // Each answer is used only if it is the latest request (a slow earlier search never replaces a newer one). A load reads
  // the current search, filters, sorting and page, also when it was started by a change made before they changed.
  const queryRef = useRef(queryKey);
  queryRef.current = queryKey;
  const load = useCallback(async (quiet = false) => {
    const n = ++seqRef.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    try { const body = await groupRead('/api/tasks/group', { id, ...JSON.parse(queryRef.current) }); if (n === seqRef.current) { setData({ ...body, _load: n }); setError(''); hasData.current = true; } }
    catch (e) {
      if (n !== seqRef.current) return;
      setError((e as Error).message);
      // Rows waiting to open can't be shown: what was typed for a new row is still saved in it, and the keyboard leaves the
      // cell that was being edited, so the next key can't reopen it.
      const waiting = pendingOpen.current;
      pendingOpen.current = [];
      if (!waiting.length) return;
      for (const p of waiting) resume.current(null, p, p.ahead || null);
      typeAhead.current = null; setGhost(null);
      toast.error((e as Error).message);
    }
    finally { if (n === seqRef.current) { setLoading(false); setRefreshing(false); } }
  }, [id]);
  useEffect(() => { void load(hasData.current); }, [load, queryKey]);
  // Searching waits until typing pauses.
  useEffect(() => { if (search === view.q) return; const t = window.setTimeout(() => setV({ q: search }), 300); return () => window.clearTimeout(t); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  // A selection belongs to one result: a new search, filter, sort or page clears it, so nothing invisible stays selected.
  useEffect(() => { setSelected({}); setAllMatching(false); anchorRef.current = null; }, [queryKey]);
  // Changes by other people arrive with the Task Controlling Management's regular refresh; nothing is reloaded while a cell is being edited or
  // rows are being selected with the pointer.
  const seq = w.data.change_seq;
  useEffect(() => { if (hasData.current && !active && !rowDrag.current && !dragRef.current) void load(true); }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Before the page is painted, so a row being added never shows twice (as the new row and under the table).
  useLayoutEffect(() => {
    if (!data) return;
    const list: Row[] = data.page.rows, ids = new Set(list.map((r: Row) => r.id));
    setSelected(s => { const next = Object.fromEntries(Object.entries(s).filter(([k]) => ids.has(k))); return Object.keys(next).length === Object.keys(s).length ? s : next; });
    if (!list.length && data.page.total > 0 && view.page > 0) setV({ page: Math.max(0, Math.ceil(data.page.total / view.size) - 1) });
    // A row just added (or the first row of the next page, after Enter on the last row of a page) opens for typing, with
    // anything typed meanwhile. Only a load started after the request settles it (a cell saved meanwhile doesn't); if
    // that page isn't the one expected, or the row isn't on it, nothing opens.
    const due = pendingOpen.current.filter(p => (data._load || 0) > p.after);
    if (!due.length) return;
    pendingOpen.current = pendingOpen.current.filter(p => !due.includes(p));
    for (const p of due) {
      const target = data.page.offset === p.offset ? (p.row === '@first' ? list[0]?.id : p.row) : undefined, ahead = p.ahead || null;
      const at = target && ids.has(target) ? target : null;
      if (!ahead || typeAhead.current === ahead) {
        if (ahead) { typeAhead.current = null; setGhost(null); }
        resume.current(at, p, ahead);
        if (!at && p.row !== '@first' && !ahead?.away) toast.info('The new row was added on another page (rows were added meanwhile).');
      }
      // A later Enter (after a click elsewhere) is typing for its own row: this one only keeps what was typed for it.
      else resume.current(at, p, { ...ahead, parts: ahead.parts.slice(0, 1), end: ahead.parts.length > 1 ? 'keep' : ahead.end ?? 'keep', away: true });
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the toolbar keeps to one line where it can
  const selecting = !!data && (allMatching || Object.keys(selected).length > 0);
  const measureFit = useCallback(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const cs = getComputedStyle(el), gap = parseFloat(cs.columnGap) || 0, room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let fixed = 0, count = 0;
    const shown: HTMLElement[] = [];
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const ccs = getComputedStyle(child);
      if (ccs.display === 'none' || ccs.position === 'absolute') continue;
      shown.push(child);
      const key = child.dataset.fit, width = (Number(child.dataset.minWidth) || child.getBoundingClientRect().width) + parseFloat(ccs.marginLeft) + parseFloat(ccs.marginRight);
      if (key) fitWidths.current.set(key, width); else { fixed += width; count++; }
    }
    // Wrapped onto a second line although the widths said it would fit: this level needs more room than that.
    const wrapped = shown.length > 1 && shown.some(c => c.offsetTop > shown[0].offsetTop + 6);
    if (wrapped && fitRef.current < 2) minRoom.current[fitRef.current] = Math.max(minRoom.current[fitRef.current], room + 1);
    // The width needed when only the buttons of levels above `level` stay in the toolbar.
    const need = (level: number) => {
      let total = fixed, n = count;
      for (const [key, at] of FIT_ITEMS) { const width = fitWidths.current.get(key); if (width === undefined || at <= level) continue; total += width; n++; }
      return total + gap * Math.max(0, n - 1);
    };
    let next = 0;
    while (next < 2 && (need(next) > room + 0.5 || room < minRoom.current[next])) next++;
    fitRef.current = next;
    setFit(f => (f === next ? f : next));
  }, []);
  useLayoutEffect(() => { measureFit(); }, [measureFit, fit, mode, !!data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keys typed while the row an Enter moves to is on its way are kept for it (Enter and Backspace included), so nothing is
  // lost and nothing reaches the cell that was just left. Escape cancels what was typed for that row and Tab or a click
  // elsewhere keeps it (it is saved); after these, keys go where they normally go.
  useEffect(() => {
    const named = /^(?:[A-Z][A-Za-z0-9]+)$/; // key names (Enter, ArrowLeft, F2, Dead…), as opposed to typed characters
    const show = (a: TypeAhead) => { if (a.ghost) setGhost({ col: a.col, parts: [...a.parts], end: a.end }); };
    const onKey = (e: Event) => {
      const k = e as globalThis.KeyboardEvent, t = k.target as HTMLElement | null, a = typeAhead.current;
      if (!a || a.end || k.isComposing || t?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const swallow = () => { k.preventDefault(); k.stopPropagation(); };
      // Shortcuts pass, except the keys that would reopen the cell just left. AltGr (Ctrl+Alt on Windows) types characters.
      if (k.metaKey || ((k.ctrlKey || k.altKey) && !k.getModifierState?.('AltGraph'))) { if (k.key === 'Enter' || k.key === 'F2') swallow(); return; }
      if (/^(?:Shift|Control|Alt|AltGraph|Meta|CapsLock|NumLock|Fn)$/.test(k.key)) return;
      if (k.key === 'Tab') { a.end = 'keep'; a.away = true; show(a); return; }
      swallow();
      const n = a.parts.length - 1;
      if (k.key === 'Escape') { a.end = 'cancel'; if (bodyRef.current?.contains(document.activeElement)) wrapRef.current?.focus({ preventScroll: true }); }
      else if (k.key === 'Enter') { if (k.shiftKey && a.lines) a.parts[n] += '\n'; else a.parts.push(''); }
      else if (k.key === 'Backspace') a.parts[n] = Array.from(a.parts[n]).slice(0, -1).join('');
      else if (a.text && !named.test(k.key)) a.parts[n] += k.key;
      else return;
      show(a);
    };
    const onPointer = () => { const a = typeAhead.current; if (a && !a.away) { a.away = true; a.end ??= 'keep'; show(a); } };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onPointer, true); };
  }, []);
  // The row being added comes into view, as the cell typed in would.
  useLayoutEffect(() => { if (ghost) ghostCell.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [ghost?.parts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape clears the selection also when nothing in particular has the keyboard focus.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: Event) => { const k = e as globalThis.KeyboardEvent; if (k.key === 'Escape' && !k.defaultPrevented && (k.target === document.body || k.target === document.documentElement)) escapeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting]);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureFit, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const boards: Row[] = (w.data.tm_boards || []).filter((b: Row) => data && b.workspace_id === data.group.workspace_id && (b.status === 'ACTIVE' || b.id === id));
  if (loading && !data) return <div className="group-loading" role="status"><Loader2 className="spin" aria-hidden="true" />Opening the group…</div>;
  if (error && !data) return <><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />All groups</Button><ErrorState message={error} onRetry={() => void load()} /></>;
  if (!data) return null;
  // Live Data columns are shown, filtered and edited as their source column's type (`linked` keeps the connection).
  const g: Row = data.group, columns: Row[] = data.columns.map(viewColumn), page: Row = data.page, rows: Row[] = page.rows, caps: Row = g.caps;
  rowsRef.current = rows;
  const personal: Row = data.view || {}, sharedLayout: Row = data.layout || {};
  const nameOf = (x: string) => personName(w, x, inactive);
  const valueOf = (col: Row, row: Row) => (col.type === 'FORMULA' ? row.computed?.[col.id] : row.values?.[col.id]);
  const text = (col: Row, row: Row) => cellText(col, valueOf(col, row), nameOf);

  // ---------------------------------------------------------------- columns: my order, my widths, my hidden columns
  const order: string[] = Array.isArray(personal.order) ? personal.order : [];
  const rank = (c: Row) => { const i = order.indexOf(c.id); return i < 0 ? 1e6 + c.position : i; };
  const ordered = [...columns].sort((a, b) => rank(a) - rank(b) || a.position - b.position);
  const hiddenCols = new Set<string>(personal.hidden_columns || []), hiddenRows = new Set<string>(personal.hidden_rows || []);
  const shown = ordered.filter(c => !hiddenCols.has(c.id));
  const widthOf = (c: Row): number => widths[c.id] ?? personal.widths?.[c.id] ?? sharedLayout.widths?.[c.id] ?? DEFAULT_WIDTH[c.type] ?? 180;
  // V5.6.9: the row-number column on the left can be resized like the others (kept in my view, or the shared default).
  const rownumW: number = rownumDraft ?? personal.rownum ?? sharedLayout.rownum ?? NUMBER_W;
  // The table is exactly as wide as its columns, so widening or narrowing one column never resizes the others: the
  // columns after it just move along (as in a spreadsheet).
  const tableWidth = rownumW + shown.reduce((n, c) => n + widthOf(c), 0);
  const firstCol = shown.find(c => c.type !== 'FORMULA' && c.type !== 'ATTACHMENT') || shown[0];
  const rowLabel = (r: Row, n: number) => { const t = firstCol ? text(firstCol, r).trim().split('\n')[0] : ''; return t ? `Row ${n} (${t.slice(0, 40)})` : `Row ${n}`; };
  const filtering = !!(view.q.trim() || view.filters.length);
  const reorderable = !view.sort && !filtering && (!page.hidden_mine || view.showHidden);
  const canSettings = !!(caps.rename || caps.share || caps.visibility);
  // The last row of the whole table (the last page): Enter there adds a new row.
  const lastRowId = caps.addRows && !filtering && !view.sort && page.offset + rows.length >= page.total && rows.length ? rows[rows.length - 1].id : null;

  // ---------------------------------------------------------------- saving
  const replaceRow = (next: Row) => setData(d => d && ({ ...d, page: { ...d.page, rows: d.page.rows.map((r: Row) => (r.id === next.id ? { ...r, ...next, notes: next.notes ?? r.notes } : r)) } }));
  const structure = async (action: string, body: Row, message?: string) => {
    setBusy(true);
    try { const r = await groupCommand(action, { group_id: id, ...body }); await load(true); void w.refresh({ quiet: true }); if (message !== '') toast.success(message || r.message || 'Saved'); return r; }
    finally { setBusy(false); }
  };
  const saveView = async (patch: Row, message?: string, reload = false) => {
    setData(d => d && ({ ...d, view: { ...d.view, ...patch } }));
    try { await groupCommand('tm.group.view.save', { group_id: id, view: patch }); if (message) toast.success(message); if (reload) await load(true); }
    catch (e) { toast.error((e as Error).message); await load(true); }
  };
  const saveCell = async (row: Row, col: Row, value: unknown): Promise<boolean> => {
    const key = cellKey(row.id, col.id), before = row.values?.[col.id] ?? null;
    const check = cleanCell(col, value, { eligible: null, current: before });
    if (!check.ok) { setCells(s => ({ ...s, [key]: { state: 'error', message: (check as Row).error, draft: value } })); return false; }
    if (same(check.value, before)) { setCells(s => { const n = { ...s }; delete n[key]; return n; }); return true; }
    setCells(s => ({ ...s, [key]: { state: 'saving', draft: value, shown: check.value } }));
    try {
      const r = await groupCommand('tm.group.row.update', { group_id: id, id: row.id, values: { [col.id]: check.value }, expected: { [col.id]: before } });
      if (r.row) replaceRow(r.row);
      setCells(s => ({ ...s, [key]: { state: 'saved' } }));
      window.setTimeout(() => setCells(s => { if (s[key]?.state !== 'saved') return s; const n = { ...s }; delete n[key]; return n; }), 1800);
      return true;
    } catch (e) {
      const err = e as GroupError;
      setCells(s => ({ ...s, [key]: { state: 'error', message: err.message, draft: value } }));
      // Someone else changed it: show their value; what this person typed stays in the editor to try again.
      if (err.details?.code === 'cell_conflict' || err.details?.code === 'column_missing' || err.status === 404) void load(true);
      return false;
    }
  };
  const discard = (row: Row, col: Row) => setCells(s => { const n = { ...s }; delete n[cellKey(row.id, col.id)]; return n; });
  /** Adds a row (below `after`, or at the end) and opens it for typing in `openCol` (else the first column). */
  const addRow = async (after?: string, openCol?: string, quiet = false, ahead?: TypeAhead) => {
    setBusy(true);
    try {
      const r = await groupCommand('tm.group.row.add', { group_id: id, ...(after ? { after } : {}) });
      const colId = openCol || (firstCol && firstCol.type !== 'FORMULA' ? firstCol.id : '');
      const last = Math.floor(page.total / view.size), toLast = !after && !filtering && !view.sort && last !== view.page;
      if (r.id && colId && mode === 'table') pendingOpen.current = [...pendingOpen.current, { row: r.id, col: colId, offset: (toLast ? last : view.page) * view.size, after: seqRef.current, ahead }];
      else if (ahead && typeAhead.current === ahead) { typeAhead.current = null; setGhost(null); }
      if (toLast) setV({ page: last }); else await load(true);
      if (quiet) setAnnounce('Row added.');
      else toast.success(filtering ? 'Row added. It may not match your search or filters.' : view.sort ? 'Row added. With this sorting it may be on another page.' : 'Row added.');
    } catch (e) { if (ahead && typeAhead.current === ahead) { typeAhead.current = null; setGhost(null); } toast.error((e as Error).message); } finally { setBusy(false); }
  };
  // Enter in a cell (V5.5.1, like Excel): save, then edit the same column in the row below. On the last row of the
  // table a new row is added first, unless that last row is still completely empty.
  // With a search, filters or sorting active the new row could land out of sight, so Enter there just saves.
  const canAdd = (row: Row, col: Row, value: unknown) => {
    const empty = (v: unknown) => emptyValue(typeof v === 'string' ? v.trim() : v);
    return !!caps.addRows && !filtering && !view.sort && columns.some(c => c.type !== 'FORMULA' && !empty(c.id === col.id ? value : row.values?.[c.id]));
  };
  const nextStep = (list: Row[], row: Row, col: Row, value: unknown): Step => {
    const i = list.findIndex(r => r.id === row.id);
    if (i < 0) return { kind: 'stop' };
    if (i + 1 < list.length) return { kind: 'row', index: i + 1 };
    if (page.offset + list.length < page.total) return { kind: 'page' };
    return { kind: canAdd(row, col, value) ? 'add' : 'stop' };
  };
  /** Goes on to the next page's first row, or a new row, keeping what is typed until it is there. */
  const goOn = (step: 'page' | 'add', col: Row, from: TypeAhead | null) => {
    const ahead: TypeAhead = { ...(from || { col: col.id, parts: [''], text: col.type === 'TEXT' || col.type === 'NUMBER', lines: col.type === 'TEXT', until: Date.now() + 10000 }), ghost: step === 'add' };
    typeAhead.current = ahead;
    setGhost(ahead.ghost ? { col: col.id, parts: [...ahead.parts], end: ahead.end } : null);
    if (step === 'add') setAnnounce('Adding a row…');
    // A server that doesn't answer doesn't keep the keyboard: 10 seconds after the first Enter of a run of rows typed ahead,
    // keys go where they normally go again (what was typed is still saved when the row comes).
    window.setTimeout(() => {
      if (typeAhead.current !== ahead || ahead.end) return;
      ahead.end = 'keep'; ahead.away = true;
      if (ahead.ghost) setGhost({ col: ahead.col, parts: [...ahead.parts], end: ahead.end });
      if (bodyRef.current?.contains(document.activeElement)) wrapRef.current?.focus({ preventScroll: true });
    }, Math.max(0, ahead.until - Date.now()));
    if (step === 'page') { pendingOpen.current = [...pendingOpen.current, { row: '@first', col: col.id, offset: page.offset + view.size, after: seqRef.current, ahead }]; setV({ page: view.page + 1 }); }
    else void addRow(undefined, col.id, true, ahead);
  };
  const advance = (row: Row, col: Row, value: unknown) => {
    const list = rowsRef.current, step = nextStep(list, row, col, value);
    if (step.kind === 'row') { enterTo.current = cellKey(list[step.index].id, col.id); setActive({ row: list[step.index].id, col: col.id }); return; }
    setActive(null);
    if (step.kind !== 'stop') goOn(step.kind, col, null);
  };
  const focusCell = (key: string) => { const el = bodyRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(key)}"]`); el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
  // Once the row an Enter moved to is there, what was typed meanwhile goes into it, and after each Enter on into the rows
  // that follow, as if every key had reached its cell in time. The cell it ends in opens with the rest, unless Escape, Tab
  // or a click elsewhere closed it first.
  resume.current = (target, p, ahead) => {
    const col = columns.find(c => c.id === p.col), list = rowsRef.current;
    if (!col) return;
    // Typing is replayed only into text and number cells, and not into the next page while a search, filters or sorting
    // decide which row comes first there (that row just opens, as without typing ahead).
    const parts = ahead?.text && !(p.row === '@first' && (filtering || view.sort)) ? ahead.parts : [''];
    if (!target) {
      // The new row isn't on this page (rows were added by someone else meanwhile, or the page couldn't be loaded): what
      // was typed for it is still saved in it; the keyboard leaves the cell that was being edited.
      if (p.row !== '@first' && parts[0] && (parts.length > 1 || ahead?.end !== 'cancel')) void saveCell({ id: p.row, values: {} }, col, parts[0]);
      if (!ahead?.away && bodyRef.current?.contains(document.activeElement)) wrapRef.current?.focus({ preventScroll: true });
      return;
    }
    let i = list.findIndex(r => r.id === target);
    for (let n = 0; ; n++) {
      const row = list[i], typed = parts[n], key = cellKey(row.id, col.id);
      if (n === parts.length - 1) {
        if (ahead?.end) {
          if (ahead.end === 'keep' && typed) void saveCell(row, col, typed);
          // After Escape the keyboard waited on the table; it comes to this cell, as it would have.
          if (!ahead.away && (document.activeElement === wrapRef.current || document.activeElement === document.body)) focusCell(key);
          return;
        }
        if (typed) seed.current = { key, text: typed }; else enterTo.current = key;
        setActive({ row: row.id, col: col.id });
        return;
      }
      // Enter came after it: it is saved, and Enter goes on from there.
      let value = row.values?.[col.id] ?? null;
      if (typed) {
        if (!cleanCell(col, typed, { eligible: null, current: value }).ok) {
          // As if Enter had been refused: the value stays in its cell with the message and what came after it is typed on
          // into it (without what Escape cancelled). If the person has moved on, the cell just shows the message.
          const text = parts.slice(n, ahead?.end === 'cancel' ? -1 : undefined).join('');
          if (ahead?.away) { void saveCell(row, col, text); return; }
          void saveCell(row, col, typed); seed.current = { key, text }; setActive({ row: row.id, col: col.id });
          return;
        }
        void saveCell(row, col, typed); value = typed;
      }
      // After a new row come only further new rows: a row someone else added meanwhile, never seen here, isn't typed into.
      const step: Step = ahead?.ghost ? { kind: canAdd(row, col, value) ? 'add' : 'stop' } : nextStep(list, row, col, value);
      if (step.kind === 'row') { i = step.index; continue; }
      if (step.kind === 'stop') { if (!ahead?.away) focusCell(key); return; }
      goOn(step.kind, col, ahead && { ...ahead, parts: ahead.parts.slice(n + 1) });
      return;
    }
  };
  const deleteRow = async (row: Row, label: string) => {
    if (!(await confirm({ title: `Delete ${label}?`, description: 'The row and its notes are deleted. This can’t be undone; the deletion is kept in the group’s activity.', confirmLabel: 'Delete row', tone: 'danger' }))) return;
    try { await structure('tm.group.row.delete', { id: row.id, expected_version: row.version }, 'Row deleted.'); } catch (e) { toast.error((e as Error).message); await load(true); }
  };
  const moveRow = async (row: Row, by: number) => {
    const to = page.offset + rows.findIndex(r => r.id === row.id) + by;
    if (to < 0 || to >= page.total) return;
    try { await structure('tm.group.row.move', { id: row.id, to }, ''); if (to < page.offset || to >= page.offset + view.size) setV({ page: Math.floor(to / view.size) }); } catch (e) { toast.error((e as Error).message); }
  };
  const deleteColumn = async (col: Row) => {
    if (col.used_by?.length) { toast.error(`“${col.name}” is used by ${col.used_by.map((x: string) => `“${columns.find(c => c.id === x)?.name}”`).join(', ')}. Change or delete those formulas first.`); return; }
    if (!(await confirm({ title: `Delete the column “${col.name}”?`, description: 'Its values in every row are deleted too. This can’t be undone.', confirmLabel: 'Delete column', tone: 'danger' }))) return;
    try { await structure('tm.group.column.delete', { id: col.id, expected_version: col.version, confirm: true }, `Column “${col.name}” deleted.`); } catch (e) { toast.error((e as Error).message); }
  };
  const archive = async () => {
    const archiving = g.status === 'ACTIVE';
    if (!(await confirm({ title: `${archiving ? 'Archive' : 'Restore'} “${g.name}”?`, description: archiving ? `Its ${columns.length} ${plural(columns.length, 'column')} and ${page.all} ${plural(page.all, 'row')} are kept but can’t be changed while it is archived. It can be restored, or deleted permanently.` : 'The group can be changed again.', confirmLabel: archiving ? 'Archive group' : 'Restore group', tone: archiving ? 'danger' : 'default' }))) return;
    try { await structure('tm.group.archive', { id: g.id, expected_version: g.version, status: archiving ? 'ARCHIVED' : 'ACTIVE' }); } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async () => {
    const r = await confirm({ title: `Delete “${g.name}” permanently?`, description: `The group, its ${columns.length} ${plural(columns.length, 'column')} and ${page.all} ${plural(page.all, 'row')} are deleted for everyone. This can’t be undone.`, confirmLabel: 'Delete permanently', tone: 'danger', reason: { label: 'Type the group name to confirm', required: true, placeholder: g.name } });
    if (!r) return;
    if (r.reason.trim() !== g.name) { toast.error('The name you typed does not match the group name. Nothing was deleted.'); return; }
    try { await groupCommand('tm.group.delete', { id: g.id, expected_version: g.version, confirm: true }); toast.success('Group deleted.'); void w.refresh({ quiet: true }); onBack(); } catch (e) { toast.error((e as Error).message); }
  };

  // ---------------------------------------------------------------- my view: hide rows and columns (only for me)
  const hideRows = (ids: string[]) => void saveView({ hidden_rows: [...new Set([...hiddenRows, ...ids])] }, ids.length === 1 ? 'Hidden in your view. Others still see it.' : `${ids.length} rows hidden in your view. Others still see them.`, true).then(() => { setSelected({}); });
  const showRow = (rid: string) => void saveView({ hidden_rows: [...hiddenRows].filter(x => x !== rid) }, 'Shown in your view again.', true);
  const hideColumn = (col: Row) => void saveView({ hidden_columns: [...hiddenCols, col.id] }, `“${col.name}” is hidden in your view. Others still see it.`);
  const resetLayout = async () => { try { await groupCommand('tm.group.view.save', { group_id: id, reset: true }); setWidths({}); setRownumDraft(null); toast.success('Your view is back to the group’s default.'); await load(true); } catch (e) { toast.error((e as Error).message); } };
  const saveDefaultLayout = async () => {
    const all = Object.fromEntries(ordered.map(c => [c.id, widthOf(c)]));
    try { await structure('tm.group.layout.save', { layout: { widths: all, order: ordered.map(c => c.id), rownum: rownumW } }); } catch (e) { toast.error((e as Error).message); }
  };

  // ---------------------------------------------------------------- widths (drag a border, or arrow keys on it)
  const commitWidth = (c: Row) => { const v = widths[c.id]; if (v === undefined || v === personal.widths?.[c.id]) return; void saveView({ widths: { ...(personal.widths || {}), [c.id]: v } }); };
  const commitRownum = () => { if (rownumDraft === null || rownumDraft === personal.rownum) return; void saveView({ rownum: rownumDraft }); };
  // ---------------------------------------------------------------- order (drag a header, or use arrow keys on its grip)
  const saveOrder = (ids: string[], moved: string) => {
    // Columns hidden in my view keep their place in the full order.
    const full = [...ids];
    ordered.forEach((c, i) => { if (hiddenCols.has(c.id)) full.splice(Math.min(i, full.length), 0, c.id); });
    void saveView({ order: full });
    const name = columns.find(c => c.id === moved)?.name || 'Column';
    setAnnounce(`${name} moved to position ${ids.indexOf(moved) + 1} of ${ids.length}.`);
  };
  const moveColumnBy = (colId: string, by: number) => {
    const ids = shown.map(c => c.id), i = ids.indexOf(colId), j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]]; saveOrder(ids, colId);
  };
  // Hit testing uses the original measured layout, not the animated cells, so a shifted neighbor cannot
  // move its own drop threshold back under the cursor and make the insertion position oscillate.
  const dropIndex = (current: ColumnDrag, x: number) => {
    const wrap = wrapRef.current; if (!wrap) return current.to;
    const point = x - wrap.getBoundingClientRect().left + wrap.scrollLeft;
    const before = current.columns.filter(c => point > c.left + c.width / 2).length;
    const from = current.columns.findIndex(c => c.id === current.id);
    return Math.max(0, Math.min(current.columns.length - 1, before > from ? before - 1 : before));
  };
  const paintColumnDrag = (current: ColumnDrag) => {
    const wrap = wrapRef.current, lifted = current.columns.find(c => c.id === current.id);
    if (!wrap || !lifted) return;
    const to = dropIndex(current, current.x), rest = current.columns.filter(c => c.id !== current.id);
    rest.splice(to, 0, lifted);
    let left = current.columns[0].left;
    if (!current.painted || current.to !== to) for (const col of rest) {
      if (col.id === current.id) wrap.style.setProperty('--column-drop-left', `${left}px`);
      else wrap.style.setProperty(`--column-shift-${col.id}`, `translate3d(${left - col.left}px, 0, 0)`);
      left += col.width;
    }
    current.painted = true;
    const last = current.columns[current.columns.length - 1];
    const delta = Math.max(current.columns[0].left - lifted.left, Math.min(last.left + last.width - lifted.width - lifted.left, current.x - current.startX + wrap.scrollLeft - current.startScroll));
    // Only the dragged column's CSS variable changes on each frame; the table does not re-render for mouse movement.
    wrap.style.setProperty(`--column-shift-${current.id}`, `translate3d(${delta}px, 0, 0)`);
    if (current.to !== to) { current.to = to; setDrag({ id: current.id, to }); }
  };
  const animateColumns = (time: number) => {
    const current = dragRef.current, wrap = wrapRef.current;
    if (!current?.moved || !wrap) return;
    const box = wrap.getBoundingClientRect(), elapsed = Math.min(32, current.time ? time - current.time : 16);
    current.time = time;
    if (current.y >= box.top && current.y <= box.bottom) {
      const speed = current.x > box.right - 40 ? Math.min(1, (current.x - box.right + 40) / 30) : current.x < box.left + rownumW + 40 ? -Math.min(1, (box.left + rownumW + 40 - current.x) / 30) : 0;
      wrap.scrollLeft += speed * elapsed * 0.8;
    }
    paintColumnDrag(current);
    current.frame = window.requestAnimationFrame(animateColumns);
  };
  const gripDown = (e: ReactPointerEvent, c: Row) => {
    const wrap = wrapRef.current;
    if (!wrap || e.button !== 0 || e.ctrlKey || dragRef.current || !e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest('.col-resize')) return;
    suppressColumnClick.current = false;
    const target = (e.target as HTMLElement).closest<HTMLElement>('button') || e.currentTarget as HTMLElement;
    const left = wrap.getBoundingClientRect().left;
    const measured = shown.map(col => { const box = headRefs.current.get(col.id)!.getBoundingClientRect(); return { id: col.id, left: box.left - left + wrap.scrollLeft, width: box.width }; });
    target.setPointerCapture(e.pointerId);
    dragRef.current = { id: c.id, pointer: e.pointerId, startX: e.clientX, startScroll: wrap.scrollLeft, x: e.clientX, y: e.clientY, moved: false, frame: 0, time: 0, to: shown.findIndex(col => col.id === c.id), target, columns: measured };
  };
  const gripMove = (e: ReactPointerEvent) => {
    const current = dragRef.current; if (!current || current.pointer !== e.pointerId) return;
    current.x = e.clientX; current.y = e.clientY;
    if (!current.moved && Math.abs(e.clientX - current.startX) < 5) return;
    e.preventDefault();
    if (!current.moved) {
      current.moved = true;
      const wrap = wrapRef.current!, col = current.columns.find(c => c.id === current.id)!;
      wrap.style.setProperty('--column-drop-width', `${col.width}px`);
      wrap.style.setProperty('--column-drop-height', `${wrap.scrollHeight}px`);
      setDrag({ id: current.id, to: current.to });
      current.frame = window.requestAnimationFrame(animateColumns);
    }
  };
  const gripUp = (e: ReactPointerEvent) => {
    const current = dragRef.current; if (!current || current.pointer !== e.pointerId) return;
    const to = dropIndex(current, e.clientX); cancelColumnDrag();
    if (!current.moved) return;
    const ids = shown.map(c => c.id), from = ids.indexOf(current.id);
    if (from < 0) return;
    ids.splice(from, 1); ids.splice(to, 0, current.id);
    if (ids.join() !== shown.map(c => c.id).join()) saveOrder(ids, current.id);
  };

  // ---------------------------------------------------------------- selecting rows on their numbers (V5.5.1, like Excel)
  // Click a row number to select that row; press and drag over the numbers for a range (the table scrolls near its
  // edges); Shift+click extends from the last row clicked; Ctrl (⌘ on a Mac) +click adds or removes one row. On touch
  // screens a tap adds or removes a row and a drag adds a range. Keyboard: Space or Enter on a number adds or removes
  // it, Shift+Arrow keys extend, Ctrl+A selects the page, Escape clears. Right-click (or the ⋮ button) for row actions.
  const ids = Object.keys(selected), pageAll = rows.length > 0 && rows.every(r => selected[r.id] !== undefined);
  const selCount = allMatching ? page.total : ids.length;
  const say = (n: number) => setAnnounce(n ? `${n} ${plural(n, 'row')} selected.` : 'Selection cleared.');
  const pageSelection = () => Object.fromEntries(rows.map(r => [r.id, r.version])) as Record<string, number>;
  const pick = (next: Record<string, number>) => { setAllMatching(false); setSelected(next); say(Object.keys(next).length); };
  const rangeOf = (a: number, b: number) => {
    const list = rowsRef.current, out: Record<string, number> = {};
    for (let k = Math.max(0, Math.min(a, b)); k <= Math.min(list.length - 1, Math.max(a, b)); k++) out[list[k].id] = list[k].version;
    return out;
  };
  const anchorAt = () => (anchorRef.current ? rows.findIndex(r => r.id === anchorRef.current) : -1);
  const togglePage = () => { anchorRef.current = null; pick(pageAll || allMatching ? {} : pageSelection()); };
  const toggleOne = (i: number) => {
    const r = rows[i]; if (!r) return;
    anchorRef.current = r.id;
    const next = { ...(allMatching ? pageSelection() : selected) };
    if (next[r.id] !== undefined) delete next[r.id]; else next[r.id] = r.version;
    pick(next);
  };
  const extendTo = (i: number) => { let a = anchorAt(); if (a < 0) { a = i; anchorRef.current = rows[i]?.id || null; } pick(rangeOf(a, i)); };
  const clearSelection = () => { anchorRef.current = null; setSelected({}); setAllMatching(false); };
  const clearAndFocus = () => { clearSelection(); say(0); window.requestAnimationFrame(() => (wrapRef.current || toolbarRef.current?.querySelector<HTMLElement>('input, button'))?.focus({ preventScroll: true })); };
  escapeRef.current = clearAndFocus;
  /** The row under a height on screen (sideways movement does not matter while dragging). */
  const rowAt = (y: number) => {
    const trs = bodyRef.current?.rows; if (!trs || !trs.length || !rowsRef.current.length) return -1;
    const last = Math.min(trs.length, rowsRef.current.length) - 1;
    if (y < trs[0].getBoundingClientRect().top) return 0;
    if (y >= trs[last].getBoundingClientRect().top) return last;
    let lo = 0, hi = last;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (trs[mid].getBoundingClientRect().top <= y) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const applyDrag = (to: number) => {
    const s = rowDrag.current; if (!s || to < 0 || to === s.current) return;
    s.current = to;
    const range = rangeOf(s.anchor, to);
    const next = s.mode === 'replace' ? range : s.mode === 'add' ? { ...s.base, ...range } : Object.fromEntries(Object.entries(s.base).filter(([k]) => range[k] === undefined));
    s.count = Object.keys(next).length;
    setAllMatching(false); setSelected(next);
  };
  // Near the top or bottom edge of the table (or beyond it) the table scrolls, faster the further out the pointer is.
  const autoScroll = () => {
    const s = rowDrag.current, wrap = wrapRef.current; if (!s || !wrap) return;
    const box = wrap.getBoundingClientRect(), head = wrap.querySelector('thead')?.getBoundingClientRect().height || 0, foot = wrap.querySelector('tfoot')?.getBoundingClientRect().height || 0;
    const top = box.top + head, bottom = box.bottom - foot, edge = 32;
    const by = s.y < top + edge ? -Math.min(28, Math.ceil((top + edge - s.y) / 3)) : s.y > bottom - edge ? Math.min(28, Math.ceil((s.y - bottom + edge) / 3)) : 0;
    if (by && s.moved) { const before = wrap.scrollTop; wrap.scrollTop += by; if (wrap.scrollTop !== before) applyDrag(rowAt(Math.max(top + 2, Math.min(bottom - 2, s.y)))); }
    s.frame = window.requestAnimationFrame(autoScroll);
  };
  const rowDown = (e: ReactPointerEvent<HTMLElement>, i: number) => {
    if (e.button !== 0 || rowDrag.current || (e.target as HTMLElement).closest('.note-button, .rownum-menu')) return;
    const r = rows[i]; if (!r) return;
    e.currentTarget.querySelector<HTMLButtonElement>('.rownum-select')?.focus({ preventScroll: true });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers: the drag still works inside the table */ }
    e.preventDefault();
    const on = allMatching || selected[r.id] !== undefined, meta = e.ctrlKey || e.metaKey, touch = e.pointerType !== 'mouse';
    const a = anchorAt(), extend = e.shiftKey && a >= 0;
    const mode: RowDrag['mode'] = extend ? (meta ? 'add' : 'replace') : meta || touch ? (on ? 'remove' : 'add') : 'replace';
    const anchor = extend ? a : i;
    anchorRef.current = rows[anchor].id;
    rowDrag.current = { pointer: e.pointerId, anchor, current: -1, mode, base: mode === 'replace' ? {} : allMatching ? pageSelection() : selected, moved: false, y: e.clientY, startY: e.clientY, count: 0,
      wasOnly: !extend && !meta && !touch && on && !allMatching && ids.length === 1, frame: 0, touch };
    applyDrag(i);
    rowDrag.current.frame = window.requestAnimationFrame(autoScroll);
  };
  const rowMove = (e: ReactPointerEvent) => {
    const s = rowDrag.current; if (!s || e.pointerId !== s.pointer) return;
    s.y = e.clientY;
    if (!s.moved && Math.abs(e.clientY - s.startY) < 4) return;
    s.moved = true;
    applyDrag(rowAt(e.clientY));
  };
  const rowUp = (e: ReactPointerEvent) => {
    const s = rowDrag.current; if (!s || e.pointerId !== s.pointer) return;
    window.cancelAnimationFrame(s.frame); rowDrag.current = null;
    // Clicking the only selected row again clears the selection.
    if (!s.moved && s.wasOnly) { clearSelection(); say(0); return; }
    say(s.count);
  };
  // Also when the browser takes the pointer away (no pointerup), so a drag never stays stuck.
  const rowCancel = () => { const s = rowDrag.current; if (!s) return; window.cancelAnimationFrame(s.frame); rowDrag.current = null; say(s.count); };
  // Clicks from the mouse or a touch were handled when pressed (their detail is 1 or more); clicks from the keyboard or
  // a screen reader (detail 0) add or remove the row, Shift extends.
  const rowClick = (e: MouseEvent, i: number) => { if (e.detail > 0) return; if (e.shiftKey) extendTo(i); else toggleOne(i); };
  const rowKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const go = (j: number) => wrapRef.current?.querySelectorAll<HTMLButtonElement>('.rownum-select')[j]?.focus();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      const step = e.key === 'PageDown' ? 10 : e.key === 'PageUp' ? -10 : e.key === 'ArrowDown' ? 1 : -1;
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + step));
      if (e.shiftKey) { if (anchorAt() < 0) anchorRef.current = rows[i].id; extendTo(j); }
      go(j);
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); anchorRef.current = null; pick(pageSelection()); }
    else if (e.key === 'Escape' && selCount) { e.preventDefault(); e.stopPropagation(); clearSelection(); say(0); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openRowMenu(i); }
  };
  /** Row actions at a row (right-click, the Menu key, or a long press on a touch screen). A row inside a selection of
   *  several rows gets the actions for the whole selection, as in Excel. */
  const openRowMenu = (i: number) => {
    const r = rows[i]; if (!r) return;
    const on = allMatching || selected[r.id] !== undefined;
    if (!on) { anchorRef.current = r.id; pick({ [r.id]: r.version }); }
    setMenu({ row: r.id, bulk: on && selCount > 1 });
  };
  // A long press on a touch screen arrives while its press is still held: unless it moved, it opens the menu.
  const rowContext = (e: MouseEvent, i: number) => {
    e.preventDefault();
    const s = rowDrag.current;
    if (s) { if (s.moved) return; window.cancelAnimationFrame(s.frame); rowDrag.current = null; }
    openRowMenu(i);
  };
  const cardClick = (e: MouseEvent, i: number) => { if (e.shiftKey && anchorAt() >= 0) extendTo(i); else toggleOne(i); };
  const boardKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !selCount || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [role="menu"], [role="dialog"], [role="listbox"]')) return;
    e.preventDefault(); clearSelection(); say(0);
  };
  const deleteSelected = async () => {
    const count = selCount, big = count > 20;
    const r = await confirm({
      title: `Delete ${count.toLocaleString('en-US')} ${plural(count, 'row')}?`,
      description: allMatching ? `Every row matching your search and filters is deleted, with its notes. This can’t be undone.` : `The selected ${plural(count, 'row')} and ${count === 1 ? 'its' : 'their'} notes are deleted. This can’t be undone. If any of them changed or can’t be deleted, nothing is deleted.`,
      confirmLabel: `Delete ${count.toLocaleString('en-US')} ${plural(count, 'row')}`, tone: 'danger', ...(big ? { reason: { label: `Type ${count} to confirm`, required: true, placeholder: String(count), singleLine: true, inputMode: 'numeric' } } : {}),
    });
    if (!r) return;
    if (big && r.reason.replace(/[,\s]/g, '') !== String(count)) { toast.error('The number you typed does not match. Nothing was deleted.'); return; }
    setBusy(true);
    try {
      const body = allMatching ? { match: { q: query.q || '', filters: view.filters, ...(view.showHidden ? { hidden: '1' } : {}) }, expected_count: count, match_key: matchKey } : { ids, expected: selected };
      const res = await groupCommand('tm.group.row.delete', { group_id: id, ...body });
      toast.success(res.message || 'Deleted.'); clearSelection(); await load(true); void w.refresh({ quiet: true });
    } catch (e) { toast.error((e as Error).message); await load(true); } finally { setBusy(false); }
  };
  const restrictRows = (list: Row[], label: string) => {
    const rules = list.map(r => JSON.stringify(r.access || [])), same = rules.every(x => x === rules[0]);
    setRuleFor({ kind: 'rows', ids: list.map(r => r.id), current: same ? (list[0]?.access || null) : null, label });
  };
  const restrictSelected = () => restrictRows(rows.filter(r => selected[r.id] !== undefined), `${ids.length} selected ${plural(ids.length, 'row')}`);

  // ---------------------------------------------------------------- filters shown as chips
  const chips: FilterChip[] = [
    ...(view.q ? [{ key: 'q', label: <>Search: “{view.q}”</>, text: `Search ${view.q}`, onRemove: () => { setSearch(''); setV({ q: '' }); } }] : []),
    ...view.filters.map((f, i) => { const col = columns.find(c => c.id === f.col); return { key: `f${i}`, label: <>{filterLabel(col, f, nameOf)}</>, text: filterLabel(col, f, nameOf), onRemove: () => setV({ filters: view.filters.filter((_, n) => n !== i) }) }; }),
  ];
  const editors: Editors = { active, setActive, cells, saveCell, discard, groupId: id, w, nameOf, caps, replaceRow, advance, lastRowId, enterTo, seed };
  const rowMenu = (r: Row, n: number, i: number) => {
    const bulk = !!menu && menu.row === r.id && menu.bulk;
    return <RowMenu label={rowLabel(r, n)} caps={caps} reorderable={reorderable} first={page.offset + i === 0} last={page.offset + i >= page.total - 1} hiddenMine={hiddenRows.has(r.id)}
      open={menu?.row === r.id} onOpenChange={o => setMenu(o ? { row: r.id, bulk: (allMatching || selected[r.id] !== undefined) && selCount > 1 } : null)}
      bulk={bulk ? { count: selCount, all: allMatching, onExport: () => setExporting(true), onHide: () => hideRows(ids), onRestrict: restrictSelected, onDelete: () => void deleteSelected(), onClear: () => { clearSelection(); say(0); } } : undefined}
      onNotes={() => setNotesFor({ row: r, title: rowLabel(r, n) })} onInsert={() => void addRow(r.id)} onMove={by => void moveRow(r, by)} onHide={() => (hiddenRows.has(r.id) ? showRow(r.id) : hideRows([r.id]))}
      onRestrict={() => restrictRows([r], rowLabel(r, n).toLowerCase())} onDelete={() => void deleteRow(r, rowLabel(r, n).toLowerCase())} />;
  };
  const notesButton = (r: Row, n: number) => <button type="button" className={`note-button${r.notes ? ' has-notes' : ''}`} onClick={() => setNotesFor({ row: r, title: rowLabel(r, n) })} aria-label={r.notes ? `${r.notes} ${plural(r.notes, 'note')} on ${rowLabel(r, n)}` : `Notes on ${rowLabel(r, n)}`} title={r.notes ? `${r.notes} ${plural(r.notes, 'note')}` : 'Notes'}><MessageSquareText aria-hidden="true" />{r.notes > 0 && <span className="num">{r.notes > 99 ? '99+' : r.notes}</span>}</button>;
  const sizeText = (n: number) => n.toLocaleString('en-US');
  const moved = (fit >= 2 && (caps.structure || canSettings)) || (fit >= 1 && (caps.import || caps.export));
  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${g.name}`} title="More"><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="group-more-menu">
        {fit >= 2 && caps.structure && <DropdownMenuItem disabled={busy || columns.length >= GROUP_LIMITS.columns} onSelect={() => setColumnDialog({})}><Columns3 />Add column</DropdownMenuItem>}
        {fit >= 2 && canSettings && <DropdownMenuItem disabled={busy} onSelect={() => onEdit()}><Settings2 />Settings & sharing</DropdownMenuItem>}
        {fit >= 1 && caps.import && <DropdownMenuItem disabled={busy} onSelect={() => setImporting(true)}><Upload />Import data</DropdownMenuItem>}
        {fit >= 1 && caps.export && <DropdownMenuItem onSelect={() => setExporting(true)}><Download />Export data</DropdownMenuItem>}
        {moved && <DropdownMenuSeparator />}
        {(caps.structure || (caps.share && caps.export)) && <DropdownMenuLabel>Live Data</DropdownMenuLabel>}
        {caps.share && caps.export && <DropdownMenuItem disabled={busy} onSelect={() => setLiveShare({})}><Share2 />Share Live Data…</DropdownMenuItem>}
        {caps.structure && <DropdownMenuItem disabled={busy || columns.length >= GROUP_LIMITS.columns} onSelect={() => setLiveColumn({})}><Link2 />Add Live Data column…</DropdownMenuItem>}
        {(caps.structure || (caps.share && caps.export)) && <DropdownMenuSeparator />}
        {data.activity && <DropdownMenuItem onSelect={() => setShowActivity(true)}><History />Recent changes</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => setShowAccess(true)}><Users />Who can open it</DropdownMenuItem>
        {g.description && <DropdownMenuLabel className="group-menu-desc">{g.description.slice(0, 200)}</DropdownMenuLabel>}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        {hiddenCols.size > 0 && <DropdownMenuItem onSelect={() => void saveView({ hidden_columns: [] }, 'All columns are shown again.')}><Eye />Show {hiddenCols.size} hidden {plural(hiddenCols.size, 'column')}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => void resetLayout()}><RotateCcw />Reset my view</DropdownMenuItem>
        {caps.structure && <DropdownMenuItem onSelect={() => void saveDefaultLayout()}><Save />Save my layout as everyone’s default</DropdownMenuItem>}
        {caps.archive && <><DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void archive()}>{g.status === 'ACTIVE' ? <><Archive />Archive group…</> : <><ArchiveRestore />Restore group…</>}</DropdownMenuItem>
          {g.status === 'ARCHIVED' && <DropdownMenuItem tone="danger" onSelect={() => void remove()}><Trash2 />Delete permanently…</DropdownMenuItem>}</>}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="group-board" onKeyDown={boardKeys}>
      {/* The page's heading (the page title is not shown while a group is open). */}
      <h1 className="sr-only">{g.name}</h1>
      {/* V5.5.1: one compact bar above the table (no page title, tabs or title row while a group is open). */}
      <div ref={toolbarRef} className="group-toolbar" role="group" aria-label={`${g.name} tools`}>
          <IconButton label="All groups" icon={ArrowLeft} onClick={onBack} className="group-back" />
          <div className="group-search" data-min-width="150"><SearchInput value={search} onChange={setSearch} label="Search this group" placeholder="Search every column…" /></div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><ListFilter />Filter{view.filters.length ? <span className="count-inline num">{view.filters.length}</span> : null}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Filter by column</DropdownMenuLabel>
              {shown.map(c => { const Icon = TYPE_ICON[c.type]; return <DropdownMenuItem key={c.id} onSelect={() => setFilterFor(c)}><Icon />{c.name}</DropdownMenuItem>; })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Segmented label="View" size="sm" value={mode} onChange={v => setV({ mode: v as ViewState['mode'], page: view.page })} options={[{ value: 'table', label: 'Table', icon: Sheet, hideLabel: narrow }, { value: 'cards', label: 'Cards', icon: LayoutList, hideLabel: narrow }]} />
          <span className="toolbar-sep" aria-hidden="true" />
          {caps.addRows && <Button size="sm" onClick={() => void addRow()} disabled={busy}><Plus />Add row</Button>}
          {fit < 2 && caps.structure && <Button size="sm" variant="outline" data-fit="column" onClick={() => setColumnDialog({})} disabled={busy || columns.length >= GROUP_LIMITS.columns}><Columns3 />Add column</Button>}
          {fit < 2 && canSettings && <Button size="sm" variant="outline" data-fit="settings" onClick={() => onEdit()} disabled={busy}><Settings2 />Settings & sharing</Button>}
          {fit < 1 && caps.import && <Button size="sm" variant="outline" data-fit="import" onClick={() => setImporting(true)} disabled={busy} title="Import data from Excel"><Upload />Import</Button>}
          {fit < 1 && caps.export && <Button size="sm" variant="outline" data-fit="export" onClick={() => setExporting(true)} title="Export data to Excel"><Download />Export</Button>}
          {moreMenu}
      </div>
      {g.workspace_status === 'ARCHIVED' ? <Alert tone="neutral" title="This group’s workspace is archived">Restore the workspace “{g.workspace_name}” to change its groups.</Alert>
        : g.status === 'ARCHIVED' ? <Alert tone="neutral" title="This group is archived">Nobody can change it. {caps.archive ? 'Restore it to use it again, or delete it permanently.' : 'Its owner can restore it.'}</Alert>
          : !caps.editRows && <p className="group-readonly muted small"><Lock aria-hidden="true" className="inline-icon" />View only{w.can('tasks.groups', 'update') ? ': changing records needs “Can edit records” access from its owner.' : '.'}</p>}
      {/* While rows are selected, what can be done with them lies over the line with the row count: nothing moves, so the
          rows under the pointer stay put during a drag, and the toolbar above stays usable. */}
      <div className={`group-status-wrap${selecting ? ' is-selecting' : ''}`}>
      {selecting && <div className="selection-bar" role="region" aria-label="Selected rows">
        <IconButton label="Clear the selection" icon={X} size="icon-xs" onClick={clearAndFocus} />
        <span className="selection-count"><strong className="num">{sizeText(selCount)}</strong> {allMatching ? `selected: every row ${filtering ? 'matching your search and filters' : 'in this group'}` : `${plural(selCount, 'row')} selected${page.total > rows.length ? ' on this page' : ''}`}</span>
        {(allMatching || pageAll) && page.total > rows.length && <Button size="xs" variant="link" onClick={() => { if (allMatching) { setAllMatching(false); say(rows.length); } else { setMatchKey(page.match_key || ''); setAllMatching(true); say(page.total); } }}>
          {allMatching ? `Select only the ${sizeText(rows.length)} on this page` : `Select all ${sizeText(page.total)} ${filtering ? 'matching rows' : 'rows'}`}</Button>}
        <span className="selection-actions">
          {caps.export && <Button size="xs" variant="outline" onClick={() => setExporting(true)}><Download />Export</Button>}
          {!allMatching && <Button size="xs" variant="outline" onClick={() => hideRows(ids)}><EyeOff /><span className="label-long">Hide in my view</span><span className="label-short">Hide for me</span></Button>}
          {caps.share && !allMatching && <Button size="xs" variant="outline" onClick={restrictSelected}><Lock /><span className="label-long">Restrict access…</span><span className="label-short">Restrict…</span></Button>}
          {caps.deleteRows && <Button size="xs" variant="danger-outline" onClick={() => void deleteSelected()} disabled={busy}><Trash2 /><span className="label-long">Delete selected</span><span className="label-short">Delete</span></Button>}
        </span>
      </div>}
      <div className="filter-status group-status">
        <GroupSwitch name={g.name} boards={boards} current={id} onOpen={onOpen} onBack={onBack} />
        <span className="filter-summary" aria-live="polite"><strong className="num">{sizeText(page.total)}</strong>{filtering ? ` of ${sizeText(page.all)}` : ''} {plural(filtering ? page.all : page.total, 'row')}
          {page.hidden_mine > 0 && <> · <button type="button" className="text-link" onClick={() => setV({ showHidden: !view.showHidden })}>{view.showHidden ? `Hide the ${page.hidden_mine} ${plural(page.hidden_mine, 'row')} I hid` : `${page.hidden_mine} hidden in your view (show)`}</button></>}
          {hiddenCols.size > 0 && <> · <button type="button" className="text-link" onClick={() => void saveView({ hidden_columns: [] }, 'All columns are shown again.')}>{hiddenCols.size} {plural(hiddenCols.size, 'column')} hidden in your view (show)</button></>}
        </span>
        {chips.length > 0 && <ul className="filter-chips" aria-label="Active filters">{chips.map(c => <li key={c.key} className="chip"><span>{c.label}</span><button type="button" aria-label={`Remove filter ${c.text}`} onClick={c.onRemove}><X aria-hidden="true" /></button></li>)}</ul>}
        {chips.length > 1 && <Button variant="link" size="xs" onClick={() => { setSearch(''); setV({ q: '', filters: [] }); }}>Reset all</Button>}
        {view.sort && <Button size="xs" variant="ghost" onClick={() => setV({ sort: null })}><X />Sorted by {columns.find(c => c.id === view.sort!.col)?.name} ({view.sort.dir === 'asc' ? 'A→Z, 1→9' : 'Z→A, 9→1'})</Button>}
        <span className="group-status-end">
          {data.sync && <button type="button" className={`sync-chip is-${String(data.sync.status).toLowerCase()}`} onClick={caps.share ? () => onEdit('google') : undefined} disabled={!caps.share} title={caps.share ? 'Google Sheets settings' : undefined}>
            <Sheet aria-hidden="true" />{syncLabel(data.sync)}{data.sync.conflicts ? <span className="sync-conflicts"> · {data.sync.conflicts} {plural(data.sync.conflicts, 'conflict')}</span> : null}</button>}
          {refreshing && <span className="muted small" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />Updating…</span>}
          {error && !refreshing && <span className="group-refresh-error small" role="alert"><CircleAlert aria-hidden="true" />{error} <button type="button" className="text-link" onClick={() => void load(true)}>Try again</button></span>}
        </span>
      </div>
      </div>
      <p className="sr-only" aria-live="polite">{announce}</p>
      <p className="sr-only" id={gripHint}>Drag to move the column, or press the left and right arrow keys.</p>
      {!columns.length ? <EmptyState icon={Columns3} title="This group has no columns" description="Add a column to start." action={caps.structure && <Button size="sm" onClick={() => setColumnDialog({})}><Plus />Add column</Button>} />
        : mode === 'table' ? (
          <div ref={wrapRef} className={`grid-wrap${refreshing ? ' is-refreshing' : ''}${drag ? ' is-column-dragging' : ''}`} role="region" aria-label={`${g.name} table`} tabIndex={0}>
            {drag && <div className="column-drop-slot" aria-hidden="true" />}
            <table className="grid-table" style={{ width: tableWidth, ['--grid-rownum-w' as string]: `${rownumW}px` }}>
              <caption className="sr-only">{g.name}: rows {sizeText(page.total ? page.offset + 1 : 0)} to {sizeText(page.offset + rows.length)} of {sizeText(page.total)}. {caps.editRows ? 'Select a cell to edit it. Enter saves and moves to the row below (on the last row, without a search, filter or sorting, it adds a new row); Escape cancels.' : 'Read-only.'} Select rows on their numbers: click, drag, Shift+click or Ctrl+click; on a number, Space selects and Shift+Arrow keys extend.</caption>
              <colgroup><col style={{ width: rownumW }} />{shown.map(c => <col key={c.id} style={{ width: widthOf(c) }} />)}</colgroup>
              <thead>
                <tr>
                  <th scope="col" className="grid-rownum grid-corner">
                    <button type="button" className="rownum-all" onClick={togglePage} disabled={!rows.length} aria-pressed={pageAll || allMatching}
                      aria-label={pageAll || allMatching ? 'Clear the selection' : 'Select every row on this page'} title={pageAll || allMatching ? 'Clear the selection' : 'Select every row on this page'}>#</button>
                    <ResizeHandle name="the row numbers" width={rownumW} limits={GROUP_LIMITS.rownumWidth} reset={NUMBER_W} onResize={setRownumDraft} onCommit={commitRownum} />
                  </th>
                  {shown.map(c => (
                    <th key={c.id} ref={el => { if (el) headRefs.current.set(c.id, el); else headRefs.current.delete(c.id); }} scope="col" data-column-id={c.id} style={columnStyle(c.id)} className={`grid-head type-${c.type.toLowerCase()}${drag?.id === c.id ? ' is-dragging' : ''}`}
                      onPointerDown={e => gripDown(e, c)} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={cancelColumnDrag} onLostPointerCapture={cancelColumnDrag}
                      onClickCapture={e => { if (suppressColumnClick.current) { e.preventDefault(); e.stopPropagation(); suppressColumnClick.current = false; } }}
                      aria-sort={view.sort?.col === c.id ? (view.sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <div className="grid-head-inner">
                        <button type="button" className="col-grip" aria-label={`Move column ${c.name}`} aria-describedby={gripHint} title="Drag to move (or use the arrow keys)"
                          onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); moveColumnBy(c.id, e.key === 'ArrowLeft' ? -1 : 1); } }}><GripVertical aria-hidden="true" /></button>
                        <ColumnMenu col={c} caps={caps} sort={view.sort?.col === c.id ? view.sort?.dir ?? null : null} columns={columns}
                          onSort={dir => setV({ sort: dir ? { col: c.id, dir } : null })} onFilter={() => setFilterFor(c)} onHide={() => hideColumn(c)} onEdit={() => setColumnDialog({ column: c })} onInsert={() => setColumnDialog({ after: c.id })}
                          onShare={() => setShareColumn(c)} onRestrict={() => setRuleFor({ kind: 'column', column: c })} onDelete={() => void deleteColumn(c)}
                          onShareLive={() => setLiveShare({ column: c.id })} onHistory={() => c.linked ? setLiveHistory({ group: c.linked.source_group_id, name: c.linked.source_group_name, column: c.linked.source_column_id }) : setLiveHistory({ group: id, name: g.name, column: c.id })}
                          onAddRows={() => void structure('tm.group.live.rows', { column_id: c.id })} />
                      </div>
                      <ResizeHandle name={c.name} width={widthOf(c)} onResize={v => setWidths(s => ({ ...s, [c.id]: v }))} onCommit={() => commitWidth(c)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody ref={bodyRef}>
                {rows.map((r, i) => {
                  const n = page.offset + i + 1, on = allMatching || selected[r.id] !== undefined;
                  return (
                    <tr key={r.id} className={`${on ? 'is-selected' : ''}${hiddenRows.has(r.id) ? ' is-hidden-mine' : ''}`}>
                      <th scope="row" className="grid-rownum" onPointerDown={e => rowDown(e, i)} onPointerMove={rowMove} onPointerUp={rowUp} onPointerCancel={rowCancel} onLostPointerCapture={rowCancel} onContextMenu={e => rowContext(e, i)}>
                        <div className="rownum-inner">
                          <button type="button" className="rownum-select num" aria-pressed={on} aria-label={`Select ${rowLabel(r, n)}`} onClick={e => rowClick(e, i)} onKeyDown={e => rowKey(e, i)}>{n}</button>
                          {r.access?.length ? <Lock className="row-lock" aria-label="Visible to some people only" /> : null}
                          {notesButton(r, n)}{rowMenu(r, n, i)}
                        </div>
                      </th>
                      {shown.map(c => <GridCell key={c.id} row={r} col={c} lifted={drag?.id === c.id} {...editors} onExpand={() => setCellDialog({ row: r, col: c })} />)}
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={shown.length + 1} className="grid-empty">{page.all ? 'No rows match your search or filters.' : caps.addRows ? 'No rows yet. Use “Add row” to start, or import data from Excel.' : 'No rows yet.'}</td></tr>}
              </tbody>
              {ghost && rows.length > 0 && <tbody className="grid-adding" aria-hidden="true">
                {ghost.parts.map((t, k) => {
                  const typing = k === ghost.parts.length - 1;
                  return (
                    <tr key={k} className="row-adding">
                      <th className="grid-rownum"><div className="rownum-inner"><Loader2 className="spin row-adding-spin" /></div></th>
                      {shown.map(c => <td key={c.id} ref={typing && c.id === ghost.col ? ghostCell : undefined} data-column-id={c.id} style={columnStyle(c.id)} className={`grid-cell type-${c.type.toLowerCase()}${drag?.id === c.id ? ' is-dragging' : ''}`}>{c.id === ghost.col && <div className="grid-cell-view"><span className="cell-text">{typing && ghost.end === 'cancel' ? '' : t}</span>{typing && !ghost.end && <span className="adding-caret" />}</div>}</td>)}
                    </tr>
                  );
                })}
              </tbody>}
              {Object.keys(page.totals || {}).some(k => shown.some(c => c.id === k)) && rows.length > 0 && <tfoot>
                <tr>
                  <th scope="row" className="grid-rownum"><span className="small" title={`Totals of all ${page.total} matching rows`}>Σ</span></th>
                  {shown.map((c, i) => { const t = page.totals[c.id]; return <td key={c.id} data-column-id={c.id} style={columnStyle(c.id)} data-lifted={drag?.id === c.id || undefined} className={t ? 'grid-total num' : 'grid-total'}>{t ? (t.errors ? <span className="text-danger small" title="Some rows have an error in this column, so no total is shown.">{t.errors} {plural(t.errors, 'error')}</span> : <span title={`Total of ${page.total} ${plural(page.total, 'row')}`}>{formatColumnNumber(t.sum, c.settings)}</span>) : i === 0 ? <span className="muted small">Total of {sizeText(page.total)}</span> : null}</td>; })}
                </tr>
              </tfoot>}
            </table>
          </div>
        ) : (
          <div className={`group-cards${refreshing ? ' is-refreshing' : ''}`}>
            {rows.map((r, i) => {
              const n = page.offset + i + 1, on = allMatching || selected[r.id] !== undefined;
              return (
                <article key={r.id} className={`row-card${on ? ' is-selected' : ''}`} aria-label={rowLabel(r, n)}>
                  <div className="row-card-head">
                    <button type="button" className="row-card-num num" aria-pressed={on} aria-label={`Select ${rowLabel(r, n)}`} title={on ? 'Selected: tap to unselect' : 'Tap to select'} onClick={e => cardClick(e, i)}>{n}</button>
                    <span className="cell-title">{(firstCol && text(firstCol, r)) || <span className="muted">Row {n}</span>}</span>
                    {r.access?.length ? <Lock className="row-lock" aria-label="Visible to some people only" /> : null}
                    {notesButton(r, n)}{rowMenu(r, n, i)}
                  </div>
                  <dl className="row-card-fields">
                    {shown.map(c => (
                      <div key={c.id} className="row-card-field" style={cellColors(r, c)}>
                        <dt>{c.name}{caps.editRows && <CellFormatControl groupId={id} row={r} col={c} onSaved={replaceRow} />}</dt>
                        <dd>{c.type === 'ATTACHMENT' ? <AttachmentCell row={r} col={c} groupId={id} caps={caps} replaceRow={replaceRow} inline /> : <CellDisplay row={r} col={c} value={valueOf(c, r)} nameOf={nameOf} />}
                          {caps.editRows && c.type !== 'FORMULA' && c.type !== 'ATTACHMENT' && !c.linked?.readOnly && <IconButton label={`Edit ${c.name}`} icon={Pencil} onClick={() => setCellDialog({ row: r, col: c })} />}
                          {cells[cellKey(r.id, c.id)]?.state === 'error' && <span className="text-danger small">{cells[cellKey(r.id, c.id)]?.message}</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </article>
              );
            })}
            {!rows.length && <EmptyState compact title={page.all ? 'No rows match your search or filters' : 'No rows yet'} action={!page.all && caps.addRows ? <Button size="sm" onClick={() => void addRow()}><Plus />Add row</Button> : undefined} />}
          </div>
        )}
      {page.total > 0 && <nav className="group-pager" aria-label="Pages">
        <span className="small num" aria-live="polite">{sizeText(page.offset + 1)}–{sizeText(page.offset + rows.length)} of {sizeText(page.total)}</span>
        <Button size="sm" variant="outline" disabled={view.page === 0} onClick={() => setV({ page: view.page - 1 })}><ChevronLeft />Previous</Button>
        <Button size="sm" variant="outline" disabled={(view.page + 1) * view.size >= page.total} onClick={() => setV({ page: view.page + 1 })}>Next<ChevronRight /></Button>
        <label className="page-size small">Rows per page <select className="control" value={view.size} onChange={e => setV({ size: Number(e.target.value) })}>{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      </nav>}
      {shareColumn && <ShareDataDialog groupId={id} columns={columns.filter(c => !c.linked)} initialColumn={shareColumn.id} onClose={() => setShareColumn(null)} />}
      {liveShare && <ShareLiveDialog groupId={id} groupName={g.name} initialColumn={liveShare.column} onClose={() => setLiveShare(null)} />}
      {liveColumn && <AddLiveColumnDialog groupId={id} columns={columns} after={liveColumn.after} onClose={() => setLiveColumn(null)}
        onSaved={async message => { setLiveColumn(null); await load(true); void w.refresh({ quiet: true }); toast.success(message); }} />}
      {liveHistory && <LiveHistoryDialog groupId={liveHistory.group} groupName={liveHistory.name} column={liveHistory.column} onClose={() => setLiveHistory(null)} />}
      {columnDialog && <ColumnDialog w={w} group={g} columns={columns} rows={rows} column={columnDialog.column} after={columnDialog.after} onClose={() => setColumnDialog(null)}
        onSaved={async message => { setColumnDialog(null); await load(true); void w.refresh({ quiet: true }); toast.success(message); }} />}
      {cellDialog && <CellDialog row={cellDialog.row} col={cellDialog.col} {...editors} onClose={() => setCellDialog(null)} />}
      {filterFor && <FilterDialog col={filterFor} groupId={id} nameOf={nameOf} onClose={() => setFilterFor(null)} onApply={f => { setV({ filters: [...view.filters.filter(x => x.col !== f.col), f] }); setFilterFor(null); }} />}
      {showAccess && <AccessDialog w={w} group={g} onClose={() => setShowAccess(false)} onEdit={caps.share || caps.visibility ? () => { setShowAccess(false); onEdit(); } : undefined} />}
      {showActivity && data.activity && <ActivityDialog w={w} name={g.name} activity={data.activity} onClose={() => setShowActivity(false)} />}
      {notesFor && <NotesDrawer w={w} groupId={id} row={notesFor.row} title={notesFor.title} onClose={() => setNotesFor(null)} onChanged={() => void load(true)} />}
      {ruleFor && <AccessRuleDialog groupId={id} target={ruleFor} onClose={() => setRuleFor(null)} onSaved={async message => { setRuleFor(null); setSelected({}); toast.success(message); await load(true); }} />}
      {exporting && <ExportDialog groupId={id} name={g.name} all={page.all} filtered={page.total} selectedIds={allMatching ? null : ids.length ? ids : null} query={query} filteredActive={filtering || allMatching} hiddenColumns={hiddenCols.size} onClose={() => setExporting(false)} />}
      {importing && <ImportWizard groupId={id} groupName={g.name} columns={columns.filter(c => !c.linked)} canCreateColumns={!!caps.structure} onClose={() => setImporting(false)} onDone={() => { void load(true); void w.refresh({ quiet: true }); }} />}
    </div>
  );
}

/** The group's name above the table: opens the other groups of the workspace, or the list of all groups. */
function GroupSwitch({ name, boards, current, onOpen, onBack }: { name: string; boards: Row[]; current: string; onOpen: (id: string) => void; onBack: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="group-crumb" title={name}><span className="group-crumb-name">{name}</span><ChevronDown aria-hidden="true" /><span className="sr-only">: switch to another group</span></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="group-switch-menu">
        <DropdownMenuItem onSelect={onBack}><ArrowLeft />All groups</DropdownMenuItem>
        {boards.length > 1 && <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Open another group</DropdownMenuLabel>
          {boards.map(b => <DropdownMenuItem key={b.id} aria-current={b.id === current ? 'true' : undefined} onSelect={() => { if (b.id !== current) onOpen(b.id); }}>{b.id === current ? <Check /> : <Sheet />}{b.name}{b.status === 'ARCHIVED' ? ' (archived)' : ''}</DropdownMenuItem>)}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function filterLabel(col: Row | undefined, f: Filter, nameOf: (id: string) => string) {
  if (!col) return 'Filter';
  if (col.type === 'NUMBER' || col.type === 'FORMULA') return `${col.name}: ${f.min !== undefined && f.min !== '' ? `≥ ${f.min}` : ''}${f.min && f.max ? ' and ' : ''}${f.max !== undefined && f.max !== '' ? `≤ ${f.max}` : ''}`;
  if (col.type === 'DATE') return `${col.name}: ${f.from ? `from ${formatDay(f.from)}` : ''}${f.from && f.to ? ' ' : ''}${f.to ? `to ${formatDay(f.to)}` : ''}`;
  if (col.type === 'STATUS') return `${col.name}: ${f.value ? statusLabels(col).find((l: Row) => l.id === f.value)?.name || '?' : 'empty'}`;
  if (col.type === 'IN_CHARGE' || col.type === 'SUPPORT') return `${col.name}: ${f.value ? nameOf(f.value) : 'nobody'}`;
  return `${col.name} contains “${f.value}”`;
}

// ---------------------------------------------------------------- column header, resize handle and row menu
/** The border of a column: drag it (mouse, pen or touch) or use the arrow keys on it (Shift for bigger steps). */
function ResizeHandle({ name, width, onResize, onCommit, limits = GROUP_LIMITS.width, reset = DEFAULT_WIDTH.TEXT }: { name: string; width: number; onResize: (w: number) => void; onCommit: () => void; limits?: number[]; reset?: number }) {
  const start = useRef<{ x: number; w: number } | null>(null), timer = useRef(0);
  const later = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(onCommit, 700); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span role="separator" aria-orientation="vertical" aria-label={`Width of ${name}`} aria-valuenow={width} aria-valuemin={limits[0]} aria-valuemax={limits[1]} tabIndex={0} className="col-resize" title="Drag to resize"
      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: width }; }}
      onPointerMove={e => { if (start.current) onResize(clampWidth(start.current.w + e.clientX - start.current.x, limits)); }}
      onPointerUp={() => { if (start.current) { start.current = null; onCommit(); } }}
      onPointerCancel={() => { if (start.current) { start.current = null; onCommit(); } }}
      onDoubleClick={() => { onResize(clampWidth(reset, limits)); later(); }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onResize(clampWidth(width + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 50 : 10), limits)); later(); } }} />
  );
}

function ColumnMenu({ col, caps, sort, columns, onSort, onFilter, onHide, onEdit, onInsert, onRestrict, onShare, onDelete, onShareLive, onHistory, onAddRows }: {
  col: Row; caps: Row; sort: 'asc' | 'desc' | null; columns: Row[]; onShare: () => void; onSort: (d: 'asc' | 'desc' | null) => void; onFilter: () => void; onHide: () => void; onEdit: () => void; onInsert: () => void; onRestrict: () => void; onDelete: () => void;
  onShareLive: () => void; onHistory: () => void; onAddRows: () => void;
}) {
  const [open, setOpen] = useState(false);
  const live: Row | undefined = col.linked;
  const Icon = live ? Link2 : TYPE_ICON[col.type], formula = col.type === 'FORMULA' ? col.settings?.display : '';
  const liveText = live ? (live.state === 'ok' ? `Live Data from ${live.source_group_name} · ${live.permission === 'EDIT' ? 'Can edit' : 'Viewer'}` : live.state === 'broken' ? 'Live Data · the source column was removed' : 'Live Data · not available to you') : '';
  const usedBy = (col.used_by || []).map((x: string) => columns.find(c => c.id === x)?.name).filter(Boolean), restricted = !!col.access?.length;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`grid-head-button${live ? ' is-live' : ''}`} onPointerDown={e => { if (e.button === 0 && !e.ctrlKey) e.preventDefault(); }} onClick={() => setOpen(value => !value)} title={formula ? `${col.name} ${formula}` : live ? `${col.name} · ${liveText}` : `${col.name} · ${COLUMN_TYPES[col.type as ColumnType]} · Drag to move`}>
          <Icon aria-hidden="true" className="grid-type-icon" /><span className="grid-head-name">{col.name}</span>
          {restricted && <Lock aria-hidden="true" className="grid-lock" />}
          {sort && (sort === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />)}
          <span className="sr-only">, {live ? liveText : `${COLUMN_TYPES[col.type as ColumnType]} column`}{restricted ? ', visible to some people only' : ''}{sort ? `, sorted ${sort === 'asc' ? 'ascending' : 'descending'}` : ''}. Open the column menu.</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="column-menu">
        <DropdownMenuLabel>{live ? liveText : COLUMN_TYPES[col.type as ColumnType]}{live?.state === 'ok' ? <span className="column-menu-note">Matched by {live.source_key_name} = {columns.find(c => c.id === live.key_column_id)?.name || 'a column of this group'}</span> : null}{formula ? <code className="column-menu-formula">{formula}</code> : null}{usedBy.length ? <span className="column-menu-note">Used by {usedBy.join(', ')}</span> : null}{restricted ? <span className="column-menu-note">Visible to some people only</span> : null}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSort('asc')}><ArrowUp />Sort ascending</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSort('desc')}><ArrowDown />Sort descending</DropdownMenuItem>
        {sort && <DropdownMenuItem onSelect={() => onSort(null)}><ArrowUpDown />Clear sorting</DropdownMenuItem>}
        <DropdownMenuItem onSelect={onFilter}><ListFilter />Filter…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onHide}><EyeOff />Hide in my view</DropdownMenuItem>
        {caps.structure && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onEdit}><Pencil />{live ? 'Rename Live Data column…' : col.type === 'FORMULA' ? 'Edit formula and column…' : 'Rename or change column…'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onInsert}><Plus />Add column after</DropdownMenuItem>
        </>}
        {live?.state === 'ok' && caps.addRows && <DropdownMenuItem onSelect={onAddRows}><Plus />Add rows for shared records</DropdownMenuItem>}
        {(live?.can_history || (!live && col.shared_live)) && <DropdownMenuItem onSelect={onHistory}><History />Live Data edit history…</DropdownMenuItem>}
        {!live && caps.share && caps.export && col.type !== 'ATTACHMENT' && <DropdownMenuItem onSelect={onShare}><Share2 />Share Data (copy)…</DropdownMenuItem>}
        {!live && caps.share && caps.export && col.type !== 'ATTACHMENT' && <DropdownMenuItem onSelect={onShareLive}><Link2 />Share Live Data…</DropdownMenuItem>}
        {caps.share && <DropdownMenuItem onSelect={onRestrict}><Lock />Restrict access…</DropdownMenuItem>}
        {caps.deleteColumns && <><DropdownMenuSeparator /><DropdownMenuItem tone="danger" onSelect={onDelete}><Trash2 />Delete column…</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
type BulkActions = { count: number; all: boolean; onExport: () => void; onHide: () => void; onRestrict: () => void; onDelete: () => void; onClear: () => void };
/** A row's actions (its ⋮ button, a right-click on its number, or the Menu key). Opened on a row that is part of a
 *  selection of several rows, it offers the actions for the whole selection instead. */
function RowMenu({ label, caps, reorderable, first, last, hiddenMine, open, onOpenChange, bulk, onNotes, onInsert, onMove, onHide, onRestrict, onDelete }: {
  label: string; caps: Row; reorderable: boolean; first: boolean; last: boolean; hiddenMine: boolean; open: boolean; onOpenChange: (open: boolean) => void; bulk?: BulkActions;
  onNotes: () => void; onInsert: () => void; onMove: (by: number) => void; onHide: () => void; onRestrict: () => void; onDelete: () => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild><button type="button" className="rownum-menu" aria-label={`${label}: actions`} title="Row actions (or right-click the row number)"><MoreVertical aria-hidden="true" /></button></DropdownMenuTrigger>
      {bulk ? <DropdownMenuContent align="start">
        <DropdownMenuLabel>{bulk.all ? `Every matching row (${bulk.count.toLocaleString('en-US')})` : `${bulk.count} rows selected`}</DropdownMenuLabel>
        {caps.export && <DropdownMenuItem onSelect={bulk.onExport}><Download />Export…</DropdownMenuItem>}
        {!bulk.all && <DropdownMenuItem onSelect={bulk.onHide}><EyeOff />Hide in my view</DropdownMenuItem>}
        {caps.share && !bulk.all && <DropdownMenuItem onSelect={bulk.onRestrict}><Lock />Restrict access…</DropdownMenuItem>}
        {caps.deleteRows && <><DropdownMenuSeparator /><DropdownMenuItem tone="danger" onSelect={bulk.onDelete}><Trash2 />Delete {bulk.count.toLocaleString('en-US')} rows…</DropdownMenuItem></>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={bulk.onClear}><X />Clear the selection</DropdownMenuItem>
      </DropdownMenuContent> : <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={onNotes}><MessageSquareText />Notes…</DropdownMenuItem>
        {caps.addRows && <DropdownMenuItem onSelect={onInsert}><Plus />Insert row below</DropdownMenuItem>}
        {caps.editRows && <>
          <DropdownMenuItem disabled={!reorderable || first} onSelect={() => onMove(-1)}><ArrowUp />Move up</DropdownMenuItem>
          <DropdownMenuItem disabled={!reorderable || last} onSelect={() => onMove(1)}><ArrowDown />Move down</DropdownMenuItem>
          {!reorderable && <DropdownMenuLabel className="text-xs">Clear sorting, search and filters to move rows.</DropdownMenuLabel>}
        </>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onHide}>{hiddenMine ? <><Eye />Show in my view</> : <><EyeOff />Hide in my view</>}</DropdownMenuItem>
        {caps.share && <DropdownMenuItem onSelect={onRestrict}><Lock />Restrict access…</DropdownMenuItem>}
        {caps.deleteRows && <><DropdownMenuSeparator /><DropdownMenuItem tone="danger" onSelect={onDelete}><Trash2 />Delete row…</DropdownMenuItem></>}
      </DropdownMenuContent>}
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- cells
type Editors = {
  active: { row: string; col: string } | null; setActive: Dispatch<SetStateAction<{ row: string; col: string } | null>>; cells: Record<string, CellState>; saveCell: (row: Row, col: Row, value: unknown) => Promise<boolean>; discard: (row: Row, col: Row) => void;
  groupId: string; w: Workspace; nameOf: (id: string) => string; caps: Row;
  /** V5.6.9: puts a row the server sent back (after a file was added or removed) in place. */
  replaceRow: (row: Row) => void;
  /** After Enter saved a cell: edit the same column in the next row (a new row after the last one). */
  advance: (row: Row, col: Row, value: unknown) => void; lastRowId: string | null;
  /** The cell Enter moved to (its text is selected, so typing replaces it), and text typed for a row still being added. */
  enterTo: MutableRefObject<string>; seed: MutableRefObject<{ key: string; text: string } | null>;
};

function CellDisplay({ row, col, value, nameOf }: { row: Row; col: Row; value: unknown; nameOf: (id: string) => string }) {
  if (emptyValue(value)) return <span className="cell-empty"><span className="sr-only">empty</span></span>;
  // A Live Data cell that can't show a value: #N/A (no access), #DUP! (several matches), #REF! (source removed).
  if (col.linked && value && typeof value === 'object' && !Array.isArray(value)) { const code = String((value as Row).error || ''); return <span className="cell-error" title={LIVE_ERRORS[code]}><CircleAlert aria-hidden="true" />{code}<span className="sr-only">: {LIVE_ERRORS[code]}</span></span>; }
  switch (col.type) {
    case 'FORMULA': {
      if (value && typeof value === 'object') { const code = (value as Row).error; return <span className="cell-error" title={FORMULA_ERRORS[code as keyof typeof FORMULA_ERRORS]}><CircleAlert aria-hidden="true" />{code}<span className="sr-only">: {FORMULA_ERRORS[code as keyof typeof FORMULA_ERRORS]}</span></span>; }
      return <span className="num">{formatColumnNumber(value, col.settings)}</span>;
    }
    case 'NUMBER': return <span className="num">{formatColumnNumber(value, col.settings)}</span>;
    case 'DATE': return <span className="nowrap">{formatDay(value as string)}</span>;
    case 'STATUS': return <StatusChip label={statusLabels(col).find((l: Row) => l.id === value)} />;
    case 'IN_CHARGE': return <span className="person-cell small"><Avatar name={nameOf(value as string)} size="sm" />{nameOf(value as string)}</span>;
    case 'SUPPORT': return <span className="cell-people">{(value as string[]).map(x => <span key={x} className="person-cell small"><Avatar name={nameOf(x)} size="sm" />{nameOf(x).split(' · ')[0]}</span>)}</span>;
    case 'ATTACHMENT': return <FileChips files={value as Row[]} />;
    default: return <span className="cell-text">{String(value)}</span>;
  }

}

function GridCell(props: Editors & { row: Row; col: Row; onExpand: () => void; lifted?: boolean }) {
  // V5.6.9: an Attachment cell lists its files (open, download, and for editors upload and remove) in its own panel.
  if (props.col.type === 'ATTACHMENT') return <AttachmentCell row={props.row} col={props.col} groupId={props.groupId} caps={props.caps} replaceRow={props.replaceRow} lifted={props.lifted} />;
  return <EditableCell {...props} />;
}
function EditableCell({ row, col, active, setActive, cells, saveCell, discard, groupId, w, nameOf, caps, advance, lastRowId, enterTo, seed, onExpand, lifted, replaceRow }: Editors & { row: Row; col: Row; onExpand: () => void; lifted?: boolean }) {
  const key = cellKey(row.id, col.id), st = cells[key], editable = caps.editRows && col.type !== 'FORMULA' && !col.linked?.readOnly;
  const isActive = active?.row === row.id && active?.col === col.id;
  const value = col.type === 'FORMULA' ? row.computed?.[col.id] : row.values?.[col.id];
  // While a value is being saved the cell already shows it; a value that couldn't be saved stays shown with its message.
  const shownValue = st?.state === 'error' ? st.draft : st?.state === 'saving' ? st.shown : value;
  const start = () => { if (editable) setActive({ row: row.id, col: col.id }); };
  // Closing only closes this cell's editor: if another cell was opened meanwhile (click on it while this one saves),
  // that one stays open.
  const close = () => setActive(a => (a && a.row === row.id && a.col === col.id ? null : a));
  // After the editor closes, keyboard focus returns to the cell (unless the person has already moved elsewhere).
  const viewRef = useRef<HTMLButtonElement>(null), wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !isActive && (!document.activeElement || document.activeElement === document.body)) viewRef.current?.focus({ preventScroll: true });
    wasActive.current = isActive;
  }, [isActive]);
  const className = `grid-cell type-${col.type.toLowerCase()}${col.linked ? ' is-live' : ''}${st?.state === 'error' ? ' has-error' : ''}${st?.state === 'saving' ? ' is-saving' : ''}${isActive ? ' is-editing' : ''}${lifted ? ' is-dragging' : ''}`;
  const status = st?.state === 'saving' ? <Loader2 className="spin cell-status" aria-label="Saving" /> : st?.state === 'saved' ? <Check className="cell-status is-saved" aria-label="Saved" /> : null;
  // “Undo my change” puts the saved value back: the editor closes without saving (pressing the button does not count as
  // leaving the editor, so the rejected value is not sent again).
  const error = st?.state === 'error' ? <span className="cell-message" role="alert">{st.message} <button type="button" className="text-link" onMouseDown={e => e.preventDefault()} onClick={() => { discard(row, col); close(); }}>Undo my change</button></span> : null;
  const colorControl = caps.editRows ? <CellFormatControl groupId={groupId} row={row} col={col} onSaved={replaceRow} /> : null;
  if (isActive) {
    const typed = seed.current?.key === key ? seed.current.text : null;
    const initial = typed !== null ? typed : st?.state === 'error' || st?.state === 'saving' ? st.draft : value;
    // Enter saves and moves on at once (to the row below, or a new row after the last one) while the value is saved; a
    // value the column can't take stays in the editor with its message. Leaving the cell just saves.
    const onSave = async (v: unknown, next = false) => {
      if (next) {
        if (!cleanCell(col, v, { eligible: null, current: row.values?.[col.id] ?? null }).ok) return saveCell(row, col, v);
        void saveCell(row, col, v);
        advance(row, col, v);
        return true;
      }
      const ok = await saveCell(row, col, v); if (ok) close(); return ok;
    };
    const opened = () => { if (enterTo.current === key) enterTo.current = ''; if (seed.current?.key === key) seed.current = null; };
    return <td data-column-id={col.id} style={{ ...columnStyle(col.id), ...cellColors(row, col) }} className={className}><CellEditor row={row} col={col} initial={initial} groupId={groupId} w={w} nameOf={nameOf} onSave={onSave} onCancel={() => { discard(row, col); close(); }} onExpand={onExpand} saving={st?.state === 'saving'}
      lastRow={lastRowId === row.id} selectAll={typed === null && enterTo.current === key} seeded={typed !== null} onOpened={opened} />{error}</td>;
  }
  if (!editable) return <td data-column-id={col.id} style={{ ...columnStyle(col.id), ...cellColors(row, col) }} className={className} title={col.type === 'FORMULA' ? `${col.settings?.display || ''}${value && typeof value === 'object' ? ` · ${FORMULA_ERRORS[(value as Row).error as keyof typeof FORMULA_ERRORS] || ''}` : ''}` : undefined}><div className="grid-cell-view"><CellDisplay row={row} col={col} value={value} nameOf={nameOf} /></div>{colorControl}</td>;
  return (
    <td data-column-id={col.id} style={{ ...columnStyle(col.id), ...cellColors(row, col) }} className={className}>
      <button ref={viewRef} type="button" className="grid-cell-view" data-cell={key} onClick={start} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); start(); } }}
        aria-label={`${col.name}: ${cellText(col, shownValue, nameOf) || 'empty'}. Edit`}>
        <CellDisplay row={row} col={col} value={shownValue} nameOf={nameOf} />{status}
      </button>
      {error}{colorControl}
    </td>
  );
}

// ---------------------------------------------------------------- V5.6.9 Attachment cells
const fileUrl = (groupId: string, f: Row, inline = false) => apiPath(`/api/tasks/group/file?id=${encodeURIComponent(groupId)}&file=${encodeURIComponent(f.id)}${inline ? '&inline=1' : ''}`);
const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const FileKindIcon = ({ f }: { f: Row }) => (String(f.mime || '').startsWith('image/') ? <FileImage aria-hidden="true" /> : <FileText aria-hidden="true" />);
/** The files of a cell as small chips (the first three, then “+n”). */
function FileChips({ files }: { files: Row[] }) {
  const list = Array.isArray(files) ? files : [];
  return <span className="cell-files">{list.slice(0, 3).map(f => <span key={f.id} className="file-chip" title={f.name}><FileKindIcon f={f} /><span className="file-chip-name">{f.name}</span></span>)}{list.length > 3 && <span className="file-more">+{list.length - 3}</span>}</span>;
}
/** One Attachment cell: its files open in the in-app preview (images, PDF, Word, Excel, PowerPoint, CSV and text) or
 *  download; people who can edit records upload more (several at once) and remove them. In the table it is a cell; in
 *  card view, a field. */
function AttachmentCell({ row, col, groupId, caps, replaceRow, lifted, inline }: { row: Row; col: Row; groupId: string; caps: Row; replaceRow: (row: Row) => void; lifted?: boolean; inline?: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [preview, setPreview] = useState<Row | null>(null);
  const input = useRef<HTMLInputElement>(null), confirm = useConfirm(), asking = useRef(false);
  const files: Row[] = Array.isArray(row.values?.[col.id]) ? row.values[col.id] : [];
  const editable = !!caps.editRows, key = cellKey(row.id, col.id);
  const limitMb = GROUP_LIMITS.fileBytes / 1024 / 1024;
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setError('');
    for (const file of Array.from(list)) {
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      if (!Object.hasOwn(TASK_FILE_TYPES, ext)) { setError(`${file.name}: attach an image, a PDF, a Word, Excel or PowerPoint document, or a CSV, TXT or ZIP file.`); continue; }
      if (!file.size || file.size > GROUP_LIMITS.fileBytes) { setError(`${file.name}: choose a file between 1 byte and ${limitMb} MB.`); continue; }
      setBusy(file.name);
      try {
        const r = await groupCommand('tm.group.file.add', { group_id: groupId, row_id: row.id, column_id: col.id, name: file.name, base64: await fileToBase64(file) });
        if (r.row) replaceRow(r.row);
        toast.success(r.message || `${file.name} attached.`);
      } catch (e) { setError(`${file.name}: ${(e as Error).message}`); }
    }
    setBusy('');
    if (input.current) input.current.value = '';
  };
  const remove = async (f: Row) => {
    // The panel stays open while the question is asked (it would otherwise close as the question takes the focus).
    asking.current = true;
    const ok = await confirm({ title: `Remove “${f.name}”?`, description: 'The file is deleted from this row for everyone.', confirmLabel: 'Remove file', tone: 'danger' });
    asking.current = false;
    if (!ok) return;
    setBusy(f.name); setError('');
    try { const r = await groupCommand('tm.group.file.remove', { group_id: groupId, row_id: row.id, column_id: col.id, file_id: f.id }); if (r.row) replaceRow(r.row); toast.success(r.message || 'File removed.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const summary = files.length ? `${files.length} ${plural(files.length, 'file')}` : 'no files';
  const trigger = (
    <button type="button" className={inline ? 'attach-field' : 'grid-cell-view'} data-cell={inline ? undefined : key} aria-label={`${col.name}: ${summary}. ${editable ? 'Open to view, upload or remove files' : 'Open to view the files'}`}>
      {files.length ? <FileChips files={files} /> : editable ? <span className="cell-attach-hint"><Paperclip aria-hidden="true" />Attach files</span> : <span className="cell-empty"><span className="sr-only">no files</span></span>}
      {busy && <Loader2 className="spin cell-status" aria-label="Uploading" />}
    </button>
  );
  const panel = (<>
    <Popover open={open} onOpenChange={o => { if (!busy && !asking.current) setOpen(o); }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="attach-popover" aria-label={`${col.name}: files`}>
        <p className="attach-title"><Paperclip aria-hidden="true" />{col.name}<span className="muted small"> · {summary}</span></p>
        {error && <p className="field-error" role="alert">{error}</p>}
        {files.length ? <ul className="attach-list">
          {files.map(f => <li key={f.id} className="attach-item">
            <FileKindIcon f={f} />
            <span className="attach-text"><button type="button" className="attach-name" onClick={() => { setOpen(false); setPreview({ ...f, detail: col.name }); }} title="Preview">{f.name}</button><small>{fileSize(f.size)}</small></span>
            <a className="attach-action" href={fileUrl(groupId, f)} download={f.name} aria-label={`Download ${f.name}`} title="Download"><Download aria-hidden="true" /></a>
            {editable && <button type="button" className="attach-action" aria-label={`Remove ${f.name}`} title="Remove" disabled={!!busy} onClick={() => void remove(f)}><Trash2 aria-hidden="true" /></button>}
          </li>)}
        </ul> : <p className="muted small attach-empty">No files in this cell yet.</p>}
        {!!files.length && <GroupDelivery groupId={groupId} files={files} command={groupCommand} read={delivery => groupRead('/api/tasks/group/delivery', { id: groupId, delivery })} />}
        {editable && <div className="attach-foot">
          <CameraAttachment maxBytes={GROUP_LIMITS.fileBytes} disabled={!!busy||files.length>=GROUP_LIMITS.files} upload={async file=>{const r=await groupCommand('tm.group.file.add',{group_id:groupId,row_id:row.id,column_id:col.id,name:file.name,base64:await fileToBase64(file)});if(r.row)replaceRow(r.row);}} />
          <input ref={input} type="file" multiple accept={TASK_FILE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={e => void upload(e.target.files)} />
          <Button type="button" size="sm" loading={!!busy} disabled={!!busy || files.length >= GROUP_LIMITS.files} onClick={() => input.current?.click()}><Upload />{busy ? `Uploading ${busy}…` : 'Upload files'}</Button>
          <p className="field-hint">Images, PDF, Word, Excel, PowerPoint, CSV, TXT or ZIP · up to {limitMb} MB each · {GROUP_LIMITS.files} files per cell</p>
        </div>}
      </PopoverContent>
    </Popover>
    {preview && <GroupFilePreview groupId={groupId} file={preview as Row & { id: string; name: string; mime: string }} navigation={{ index: files.findIndex(f => f.id === preview.id), total: files.length, onSelect: i => setPreview({ ...files[i], detail: col.name }) }} onClose={() => setPreview(null)} />}
  </>);
  if (inline) return panel;
  return <td data-column-id={col.id} style={{ ...columnStyle(col.id), ...cellColors(row, col) }} className={`grid-cell type-attachment${lifted ? ' is-dragging' : ''}`}>{panel}{caps.editRows && <CellFormatControl groupId={groupId} row={row} col={col} onSaved={replaceRow} />}</td>;
}

/** The editor inside a cell: Enter saves and moves to the row below (V5.5.1: on the last row it adds a new row), Escape
 *  cancels, leaving the cell saves. What was typed stays if saving fails. */
function CellEditor({ row, col, initial, groupId, w, nameOf, onSave, onCancel, onExpand, saving, lastRow, selectAll, seeded, onOpened }: { row: Row; col: Row; initial: unknown; groupId: string; w: Workspace; nameOf: (id: string) => string; onSave: (v: unknown, next?: boolean) => Promise<boolean>; onCancel: () => void; onExpand?: () => void; saving?: boolean; lastRow?: boolean; selectAll?: boolean; seeded?: boolean; onOpened?: () => void }) {
  const [v, setV] = useState<unknown>(col.type === 'NUMBER' && typeof initial === 'number' ? String(initial) : initial ?? (col.type === 'SUPPORT' ? [] : ''));
  // `finished`: once a value is saved and the editor is moving on, nothing more is sent from it (for example when the
  // field loses focus as it closes).
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null), done = useRef(false), finished = useRef(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // The whole cell, with its hint line, comes into view clear of the header and the totals row.
    el.focus({ preventScroll: true });
    el.closest('td')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Opened by Enter from the row above: its text is selected, so typing replaces it (as in Excel). Text typed before
    // the cell opened (`seeded`) and other text cells: the cursor goes to the end, so typing goes on after it.
    if (seeded || (col.type === 'TEXT' && !selectAll)) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* no text cursor */ } } else if ('select' in el) el.select();
    onOpened?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (value = v, next = false) => { if (done.current || finished.current) return; done.current = true; try { if (await onSave(value, next)) finished.current = true; } finally { done.current = false; } };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    // Enter that only confirms an input method (Khmer, Chinese, Japanese…) is not a save.
    else if (e.key === 'Enter' && !(col.type === 'TEXT' && e.shiftKey) && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void save(v, true); }
  };
  const label = `${col.name} for this row`;
  if (col.type === 'TEXT') return (
    <div className="cell-editor">
      <Textarea ref={ref} aria-label={label} value={String(v ?? '')} rows={Math.min(6, Math.max(1, String(v ?? '').split('\n').length))} maxLength={GROUP_LIMITS.text} onChange={e => setV(e.target.value)} onKeyDown={keys} onBlur={() => void save()} disabled={saving} />
      <div className="cell-editor-tools"><span className="muted text-xs">Enter saves {lastRow ? 'and adds a row' : 'and moves down'} · Shift+Enter new line · Esc cancels</span>{onExpand && <IconButton label="Open a larger editor" icon={Expand} onMouseDown={e => e.preventDefault()} onClick={() => { onCancel(); onExpand(); }} />}</div>
    </div>
  );
  if (col.type === 'NUMBER') return <div className="cell-editor"><input ref={ref} className="cell-input num" type="text" inputMode="decimal" aria-label={label} value={String(v ?? '')} onChange={e => setV(e.target.value)} onKeyDown={keys} onBlur={() => void save()} disabled={saving} placeholder="0" /></div>;
  if (col.type === 'DATE') return <div className="cell-editor"><input ref={ref} className="cell-input" type="date" aria-label={label} value={String(v ?? '')} onChange={e => setV(e.target.value)} onKeyDown={keys} onBlur={() => void save()} disabled={saving} /></div>;
  if (col.type === 'STATUS') return (
    <Popover open onOpenChange={o => { if (!o) onCancel(); }}>
      <PopoverAnchor asChild><span className="cell-anchor"><CellDisplay row={row} col={col} value={v} nameOf={nameOf} /></span></PopoverAnchor>
      <PopoverContent align="start" className="status-popover" aria-label={`Choose ${col.name}`} onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}>
        <ul className="status-options" aria-label={col.name}>
          {statusLabels(col).map((l: Row) => <li key={l.id}><button type="button" className="status-option" aria-pressed={v === l.id} onClick={() => void save(l.id)} autoFocus={v === l.id}><StatusChip label={l} />{v === l.id && <Check aria-hidden="true" />}</button></li>)}
          <li><button type="button" className="status-option muted" aria-pressed={emptyValue(v)} onClick={() => void save(null)}>Clear</button></li>
        </ul>
      </PopoverContent>
    </Popover>
  );
  if (col.type === 'IN_CHARGE' || col.type === 'SUPPORT') {
    const multiple = col.type === 'SUPPORT', chosen = multiple ? (Array.isArray(v) ? v as string[] : []) : v ? [v as string] : [];
    return (
      <Popover open onOpenChange={o => { if (!o) { if (multiple && !same(chosen, initial ?? [])) void save(chosen); else onCancel(); } }}>
        <PopoverAnchor asChild><span className="cell-anchor"><CellDisplay row={row} col={col} value={v} nameOf={nameOf} /></span></PopoverAnchor>
        <PopoverContent align="start" className="person-popover member-popover" aria-label={`Choose ${col.name}`}>
          <MemberSearch groupId={groupId} w={w} nameOf={nameOf} selected={chosen} multiple={multiple}
            onPick={id => { if (multiple) setV(chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]); else void save(id); }} />
          <div className="member-popover-foot">
            {!multiple && chosen.length > 0 && <Button size="xs" variant="ghost" onClick={() => void save(null)}><X />Nobody</Button>}
            {multiple && <><Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button><Button size="xs" onClick={() => void save(chosen)} loading={saving}>Save</Button></>}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  return null;
}

/** Eligible members from the server (active members of the group's workspace, narrowed by its sharing), with search
 *  and paging so everyone can be found. People already chosen stay listed even if they are no longer available. */
function MemberSearch({ groupId, w, nameOf, selected, multiple, onPick }: { groupId: string; w: Workspace; nameOf: (id: string) => string; selected: string[]; multiple: boolean; onPick: (id: string) => void }) {
  const [q, setQ] = useState(''), [items, setItems] = useState<Row[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const listId = useId();
  const fetchPage = useCallback(async (query: string, offset: number) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/tasks/group/members?id=${encodeURIComponent(groupId)}&q=${encodeURIComponent(query)}&offset=${offset}&limit=30`), body = await res.json();
      if (!res.ok) throw new Error(body.error || 'People could not be loaded.');
      setItems(old => (offset ? [...old, ...body.items] : body.items)); setTotal(body.total); setError('');
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [groupId]);
  useEffect(() => { const t = window.setTimeout(() => void fetchPage(q, 0), q ? 250 : 0); return () => window.clearTimeout(t); }, [q, fetchPage]);
  const unavailable = selected.filter(x => !items.some(p => p.id === x));
  return (
    <div className="person-list-popup">
      <div className="person-search"><Search aria-hidden="true" /><input type="text" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or department" aria-label="Search people" aria-controls={listId} autoComplete="off" spellCheck={false} /></div>
      {error && <p className="field-error">{error}</p>}
      <ul id={listId} className="person-options" role="listbox" aria-multiselectable={multiple || undefined} aria-label="People">
        {!q && unavailable.map(x => <li key={x} role="option" aria-selected className="person-option" onClick={() => onPick(x)}><Avatar name={w.lookup(x)} size="sm" /><span className="person-option-text"><span className="person-option-name">{nameOf(x)}</span><small>Already chosen · can’t be chosen again once removed</small></span><Check className="person-option-check" aria-hidden="true" /></li>)}
        {items.map(p => <li key={p.id} role="option" aria-selected={selected.includes(p.id)} className="person-option" onClick={() => onPick(p.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p.id); } }} tabIndex={0}>
          <Avatar name={p.name} size="sm" /><span className="person-option-text"><span className="person-option-name">{p.name}{p.id === w.actor && <span className="muted"> (you)</span>}</span>{(p.department || p.position) && <small>{[p.department, p.position].filter(Boolean).join(' · ')}</small>}</span>
          {selected.includes(p.id) && <Check className="person-option-check" aria-hidden="true" />}
        </li>)}
      </ul>
      {!loading && !items.length && !error && <p className="person-empty" role="status">{q ? 'Nobody matches your search.' : 'Nobody can be chosen in this group yet.'}</p>}
      {loading && <p className="person-empty" role="status"><Loader2 className="spin inline-icon" aria-hidden="true" />Loading…</p>}
      {!loading && items.length < total && <button type="button" className="person-clear" onClick={() => void fetchPage(q, items.length)}>Show more ({total - items.length})</button>}
    </div>
  );
}

/** A cell in a dialog: long text, and editing on small screens (card layout). */
function CellDialog({ row, col, cells, saveCell, discard, groupId, w, nameOf, onClose }: Editors & { row: Row; col: Row; onClose: () => void }) {
  const st = cells[cellKey(row.id, col.id)], initial = st?.state === 'error' || st?.state === 'saving' ? st.draft : row.values?.[col.id];
  const [v, setV] = useState<unknown>(col.type === 'NUMBER' && typeof initial === 'number' ? String(initial) : initial ?? (col.type === 'SUPPORT' ? [] : ''));
  const [saving, setSaving] = useState(false);
  const save = async (value = v) => { setSaving(true); try { if (await saveCell(row, col, value)) onClose(); } finally { setSaving(false); } };
  const submit = (e: FormEvent) => { e.preventDefault(); void save(); };
  const error = cells[cellKey(row.id, col.id)]?.state === 'error' ? cells[cellKey(row.id, col.id)]?.message : '';
  return (
    <Dialog open onOpenChange={o => { if (!o && !saving) onClose(); }}>
      <DialogContent className={col.type === 'TEXT' ? 'dialog-md' : 'dialog-sm'}>
        <DialogHeader><DialogTitle>{col.name}</DialogTitle><DialogDescription>{COLUMN_TYPES[col.type as ColumnType]} · {COLUMN_HINTS[col.type as ColumnType]}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={saving}>
            <div className="dialog-body stack">
              {error && <Alert tone="danger" title="Not saved" live>{error}</Alert>}
              {col.type === 'TEXT' ? <div className="field"><label className="field-label" htmlFor="cell-dialog-text">{col.name}</label><Textarea id="cell-dialog-text" autoFocus rows={10} value={String(v ?? '')} maxLength={GROUP_LIMITS.text} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} /><p className="field-hint">{String(v ?? '').length.toLocaleString('en-US')} of {GROUP_LIMITS.text.toLocaleString('en-US')} characters · Ctrl+Enter saves</p></div>
                : col.type === 'NUMBER' ? <Field label={col.name} value={String(v ?? '')} onChange={setV} inputMode="decimal" hint="Whole numbers or decimals, for example -12.5. Leave empty to clear." />
                  : col.type === 'DATE' ? <Field label={col.name} type="date" value={String(v ?? '')} onChange={setV} hint="Leave empty to clear." />
                    : col.type === 'STATUS' ? <Picker label={col.name} value={v} none="Empty" options={statusLabels(col).map((l: Row) => [l.id, l.name])} onChange={x => setV(x || null)} />
                      : <div className="member-inline"><p className="field-label">{col.name}</p>
                        {col.type === 'SUPPORT' && Array.isArray(v) && (v as string[]).length > 0 && <ul className="people-chips">{(v as string[]).map(x => <li key={x} className="person-chip"><Avatar name={w.lookup(x)} size="sm" /><span className="person-chip-name">{nameOf(x)}</span><button type="button" className="person-chip-remove" aria-label={`Remove ${w.lookup(x)}`} onClick={() => setV((v as string[]).filter(y => y !== x))}><X aria-hidden="true" /></button></li>)}</ul>}
                        {col.type === 'IN_CHARGE' && !!v && <p className="person-cell"><Avatar name={w.lookup(v as string)} size="sm" />{nameOf(v as string)} <Button type="button" size="xs" variant="ghost" onClick={() => setV(null)}>Remove</Button></p>}
                        <MemberSearch groupId={groupId} w={w} nameOf={nameOf} selected={col.type === 'SUPPORT' ? (Array.isArray(v) ? v as string[] : []) : v ? [v as string] : []} multiple={col.type === 'SUPPORT'}
                          onPick={id => setV(col.type === 'SUPPORT' ? ((Array.isArray(v) ? v as string[] : []).includes(id) ? (v as string[]).filter(x => x !== id) : [...(Array.isArray(v) ? v as string[] : []), id]) : id)} />
                      </div>}
            </div>
            <div className="dialog-footer">
              {error && <div className="footer-start"><Button type="button" variant="ghost" onClick={() => { discard(row, col); onClose(); }}>Undo my change</Button></div>}
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- filters
function FilterDialog({ col, groupId, nameOf, onClose, onApply }: { col: Row; groupId: string; nameOf: (id: string) => string; onClose: () => void; onApply: (f: Filter) => void }) {
  const [f, setF] = useState<Filter>({ col: col.id, value: '' });
  const [people, setPeople] = useState<Row[]>([]);
  useEffect(() => {
    if (col.type !== 'IN_CHARGE' && col.type !== 'SUPPORT') return;
    void apiFetch(`/api/tasks/group/members?id=${encodeURIComponent(groupId)}&limit=100`).then(r => r.json()).then(b => setPeople(b.items || [])).catch(() => setPeople([]));
  }, [col, groupId]);
  const submit = (e: FormEvent) => { e.preventDefault(); onApply(f); };
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-sm">
        <DialogHeader><DialogTitle>Filter by {col.name}</DialogTitle><DialogDescription>Show only the rows that match. Filters can be removed from the list above the table.</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-body stack">
            {col.type === 'NUMBER' || col.type === 'FORMULA' ? <div className="grid-2"><Field label="At least" value={f.min || ''} inputMode="decimal" onChange={v => setF(s => ({ ...s, min: v }))} /><Field label="At most" value={f.max || ''} inputMode="decimal" onChange={v => setF(s => ({ ...s, max: v }))} /></div>
              : col.type === 'DATE' ? <div className="grid-2"><Field label="From" type="date" value={f.from || ''} onChange={v => setF(s => ({ ...s, from: v }))} /><Field label="To" type="date" value={f.to || ''} onChange={v => setF(s => ({ ...s, to: v }))} /></div>
                : col.type === 'STATUS' ? <Picker label={col.name} value={f.value} none="Empty (no status)" options={statusLabels(col).map((l: Row) => [l.id, l.name])} onChange={v => setF(s => ({ ...s, value: v }))} />
                  : col.type === 'IN_CHARGE' || col.type === 'SUPPORT' ? <Picker label={col.type === 'SUPPORT' ? `${col.name} includes` : col.name} value={f.value} none="Nobody chosen" options={people.map(p => [p.id, nameOf(p.id)])} onChange={v => setF(s => ({ ...s, value: v }))} />
                    : <Field label="Contains" value={f.value || ''} onChange={v => setF(s => ({ ...s, value: v }))} placeholder="Text to look for" />}
          </div>
          <div className="dialog-footer"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Apply filter</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- group activity and access
/** Recent changes to the group (structure, sharing, rows added or deleted), from the group's “More” menu. */
function ActivityDialog({ w, name, activity, onClose }: { w: Workspace; name: string; activity: Row[]; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle>Recent changes</DialogTitle><DialogDescription>{name}. Structure, sharing and rows added or deleted are recorded; individual cell edits are not listed here.</DialogDescription></DialogHeader>
        <div className="dialog-body" role="region" aria-label="Recent changes" tabIndex={0}>
          {activity.length ? <ol className="timeline compact">{activity.map((a, i) => <li key={i}><span className="timeline-dot" aria-hidden="true" /><div className="timeline-body"><p className="timeline-title">{a.action}</p>{a.detail && <p className="timeline-detail">{a.detail}</p>}<p className="timeline-meta">{formatDateTime(a.created_at)} · {w.lookup(a.actor_id)}</p></div></li>)}</ol>
            : <p className="muted small">No changes recorded yet.</p>}
        </div>
        <div className="dialog-footer"><Button onClick={onClose}>Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}
function AccessDialog({ w, group: g, onClose, onEdit }: { w: Workspace; group: Row; onClose: () => void; onEdit?: () => void }) {
  const ws = w.data.tm_workspaces.find((x: Row) => x.id === g.workspace_id), members = (w.data.tm_members || []).filter((m: Row) => m.workspace_id === g.workspace_id).length;
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-md">
        <DialogHeader><DialogTitle>Who can open “{g.name}”</DialogTitle><DialogDescription>{g.visibility === 'TEAM' ? `A team group in ${ws?.name || 'this workspace'}.` : 'A personal group.'} Choosing someone in an In Charge or Support cell never gives them access.</DialogDescription></DialogHeader>
        <div className="dialog-body stack" role="region" aria-label="People who can open this group" tabIndex={0}>
          <ul className="access-list">
            <li><Avatar name={w.lookup(g.owner_id)} size="md" /><span className="cell-stack"><span className="person-name">{w.lookup(g.owner_id)}{g.owner_id === w.actor && <span className="muted"> (you)</span>}</span><small>{LEVEL_HINTS.OWNER}</small></span><StatusBadge value="OWNER" label="Owner" tone="accent" /></li>
            {g.visibility === 'TEAM' && g.audience === 'WORKSPACE' && <li><span className="access-icon" aria-hidden="true"><Users /></span><span className="cell-stack"><span className="person-name">Everyone in {ws?.name || 'the workspace'}</span><small>{members} {plural(members, 'member')} · {LEVEL_HINTS[g.workspace_level as keyof typeof LEVEL_HINTS]}</small></span><StatusBadge value={g.workspace_level} label={LEVEL_LABELS[g.workspace_level as keyof typeof LEVEL_LABELS]} tone="info" /></li>}
            {g.visibility === 'TEAM' && (g.shared || []).map((a: Row) => <li key={a.staff_id}><Avatar name={a.name} size="md" /><span className="cell-stack"><span className="person-name">{a.name}{a.staff_id === w.actor && <span className="muted"> (you)</span>}</span><small>{LEVEL_HINTS[a.level as keyof typeof LEVEL_HINTS]}</small></span><StatusBadge value={a.level} label={LEVEL_LABELS[a.level as keyof typeof LEVEL_LABELS]} tone="info" /></li>)}
          </ul>
          {g.visibility !== 'TEAM' ? <p className="muted small">Nobody else can open a personal group, including administrators. Its owner can share it by making it a team group.</p>
            : <p className="muted small">People must still belong to {ws?.name || 'the workspace'} to open it. Administrators with the Groups “Approve” permission can also manage team groups. What each person can change also depends on their role’s Groups permissions.</p>}
        </div>
        <div className="dialog-footer">{onEdit && <div className="footer-start"><Button variant="outline" onClick={onEdit}><Settings2 />Change sharing</Button></div>}<Button onClick={onClose}>Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ group settings (create, rename, sharing)
function GroupSettingsDialog({ w, group, workspaceId, tab: initialTab, onClose, onSaved }: { w: Workspace; group: Row | null; workspaceId: string; tab?: string; onClose: () => void; onSaved: (id?: string) => void }) {
  const [tab, setTab] = useState(initialTab === 'google' ? 'google' : 'general');
  const isNew = !group, caps = group ? capsFor(w, group) : null;
  const shared0: Row[] = group ? (w.data.tm_board_access || []).filter((a: Row) => a.board_id === group.id).map((a: Row) => ({ staff_id: a.staff_id, level: a.level })) : [];
  const [d, setD] = useState<Row>({ workspace_id: group?.workspace_id || workspaceId, name: group?.name || '', description: group?.description || '', visibility: group?.visibility || 'PERSONAL', audience: group?.audience || 'SELECTED', workspace_level: group?.workspace_level || 'EDIT', shared: shared0 });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [nameError, setNameError] = useState(''), [dirty, setDirty] = useState(false);
  const confirm = useConfirm(), visId = useId();
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setDirty(true); };
  const owner = group?.owner_id || w.actor;
  const wsList: Row[] = w.data.tm_workspaces.filter((x: Row) => (w.data.tm_group_workspaces || []).includes(x.id));
  const members: Row[] = (w.data.tm_members || []).filter((m: Row) => m.workspace_id === d.workspace_id && m.staff_id !== owner);
  const profiles = new Map<string, Row>((w.data.tm_profiles || []).map((p: Row) => [p.staff_id, p]));
  const options = members.map((m: Row) => ({ id: m.staff_id, name: w.lookup(m.staff_id), detail: [profiles.get(m.staff_id)?.department, profiles.get(m.staff_id)?.position].filter(Boolean).join(' · ') || undefined })).filter(p => profiles.get(p.id)?.active !== 0);
  const canName = isNew || caps?.rename, canShare = isNew || caps?.share, canVisibility = isNew || caps?.visibility;
  const close = async () => { if (busy) return; if (dirty && !(await confirm({ title: 'Discard your changes?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' }))) return; onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) { setNameError('Enter a name for the group.'); return; }
    if (isNew && !d.workspace_id) { setError('Choose a workspace.'); return; }
    if (group && group.visibility === 'TEAM' && d.visibility === 'PERSONAL' && !(await confirm({ title: 'Make this group personal?', description: 'Only its owner will be able to open it. Everyone it is shared with loses access.', confirmLabel: 'Make personal', tone: 'danger' }))) return;
    setBusy(true); setError('');
    try {
      const r = await groupCommand('tm.group.save', { ...(group ? { id: group.id, expected_version: group.version } : { workspace_id: d.workspace_id }), name: d.name, description: d.description, visibility: d.visibility, audience: d.audience, workspace_level: d.workspace_level, shared: d.visibility === 'TEAM' ? d.shared : [] });
      toast.success(r.message || 'Saved'); await w.refresh({ quiet: true }); onSaved(isNew ? r.id : undefined);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const addPeople = (ids: string[]) => set('shared', [...d.shared.filter((x: Row) => ids.includes(x.staff_id)), ...ids.filter(id => !d.shared.some((x: Row) => x.staff_id === id)).map(id => ({ staff_id: id, level: 'EDIT' }))]);
  return (
    <Dialog open onOpenChange={o => { if (!o) void close(); }}>
      <DialogContent className="dialog-lg" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader><DialogTitle>{isNew ? 'Create a group' : `Settings for “${group!.name}”`}</DialogTitle><DialogDescription>{isNew ? 'A group is a table you design. It starts with one text column, “Item”, which you can rename.' : 'Name, description and who can open this group.'}</DialogDescription></DialogHeader>
        {group && caps?.share ? <Tabs value={tab} onValueChange={setTab} className="settings-tabs">
          <TabsList className="settings-tablist"><TabsTrigger value="general">Name and sharing</TabsTrigger><TabsTrigger value="google"><Sheet aria-hidden="true" />Google Sheets</TabsTrigger></TabsList>
          <TabsContent value="general">
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {error && <Alert tone="danger" title="This could not be saved" live>{error}</Alert>}
              <FormSection title="Group">
                {isNew && <Picker label="Workspace" required value={d.workspace_id} allowNone={false} options={wsList.map(x => [x.id, x.name])} onChange={v => { set('workspace_id', v); set('shared', []); }} hint="Groups belong to one workspace. Only its members can be given access." />}
                <Field label="Group name" required value={d.name} onChange={v => { set('name', v); setNameError(''); }} error={nameError} maxLength={GROUP_LIMITS.name} disabled={!canName} placeholder="For example: Operational Tracking" wide={!isNew} />
                <Field label="Description" type="textarea" wide value={d.description} onChange={v => set('description', v)} maxLength={GROUP_LIMITS.description} disabled={!canName} hint="Optional. What the group is for." />
              </FormSection>
              <FormSection title="Who can open it" columns={1}>
                <fieldset className="choice-cards" aria-describedby={`${visId}-hint`} disabled={!canVisibility}>
                  <legend className="field-label">Visibility</legend>
                  {[['PERSONAL', 'Personal', 'Private tracking. Only you can open it.', Lock], ['TEAM', 'Team', 'Shared tracking with people in this workspace, or the whole workspace.', Users]].map(([value, label, hint, Icon]) => {
                    const I = Icon as LucideIcon;
                    return <label key={value as string} className={`choice-card${d.visibility === value ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-vis`} value={value as string} checked={d.visibility === value} onChange={() => set('visibility', value)} /><I aria-hidden="true" className="choice-icon" /><span className="cell-stack"><span className="cell-title">{label as string}</span><small>{hint as string}</small></span></label>;
                  })}
                  <p className="field-hint" id={`${visId}-hint`}>{canVisibility ? 'Choosing someone in an In Charge or Support cell never gives them access.' : 'Only the group’s owner can change this.'}</p>
                </fieldset>
                {d.visibility === 'TEAM' && <>
                  <fieldset className="choice-cards" disabled={!canShare}>
                    <legend className="field-label">Share with</legend>
                    <label className={`choice-card${d.audience === 'WORKSPACE' ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-aud`} checked={d.audience === 'WORKSPACE'} onChange={() => set('audience', 'WORKSPACE')} /><span className="cell-stack"><span className="cell-title">Everyone in {w.data.tm_workspaces.find((x: Row) => x.id === d.workspace_id)?.name || 'the workspace'}</span><small>All current and future members of the workspace.</small></span></label>
                    <label className={`choice-card${d.audience === 'SELECTED' ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-aud`} checked={d.audience === 'SELECTED'} onChange={() => set('audience', 'SELECTED')} /><span className="cell-stack"><span className="cell-title">Selected people</span><small>Only the members you choose below.</small></span></label>
                  </fieldset>
                  {d.audience === 'WORKSPACE' && <Picker label="Everyone in the workspace can" value={d.workspace_level} allowNone={false} disabled={!canShare} options={[['VIEW', LEVEL_LABELS.VIEW], ['EDIT', LEVEL_LABELS.EDIT]]} onChange={v => set('workspace_level', v)} hint="Give individual people more access below, for example “Can manage” to change columns." />}
                  <div className="share-people">
                    <p className="field-label">{d.audience === 'WORKSPACE' ? 'People with more access (optional)' : 'People'}</p>
                    <SharePicker options={options} value={d.shared.map((x: Row) => x.staff_id)} onChange={addPeople} disabled={!canShare} />
                    {d.shared.length > 0 && <ul className="share-list">
                      {d.shared.map((x: Row) => <li key={x.staff_id}><Avatar name={w.lookup(x.staff_id)} size="sm" /><span className="person-name">{w.lookup(x.staff_id)}</span>
                        <Picker label={`Access for ${w.lookup(x.staff_id)}`} hideLabel value={x.level} allowNone={false} disabled={!canShare} options={(['VIEW', 'EDIT', 'MANAGE'] as const).map(l => [l, LEVEL_LABELS[l]])} onChange={v => set('shared', d.shared.map((y: Row) => (y.staff_id === x.staff_id ? { ...y, level: v } : y)))} className="share-level" />
                        {canShare && <IconButton label={`Remove ${w.lookup(x.staff_id)}`} icon={X} onClick={() => set('shared', d.shared.filter((y: Row) => y.staff_id !== x.staff_id))} />}</li>)}
                    </ul>}
                    <p className="field-hint">Can view: read only. Can edit records: add, change and delete rows. Can manage: also change columns, formulas and sharing. {options.length ? '' : 'This workspace has no other members yet.'}</p>
                  </div>
                </>}
              </FormSection>
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>Cancel</Button>
              <Button type="submit" loading={busy}>{busy ? 'Saving…' : isNew ? 'Create group' : 'Save'}</Button>
            </div>
          </fieldset>
        </form>
          </TabsContent>
          <TabsContent value="google"><div className="dialog-body"><GoogleSheetsPanel w={w} groupId={group.id} groupName={group.name} /></div><div className="dialog-footer"><Button type="button" onClick={onClose}>Close</Button></div></TabsContent>
        </Tabs> : <>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {error && <Alert tone="danger" title="This could not be saved" live>{error}</Alert>}
              <FormSection title="Group">
                {isNew && <Picker label="Workspace" required value={d.workspace_id} allowNone={false} options={wsList.map(x => [x.id, x.name])} onChange={v => { set('workspace_id', v); set('shared', []); }} hint="Groups belong to one workspace. Only its members can be given access." />}
                <Field label="Group name" required value={d.name} onChange={v => { set('name', v); setNameError(''); }} error={nameError} maxLength={GROUP_LIMITS.name} disabled={!canName} placeholder="For example: Operational Tracking" wide={!isNew} />
                <Field label="Description" type="textarea" wide value={d.description} onChange={v => set('description', v)} maxLength={GROUP_LIMITS.description} disabled={!canName} hint="Optional. What the group is for." />
              </FormSection>
              <FormSection title="Who can open it" columns={1}>
                <fieldset className="choice-cards" aria-describedby={`${visId}-hint`} disabled={!canVisibility}>
                  <legend className="field-label">Visibility</legend>
                  {[['PERSONAL', 'Personal', 'Private tracking. Only you can open it.', Lock], ['TEAM', 'Team', 'Shared tracking with people in this workspace, or the whole workspace.', Users]].map(([value, label, hint, Icon]) => {
                    const I = Icon as LucideIcon;
                    return <label key={value as string} className={`choice-card${d.visibility === value ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-vis`} value={value as string} checked={d.visibility === value} onChange={() => set('visibility', value)} /><I aria-hidden="true" className="choice-icon" /><span className="cell-stack"><span className="cell-title">{label as string}</span><small>{hint as string}</small></span></label>;
                  })}
                  <p className="field-hint" id={`${visId}-hint`}>{canVisibility ? 'Choosing someone in an In Charge or Support cell never gives them access.' : 'Only the group’s owner can change this.'}</p>
                </fieldset>
                {d.visibility === 'TEAM' && <>
                  <fieldset className="choice-cards" disabled={!canShare}>
                    <legend className="field-label">Share with</legend>
                    <label className={`choice-card${d.audience === 'WORKSPACE' ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-aud`} checked={d.audience === 'WORKSPACE'} onChange={() => set('audience', 'WORKSPACE')} /><span className="cell-stack"><span className="cell-title">Everyone in {w.data.tm_workspaces.find((x: Row) => x.id === d.workspace_id)?.name || 'the workspace'}</span><small>All current and future members of the workspace.</small></span></label>
                    <label className={`choice-card${d.audience === 'SELECTED' ? ' is-checked' : ''}`}><input type="radio" name={`${visId}-aud`} checked={d.audience === 'SELECTED'} onChange={() => set('audience', 'SELECTED')} /><span className="cell-stack"><span className="cell-title">Selected people</span><small>Only the members you choose below.</small></span></label>
                  </fieldset>
                  {d.audience === 'WORKSPACE' && <Picker label="Everyone in the workspace can" value={d.workspace_level} allowNone={false} disabled={!canShare} options={[['VIEW', LEVEL_LABELS.VIEW], ['EDIT', LEVEL_LABELS.EDIT]]} onChange={v => set('workspace_level', v)} hint="Give individual people more access below, for example “Can manage” to change columns." />}
                  <div className="share-people">
                    <p className="field-label">{d.audience === 'WORKSPACE' ? 'People with more access (optional)' : 'People'}</p>
                    <SharePicker options={options} value={d.shared.map((x: Row) => x.staff_id)} onChange={addPeople} disabled={!canShare} />
                    {d.shared.length > 0 && <ul className="share-list">
                      {d.shared.map((x: Row) => <li key={x.staff_id}><Avatar name={w.lookup(x.staff_id)} size="sm" /><span className="person-name">{w.lookup(x.staff_id)}</span>
                        <Picker label={`Access for ${w.lookup(x.staff_id)}`} hideLabel value={x.level} allowNone={false} disabled={!canShare} options={(['VIEW', 'EDIT', 'MANAGE'] as const).map(l => [l, LEVEL_LABELS[l]])} onChange={v => set('shared', d.shared.map((y: Row) => (y.staff_id === x.staff_id ? { ...y, level: v } : y)))} className="share-level" />
                        {canShare && <IconButton label={`Remove ${w.lookup(x.staff_id)}`} icon={X} onClick={() => set('shared', d.shared.filter((y: Row) => y.staff_id !== x.staff_id))} />}</li>)}
                    </ul>}
                    <p className="field-hint">Can view: read only. Can edit records: add, change and delete rows. Can manage: also change columns, formulas and sharing. {options.length ? '' : 'This workspace has no other members yet.'}</p>
                  </div>
                </>}
              </FormSection>
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>Cancel</Button>
              <Button type="submit" loading={busy}>{busy ? 'Saving…' : isNew ? 'Create group' : 'Save'}</Button>
            </div>
          </fieldset>
        </form>
        </>}
      </DialogContent>
    </Dialog>
  );
}
function SharePicker({ options, value, onChange, disabled }: { options: { id: string; name: string; detail?: string }[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [q, setQ] = useState('');
  const available = options.filter(p => !value.includes(p.id) && `${p.name} ${p.detail || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled || !options.some(p => !value.includes(p.id))}><Plus />Add people</Button></PopoverTrigger>
      <PopoverContent align="start" className="person-popover" aria-label="Add people">
        <div className="person-list-popup">
          <div className="person-search"><Search aria-hidden="true" /><input type="text" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search workspace members" aria-label="Search workspace members" /></div>
          <ul className="person-options" role="listbox" aria-label="Workspace members">
            {available.map(p => <li key={p.id} role="option" aria-selected={false} tabIndex={0} className="person-option" onClick={() => onChange([...value, p.id])} onKeyDown={e => { if (e.key === 'Enter') onChange([...value, p.id]); }}><Avatar name={p.name} size="sm" /><span className="person-option-text"><span className="person-option-name">{p.name}</span>{p.detail && <small>{p.detail}</small>}</span></li>)}
          </ul>
          {!available.length && <p className="person-empty">Nobody else to add.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ================================================================ columns
const DECIMAL_OPTIONS: [string, string][] = [['auto', 'As entered (up to 6)'], ...[0, 1, 2, 3, 4, 5, 6].map(n => [String(n), n === 0 ? 'No decimals' : `${n} decimal place${n === 1 ? '' : 's'}`] as [string, string])];
function ColumnDialog({ w, group, columns, rows, column, after, onClose, onSaved }: { w: Workspace; group: Row; columns: Row[]; rows: Row[]; column?: Row; after?: string; onClose: () => void; onSaved: (message: string) => void | Promise<void> }) {
  const isNew = !column, live: Row | undefined = column?.linked;
  const [d, setD] = useState<Row>(() => ({
    format: column?.settings?.format || 'GENERAL', prefix: column?.settings?.prefix || '', suffix: column?.settings?.suffix || '', grouping: column?.settings?.grouping !== false,
    name: column?.name || '', type: column?.type || 'TEXT', decimals: column?.settings?.decimals ?? '',
    labels: column?.type === 'STATUS' ? statusLabels(column).map((l: Row) => ({ ...l })) : DEFAULT_STATUS_LABELS.map(([name, color]) => ({ name, color })),
    expression: column?.type === 'FORMULA' ? column.settings?.display || '' : '',
  }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
  const [replacements, setReplacements] = useState<{ labels: Row[]; choice: Record<string, string> } | null>(null);
  const confirm = useConfirm(), typeId = useId();
  const set = (k: string, v: unknown) => { setD(s => ({ ...s, [k]: v })); setDirty(true); setError(''); };
  const nameError = d.name ? columnNameError(d.name, columns, column?.id) : null;
  const typeChanged = !!column && column.type !== d.type;
  const dependents = column ? (column.used_by || []).map((x: string) => columns.find(c => c.id === x)?.name).filter(Boolean) : [];
  const close = async () => { if (busy) return; if (dirty && !(await confirm({ title: 'Discard your changes?', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'danger' }))) return; onClose(); };
  const send = async (extra: Row = {}): Promise<void> => {
    setBusy(true); setError('');
    try {
      const settings: Row = {};
      if (d.type === 'NUMBER' || d.type === 'FORMULA') Object.assign(settings, { decimals: d.decimals === '' ? null : Number(d.decimals), format: d.format, prefix: d.prefix, suffix: d.suffix, grouping: d.grouping });
      if (d.type === 'STATUS') settings.labels = d.labels.map((l: Row) => ({ ...(l.id ? { id: l.id } : {}), name: l.name, color: l.color }));
      if (d.type === 'FORMULA') settings.expression = d.expression;
      const r = await groupCommand('tm.group.column.save', { group_id: group.id, ...(column ? { id: column.id, expected_version: column.version } : after ? { after } : {}), name: d.name, type: live ? 'LINKED' : d.type, settings: live ? {} : settings, ...extra });
      await onSaved(r.message || 'Saved');
    } catch (e) {
      const err = e as GroupError, code = err.details?.code;
      if (code === 'labels_in_use') { setReplacements({ labels: err.details!.labels, choice: {} }); setError(''); }
      else if (code === 'type_change') {
        if (await confirm({ title: `Change the type and clear ${err.details!.count} ${plural(err.details!.count, 'value')}?`, description: err.message, confirmLabel: 'Change type and clear', tone: 'danger' })) { setBusy(false); return send({ ...extra, confirm_clear: true }); }
        setError(err.message);
      } else setError(err.message);
    } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) { setError('Enter a column name.'); return; }
    if (nameError) { setError(nameError); return; }
    if (d.type === 'STATUS' && d.labels.some((l: Row) => !String(l.name || '').trim())) { setError('Give every label a name, or remove it.'); return; }
    void send();
  };
  const applyReplacements = () => {
    if (!replacements) return;
    const map: Record<string, string | null> = {};
    for (const l of replacements.labels) { const c = replacements.choice[l.id]; if (c === undefined || c === '') { setError(`Choose what happens to the rows labelled “${l.name}”.`); return; } map[l.id] = c === '__clear' ? null : c; }
    setReplacements(null); void send({ label_replacements: map });
  };
  const formulaColumns = columns.filter(c => c.id !== column?.id && (c.type === 'NUMBER' || c.type === 'FORMULA'));
  return (
    <Dialog open onOpenChange={o => { if (!o) void close(); }}>
      <DialogContent className="dialog-lg" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader><DialogTitle>{isNew ? 'Add a column' : `Column “${column!.name}”`}</DialogTitle><DialogDescription>{isNew ? `Added ${after ? `after “${columns.find(c => c.id === after)?.name}”` : 'at the end'}. Every row gets this column.` : 'Renaming or moving a column keeps its values and formulas.'}</DialogDescription></DialogHeader>
        <form className="dialog-form" onSubmit={submit} noValidate>
          <fieldset disabled={busy}>
            <div className="dialog-body">
              {error && <Alert tone="danger" title="This could not be saved" live>{error}</Alert>}
              {replacements && <Alert tone="warning" title="Some labels are still used">
                <p>Choose a replacement for each removed label, or clear those cells.</p>
                <ul className="replace-list">{replacements.labels.map((l: Row) => <li key={l.id}><span>“{l.name}” · {l.count} {plural(l.count, 'row')}</span>
                  <Picker label={`Replace “${l.name}” with`} hideLabel value={replacements.choice[l.id] || ''} none="Choose…" options={[...d.labels.filter((x: Row) => x.id).map((x: Row) => [x.id, `Use “${x.name}”`] as [string, string]), ['__clear', 'Clear these cells']]} onChange={v => setReplacements(r => r && ({ ...r, choice: { ...r.choice, [l.id]: v } }))} /></li>)}</ul>
                <div className="row mt-2"><Button type="button" size="sm" onClick={applyReplacements}>Save with these choices</Button><Button type="button" size="sm" variant="ghost" onClick={() => setReplacements(null)}>Back</Button></div>
              </Alert>}
              <FormSection title="Column">
                <Field label="Column name" required value={d.name} onChange={v => set('name', v)} error={nameError || undefined} maxLength={GROUP_LIMITS.name} hint="Unique in this group. Formulas refer to it as {Name}." wide />
              </FormSection>
              {live && <Alert tone="info" icon={Link2} title={live.state === 'ok' ? `Live Data from ${live.source_group_name}` : 'Live Data'}>{live.state === 'ok' ? `Shows “${live.source_name}”, matched by ${live.source_key_name}. ${live.permission === 'EDIT' ? 'You can edit it (Can edit); changes are saved in the source group.' : 'View only (Viewer).'} Its values are never copied into this group.` : 'The source is not available to you, so its values are not shown.'} Only its name can be changed here.</Alert>}
              {!live && <fieldset className="type-cards" aria-describedby={`${typeId}-hint`}>
                <legend className="field-label">Type</legend>
                {TYPE_ORDER.map(t => { const Icon = TYPE_ICON[t]; return (
                  <label key={t} className={`type-card${d.type === t ? ' is-checked' : ''}`}>
                    <input type="radio" name={`${typeId}-type`} value={t} checked={d.type === t} onChange={() => set('type', t)} />
                    <Icon aria-hidden="true" /><span className="cell-stack"><span className="cell-title">{COLUMN_TYPES[t]}</span><small>{COLUMN_HINTS[t]}</small></span>
                  </label>
                ); })}
                <p className="field-hint" id={`${typeId}-hint`}>{typeChanged ? `Changing ${COLUMN_TYPES[column!.type as ColumnType]} to ${COLUMN_TYPES[d.type as ColumnType]}: values that fit are converted; you are asked before any value is cleared.` : 'You can change the type later; values are checked first.'}</p>
              </fieldset>}
              {typeChanged && dependents.length > 0 && !['NUMBER', 'FORMULA'].includes(d.type) && <Alert tone="warning" title="Used by formulas">{dependents.join(', ')} {dependents.length === 1 ? 'uses' : 'use'} this column. Change {dependents.length === 1 ? 'that formula' : 'those formulas'} before changing its type.</Alert>}
              {!live && (d.type === 'NUMBER' || d.type === 'FORMULA') && <FormSection columns={2}><Picker label="Decimal places shown" value={d.decimals === '' || d.decimals === null || d.decimals === undefined ? 'auto' : String(d.decimals)} allowNone={false} options={DECIMAL_OPTIONS} onChange={v => set('decimals', v === 'auto' ? '' : v)} hint="Only changes how numbers are shown; stored values keep their full precision." /></FormSection>}
              {!live && ['NUMBER', 'FORMULA'].includes(d.type) && <FormSection columns={2}><Picker label="Display format" value={d.format} allowNone={false} options={[["GENERAL", "General number"], ["USD", "USD ($)"], ["KHR", "Cambodian Riel (៛)"], ["PERCENT", "Percentage (%)"], ["CUSTOM", "Custom prefix / suffix"]]} onChange={v => set('format', v)} /><CheckboxField label="Thousands separators" checked={d.grouping} onChange={v => set('grouping', v)} />{d.format === 'CUSTOM' && <><Field label="Prefix" value={d.prefix} onChange={v => set('prefix', v)} maxLength={12} /><Field label="Suffix" value={d.suffix} onChange={v => set('suffix', v)} maxLength={12} /></>}<p className="field-hint">Example: {formatColumnNumber(d.format === 'PERCENT' ? 25 : 1500, { ...d, decimals: d.decimals === '' ? null : Number(d.decimals) })}. Percentage adds a % symbol; 25 stays 25.</p></FormSection>}
              {!live && d.type === 'STATUS' && <StatusLabelsEditor labels={d.labels} onChange={v => set('labels', v)} used={column?.type === 'STATUS' ? Object.fromEntries(statusLabels(column).map((l: Row) => [l.id, rows.filter(r => r.values?.[column.id] === l.id).length])) : {}} />}
              {d.type === 'FORMULA' && <FormulaEditor columns={columns} selfId={column?.id || null} name={d.name || 'this column'} ownName={d.name || ''} value={d.expression} onChange={v => set('expression', v)} rows={rows} formulaColumns={formulaColumns} />}
            </div>
            <div className="dialog-footer">
              <Button type="button" variant="outline" onClick={() => void close()}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!!replacements}>{busy ? 'Saving…' : isNew ? 'Add column' : 'Save column'}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatusLabelsEditor({ labels, onChange, used }: { labels: Row[]; onChange: (v: Row[]) => void; used: Record<string, number> }) {
  const move = (i: number, by: number) => { const next = [...labels]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x); onChange(next); };
  return (
    <fieldset className="labels-editor">
      <legend className="field-label">Labels</legend>
      <ol className="labels-list">
        {labels.map((l, i) => (
          <li key={l.id || `new-${i}`}>
            <span className={`status-swatch ${colorClass(l.color)}`} aria-hidden="true" />
            <label className="sr-only" htmlFor={`label-name-${i}`}>Label {i + 1} name</label>
            <input id={`label-name-${i}`} className="label-name-input" value={l.name} maxLength={GROUP_LIMITS.label} onChange={e => onChange(labels.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} placeholder="Label name" />
            <Picker label={`Label ${i + 1} color`} hideLabel value={l.color} allowNone={false} options={Object.entries(STATUS_COLORS) as [string, string][]} onChange={v => onChange(labels.map((x, n) => (n === i ? { ...x, color: v } : x)))} className="label-color" />
            <span className="muted text-xs num">{l.id && used[l.id] ? `${used[l.id]} ${plural(used[l.id], 'row')}` : ''}</span>
            <IconButton label={`Move “${l.name}” up`} icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} />
            <IconButton label={`Move “${l.name}” down`} icon={ArrowDown} disabled={i === labels.length - 1} onClick={() => move(i, 1)} />
            <IconButton label={`Remove “${l.name}”`} icon={Trash2} disabled={labels.length === 1} onClick={() => onChange(labels.filter((_, n) => n !== i))} />
          </li>
        ))}
      </ol>
      <Button type="button" size="sm" variant="outline" disabled={labels.length >= GROUP_LIMITS.labels} onClick={() => onChange([...labels, { name: '', color: 'GRAY' }])}><Plus />Add label</Button>
      <p className="field-hint">Renaming a label keeps it on every row that uses it. Removing a label that rows use asks for a replacement first.</p>
    </fieldset>
  );
}

/** Formula editor: insert columns and functions, examples, live checking with the server's rules, and a preview. */
function FormulaEditor({ columns, selfId, name, ownName, value, onChange, rows, formulaColumns }: { columns: Row[]; selfId: string | null; name: string; ownName: string; value: string; onChange: (v: string) => void; rows: Row[]; formulaColumns: Row[] }) {
  const ref = useRef<HTMLTextAreaElement>(null), id = useId();
  const [sample, setSample] = useState(rows[0]?.id || ''), [custom, setCustom] = useState<Row>({});
  const insert = (text: string) => {
    const el = ref.current, start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? value.length;
    const base = value || '=', s = value ? start : base.length, e2 = value ? end : base.length;
    const next = base.slice(0, s) + text + base.slice(e2);
    onChange(next);
    window.requestAnimationFrame(() => { el?.focus(); const pos = s + text.length - (text.endsWith('()') ? 1 : 0); el?.setSelectionRange(pos, pos); });
  };
  // Clicking a chip keeps the cursor in the formula, so several chips and typed text can follow each other.
  const keepFocus = (e: MouseEvent) => { if (document.activeElement === ref.current) e.preventDefault(); };
  // The column being edited takes part with the name typed above, so the preview gives the same answer as the server
  // (for example “a formula can’t use its own column”), also for a column that doesn't exist yet.
  const selfKey = selfId || '__draft__', current = columns.find(c => c.id === selfKey);
  const draftCols = [...columns.filter(c => c.id !== selfKey), { ...(current || {}), id: selfKey, name: ownName.trim() || current?.name || '(new column)', type: 'FORMULA', settings: { ...(current?.settings || {}) } }];
  const row = rows.find(r => r.id === sample);
  const values = sample === '__custom' ? Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, v === '' ? null : Number(v)])) : row?.values;
  const result: Row | null = value.trim() ? previewFormula(value, draftCols, selfKey, values || {}) : null;
  const shownResult = result && result.ok ? (result.value === undefined ? '' : result.value === null ? 'empty' : formatResult(result.value, null)) : '';
  return (
    <section className="formula-editor" aria-labelledby={`${id}-title`}>
      <h3 className="text-section" id={`${id}-title`}><Calculator aria-hidden="true" className="inline-icon" />Formula</h3>
      <p className="muted small">Calculated for each row from values in the <strong>same row</strong>. Put column names in braces; the = at the start is optional. Other rows, other groups and cell addresses (like A1) can’t be used.</p>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-input`}>Formula for {name}<span className="field-required" aria-hidden="true">*</span></label>
        <Textarea ref={ref} id={`${id}-input`} className="formula-input" rows={3} value={value} onChange={e => onChange(e.target.value)} placeholder="={Quantity} * {Unit Price}" spellCheck={false} aria-describedby={`${id}-check`} maxLength={GROUP_LIMITS.formula} />
        <p id={`${id}-check`} className={result ? (result.ok ? 'formula-ok' : 'formula-error') : 'field-hint'} role="status">
          {!result ? 'Enter a formula, or start from an example below.' : result.ok ? <><Check aria-hidden="true" className="inline-icon" />Valid formula{shownResult ? <> · preview: <strong className="num">{shownResult}</strong>{result.value && typeof result.value === 'object' ? ` (${FORMULA_ERRORS[(result.value as Row).error as keyof typeof FORMULA_ERRORS]})` : ''}</> : ''}</> : <><CircleAlert aria-hidden="true" className="inline-icon" />{result.error}</>}
        </p>
      </div>
      <div className="formula-pickers">
        <div><p className="text-label">Insert a column</p>
          <div className="chip-row">{formulaColumns.length ? formulaColumns.map(c => <button type="button" key={c.id} className="formula-chip" onMouseDown={keepFocus} onClick={() => insert(`{${c.name}}`)}>{`{${c.name}}`}</button>) : <span className="muted small">Add a Number column first; formulas use Number and Formula columns.</span>}</div></div>
        <div><p className="text-label">Insert a function</p>
          <div className="chip-row">{Object.entries(FORMULA_FUNCTIONS).map(([fn, f]) => <button type="button" key={fn} className="formula-chip" title={`${f.usage} — ${f.about}`} onMouseDown={keepFocus} onClick={() => insert(`${fn}()`)}>{fn}</button>)}
            {['+', '-', '*', '/', '(', ')', '>', '<', '=', '<>', ','].map(op => <button type="button" key={op} className="formula-chip op" aria-label={`Insert ${op}`} onMouseDown={keepFocus} onClick={() => insert(` ${op} `.replace(' , ', ', ').replace(' ( ', '(').replace(' ) ', ')'))}>{op}</button>)}</div></div>
      </div>
      <div className="formula-preview">
        <Picker label="Preview with" value={sample} allowNone={false} options={[...rows.slice(0, 30).map((r, i) => [r.id, `Row ${i + 1}${r.values?.[columns[0]?.id] ? ` · ${String(r.values[columns[0].id]).slice(0, 30)}` : ''}`] as [string, string]), ['__custom', 'Sample values I type']]} onChange={setSample} hint={!rows.length ? 'No rows yet: type sample values instead.' : undefined} />
        {sample === '__custom' && <div className="grid-3">{columns.filter(c => c.type === 'NUMBER').map(c => <Field key={c.id} label={c.name} value={custom[c.id] ?? ''} inputMode="decimal" onChange={v => setCustom(s => ({ ...s, [c.id]: v }))} />)}</div>}
      </div>
      <details className="disclosure">
        <summary>Functions, examples and rules</summary>
        <div className="disclosure-body stack">
          <ul className="formula-help">{Object.entries(FORMULA_FUNCTIONS).map(([fn, f]) => <li key={fn}><code>{f.usage}</code> — {f.about} <button type="button" className="text-link" onClick={() => onChange(f.example)}>Use example <code>{f.example}</code></button></li>)}</ul>
          <p className="text-label">Operators</p>
          <p className="small">+ − * / and brackets, with the usual order (* and / before + and −). Comparisons = &lt;&gt; &gt; &gt;= &lt; &lt;= give TRUE or FALSE, for use in IF.</p>
          <p className="text-label">Rules</p>
          <ul className="formula-help">{FORMULA_RULES.map(r => <li key={r}>{r}</li>)}</ul>
          <p className="text-label">Error codes</p>
          <ul className="formula-help">{Object.entries(FORMULA_ERRORS).map(([k, v]) => <li key={k}><code>{k}</code> — {v}</li>)}</ul>
        </div>
      </details>
    </section>
  );
}

// Referenced so the bundler keeps the helpers the screens share with the Mini App.
export { LEVELS, compileFormula };
