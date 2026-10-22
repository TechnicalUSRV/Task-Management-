import { uiText, useLanguage } from "./i18n";
// In-app preview of attachments (task files, Group attachment cells and the Telegram Mini App).
//
// Images and PDFs are shown from the file itself, read through the same authorized address as the download
// (`inline=1`); PDFs are drawn page by page with PDF.js (loaded only when a PDF is opened, scripts in PDFs never run).
// Word, Excel, PowerPoint, CSV and text files are read on the server into plain text, headings, tables and slides
// (`…/preview`), which are rendered here as text — no HTML from a file is ever inserted into the page. Anything else
// offers the download. Every request goes through the server's access checks, so a preview shows exactly what the
// person may download.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, File as FileIcon, FileImage, FileSpreadsheet, FileText, Loader2, Maximize2, Minus, Plus, Presentation, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiFetch, apiPath } from './api-client';
import './styles/file-preview.css';

type Row = Record<string, any>;
export type PreviewFile = { id?: string; name: string; mime: string; size?: number; detail?: string };
export type PreviewSource = {
  file: PreviewFile;
  /** The file itself (inline), for images and PDFs. */
  bytesUrl: string;
  /** The readable preview (JSON) of Word, Excel, PowerPoint, CSV and text files. */
  previewUrl: string;
  /** Fetches one of the addresses above with the right credentials. */
  load: (url: string) => Promise<Response>;
  /** A download address, or an action that downloads (the Mini App uses Telegram's own download). */
  download: string | (() => void);
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic'];
const DATA = ['text/plain', 'text/csv', XLSX, DOCX, PPTX];
const TYPE_LABEL: Record<string, string> = {
  'application/pdf': 'PDF document', [DOCX]: 'Word document', [XLSX]: 'Excel workbook', [PPTX]: 'PowerPoint presentation', 'text/csv': 'CSV table',
  'text/plain': 'Text file', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image', 'image/webp': 'WebP image', 'image/gif': 'GIF image', 'image/heic': 'HEIC photo',
  'application/zip': 'ZIP archive', 'application/msword': 'Word 97–2003 document', 'application/vnd.ms-excel': 'Excel 97–2003 workbook',
};
export type FileNavigation = { index: number; total: number; onSelect: (index: number) => void };
export type PreviewKind = 'image' | 'pdf' | 'data' | 'none';
export const previewKind = (mime: string): PreviewKind => (IMAGES.includes(mime) ? 'image' : mime === 'application/pdf' ? 'pdf' : DATA.includes(mime) ? 'data' : 'none');
export const typeLabel = (f: PreviewFile) => TYPE_LABEL[f.mime] || (f.name.includes('.') ? `${f.name.split('.').pop()!.toUpperCase()} file` : uiText("File"));
export const sizeLabel = (n?: number) => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);
const KindIcon = ({ mime }: { mime: string }) => {
  const Icon = mime.startsWith('image/') ? FileImage : mime === XLSX || mime === 'text/csv' ? FileSpreadsheet : mime === PPTX ? Presentation : mime === 'application/pdf' || mime === DOCX || mime === 'text/plain' ? FileText : FileIcon;
  return <Icon aria-hidden="true" />;
};

const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
type Zoom = number | 'fit';
const nextStep = (current: number, up: boolean) => (up ? STEPS.find(s => s > current + 0.001) ?? STEPS[STEPS.length - 1] : [...STEPS].reverse().find(s => s < current - 0.001) ?? STEPS[0]);

class NoPreviewRoute extends Error {}
async function failure(res: Response): Promise<Error> {
  let message = '';
  try { message = (await res.json()).error || ''; } catch { /* not JSON */ }
  // A server without readable previews (the earlier Node version) answers “Route not found.”: offer the download.
  if (res.status === 404 && message === 'Route not found.') return new NoPreviewRoute();
  if (res.status === 404) message = uiText("This file is no longer available. It may have been removed, or you no longer have access to it.");
  return new Error(message || uiText("The preview could not be loaded. Check your connection and try again."));
}

// PDF.js is loaded the first time a PDF is opened. Its worker is a file of this app (same origin), so the page's
// content security policy needs no exception; eval is switched off.
let pdfjs: Promise<any> | null = null;
function loadPdfjs() {
  pdfjs ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import(uiText("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"))]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

