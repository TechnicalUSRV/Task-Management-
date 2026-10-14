// V5.7.1: retain string-valued contact emails, but apply uniqueness only when supplied.
// Rebuild the parent table using SQLite's create/copy/drop/rename procedure so
// sessions, permission overrides and all staff relationships keep their original IDs.
export function migrateContactEmail({db,get,all,run}) {
 if(get('SELECT version FROM schema_version WHERE version=18'))return;
 const previous=get('PRAGMA foreign_keys').foreign_keys;
 db.exec('PRAGMA foreign_keys=OFF');
 db.exec('BEGIN IMMEDIATE');
 try {
  const original=get("SELECT sql FROM sqlite_master WHERE type='table' AND name='access_users'").sql;
  const revised=original.replace(/email\s+TEXT\s+NOT\s+NULL\s+COLLATE\s+NOCASE\s+UNIQUE/i,"email TEXT NOT NULL COLLATE NOCASE DEFAULT ''");
  if(revised!==original){
   const dependent=all("SELECT sql FROM sqlite_master WHERE tbl_name='access_users' AND type IN ('index','trigger') AND sql IS NOT NULL");
   const columns=all('PRAGMA table_info(access_users)').map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',');
   db.exec(revised.replace(/CREATE TABLE\s+(?:"access_users"|access_users)/i,'CREATE TABLE access_users_v18'));
   db.exec(`INSERT INTO access_users_v18(${columns}) SELECT ${columns} FROM access_users;
    DROP TABLE access_users; ALTER TABLE access_users_v18 RENAME TO access_users;`);
   for(const item of dependent)db.exec(item.sql);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS access_contact_email_unique ON access_users(email) WHERE email<>''");
  if(all('PRAGMA foreign_key_check').length)throw new Error('Contact email migration foreign key validation failed.');
  run('INSERT INTO schema_version(version) VALUES(18)');
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 finally{db.exec(`PRAGMA foreign_keys=${previous?'ON':'OFF'}`);}
}
