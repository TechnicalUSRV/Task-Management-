import { uiText, useLanguage } from "./i18n";
import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { groupCommand } from './group-api';
import type { Row } from './components';
const PRESETS = ['#172B4D', '#FFFFFF', '#D92D20', '#FEE4E2', '#037749', '#D1FADF', '#175CD3', '#DBEAFE', '#FEF0C7', '#E9D7FE'];
export function CellFormatControl({ groupId, row, col, onSaved }: { groupId: string; row: Row; col: Row; onSaved: (row: Row) => void }) {
  useLanguage();
  const [open, setOpen] = useState(false), [style, setStyle] = useState<Row>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const show = () => { setStyle(row.styles?.[col.id] || {}); setError(''); setOpen(true); };
  const save = async () => { setBusy(true); setError(''); try { const result = await groupCommand('tm.group.cell.format', { group_id: groupId, row_id: row.id, column_id: col.id, expected_version: row.version, style }); onSaved(result.row); setOpen(false); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <><button type="button" className="cell-format-trigger" aria-label={uiText("Format {p0} cell colors", { p0: col.name })} title={uiText("Cell colors")} onClick={show}><Palette size={14} /></button>
    {open && <Dialog open onOpenChange={o => { if (!busy) setOpen(o); }}><DialogContent><DialogHeader><DialogTitle>{uiText("Cell colors · ")}{col.name}</DialogTitle><DialogDescription>{uiText("Changes the appearance of this cell only.")}</DialogDescription></DialogHeader>
      <div className="dialog-body stack">{(['text_color', 'background_color'] as const).map(key => <fieldset key={key} className="cell-color-field"><legend>{key === 'text_color' ? uiText("Text and number color") : uiText("Background color")}</legend><div className="color-presets">{PRESETS.map(color => <button type="button" key={color} style={{ backgroundColor: color }} aria-label={color} aria-pressed={style[key] === color} onClick={() => setStyle(s => ({ ...s, [key]: color }))} />)}<label>{uiText("Custom ")}<input type="color" value={style[key] || (key === 'text_color' ? '#172B4D' : '#FFFFFF')} onChange={e => setStyle(s => ({ ...s, [key]: e.target.value }))} /></label></div><Button size="xs" variant="ghost" onClick={() => setStyle(s => ({ ...s, [key]: '' }))}>{uiText("Default")}</Button></fieldset>)}{error && <p role="alert" className="field-error">{error}</p>}</div>
      <div className="dialog-footer"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{uiText("Cancel")}</Button><Button disabled={busy} onClick={() => void save()}>{uiText("Save colors")}</Button></div></DialogContent></Dialog>}
  </>;
}