/** The web app's preview: a large dialog (a full-height sheet on phones). */
export function FilePreviewDialog({ source, onClose, navigation }: { source: PreviewSource; onClose: () => void; navigation?: FileNavigation }) {
  useLanguage();
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="dialog-preview" showCloseButton={false}>
        <PreviewPane key={source.bytesUrl} source={source} navigation={navigation} onClose={onClose} title={name => <DialogTitle className="fp-name">{name}</DialogTitle>}
          description={text => <DialogDescription className="fp-meta">{text}</DialogDescription>} />
      </DialogContent>
    </Dialog>
  );
}

/** The preview itself: a toolbar (name, type, zoom, pages, download, close) and the file. `dark` for the Mini App's
 *  full-screen viewer. `title` and `description` let the dialog name itself after the file. */
export function PreviewPane({ source, onClose, dark = false, title, description, navigation }: { source: PreviewSource; onClose: () => void; dark?: boolean; navigation?: FileNavigation; title?: (name: string) => ReactNode; description?: (text: string) => ReactNode }) {
  useLanguage();
  const pane = useRef<HTMLDivElement>(null);
  const { file } = source, kind = previewKind(file.mime);
  const [zoom, setZoom] = useState<Zoom>('fit'), [fitScale, setFitScale] = useState(1);
  const [pages, setPages] = useState(0), [page, setPage] = useState(1);
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(kind !== 'none');
  const [imageFailed, setImageFailed] = useState(false);
  const effective = zoom === 'fit' ? fitScale : zoom;
  const zoomable = (kind === 'image' && !imageFailed) || kind === 'pdf' || (kind === 'data' && !!data && data.kind !== 'unsupported');
  const changeZoom = useCallback((up: boolean) => setZoom(z => nextStep(z === 'fit' ? fitScale : z, up)), [fitScale]);
  const jump = useCallback((n: number) => { setPage(n); if (dark) pane.current?.querySelector(`[data-pdf-page="${n}"]`)?.scrollIntoView({ block: 'start' }); }, [dark]);
  const go = useCallback((n: number) => jump(Math.min(Math.max(1, page + n), Math.max(1, pages))), [pages, page, jump]);
  useEffect(() => {
    if (kind !== 'data') return;
    let live = true;
    setLoading(true); setError('');
    source.load(source.previewUrl).then(async res => { if (!res.ok) throw await failure(res); return res.json(); })
      .then(body => { if (live) setData(body); })
      .catch(e => { if (!live) return; if (e instanceof NoPreviewRoute) setData({ kind: 'unsupported' }); else setError((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind, source]);
  // Keyboard: + and − zoom, 0 fits, ← and → turn PDF pages (Escape closes, through the dialog or the Mini App layer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (zoomable && (e.key === '+' || e.key === '=')) { e.preventDefault(); changeZoom(true); }
      else if (zoomable && (e.key === '-' || e.key === '_')) { e.preventDefault(); changeZoom(false); }
      else if (zoomable && e.key === '0') { e.preventDefault(); setZoom('fit'); }
      else if (kind === 'pdf' && (e.key === 'ArrowRight' || e.key === 'PageDown')) { e.preventDefault(); go(1); }
      else if (kind === 'pdf' && (e.key === 'ArrowLeft' || e.key === 'PageUp')) { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomable, kind, changeZoom, go]);
  const meta = [typeLabel(file), sizeLabel(file.size), file.detail].filter(Boolean).join(' · ');
  const download = typeof source.download === 'string'
    ? <a className="fp-btn fp-download" href={source.download} download={file.name} aria-label={uiText("Download {p0}", { p0: file.name })}><Download aria-hidden="true" /><span className="fp-label">{uiText("Download")}</span></a>
    : <button type="button" className="fp-btn fp-download" onClick={source.download} aria-label={uiText("Download {p0}", { p0: file.name })}><Download aria-hidden="true" /><span className="fp-label">{uiText("Download")}</span></button>;
  const unsupported = kind === 'none' || imageFailed || data?.kind === 'unsupported';
  return (
    <div ref={pane} className={`fp${dark ? " is-dark" : ''}`} data-kind={kind}>
      <header className="fp-bar">
        <span className="fp-icon"><KindIcon mime={file.mime} /></span>
        <div className="fp-title">
          {title ? title(file.name) : <p className="fp-name">{file.name}</p>}
          {description ? description(meta) : <p className="fp-meta">{meta}</p>}
        </div>
        <div className="fp-actions">
          {kind === 'pdf' && pages > 0 && <div className="fp-group" role="group" aria-label={uiText("Pages")}>
            <button type="button" className="fp-btn" onClick={() => go(-1)} disabled={page <= 1} aria-label={uiText("Previous page")} title={uiText("Previous page (←)")}><ChevronLeft aria-hidden="true" /></button>
            <label className="fp-page"><span className="sr-only">{uiText("Page")}</span>
              <input type="number" inputMode="numeric" min={1} max={pages} value={page} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= pages) jump(n); }} aria-label={uiText("Page, 1 to {p0}", { p0: pages })} />
              <span aria-hidden="true">/ {pages}</span></label>
            <button type="button" className="fp-btn" onClick={() => go(1)} disabled={page >= pages} aria-label={uiText("Next page")} title={uiText("Next page (→)")}><ChevronRight aria-hidden="true" /></button>
          </div>}
          {zoomable && <div className="fp-group" role="group" aria-label={uiText("Zoom")}>
            <button type="button" className="fp-btn" onClick={() => changeZoom(false)} disabled={effective <= STEPS[0] + 0.001} aria-label={uiText("Zoom out")} title={uiText("Zoom out (−)")}><Minus aria-hidden="true" /></button>
            <span className="fp-zoom" aria-live="polite">{Math.round(effective * 100)}%</span>
            <button type="button" className="fp-btn" onClick={() => changeZoom(true)} disabled={effective >= STEPS[STEPS.length - 1] - 0.001} aria-label={uiText("Zoom in")} title={uiText("Zoom in (+)")}><Plus aria-hidden="true" /></button>
            <button type="button" className="fp-btn" onClick={() => setZoom('fit')} aria-pressed={zoom === 'fit'} aria-label={uiText("Fit to the window")} title={uiText("Fit (0)")}><Maximize2 aria-hidden="true" /></button>
          </div>}
          {download}
        </div>
        <button type="button" className="fp-btn fp-close" onClick={onClose} aria-label={uiText("Close preview")} title={uiText("Close (Esc)")}><X aria-hidden="true" /></button>
      </header>
      {navigation && navigation.total > 1 && <nav className="fp-file-nav" aria-label={uiText("Files in this Attachment cell")}><button type="button" disabled={navigation.index <= 0} onClick={() => navigation.onSelect(navigation.index - 1)}><ChevronLeft size={16} />{uiText("Previous File")}</button><span>{uiText("File ")}{navigation.index + 1} / {navigation.total}</span><button type="button" disabled={navigation.index >= navigation.total - 1} onClick={() => navigation.onSelect(navigation.index + 1)}>{uiText("Next File")}<ChevronRight size={16} /></button></nav>}
      <div className="fp-stage" tabIndex={0} role="region" aria-label={uiText("Preview of {p0}", { p0: file.name })}>
        {unsupported ? <NoPreview file={file} reason={data?.reason || (imageFailed ? uiText("This browser can’t show this image.") : '')} download={download} />
          : error ? <div className="fp-message" role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p>{download}</div>
          : kind === 'image' ? <ImageView source={source} zoom={zoom} onFit={setFitScale} onFailed={() => setImageFailed(true)} />
          : kind === 'pdf' ? <PdfView source={source} zoom={zoom} page={page} continuous={dark} onVisiblePage={setPage} onFit={setFitScale} onPages={n => { setPages(n); setPage(p => Math.min(p, n)); }} onError={setError} />
          : loading || !data ? <Loading />
          : <div className="fp-data" style={{ '--fp-scale': effective } as CSSProperties}><DataView data={data} /></div>}
      </div>
    </div>
  );
}

