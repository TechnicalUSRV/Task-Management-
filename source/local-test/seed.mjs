import { today, dayOffset } from './service.mjs';
import { seedOperations } from './operations-seed.mjs';
import { seedTasks } from './tasks-seed.mjs';

// Explicit sample data for a new local database only. Never applied to a hosted Site.
export function seedDemo(s) {
  if (s.get('SELECT id FROM company WHERE id=1')) return;
  s.db.exec('BEGIN IMMEDIATE');
  try {
    s.insert('company', { id: 1, name: 'Sunny Logistics', address: 'Phnom Penh, Cambodia', currency: 'USD' });
    const refs = {
      staff: [['STAFF-001','Dara · Sales'],['STAFF-002','Sophea · Sales Manager'],['STAFF-003','Vanna · Director']],
      branch: [['BR-PP','Phnom Penh'],['BR-SR','Siem Reap']],
      opportunity_class: [['OC001','USRV Group'],['OC002','USRV INT.'],['OC003','SUNNY'],['OC004','BB.']],
      contact_class: [['CC001','Corporate'],['CC002','Small business']],
      lead_class: [['LC001','New business'],['LC002','Existing customer']],
      campaign_class: [['MC001','Digital'],['MC002','Referral']],
      partner: [['P001','CF Logistic'],['P002','OLAIR'],['P003','MP LOGISTICS'],['P004','EXCELLENCE LOGISTIC']],
      material: [['SVC-001','Consulting','hour'],['SVC-002','Transport','trip'],['SVC-003','Documentation','service']]
    };
    for (const [kind, rows] of Object.entries(refs)) for (const [id, name, unit = ''] of rows) s.insert('lookups', { id, kind, name, unit });
    s.insert('sequences', { kind: 'staff', value: 3 });
    s.insert('approval_steps', { step: 1, approver_id: 'STAFF-002' });
    s.insert('approval_steps', { step: 2, approver_id: 'STAFF-003' });
    s.db.exec('COMMIT');
  } catch (e) { s.db.exec('ROLLBACK'); throw e; }
  const act = (action, d, actor) => s.command(action, d, actor);
  const people = [['Lina','Sok','Mekong Supply (sample)','Referral'],['Dara','Chan','Lotus Retail (sample)','Website'],['Maly','Chea','Angkor Services (sample)','Campaign'],['Sokha','Lim','River Trading (sample)','Referral'],['Nita','Keo','Horizon Foods (sample)','Website']];
  const contacts = people.map(([first_name,last_name,customer_name,source],i) => act('contact.save',{first_name,last_name,customer_name,source,phone:`012 555 10${i}`,email:`customer${i+1}@example.com`,address:'Phnom Penh',owner_id:i%2?'STAFF-002':'STAFF-001',class_id:'CC001'}).id);
  const camp = act('campaign.save',{name:'September customer outreach',class_id:'MC001',audience:'Local businesses',description:'Sample campaign for testing inquiry capture.',start_date:dayOffset(-12),end_date:dayOffset(20),budget:'350',status:'ACTIVE'}).id;
  act('campaign.generate',{id:camp,contact_ids:contacts.slice(0,4)});
  const lines = (n=1) => [{material_id:'SVC-001',description:'Service consultation',unit:'hour',quantity:String(n*10),unit_price:'45.00',discount:'0',percentage_discount:'5',tax_percent:'10'}, {material_id:'SVC-003',description:'Business documentation',unit:'service',quantity:'1',unit_price:'120.00',discount:'0',percentage_discount:'0',tax_percent:'10'}];
  const opportunities=[];
  for(let i=0;i<4;i++) {
    const lead=s.get('SELECT * FROM leads WHERE contact_id=?',contacts[i]);
    act('lead.save',{...lead,expected_version:lead.version,status:'QUALIFIED'});
    const opp=act('opportunity.save',{contact_id:contacts[i],lead_id:lead.id,title:['Annual service package','Retail expansion support','Regional documentation','Delivery coordination'][i],branch_id:i===2?'BR-SR':'BR-PP',class_id:['OC001','OC002','OC003','OC004'][i],owner_id:lead.owner_id,partner_id:'P001',estimation:dayOffset(i*5+3),probability:60,costing:'180',commission:'25',payment_received:'0',lines:lines(i+1),notes:'Sample opportunity. You can edit open deals.'}).id;
    opportunities.push(opp);
  }
  act('opportunity.close',{id:opportunities[3],expected_version:0,status:'LOST',reason:'Customer postponed the project.'});
  for(let i=0;i<2;i++) {
    act('opportunity.close',{id:opportunities[i],expected_version:0,status:'WON'});
    const qid=act('quotation.create',{opportunity_id:opportunities[i]}).id;
    const process=(verb,actor='STAFF-001')=>act('quotation.process',{id:qid,expected_version:s.record('quotation',qid).version,process:verb},actor);
    if(i===0) {
      process('submit');process('approve','STAFF-002');process('approve','STAFF-003');process('accept');
      const order=act('order.create',{quotation_id:qid}).id;
      act('order.ship',{id:order,expected_version:0,reference:'Sample delivery confirmation',shipment_date:today()});
      act('order.invoice',{id:order,expected_version:1,invoice_date:today(),due_date:dayOffset(30)});
      const invoice=s.get('SELECT * FROM invoices WHERE order_id=?',order);
      act('payment.record',{invoice_id:invoice.id,amount:'100',payment_date:today(),reference:'Sample deposit',request_key:'seed-payment-001'});
    } else process('submit');
  }
  const account=s.get('SELECT * FROM accounts LIMIT 1');
  for(const [i,p] of [{parent_type:'CONTACT',parent_id:contacts[4],type:'FOLLOWUP',subject:'Discuss the new inquiry',channel:'CALL'},{parent_type:'OPPORTUNITY',parent_id:opportunities[2],type:'OPPORTUNITY',subject:'Review service requirements',channel:'MEETING'},{parent_type:'ACCOUNT',parent_id:account.id,type:'AFTER SALE',subject:'Customer service check-in',channel:'CALL',forecast:'250'},{parent_type:'TASK',type:'FOLLOWUP',subject:'Prepare weekly sales review',channel:'TASK'}].entries()) {
    act('activity.save',{...p,start_at:`${dayOffset(i-1)}T09:00:00+07:00`,branch_id:'BR-PP',assigned_to:'STAFF-001',priority:i===0?'HIGH':'MEDIUM',summary:'Sample activity for the local test.'});
  }
  seedOperations(s);
  seedTasks(s);
}
