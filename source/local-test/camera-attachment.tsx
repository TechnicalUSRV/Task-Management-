import { uiText, useLanguage } from "./i18n";
import { useEffect, useRef, useState } from 'react';
import { Camera, X, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { photoPdf } from './camera-pdf.mjs';
import './styles/camera-attachment.css';

type Photo = { url: string; blob: Blob; width: number; height: number };
type Props = { upload: (file: File) => Promise<unknown>; maxBytes?: number; disabled?: boolean };
export function CameraAttachment({ upload, maxBytes = 30*1024*1024, disabled }: Props) {
  useLanguage();
  const [open,setOpen] = useState(false);
  return <><button type="button" className="btn camera-open" disabled={disabled} onClick={()=>setOpen(true)}><Camera size={17}/>{uiText("Camera")}</button>
    {open && <Capture upload={upload} maxBytes={maxBytes} close={()=>setOpen(false)} />}</>;
}
function Capture({upload,maxBytes,close}: Props & {maxBytes:number;close:()=>void}) {
  useLanguage();
  const [photos,setPhotos] = useState<Photo[]>([]), [multi,setMulti] = useState(false), [error,setError] = useState('');
  const [busy,setBusy] = useState(false), [live,setLive] = useState(false), [name,setName] = useState('Camera-document');
  const video = useRef<HTMLVideoElement>(null), input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream|null>(null), active = useRef(true), saved = useRef<Photo[]>([]), replacing = useRef<number|null>(null);
  const stop = () => { stream.current?.getTracks().forEach(t=>t.stop()); stream.current=null; setLive(false); };
  useEffect(()=>{ saved.current=photos; },[photos]);
  useEffect(()=>{
    active.current=true; panel.current?.focus();
    const hidden=()=>{if(document.hidden) stop();}; document.addEventListener('visibilitychange',hidden);
    return ()=>{active.current=false;stream.current?.getTracks().forEach(t=>t.stop());saved.current.forEach(p=>URL.revokeObjectURL(p.url));document.removeEventListener('visibilitychange',hidden);};
  },[]);
  const start = async () => {
    if(busy)return;setBusy(true);setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(uiText("Use the device camera button below."));
      stop(); const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:2560}},audio:false});
      if(!active.current){media.getTracks().forEach(t=>t.stop());return;}
      stream.current=media; if(video.current){video.current.srcObject=media;await video.current.play();}setLive(true);
    }catch{stop();setError(uiText("Live camera is unavailable or permission was declined. You can use the device camera/photo picker below."));}finally{if(active.current)setBusy(false);}
  };
  const canvasPhoto = async (source:CanvasImageSource,width:number,height:number) => {
    const ratio=Math.min(1,2000/Math.max(width,height)), canvas=document.createElement('canvas');
    canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error(uiText("Image capture is unavailable."));
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error(uiText("Unable to capture this photo."))),'image/jpeg',0.88));
    if(!active.current)return;
    const photo={blob,url:URL.createObjectURL(blob),width:canvas.width,height:canvas.height};
    {
      const out=[...saved.current], index=replacing.current;replacing.current=null;
      if(index!==null && out[index]){URL.revokeObjectURL(out[index].url);out[index]=photo;}
      else if(!multi){out.forEach(p=>URL.revokeObjectURL(p.url));out.splice(0,out.length,photo);}
      else if(out.length<20)out.push(photo);else URL.revokeObjectURL(photo.url);
      saved.current=out;setPhotos(out);
    }
    stop();
  };
  const capture = async()=>{
    if(!video.current?.videoWidth)return;setBusy(true);setError('');
    try{await canvasPhoto(video.current,video.current.videoWidth,video.current.videoHeight);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const pick=async(file?:File)=>{
    if(!file)return;setBusy(true);setError('');
    try{
      if(file.size>maxBytes)throw new Error(uiText("This photo exceeds the attachment size limit."));
      if(typeof createImageBitmap==='function'){
        const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
        try{await canvasPhoto(bitmap,bitmap.width,bitmap.height);}finally{bitmap.close();}
      }else{
        const url=URL.createObjectURL(file), img=new Image();
        try{await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error(uiText("Image could not be decoded.")));img.src=url;});await canvasPhoto(img,img.naturalWidth,img.naturalHeight);}finally{URL.revokeObjectURL(url);}
      }
    }catch{setError(uiText("This image could not be opened. Try taking a JPEG photo with the device camera."));}finally{setBusy(false);}
  };
  const remove=(i:number)=>{const old=saved.current;URL.revokeObjectURL(old[i].url);const out=old.filter((_,j)=>j!==i);replacing.current=null;saved.current=out;setPhotos(out);};
  const move=(i:number,by:number)=>{const out=[...saved.current];[out[i],out[i+by]]=[out[i+by],out[i]];replacing.current=null;saved.current=out;setPhotos(out);};
  const finish=async()=>{
    setBusy(true);setError('');stop();
    try{
      const base=(name.trim()||'Camera-document').replace(/[\\/:*?"<>|]/g,'-').replace(/\.(pdf|jpe?g)$/i,'');
      const blob=multi?photoPdf(await Promise.all(photos.map(async p=>({width:p.width,height:p.height,bytes:new Uint8Array(await p.blob.arrayBuffer())})))):photos[0].blob;
      if(blob.size>maxBytes)throw new Error(uiText("The combined document exceeds the attachment limit. Remove photos and try again."));
      await upload(new File([blob],`${base}.${multi?'pdf':'jpg'}`,{type:blob.type}));close();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <div className="capture-overlay" role="dialog" aria-modal="true" aria-label={uiText("Camera attachments")} ref={panel} tabIndex={-1} onKeyDown={e=>{
    if(e.key==='Escape'&&!busy){e.stopPropagation();close();}
    if(e.key==='Tab'){const els=panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)');if(!els?.length)return;const first=els[0],last=els[els.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  }}>
    <header><h2>{uiText("Camera attachments")}</h2><button type="button" aria-label={uiText("Close camera")} disabled={busy} onClick={close}><X/></button></header>
    <div className="capture-body">
      <label>{uiText("Capture mode")}<select value={multi?'multiple':'single'} disabled={busy||photos.length>0} onChange={e=>setMulti(e.target.value==='multiple')}><option value="single">{uiText("Single photo")}</option><option value="multiple">{uiText("Multiple photos → one PDF")}</option></select></label>
      <video ref={video} autoPlay muted playsInline className={live?'':'capture-hidden'} />
      <div className="capture-actions"><button type="button" disabled={busy||photos.length>=20} onClick={()=>{replacing.current=null;void start();}}>{photos.length?uiText("Add another photo"):uiText("Open camera")}</button>
        {live&&<button type="button" disabled={busy} onClick={()=>void capture()}>{uiText("Capture photo")}</button>}
        <button type="button" disabled={busy||(photos.length>=20&&replacing.current===null)} onClick={()=>{stop();input.current?.click();}}>{uiText("Device camera / photo picker")}</button>
        <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={e=>{void pick(e.target.files?.[0]);e.target.value='';}}/>
      </div>
      <p>{uiText("Review photos before uploading. ")}{multi?uiText("Only the combined PDF is uploaded."):uiText("Confirm the photo or retake it.")} {uiText("Photos stay on this device until upload.")}</p>
      <ol className="capture-photos">{photos.map((p,i)=><li key={p.url}><img src={p.url} alt={uiText("Photo {p0}", { p0: i+1 })}/><span>{uiText("Page ")}{i+1}</span><div>
        <button type="button" disabled={busy} onClick={()=>{replacing.current=i;void start();}}>{uiText("Retake")}</button>
        <button type="button" disabled={busy} aria-label={uiText("Delete photo {p0}", { p0: i+1 })} onClick={()=>remove(i)}><Trash2 size={18}/></button>
        <button type="button" disabled={busy||i===0} aria-label={uiText("Move photo {p0} up", { p0: i+1 })} onClick={()=>move(i,-1)}><ArrowUp size={18}/></button>
        <button type="button" disabled={busy||i===photos.length-1} aria-label={uiText("Move photo {p0} down", { p0: i+1 })} onClick={()=>move(i,1)}><ArrowDown size={18}/></button>
      </div></li>)}</ol>
      <label>{uiText("File name")}<input value={name} maxLength={100} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
      {error&&<p role="alert" className="capture-error">{error}</p>}
    </div>
    <footer><button type="button" disabled={busy} onClick={close}>{uiText("Cancel")}</button><button type="button" disabled={busy||!photos.length} onClick={()=>void finish()}>{busy?uiText("Processing…"):multi?uiText("Combine into PDF and upload"):uiText("Confirm and upload photo")}</button></footer>
  </div>;
}
