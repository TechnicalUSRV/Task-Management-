// Opt-in isolated review launcher. Never used by server.mjs or a migration.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCompanies} from './company-hub.mjs';
import {createLocalServer} from './server.mjs';
import {createTelegramGateway,signInitData} from './telegram-gateway.mjs';
import {organizationFixture} from './organization-fixture.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export async function startOrganizationReview({port=4380,miniPort=4381,log=console.log}={}){
 const folder=path.join(root,'review-data'),marker=path.join(folder,'organization-review.json');
 const hub=openCompanies(folder,{demo:true}),s=hub.primary;
 let info,server,gateway;
 try{
  if(existsSync(marker))info=JSON.parse(readFileSync(marker,'utf8'));
  else{
   if(s.get('SELECT COUNT(*) n FROM access_users').n)throw Error('The review-data folder contains existing accounts. Choose another extracted copy for isolated review.');
   const {ids,cmd,createWorkspace,task}=organizationFixture(s);
   cmd('org.delegation.request',{beneficiary_id:ids.C,reason:'Review: approved delivery owner'},ids.B);
   const grant=s.organization.grants(ids.C)[0],ws=createWorkspace(ids.C,'Workspace C · Delivery','ORGANIZATIONAL',{joinable:true});
   task(ids.C,ws,'Prepare the client delivery checklist');
   const request=cmd('org.delegation.request',{beneficiary_id:ids.D,parent_grant_id:grant.id,reason:'Review: daily dispatch coordination'},ids.C).id;
   const personal=createWorkspace(ids.E,'E · Personal planning','PERSONAL');task(ids.E,personal,'Personal review note — visible only to E');
   cmd('org.membership.request',{workspace_id:ws,beneficiary_id:ids.Y,reason:'Review: cross-branch project access'},ids.Y);
   s.run("UPDATE company SET name='Task Controlling Management · Organization review' WHERE id=1");
   info={ids,request};writeFileSync(marker,JSON.stringify(info,null,2));
  }
  const token='123456789:AAHtestTokenForSunnyErpLocalChecks00';
  s.run('UPDATE tg_settings SET enabled=1,bot_token=? WHERE id=1',token);
  for(const [i,employee] of Object.values(info.ids).entries())s.telegram.connectSignedIn(employee,{id:8800+i,first_name:Object.keys(info.ids)[i]},8800+i);
  server=createLocalServer(s,port,hub);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  gateway=createTelegramGateway({companies:hub,publicDir:path.join(root,'public')});await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(miniPort,'127.0.0.1',resolve);});
  const miniLinks={};
  for(const [i,letter] of Object.keys(info.ids).entries()){
   const init=signInitData({auth_date:Math.floor(Date.now()/1000),user:{id:8800+i,first_name:letter}},token);
   miniLinks[letter]=`http://127.0.0.1:${gateway.address().port}/c/default/tg/?org_request=${info.request}#tgWebAppData=${encodeURIComponent(init)}`;
  }
  log(`Task Controlling Management — isolated Organizational Structure review\nERP: http://127.0.0.1:${server.address().port}/c/default/#/tasks/organization\nLogin: a@review.test (Level 1), b@review.test (Level 2), c@review.test (Owner), e@review.test (personal privacy)\nPassword for review accounts: Review-organization-2026\nMini App as B, approving manager:\n${miniLinks.B}\n\nData is in review-data only. No Telegram bot polling or Google sync worker is started.\nThe Mini App link is signed for this local review fixture; restart this launcher if it expires.\nPress Ctrl+C to stop.`);
  let closed=false;const stop=async()=>{if(closed)return;closed=true;await Promise.all([server,gateway].map(x=>new Promise(r=>{x.close(r);x.closeAllConnections?.();})));hub.close();};
  return {hub,server,gateway,miniLinks,stop};
 }catch(e){server?.close();gateway?.close();hub.close();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startOrganizationReview({port:Number(process.env.ERP_ORG_REVIEW_PORT||4380),miniPort:Number(process.env.ERP_ORG_REVIEW_MINI_PORT||4381)})
 .then(app=>{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.stop().then(()=>process.exit(0)));})
 .catch(e=>{console.error(e.message);process.exitCode=1;});
}
