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
const root=path.dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(path.join(tmpdir(),'sunny-workspace-browser-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,wsB,createWorkspace,task}=organizationFixture(s),{A,B,C,D,E,Y}=ids;
const port=4391,base=`http://127.0.0.1:${port}`,token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
const server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});
const screenshots=path.join(root,'verification');mkdirSync(screenshots,{recursive:true});
const errors=[];let browser,checks=0,current;
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 cmd('org.membership.request',{workspace_id:wsB,beneficiary_id:C,reason:'Origin workspace'},B);
 cmd('org.delegation.request',{beneficiary_id:C,workspace_id:wsB,capabilities:['workspace_create','workspace_manage','delegate_request','membership_request'],reason:'Limited scoped browser fixture'},B);
 const wsC=createWorkspace(C,'Separate delivery workspace','ORGANIZATIONAL',{origin_workspace_id:wsB});
 const t=task(B,wsC,'Outside collaboration review',{pic_id:Y});cmd('tm.task.accept',{id:t},Y);
 const role=cmd('admin.role.save',{name:'Organization coordinator',permissions:{'tasks.organization':['view']}}).id;
 const account=cmd('admin.user.save',{name:'Coordinator without Task access',email:'coordinator@review.test',role_id:role,password:'Review-organization-2026',active:1}).id;
 const coordinator=s.get('SELECT staff_id FROM access_users WHERE id=?',account).staff_id;
 const old=s.access.publicUser(s.access.accountFor(E).id);cmd('admin.user.save',{...old,expected_version:old.version,function_settings:{'tasks.organization':{view:'DENY'}}},A);
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
 const signed={};for(const [i,[letter,staff]] of Object.entries(ids).entries()){const user={id:8800+i,first_name:letter};s.telegram.connectSignedIn(staff,user,user.id);signed[letter]=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);}
 await new Promise((r,e)=>{server.once('error',e);server.listen(port,'127.0.0.1',r);});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const page=async(mobile=false)=>{const p=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:960},isMobile:mobile});p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));current=p;return p;};
 const web=async(who,route='organization')=>{const p=await page();await p.goto(base+'/c/default/#/tasks/'+route);await p.getByRole('textbox',{name:/Email/}).fill(who.toLowerCase()+'@review.test');await p.locator('input[type=password]').fill('Review-organization-2026');await p.getByRole('button',{name:'Sign in',exact:true}).click();return p;};
 const mini=async(who,query)=>{const p=await page(true);await p.route('https://telegram.org/**',r=>r.abort());await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/?${query}#tgWebAppData=${encodeURIComponent(signed[who])}`);return p;};
 cmd('org.delegation.request',{beneficiary_id:D,reason:'Managed workspace Owner'},B);
 const wsD=createWorkspace(D,'Dispatch team workspace'),reportTask=task(B,wsD,'Managed dispatch task',{pic_id:E});
 const secret=createWorkspace(E,'Hidden personal workspace','PERSONAL');task(E,secret,'Hidden personal task');
 await check('Owner dashboard keeps its original cards, scopes the Add member picker and immediately records authorized membership',async()=>{
  const p=await web('C','workspace');await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();
  const own=p.getByRole('region',{name:'My Workspaces'});assert.ok(await own.getByText('Separate delivery workspace',{exact:true}).isVisible());
  await own.getByRole('button',{name:'Add member',exact:true}).click();await p.getByRole('dialog').getByRole('button',{name:/^Employee/}).click();
  assert.equal(await p.getByRole('option',{name:/Y · Review employee/}).count(),0);await p.getByRole('option',{name:/D · Review employee/}).click();
  await p.getByRole('textbox',{name:/^Reason/}).fill('Owner adds direct report');await p.getByRole('dialog').getByRole('button',{name:'Add member',exact:true}).click();await p.getByRole('dialog',{name:'Add member to Separate delivery workspace',exact:true}).waitFor({state:'hidden'});
  assert.equal(s.get('SELECT approved_by FROM tm_members WHERE workspace_id=? AND staff_id=?',wsC,D).approved_by,C);
  await p.screenshot({path:path.join(screenshots,'v5.6.4-owner-dashboard.png'),fullPage:true});await p.close();
 });
 await check('Manager filters navigate reporting workspaces and open only permitted tasks',async()=>{
  const p=await web('C','workspace');await p.locator('summary').filter({hasText:'Workspaces Under My Management'}).click();
  const panel=p.locator('.workspace-management');await panel.getByRole('combobox',{name:'Manager',exact:true}).selectOption(D);await panel.getByRole('combobox',{name:'Member',exact:true}).selectOption(D);await panel.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(wsD);
  await panel.getByRole('combobox',{name:'Organizational hierarchy',exact:true}).selectOption('direct');assert.ok(await panel.getByText('No workspaces match this management scope.',{exact:true}).isVisible());
  await panel.getByRole('combobox',{name:'Organizational hierarchy',exact:true}).selectOption('all');await panel.locator('article').waitFor();assert.equal(await panel.locator('article').count(),1);assert.equal(await panel.getByRole('button',{name:/^Edit /}).count(),0);
  assert.equal(await p.getByText('Hidden personal workspace',{exact:true}).count(),0);await p.screenshot({path:path.join(screenshots,'v5.6.4-manager-dashboard.png'),fullPage:true});
  await panel.getByRole('button',{name:'View tasks',exact:true}).click();await p.getByText('Managed dispatch task',{exact:false}).last().waitFor();assert.ok(p.url().includes('/tasks/tasks'));await p.close();
 });
 await check('Workspace creator deletes and restores their own workspace from My Workspaces',async()=>{
  const p=await web('C','workspace');await p.getByRole('button',{name:'Delete Separate delivery workspace',exact:true}).click();await p.getByRole('alertdialog').getByRole('button',{name:'Delete workspace',exact:true}).click();
  await p.getByRole('button',{name:'Delete Separate delivery workspace',exact:true}).waitFor({state:'hidden'});assert.ok(s.get('SELECT deleted_at FROM tm_workspaces WHERE id=?',wsC).deleted_at);
  await p.getByRole('button',{name:'Show deleted',exact:true}).click();await p.getByRole('button',{name:'Restore deleted Separate delivery workspace',exact:true}).click();await p.getByRole('alertdialog').getByRole('button',{name:'Restore workspace',exact:true}).click();
  await p.getByRole('button',{name:'Delete Separate delivery workspace',exact:true}).waitFor();assert.equal(s.get('SELECT deleted_at FROM tm_workspaces WHERE id=?',wsC).deleted_at,null);await p.close();
 });
 await check('Employee with no subordinates has only My Workspaces and retains private workspace access',async()=>{
  const p=await web('E','workspace');await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();assert.equal(await p.locator('summary').filter({hasText:'Workspaces Under My Management'}).count(),0);assert.ok(await p.getByText('Hidden personal workspace',{exact:true}).isVisible());await p.close();
 });
 await check('Signed mobile Mini App uses the same two sections and opens a managed workspace task',async()=>{
  const p=await mini('C','organization=1');
  // The ordinary organization navigation is also available from the home screen.
  await p.getByRole('button',{name:'My profile and settings',exact:true}).click();await p.getByRole('button',{name:/Organizational Structure/}).click();
  await p.getByRole('button',{name:'Workspaces',exact:true}).click();await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();
  await p.locator('summary').filter({hasText:'Workspaces Under My Management'}).click();const panel=p.locator('.workspace-management');await panel.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(wsD);
  await panel.locator('summary').filter({hasText:'View tasks (1)'}).click();await p.screenshot({path:path.join(screenshots,'v5.6.4-mini-manager.png'),fullPage:true});
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.getByRole('button',{name:'Open task',exact:true}).click();await p.getByRole('heading',{name:'Managed dispatch task',exact:true}).waitFor();await p.close();
 });
 await check('Mini App Owner membership form lists only eligible reports and records immediate approval',async()=>{
  const p=await mini('D','organization=1');await p.getByRole('button',{name:'My profile and settings',exact:true}).click();await p.getByRole('button',{name:/Organizational Structure/}).click();
  await p.getByRole('button',{name:'Workspaces',exact:true}).click();const own=p.getByRole('region',{name:'My Workspaces'});await own.getByRole('button',{name:'Add member',exact:true}).click();const dialog=p.getByRole('dialog'),picker=dialog.getByRole('combobox',{name:/^Employee/});assert.ok(!await picker.locator('option').allTextContents().then(v=>v.some(x=>x.includes('Y ·'))));await picker.selectOption(E);await dialog.getByRole('textbox',{name:'Reason',exact:true}).fill('Mini owner adds report');await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(s.get('SELECT approved_by FROM tm_members WHERE workspace_id=? AND staff_id=?',wsD,E).approved_by,D);await p.close();
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} browser flows passed; no JavaScript page errors. Local signed Telegram preview only.`);
}catch(e){if(current&&!current.isClosed()){console.error((await current.locator('body').innerText()).slice(-6000));await current.screenshot({path:path.join(screenshots,'v5.6.4-browser-failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}
