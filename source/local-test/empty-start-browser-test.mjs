import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'./source/node_modules/playwright/index.mjs');
const root=path.dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(path.join(tmpdir(),'sunny-empty-browser-')),hub=openCompanies(folder),s=hub.primary;
const port=4394,server=createLocalServer(s,port,hub),screenshots=path.join(root,'verification');mkdirSync(screenshots,{recursive:true});let browser,p,checks=0;const errors=[];
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});p=await browser.newPage({viewport:{width:1440,height:960}});p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
 await check('Empty first-run setup asks for company and administrator, with no sample staff selection',async()=>{
  await p.goto(`http://127.0.0.1:${port}/c/default/#/dashboard`);await p.getByRole('heading',{name:'Create the administrator',exact:true}).waitFor();assert.equal(await p.getByRole('combobox',{name:/Staff identity/}).count(),0);assert.equal(s.get('SELECT count(*) n FROM lookups').n,0);
  await p.getByRole('textbox',{name:/Company name/}).fill('New Test Company');await p.getByRole('textbox',{name:/Full name/}).fill('First Test Administrator');await p.getByRole('textbox',{name:/Email/}).fill('first@test.example');await p.locator('input[type=password]').nth(0).fill('New-test-password-2026');await p.locator('input[type=password]').nth(1).fill('New-test-password-2026');await p.screenshot({path:path.join(screenshots,'v5.6.5-empty-setup.png'),fullPage:true});
  await p.getByRole('button',{name:'Create administrator & sign in',exact:true}).click();await p.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await p.goto(`http://127.0.0.1:${port}/c/default/#/tasks/workspace`);await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();assert.equal(s.get('SELECT count(*) n FROM access_users').n,1);assert.equal(s.get('SELECT count(*) n FROM tm_workspaces').n,0);assert.equal(s.get('SELECT count(*) n FROM contacts').n,0);
  await p.screenshot({path:path.join(screenshots,'v5.6.5-empty-workspaces.png'),fullPage:true});
 });
 await check('User can enter a new workspace and reload without demo data appearing',async()=>{
  await p.getByRole('button',{name:'New workspace',exact:true}).first().click();const dialog=p.getByRole('dialog');await dialog.getByRole('textbox',{name:/Workspace name/}).fill('First manually entered workspace');await dialog.getByRole('button',{name:'Create workspace',exact:true}).click();await dialog.waitFor({state:'hidden'});await p.getByText('First manually entered workspace',{exact:true}).waitFor();await p.reload();await p.getByText('First manually entered workspace',{exact:true}).waitFor();assert.equal(s.get('SELECT count(*) n FROM tm_workspaces').n,1);assert.equal(s.get('SELECT count(*) n FROM access_users').n,1);assert.equal(s.get('SELECT count(*) n FROM lookups').n,1);assert.equal(s.get('SELECT count(*) n FROM tm_tasks').n,0);
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} empty-start browser flows passed; no JavaScript page errors.`);
}catch(e){if(p&&!p.isClosed()){console.error((await p.locator('body').innerText()).slice(-7000));await p.screenshot({path:path.join(screenshots,'v5.6.5-empty-failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections?.();});hub.close();rmSync(folder,{recursive:true,force:true});}
