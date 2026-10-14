// Focused acceptance coverage for sign-in, setup and contact-email changes.
// Runs only against temporary data; screenshots are opt-in inspection artifacts.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
const {chromium}=await import(process.env.SUNNY_PLAYWRIGHT_MODULE||'playwright');
const root=path.dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(path.join(tmpdir(),'tcm-v571-browser-')),hub=openCompanies(dir),s=hub.primary;
const port=4398,base=`http://127.0.0.1:${port}`,server=createLocalServer(s,port,hub),gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});
const screenshots=process.env.TCM_SCREENSHOTS;if(screenshots)mkdirSync(screenshots,{recursive:true});
const password='Test-password-2026',errors=[];let browser,p,checks=0,setupBody;
const check=async(label,fn)=>{await fn();checks++;console.log('PASS '+label);};
const screenshot=async name=>{if(screenshots)await p.screenshot({path:path.join(screenshots,name+'.png'),fullPage:true});};
const signOut=async()=>{await p.getByRole('button',{name:/Account:/}).click();await p.getByRole('menuitem',{name:'Sign out',exact:true}).click();await p.getByRole('heading',{name:'Sign in',exact:true}).waitFor();};
const wholeLogo=async selector=>{
 const logo=await p.locator(selector).evaluate(async img=>{
  await img.decode();const box=img.getBoundingClientRect(),style=getComputedStyle(img),parent=img.parentElement.getBoundingClientRect();
  return {alt:img.alt,src:img.currentSrc,natural:[img.naturalWidth,img.naturalHeight],width:box.width,height:box.height,parentWidth:parent.width,background:style.backgroundColor,border:style.borderTopWidth,shadow:style.boxShadow,radius:style.borderRadius,fit:style.objectFit};
 });
 assert.equal(logo.alt,'Task Controlling Management');assert.match(logo.src,/\.png$/);assert.deepEqual(logo.natural,[2048,682]);
 assert.ok(logo.width>0&&logo.width<=logo.parentWidth+1);assert.ok(Math.abs(logo.width/logo.height-2048/682)<0.01);
 assert.equal(logo.background,'rgba(0, 0, 0, 0)');assert.equal(logo.border,'0px');assert.equal(logo.shadow,'none');assert.equal(logo.radius,'0px');assert.equal(logo.fit,'contain');
 return logo;
};
const iconLogo=async(selector,width)=>{
 const logo=await p.locator(selector).evaluate(async img=>{await img.decode();const box=img.getBoundingClientRect(),style=getComputedStyle(img);return {src:img.currentSrc,width:box.width,height:box.height,background:style.backgroundColor,border:style.borderTopWidth,shadow:style.boxShadow};});
 assert.match(logo.src,/task-controlling-icon-.*\.svg$/);assert.equal(logo.width,width);assert.ok(Math.abs(logo.width/logo.height-450/429)<0.01);
 assert.equal(logo.background,'rgba(0, 0, 0, 0)');assert.equal(logo.border,'0px');assert.equal(logo.shadow,'none');
};
try{
 await new Promise(r=>server.listen(port,'127.0.0.1',r));await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--no-zygote','--single-process','--disable-gpu'],...(process.env.SUNNY_CHROMIUM_PATH?{executablePath:process.env.SUNNY_CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:960}});p=await context.newPage();p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));
 p.on('request',r=>{if(r.url().endsWith('/api/auth/setup'))setupBody=r.postDataJSON();});
 await check('complete transparent PNG contains the logo and title with no added frame',async()=>{
  await p.goto(base+'/c/default/#/tasks/workspace');await p.getByRole('heading',{name:'Create the administrator',exact:true}).waitFor();
  const branding=await p.evaluate(async()=>{
   const title=document.querySelector('.auth-title'),brand=document.querySelector('.auth-brand'),pitch=document.querySelector('.auth-pitch'),logo=document.querySelector('.auth-logo');await logo.decode();
   const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=682;const ctx=canvas.getContext('2d');ctx.drawImage(logo,0,0);
   return {title:title.textContent,titleBackground:getComputedStyle(title).backgroundColor,brandBackground:getComputedStyle(brand).backgroundColor,gap:pitch.getBoundingClientRect().top-brand.getBoundingClientRect().bottom,alpha:ctx.getImageData(0,0,1,1).data[3],paperAlpha:ctx.getImageData(150,300,1,1).data[3],aside:getComputedStyle(document.querySelector('.auth-aside')).backgroundColor};
  });
  assert.equal(branding.title,'');assert.equal(await p.getByRole('heading',{name:'Task Controlling Management',exact:true}).count(),1);assert.equal(branding.titleBackground,'rgba(0, 0, 0, 0)');assert.equal(branding.brandBackground,'rgba(0, 0, 0, 0)');
  await wholeLogo('.auth-logo');assert.ok(branding.gap>=40&&branding.gap<=88);assert.equal(branding.alpha,0);assert.ok(branding.paperAlpha>240);assert.equal(branding.aside,'rgb(15, 29, 61)');
  await screenshot('v571-registration-desktop');
 });
 await check('registration has no Company field and accepts an empty contact email',async()=>{
  assert.equal(await p.getByLabel(/Company/).count(),0);const email=p.getByRole('textbox',{name:'Contact email',exact:true});assert.equal(await email.getAttribute('required'),null);
  await p.getByRole('textbox',{name:'Username',exact:true}).fill('New Administrator');await p.locator('input[type=password]').nth(0).fill(password);await p.locator('input[type=password]').nth(1).fill(password);
  await email.fill('bad-email');await p.getByRole('button',{name:'Create administrator & sign in',exact:true}).click();await p.getByText('Enter a valid contact email.',{exact:true}).waitFor();assert.equal(s.get('SELECT COUNT(*) n FROM access_users').n,0);
  await email.fill('');await p.getByRole('button',{name:'Create administrator & sign in',exact:true}).click();await p.getByRole('heading',{name:'My Workspaces',exact:true}).waitFor();
  assert.equal(s.get('SELECT email FROM access_users').email,'');assert.equal(s.get('SELECT name FROM company').name,'Task Controlling Management');assert.ok(!Object.hasOwn(setupBody,'company_name'));
  await p.goto(base+'/c/default/#/dashboard');await p.locator('.sidebar-brand').waitFor();await iconLogo('.sidebar-brand .usrv-logo',37);assert.equal(await p.locator('.brand-name').innerText(),'Task Controlling Management');assert.equal(await p.locator('.brand-name').evaluate(el=>getComputedStyle(el).fontSize),'13px');assert.equal(await p.locator('.brand-company').count(),0);assert.equal(((await p.locator('body').innerText()).match(/Task Controlling Management/g)||[]).length,1);assert.equal(await p.locator('.company-switch select').inputValue(),'default');await screenshot('v575-dashboard-desktop');
  await p.locator('[data-slot="sidebar-trigger"]').click();await iconLogo('.sidebar-brand .usrv-logo',37);assert.equal(await p.locator('.brand-text').isVisible(),false);await screenshot('v575-dashboard-collapsed');await p.locator('[data-slot="sidebar-trigger"]').click();
  s.run("UPDATE company SET name='Distinct company' WHERE id=1");await p.reload();await p.locator('.brand-company').waitFor();assert.equal(await p.locator('.brand-company').innerText(),'Distinct company');
  s.run("UPDATE company SET name='Task Controlling Management' WHERE id=1");await p.reload();await p.locator('.sidebar-brand').waitFor();assert.equal(await p.locator('.brand-company').count(),0);
 });
 await check('administrator creates multiple users without contact email and invalid email stays editable',async()=>{
  await p.goto(base+'/c/default/#/admin/users');
  for(const name of ['Browser Member','Second Member']){
   await p.getByRole('button',{name:'Create user',exact:true}).click();const d=p.getByRole('dialog'),email=d.getByRole('textbox',{name:'Contact email',exact:true});assert.equal(await email.getAttribute('required'),null);
   await d.getByRole('textbox',{name:'Username',exact:true}).fill(name);await d.locator('input[type=password]').fill(password);
   if(name==='Browser Member'){
    await email.fill('wrong-format');await d.getByRole('button',{name:'Create account',exact:true}).click();await d.getByText('Enter a valid email address.',{exact:true}).first().waitFor();assert.equal(s.get('SELECT COUNT(*) n FROM access_users WHERE username=?',name).n,0);
    await email.fill('');await screenshot('v571-create-user-desktop');
   }
   await d.getByRole('button',{name:'Create account',exact:true}).click();await d.waitFor({state:'hidden'});assert.equal(s.get('SELECT email FROM access_users WHERE username=?',name).email,'');
  }
 });
 await check('existing username/password sign-in remains valid and responsive at desktop and narrow widths',async()=>{
  await signOut();await screenshot('v571-signin-desktop');
  for(const width of [1024,901,768,390,320]){
   await p.setViewportSize({width,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await p.getByRole('heading',{name:'Task Controlling Management',exact:true}).count(),1);
   await wholeLogo('.auth-logo');await screenshot('v571-signin-'+width);
  }
  await p.getByRole('textbox',{name:'Username',exact:true}).fill(' BROWSER   member ');await p.locator('input[type=password]').fill(password);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('button',{name:/Account:/}).waitFor();
  assert.equal(s.get("SELECT role_id FROM access_users WHERE username='Browser Member'").role_id,'ROLE-MEMBER');await signOut();
 });
 await check('Telegram Mini App signs in and connects with an email-free account',async()=>{
  const token='123456789:AAHtestTokenForTaskManagementChecks00';s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
  const user={id:9571001,first_name:'Browser'},signed=signInitData({auth_date:Math.floor(Date.now()/1000),user},token);
  await p.setViewportSize({width:390,height:844});await p.route('https://telegram.org/**',r=>r.abort());await p.goto(`http://127.0.0.1:${gateway.address().port}/c/default/tg/#tgWebAppData=${encodeURIComponent(signed)}`);
  await p.getByRole('textbox',{name:'Username',exact:true}).fill('Browser Member');await p.locator('input[type=password]').fill(password);await p.getByRole('button',{name:'Sign in and connect',exact:true}).click();await p.getByRole('button',{name:'Timesheets',exact:true}).waitFor();
  assert.equal(s.telegram.linkFor(user.id).staff_id,s.get("SELECT staff_id FROM access_users WHERE username='Browser Member'").staff_id);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  for(const width of [390,320,768]){await p.setViewportSize({width,height:844});await iconLogo('.brand-line .usrv-logo',33);assert.equal(await p.locator('.brand-line').innerText(),'Task Controlling Management');assert.equal(await p.locator('.brand-line > span').evaluate(el=>getComputedStyle(el).fontSize),await p.locator('.brand-line').evaluate(el=>getComputedStyle(el).fontSize));assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await screenshot('v575-mini-app-'+width);}
 });
 assert.deepEqual(errors,[]);console.log(`\n${checks} targeted browser acceptance flows passed; no JavaScript page errors.`);
}catch(e){if(p&&!p.isClosed()){console.error((await p.locator('body').innerText()).slice(-4000));await screenshot('v571-failure');}throw e;}
finally{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections?.();});await new Promise(r=>{gateway.close(r);gateway.closeAllConnections?.();});hub.close();rmSync(dir,{recursive:true,force:true});}
