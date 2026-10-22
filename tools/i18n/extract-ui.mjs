/** Enumerate explicit UI translation keys; never scans employee data. */
import ts from '../../source/node_modules/typescript/lib/typescript.js';
import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),keys={};
function scan(file){const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);function visit(n){if(ts.isCallExpression(n)&&['uiText','t'].includes(n.expression.getText(sf))&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))(keys[n.arguments[0].text]??=[]).push(path.relative(root,file));ts.forEachChild(n,visit)}visit(sf)}
function walk(dir){for(const entry of fs.readdirSync(dir)){const f=path.join(dir,entry);if(fs.statSync(f).isDirectory()){if(!['node_modules','public','vendor'].includes(entry))walk(f)}else if(/\.(tsx?|mjs)$/.test(f)&&!/(test|server|seed|migration)/.test(entry)&&entry!=='i18n.ts')scan(f)}}
walk(root+'/source/local-test');walk(root+'/source/components');console.log(JSON.stringify(keys));
