// Server-side check that an uploaded file really is the kind of file its name says (V5.6.8), shared by task files and
// V5.6.9 Group attachments: never a program renamed as a document.
const startsWith=(b,...bytes)=>bytes.every((x,i)=>b[i]===x);
export function contentMatches(ext,b){
 if(startsWith(b,0x4d,0x5a)||startsWith(b,0x7f,0x45,0x4c,0x46)||startsWith(b,0xcf,0xfa,0xed,0xfe)||startsWith(b,0xfe,0xed,0xfa,0xce)||startsWith(b,0xca,0xfe,0xba,0xbe))return false;
 const zip=startsWith(b,0x50,0x4b),ole=startsWith(b,0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1),head=b.subarray(0,16).toString('latin1');
 switch(ext){
  case 'pdf':return b.subarray(0,1024).toString('latin1').includes('%PDF-');
  // Any real image is accepted for an image name (phones and Telegram often label one kind as another).
  case 'png':case 'jpg':case 'jpeg':case 'gif':case 'webp':case 'heic':case 'heif':
   return startsWith(b,0x89,0x50,0x4e,0x47)||startsWith(b,0xff,0xd8,0xff)||head.startsWith('GIF8')||head.startsWith('RIFF')&&head.slice(8,12)==='WEBP'||head.slice(4,8)==='ftyp';
  case 'docx':case 'xlsx':case 'pptx':case 'zip':return zip;
  case 'doc':case 'xls':case 'ppt':return ole;
  default:return !zip&&!ole;
 }
}
/** A file name as it is kept: the last part of a path, without control characters (empty → "file"). */
export const cleanFileName=name=>String(name||'').replaceAll('\\','/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'').trim()||'file';