const Loading = () => <div className="fp-message" role="status"><Loader2 className="spin" aria-hidden="true" /><p>{uiText("Loading the preview…")}</p></div>;

function NoPreview({ file, reason, download }: { file: PreviewFile; reason?: string; download: ReactNode }) {
  useLanguage();
  return (
    <div className="fp-message">
      <span className="fp-big-icon"><KindIcon mime={file.mime} /></span>
      <p className="fp-message-title">{uiText("Preview isn’t available for this file")}</p>
      <p>{reason || uiText("{p0}s can’t be shown here.", { p0: typeLabel(file) })} {uiText("Download it to open it on your device.")}</p>
      {download}
    </div>
  );
}

/** Measures the stage, for fitting a page or an image into it. */
function useStageSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current?.closest('.fp-stage') as HTMLElement | null;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function ImageView({ source, zoom, onFit, onFailed }: { source: PreviewSource; zoom: Zoom; onFit: (scale: number) => void; onFailed: () => void }) {
  useLanguage();
  const box = useRef<HTMLDivElement>(null), stage = useStageSize(box);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const fit = natural && stage.width ? Math.min(1, (stage.width - 32) / natural.width, (stage.height - 32) / natural.height) : 1;
  useEffect(() => { onFit(Math.max(0.05, fit)); }, [fit, onFit]);
  const scale = zoom === 'fit' ? fit : zoom;
  return (
    <div ref={box} className={`fp-canvas${zoom === 'fit' ? " is-fit" : ''}`}>
      {!natural && <Loading />}
      <img src={source.bytesUrl} alt={source.file.name} draggable={false} onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={onFailed}
        style={natural ? { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) } : { opacity: 0 }} />
    </div>
  );
}

