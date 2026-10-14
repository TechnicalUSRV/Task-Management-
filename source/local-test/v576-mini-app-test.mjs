// Mini App action regression checks. Temporary data and a local gateway only.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {taskToday,addDays} from './task-domain.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'playwright');
const root=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(tmpdir(),'tcm-v576-mini-')),hub=openCompanies(dir),s=hub.primary;
const gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});
const A=s.access.bootstrap({name:'Mini Administrator',password:'Test-password-2026'}).staff_id;
const cmd=(action,data)=>s.command(action,data,A);
const addUser=(name,role_id)=>{const id=cmd('admin.user.save',{name,password:'Test-password-2026',role_id}).id;return s.get('SELECT staff_id FROM access_users WHERE id=?',id).staff_id;};
const B=addUser('Mini Member','ROLE-MEMBER');
const role=cmd('admin.role.save',{name:'Mini restricted reader',permissions:{'tasks.tasks':['view'],'tasks.workspace':['view'],'tasks.users':['view']}}).id;
const R=addUser('Mini Reader',role);
const token='123456789:AAHtestTokenForTaskManagementChecks00';s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
const signedFor=(staff,id)=>{const user={id,first_name:'Mini'};s.telegram.connectSignedIn(staff,user,id);return signInitData({auth_date:Math.floor(Date.now()/1000),user},token);};
const memberData=signedFor(B,9576001),readerData=signedFor(R,9576002);
const screenshots=process.env.TCM_SCREENSHOTS;if(screenshots)mkdirSync(screenshots,{recursive:true});
let browser,p,base,checks=0,workspace;const errors=[];
const check=async(label,fn)=>{await fn();checks++;console.log('PASS '+label);};
const home=async(data=memberData)=>{await p.goto('about:blank');await p.goto(`${base}/#tgWebAppData=${encodeURIComponent(data)}`);await p.getByRole('button',{name:'Timesheets',exact:true}).waitFor();};
const actions=async()=>{for(const name of ['Request a task','New task','Timesheets']){const button=p.getByRole('button',{name,exact:true});assert.equal(await button.count(),1);assert.ok(await button.isVisible());assert.ok(await button.isEnabled());}};
const shot=async name=>{if(screenshots)await p.screenshot({path:path.join(screenshots,name+'.png'),fullPage:true});};
try{
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${gateway.address().port}/c/default/tg`;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}});p=await context.newPage();p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));await p.route('https://telegram.org/**',r=>r.abort());
 await check('all three actions remain available without a workspace; New Task explains setup',async()=>{
  await home();await actions();await p.getByRole('button',{name:'New task',exact:true}).click();
  await p.getByText('You can’t create tasks in a workspace yet',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Create task',exact:true}).count(),0);assert.equal(s.get('SELECT COUNT(*) n FROM tm_tasks').n,0);
  await p.getByRole('button',{name:'Back',exact:true}).click();await actions();
  await p.getByRole('button',{name:'Tasks',exact:true}).click();await p.getByRole('button',{name:'New task',exact:true}).click();await p.getByText('You can’t create tasks in a workspace yet',{exact:true}).waitFor();
 });
 workspace=cmd('tm.workspace.save',{name:'Mini workspace',owner_id:A,member_ids:[A,B,R]}).id;
 await check('New Task validates expectation, creates a task and persists through reload',async()=>{
  await home();await actions();await p.getByRole('button',{name:'New task',exact:true}).click();
  await p.getByRole('textbox',{name:'Title',exact:true}).fill('Task from restored Mini App action');await p.getByRole('button',{name:'Create task',exact:true}).click();await p.getByText('Expectation is required.',{exact:true}).waitFor();
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_tasks WHERE title='Task from restored Mini App action'").n,0);
  await p.getByRole('textbox',{name:/^Expectation/}).fill('Provide the verified completion report');await p.getByRole('button',{name:'Create task',exact:true}).click();await p.getByRole('heading',{name:'Task from restored Mini App action',exact:true}).waitFor();
  const task=s.get("SELECT * FROM tm_tasks WHERE title='Task from restored Mini App action'");assert.equal(task.workspace_id,workspace);assert.equal(task.pic_id,B);assert.equal(task.description,'Provide the verified completion report');
  await p.reload();await p.getByText('Task from restored Mini App action',{exact:true}).first().waitFor();
 });
 await check('Request Task sends a request through the existing form',async()=>{
  await home();await p.getByRole('button',{name:'Request a task',exact:true}).click();await p.getByRole('textbox',{name:'What do you need?',exact:true}).fill('Request from Mini App action');
  await p.locator('[data-field="manager_id"]').click();await p.getByRole('dialog').getByText('Mini Administrator',{exact:true}).click();
  await p.getByRole('textbox',{name:/^Expectation/}).fill('Confirm the requested delivery date');await p.getByRole('button',{name:'Send request',exact:true}).click();await p.getByRole('button',{name:'Timesheets',exact:true}).waitFor();
  const request=s.get("SELECT * FROM tm_requests WHERE title='Request from Mini App action'");assert.ok(request);assert.equal(request.requested_by,B);assert.equal(request.manager_id,A);
 });
 await check('Timesheet records independent work and retains all three Home actions',async()=>{
  await p.getByRole('button',{name:'Timesheets',exact:true}).click();await p.getByRole('button',{name:'Add time',exact:true}).click();await p.getByRole('textbox',{name:'Activity',exact:true}).fill('Mini App action verification');await p.getByRole('textbox',{name:'Duration (H:MM)',exact:true}).fill('1:45');
  await p.getByRole('button',{name:'Save time',exact:true}).click();await p.getByText('Mini App action verification',{exact:true}).waitFor();
  const entry=s.get("SELECT * FROM tm_timesheets WHERE activity='Mini App action verification'");assert.equal(entry.staff_id,B);assert.equal(entry.minutes,105);assert.equal(entry.task_id,null);
  await home();await actions();
 });
 await check('larger title and all three actions fit phone and tablet widths',async()=>{
  for(const width of [390,320,768]){
   await p.setViewportSize({width,height:844});await actions();
   const brand=await p.locator('.brand-line').evaluate(el=>({size:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight,text:el.textContent,icon:el.querySelector('img').getBoundingClientRect().width}));
   assert.equal(brand.text,'Task Controlling Management');assert.equal(brand.size,'16px');assert.equal(brand.weight,'600');assert.equal(brand.icon,33);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot('v576-mini-home-'+width);
  }
 });
 await check('visible shortcuts preserve role restrictions and backend enforcement',async()=>{
  await home(readerData);await actions();await p.getByRole('button',{name:'New task',exact:true}).click();await p.getByRole('alert').getByText(/does not have permission to create tasks/).waitFor();assert.equal(await p.getByRole('button',{name:'Create task',exact:true}).count(),0);
  await p.getByRole('button',{name:'Back',exact:true}).click();await p.getByRole('button',{name:'Timesheets',exact:true}).click();await p.getByRole('alert').getByText(/does not have permission to view timesheets/).waitFor();assert.equal(await p.getByRole('button',{name:'Add time',exact:true}).count(),0);
  const denied=async(action,data)=>{const res=await context.request.post(base+'/api/command',{headers:{Authorization:'tma '+readerData},data:{action,data}});assert.equal(res.status(),403);};
  await denied('tm.task.save',{workspace_id:workspace,title:'Forbidden task',description:'Must not be created',pic_id:R,reviewer_id:R,start_date:taskToday(),due_date:addDays(taskToday(),1)});
  await denied('tm.time.save',{activity:'Forbidden time',staff_id:R,work_date:taskToday(),duration:'1:00'});
  assert.equal(s.get("SELECT COUNT(*) n FROM tm_tasks WHERE title='Forbidden task'").n,0);assert.equal(s.get("SELECT COUNT(*) n FROM tm_timesheets WHERE activity='Forbidden time'").n,0);
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} Mini App action checks passed; no JavaScript page errors.`);
}catch(e){if(p&&!p.isClosed()){console.error((await p.locator('body').innerText()).slice(-4000));await shot('v576-failure');}throw e;}
finally{await browser?.close();await new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();});hub.close();rmSync(dir,{recursive:true,force:true});}
