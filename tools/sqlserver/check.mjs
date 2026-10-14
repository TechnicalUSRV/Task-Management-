import { connectionConfig, failureHint } from './config.mjs';

let config;
try {
  config = connectionConfig();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

if (config) {
  let sql;
  try { sql = (await import('mssql')).default; }
  catch {
    console.error('Install this checker first: run npm install inside tools/sqlserver.');
    process.exitCode = 1;
  }
  if (sql) {
    let pool;
    let poolError;
    try {
      pool = new sql.ConnectionPool(config);
      pool.on('error', error => { poolError = error; });
      await pool.connect();
      // Parameters prove that Unicode survives the actual driver connection.
      // Only SELECT statements are sent. No application tables or data are written.
      const sample = 'Task Management — ការងារ';
      const result = await pool.request().input('sample', sql.NVarChar(100), sample).query(`
        SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS server_name,
               CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS server_version,
               DB_NAME() AS database_name,
               ORIGINAL_LOGIN() AS login_name,
               USER_NAME() AS database_user,
               IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
               IS_MEMBER('db_owner') AS is_database_owner,
               (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS visible_table_count,
               @sample AS unicode_sample;
      `);
      if (poolError) throw poolError;
      const row = result.recordset?.[0];
      if (!row || row.unicode_sample !== sample) throw new Error('Unexpected SQL Server response.');
      console.log('SQL Server connection: PASSED');
      console.table([{
        server: row.server_name,
        database: row.database_name,
        login: row.login_name,
        database_user: row.database_user,
        version: row.server_version,
        visible_tables: row.visible_table_count,
        unicode: 'PASSED',
      }]);
      if (row.is_sysadmin === 1 || row.is_database_owner === 1) {
        console.log('This login has broad administrator permissions. Use a database-scoped application login for normal operation.');
      }
      console.log('Connectivity only: the V5.7.7 application still uses SQLite. Schema migration and application conversion are pending.');
    } catch (error) {
      console.error(failureHint(error));
      process.exitCode = 1;
    } finally {
      if (pool) await pool.close().catch(() => {});
    }
  }
}
