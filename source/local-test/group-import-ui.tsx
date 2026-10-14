// V5.5 Groups · Import data from Excel, in eight steps: upload, worksheets, header rows, rows and columns, mapping,
// check (the server works out exactly what would happen, nothing is saved), import, and the result. The server checks
// everything again when importing; importing the same upload twice never adds its rows twice.
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Row } from './components';
import { COLUMN_TYPES, GROUP_LIMITS, nameKey } from './group-domain.mjs';
import { groupCommand, groupPost, type GroupError } from './group-api';
import { fileToBase64 } from './media';
import { plural } from './format';
import { Alert, CheckboxField, Field, Picker, useConfirm } from './ui-kit';

const STEPS = ['Upload', 'Worksheets', 'Header rows', 'Rows and columns', 'Mapping', 'Check', 'Import', 'Result'];
const IMPORTABLE = ['TEXT', 'NUMBER', 'DATE', 'STATUS', 'IN_CHARGE', 'SUPPORT'];
const colLetter = (i: number) => { let s = '', n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
type Mapping = { target?: string; new?: { name: string; type: string }; skip?: boolean };
type SheetPlan = { header_row: number; rows: string; cols: number[]; map: Record<number, Mapping>; key: number | null };

/** Header names as the server makes them: trimmed, braces removed, empty ones named after their column letter, repeats numbered. */
function headersOf(sheet: Row, headerRow: number): string[] {
  const cells: string[] = sheet.preview[headerRow - 1] || [], width = Math.max(sheet.preview[0]?.length || 0, cells.length), seen = new Map<string, number>(), out: string[] = [];
  for (let i = 0; i < width; i++) {
    let name = String(cells[i] || '').replace(/\s+/g, ' ').replace(/[{}]/g, '').replace(/^[#=]+/, '').trim().slice(0, GROUP_LIMITS.name) || `Column ${colLetter(i)}`;
    const k = nameKey(name), n = (seen.get(k) || 0) + 1; seen.set(k, n); if (n > 1) name = `${name.slice(0, GROUP_LIMITS.name - 5)} (${n})`;
    out.push(name);
  }
  return out;
}
const isNumber = (v: string) => /^-?[\d,]*\.?\d+$/.test(v.replace(/\s/g, ''));
const isDate = (v: string) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(v) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(v);
/** A first guess at the type of a new column, from the preview values under the header. */
function guessType(sheet: Row, headerRow: number, col: number): string {
  const values: string[] = sheet.preview.slice(headerRow).map((r: string[]) => String(r[col] || '').trim()).filter(Boolean);
  if (!values.length) return 'TEXT';
  if (values.every(isDate)) return 'DATE';
  if (values.every(v => isNumber(v) && !/^0\d/.test(v))) return 'NUMBER';
  return 'TEXT';
}
/** “2-50, 75, 80-90” → sheet row numbers (null for “all”). */
function parseRows(text: string): number[] | null | 'error' {
  const t = text.trim(); if (!t) return null;
  const out: number[] = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:[-–](\d+))?$/.exec(part); if (!m) return 'error';
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a; if (b < a || b - a > 50000) return 'error';
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

export function ImportWizard({ groupId, groupName, columns, canCreateColumns, onClose, onDone }: { groupId: string; groupName: string; columns: Row[]; canCreateColumns: boolean; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [imp, setImp] = useState<Row | null>(null), [chosen, setChosen] = useState<number[]>([]), [plans, setPlans] = useState<Record<number, SheetPlan>>({});
  const [mode, setMode] = useState<'append' | 'update'>('append'), [unmatched, setUnmatched] = useState<'add' | 'skip'>('add'), [createLabels, setCreateLabels] = useState(false);
  const [people, setPeople] = useState<Record<string, string>>({}), [preview, setPreview] = useState<Row | null>(null), [result, setResult] = useState<Row | null>(null);
  const fileRef = useRef<HTMLInputElement>(null), confirm = useConfirm();
  const targets = useMemo(() => columns.filter(c => IMPORTABLE.includes(c.type)), [columns]);
  const sheets: Row[] = imp?.sheets || [];
  const plan = (i: number): SheetPlan => plans[i];
  const setPlan = (i: number, patch: Partial<SheetPlan>) => { setPlans(s => ({ ...s, [i]: { ...s[i], ...patch } })); setPreview(null); };

  // ---------------------------------------------------------------- 1. upload
  const upload = async (file: File) => {
    setError('');
    if (!/\.xlsx$/i.test(file.name)) { setError(/\.(xls|csv|xlsm|xlsb|ods)$/i.test(file.name) ? `“${file.name}” is not an Excel workbook (.xlsx). Save it as “Excel Workbook (*.xlsx)” and choose it again.` : 'Choose an Excel workbook (.xlsx).'); return; }
    if (file.size > GROUP_LIMITS.importBytes) { setError(`Choose a file of up to ${GROUP_LIMITS.importBytes / 1048576} MB.`); return; }
    setBusy(`Reading ${file.name}…`);
    try {
      const r = await groupCommand('tm.group.import.upload', { group_id: groupId, name: file.name, base64: await fileToBase64(file) });
      const s: Row[] = r.import.sheets;
      setImp(r.import); setResult(null); setPreview(null); setPeople({});
      setChosen(s.filter(x => !x.hidden && x.filled_rows > 0).map(x => x.index));
      // Defaults: the first filled row is the header; every column with a header; all rows.
      setPlans(Object.fromEntries(s.map(x => {
        const headerRow = Math.max(1, x.preview.findIndex((r: string[]) => r.some(v => String(v).trim())) + 1);
        const heads = headersOf(x, headerRow), cols = heads.map((_, i) => i).filter(i => x.preview.some((r: string[]) => String(r[i] || '').trim()));
        return [x.index, { header_row: headerRow, rows: '', cols, map: {}, key: null } as SheetPlan];
      })));
      setStep(1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  // ---------------------------------------------------------------- 5. mapping defaults (by header name)
  const defaultsFor = (i: number) => {
    const p = plan(i), heads = headersOf(sheets[i], p.header_row), map: Record<number, Mapping> = {};
    for (const src of p.cols) {
      if (p.map[src]) { map[src] = p.map[src]; continue; }
      const same = targets.find(c => nameKey(c.name) === nameKey(heads[src]));
      map[src] = same ? { target: same.id } : canCreateColumns ? { new: { name: heads[src], type: guessType(sheets[i], p.header_row, src) } } : { skip: true };
    }
    return map;
  };
  const toMapping = () => { setPlans(s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, chosen.includes(Number(k)) ? { ...v, map: defaultsFor(Number(k)) } : v]))); setStep(4); };

  // ---------------------------------------------------------------- 6. the plan the server checks
  const body = () => ({
    mode, unmatched, create_labels: createLabels, people,
    sheets: chosen.map(i => {
      const p = plan(i), rows = parseRows(p.rows);
      return { index: i, header_row: p.header_row, ...(Array.isArray(rows) ? { rows } : {}),
        columns: p.cols.map(src => { const m = p.map[src] || { skip: true }; return m.skip ? { source: src, skip: true } : m.new ? { source: src, new: m.new } : { source: src, target: m.target }; }),
        ...(mode === 'update' && p.key !== null ? { key: { source: p.key } } : {}) };
    }),
  });
  const check = async () => {
    setError('');
    for (const i of chosen) if (parseRows(plan(i).rows) === 'error') { setError(`“${sheets[i].name}”: write rows like 2-50, 75, 80-90 (or leave empty for all rows).`); setStep(3); return; }
    setBusy('Checking every row…');
    try { const r = await groupPost('/api/tasks/group/import/preview', { import_id: imp!.id, plan: body() }); setPreview(r); setStep(5); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const commit = async () => {
    if (!preview) return;
    const t = preview.totals;
    if (mode === 'update' && t.update > 0 && !(await confirm({ title: `Change ${t.update} existing ${plural(t.update, 'row')}?`, description: 'Their values are replaced by the values in the file for the columns you mapped. Rows not in the file are not changed.', confirmLabel: `Update ${t.update} ${plural(t.update, 'row')}`, tone: 'danger' }))) return;
    setStep(6); setBusy(`Importing ${t.add + t.update} ${plural(t.add + t.update, 'row')}…`); setError('');
    try {
      const r = await groupCommand('tm.group.import.commit', { import_id: imp!.id, plan: body(), expected: { add: t.add, update: t.update }, confirm_update: mode === 'update' && t.update > 0 });
      setResult(r.result ? { ...r.result, message: r.message, already: r.already } : { message: r.message }); setStep(7); onDone();
    } catch (e) {
      const err = e as GroupError;
      setError(err.message);
      if (err.details?.code === 'people' || err.details?.code === 'preview_changed') { setPreview(null); setStep(4); } else setStep(5);
    } finally { setBusy(''); }
  };

  const canNext = step === 1 ? chosen.length > 0 : step === 2 || step === 3 ? true : step === 4 ? chosen.every(i => plan(i).cols.some(src => { const m = plan(i).map[src]; return !!m && !m.skip; })) && (mode === 'append' || chosen.every(i => plan(i).key !== null)) : false;
  const next = () => { setError(''); if (step === 3) toMapping(); else if (step === 4) void check(); else setStep(step + 1); };
  const sheetTabs = (render: (s: Row, p: SheetPlan) => ReactNode) => chosen.map(i => <section key={i} className="import-sheet" aria-label={`Worksheet ${sheets[i].name}`}><h3 className="text-section">{sheets[i].name}</h3>{render(sheets[i], plan(i))}</section>);

  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="dialog-xl import-dialog" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader><DialogTitle><FileSpreadsheet aria-hidden="true" className="inline-icon" />Import data into “{groupName}”</DialogTitle>
          <DialogDescription>{imp ? `${imp.file_name} · ${sheets.length} ${plural(sheets.length, 'worksheet')}` : 'From an Excel workbook (.xlsx). Nothing is saved until you confirm.'}</DialogDescription></DialogHeader>
        <ol className="wizard-steps" aria-label="Import steps">
          {STEPS.map((s, i) => <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}><span className="wizard-dot num" aria-hidden="true">{i < step ? <Check /> : i + 1}</span><span className="wizard-label">{s}</span></li>)}
        </ol>
        <div className="dialog-body stack import-body">
          {error && <Alert tone="danger" title="Check this" live>{error}</Alert>}
          {busy && <p className="import-busy" role="status"><Loader2 className="spin" aria-hidden="true" />{busy}</p>}

          {step === 0 && <div className="import-drop">
            <Upload aria-hidden="true" />
            <p><strong>Choose an Excel workbook</strong> (.xlsx, up to {GROUP_LIMITS.importBytes / 1048576} MB). Every worksheet is read; you choose which to import next.</p>
            <input ref={fileRef} type="file" aria-label="Excel workbook to import" tabIndex={-1} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
            <Button onClick={() => fileRef.current?.click()} disabled={!!busy}><Upload />Choose file</Button>
            <p className="muted small">Excel formulas are not calculated: their saved results are imported. Group formula columns keep calculating themselves.</p>
          </div>}

          {step === 1 && <>
            <div className="row-between"><p className="small">Choose the worksheets to import. Each one is mapped on its own.</p>
              <Button size="xs" variant="ghost" onClick={() => setChosen(chosen.length === sheets.length ? [] : sheets.map(s => s.index))}>{chosen.length === sheets.length ? 'Clear all' : 'Select all'}</Button></div>
            <ul className="import-sheets">{sheets.map(s => <li key={s.index}>
              <CheckboxField label={<><strong>{s.name}</strong>{s.hidden ? ' (hidden in Excel)' : ''}</>} checked={chosen.includes(s.index)} onChange={v => setChosen(c => v ? [...c, s.index].sort((a, b) => a - b) : c.filter(x => x !== s.index))}
                description={`${s.filled_rows.toLocaleString('en-US')} filled ${plural(s.filled_rows, 'row')} · ${s.columns} ${plural(s.columns, 'column')}${s.truncated ? ' · only the first 20,000 rows were read' : ''}${s.formulas_without_results ? ` · ${s.formulas_without_results} ${plural(s.formulas_without_results, 'formula')} without a saved result` : ''}`} />
              <PreviewTable sheet={s} headerRow={0} rows={5} />
            </li>)}</ul>
          </>}

          {step === 2 && sheetTabs((s, p) => <>
            <Picker label="Header row" value={String(p.header_row)} allowNone={false} options={s.preview.map((r: string[], i: number) => [String(i + 1), `Row ${i + 1}: ${r.filter(Boolean).slice(0, 4).join(' · ').slice(0, 70) || '(empty)'}`])}
              onChange={v => setPlan(s.index, { header_row: Number(v), cols: headersOf(s, Number(v)).map((_, i) => i).filter(i => s.preview.some((r: string[]) => String(r[i] || '').trim())), map: {}, key: null })} hint="The row with the column names. Data starts on the next row." />
            <PreviewTable sheet={s} headerRow={p.header_row} rows={8} />
          </>)}

          {step === 3 && sheetTabs((s, p) => { const heads = headersOf(s, p.header_row); return <>
            <Field label="Rows to import" value={p.rows} onChange={v => setPlan(s.index, { rows: v })} placeholder={`All rows (${p.header_row + 1} to the end)`} hint={`Leave empty for every row after the header, or write sheet row numbers such as ${p.header_row + 1}-50, 75, 80-90. Empty rows are skipped.`}
              error={parseRows(p.rows) === 'error' ? 'Write rows like 2-50, 75, 80-90.' : undefined} />
            <fieldset className="import-cols"><legend className="field-label">Columns to import <Button type="button" size="xs" variant="link" onClick={() => setPlan(s.index, { cols: p.cols.length === heads.length ? [] : heads.map((_, i) => i) })}>{p.cols.length === heads.length ? 'Clear all' : 'Select all'}</Button></legend>
              {heads.map((h, i) => <CheckboxField key={i} label={<><span className="muted num">{colLetter(i)}</span> {h}</>} checked={p.cols.includes(i)} onChange={v => setPlan(s.index, { cols: v ? [...p.cols, i].sort((a, b) => a - b) : p.cols.filter(x => x !== i) })} />)}
            </fieldset>
          </>; })}

          {step === 4 && <>
            <fieldset className="choice-cards is-two import-mode"><legend className="field-label">What to do with the rows</legend>
              <label className={`choice-card${mode === 'append' ? ' is-checked' : ''}`}><input type="radio" name="imp-mode" checked={mode === 'append'} onChange={() => { setMode('append'); setPreview(null); }} /><span className="cell-stack"><span className="cell-title">Add them as new rows</span><small>The usual choice. Existing rows are not touched.</small></span></label>
              <label className={`choice-card${mode === 'update' ? ' is-checked' : ''}`}><input type="radio" name="imp-mode" checked={mode === 'update'} onChange={() => { setMode('update'); setPreview(null); }} /><span className="cell-stack"><span className="cell-title">Update matching rows</span><small>Choose a key column (for example an order number) that identifies each row.</small></span></label>
            </fieldset>
            {mode === 'update' && <Picker label="Rows in the file that match no row" value={unmatched} allowNone={false} options={[['add', 'Add them as new rows'], ['skip', 'Skip them']]} onChange={v => { setUnmatched(v as 'add' | 'skip'); setPreview(null); }} />}
            {sheetTabs((s, p) => { const heads = headersOf(s, p.header_row); return <>
              <table className="map-table"><thead><tr><th scope="col">Excel column</th><th scope="col">Goes into</th>{mode === 'update' && <th scope="col">Key</th>}</tr></thead>
                <tbody>{p.cols.map(src => { const m = p.map[src] || { skip: true }, value = m.skip ? '__skip' : m.new ? '__new' : m.target!; const keyable = !!m.target && ['TEXT', 'NUMBER', 'DATE'].includes(targets.find(c => c.id === m.target)?.type || '');
                  return <tr key={src}>
                    <th scope="row"><span className="muted num">{colLetter(src)}</span> {heads[src]}</th>
                    <td><div className="map-target">
                      <Picker label={`Where “${heads[src]}” goes`} hideLabel value={value} allowNone={false} options={[...targets.map(c => [c.id, `${c.name} · ${COLUMN_TYPES[c.type as keyof typeof COLUMN_TYPES]}`] as [string, string]), ...(canCreateColumns ? [['__new', 'A new column…'] as [string, string]] : []), ['__skip', 'Don’t import']]}
                        onChange={v => setPlan(s.index, { map: { ...p.map, [src]: v === '__skip' ? { skip: true } : v === '__new' ? { new: { name: heads[src], type: guessType(s, p.header_row, src) } } : { target: v } }, key: p.key === src && (v === '__skip' || v === '__new') ? null : p.key })} />
                      {m.new && <><Field label="New column name" hideLabel value={m.new.name} onChange={v => setPlan(s.index, { map: { ...p.map, [src]: { new: { ...m.new!, name: v } } } })} />
                        <Picker label="New column type" hideLabel value={m.new.type} allowNone={false} options={IMPORTABLE.map(t => [t, COLUMN_TYPES[t as keyof typeof COLUMN_TYPES]])} onChange={v => setPlan(s.index, { map: { ...p.map, [src]: { new: { ...m.new!, type: v } } } })} /></>}
                    </div></td>
                    {mode === 'update' && <td>{keyable ? <input type="radio" name={`key-${s.index}`} aria-label={`Use “${heads[src]}” as the key`} checked={p.key === src} onChange={() => setPlan(s.index, { key: src })} /> : null}</td>}
                  </tr>; })}</tbody></table>
              {mode === 'update' && p.key === null && <p className="field-error">Choose the key column for this worksheet (an existing Text, Number or Date column).</p>}
            </>; })}
            {targets.some(c => c.type === 'STATUS') && <CheckboxField label="Add status labels the file uses that a column doesn’t have yet" checked={createLabels} onChange={v => { setCreateLabels(v); setPreview(null); }} description="Off: those rows are reported instead." />}
            <p className="muted small">People are matched by staff ID, Task Controlling Management email or a name only one person has. Formula columns can’t be imported into.</p>
          </>}

          {step === 5 && preview && <ImportPreview preview={preview} people={people} onPerson={(text, id) => { setPeople(s => ({ ...s, [text]: id })); }} />}
          {step === 6 && !busy && error && <p className="muted small">Nothing was imported.</p>}
          {step === 7 && result && <ImportResult result={result} />}
        </div>
        <div className="dialog-footer">
          {step > 0 && step < 6 && <div className="footer-start"><Button type="button" variant="ghost" disabled={!!busy} onClick={() => { setError(''); setStep(step === 5 ? 4 : step - 1); }}><ChevronLeft />Back</Button></div>}
          <Button type="button" variant="outline" disabled={!!busy && step !== 0} onClick={onClose}>{step === 7 ? 'Close' : 'Cancel'}</Button>
          {step >= 1 && step <= 4 && <Button type="button" disabled={!canNext || !!busy} onClick={next}>{step === 4 ? 'Check the import' : 'Next'}<ChevronRight /></Button>}
          {step === 5 && preview && (preview.unresolved?.length ? <Button type="button" disabled={!!busy || preview.unresolved.some((u: Row) => !people[u.text])} onClick={() => void check()}>Check again</Button>
            : <Button type="button" disabled={!!busy || preview.already || !(preview.totals.add + preview.totals.update)} onClick={() => void commit()}>Import {(preview.totals.add + preview.totals.update).toLocaleString('en-US')} {plural(preview.totals.add + preview.totals.update, 'row')}</Button>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ sheet, headerRow, rows }: { sheet: Row; headerRow: number; rows: number }) {
  const width = Math.min(12, sheet.preview[0]?.length || 0), start = headerRow ? Math.max(0, headerRow - 2) : 0, list: string[][] = sheet.preview.slice(start, start + rows);
  if (!width) return <p className="muted small">This worksheet is empty.</p>;
  return (
    <div className="import-preview" role="region" aria-label={`First rows of ${sheet.name}`} tabIndex={0}>
      <table><thead><tr><th scope="col"><span className="sr-only">Row</span></th>{Array.from({ length: width }, (_, i) => <th key={i} scope="col">{colLetter(i)}</th>)}</tr></thead>
        <tbody>{list.map((r, n) => <tr key={n} className={start + n + 1 === headerRow ? 'is-header' : undefined}><th scope="row" className="num">{start + n + 1}</th>{Array.from({ length: width }, (_, i) => <td key={i}>{r[i]}</td>)}</tr>)}</tbody></table>
    </div>
  );
}

function ImportPreview({ preview, people, onPerson }: { preview: Row; people: Record<string, string>; onPerson: (text: string, id: string) => void }) {
  if (preview.already) return <Alert tone="info" title="This file was already imported">{preview.result?.added} rows were added then. Upload the file again to import it once more.</Alert>;
  const t = preview.totals;
  return (
    <div className="stack">
      <div className="import-totals">
        <Stat label="To add" value={t.add} tone="success" /><Stat label="To update" value={t.update} /><Stat label="Skipped" value={t.skipped} detail="empty or not matched" /><Stat label="Can’t import" value={t.failed} tone={t.failed ? 'danger' : undefined} />
      </div>
      {preview.new_columns?.length > 0 && <Alert tone="info" title={`${preview.new_columns.length} new ${plural(preview.new_columns.length, 'column')}`}>{preview.new_columns.map((c: Row) => `${c.name} (${COLUMN_TYPES[c.type as keyof typeof COLUMN_TYPES]})`).join(', ')}</Alert>}
      {preview.new_labels?.length > 0 && <Alert tone="info" title="New status labels">{preview.new_labels.map((x: Row) => `${x.column}: ${x.labels.join(', ')}`).join(' · ')}</Alert>}
      {preview.unresolved?.length > 0 && <Alert tone="warning" title="Choose who is meant">
        <ul className="import-people">{preview.unresolved.map((u: Row) => <li key={u.text}><span>“{u.text}”</span><Picker label={`Who is “${u.text}”`} hideLabel value={people[u.text] || ''} none="Choose…" options={u.candidates.map((c: Row) => [c.id, `${c.name}${c.department ? ` · ${c.department}` : ''}`])} onChange={v => onPerson(u.text, v)} /></li>)}</ul>
      </Alert>}
      {preview.sheets.map((s: Row) => <section key={s.index} className="import-sheet" aria-label={`Worksheet ${s.name}`}>
        <h3 className="text-section">{s.name} <span className="muted small">· {s.selected} {plural(s.selected, 'row')} chosen · {s.add} to add{s.update ? ` · ${s.update} to update` : ''}{s.skipped_blank ? ` · ${s.skipped_blank} empty` : ''}{s.skipped_unmatched ? ` · ${s.skipped_unmatched} not matched` : ''}{s.failed ? ` · ${s.failed} can’t import` : ''}</span></h3>
        {s.errors.length > 0 && <ProblemList title="Rows that can’t be imported" items={s.errors} tone="danger" />}
        {s.warnings.length > 0 && <ProblemList title="Warnings" items={s.warnings} tone="warning" />}
        {s.sample.length > 0 && <details className="disclosure"><summary>Examples of what will be saved</summary><div className="disclosure-body"><ul className="import-sample">{s.sample.map((x: Row, i: number) => <li key={i}><span className="muted num">Row {x.row} · {x.action === 'add' ? 'add' : 'update'}</span> {Object.entries(x.values).map(([k, v]) => `${k}: ${v}`).join(' · ')}</li>)}</ul></div></details>}
      </section>)}
    </div>
  );
}
function Stat({ label, value, detail, tone }: { label: string; value: number; detail?: string; tone?: 'success' | 'danger' }) {
  return <div className={`import-stat${tone ? ` is-${tone}` : ''}`}><span className="import-stat-value num">{value.toLocaleString('en-US')}</span><span className="import-stat-label">{label}</span>{detail && <small className="muted">{detail}</small>}</div>;
}
function ProblemList({ title, items, tone }: { title: string; items: Row[]; tone: 'danger' | 'warning' }) {
  return (
    <div className={`problem-list is-${tone}`}>
      <p className="text-label"><AlertTriangle aria-hidden="true" className="inline-icon" />{title} · {items.length}{items.length >= 300 ? '+' : ''} {plural(items.length, 'problem')}</p>
      <ul>{items.slice(0, 100).map((e, i) => <li key={i}>{e.row ? <span className="num">Row {e.row}</span> : null}{e.column ? <span> · {e.column}</span> : null}{e.value ? <span className="muted"> · “{e.value}”</span> : null}: {e.message}</li>)}</ul>
      {items.length > 100 && <p className="muted small">And {items.length - 100} more. Correct the file and upload it again to see the rest.</p>}
    </div>
  );
}
function ImportResult({ result }: { result: Row }) {
  return (
    <div className="stack">
      <Alert tone={result.failed ? 'warning' : 'success'} icon={CheckCircle2} title={result.already ? 'Already imported' : 'Import finished'}>{result.message}</Alert>
      {result.added !== undefined && <div className="import-totals"><Stat label="Added" value={result.added} tone="success" /><Stat label="Updated" value={result.updated} /><Stat label="Skipped" value={result.skipped} /><Stat label="Not imported" value={result.failed} tone={result.failed ? 'danger' : undefined} /></div>}
      {result.created_columns?.length > 0 && <p className="small">New columns: {result.created_columns.map((c: Row) => c.name).join(', ')}.</p>}
      {(result.sheets || []).filter((s: Row) => s.errors?.length).map((s: Row) => <ProblemList key={s.name} title={`${s.name}: rows not imported`} items={s.errors} tone="danger" />)}
    </div>
  );
}
