import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, CheckCircle2, File as FileIcon, FileImage, FileText, Loader2, Send, X } from 'lucide-react';
import type { Row } from './components';
import { uuid } from './api-client';
import './styles/group-enhancements.css';

type Props = { groupId?: string; taskId?: string; files: Row[]; command: (action: string, data: Row) => Promise<Row>; read: (id: string) => Promise<Row> };
export const MERGED_DEFAULT = 'Combined-documents';
const isPdf = (f?: Row) => f?.mime === 'application/pdf';
export const fileKind = (f: Row) => isPdf(f) ? 'PDF' : String(f.mime || '').startsWith('image/') ? 'Image' : (String(f.name || '').split('.').pop() || 'File').toUpperCase();
export const fileSize = (n: unknown) => { const b = Number(n) || 0; return b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`; };

/** The same ordered selection, sending method, merged file name and delivery status for the web app and the Mini App. */
export function useDelivery({ groupId, taskId, files, command, read }: Props) {
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState('SEPARATE'), [name, setName] = useState(MERGED_DEFAULT);
  const [job, setJob] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<{ signature: string; key: string } | null>(null);
  const pending = !!job && ['QUEUED', 'PREPARING', 'APPROVED', 'SENDING'].includes(job.status);
  const waitingRetry = !!job && ['FAILED', 'PARTIAL'].includes(job.status) && !!job.retry_at && !job.can_retry;
  useEffect(() => {
    if (!pending && !waitingRetry) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await read(job!.id); if (live) { setJob(result); setError(''); } }
      catch (e) { if (live) setError((e as Error).message); }
      if (live) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [job?.id, pending, waitingRetry, read]);
  const chosen = selected.filter(id => files.some(f => f.id === id));
  const pdfs = chosen.length >= 2 && chosen.every(id => isPdf(files.find(f => f.id === id)));
  // Why combining is not possible right now (shown next to the option instead of a silent, disabled control).
  const notPdf = chosen.map(id => files.find(f => f.id === id)).find(f => f && !isPdf(f));
  const mergeBlock = chosen.length < 2 ? 'Select two or more PDF files to combine them.' : notPdf ? `Only PDF files can be combined: “${notPdf.name}” is not a PDF.` : '';
  const merging = mode === 'MERGED_PDF';
  const nameError = merging && !name.trim() ? 'Enter a name for the combined PDF.' : '';
  const toggle = (id: string, on: boolean) => setSelected(s => on ? (s.includes(id) ? s : [...s, id]) : s.filter(x => x !== id));
  const move = (id: string, by: number) => setSelected(s => { const out = [...s], i = out.indexOf(id), j = i + by; if (i >= 0 && j >= 0 && j < out.length) [out[i], out[j]] = [out[j], out[i]]; return out; });
  const fileName = merging ? `${name.trim().replace(/\.pdf$/i, '')}.pdf` : '';
  const ready = chosen.length > 0 && (!merging || (pdfs && !nameError)) && !busy && !pending && job?.status !== 'READY';
  const send = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    const signature = JSON.stringify([groupId, taskId, chosen, mode, fileName]);
    if (!request.current || request.current.signature !== signature || job && !pending) request.current = { signature, key: uuid() };
    try { const result = await command(taskId ? 'tm.task.delivery.create' : 'tm.group.delivery.create', { ...(taskId ? { task_id: taskId } : { group_id: groupId }), preview: true, file_ids: chosen, mode, request_key: request.current.key, ...(merging ? { file_name: fileName } : {}) }); setJob(result.delivery); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (merging && !pdfs && chosen.length) setMode('SEPARATE'); }, [merging, pdfs, chosen.length]);
  const confirmDelivery = async (cancel=false, retry=false) => { if (!job) return; setBusy(true); setError(''); try { const r = await command(`tm.${taskId ? 'task' : 'group'}.delivery.${retry ? 'retry' : cancel ? 'cancel' : 'confirm'}`, { delivery_id: job.id }); setJob(r.delivery); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } };
  const reset = () => { setJob(null); setError(''); setSelected([]); request.current = null; };
  return { selected: chosen, setSelected, toggle, move, mode, setMode, name, setName, nameError, fileName, job, error, busy, pending, pdfs, mergeBlock, merging, ready, send, reset, confirmDelivery };
}

function statusText(job: Row) {
  return job.status === 'READY' ? 'Prepared. Review the sizes and confirm delivery.' : job.status === 'PREPARING' ? 'Preparing documents…' : job.status === 'APPROVED' ? 'Confirmed. Waiting to send.' : job.status === 'CANCELLED' ? 'Cancelled.' : job.status === 'QUEUED' ? 'Queued. Waiting for the delivery worker.' : job.status === 'SENDING' ? 'Sending…' : job.status === 'SENT' ? 'Sent to your Telegram.'
    : job.status === 'PARTIAL' ? 'Some files were sent.' : job.status === 'UNKNOWN' ? 'Delivery not confirmed.' : 'Delivery failed.';
}

function DeliveryStatus({ job }: { job: Row }) {
  const pending = ['QUEUED', 'PREPARING', 'APPROVED', 'SENDING'].includes(job.status);
  return <>
    <p role="status" className={`gd-hint gd-status is-${String(job.status).toLowerCase()}`}>{pending ? <Loader2 size={14} className="spin" /> : job.status === 'SENT' ? <CheckCircle2 size={16} /> : null} {statusText(job)} {job.results.length} / {job.total} sent. {job.error}</p>
    {job.plan?.length > 0 && <ol className="gd-hint">{job.plan.map((p: Row, i: number) => <li key={i}>{p.name} · {fileSize(p.size)} ({Number(p.size).toLocaleString()} bytes){p.pages ? ` · pages ${p.pages[0]}–${p.pages[1]}` : ''}</li>)}</ol>}
    {job.results?.length > 0 && <ul className="gd-hint">{job.results.map((r: Row, i: number) => <li key={i}>Sent: {r.name}</li>)}</ul>}
    {['PARTIAL', 'UNKNOWN'].includes(job.status) && <p className="gd-hint">Check your Telegram chat. Retry remaining documents only for a confirmed failure. Do not repeat an uncertain delivery.</p>}
  </>;
}

/** The web app's compact panel under an Attachment cell (unchanged layout; the combined PDF can now be named). */
export function GroupDelivery(props: Props) {
  const { files } = props, d = useDelivery(props), nameId = useId();
  return <details className="gd-panel"><summary><Send size={16} />Send to Telegram</summary>
    <p className="gd-hint">Send to your own connected account. Select files in the required order.</p>
    <fieldset disabled={d.busy || d.pending || d.job?.status==='READY'}>
      <div className="gd-file-options">{files.map(f => <label key={f.id}><input type="checkbox" checked={d.selected.includes(f.id)} onChange={e => d.toggle(f.id, e.target.checked)} /><span title={f.name}>{f.name}</span></label>)}</div>
      {d.selected.length > 1 && <ol className="gd-order">{d.selected.map((id, i) => <li key={id}><span>{i + 1}. {files.find(f => f.id === id)?.name}</span><button type="button" disabled={i === 0} aria-label={`Move file ${i + 1} up`} onClick={() => d.move(id, -1)}><ArrowUp size={16} /></button><button type="button" disabled={i === d.selected.length - 1} aria-label={`Move file ${i + 1} down`} onClick={() => d.move(id, 1)}><ArrowDown size={16} /></button></li>)}</ol>}
      <label className="gd-mode">Sending option<select value={d.mode} onChange={e => d.setMode(e.target.value)}><option value="SEPARATE">Send files separately</option><option value="MERGED_PDF" disabled={!d.pdfs}>Combine PDFs in this order</option></select></label>
      {d.merging && <><label className="gd-mode" htmlFor={nameId}>Name of the combined PDF<span className="gd-name"><input id={nameId} value={d.name} maxLength={116} onChange={e => d.setName(e.target.value)} aria-invalid={!!d.nameError || undefined} /><span aria-hidden="true">.pdf</span></span></label>
        {d.nameError && <p className="field-error">{d.nameError}</p>}
        <p className="gd-hint">Combine PDF pages in this order. Interactive actions are removed; originals stay unchanged.</p></>}
      <button type="button" className="gd-send" disabled={!d.ready} onClick={() => void d.send()}>{d.busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}Prepare selected files</button>
    </fieldset>
    {d.job && <DeliveryStatus job={d.job} />}{d.job?.can_retry&&<button type="button" disabled={d.busy} onClick={()=>void d.confirmDelivery(false,true)}>Retry remaining documents</button>}{d.job?.status === 'READY' && <div><button type="button" disabled={d.busy} onClick={()=>void d.confirmDelivery()}>Confirm and send</button><button type="button" disabled={d.busy} onClick={()=>void d.confirmDelivery(true)}>Cancel delivery</button></div>}
    {d.error && <p role="alert" className="field-error">{d.error}</p>}
  </details>;
}

const KindIcon = ({ f }: { f: Row }) => isPdf(f) ? <FileText aria-hidden="true" /> : String(f.mime || '').startsWith('image/') ? <FileImage aria-hidden="true" /> : <FileIcon aria-hidden="true" />;

/** Telegram Mini App: a full-screen selection sheet opened from the Send to Telegram button above the file list. */
export function MiniDeliverySheet({ layer, onClose, ...props }: Props & { onClose: () => void; layer: (close: () => void) => void }) {
  const { files } = props, d = useDelivery(props), titleId = useId(), nameId = useId();
  const close = () => { if (!d.busy) onClose(); };
  layer(close);
  const all = d.selected.length === files.length;
  const done = !!d.job && !d.pending && d.job.status !== 'READY';
  return (
    <div className="picker gd-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="picker-head">
        <button type="button" className="icon-btn" onClick={close} aria-label="Close"><X aria-hidden="true" /></button>
        <h2 id={titleId}>Send to Telegram</h2>
        <span className="picker-spacer" aria-hidden="true" />
      </div>
      <div className="gd-sheet-body">
        <p className="hint small">To your own connected Telegram chat. Files are sent in the order you select them.</p>
        <fieldset className="gd-sheet-files" disabled={d.busy || d.pending || d.job?.status==='READY'}>
          <legend className="gd-sheet-legend"><span>Files</span><span className="gd-sheet-count" aria-live="polite">{d.selected.length} of {files.length} selected</span>
            <button type="button" className="btn small" onClick={() => d.setSelected(all ? [] : files.map(f => f.id))}>{all ? 'Clear' : 'Select all'}</button></legend>
          <ul className="gd-sheet-list">{files.map(f => {
            const at = d.selected.indexOf(f.id), on = at >= 0;
            return <li key={f.id}><button type="button" className="gd-sheet-row" aria-pressed={on} onClick={() => d.toggle(f.id, !on)}>
              <span className={`gd-box${on ? ' is-on' : ''}`} aria-hidden="true">{on ? (d.selected.length > 1 ? <span className="num">{at + 1}</span> : <Check />) : null}</span>
              <span className="gd-kind"><KindIcon f={f} /></span>
              <span className="row-main"><span className="row-title">{f.name}</span><span className="row-meta">{fileKind(f)}{f.size ? ` · ${fileSize(f.size)}` : ''}</span></span>
            </button></li>;
          })}</ul>
        </fieldset>
        {d.selected.length > 1 && <section className="gd-sheet-section" aria-labelledby={`${titleId}-order`}>
          <h3 id={`${titleId}-order`}>Order</h3>
          <ol className="gd-sheet-order">{d.selected.map((id, i) => <li key={id}><span className="num">{i + 1}</span><span className="gd-order-name">{files.find(f => f.id === id)?.name}</span>
            <button type="button" className="icon-btn" disabled={i === 0 || d.busy || d.pending || d.job?.status==='READY'} aria-label={`Move file ${i + 1} up`} onClick={() => d.move(id, -1)}><ArrowUp aria-hidden="true" /></button>
            <button type="button" className="icon-btn" disabled={i === d.selected.length - 1 || d.busy || d.pending || d.job?.status==='READY'} aria-label={`Move file ${i + 1} down`} onClick={() => d.move(id, 1)}><ArrowDown aria-hidden="true" /></button></li>)}</ol>
        </section>}
        <fieldset className="gd-sheet-section gd-methods" disabled={d.busy || d.pending || d.job?.status==='READY'}>
          <legend>Sending method</legend>
          <label className={`gd-method${d.mode === 'SEPARATE' ? ' is-on' : ''}`}><input type="radio" name={`${titleId}-mode`} checked={d.mode === 'SEPARATE'} onChange={() => d.setMode('SEPARATE')} />
            <span className="row-main"><span className="row-title">Send files separately</span><span className="row-meta">{d.selected.length > 1 ? `${d.selected.length} documents, one after another` : 'Each file as its own document'}</span></span></label>
          <label className={`gd-method${d.merging ? ' is-on' : ''}${d.pdfs ? '' : ' is-off'}`}><input type="radio" name={`${titleId}-mode`} checked={d.merging} disabled={!d.pdfs} onChange={() => d.setMode('MERGED_PDF')} />
            <span className="row-main"><span className="row-title">Combine PDFs and send</span><span className="row-meta">{d.pdfs ? 'PDF pages in this order; oversized output is split into numbered parts' : d.mergeBlock}</span></span></label>
          {d.merging && <div className="gd-sheet-name">
            <label htmlFor={nameId} className="field-label">Name of the combined PDF</label>
            <span className="gd-name"><input id={nameId} className="input" value={d.name} maxLength={116} onChange={e => d.setName(e.target.value)} aria-invalid={!!d.nameError || undefined} aria-describedby={`${nameId}-hint`} /><span aria-hidden="true">.pdf</span></span>
            <p id={`${nameId}-hint`} className={d.nameError ? 'error small' : 'hint small'}>{d.nameError || `Sent as “${d.fileName}”. Interactive actions are removed; the original files stay unchanged.`}</p>
          </div>}
        </fieldset>
        {d.job && <section className="gd-sheet-section"><DeliveryStatus job={d.job} />{d.job.can_retry&&<button type="button" className="btn" disabled={d.busy} onClick={()=>void d.confirmDelivery(false,true)}>Retry remaining documents</button>}</section>}
        {d.error && <p role="alert" className="error">{d.error}</p>}
      </div>
      <div className="gd-sheet-foot">
        {d.job?.status === 'READY' ? <><button type="button" className="btn" disabled={d.busy} onClick={()=>void d.confirmDelivery(true)}>Cancel delivery</button><button type="button" className="btn primary" disabled={d.busy} onClick={()=>void d.confirmDelivery()}>Confirm and send</button></> : done ? <><button type="button" className="btn" onClick={d.reset}>Send more</button><button type="button" className="btn primary" onClick={onClose}>Done</button></>
          : <><button type="button" className="btn" onClick={close} disabled={d.busy}>Cancel</button>
            <button type="button" className="btn primary gd-sheet-send" disabled={!d.ready} onClick={() => void d.send()}>{d.busy || d.pending ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}{d.pending ? 'Sending…' : d.selected.length ? `Prepare ${d.merging ? 'combined PDF' : `${d.selected.length} ${d.selected.length === 1 ? 'file' : 'files'}`}` : 'Select files'}</button></>}
      </div>
    </div>
  );
}
