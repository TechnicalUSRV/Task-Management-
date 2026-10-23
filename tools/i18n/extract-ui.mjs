/** Enumerate explicit UI translation keys; never scans employee data. */
import ts from '../../source/node_modules/typescript/lib/typescript.js';
import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),keys={};
const domainMaps = new Set('TASK_SECTIONS TASK_STATUS REQUEST_STATUS TASK_SOURCES TASK_REPORTS MONTHLY_REPORTS RECURRENCE RECURRENCE_SHORT ROLE_LABEL CHANGE_STATUS CHANGE_KIND REQUEST_DOER COLUMN_TYPES LEVEL_LABELS'.split(' '));
function scan(file){
 const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const add=n=>{if(n&&ts.isStringLiteralLike(n))(keys[n.text]??=[]).push(path.relative(root,file));};
 const map=n=>{if(n&&ts.isObjectLiteralExpression(n))for(const p of n.properties)if(ts.isPropertyAssignment(p))add(p.initializer);};
 function visit(n){
  if(ts.isCallExpression(n)){
   if(['uiText','t'].includes(n.expression.getText(sf)))add(n.arguments[0]);
   if(n.expression.getText(sf)==='translatedMap')map(n.arguments[0]);
  }
  if(/\/(task|group)-domain\.mjs$/.test(file)&&ts.isVariableDeclaration(n)){
   if(domainMaps.has(n.name.getText(sf)))map(n.initializer);
   if(n.name.getText(sf)==='MONTHLY_CATEGORIES'&&ts.isArrayLiteralExpression(n.initializer))for(const row of n.initializer.elements)if(ts.isArrayLiteralExpression(row))add(row.elements[1]);
  }
  ts.forEachChild(n,visit);
 }
 visit(sf);
}
function walk(dir){for(const entry of fs.readdirSync(dir)){const f=path.join(dir,entry);if(fs.statSync(f).isDirectory()){if(!['node_modules','public','vendor'].includes(entry))walk(f)}else if(/\.(tsx?|mjs)$/.test(f)&&!/(test|server|seed|migration)/.test(entry)&&entry!=='i18n.ts')scan(f)}}
walk(root+'/source/local-test');walk(root+'/source/components');console.log(JSON.stringify(keys));
