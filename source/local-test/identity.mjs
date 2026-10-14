export const cleanUsername = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const usernameKey = value => cleanUsername(value).toLocaleLowerCase('en-US');
export const displayName = (name, nickname) => nickname ? `${name} (${nickname})` : name;
export function migrateIdentity({db,get,all,run,now}) {
 if(get('SELECT version FROM schema_version WHERE version=17'))return;
 db.exec('BEGIN IMMEDIATE');
 try {
  const cols=new Set(all('PRAGMA table_info(access_users)').map(c=>c.name));
  if(!cols.has('username'))run("ALTER TABLE access_users ADD COLUMN username TEXT NOT NULL DEFAULT ''");
  if(!cols.has('username_key'))run("ALTER TABLE access_users ADD COLUMN username_key TEXT NOT NULL DEFAULT ''");
  const used=new Set();
  for(const u of all('SELECT u.id,u.staff_id,l.name FROM access_users u JOIN lookups l ON l.id=u.staff_id ORDER BY u.created_at,u.id')) {
   const base=cleanUsername(u.name).slice(0,160)||u.staff_id;
   let name=base,key=usernameKey(name),suffix=0;
   while(used.has(key)||get("SELECT id FROM lookups WHERE kind='staff' AND name=? AND id<>?",name,u.staff_id)){name=`${base} (${u.staff_id}${suffix++ ? '-'+suffix : ''})`;key=usernameKey(name);}
   used.add(key);run('UPDATE access_users SET username=?,username_key=? WHERE id=?',name,key,u.id);
   run('UPDATE lookups SET name=? WHERE id=?',name,u.staff_id);
   run("INSERT INTO access_audit(actor_id,action,target_id,detail,created_at) VALUES(NULL,'Username migrated',?,?,?)",u.id,JSON.stringify({previous_name:u.name,username:name}),now());
  }
  run('CREATE UNIQUE INDEX IF NOT EXISTS access_username_unique ON access_users(username_key)');
  run('INSERT INTO schema_version(version) VALUES(17)');db.exec('COMMIT');
 } catch(e){db.exec('ROLLBACK');throw e;}
}