function PdfView({ source, zoom, page, onFit, onPages, onError, continuous, onVisiblePage }: { continuous?: boolean; onVisiblePage: (n: number) => void; source: PreviewSource; zoom: Zoom; page: number; onFit: (scale: number) => void; onPages: (n: number) => void; onError: (message: string) => void }) {
  useLanguage();
  const box = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), stage = useStageSize(box);
  const [doc, setDoc] = useState<any>(null), [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true, task: any = null;
    (async () => {
      try {
        const [lib, res] = await Promise.all([loadPdfjs(), source.load(source.bytesUrl)]);
        if (!res.ok) throw await failure(res);
        const bytes = new Uint8Array(await res.arrayBuffer());
        task = lib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: true });
        const loaded = await task.promise;
        if (!live) { void loaded.destroy(); return; }
        setDoc(loaded); onPages(loaded.numPages);
      } catch (e) {
        const err = e as Error & { name?: string };
        if (live) onError(err.name === 'PasswordException' ? uiText("This PDF is password-protected. Download it to open it with its password.")
          : err.name === 'InvalidPDFException' ? uiText("This PDF is damaged and can’t be shown. Download it to try opening it on your device.") : err.message || uiText("The PDF could not be shown."));
      }
    })();
    return () => { live = false; try { task?.destroy?.(); } catch { /* already closed */ } };
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { try { doc?.destroy?.(); } catch { /* ignore */ } }, [doc]);
  useEffect(() => {
    if (continuous || !doc || !canvas.current || !stage.width) return;
    let render: any = null, live = true;
    setBusy(true);
    (async () => {
      const p = await doc.getPage(Math.min(page, doc.numPages));
      if (!live) return;
      const base = p.getViewport({ scale: 1 });
      const fit = Math.max(0.1, Math.min((stage.width - 32) / base.width, 4));
      onFit(fit);
      const viewport = p.getViewport({ scale: zoom === 'fit' ? fit : zoom });
      // Sharp on high-density screens, but never a canvas too large for the device to draw.
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      while (viewport.width * viewport.height * ratio * ratio > 24e6 && ratio > 0.5) ratio /= 1.5;
      const el = canvas.current!, ctx = el.getContext('2d')!;
      el.width = Math.floor(viewport.width * ratio); el.height = Math.floor(viewport.height * ratio);
      el.style.width = `${Math.floor(viewport.width)}px`; el.style.height = `${Math.floor(viewport.height)}px`;
      render = p.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await render.promise;
      if (live) setBusy(false);
    })().catch(e => { if ((e as Error)?.name !== 'RenderingCancelledException' && live) onError(uiText("This page could not be shown. Download the PDF to open it on your device.")); });
    return () => { live = false; try { render?.cancel(); } catch { /* finished */ } };
  }, [doc, page, zoom, stage.width]); // eslint-disable-line react-hooks/exhaustive-deps
  if (continuous) return <div ref={box} className="fp-continuous">{!doc ? <Loading /> : Array.from({ length: doc.numPages }, (_, i) => <ContinuousPage key={i} doc={doc} number={i + 1} zoom={zoom} width={stage.width} onFit={onFit} onVisible={onVisiblePage} onError={onError} />)}</div>;
  return (
    <div ref={box} className="fp-canvas">
      {(!doc || busy) && <div className="fp-loading-overlay"><Loader2 className="spin" aria-hidden="true" /><span className="sr-only">{uiText("Loading the page…")}</span></div>}
      <canvas ref={canvas} className="fp-page-canvas" role="img" aria-label={uiText("Page {p0} of {p1}", { p0: page, p1: source.file.name })} />
    </div>
  );
}

