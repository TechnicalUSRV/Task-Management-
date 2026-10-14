// V5.5: secrets kept on the server (Google refresh tokens and the OAuth client secret) are encrypted with AES-256-GCM.
// The key comes from the SUNNY_SECRET_KEY environment variable (32 bytes, base64) or, when that is not set, from the
// file secret.key next to the company databases, created once with owner-only permissions. Encrypted values never
// leave the server; the screens only learn whether a secret is set.
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';

const keys=new Map();
function keyFor(dir){
 const env=process.env.SUNNY_SECRET_KEY;
 if(env){const k=Buffer.from(env,'base64');if(k.length!==32)throw new Error('SUNNY_SECRET_KEY must be 32 bytes, base64-encoded (for example the output of: openssl rand -base64 32).');return k;}
 const file=path.join(dir,'secret.key');
 if(keys.has(file))return keys.get(file);
 let k;
 if(existsSync(file))k=Buffer.from(readFileSync(file,'utf8').trim(),'base64');
 else{mkdirSync(dir,{recursive:true});k=randomBytes(32);writeFileSync(file,k.toString('base64')+'\n',{mode:0o600});try{chmodSync(file,0o600);}catch{}}
 if(k.length!==32)throw new Error(`${file} is damaged: it must hold 32 bytes, base64-encoded.`);
 keys.set(file,k);return k;
}
/** {seal(text) → 'v1:iv:tag:data', open(sealed) → text} with the key for this data folder (':memory:' uses a process key). */
export function secretBox(dir){
 const key=dir?keyFor(dir):(keys.get(':memory:')||(keys.set(':memory:',randomBytes(32)),keys.get(':memory:')));
 return {
  seal(text){
   if(text===null||text===undefined||text==='')return '';
   const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(String(text),'utf8'),c.final()]);
   return ['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join(':');
  },
  open(sealed){
   if(!sealed)return '';
   const [v,iv,tag,data]=String(sealed).split(':');if(v!=='v1'||!iv||!tag||data===undefined)throw new Error('This secret was stored in an unknown format.');
   const d=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));d.setAuthTag(Buffer.from(tag,'base64'));
   try{return Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString('utf8');}catch{throw new Error('A stored secret can’t be read with this key (was secret.key or SUNNY_SECRET_KEY changed?). Reconnect Google.');}
  },
 };
}
export const hashToken=t=>createHash('sha256').update(String(t)).digest('hex');
