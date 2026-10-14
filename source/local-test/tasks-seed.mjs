import {taskToday,addDays} from './task-domain.mjs';
// Demonstration work only for a brand-new database. Existing local data is never reseeded.
// Tasks are created by the manager (Vanna) and then moved through the workflow by the people doing the work,
// so the sample history, notifications and monthly reports look like real use.
export function seedTasks(s){
 const act=(a,d,actor='STAFF-003')=>s.command(a,d,actor),members=['STAFF-001','STAFF-002','STAFF-003'];
 const profiles=[['STAFF-001','Dara · Sales','Sales executive','Sales'],['STAFF-002','Sophea · Sales Manager','Team lead','Operations'],['STAFF-003','Vanna · Director','Director','Management']];
 for(const [staff_id,name,position,department] of profiles)act('tm.profile.save',{staff_id,name,position,department,email:'',phone:'',active:1});
 const spaces=[['Customer onboarding (sample)','Sales','BLUE','Keep customer follow-ups, handoffs and onboarding connected.'],['Shipment coordination (sample)','Operations','TEAL','Coordinate documentation, shipment updates and customer delivery.'],['Company planning (sample)','Management','PURPLE','Plan team priorities and track shared internal work.']].map(([name,department,color,description])=>act('tm.workspace.save',{name,department,color,description,owner_id:'STAFF-003',member_ids:members}).id);
 const contact=s.get('SELECT id FROM contacts LIMIT 1').id;
 const plan=[
  ['Prepare customer onboarding pack',0,60,2,'STAFF-001',['STAFF-002'],'Sales team prepares the pack; Operations checks delivery details.'],
  ['Confirm consignee details',1,0,3,'STAFF-002',[],'Needed before the shipment documents are issued.'],
  ['Check shipment documentation',1,90,1,'STAFF-001',['STAFF-002'],'Operations reviews all documents before release.'],
  ['Share weekly priorities',2,100,0,'STAFF-003',[],'Management shares priorities with every department.'],
  ['Arrange customer follow-up',0,30,-1,'STAFF-001',[],'Sales follow-up after the onboarding call.'],
  ['Review supplier schedule',1,0,5,'STAFF-002',['STAFF-001'],'Operations and Sales agree the supplier timetable.'],
 ];
 const tasks=plan.map(([title,space,,offset,pic,supporters,note],i)=>act('tm.task.save',{title:title+' (sample)',workspace_id:spaces[space],description:'Sample work for testing the task workflow, progress and time tracking.',start_date:addDays(taskToday(),-3),due_date:addDays(taskToday(),offset),priority:i===4?'HIGH':'MEDIUM',estimate:'4:00',pic_id:pic,supporter_ids:supporters,reviewer_id:'STAFF-003',department_note:note,related_type:space===0?'CONTACT':'',related_id:space===0?contact:'',request_key:'sample-task-'+i,...(i===0?{checklist:['Customer details confirmed','Price list attached','Welcome email drafted']}:{})}).id);
 // The people in charge accept and work on their tasks.
 act('tm.task.accept',{id:tasks[0]},'STAFF-001');
 // Supporting people confirm (V5.3); the supporter of the last sample task has not answered yet.
 act('tm.task.accept',{id:tasks[0]},'STAFF-002');act('tm.task.accept',{id:tasks[2]},'STAFF-002');
 for(const item of s.all('SELECT id FROM tm_checklist WHERE task_id=? ORDER BY position LIMIT 2',tasks[0]))act('tm.check.toggle',{id:item.id,done:true},'STAFF-001');
 act('tm.task.note',{id:tasks[0],note:'Checklist drafted; the welcome email is next.'},'STAFF-001');
 // V5.5: on a task someone else assigned, a new progress figure waits for the assigner, who approves it here.
 const progress=(id,value,by)=>{const r=act('tm.task.progress',{id,progress:value},by);if(r.change_id)act('tm.change.decide',{id:r.change_id,decision:'APPROVE'},'STAFF-003');};
 act('tm.task.accept',{id:tasks[2]},'STAFF-001');progress(tasks[2],90,'STAFF-001');act('tm.task.submit',{id:tasks[2],note:'All documents checked; please review.'},'STAFF-001');
 progress(tasks[3],50,'STAFF-003');act('tm.task.close',{id:tasks[3],note:'Priorities shared with all departments.'},'STAFF-003');
 act('tm.task.accept',{id:tasks[4]},'STAFF-001');progress(tasks[4],30,'STAFF-001');act('tm.task.stuck',{id:tasks[4],reason:'Waiting for the customer to confirm a meeting time.'},'STAFF-001');
 act('tm.time.save',{task_id:tasks[0],staff_id:'STAFF-001',work_date:taskToday(),duration:'1:30',notes:'Sample time: prepared customer checklist.'});
 act('tm.time.save',{task_id:tasks[2],staff_id:'STAFF-001',work_date:taskToday(),duration:'0:45',notes:'Sample time: reviewed documents.'});
 act('tm.time.save',{task_id:tasks[3],staff_id:'STAFF-003',work_date:addDays(taskToday(),-1),duration:'1:00',notes:'Sample weekly planning.'});
 act('tm.meeting.save',{workspace_id:spaces[1],task_id:tasks[2],title:'Shipment readiness check (sample)',agenda:'Review missing documents, delivery dates and next actions.',organizer_id:'STAFF-002',attendee_ids:members,start_at:addDays(taskToday(),1)+'T09:00:00+07:00',end_at:addDays(taskToday(),1)+'T09:45:00+07:00',location:'Meeting room 1',url:'',status:'SCHEDULED',request_key:'sample-meeting-1'});
 // V5.4 Groups: the “Operational Tracking” example for development and testing. It is created only with the other sample
 // data of a brand-new local database, never added to an existing database.
 s.tasks.groups.asSystem(()=>{
  const g=act('tm.group.save',{workspace_id:spaces[1],name:'Operational Tracking',description:'Sample group: purchases with quantities, prices and two formulas.',visibility:'TEAM',audience:'WORKSPACE',workspace_level:'EDIT'}).id;
  const item=s.get("SELECT id FROM tm_board_columns WHERE board_id=? AND name='Item'",g).id,col=(name,type,settings={})=>act('tm.group.column.save',{group_id:g,name,type,settings}).id;
  const qty=col('Quantity','NUMBER'),price=col('Unit Price','NUMBER');col('Subtotal','FORMULA',{expression:'={Quantity} * {Unit Price}'});
  const discount=col('Discount','NUMBER');col('Net Amount','FORMULA',{expression:'={Subtotal} - {Discount}'});
  const day=col('Date','DATE'),status=col('Status','STATUS'),pic=col('In Charge','IN_CHARGE'),sup=col('Support','SUPPORT');
  const inProgress=JSON.parse(s.get('SELECT settings_json FROM tm_board_columns WHERE id=?',status).settings_json).labels.find(l=>l.name==='In Progress').id;
  act('tm.group.row.add',{group_id:g,values:{[item]:'Office supplies',[qty]:10,[price]:5,[discount]:5,[day]:'2026-10-01',[status]:inProgress,[pic]:'STAFF-001',[sup]:['STAFF-002']}});
 });
 act('tm.meeting.save',{workspace_id:spaces[2],task_id:tasks[3],title:'Weekly planning recap (sample)',agenda:'Confirm the team’s priorities.',organizer_id:'STAFF-003',attendee_ids:members,start_at:addDays(taskToday(),-1)+'T10:00:00+07:00',end_at:addDays(taskToday(),-1)+'T11:00:00+07:00',location:'Office',status:'COMPLETED',minutes_notes:'Sample decision: assign one owner for each customer handoff.',request_key:'sample-meeting-2'});
}
