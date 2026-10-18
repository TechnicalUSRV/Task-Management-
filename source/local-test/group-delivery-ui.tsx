import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Send, Loader2 } from 'lucide-react';
import type { Row } from './components';
import { uuid } from './api-client';
import './styles/group-enhancements.css';

type Props = { groupId: string; files: Row[]; command: (action: string, data: Row) => Promise<Row>; read: (id: string) => Promise<Row> };
/** The same ordered selection and delivery status is used by the web app and Mini App. */
export function GroupDelivery({ groupId, files, command, read }: Props) {
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState('SEPARATE');
  const [job, setJob] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<{ signature: string; key: string } | null>(null);
  const pending = !!job && ['QUEUED', 'SENDING'].includes(job.status);
  useEffect(() => {
    if (!pending) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await read(job!.id); if (live) { setJob(result); setError(''); } }
      catch (e) { if (live) setError((e as Error).message); }
      if (live) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [job?.id, pending, read]);
  const chosen = selected.filter(id => files.some(f => f.id === id));
  const pdfs = chosen.length >= 2 && chosen.every(id => files.find(f => f.id === id)?.mime === 'application/pdf');
  const move = (id: string, by: number) => setSelected(s => { const out = [...s], i = out.indexOf(id), j = i + by; if (j >= 0 && j < out.length) [out[i], out[j]] = [out[j], out[i]]; return out; });
  const send = async () => {
    setBusy(true); setError('');
    const signature = JSON.stringify([groupId, chosen, mode]);
    if (!request.current || request.current.signature !== signature || job && !pending) request.current = { signature, key: uuid() };
    try { const result = await command('tm.group.delivery.create', { group_id: groupId, file_ids: chosen, mode, request_key: request.current.key }); setJob(result.delivery); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <details className="gd-panel"><summary><Send size={16} />Send to Telegram</summary>
    <p className="gd-hint">Send to your own connected account. Select files in the required order.</p>
    <fieldset disabled={busy || pending}>
      <div className="gd-file-options">{files.map(f => <label key={f.id}><input type="checkbox" checked={chosen.includes(f.id)} onChange={e => setSelected(s => e.target.checked ? [...s, f.id] : s.filter(x => x !== f.id))} /><span title={f.name}>{f.name}</span></label>)}</div>
      {chosen.length > 1 && <ol className="gd-order">{chosen.map((id, i) => <li key={id}><span>{i + 1}. {files.find(f => f.id === id)?.name}</span><button type="button" disabled={i === 0} aria-label={`Move file ${i + 1} up`} onClick={() => move(id, -1)}><ArrowUp size={16} /></button><button type="button" disabled={i === chosen.length - 1} aria-label={`Move file ${i + 1} down`} onClick={() => move(id, 1)}><ArrowDown size={16} /></button></li>)}</ol>}
      <label className="gd-mode">Sending option<select value={mode} onChange={e => setMode(e.target.value)}><option value="SEPARATE">Send files separately</option><option value="MERGED_PDF" disabled={!pdfs}>Combine PDFs in this order</option></select></label>
      {mode === 'MERGED_PDF' && <p className="gd-hint">Combine PDF pages in this order. Interactive actions are removed; originals stay unchanged.</p>}
      <button type="button" className="gd-send" disabled={!chosen.length || mode === 'MERGED_PDF' && !pdfs} onClick={() => void send()}>{busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}Send selected files</button>
    </fieldset>
    {job && <p role="status" className="gd-hint">{pending && <Loader2 size={14} className="spin" />} {job.status === 'QUEUED' ? 'Queued. Waiting for the delivery worker.' : job.status === 'SENDING' ? 'Sending…' : job.status === 'SENT' ? 'Sent to your Telegram.' : job.status === 'PARTIAL' ? 'Some files were sent.' : job.status === 'UNKNOWN' ? 'Delivery not confirmed.' : 'Delivery failed.'} {job.results.length} / {job.total} sent. {job.error}</p>}
    {job && job.results?.length > 0 && <ul className="gd-hint">{job.results.map((r: Row, i: number) => <li key={i}>Sent: {r.name}</li>)}</ul>}
    {job && ['PARTIAL', 'UNKNOWN'].includes(job.status) && <p className="gd-hint">Check your chat and select only files you still need before sending again.</p>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </details>;
}
