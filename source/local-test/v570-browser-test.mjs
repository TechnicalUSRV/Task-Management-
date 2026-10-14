// Optional browser acceptance checks. Runs only against temporary company data.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {taskToday,addDays} from './task-domain.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'playwright');
const root=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(tmpdir(),'tcm-browser-')),hub=openCompanies(dir),s=hub.primary;
const port=4397,base=`http://127.0.0.1:${port}`,server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});
const screenshots=process.env.TCM_SCREENSHOTS||path.join(root,'verification','v5.7.0');mkdirSync(screenshots,{recursive:true});
let browser,p,checks=0;const errors=[],check=async(label,fn)=>{await fn();checks++;console.log('PASS '+label);};
const A=s.access.bootstrap({name:'Huon Sithai',email:'admin@example.test',password:'Test-password-2026',company_name:'Task Controlling Management'}).staff_id;
const cmd=(action,data,actor=A)=>s.command(action,data,actor);
const bid=cmd('admin.user.save',{name:'Team Member',email:'member@example.test',password:'Test-password-2026',role_id:'ROLE-MEMBER'}).id,B=s.get('SELECT staff_id FROM access_users WHERE id=?',bid).staff_id;
const ws=cmd('tm.workspace.save',{name:'Operations',owner_id:A,member_ids:[A,B]}).id;
const task=cmd('tm.task.save',{workspace_id:ws,title:'Browser review task',description:'Provide a checked delivery report',pic_id:A,start_date:taskToday(),due_date:addDays(taskToday(),4)}).id;
const meeting=cmd('tm.meeting.save',{workspace_id:ws,title:'Approval review',organizer_id:A,attendee_ids:[A,B],start_at:new Date(Date.now()+3*86400000).toISOString(),end_at:new Date(Date.now()+3*86400000+3600000).toISOString()}).id;
let m=s.get('SELECT * FROM tm_meetings WHERE id=?',meeting);cmd('tm.meeting.save',{...m,expected_version:m.version,title:'Approved planning meeting'});
const token='123456789:AAHtestTokenForTaskManagementChecks00';s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
const tgUser={id:90001,first_name:'Team'};s.telegram.connectSignedIn(B,tgUser,tgUser.id);const signed=signInitData({auth_date:Math.floor(Date.now()/1000),user:tgUser},token);
try{
 await new Promise(r=>server.listen(port,'127.0.0.1',r));await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:960}});p=await context.newPage();p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
 await check('new logo, username sign-in and unchanged desktop navigation render',async()=>{
  await p.goto(base+'/c/default/#/tasks/workspace');await p.getByRole('textbox',{name:'Username',exact:true}).waitFor();
  await p.screenshot({path:path.join(screenshots,'signin-desktop.png'),fullPage:true});
  assert.ok(await p.locator('img[alt="Task Controlling Management"]').count());assert.equal(await p.title(),'Task Controlling Management');
  await p.getByRole('textbox',{name:'Username',exact:true}).fill('  HUON   Sithai  ');await p.locator('input[type=password]').fill('Test-password-2026');await p.getByRole('button',{name:'Sign in',exact:true}).click();
  await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();await p.screenshot({path:path.join(screenshots,'workspace-desktop.png'),fullPage:true});
 });
 await check('profile username is read-only; nickname saves and renders smaller in the account menu',async()=>{
  await p.getByRole('button',{name:/Account:/}).click();await p.getByRole('menuitem',{name:'My profile',exact:true}).click();const d=p.getByRole('dialog');
  assert.ok(await d.getByRole('textbox',{name:'Username / display name',exact:true}).isDisabled());await d.getByRole('textbox',{name:'Nickname (optional)',exact:true}).fill('Tong');await d.getByRole('button',{name:'Save nickname',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('.user-trigger .identity-nickname')?.textContent==='(Tong)');await p.screenshot({path:path.join(screenshots,'profile-desktop.png'),fullPage:true});await p.keyboard.press('Escape');
 });
 await check('New Task requires expectation and exposes custom recurrence in the existing dialog',async()=>{
  await p.goto(base+'/c/default/#/tasks/tasks');await p.getByRole('button',{name:'New task',exact:true}).first().click();const d=p.getByRole('dialog');
  await d.getByRole('textbox',{name:/^Task title/}).fill('UI recurring task');await d.getByRole('button',{name:'Create task',exact:true}).click();
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_tasks WHERE title='UI recurring task'").n,0);await d.getByText(/Enter expectation/).waitFor();
  await d.getByRole('textbox',{name:/^Expectation/}).fill('Deliver the monthly reconciliation');await d.getByRole('combobox',{name:/^Repeat/}).click();await p.getByRole('option',{name:'Every week',exact:true}).click();await d.getByRole('spinbutton',{name:'Repeat interval',exact:true}).fill('2');
  await d.getByRole('checkbox',{name:'Mon',exact:true}).check();await d.getByRole('checkbox',{name:'Wed',exact:true}).check();await p.screenshot({path:path.join(screenshots,'recurrence-desktop.png'),fullPage:true});
  await d.getByRole('button',{name:'Create task',exact:true}).click();await p.getByRole('heading',{name:'UI recurring task',exact:true}).waitFor();const saved=s.get("SELECT * FROM tm_tasks WHERE title='UI recurring task'");assert.ok(saved);assert.equal(JSON.parse(saved.recurrence_rule).interval,2);
 });
 await check('independent timesheet saves without a task or workspace and displays rolling, week and month totals',async()=>{
  await p.goto(base+'/c/default/#/tasks/timesheets');await p.getByRole('button',{name:'Log time',exact:true}).first().click();const d=p.getByRole('dialog');
  await d.getByRole('textbox',{name:/^Activity/}).fill('Unexpected delivery support');await d.getByRole('textbox',{name:/^Duration/}).fill('1:30');await d.getByRole('button',{name:'Create time entry',exact:true}).click();await d.waitFor({state:'hidden'});
  await p.getByText('Unexpected delivery support',{exact:true}).waitFor();assert.equal(s.get("SELECT task_id FROM tm_timesheets WHERE activity='Unexpected delivery support'").task_id,null);
  assert.equal(await p.locator('.week-table thead .week-date').count(),8);await p.getByRole('combobox',{name:'Period',exact:true}).click();await p.getByRole('option',{name:'Week',exact:true}).click();await p.getByText('Unexpected delivery support',{exact:true}).waitFor();await p.getByRole('combobox',{name:'Period',exact:true}).click();await p.getByRole('option',{name:'Month',exact:true}).click();await p.screenshot({path:path.join(screenshots,'timesheet-desktop.png'),fullPage:true});
 });
 await check('signed Telegram Mini App shows the new logo and approves the shared backend meeting request',async()=>{
  await p.setViewportSize({width:390,height:844});await p.route('https://telegram.org/**',r=>r.abort());await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/?meeting=${meeting}#tgWebAppData=${encodeURIComponent(signed)}`);
  await p.getByRole('heading',{name:'Approval review',exact:true}).waitFor();await p.getByRole('button',{name:'Approve change',exact:true}).click();await p.getByRole('heading',{name:'Approved planning meeting',exact:true}).waitFor();assert.equal(s.get('SELECT title FROM tm_meetings WHERE id=?',meeting).title,'Approved planning meeting');await p.screenshot({path:path.join(screenshots,'meeting-mini.png'),fullPage:true});
 });
 await check('Mini App independent time entry synchronizes and narrow screens avoid horizontal overflow',async()=>{
  await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/#tgWebAppData=${encodeURIComponent(signed)}`);await p.getByRole('button',{name:'Timesheets',exact:true}).click();await p.getByRole('button',{name:'Add time',exact:true}).click();await p.getByRole('textbox',{name:'Activity',exact:true}).fill('Urgent mobile support');await p.getByRole('button',{name:'Save time',exact:true}).click();await p.getByText('Urgent mobile support',{exact:true}).waitFor();assert.ok(s.get("SELECT id FROM tm_timesheets WHERE staff_id=? AND activity='Urgent mobile support'",B));assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await p.screenshot({path:path.join(screenshots,'timesheet-mini.png'),fullPage:true});
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} browser acceptance flows passed; no JavaScript page errors.`);
}catch(e){if(p&&!p.isClosed()){console.error((await p.locator('body').innerText()).slice(-5000));await p.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections?.();});await new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();});hub.close();rmSync(dir,{recursive:true,force:true});}
