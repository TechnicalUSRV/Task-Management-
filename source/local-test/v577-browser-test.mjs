import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {visibilityFixture} from './v577-fixture.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'playwright');
const root=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(tmpdir(),'tcm-v577-browser-')),hub=openCompanies(dir),s=hub.primary;
const f=visibilityFixture(s),{ids,cmd,grant,personal}=f,port=4393,base=`http://127.0.0.1:${port}`;
const server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')}),screenshots=process.env.TCM_SCREENSHOTS;
const token='123456789:AAHtestTokenForVisibilityTests0000',signed={};let browser,p,checks=0;const errors=[];
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
const shot=async n=>{if(screenshots){mkdirSync(screenshots,{recursive:true});await p.screenshot({path:path.join(screenshots,n+'.png'),fullPage:true});}};
try{
 s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);let n=9577800;
 for(const who of ['A','B']){const user={id:n++,first_name:who};s.telegram.connectSignedIn(ids[who],user,user.id);signed[who]=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);}
 await new Promise(r=>server.listen(port,'127.0.0.1',r));await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const context=await browser.newContext();
 const page=async(width=1440)=>{p=await context.newPage();await p.setViewportSize({width,height:960});p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));return p;};
 const web=async(who,route)=>{await context.clearCookies();await page();await p.goto(base+'/c/default/#/tasks/'+route);await p.getByRole('textbox',{name:'Username',exact:true}).fill('Employee '+who);await p.locator('input[type=password]').fill(f.password);await p.getByRole('button',{name:'Sign in',exact:true}).click();};
 const mini=async who=>{await page(390);await p.route('https://telegram.org/**',r=>r.abort());await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/#tgWebAppData=${encodeURIComponent(signed[who])}`);await p.getByRole('button',{name:'My profile and settings',exact:true}).click();await p.getByRole('button',{name:'Organizational Structure',exact:true}).click();};
 await check('web View-only Level 1 gets the existing hierarchy tree with no management controls',async()=>{
  await web('A','organization');await p.getByRole('heading',{name:'Organizational Structure',exact:true}).waitFor();await p.getByRole('button',{name:'Assign employee',exact:true}).waitFor({state:'hidden'});
  await p.getByRole('button',{name:'People',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Workspaces',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Change reporting',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Delegate authority',exact:true}).count(),0);await shot('v577-web-readonly');await p.close();
 });
 await check('web owner adds a member, sees Public conversion, then removes membership using the existing dialog style',async()=>{
  await web('B','workspace');await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();
  const card=p.locator('article.ws-card').filter({has:p.getByRole('button',{name:'B Personal',exact:true})});await card.getByRole('button',{name:'Add member',exact:true}).click();
  await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByText(/automatically makes this workspace Public/).waitFor();await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('button',{name:/^Employee/}).click();await p.getByRole('option',{name:/Employee D/}).click();await p.getByRole('textbox',{name:/^Reason/}).fill('Browser share');await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('button',{name:'Add member',exact:true}).click();await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).waitFor({state:'hidden'});
  await card.getByText('Public',{exact:true}).waitFor();assert.equal(s.get('SELECT visibility FROM tm_workspaces WHERE id=?',personal).visibility,'PUBLIC');
  await card.getByRole('button',{name:'Remove member',exact:true}).click();await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('button',{name:/^Employee/}).click();await p.getByRole('option',{name:/Employee D/}).click();await p.getByRole('textbox',{name:/^Reason/}).fill('Browser revoke');await shot('v577-web-remove');await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('button',{name:'Remove member',exact:true}).click();await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).waitFor({state:'hidden'});assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',personal,ids.D));await p.close();
 });
 await check('Mini App View-only users can read hierarchy but cannot open management tabs',async()=>{
  await mini('A');await p.getByRole('heading',{name:'Organizational Structure',exact:true}).waitFor();await p.getByRole('button',{name:'People',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Workspaces',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Approvals',exact:true}).count(),0);await shot('v577-mini-readonly');await p.close();
 });
 await check('Mini App Create permission retains management and member removal at phone width',async()=>{
  grant('B',{'tasks.organization':{create:'ALLOW'}});cmd('tm.workspace.member.add',{workspace_id:personal,beneficiary_id:ids.D,reason:'Mini removal fixture'},'B');
  await mini('B');await p.getByRole('heading',{name:'Organizational Structure',exact:true}).waitFor();await p.getByRole('button',{name:'Workspaces',exact:true}).click();
  const card=p.locator('article.org-ws-card').filter({has:p.getByText('B Personal',{exact:true})});await card.getByRole('button',{name:'Remove member',exact:true}).click();
  await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('combobox',{name:/Member to remove/}).selectOption(ids.D);await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('textbox',{name:/^Reason/}).fill('Mini removal');await shot('v577-mini-remove');await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).getByRole('button',{name:'Save',exact:true}).click();await p.getByRole('dialog',{name:/^(Add member to|Remove member from|Remove workspace member)/}).waitFor({state:'hidden'});
  assert.ok(!s.get('SELECT 1 FROM tm_members WHERE workspace_id=? AND staff_id=?',personal,ids.D));assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.setViewportSize({width:320,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot('v577-mini-management-320');await p.close();
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} hierarchy/member browser checks passed; no JavaScript page errors.`);
}catch(e){if(p&&!p.isClosed()){console.error((await p.locator('body').innerText()).slice(-5000));await shot('v577-failure');}throw e;}
finally{await browser?.close();await Promise.all([new Promise(r=>{server.close(r);server.closeAllConnections?.();}),new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();})]);hub.close();rmSync(dir,{recursive:true,force:true});}
