// Optional browser regression: see FLOW_FIX_REVIEW.md for setup. Never uses company data.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'./source/node_modules/playwright/index.mjs');
const root=path.dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(path.join(tmpdir(),'sunny-reporting-browser-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,wsB,createWorkspace,task}=organizationFixture(s),{A,B,C,D,E,Y}=ids;
const port=4392,base=`http://127.0.0.1:${port}`,token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
const server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});
const screenshots=path.join(root,'verification');mkdirSync(screenshots,{recursive:true});
const errors=[];let browser,checks=0,current;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
 const signed={};for(const [i,[letter,staff]] of Object.entries(ids).entries()){const user={id:8800+i,first_name:letter};s.telegram.connectSignedIn(staff,user,user.id);signed[letter]=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);}
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const page=async(mobile=false)=>{const p=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:960},isMobile:mobile});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));current=p;return p;};
 const web=async(who,route='organization')=>{const p=await page();await p.goto(base+'/c/default/#/tasks/'+route);await p.getByRole('textbox',{name:/Email/}).fill(who.toLowerCase()+'@review.test');await p.locator('input[type=password]').fill('Review-organization-2026');await p.getByRole('button',{name:'Sign in',exact:true}).click();return p;};
 const mini=async(who,query)=>{const p=await page(true);await p.route('https://telegram.org/**',r=>r.abort());await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/?${query}#tgWebAppData=${encodeURIComponent(signed[who])}`);return p;};
 const before={people:s.all('SELECT staff_id,manager_id,org_level FROM tm_profiles ORDER BY staff_id'),audit:s.get('SELECT count(*) n FROM org_audit').n};
 const openReporting=async p=>{await p.getByRole('button',{name:'Table',exact:true}).click();await p.getByRole('button',{name:'C · Review employee',exact:true}).click();await p.getByRole('button',{name:'Change reporting',exact:true}).click();return p.getByRole('dialog',{name:'Reporting relationship',exact:true});};
 const discard=async p=>{const confirm=p.getByRole('dialog',{name:'Discard unsaved changes?',exact:true});await confirm.waitFor();const visible=await confirm.getByRole('button',{name:'Discard changes',exact:true}).evaluate(b=>{const p=b.getBoundingClientRect(),d=b.closest('dialog').getBoundingClientRect();return p.top>=d.top&&p.bottom<=d.bottom&&p.top>=0&&p.bottom<=innerHeight;});assert.equal(visible,true);await confirm.getByRole('button',{name:'Discard changes',exact:true}).click();await confirm.waitFor({state:'hidden'});};
 await check('Unchanged Reporting relationship closes directly with Close and Escape',async()=>{
  const p=await web('B');let d=await openReporting(p);await d.getByRole('button',{name:'Close dialog',exact:true}).click();await d.waitFor({state:'hidden'});await p.getByRole('button',{name:'Change reporting',exact:true}).click();await p.keyboard.press('Escape');await d.waitFor({state:'hidden'});await p.close();
 });
 await check('Cancel on a long dirty form shows a focused discard confirmation even with invalid empty rows',async()=>{
  const p=await web('B'),d=await openReporting(p);for(let i=0;i<5;i++)await d.getByRole('button',{name:'Add related employee change',exact:true}).click();await d.getByRole('textbox',{name:'Reason',exact:true}).fill('Unsaved test reason');await d.getByRole('button',{name:'Cancel',exact:true}).click();
  const confirm=p.getByRole('dialog',{name:'Discard unsaved changes?',exact:true});await confirm.waitFor();assert.equal(await confirm.getByRole('button',{name:'Keep editing',exact:true}).evaluate(x=>x===document.activeElement),true);await p.screenshot({path:path.join(screenshots,'v5.6.5-discard-desktop.png'),fullPage:true});
  await confirm.getByRole('button',{name:'Keep editing',exact:true}).click();assert.equal(await d.getByRole('textbox',{name:'Reason',exact:true}).inputValue(),'Unsaved test reason');assert.equal(await d.getByRole('combobox',{name:/^Employee/}).count(),6);
  await d.getByRole('button',{name:'Cancel',exact:true}).click();await discard(p);await p.close();
 });
 await check('Close and Escape discard edited reporting fields without saving or changing hierarchy',async()=>{
  const p=await web('B'),d=await openReporting(p);await d.getByRole('combobox',{name:/^Organizational level/}).selectOption('4');await d.getByRole('button',{name:'Close dialog',exact:true}).click();await discard(p);
  await p.getByRole('button',{name:'Change reporting',exact:true}).click();assert.equal(await d.getByRole('combobox',{name:/^Organizational level/}).inputValue(),'3');await d.getByRole('textbox',{name:'Reason',exact:true}).fill('Escape this edit');await p.keyboard.press('Escape');await discard(p);await p.close();
 });
 await check('Read-only preview loading does not trap the user in an unsaved form',async()=>{
  const p=await web('B'),d=await openReporting(p);await d.getByRole('textbox',{name:'Reason',exact:true}).fill('Cancel during preview');let release,seen;
  const gate=new Promise(r=>release=r),started=new Promise(r=>seen=r);await p.route('**/api/command',async route=>{if(route.request().postDataJSON().action==='org.preview'){seen();await gate;await route.fulfill({status:200,json:{ok:true,result:{revision:rev(),impact:{employees:[],workspaces:[],grants:[],memberships:[],requests:[]}}}});}else await route.continue();});
  await d.getByRole('button',{name:'Preview affected scope',exact:true}).click();await started;await d.getByRole('button',{name:'Cancel',exact:true}).click();await discard(p);release();await p.unrouteAll({behavior:'wait'});assert.equal(await p.getByRole('dialog').count(),0);await p.close();
 });
 await check('Signed Mini App Back opens a visible discard confirmation and permits leaving an edited form',async()=>{
  const p=await page(true);await p.route('https://telegram.org/**',r=>r.abort());await p.addInitScript(()=>{window.Telegram={WebApp:{ready(){},expand(){},BackButton:{show(){},hide(){},onClick(fn){window.reviewBack=fn;},offClick(){}}}};});
  await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/#tgWebAppData=${encodeURIComponent(signed.B)}`);await p.getByRole('button',{name:'My profile and settings',exact:true}).click();await p.getByRole('button',{name:/Organizational Structure/}).click();
  await p.getByRole('button',{name:'C · Review employee',exact:true}).click();await p.getByRole('button',{name:'Change reporting',exact:true}).click();const d=p.getByRole('dialog',{name:'Reporting relationship',exact:true});for(let i=0;i<3;i++)await d.getByRole('button',{name:'Add related employee change',exact:true}).click();
  await d.getByRole('button',{name:'Cancel',exact:true}).scrollIntoViewIfNeeded();await p.evaluate(()=>window.reviewBack());await p.getByRole('dialog',{name:'Discard unsaved changes?',exact:true}).waitFor();await p.screenshot({path:path.join(screenshots,'v5.6.5-discard-mini.png'),fullPage:true});await discard(p);await p.getByRole('button',{name:'Change reporting',exact:true}).waitFor();await p.close();
 });
 assert.deepEqual(s.all('SELECT staff_id,manager_id,org_level FROM tm_profiles ORDER BY staff_id'),before.people);assert.equal(s.get('SELECT count(*) n FROM org_audit').n,before.audit);
 assert.deepEqual(errors,[]);console.log(`\n${checks} browser flows passed; no JavaScript page errors. Local signed Telegram preview only.`);
}catch(e){if(current&&!current.isClosed()){console.error((await current.locator('body').innerText()).slice(-6000));await current.screenshot({path:path.join(screenshots,'v5.6.5-browser-failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}
