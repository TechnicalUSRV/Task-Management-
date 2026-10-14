import { opsToday } from './operations-domain.mjs';

// Called only when creating a new, explicitly labelled sample database.
export function seedOperations(s) {
 const today=opsToday(),later=new Date(Date.parse(today)+30*86400000).toISOString().slice(0,10);
 const act=(a,d,actor)=>s.command(a,d,actor),req=id=>s.operations.request(id);
 const save=(type,d)=>act('ops.save',{type,document_date:today,...d}).id;
 const process=(id,process,actor='STAFF-001')=>act('ops.process',{id,expected_version:req(id).version,process},actor);
 const approve=id=>{process(id,'submit');process(id,'approve','STAFF-002');process(id,'approve','STAFF-003');};
 const charge=(description,price,category='SELLING',size='ALL',basis='SHIPMENT')=>({description,quantity:'1',unit:'service',unit_price:price,discount:'0',percentage_discount:'0',tax_percent:'0',category,container_size:size,rate_basis:basis});
 const contact=s.get('SELECT contact_id FROM accounts ORDER BY created_at LIMIT 1').contact_id;
 const quote=save('QUOTATION',{contact_id:contact,valid_until:later,commodity_type:'GARMENT',commodity:'Sample garment shipment',terms:'Import: SHV port → Phnom Penh',payment_terms:'30 days from Debit Note',notes:'Sample rate card. Container sizes are alternatives.',lines:[charge('Trucking fee','290','SELLING','20FT','CONTAINER'),charge('Trucking fee','350','SELLING','40FT','CONTAINER'),charge('Clearance fee','180'),charge('Handling fee','35'),charge('Customs duty','75','TAX'),charge('Cash disbursement recovery','20','CASH_DISBURSEMENT')]});
 approve(quote);
 for(let n=0;n<2;n++) {
  const po=save('PO',{source_id:quote,booking_confirmed:true,booking_date:today,booking_reference:`Sample customer booking ${n+1}`,consignee:'Mekong warehouse (sample)',service_type:'FCL import clearance and delivery',scope_of_services:'Sample garment cartons; customs clearance, handling and trucking.',quantity:'100',unit:'carton',conditions:'Sample test conditions.'});approve(po);
  const job=save('JOB',{source_id:po,container_size:n?'40FT':'20FT',containers:[`SAMPLE00000${n+1}`],bill_of_lading:`SAMPLE-BL-${n+1}`,eta:later,etd:today,pol_pod:'SHV / Phnom Penh',delivery_place:'Phnom Penh (sample)',gross_weight:'8,000 KG',shipment_type:'Official',ops_notes:'Sample workflow for local testing.',extra_lines:[charge('Additional documentation','30')]});approve(job);
  for(const status of ['ARRIVED_PORT','DELIVERING',...(n===0?['CLOSED']:[])])act('ops.shipment',{id:job,expected_version:s.get('SELECT version FROM ops_jobs WHERE id=?',job).version,status,closed_date:today});
  const dn=save('DN',{source_id:job,due_date:later});approve(dn);
  const pr=save('PR',{source_id:dn,payee:'Example trucking supplier (sample)',supplier_reference:`SAMPLE-BILL-${n+1}`,requested_to:'Operations manager',bank_name:'Demo bank',account_name:'Sample supplier',bank_account:'TEST-ONLY',lines:[charge('Trucking supplier cost',n?'240':'200','COSTING'),charge('Clearance supplier cost','100','COSTING')]});
  if(n===0) {
   approve(pr);
   act('ops.ap.confirm',{id:dn,expected_version:s.get('SELECT version FROM ops_ap WHERE dn_id=?',dn).version,reference:'Sample supplier invoice verified'},'STAFF-003');
   const file=act('ops.file.add',{id:dn,name:'sample-payment-evidence.txt',base64:Buffer.from('SAMPLE ONLY — no actual bank payment.\nEvidence for testing A/F verification.').toString('base64')}).file_id;
   act('ops.af.verify',{id:dn,file_id:file,settlement_date:today,reference:'Sample A/F verified',request_key:'sample-af-v3'},'STAFF-003');
   act('ops.finance.close',{id:dn,closing_date:today},'STAFF-003');
  } else process(pr,'submit');
 }
 const po=save('PO',{source_id:quote,booking_confirmed:true,booking_date:today,booking_reference:'Sample booking awaiting Job File',consignee:'Customer warehouse (sample)',service_type:'FCL import',scope_of_services:'Sample upcoming shipment awaiting an approved Job File.',quantity:'50',unit:'carton'});approve(po);
}
