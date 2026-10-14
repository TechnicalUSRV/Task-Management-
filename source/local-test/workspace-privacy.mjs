// V5.7.7: privacy is independent of the retained legacy/governance classification.
// Called inside the organization startup transaction. No records or memberships are deleted.
export function migrateWorkspacePrivacy({db,get,all,run}) {
 if(!all('PRAGMA table_info(tm_workspaces)').some(c=>c.name==='visibility'))
  run("ALTER TABLE tm_workspaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK(visibility IN('PERSONAL','PUBLIC'))");
 if(!get('SELECT 1 FROM schema_version WHERE version=19')) {
  run("UPDATE tm_workspaces SET visibility='PERSONAL' WHERE kind='PERSONAL'");
  const shared=all("SELECT id,owner_id FROM tm_workspaces w WHERE visibility='PERSONAL' AND EXISTS(SELECT 1 FROM tm_members m WHERE m.workspace_id=w.id AND m.staff_id<>w.owner_id)");
  for(const w of shared) {
   run("UPDATE tm_workspaces SET visibility='PUBLIC',version=version+1 WHERE id=?",w.id);
   run("INSERT INTO org_audit(actor_id,action,workspace_id,before_json,after_json,reason,created_at) VALUES(?,'workspace.public',?,?,?,'V5.7.7: retained existing shared membership; Personal becomes Public',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",w.owner_id,w.id,JSON.stringify({visibility:'PERSONAL'}),JSON.stringify({visibility:'PUBLIC'}));
  }
  run('UPDATE org_settings SET revision=revision+1 WHERE id=1');
  run('INSERT INTO schema_version(version) VALUES(19)');
 }
 // Enforce conversion for every membership write, including old clients and imports.
 const convert=`UPDATE tm_workspaces SET visibility='PUBLIC',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.workspace_id AND visibility='PERSONAL' AND owner_id<>NEW.staff_id;`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS workspace_member_public_insert AFTER INSERT ON tm_members BEGIN ${convert} END;
 CREATE TRIGGER IF NOT EXISTS workspace_member_public_update AFTER UPDATE OF workspace_id,staff_id ON tm_members BEGIN ${convert} END;
 CREATE TRIGGER IF NOT EXISTS workspace_public_audit AFTER UPDATE OF visibility ON tm_workspaces
 WHEN OLD.visibility='PERSONAL' AND NEW.visibility='PUBLIC' BEGIN
 INSERT INTO org_audit(actor_id,action,workspace_id,before_json,after_json,reason,created_at)
 VALUES(NEW.owner_id,'workspace.public',NEW.id,'{"visibility":"PERSONAL"}','{"visibility":"PUBLIC"}','Personal workspace converted to Public',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 UPDATE org_settings SET revision=revision+1 WHERE id=1;
 END;`);
}
export const isPersonalWorkspace=w=>!!w&&(w.visibility??(w.kind==='PERSONAL'?'PERSONAL':'PUBLIC'))==='PERSONAL';
