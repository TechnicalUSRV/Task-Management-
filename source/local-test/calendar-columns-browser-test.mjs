// Interaction regression in an isolated temporary database; never starts with company data.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';
import {taskToday,addDays} from './task-domain.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'./source/node_modules/playwright/index.mjs');
const root=path.dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(path.join(tmpdir(),'sunny-calendar-columns-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,task,wsB,wsX}=organizationFixture(s),day=addDays(taskToday(),7),empty=addDays(day,1);
const label=d=>new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
// Node and Chromium may format the long date with or without a comma after the weekday.
const named=d=>new RegExp('^'+label(d).replace(/,/g,',?')+'$');
const taskId=task(ids.B,wsB,'Calendar delivery deadline',{due_date:day});
task(ids.X,wsX,'Private branch deadline',{due_date:day});
cmd('tm.meeting.save',{workspace_id:wsB,title:'Morning planning meeting',organizer_id:ids.B,attendee_ids:[ids.B],start_at:day+'T02:00:00Z',end_at:day+'T03:00:00Z',location:'Meeting room 1'},ids.B);
cmd('tm.meeting.save',{workspace_id:wsB,title:'Afternoon delivery meeting',organizer_id:ids.B,attendee_ids:[ids.B],start_at:day+'T07:00:00Z',end_at:day+'T08:00:00Z'},ids.B);
cmd('tm.meeting.save',{workspace_id:wsX,title:'Private branch meeting',organizer_id:ids.X,attendee_ids:[ids.X],start_at:day+'T02:00:00Z',end_at:day+'T03:00:00Z'},ids.X);
for(let i=1;i<=6;i++)cmd('tm.calnote.save',{title:`Planning note ${i}`,body:`Private note details ${i}`,all_day:true,day},ids.B);
cmd('tm.calnote.save',{title:'Another person private note',body:'Hidden',all_day:true,day},ids.X);
cmd('activity.save',{parent_type:'TASK',type:'FOLLOWUP',subject:'Customer follow-up call',branch_id:s.get("SELECT id FROM lookups WHERE kind='branch' AND active=1 LIMIT 1").id,assigned_to:ids.B,start_at:day+'T09:00:00Z',end_at:day+'T09:30:00Z',channel:'CALL'},ids.B);
cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:ids.D,member_role:'VIEWER',reason:'Read-only group access for interaction verification'},ids.B);
const groupId=cmd('tm.group.save',{workspace_id:wsB,name:'Column reorder board',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'VIEW'},ids.B).id;
for(const name of ['Column B','Column C','Column D','Column E','Column F','Column G','Column H','Column I'])cmd('tm.group.column.save',{group_id:groupId,name,type:'TEXT'},ids.B);
const columns=s.all('SELECT id,name,position FROM tm_board_columns WHERE board_id=? ORDER BY position',groupId),original=columns.map(c=>c.name),colIds=columns.map(c=>c.id);
cmd('tm.group.row.add',{group_id:groupId,values:Object.fromEntries(columns.map((c,i)=>[c.id,`Cell value ${i+1}`]))},ids.B);
const initialRows=JSON.stringify(s.all('SELECT * FROM tm_board_rows WHERE board_id=?',groupId));
const port=4395,server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')}),base=`http://127.0.0.1:${port}/c/default/`;
const screenshots=path.join(root,'verification');mkdirSync(screenshots,{recursive:true});let browser,p,current,checks=0;const errors=[];
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const releaseText=/\bV\d+\.\d+\.\d+\b|\bbuild\s+\d|local test build|shared for testing|under construction|development version|testing labels/i;
const cleanText=async page=>assert.doesNotMatch(await page.locator('body').innerText(),releaseText);
try{
 const token='123456789:AAHtestTokenForSunnyErpLocalChecks00';s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);const user={id:8810,first_name:'B'};s.telegram.connectSignedIn(ids.B,user,user.id);const signed=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const page=async(mobile=false)=>{const x=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:960},isMobile:mobile,hasTouch:mobile});x.setDefaultTimeout(10000);x.on('pageerror',e=>errors.push(e.message));current=x;return x;};
 const web=async who=>{const x=await page();await x.goto(base+'#/tasks/calendar');await x.getByRole('button',{name:'Sign in',exact:true}).waitFor();await cleanText(x);await x.getByRole('textbox',{name:/Email/}).fill(who.toLowerCase()+'@review.test');await x.locator('input[type=password]').fill('Review-organization-2026');await x.getByRole('button',{name:'Sign in',exact:true}).click();await x.locator('.cal-month').waitFor();return x;};
 const dayPanel=async(d=day)=>{await p.mouse.move(2,2);await p.locator(`[data-calendar-day="${d}"]`).click({position:{x:15,y:15}});const panel=p.getByRole('dialog',{name:named(d)});await panel.waitFor();return panel;};
 const savedOrder=who=>JSON.parse(s.get('SELECT view_json FROM tm_board_views WHERE board_id=? AND staff_id=?',groupId,ids[who])?.view_json||'{}').order;
 const names=async x=>x.locator('.grid-head-name').allTextContents();
 const head=(x,name)=>x.locator('.grid-head').filter({has:x.locator('.grid-head-name').filter({hasText:new RegExp('^'+name+'$')})});
 const move=async(x,from,to,direction='right')=>{const saved=x.waitForResponse(r=>r.url().endsWith('/api/command')&&r.request().postDataJSON()?.data?.view?.order);const a=await head(x,from).locator('.grid-head-button').boundingBox(),b=await head(x,to).boundingBox();assert.ok(a&&b);await x.mouse.move(a.x+a.width/2,a.y+a.height/2);await x.mouse.down();await x.mouse.move(direction==='right'?b.x+b.width-12:b.x+12,b.y+b.height/2,{steps:12});await x.mouse.up();await saved;};
 const orderIs=async(x,expected)=>{await x.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('.grid-head-name')].map(x=>x.textContent))===JSON.stringify(expected),expected);};
 p=await web('B');await p.locator('.cal-jump input').fill(day);
 await check('Clicking a date lists all daily event types with details, scrolls, and respects visibility',async()=>{
  for(const d of [day,empty,addDays(day,2),day])await p.locator(`[data-calendar-day="${d}"]`).hover({position:{x:15,y:15}});assert.equal(await p.locator('.day-preview').count(),0);
  const panel=await dayPanel();assert.equal(await panel.locator('.day-preview-list button').count(),10);await panel.getByText('Customer follow-up call',{exact:true}).waitFor();assert.match(await panel.innerText(),/Meeting room 1/);assert.doesNotMatch(await panel.innerText(),/Private branch|Another person/);
  const dims=await panel.evaluate(e=>{const r=e.getBoundingClientRect(),l=e.querySelector('.day-preview-list');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:l.scrollHeight>l.clientHeight};});assert.ok(dims.left>=0&&dims.right<=dims.width&&dims.top>=0&&dims.bottom<=dims.height&&dims.scroll);
  await p.mouse.move(2,2);await p.waitForTimeout(350);assert.equal(await panel.isVisible(),true);await p.screenshot({path:path.join(screenshots,'v5.6.7-calendar-preview.png'),fullPage:true});
 });
 await check('Day panels open task, meeting, note, and CRM details through existing screens',async()=>{
  for(const [title,verify] of [['Calendar delivery deadline',async()=>p.getByRole('dialog',{name:'Calendar delivery deadline',exact:true}).waitFor()],['Morning planning meeting',async()=>p.getByRole('dialog',{name:'Edit meeting',exact:true}).waitFor()],['Planning note 6',async()=>p.getByRole('dialog',{name:'Your note',exact:true}).waitFor()],['Customer follow-up call',async()=>p.getByRole('dialog',{name:'Edit activity',exact:true}).waitFor()]]){
   await p.goto(base+'#/tasks/calendar');await p.locator('.cal-jump input').fill(day);const panel=await dayPanel();await panel.getByRole('button',{name:new RegExp(title)}).click();await panel.waitFor({state:'hidden'});await verify();await p.keyboard.press('Escape');
  }
 });
 await check('Empty dates, keyboard entry, Escape, week view and filters preserve calendar navigation',async()=>{
  await p.goto(base+'#/tasks/calendar');await p.locator('.cal-jump input').fill(day);let panel=await dayPanel(empty);await panel.getByText('Nothing planned for this day.',{exact:true}).waitFor();await p.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  const dateButton=p.locator(`[data-calendar-day="${day}"] .cal-day-number`);await dateButton.focus();assert.equal(await p.locator('.day-preview').count(),0);await dateButton.press('Enter');panel=p.getByRole('dialog',{name:named(day)});await panel.waitFor();assert.equal(await panel.evaluate(e=>e.contains(document.activeElement)),true);await p.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  await p.getByRole('button',{name:'Week',exact:true}).click();panel=await dayPanel();assert.equal(await panel.locator('.day-preview-list button').count(),10);await panel.getByRole('button',{name:'Close',exact:true}).click();await panel.waitFor({state:'hidden'});
  await p.getByRole('button',{name:'My notes',exact:true}).click();panel=await dayPanel();assert.equal(await panel.locator('.day-preview-list button').count(),4);await p.keyboard.press('Escape');await p.getByRole('button',{name:'My notes',exact:true}).click();
  await p.getByRole('button',{name:'Month',exact:true}).click();await p.locator(`[data-calendar-day="${day}"] .cal-day-number`).click();await p.getByRole('dialog',{name:named(day)}).waitFor();assert.equal(await p.locator('.cal-month').isVisible(),true);assert.equal(await p.locator('.day-preview').count(),1);await p.getByRole('dialog',{name:named(day)}).getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('button',{name:'Day',exact:true}).click();await p.locator('.cal-day').waitFor();
 });
 await check('Only one clicked day opens at a time; Close, outside click and navigation dismiss it',async()=>{
  await p.getByRole('button',{name:'Month',exact:true}).click();await dayPanel();await p.locator(`[data-calendar-day="${empty}"] .cal-day-number`).click();let panel=p.getByRole('dialog',{name:named(empty)});await panel.waitFor();assert.equal(await p.locator('.day-preview').count(),1);await panel.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await p.locator('.day-preview').count(),0);
  await p.locator(`[data-calendar-day="${empty}"]`).hover();await p.waitForTimeout(250);assert.equal(await p.locator('.day-preview').count(),0);await dayPanel();await p.locator('.cal-title').click();await p.locator('.day-preview').waitFor({state:'hidden'});
  await p.locator(`[data-calendar-day="${day}"] .cal-more`).click();assert.equal(await p.locator('.day-preview-list button').count(),10);await p.getByRole('button',{name:'Next month',exact:true}).click();await p.locator('.day-preview').waitFor({state:'hidden'});
 });
 await check('Sign-in, dashboard and account menu show no build or development labels',async()=>{
  await p.goto(base+'#/dashboard');await p.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();await cleanText(p);await p.getByRole('button',{name:/^Account:/}).click();await p.getByRole('menuitem',{name:'Sign out',exact:true}).waitFor();await cleanText(p);assert.equal(await p.locator('.header-build').count(),0);await p.keyboard.press('Escape');await p.locator('[role=menu]').waitFor({state:'hidden'});
 });
 await p.goto(base+'#/tasks/groups');await p.getByRole('button',{name:'Column reorder board',exact:true}).click();await p.locator('.grid-table').waitFor();
 await check('The entire dragged column follows the cursor, and neighboring columns shift into an insertion gap',async()=>{
  const a=await head(p,'Column D').locator('.grid-head-button').boundingBox(),b=await head(p,'Column B').boundingBox(),c=await head(p,'Column C').boundingBox(),lifted=await head(p,'Column D').boundingBox();
  const cell=p.locator(`.grid-table tbody [data-column-id="${colIds[3]}"]`).first(),cellBefore=await cell.boundingBox();
  await p.mouse.move(a.x+a.width/2,a.y+a.height/2);await p.mouse.down();await p.mouse.move(a.x+a.width/2-30,a.y+a.height/2,{steps:4});
  await p.waitForFunction(id=>getComputedStyle(document.querySelector(`thead [data-column-id="${id}"]`)).transform!=='none',colIds[3]);
  const moved=await head(p,'Column D').boundingBox(),movedCell=await cell.boundingBox();assert.ok(Math.abs((moved.x-lifted.x)+30)<3);assert.ok(Math.abs(moved.x-movedCell.x)<2);assert.ok(Math.abs((movedCell.x-cellBefore.x)+30)<3);
  await p.mouse.move(b.x+10,a.y+a.height/2,{steps:16});await p.waitForTimeout(220);
  assert.ok(Math.abs((await head(p,'Column B').boundingBox()).x-b.x-lifted.width)<3);assert.ok(Math.abs((await head(p,'Column C').boundingBox()).x-c.x-lifted.width)<3);assert.ok(Math.abs((await p.locator('.column-drop-slot').boundingBox()).x-b.x)<3);assert.deepEqual(await names(p),original);assert.equal(savedOrder('B'),undefined);
  await p.screenshot({path:path.join(screenshots,'v5.6.7-column-moving.png'),fullPage:true});
  const saved=p.waitForResponse(r=>r.url().endsWith('/api/command')&&r.request().postDataJSON()?.data?.view?.order);await p.mouse.up();await saved;await orderIs(p,['Item','Column D','Column B','Column C',...original.slice(4)]);
  assert.equal(await p.locator('.column-drop-slot').count(),0);assert.equal(JSON.stringify(s.all('SELECT * FROM tm_board_rows WHERE board_id=?',groupId)),initialRows);await move(p,'Column D','Column C');await orderIs(p,original);
 });
 await check('Drag full column headers in either direction, persist across reload, and retain cell data',async()=>{
  await move(p,'Item','Column C');const reordered=['Column B','Column C','Item',...original.slice(3)];await orderIs(p,reordered);
  assert.deepEqual(savedOrder('B'),[colIds[1],colIds[2],colIds[0],...colIds.slice(3)]);assert.equal(await p.getByRole('menu').count(),0);await p.reload();await orderIs(p,reordered);assert.deepEqual(await p.locator('.grid-table tbody tr').first().locator('.cell-text').allTextContents(),['Cell value 2','Cell value 3','Cell value 1',...original.slice(3).map((_,i)=>`Cell value ${i+4}`)]);
  assert.equal(JSON.stringify(s.all('SELECT * FROM tm_board_rows WHERE board_id=?',groupId)),initialRows);await move(p,'Item','Column B','left');await orderIs(p,original);
 });
 await check('Column menus, resizing, keyboard reorder and cancelled drags remain usable',async()=>{
  await head(p,'Column B').locator('.grid-head-button').click();await p.getByRole('menuitem',{name:'Sort ascending',exact:true}).waitFor();assert.equal(await p.getByRole('menuitem',{name:/Move Left|Move Right/i}).count(),0);await p.keyboard.press('Escape');
  const resize=head(p,'Column B').getByRole('separator'),before=Number(await resize.getAttribute('aria-valuenow'));await resize.focus();await resize.press('ArrowRight');assert.equal(Number(await resize.getAttribute('aria-valuenow')),before+10);
  const grip=head(p,'Column B').getByRole('button',{name:'Move column Column B',exact:true});await grip.focus();await grip.press('ArrowRight');await orderIs(p,['Item','Column C','Column B',...original.slice(3)]);await grip.press('ArrowLeft');await orderIs(p,original);
  const a=await head(p,'Item').locator('.grid-head-button').boundingBox();await p.mouse.move(a.x+40,a.y+20);await p.mouse.down();await p.mouse.move(a.x+430,a.y+20,{steps:8});await p.keyboard.press('Escape');await p.mouse.up();await orderIs(p,original);assert.equal(await p.locator('.grid-head.is-dragging').count(),0);assert.equal(await p.locator('.column-drop-slot').count(),0);assert.equal(await p.locator('[data-column-id]').evaluateAll(elements=>elements.every(e=>getComputedStyle(e).transform==='none')),true);
 });
 await check('Holding a dragged header at either edge scrolls to the first and last columns',async()=>{
  const wrap=p.locator('.grid-wrap'),box=await wrap.boundingBox(),a=await head(p,'Item').locator('.grid-head-button').boundingBox();await p.mouse.move(a.x+40,a.y+20);await p.mouse.down();await p.mouse.move(box.x+box.width-10,a.y+20,{steps:10});
  await p.waitForFunction(()=>{const w=document.querySelector('.grid-wrap');return w.scrollLeft+w.clientWidth>=w.scrollWidth-2;});await p.mouse.up();await orderIs(p,[...original.slice(1),'Item']);await p.screenshot({path:path.join(screenshots,'v5.6.7-column-reorder.png'),fullPage:true});
  const last=await head(p,'Item').locator('.grid-head-button').boundingBox();await p.mouse.move(last.x+last.width/2,last.y+20);await p.mouse.down();await p.mouse.move(box.x+70,last.y+20,{steps:10});await p.waitForFunction(()=>document.querySelector('.grid-wrap').scrollLeft===0);await p.mouse.up();await orderIs(p,original);
 });
 await check('Hidden columns keep their position and a failed reorder restores the saved order',async()=>{
  await head(p,'Column B').locator('.grid-head-button').click();await p.getByRole('menuitem',{name:'Hide in my view',exact:true}).click();await orderIs(p,original.filter(n=>n!=='Column B'));await move(p,'Item','Column C');await orderIs(p,['Column C','Item',...original.slice(3)]);
  await p.getByRole('button',{name:'1 column hidden in your view (show)',exact:true}).click();await orderIs(p,['Column C','Column B','Item',...original.slice(3)]);
  const before=await names(p);await p.route('**/api/command',route=>route.request().postDataJSON().action==='tm.group.view.save'?route.fulfill({status:503,json:{error:'Connection interrupted. Please try again.'}}):route.continue());await move(p,'Item','Column C','left');await p.getByText('Connection interrupted. Please try again.',{exact:true}).waitFor();await orderIs(p,before);await p.unroute('**/api/command');
 });
 await check('A read-only member can arrange their own view without changing shared structure or editing data',async()=>{
  const viewer=await web('D');await viewer.goto(base+'#/tasks/groups');await viewer.getByRole('button',{name:'Column reorder board',exact:true}).click();await viewer.locator('.grid-table').waitFor();await move(viewer,'Item','Column C');await orderIs(viewer,['Column B','Column C','Item',...original.slice(3)]);
  await head(viewer,'Item').locator('.grid-head-button').click();assert.equal(await viewer.getByRole('menuitem',{name:'Rename or change column…',exact:true}).count(),0);assert.deepEqual(s.all('SELECT id,name,position FROM tm_board_columns WHERE board_id=? ORDER BY position',groupId),columns);assert.equal(JSON.stringify(s.all('SELECT * FROM tm_board_rows WHERE board_id=?',groupId)),initialRows);await viewer.close();current=p;
 });
 await check('Mini App ignores hover, opens one day panel on tap, closes it, and opens event details',async()=>{
  const mini=await page(true);await mini.route('https://telegram.org/**',r=>r.abort());await mini.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/#tgWebAppData=${encodeURIComponent(signed)}`);await mini.getByRole('button',{name:'Calendar',exact:true}).click();
  const target=mini.locator(`[data-day="${day}"]`);if(!await target.count())await mini.getByRole('button',{name:'Next month',exact:true}).click();await target.hover();assert.equal(await mini.locator('.day-preview').count(),0);await target.tap();const panel=mini.locator('.day-preview');await panel.waitFor();assert.equal(await panel.locator('.cal-row').count(),9);await panel.getByRole('button',{name:/Calendar delivery deadline/}).click();await mini.getByRole('heading',{name:'Calendar delivery deadline',exact:true}).waitFor();await mini.getByRole('button',{name:'Back',exact:true}).click();
  await target.tap();await panel.waitFor();assert.equal(await target.getAttribute('aria-pressed'),'true');await panel.getByRole('button',{name:'Close',exact:true}).tap();await panel.waitFor({state:'hidden'});await target.hover();assert.equal(await mini.locator('.day-preview').count(),0);await mini.getByRole('button',{name:'Home',exact:true}).click();await mini.getByRole('button',{name:'My profile and settings',exact:true}).click();await cleanText(mini);await mini.close();
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} calendar, column, and presentation browser flows passed; no JavaScript page errors.`);
}catch(e){if(current&&!current.isClosed()){console.error((await current.locator('body').innerText()).slice(-6500));await current.screenshot({path:path.join(screenshots,'v5.6.7-browser-failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}
