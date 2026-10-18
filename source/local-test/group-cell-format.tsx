import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { groupCommand } from './group-api';
import type { Row } from './components';
const PRESETS = ['#172B4D', '#FFFFFF', '#D92D20', '#FEE4E2', '#037749', '#D1FADF', '#175CD3', '#DBEAFE', '#FEF0C7', '#E9D7FE'];
export function CellFormatControl({ groupId, row, col, onSaved }: { groupId: string; row: Row; col: Row; onSaved: (row: Row) => void }) {
  const [open, setOpen] = useState(false), [style, setStyle] = useState<Row>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const show = () => { setStyle(row.styles?.[col.id] || {}); setError(''); setOpen(true); };
  const save = async () => { setBusy(true); setError(''); try { const result = await groupCommand('tm.group.cell.format', { group_id: groupId, row_id: row.id, column_id: col.id, expected_version: row.version, style }); onSaved(result.row); setOpen(false); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <><button type="button" className="cell-format-trigger" aria-label={`Format ${col.name} cell colors`} title="Cell colors" onClick={show}><Palette size={14} /></button>
    {open && <Dialog open onOpenChange={o => { if (!busy) setOpen(o); }}><DialogContent><DialogHeader><DialogTitle>Cell colors · {col.name}</DialogTitle><DialogDescription>Changes the appearance of this cell only.</DialogDescription></DialogHeader>
      <div className="dialog-body stack">{(['text_color', 'background_color'] as const).map(key => <fieldset key={key} className="cell-color-field"><legend>{key === 'text_color' ? 'Text and number color' : 'Background color'}</legend><div className="color-presets">{PRESETS.map(color => <button type="button" key={color} style={{ backgroundColor: color }} aria-label={color} aria-pressed={style[key] === color} onClick={() => setStyle(s => ({ ...s, [key]: color }))} />)}<label>Custom <input type="color" value={style[key] || (key === 'text_color' ? '#172B4D' : '#FFFFFF')} onChange={e => setStyle(s => ({ ...s, [key]: e.target.value }))} /></label></div><Button size="xs" variant="ghost" onClick={() => setStyle(s => ({ ...s, [key]: '' }))}>Default</Button></fieldset>)}{error && <p role="alert" className="field-error">{error}</p>}</div>
      <div className="dialog-footer"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Save colors</Button></div></DialogContent></Dialog>}
  </>;
}
