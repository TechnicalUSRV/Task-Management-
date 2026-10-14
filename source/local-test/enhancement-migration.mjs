export function migrateEnhancements({db,get,all,run}) {
 if(get('SELECT version FROM schema_version WHERE version=16'))return;
 db.exec('BEGIN IMMEDIATE');
 try {
  if(!all('PRAGMA table_info(tm_tasks)').some(c=>c.name==='recurrence_rule'))run("ALTER TABLE tm_tasks ADD COLUMN recurrence_rule TEXT NOT NULL DEFAULT '{}'");
  if(!all('PRAGMA table_info(tm_profiles)').some(c=>c.name==='nickname'))run("ALTER TABLE tm_profiles ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
  // Rebuild only this leaf table to make task_id optional; preserve every old row and its IDs.
  db.exec(`CREATE TABLE tm_timesheets_v16 (
   id TEXT PRIMARY KEY,task_id TEXT REFERENCES tm_tasks(id),workspace_id TEXT REFERENCES tm_workspaces(id),activity TEXT NOT NULL DEFAULT '',
   staff_id TEXT NOT NULL REFERENCES lookups(id),work_date TEXT NOT NULL,minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),notes TEXT NOT NULL DEFAULT '',
   version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(task_id,staff_id,work_date));
   INSERT INTO tm_timesheets_v16(id,task_id,workspace_id,staff_id,work_date,minutes,notes,version,created_at,updated_at)
    SELECT e.id,e.task_id,t.workspace_id,e.staff_id,e.work_date,e.minutes,e.notes,e.version,e.created_at,e.updated_at FROM tm_timesheets e LEFT JOIN tm_tasks t ON t.id=e.task_id;
   DROP TABLE tm_timesheets;ALTER TABLE tm_timesheets_v16 RENAME TO tm_timesheets;
   CREATE INDEX tm_time_date ON tm_timesheets(staff_id,work_date);
   CREATE TABLE tm_meeting_changes (
    id TEXT PRIMARY KEY,meeting_id TEXT NOT NULL REFERENCES tm_meetings(id),requested_by TEXT NOT NULL REFERENCES lookups(id),approver_id TEXT NOT NULL REFERENCES lookups(id),
    base_version INTEGER NOT NULL,payload_json TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','REJECTED','WITHDRAWN')),
    note TEXT NOT NULL DEFAULT '',decision_note TEXT NOT NULL DEFAULT '',decided_by TEXT REFERENCES lookups(id),decided_at TEXT,created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
    CHECK(requested_by<>approver_id));
   CREATE UNIQUE INDEX tm_meeting_pending ON tm_meeting_changes(meeting_id) WHERE status='PENDING';
   CREATE UNIQUE INDEX tm_series_due_unique ON tm_tasks(series_id,scheduled_due) WHERE series_id IS NOT NULL AND scheduled_due IS NOT NULL;`);
  if(all('PRAGMA foreign_key_check').length)throw new Error('Migration foreign key validation failed.');
  run('INSERT INTO schema_version(version) VALUES(16)');db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
