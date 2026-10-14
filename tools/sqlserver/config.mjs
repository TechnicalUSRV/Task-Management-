const required = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Set ${name} in tools/sqlserver/.env.`);
  return name === 'SQLSERVER_PASSWORD' ? value : value.trim();
};

export function connectionConfig(env = process.env) {
  const server = required(env, 'SQLSERVER_HOST');
  if (/^(YOUR-|REPLACE)/i.test(server) || /[\\,\s/]/.test(server)) {
    throw new Error('SQLSERVER_HOST must be a hostname or IP address alone. Set the instance or port separately.');
  }
  const database = required(env, 'SQLSERVER_DATABASE');
  if (['master', 'model', 'msdb', 'tempdb'].includes(database.toLowerCase())) {
    throw new Error('Select the separate Task Management database, not a SQL Server system database.');
  }
  const user = required(env, 'SQLSERVER_USER');
  if (user.toLowerCase() === 'sa') throw new Error('Use a dedicated application login such as taskmanagement_app.');
  const password = required(env, 'SQLSERVER_PASSWORD');
  const instance = (env.SQLSERVER_INSTANCE || '').trim();
  const portText = (env.SQLSERVER_PORT || '').trim();
  if (Boolean(instance) === Boolean(portText)) {
    throw new Error('Set exactly one of SQLSERVER_PORT or SQLSERVER_INSTANCE.');
  }
  if (instance && /[\\,\s/]/.test(instance)) throw new Error('SQLSERVER_INSTANCE must contain only the instance name.');
  const port = Number(portText);
  if (portText && (!/^\d+$/.test(portText) || port < 1 || port > 65535)) {
    throw new Error('SQLSERVER_PORT must be a whole number from 1 to 65535.');
  }
  const trustText = (env.SQLSERVER_TRUST_SERVER_CERTIFICATE || 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(trustText)) throw new Error('SQLSERVER_TRUST_SERVER_CERTIFICATE must be true or false.');
  return {
    server, database, user, password,
    ...(portText ? { port } : {}),
    connectionTimeout: 15000,
    requestTimeout: 15000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      encrypt: true,
      trustServerCertificate: trustText === 'true',
      appName: 'TaskManagement-ConnectionCheck',
      ...(instance ? { instanceName: instance } : {}),
    },
  };
}

// Never return raw driver errors: they can contain a connection string or credentials.
export function failureHint(error) {
  const code = String(error?.code || '');
  if (code === 'ELOGIN') return 'Login failed. Verify the SQL login/password, SQL authentication mode, and database user mapping in SSMS.';
  if (code === 'ETIMEOUT' || code === 'ESOCKET' || code === 'EINSTLOOKUP') {
    return 'Connection failed. Verify the host, TCP port or instance, TCP/IP configuration, firewall, and SQL Server certificate. Named-instance discovery also needs SQL Server Browser.';
  }
  if (code === 'EREQUEST') return 'SQL Server rejected the read-only check. Verify access to the selected database with this login in SSMS.';
  return 'SQL Server check failed. Verify the local configuration and server connection in SSMS.';
}