/** Only pages near the viewport allocate a canvas; offscreen pages keep their measured space. */
function ContinuousPage({ doc, number, zoom, width, onFit, onVisible, onError }: { doc: any; number: number; zoom: Zoom; width: number; onFit: (n: number) => void; onVisible: (n: number) => void; onError: (s: string) => void }) {
  useLanguage();
  const box = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), [near, setNear] = useState(false), [height, setHeight] = useState(600);
  useEffect(() => {
    const el = box.current!;
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { root: el.closest('.fp-stage'), rootMargin: '600px' });
    const current = new IntersectionObserver(entries => { if (entries[0].isIntersecting) onVisible(number); }, { root: el.closest('.fp-stage'), rootMargin: '0px 0px -70% 0px' });
    observer.observe(el); current.observe(el); return () => { observer.disconnect(); current.disconnect(); };
  }, [number, onVisible]);
  useEffect(() => {
    if (!near || !width || !canvas.current) return;
    let live = true, render: any = null;
    const el = canvas.current;
    (async () => {
      const p = await doc.getPage(number); if (!live) return;
      const base = p.getViewport({ scale: 1 }), fit = Math.max(.1, Math.min((width - 24) / base.width, 4));
      if (number === 1) onFit(fit);
      const viewport = p.getViewport({ scale: zoom === 'fit' ? fit : zoom });
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      while (viewport.width * viewport.height * ratio * ratio > 8e6 && ratio > .25) ratio /= 1.5;
      setHeight(Math.ceil(viewport.height)); el.width = Math.ceil(viewport.width * ratio); el.height = Math.ceil(viewport.height * ratio);
      el.style.width = `${viewport.width}px`; el.style.height = `${viewport.height}px`;
      render = p.render({ canvasContext: el.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
    })().catch(e => { if (live && e.name !== 'RenderingCancelledException') onError(uiText("This PDF page could not be shown. Download the file to open it.")); });
    return () => { live = false; render?.cancel(); el.width = 0; el.height = 0; };
  }, [near, width, doc, number, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} data-pdf-page={number} className="fp-scroll-page" style={{ minHeight: height }} aria-label={uiText("PDF page {p0}", { p0: number })}><span className="fp-scroll-label">{uiText("Page ")}{number}</span>{near && <canvas ref={canvas} role="img" aria-label={uiText("Page {p0}", { p0: number })} />}</div>;
}

// ---------------------------------------------------------------- readable previews (text, tables, documents, slides)
function DataView({ data }: { data: Row }) {
  useLanguage();
  if (data.kind === 'text') return <><pre className="fp-text">{data.text}</pre>{data.truncated && <Truncated />}</>;
  if (data.kind === 'table') return <TableView sheets={data.sheets || []} />;
  if (data.kind === 'document') return <article className="fp-paper fp-doc">{(data.blocks || []).map((b: Row, i: number) => <Block key={i} block={b} />)}{!data.blocks?.length && <p className="fp-muted">{uiText("This document has no text to show.")}</p>}{data.truncated && <Truncated />}</article>;
  if (data.kind === 'slides') return <ol className="fp-slides">{(data.slides || []).map((s: Row) => <li key={s.number} className="fp-slide"><span className="fp-slide-number">{uiText("Slide ")}{s.number}</span>{s.title && <h3>{s.title}</h3>}{s.paragraphs?.length ? <ul>{s.paragraphs.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul> : !s.title && <p className="fp-muted">{uiText("No text on this slide.")}</p>}</li>)}{data.truncated && <Truncated />}</ol>;
  return null;
}
const Truncated = () => <p className="fp-truncated">{uiText("The preview shows the beginning of this file. Download it to see everything.")}</p>;
const Runs = ({ runs }: { runs: Row[] }) => <>{(runs || []).map((r, i) => { let node: ReactNode = r.t; if (r.i) node = <em>{node}</em>; if (r.b) node = <strong>{node}</strong>; return <span key={i}>{node}</span>; })}</>;
function Block({ block: b }: { block: Row }) {
  useLanguage();
  if (b.type === 'heading') { const H = (['h2', 'h3', 'h4', 'h5'] as const)[Math.min(3, Math.max(0, (b.level || 1) - 1))]; return <H><Runs runs={b.runs} /></H>; }
  if (b.type === 'item') return <p className="fp-item" style={{ marginInlineStart: `${1.25 + (b.level || 0) * 1.25}em` }}><span aria-hidden="true">• </span><Runs runs={b.runs} /></p>;
  if (b.type === 'table') return <div className="fp-table-wrap"><table className="fp-table"><tbody>{(b.rows || []).map((r: string[], i: number) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
  return b.runs?.length ? <p><Runs runs={b.runs} /></p> : <p className="fp-gap" aria-hidden="true" />;
}
const columnName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function TableView({ sheets }: { sheets: Row[] }) {
  useLanguage();
  const [at, setAt] = useState(0), sheet = sheets[Math.min(at, sheets.length - 1)];
  const width = useMemo(() => Math.max(sheet?.columns || 0, ...(sheet?.rows || []).map((r: string[]) => r.length)), [sheet]);
  if (!sheet) return <p className="fp-muted">{uiText("This file has no rows to show.")}</p>;
  return (
    <div className="fp-sheet">
      {sheets.length > 1 && <div className="fp-tabs" role="tablist" aria-label={uiText("Worksheets")}>{sheets.map((s, i) => <button key={i} type="button" role="tab" aria-selected={i === at} className="fp-tab" onClick={() => setAt(i)}>{s.name}</button>)}</div>}
      <div className="fp-table-wrap" role="tabpanel" aria-label={sheet.name}>
        <table className="fp-table is-grid">
          <thead><tr><th scope="col" className="fp-corner"><span className="sr-only">{uiText("Row")}</span></th>{Array.from({ length: width }, (_, j) => <th key={j} scope="col">{columnName(j)}</th>)}</tr></thead>
          <tbody>{(sheet.rows || []).map((r: string[], i: number) => <tr key={i}><th scope="row">{i + 1}</th>{Array.from({ length: width }, (_, j) => <td key={j} title={(r[j] ?? '').length > 30 ? r[j] : undefined}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
        </table>
        {!sheet.rows?.length && <p className="fp-muted">{uiText("This worksheet is empty.")}</p>}
      </div>
      {sheet.truncated && <Truncated />}
    </div>
  );
}

// ---------------------------------------------------------------- the web app (signed-in session)
/** A task's file: the same address as its download (inline=1 for the file itself), and its readable preview. */
export function TaskFilePreview({ file, onClose }: { file: PreviewFile & { id: string }; onClose: () => void }) {
  useLanguage();
  const source = useMemo<PreviewSource>(() => {
    const id = encodeURIComponent(file.id), bytes = `/api/tasks/file?id=${id}&inline=1`;
    return { file, bytesUrl: apiPath(bytes), previewUrl: `/api/tasks/file/preview?id=${id}`, load: url => apiFetch(url === apiPath(bytes) ? bytes : url),
      download: apiPath(`/api/tasks/file?id=${id}`) };
  }, [file]);
  return <FilePreviewDialog source={source} onClose={onClose} />;
}
/** A file in a Group's Attachment cell (the group's row and column rules decide who may open it). */
export function GroupFilePreview({ groupId, file, onClose, navigation }: { groupId: string; file: PreviewFile & { id: string }; onClose: () => void; navigation?: FileNavigation }) {
  useLanguage();
  const source = useMemo<PreviewSource>(() => {
    const q = `id=${encodeURIComponent(groupId)}&file=${encodeURIComponent(file.id)}`, bytes = `/api/tasks/group/file?${q}&inline=1`;
    return { file, bytesUrl: apiPath(bytes), previewUrl: `/api/tasks/group/file/preview?${q}`, load: url => apiFetch(url === apiPath(bytes) ? bytes : url),
      download: apiPath(`/api/tasks/group/file?${q}`) };
  }, [groupId, file]);
  return <FilePreviewDialog source={source} onClose={onClose} navigation={navigation} />;
}
