// Client-side PDF rendering preserves browser font shaping, including Khmer.
// Every authorized row is included. Pages are 2x rasterized for reliable layout;
// the companion print view is available when selectable text is needed.
import {PDFDocument,StandardFonts,rgb} from './vendor/pdf-lib.mjs';
import {formatted,filterDescription} from './report-format.mjs';
export async function reportPDF(report,makeCanvas=(w,h)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;return canvas;}){
 const doc=await PDFDocument.create();doc.setTitle(report.title);doc.setAuthor(report.company);doc.setSubject('Task Controlling Management report generated from authorized company records');
 const W=842,H=595,M=28,BOTTOM=548,scale=2,bodySize=9,line=13;
 let canvas,ctx,y,pageNo=0;
 const font=(bold=false,size=bodySize)=>ctx.font=`${bold?'bold ':''}${size}px Arial, "Noto Sans Khmer", sans-serif`;
 const wrap=(text,width)=>{const lines=[];for(const p of String(text??'').replace(/\r/g,'').split('\n')){let current='';const words=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(p)].map(x=>x.segment):p.split(/(\s+)/);for(const word of words){if(ctx.measureText(current+word).width<=width){current+=word;continue;}if(current){lines.push(current.trimEnd());current='';}if(ctx.measureText(word).width<=width){current=word.trimStart();continue;}const chars=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word)].map(x=>x.segment):Array.from(word);for(const ch of chars){if(ctx.measureText(current+ch).width>width&&current){lines.push(current);current=ch;}else current+=ch;}}lines.push(current);}return lines.length?lines:[''];};
 const textLines=(value,x,start,width,bold=false,size=bodySize)=>{font(bold,size);const lines=wrap(value,width);const leading=Math.max(line,size+4);for(let i=0;i<lines.length;i++)ctx.fillText(lines[i],x,start+i*leading);return lines.length*leading;};
 const start=()=>{canvas=makeCanvas(W*scale,H*scale);ctx=canvas.getContext('2d');ctx.scale(scale,scale);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,W,H);ctx.textBaseline='top';ctx.fillStyle='#163a65';y=M;y+=textLines(report.company,M,y,W-M*2,true,13)+4;y+=textLines(report.title,M,y,W-M*2,true,17)+6;ctx.fillStyle='#526378';y+=textLines(`${report.rows.length} records | ${report.source_count} sources | ${report.currency} | Generated ${report.generated_at.slice(0,16).replace('T',' ')} UTC`,M,y,W-M*2,false,8)+8;};
 const flush=async()=>{if(!canvas)return;const data=canvas.toDataURL('image/png');const png=await doc.embedPng(data);const page=doc.addPage([W,H]);page.drawImage(png,{x:0,y:0,width:W,height:H});pageNo++;canvas=null;if(pageNo%5===0)await new Promise(resolve=>setTimeout(resolve,0));};
 start();
 // Filter details have their own flowing block so long multi-selects cannot overlap.
 font();const filterLines=wrap('Filters: '+filterDescription(report),W-M*2);for(const value of filterLines){if(y+line>BOTTOM){await flush();start();}ctx.fillText(value,M,y);y+=line;}y+=12;
 const columns=report.columns,sets=[];if(columns.length<=6)sets.push(columns);else {const rest=columns.filter(([k])=>k!=='id');for(let i=0;i<rest.length;i+=5)sets.push([['id','Record'],...rest.slice(i,i+5)]);}
 for(const section of report.sections){
  for(let band=0;band<sets.length;band++){
   const cols=sets[band],widths=cols.map(([k])=>k==='title'||k==='notes'?2:k==='id'||k==='date'?1.1:1.3),total=widths.reduce((a,b)=>a+b,0);for(let i=0;i<widths.length;i++)widths[i]=widths[i]/total*(W-M*2);
   const heading=()=>{ctx.fillStyle='#163a65';font(true,11);y+=textLines(section.title+(sets.length>1?` - columns ${band+1}/${sets.length}`:''),M,y,W-M*2,true,11)+3;ctx.fillStyle='#526378';y+=textLines(`Date field: ${section.dateLabel} | ${section.rows.length} records`+(section.total_cents!==null?' | Amount: '+formatted({amount_cents:section.total_cents},'amount_cents',report.currency):'')+(section.total_minutes!==null?' | Time: '+formatted({minutes:section.total_minutes},'minutes',report.currency):''),M,y,W-M*2,false,8)+6;let x=M;const heights=cols.map(([,l],i)=>{font(true);return wrap(l,widths[i]-12).length*line;});const height=Math.max(...heights)+12;ctx.fillStyle='#eaf0f7';ctx.fillRect(M,y,W-M*2,height);ctx.fillStyle='#183650';for(let i=0;i<cols.length;i++){textLines(cols[i][1],x+6,y+6,widths[i]-12,true);x+=widths[i];}y+=height;};
   if(y+105>BOTTOM){await flush();start();}heading();
   if(!section.rows.length){ctx.fillStyle='#526378';y+=textLines('No records match these filters.',M+6,y+9,W-M*2)+20;}
   for(let index=0;index<section.rows.length;index++){
    const row=section.rows[index];font();const cells=cols.map(([k],i)=>wrap(formatted(row,k,report.currency),widths[i]-12)),length=Math.max(...cells.map(c=>c.length));let offset=0;
    while(offset<length){
     let capacity=Math.floor((BOTTOM-y-12)/line);if(capacity<1){await flush();start();heading();capacity=Math.floor((BOTTOM-y-12)/line);}
     const take=Math.min(capacity,length-offset),height=take*line+12;ctx.fillStyle=index%2?'#f6f8fb':'#ffffff';ctx.fillRect(M,y,W-M*2,height);ctx.fillStyle='#27364a';font();let x=M;
     for(let c=0;c<cells.length;c++){if(offset>0&&cols[c][0]==='id'){textLines(row.id+' (continued)',x+6,y+6,widths[c]-12);}else for(let l=0;l<take;l++)if(cells[c][offset+l]!==undefined)ctx.fillText(cells[c][offset+l],x+6,y+6+l*line);x+=widths[c];}
     ctx.strokeStyle='#dde4ef';ctx.beginPath();ctx.moveTo(M,y+height);ctx.lineTo(W-M,y+height);ctx.stroke();y+=height;offset+=take;
     if(offset<length){await flush();start();heading();}
    }
   }y+=18;
  }
 }
 if(y+35>BOTTOM){await flush();start();}ctx.fillStyle='#526378';textLines('Amounts are totaled within each data source. Do not add different lifecycle stages together; the same transaction can appear in several sources.',M,y,W-M*2,false,8);await flush();
 const footer=await doc.embedFont(StandardFonts.Helvetica);doc.getPages().forEach((p,i)=>{p.drawText(`Task Controlling Management | Authorized company report | Page ${i+1} of ${doc.getPageCount()}`,{x:M,y:18,size:8,font:footer,color:rgb(.33,.39,.47)});});
 return doc.save();
}
