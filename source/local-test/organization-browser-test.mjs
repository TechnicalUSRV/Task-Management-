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
const root=path.dirname(fileURLToPath(import.meta.url)),folder=mkdtempSync(path.join(tmpdir(),'sunny-org-browser-')),hub=openCompanies(folder,{demo:true}),s=hub.primary;
const {ids,cmd,rev,wsB,createWorkspace,task}=organizationFixture(s),{A,B,C,D,E,Y}=ids;
const port=4390,base=`http://127.0.0.1:${port}`,token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
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
 await check('Original desktop organization page renders; active non-Task login can be selected for assignment',async()=>{
  const p=await web('A');await p.getByRole('heading',{name:'Organizational Structure',exact:true}).waitFor();
  await p.getByRole('button',{name:'Table',exact:true}).click();await p.getByRole('button',{name:'C · Review employee',exact:true}).click();
  await p.getByRole('button',{name:'Delegate authority',exact:true}).waitFor();await p.screenshot({path:path.join(screenshots,'v5.6.5-compat-organization-desktop.png'),fullPage:true});
  await p.getByRole('button',{name:'Assign employee',exact:true}).click();await p.getByRole('dialog').getByRole('combobox',{name:/^Employee/}).selectOption(coordinator);
  assert.equal(await p.getByRole('dialog').getByRole('combobox',{name:/^Employee/}).inputValue(),coordinator);await p.close();
 });
 await check('Level 2 employee panel does not offer changes to its Level 1 ancestor',async()=>{
  const p=await web('B');await p.getByRole('button',{name:'Table',exact:true}).click();await p.getByRole('button',{name:'A · Organization administrator',exact:true}).click();
  await p.locator('.org-person-panel h2').filter({hasText:'A · Organization administrator'}).waitFor();assert.equal(await p.getByRole('button',{name:'Change reporting',exact:true}).count(),0);await p.close();
 });
 let request;
 await check('Lower-level delegation form stays within its supporting capabilities and workspace; submission stays pending',async()=>{
  const p=await web('C');await p.getByRole('button',{name:'Table',exact:true}).click();await p.getByRole('button',{name:'D · Review employee',exact:true}).click();await p.getByRole('button',{name:'Delegate authority',exact:true}).click();
  const dialog=p.getByRole('dialog');assert.equal(await dialog.getByRole('combobox',{name:/^Workspace scope/}).inputValue(),wsB);
  assert.equal(await dialog.getByRole('checkbox',{name:'Invite outside task/meeting participants',exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByRole('checkbox',{name:'Invite outside task/meeting participants',exact:true}).isChecked(),false);
  await dialog.getByRole('textbox',{name:'Reason',exact:true}).fill('Browser approved scope regression');await p.screenshot({path:path.join(screenshots,'v5.6.5-compat-delegation-form.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});
  request=s.get("SELECT * FROM org_requests WHERE reason='Browser approved scope regression'");assert.equal(request.status,'PENDING');assert.equal(s.organization.grants(D).length,0);await p.close();
 });
 await check('Mobile signed Mini App reviews and approves the same request; approved capabilities activate once',async()=>{
  const p=await mini('B','org_request='+request.id);await p.getByRole('button',{name:'Review approval',exact:true}).click();
  await p.getByRole('dialog').waitFor();await p.screenshot({path:path.join(screenshots,'v5.6.5-compat-mini-approval.png'),fullPage:true});
  await p.getByRole('button',{name:'Approve request',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});assert.equal(s.get('SELECT status FROM org_requests WHERE id=?',request.id).status,'APPROVED');assert.equal(s.organization.grants(D).length,1);
  await p.getByRole('button',{name:'People',exact:true}).click();await p.getByRole('button',{name:'D · Review employee',exact:true}).waitFor();await p.screenshot({path:path.join(screenshots,'v5.6.5-compat-mini-people.png'),fullPage:true});await p.close();
 });
 await check('Normal Workspace form creates a private workspace when organization-function access is denied',async()=>{
  const p=await web('E','workspace');await p.getByRole('button',{name:'New workspace',exact:true}).first().click();const dialog=p.getByRole('dialog');await dialog.getByRole('textbox',{name:/Workspace name/}).fill('Personal workspace from normal form');await dialog.getByRole('button',{name:'Create workspace',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const w=s.get("SELECT * FROM tm_workspaces WHERE name='Personal workspace from normal form'");assert.equal(w.kind,'PERSONAL');assert.equal(w.owner_id,E);await p.close();
 });
 await check('Outside task participant can open the Mini App edit form with its existing workspace selected',async()=>{
  const p=await mini('Y','task='+t);await p.locator('summary').filter({hasText:'More actions'}).click();await p.getByRole('button',{name:'Edit details',exact:true}).click();const selector=p.getByRole('combobox',{name:/^Workspace/});await selector.waitFor();assert.equal(await selector.inputValue(),wsC);assert.equal(await selector.isDisabled(),true);assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',wsC,Y));await p.screenshot({path:path.join(screenshots,'v5.6.5-compat-mini-outside-task.png'),fullPage:true});await p.close();
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} browser flows passed; no JavaScript page errors. Local signed Telegram preview only.`);
}catch(e){if(current&&!current.isClosed()){console.error((await current.locator('body').innerText()).slice(-6000));await current.screenshot({path:path.join(screenshots,'v5.6.5-compat-browser-failure.png'),fullPage:true});}throw e;}
finally{await browser?.close();await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();rmSync(folder,{recursive:true,force:true});}
